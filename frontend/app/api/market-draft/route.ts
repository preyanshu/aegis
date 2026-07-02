import { NextResponse } from "next/server";
import { TRUSTED_DATA_SOURCES } from "@/lib/data-sources";

const NVIDIA_API_KEY = process.env.NVIDIA_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
const NVIDIA_BASE_URL = process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";
const NVIDIA_MODEL = process.env.NVIDIA_MARKET_FILL_MODEL ?? "minimaxai/minimax-m3";
const DEFAULT_FEE_BPS = "200";

type DraftConditionPayload = {
  assetSymbol: string;
  comparator: "gte" | "lte";
  threshold: string;
  joinWithNext?: "AND" | "OR";
};

type DraftPayload = {
  question: string;
  category: "macro" | "crypto" | "eth-related" | "fx" | "commodities";
  resolutionDateTime: string;
  minBet: string;
  maxBet: string;
  feeBps: string;
  conditions: DraftConditionPayload[];
  assumptions?: string[];
};

function stripCodeFences(value: string) {
  return value
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractJsonObject(value: string) {
  const cleaned = stripCodeFences(value);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("AI did not return valid JSON.");
  }

  return cleaned.slice(start, end + 1);
}

function isValidCategory(value: string): value is DraftPayload["category"] {
  return ["macro", "crypto", "eth-related", "fx", "commodities"].includes(value);
}

function isValidComparator(value: string): value is DraftConditionPayload["comparator"] {
  return value === "gte" || value === "lte";
}

function parsePositiveNumberString(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  if (!normalized || !/^\d+(\.\d+)?$/.test(normalized)) {
    return null;
  }

  return normalized;
}

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function formatNaiveDateTimeFromParts(year: number, month: number, day: number, hour: number, minute: number) {
  return `${year}-${padTwoDigits(month)}-${padTwoDigits(day)}T${padTwoDigits(hour)}:${padTwoDigits(minute)}`;
}

function formatNaiveDateTimeForOffset(date: Date, offsetMinutes: number) {
  const shifted = new Date(date.getTime() - offsetMinutes * 60_000);
  return formatNaiveDateTimeFromParts(
    shifted.getUTCFullYear(),
    shifted.getUTCMonth() + 1,
    shifted.getUTCDate(),
    shifted.getUTCHours(),
    shifted.getUTCMinutes(),
  );
}

function parseNaiveDateTime(value: string, offsetMinutes: number) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const utcMillis = Date.UTC(year, month - 1, day, hour, minute) + offsetMinutes * 60_000;
  const candidate = new Date(utcMillis);

  if (
    Number.isNaN(candidate.getTime())
    || candidate.getUTCFullYear() !== year
    || candidate.getUTCMonth() + 1 !== month
    || candidate.getUTCDate() !== day
  ) {
    return null;
  }

  return {
    timestampMillis: utcMillis,
    normalized: formatNaiveDateTimeFromParts(year, month, day, hour, minute),
  };
}

function normalizeResolutionDateTime(
  value: unknown,
  referenceTimestampSeconds: number,
  browserUtcOffsetMinutes: number,
) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const referenceTime = referenceTimestampSeconds > 0 ? referenceTimestampSeconds * 1000 : Date.now();
  const naiveCandidate = parseNaiveDateTime(trimmed, browserUtcOffsetMinutes);

  if (naiveCandidate) {
    return naiveCandidate.timestampMillis > referenceTime ? naiveCandidate.normalized : null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime()) || parsed.getTime() <= referenceTime) {
    return null;
  }

  return formatNaiveDateTimeForOffset(parsed, browserUtcOffsetMinutes);
}

function validateDraftPayload(
  raw: unknown,
  referenceTimestampSeconds: number,
  browserUtcOffsetMinutes: number,
) {
  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned an empty market draft.");
  }

  const draft = raw as Partial<DraftPayload>;
  const question = typeof draft.question === "string" ? draft.question.trim() : "";
  const category = typeof draft.category === "string" ? draft.category.trim().toLowerCase() : "";
  const resolutionDateTime = normalizeResolutionDateTime(
    draft.resolutionDateTime,
    referenceTimestampSeconds,
    browserUtcOffsetMinutes,
  );
  const minBet = parsePositiveNumberString(draft.minBet) ?? "1";
  const maxBet = parsePositiveNumberString(draft.maxBet) ?? "25";
  const feeBps = parsePositiveNumberString(draft.feeBps) ?? DEFAULT_FEE_BPS;
  const assumptions = Array.isArray(draft.assumptions)
    ? draft.assumptions.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  if (!question) {
    throw new Error("The AI could not turn that prompt into a clear market question.");
  }

  if (!isValidCategory(category)) {
    throw new Error("The AI could not map that prompt to one of the supported market categories.");
  }

  if (!resolutionDateTime) {
    throw new Error("The prompt needs an exact future resolution time the market can settle against.");
  }

  const conditions = Array.isArray(draft.conditions) ? draft.conditions : [];
  if (conditions.length === 0) {
    throw new Error("The prompt needs at least one exact mathematical resolution condition.");
  }

  const normalizedConditions = conditions.map((condition, index) => {
    if (!condition || typeof condition !== "object") {
      throw new Error(`Condition ${index + 1} is invalid.`);
    }

    const assetSymbol = typeof condition.assetSymbol === "string" ? condition.assetSymbol.trim().toUpperCase() : "";
    const comparator = typeof condition.comparator === "string" ? condition.comparator.trim().toLowerCase() : "";
    const threshold = parsePositiveNumberString(condition.threshold);
    const joinWithNext = typeof condition.joinWithNext === "string" ? condition.joinWithNext.trim().toUpperCase() : "AND";
    const source = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === assetSymbol);

    if (!source) {
      throw new Error(`Asset ${assetSymbol || `#${index + 1}`} is not supported by the current oracle set.`);
    }

    if (!isValidComparator(comparator)) {
      throw new Error(`Condition ${index + 1} needs a supported comparator.`);
    }

    if (!threshold) {
      throw new Error(`Condition ${index + 1} needs a numeric threshold.`);
    }

    return {
      assetSymbol,
      comparator,
      threshold,
      joinWithNext: joinWithNext === "OR" ? "OR" : "AND",
    };
  });

  if (normalizedConditions.length > 5) {
    throw new Error("AI produced too many conditions. The market supports up to five.");
  }

  return {
    question,
    category,
    resolutionDateTime,
    minBet,
    maxBet,
    feeBps,
    assumptions,
    conditions: normalizedConditions,
  };
}

function supportedAssetCatalog() {
  return TRUSTED_DATA_SOURCES.map((source) => ({
    assetSymbol: source.ticker,
    assetName: source.name,
    categoryHint: source.group,
    defaultReferencePrice: source.price,
    oracleContract: source.oracleContract,
  }));
}

function promptMentionsSupportedAsset(prompt: string) {
  const normalized = prompt.toLowerCase();
  return TRUSTED_DATA_SOURCES.some((source) => {
    const ticker = source.ticker.toLowerCase();
    const name = source.name.toLowerCase();
    return normalized.includes(ticker) || normalized.includes(name);
  });
}

async function requestDraftFromModel(
  prompt: string,
  referenceTimestampSeconds: number,
  browserTimeZone: string,
  browserUtcOffsetMinutes: number,
) {
  const referenceDate = new Date(referenceTimestampSeconds > 0 ? referenceTimestampSeconds * 1000 : Date.now());
  const referenceLocalDateTime = formatNaiveDateTimeForOffset(referenceDate, browserUtcOffsetMinutes);
  const systemPrompt = [
    "You convert user prompts into private prediction market drafts.",
    "Return JSON only. No markdown. No prose outside JSON.",
    "If the prompt is not precise enough to build a mathematically resolvable market, return:",
    '{"ok":false,"reason":"<short reason>"}',
    "Otherwise return:",
    '{"ok":true,"draft":{"question":"","category":"macro|crypto|eth-related|fx|commodities","resolutionDateTime":"YYYY-MM-DDTHH:mm","minBet":"1","maxBet":"25","feeBps":"200","conditions":[{"assetSymbol":"BTC","comparator":"gte|lte","threshold":"50000","joinWithNext":"AND|OR"}],"assumptions":[]}}',
    "Rules:",
    "- The market must resolve from exact oracle math only.",
    "- If the prompt does not clearly reference one of the supported oracle assets, reject it.",
    "- Use only supported assets from the catalog.",
    `- The current Stellar ledger timestamp is ${referenceTimestampSeconds}. Treat this as the reference 'now' for all relative time reasoning.`,
    `- The corresponding reference time is ${referenceDate.toISOString()}. Use it to derive exact future resolutionDateTime values.`,
    `- The user's local timezone is ${browserTimeZone}.`,
    `- The user's local UTC offset in minutes is ${browserUtcOffsetMinutes}.`,
    `- In the user's local time, the current timestamp is ${referenceLocalDateTime}.`,
    "- The resolutionDateTime must be future-dated relative to the provided ledger timestamp.",
    "- Return resolutionDateTime as a timezone-free local datetime in exactly YYYY-MM-DDTHH:mm format.",
    "- Do not return a Z suffix, UTC offset, seconds, or any other timezone marker in resolutionDateTime.",
    "- If the prompt gives a month and day without a year, infer the correct year so the date is in the future.",
    "- If the prompt omits a time but the date is otherwise clear, default to 12:00.",
    "- Relative dates like 'this month', 'tomorrow', 'after 2 days', 'after 5 min', or 'in 5 minutes from now' are acceptable and must be converted into one exact future timestamp.",
    "- Calculate the exact future resolutionDateTime yourself from relative phrases.",
    "- If the prompt is ambiguous about time, prefer a conservative future expiry that is comfortably after the reference ledger timestamp.",
    "- If the prompt depends on sentiment, volume, dominance, market cap, ETF approval odds, or any unsupported data, reject it.",
    "- You can create between 1 and 5 conditions.",
    "- Prefer one condition unless the prompt clearly asks for multiple conditions.",
    "- Rewrite the question into a clean market title.",
    "- minBet should usually be 1 and maxBet should usually be 25 unless the prompt implies otherwise.",
    "- feeBps should be 200.",
    "- You are not limited to BTC. Choose from the full supported asset catalog below.",
    "Supported asset catalog JSON:",
    JSON.stringify(supportedAssetCatalog()),
  ].join("\n");

  const isMiniMaxModel = NVIDIA_MODEL.toLowerCase().includes("minimax");
  const requestBody: Record<string, unknown> = {
    model: NVIDIA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: prompt,
      },
    ],
    temperature: 0.1,
    top_p: 0.9,
    max_tokens: 1600,
    stream: false,
  };

  if (!isMiniMaxModel) {
    requestBody.reasoning_budget = 4096;
    requestBody.chat_template_kwargs = { enable_thinking: true };
  }

  const response = await fetch(`${NVIDIA_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${NVIDIA_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  const payload = await response.json().catch(() => null) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  } | null;

  if (!response.ok) {
    throw new Error(payload?.error?.message ?? "AI market fill failed.");
  }

  const content = payload?.choices?.[0]?.message?.content ?? "";
  return JSON.parse(extractJsonObject(content)) as
    | { ok: false; reason?: string }
    | { ok: true; draft?: unknown };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null) as {
      prompt?: string;
      currentLedgerTimestamp?: number;
      browserTimeZone?: string;
      browserUtcOffsetMinutes?: number;
    } | null;
    const prompt = body?.prompt?.trim() ?? "";
    const currentLedgerTimestamp = Number(body?.currentLedgerTimestamp ?? 0);
    const browserTimeZone = typeof body?.browserTimeZone === "string" && body.browserTimeZone.trim()
      ? body.browserTimeZone.trim()
      : "UTC";
    const browserUtcOffsetMinutes = Number.isFinite(Number(body?.browserUtcOffsetMinutes))
      ? Number(body?.browserUtcOffsetMinutes)
      : 0;
    const referenceTimestampSeconds = Number.isFinite(currentLedgerTimestamp) && currentLedgerTimestamp > 0
      ? Math.floor(currentLedgerTimestamp)
      : Math.floor(Date.now() / 1000);

    if (!prompt) {
      return NextResponse.json({ error: "Enter a market prompt first." }, { status: 400 });
    }

    if (!promptMentionsSupportedAsset(prompt)) {
      return NextResponse.json(
        { error: "That prompt does not reference a supported oracle asset, so we cannot build a valid resolution rule for it." },
        { status: 422 },
      );
    }

    if (!NVIDIA_API_KEY) {
      return NextResponse.json(
        { error: "AI market fill is not configured on the server. Set NVIDIA_API_KEY first." },
        { status: 503 },
      );
    }

    const parsed = await requestDraftFromModel(
      prompt,
      referenceTimestampSeconds,
      browserTimeZone,
      browserUtcOffsetMinutes,
    );

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.reason?.trim() || "The prompt was not precise enough to create a resolvable market." },
        { status: 422 },
      );
    }

    try {
      const draft = validateDraftPayload(parsed.draft, referenceTimestampSeconds, browserUtcOffsetMinutes);
      return NextResponse.json({ draft });
    } catch (error) {
      console.error("market-draft validation failed", {
        parsedDraft: parsed.draft,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI market fill failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
