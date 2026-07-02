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

function normalizeResolutionDateTime(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = new Date(trimmed);
  const parsedAsUtc = Number.isNaN(parsed.getTime()) ? null : parsed;
  const utcCandidate = trimmed.match(/[zZ]|[+-]\d{2}:?\d{2}$/) ? parsedAsUtc : new Date(`${trimmed}Z`);

  const futureParsed = [parsedAsUtc, utcCandidate].find((candidate) => (
    candidate !== null && !Number.isNaN(candidate.getTime()) && candidate.getTime() > Date.now()
  ));

  if (!futureParsed) {
    return null;
  }

  return futureParsed.toISOString().slice(0, 16);
}

function validateDraftPayload(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    throw new Error("AI returned an empty market draft.");
  }

  const draft = raw as Partial<DraftPayload>;
  const question = typeof draft.question === "string" ? draft.question.trim() : "";
  const category = typeof draft.category === "string" ? draft.category.trim().toLowerCase() : "";
  const resolutionDateTime = normalizeResolutionDateTime(draft.resolutionDateTime);
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

async function requestDraftFromModel(prompt: string) {
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
    "- The resolutionDateTime must be future-dated.",
    "- If the prompt gives a month and day without a year, infer the correct year so the date is in the future.",
    "- If the prompt omits a time but the date is otherwise clear, default to 12:00.",
    "- Relative dates like 'this month', 'tomorrow', 'after 2 days', 'after 5 min', or 'in 5 minutes from now' are acceptable and must be converted into one exact future timestamp.",
    "- Calculate the exact future resolutionDateTime yourself from relative phrases.",
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
    const body = await request.json().catch(() => null) as { prompt?: string } | null;
    const prompt = body?.prompt?.trim() ?? "";

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

    const parsed = await requestDraftFromModel(prompt);

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.reason?.trim() || "The prompt was not precise enough to create a resolvable market." },
        { status: 422 },
      );
    }

    try {
      const draft = validateDraftPayload(parsed.draft);
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
