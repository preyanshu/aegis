"use client";

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, HelpCircle, Loader2, ShieldCheck, Sparkles, X } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { Navbar } from "@/components/landing/Navbar";
import { PublicProfileOnboardingModal } from "@/components/profile/PublicProfileOnboardingModal";
import { mapMarketSummary, payoutForPosition, formatUsdc } from "@/lib/blind-market";
import { generateReputationProof, verifyReputationProof } from "@/lib/proofs";
import { buildSnapshot, createClaimDescriptor, reputationStatementLabel, type ReputationRecordInput, type ReputationWindowDays } from "@/lib/reputation";
import { getPrivyStellarWallet, loadMarketIds, loadMarketView, type MarketView } from "@/lib/stellar";
import { type BlindPositionRecord } from "@/lib/types";
import type { ReputationClaimDescriptor } from "@/lib/reputation";
import { loadReputationSnapshot, upsertAchievement, type ReputationSyncMode, type StoredReputationCredential } from "@/lib/reputation-vault";

type StellarMarketRow = {
  marketId: string;
  view: MarketView;
};

type ClaimedReputationRecord = ReputationRecordInput & {
  side: "YES" | "NO";
  marketQuestion: string;
  commitment: string;
  nullifier: string;
  claimTxHash?: string;
};

type GeneratedCredential = {
  serialized: string;
  isValid: boolean;
  proofHex: string;
  publicInputsHex: string[];
  publicClaim: {
    subjectId: string;
    category: string;
    windowDays: ReputationWindowDays;
    snapshotCommitment: string;
    statement: string;
  };
};

type AchievementCard = GeneratedCredential & {
  createdAt: number;
  claim: ReputationClaimDescriptor;
};

const WINDOW_OPTIONS: ReputationWindowDays[] = [30, 90, 180];
const PERCENTILE_BANDS = [10, 25, 50] as const;
const THRESHOLD_PRESETS = {
  roi: [
    { label: "ROI > 20%", value: 2000n },
    { label: "ROI > 50%", value: 5000n },
  ],
  profit: [
    { label: "Profit > 5 USDC", value: 50_000_000n },
    { label: "Profit > 10 USDC", value: 100_000_000n },
  ],
  winRate: [
    { label: "Win rate > 60%", value: 6000n },
    { label: "Win rate > 75%", value: 7500n },
  ],
  participation: [
    { label: "3 markets", value: 3n },
    { label: "5 markets", value: 5n },
  ],
  exposure: [
    { label: "50 USDC", value: 500000000n },
    { label: "100 USDC", value: 1000000000n },
  ],
} as const;

function categoryChoices(records: ReputationRecordInput[]) {
  return [...new Set(records.map((record) => record.category.toLowerCase()))].sort();
}

function shortHash(value: string, start = 8, end = 6) {
  if (!value) {
    return "—";
  }
  if (value.length <= start + end + 3) {
    return value;
  }
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

function HelpTip({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex items-center">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/35 transition group-hover:border-white/20 group-hover:text-white/70">
        <HelpCircle className="h-3 w-3" />
      </span>
      <span className="pointer-events-none absolute left-1/2 top-full z-20 mt-2 w-64 -translate-x-1/2 rounded-xl border border-white/10 bg-[#0d0d10] px-3 py-2 text-[11px] font-medium normal-case tracking-normal text-white/70 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100">
        {text}
      </span>
    </span>
  );
}

function humanizeThreshold(metric: keyof typeof THRESHOLD_PRESETS, value: bigint) {
  if (metric === "roi" || metric === "winRate") {
    return `${Number(value) / 100}%`;
  }
  if (metric === "profit" || metric === "exposure") {
    return formatUsdc(value);
  }
  return value.toString();
}

function achievementLabel(achievement: AchievementCard) {
  return achievement.publicClaim.statement;
}

function scoreForAchievement(achievement: AchievementCard) {
  const claim = achievement.claim;
  if (claim.claimType === "percentile") {
    return claim.band === 10 ? 34 : claim.band === 25 ? 24 : 14;
  }

  const metricScore = claim.metric === "roi"
    ? 30
    : claim.metric === "profit"
      ? 24
      : claim.metric === "winRate"
        ? 26
        : claim.metric === "participation"
          ? 18
          : 20;

  const thresholdBoost = claim.metric === "participation"
    ? Number(claim.threshold) * 2
    : claim.metric === "roi" || claim.metric === "winRate"
      ? Number(claim.threshold) / 500
      : Number(claim.threshold) / 100_000_000;

  return metricScore + Math.min(18, Math.max(0, Math.floor(thresholdBoost)));
}

function reputationScoreFromAchievements(achievements: AchievementCard[]) {
  const rawScore = achievements.reduce((sum, achievement) => sum + scoreForAchievement(achievement), 0);
  return Math.max(0, Math.min(100, rawScore));
}

function plainTextExport(credential: GeneratedCredential | null) {
  if (!credential) {
    return "Generate a reputation credential to export it here.";
  }

  return [
    "Verdict zk reputation credential",
    `Subject: ${credential.publicClaim.subjectId}`,
    `Category: ${credential.publicClaim.category}`,
    `Window: ${credential.publicClaim.windowDays}d`,
    `Statement: ${credential.publicClaim.statement}`,
    `Snapshot commitment: ${credential.publicClaim.snapshotCommitment}`,
    `Proof hash: ${credential.proofHex}`,
    `Verified: ${credential.isValid ? "yes" : "no"}`,
    `Public inputs: ${credential.publicInputsHex.join(", ")}`,
  ].join("\n");
}

function formatShortDate(timestampMs: number) {
  if (!timestampMs) {
    return "No activity yet";
  }

  return new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(timestampMs);
}

function relativeTimeLabel(timestampMs: number) {
  if (!timestampMs) {
    return "Not available";
  }

  const diff = Date.now() - timestampMs;
  const day = 86_400_000;
  if (diff < day) {
    return "Today";
  }
  if (diff < day * 2) {
    return "Yesterday";
  }
  if (diff < day * 30) {
    return `${Math.max(1, Math.round(diff / day))}d ago`;
  }
  return formatShortDate(timestampMs);
}

type ReputationTrendPoint = {
  label: string;
  score: number;
};

type ShowcaseCredentialCard = {
  id: string;
  title: string;
  description: string;
  meta: string;
  tags: string[];
  status: string;
};

function buildReputationTrend(records: ClaimedReputationRecord[]): ReputationTrendPoint[] {
  if (records.length === 0) {
    return [];
  }

  const buckets = new Map<string, { label: string; delta: number }>();

  records
    .slice()
    .sort((left, right) => left.claimedAt - right.claimedAt)
    .forEach((record) => {
      const claimedAtMs = record.claimedAt * 1000;
      if (!claimedAtMs) {
        return;
      }

      const date = new Date(claimedAtMs);
      const key = `${date.getUTCFullYear()}-${date.getUTCMonth()}`;
      const label = date.toLocaleString("en", { month: "short" });
      const delta = record.won ? 12 : 5;
      const current = buckets.get(key);
      if (current) {
        current.delta += delta;
        return;
      }
      buckets.set(key, { label, delta });
    });

  let runningScore = 18;
  return Array.from(buckets.values()).map((bucket) => {
    runningScore = Math.min(100, runningScore + bucket.delta);
    return {
      label: bucket.label,
      score: runningScore,
    };
  }).slice(-6);
}

function topCategoryForRecords(records: ClaimedReputationRecord[]) {
  if (records.length === 0) {
    return "No category yet";
  }

  const counts = new Map<string, number>();
  records.forEach((record) => {
    counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
  });

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "No category yet";
}

function topCategoryForPositions(records: Array<{ category: string }>) {
  if (records.length === 0) {
    return "No category yet";
  }

  const counts = new Map<string, number>();
  records.forEach((record) => {
    counts.set(record.category, (counts.get(record.category) ?? 0) + 1);
  });

  return Array.from(counts.entries()).sort((left, right) => right[1] - left[1])[0]?.[0] ?? "No category yet";
}

function MiniTrendChart({ points }: { points: ReputationTrendPoint[] }) {
  if (points.length === 0) {
    return (
      <div className="flex h-[220px] items-center justify-center rounded-[28px] border border-white/8 bg-[#0f1116]/70 text-sm text-white/42">
        Generate or claim more activity to see a reputation trend.
      </div>
    );
  }

  const width = 520;
  const height = 220;
  const padding = 22;
  const maxScore = Math.max(...points.map((point) => point.score), 100);
  const minScore = Math.min(...points.map((point) => point.score), 0);
  const spread = Math.max(1, maxScore - minScore);
  const stepX = points.length === 1 ? 0 : (width - padding * 2) / (points.length - 1);
  const coordinates = points.map((point, index) => {
    const x = padding + stepX * index;
    const y = height - padding - ((point.score - minScore) / spread) * (height - padding * 2);
    return { ...point, x, y };
  });
  const linePath = coordinates.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
  const areaPath = `${linePath} L ${coordinates[coordinates.length - 1]?.x ?? padding} ${height - padding} L ${coordinates[0]?.x ?? padding} ${height - padding} Z`;

  return (
    <div className="rounded-[28px] border border-white/8 bg-[#0f1116]/80 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Reputation trend</p>
          <h3 className="mt-2 text-xl font-black tracking-tight text-white">Score over recent activity</h3>
        </div>
        <div className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
          Live local view
        </div>
      </div>

      <div className="mt-5">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-[220px] w-full">
          <defs>
            <linearGradient id="reputation-area" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#86efac" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#86efac" stopOpacity="0" />
            </linearGradient>
          </defs>

          {[0, 1, 2, 3].map((row) => {
            const y = padding + ((height - padding * 2) / 3) * row;
            return (
              <line
                key={row}
                x1={padding}
                y1={y}
                x2={width - padding}
                y2={y}
                stroke="rgba(255,255,255,0.08)"
                strokeDasharray="5 7"
              />
            );
          })}

          <path d={areaPath} fill="url(#reputation-area)" />
          <path d={linePath} fill="none" stroke="#bbf7d0" strokeWidth="3" strokeLinecap="round" />

          {coordinates.map((point) => (
            <g key={`${point.label}-${point.x}`}>
              <circle cx={point.x} cy={point.y} r="5" fill="#dcfce7" />
              <text x={point.x} y={height - 4} textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize="11">
                {point.label}
              </text>
            </g>
          ))}
        </svg>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        {points.map((point) => (
          <div key={`${point.label}-${point.score}`} className="rounded-full border border-white/8 bg-white/[0.03] px-3 py-1.5 text-xs text-white/58">
            {point.label} · {point.score}
          </div>
        ))}
      </div>
    </div>
  );
}

function buildShowcaseCards(achievements: AchievementCard[]): ShowcaseCredentialCard[] {
  if (achievements.length > 0) {
    return achievements.slice(0, 6).map((achievement) => ({
      id: `${achievement.proofHex}-${achievement.createdAt}`,
      title: achievement.publicClaim.statement,
      description: `Proof-backed reputation statement for ${achievement.publicClaim.category} across a ${achievement.publicClaim.windowDays} day window.`,
      meta: relativeTimeLabel(achievement.createdAt),
      tags: [achievement.publicClaim.category, `${scoreForAchievement(achievement)} pts`],
      status: achievement.isValid ? "verified" : "draft",
    }));
  }
  return [];
}

type ReputationModalProps = {
  isOpen: boolean;
  onClose: () => void;
  walletAddress: string;
  categories: string[];
  claimedRecords: ClaimedReputationRecord[];
  claimMode: "percentile" | "threshold";
  setClaimMode: React.Dispatch<React.SetStateAction<"percentile" | "threshold">>;
  selectedCategory: string;
  setSelectedCategory: React.Dispatch<React.SetStateAction<string>>;
  windowDays: ReputationWindowDays;
  setWindowDays: React.Dispatch<React.SetStateAction<ReputationWindowDays>>;
  selectedBand: (typeof PERCENTILE_BANDS)[number];
  setSelectedBand: React.Dispatch<React.SetStateAction<(typeof PERCENTILE_BANDS)[number]>>;
  selectedThresholdMetric: keyof typeof THRESHOLD_PRESETS;
  setSelectedThresholdMetric: React.Dispatch<React.SetStateAction<keyof typeof THRESHOLD_PRESETS>>;
  selectedThresholdValue: bigint;
  setSelectedThresholdValue: React.Dispatch<React.SetStateAction<bigint>>;
  busy: boolean;
  status: string;
  credential: GeneratedCredential | null;
  isVerifying: boolean;
  onGenerate: () => Promise<void>;
  onVerify: () => Promise<void>;
};

function ReputationModal({
  isOpen,
  onClose,
  walletAddress,
  categories,
  claimedRecords,
  claimMode,
  setClaimMode,
  selectedCategory,
  setSelectedCategory,
  windowDays,
  setWindowDays,
  selectedBand,
  setSelectedBand,
  selectedThresholdMetric,
  setSelectedThresholdMetric,
  selectedThresholdValue,
  setSelectedThresholdValue,
  busy,
  status,
  credential,
  isVerifying,
  onGenerate,
  onVerify,
}: ReputationModalProps) {
  const [step, setStep] = useState(1);

  const snapshotPreview = useMemo(() => {
    if (!walletAddress || !selectedCategory || claimedRecords.length === 0) {
      return null;
    }

    return buildSnapshot(claimedRecords, {
      category: selectedCategory,
      subjectId: walletAddress,
      windowDays,
    });
  }, [claimedRecords, selectedCategory, walletAddress, windowDays]);

  const exportText = plainTextExport(credential);
  const totalSteps = 3;
  const canMoveForward = step === 1
    ? categories.length > 0
    : step === 2
      ? Boolean(selectedCategory)
      : true;
  const stepTitle = step === 1
    ? "Pick the scope"
    : step === 2
      ? "Pick the claim style"
      : "Review and generate";
  const stepDescription = step === 1
    ? "Choose what this credential should summarize."
    : step === 2
      ? "Choose how strict or broad the credential should feel."
      : "Check the summary and generate the proof when you're ready.";

  useEffect(() => {
    if (!isOpen) {
      setStep(1);
    }
  }, [isOpen]);

  return (
    <AnimatePresence>
      {isOpen ? (
        <div className="fixed inset-0 z-[250] flex items-center justify-center px-3 py-4 sm:px-6">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-xl"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 12 }}
            className="relative flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-[32px] border border-white/8 bg-[#0b0b0d] shadow-[0_20px_80px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-start justify-between border-b border-white/8 px-5 py-5 sm:px-8">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/35">Create creds</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
                  {stepTitle}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
                  {stepDescription}
                </p>
                <div className="mt-4 flex items-center gap-2">
                  {Array.from({ length: totalSteps }, (_, index) => index + 1).map((item) => (
                    <div
                      key={item}
                      className={`h-1.5 w-10 rounded-full transition ${
                        item <= step ? "bg-violet-400" : "bg-white/10"
                      }`}
                    />
                  ))}
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/60 transition hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-5 sm:px-8">
              <div className="space-y-5">
                {step === 1 ? (
                  <>
                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <div className="grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/28">Wallet</p>
                          <p className="mt-3 text-sm font-semibold text-white">{shortHash(walletAddress, 10, 8)}</p>
                        </div>
                        <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/28">Claims</p>
                          <p className="mt-3 text-sm font-semibold text-white">{claimedRecords.length}</p>
                        </div>
                        <div className="rounded-2xl border border-white/8 bg-black/20 p-4">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/28">Scope</p>
                          <p className="mt-3 text-sm font-semibold text-white">{selectedCategory || "macro"} · {windowDays}d</p>
                        </div>
                      </div>
                    </div>

                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Category</p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {categories.length === 0 ? (
                          <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/20 px-4 py-2 text-sm text-white/45">
                            <span>No eligible categories yet</span>
                            <HelpTip text="We only allow categories from settled positions you have already claimed. Open positions are not eligible for a public cred." />
                          </div>
                        ) : categories.map((category) => (
                          <button
                            key={category}
                            type="button"
                            onClick={() => setSelectedCategory(category)}
                            className={`rounded-full border px-3 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                              selectedCategory === category
                                ? "border-white/20 bg-white text-black"
                                : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                            }`}
                          >
                            {category}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Window</p>
                      <div className="mt-4 grid grid-cols-3 gap-2">
                        {WINDOW_OPTIONS.map((option) => (
                          <button
                            key={option}
                            type="button"
                            onClick={() => setWindowDays(option)}
                            className={`rounded-2xl border px-3 py-3 text-sm font-black transition ${
                              windowDays === option
                                ? "border-white/20 bg-white text-black"
                                : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                            }`}
                          >
                            {option}d
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                ) : null}

                {step === 2 ? (
                  <>
                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Claim style</p>
                      <div className="mt-4 inline-flex rounded-full border border-white/8 bg-black/20 p-1">
                        <button
                          type="button"
                          onClick={() => setClaimMode("percentile")}
                          className={`rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                            claimMode === "percentile" ? "bg-white text-black" : "text-white/55 hover:text-white"
                          }`}
                        >
                          Percentile
                        </button>
                        <button
                          type="button"
                          onClick={() => setClaimMode("threshold")}
                          className={`rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                            claimMode === "threshold" ? "bg-white text-black" : "text-white/55 hover:text-white"
                          }`}
                        >
                          Threshold
                        </button>
                      </div>
                    </div>

                    {claimMode === "percentile" ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Band</p>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          {PERCENTILE_BANDS.map((band) => (
                            <button
                              key={band}
                              type="button"
                              onClick={() => setSelectedBand(band)}
                              className={`rounded-2xl border px-3 py-3 text-sm font-black transition ${
                                selectedBand === band
                                  ? "border-white/20 bg-white text-black"
                                  : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                              }`}
                            >
                              Top {band}%
                            </button>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-5">
                        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Metric</p>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {Object.keys(THRESHOLD_PRESETS).map((metric) => (
                              <button
                                key={metric}
                                type="button"
                                onClick={() => setSelectedThresholdMetric(metric as keyof typeof THRESHOLD_PRESETS)}
                                className={`rounded-full border px-3 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                                  selectedThresholdMetric === metric
                                    ? "border-white/20 bg-white text-black"
                                    : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                                }`}
                              >
                                {metric}
                              </button>
                            ))}
                          </div>
                        </div>

                        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Threshold</p>
                          <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            {THRESHOLD_PRESETS[selectedThresholdMetric].map((option) => (
                              <button
                                key={`${selectedThresholdMetric}-${option.value.toString()}`}
                                type="button"
                                onClick={() => setSelectedThresholdValue(option.value)}
                                className={`rounded-2xl border px-4 py-3 text-left transition ${
                                  selectedThresholdValue === option.value
                                    ? "border-white/20 bg-white text-black"
                                    : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                                }`}
                              >
                                <p className="text-sm font-black">{option.label}</p>
                                <p className="mt-1 text-xs text-white/45">{humanizeThreshold(selectedThresholdMetric, option.value)}</p>
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                ) : null}

                {step === 3 ? (
                  <>
                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Snapshot readiness</p>
                          <p className="mt-2 text-sm text-white/50">A quick check before proof generation.</p>
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/20 px-3 py-1.5">
                          <ShieldCheck className="h-3.5 w-3.5 text-white/70" />
                          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/75">Private</span>
                        </div>
                      </div>

                      <div className="mt-5 grid gap-3 sm:grid-cols-3">
                        <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Claimed</p>
                          <p className="mt-2 text-sm font-semibold text-white">{claimedRecords.length}</p>
                        </div>
                        <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Window</p>
                          <p className="mt-2 text-sm font-semibold text-white">{snapshotPreview?.records.length ?? 0}</p>
                        </div>
                        <div className="rounded-2xl border border-white/6 bg-black/20 px-4 py-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Peers</p>
                          <p className="mt-2 text-sm font-semibold text-white">{snapshotPreview?.peerSubjects.length ?? 0}</p>
                        </div>
                      </div>

                      <div className="mt-5 rounded-2xl border border-white/6 bg-black/20 p-4">
                        <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Summary</p>
                        <p className="mt-2 text-sm leading-relaxed text-white/65">
                          {selectedCategory} · {windowDays}d · {claimMode === "percentile" ? `Top ${selectedBand}%` : `${selectedThresholdMetric} threshold`}
                        </p>
                      </div>
                    </div>

                    {status ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5 text-sm leading-relaxed text-white/60">
                        {status}
                      </div>
                    ) : null}

                    {credential ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                        <div className="flex items-start justify-between gap-4">
                          <div>
                            <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Generated credential</p>
                            <h3 className="mt-2 text-xl font-black tracking-tight text-white">
                              {credential.publicClaim.statement}
                            </h3>
                          </div>
                          <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 ${credential.isValid ? "border-white/10 bg-white/[0.05]" : "border-white/10 bg-black/20"}`}>
                            <ShieldCheck className={`h-4 w-4 ${credential.isValid ? "text-white/75" : "text-white/55"}`} />
                            <span className={`text-[10px] font-black uppercase tracking-[0.18em] ${credential.isValid ? "text-white/80" : "text-white/55"}`}>
                              {credential.isValid ? "Verified" : "Pending"}
                            </span>
                          </div>
                        </div>

                        <div className="mt-5 grid gap-3 sm:grid-cols-2">
                          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Snapshot commitment</p>
                            <p className="mt-3 font-mono text-xs text-white/80 break-all">{credential.publicClaim.snapshotCommitment}</p>
                          </div>
                          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Proof hash</p>
                            <p className="mt-3 font-mono text-xs text-white/80 break-all">{credential.proofHex}</p>
                          </div>
                        </div>

                        <div className="mt-5 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => void onVerify()}
                            disabled={isVerifying}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-[11px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.07] disabled:opacity-60"
                          >
                            {isVerifying ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                            Verify
                          </button>
                          <button
                            type="button"
                            onClick={() => void navigator.clipboard.writeText(exportText)}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.03] px-4 text-[11px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.07]"
                          >
                            <Copy className="h-4 w-4" />
                            Copy plain text
                          </button>
                        </div>
                      </div>
                    ) : null}

                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <div className="flex items-center justify-between gap-3">
                        <div>
                          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Plain text export</p>
                          <p className="mt-2 text-sm text-white/50">A clean share format for social posts, DMs, or notes.</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void navigator.clipboard.writeText(exportText)}
                          className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-black/20 px-4 text-[10px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.06]"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </button>
                      </div>
                      <textarea
                        readOnly
                        value={exportText}
                        className="mt-4 h-40 w-full resize-none rounded-3xl border border-white/8 bg-[#09090b] px-4 py-4 font-mono text-xs leading-relaxed text-white/72 outline-none"
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>

            <div className="flex flex-col gap-3 border-t border-white/8 px-5 py-5 sm:flex-row sm:items-center sm:justify-between sm:px-8">
              <div className="text-sm text-white/45">
                {step < 3 ? "One small step at a time. We’ll only show the next choice when it matters." : "Generate when the summary feels right."}
              </div>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => {
                    if (step === 1) {
                      onClose();
                      return;
                    }
                    setStep((current) => Math.max(1, current - 1));
                  }}
                  className="inline-flex h-11 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] px-5 text-[11px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.07]"
                >
                  {step === 1 ? "Close" : "Back"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (step < 3) {
                      setStep((current) => current + 1);
                      return;
                    }
                    void onGenerate();
                  }}
                  disabled={busy || categories.length === 0 || !canMoveForward}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white/90 disabled:opacity-60"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : step < 3 ? null : <Sparkles className="h-4 w-4" />}
                  {step < 3 ? "Next" : busy ? "Generating..." : "Create credential"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

export default function ReputationPage() {
  const { user } = usePrivy();
  const [rows, setRows] = useState<StellarMarketRow[]>([]);
  const [savedPositions, setSavedPositions] = useState<BlindPositionRecord[]>([]);
  const [achievements, setAchievements] = useState<AchievementCard[]>([]);
  const [profileName, setProfileName] = useState("Public trader");
  const [profileBio, setProfileBio] = useState("No public market bio yet. Start participating to build a visible reputation trail.");
  const [profileAvatar, setProfileAvatar] = useState<string | null>(null);
  const [syncMode, setSyncMode] = useState<ReputationSyncMode>("server");
  const [isLoading, setIsLoading] = useState(true);
  const [isCredModalOpen, setIsCredModalOpen] = useState(false);
  const [isProfileModalOpen, setIsProfileModalOpen] = useState(false);
  const [claimMode, setClaimMode] = useState<"percentile" | "threshold">("percentile");
  const [windowDays, setWindowDays] = useState<ReputationWindowDays>(90);
  const [selectedCategory, setSelectedCategory] = useState("macro");
  const [selectedBand, setSelectedBand] = useState<(typeof PERCENTILE_BANDS)[number]>(25);
  const [selectedThresholdMetric, setSelectedThresholdMetric] = useState<keyof typeof THRESHOLD_PRESETS>("roi");
  const [selectedThresholdValue, setSelectedThresholdValue] = useState<bigint>(THRESHOLD_PRESETS.roi[0].value);
  const [busy, setBusy] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [status, setStatus] = useState("");
  const [credential, setCredential] = useState<AchievementCard | null>(null);

  const walletAddress = getPrivyStellarWallet(user)?.address ?? "";
  const googleProfile = user?.google as {
    name?: string;
    picture?: string;
    email?: string;
  } | undefined;

  useEffect(() => {
    if (!walletAddress) {
      setProfileName(googleProfile?.name ?? user?.email?.address?.split("@")[0] ?? "Public trader");
      setProfileBio("No public market bio yet. Start participating to build a visible reputation trail.");
      setProfileAvatar(googleProfile?.picture ?? null);
      setSavedPositions([]);
      setAchievements([]);
      setSyncMode("server");
      return;
    }

    let mounted = true;
    const run = async () => {
      try {
        const snapshot = await loadReputationSnapshot(walletAddress, {
          displayName: googleProfile?.name ?? user?.email?.address?.split("@")[0] ?? "Public trader",
          bio: "No public market bio yet. Start participating to build a visible reputation trail.",
          avatarDataUrl: googleProfile?.picture ?? null,
        });

        if (!mounted) {
          return;
        }

        setSavedPositions(snapshot.positions);
        setAchievements(snapshot.achievements as AchievementCard[]);
        setProfileName(snapshot.profile.displayName || "Public trader");
        setProfileBio(snapshot.profile.bio || "No public market bio yet. Start participating to build a visible reputation trail.");
        setProfileAvatar(snapshot.profile.avatarDataUrl || null);
        setSyncMode(snapshot.syncMode);
      } catch (error) {
        console.error("Failed to load reputation snapshot:", error);
      }
    };

    void run();

    return () => {
      mounted = false;
    };
  }, [user, walletAddress]);

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      try {
        const marketIds = await loadMarketIds();
        const settled = await Promise.allSettled(
          marketIds.map(async (marketId) => ({
            marketId,
            view: await loadMarketView(marketId),
          })),
        );

        if (!mounted) {
          return;
        }

        setRows(
          settled.flatMap((result) => (result.status === "fulfilled"
            ? [{ marketId: result.value.marketId, view: result.value.view }]
            : [])),
        );
      } catch (error) {
        console.error("Failed to load markets for reputation page:", error);
      } finally {
        if (mounted) {
          setIsLoading(false);
        }
      }
    };

    void run();
    return () => {
      mounted = false;
    };
  }, []);

  const markets = useMemo(() => rows.map(mapMarketSummary), [rows]);
  const marketMap = useMemo(() => new Map(markets.map((market) => [market.marketId, market])), [markets]);
  const walletPositions = useMemo(
    () => savedPositions.filter((position) => !walletAddress || position.owner === walletAddress),
    [savedPositions, walletAddress],
  );

  const claimedRecords = useMemo(() => (
    walletPositions
      .filter((position) => position.claimedAt)
      .map((position) => {
        const market = marketMap.get(position.marketId);
        const amount = BigInt(position.amountInStroops);
        const payout = market ? payoutForPosition(market, amount) : 0n;
        return {
          marketId: position.marketId,
          subjectId: position.owner,
          category: position.category,
          resolvedAt: market?.settledAt ? Math.floor(market.settledAt / 1000) : 0,
          claimedAt: Math.floor((position.claimedAt ?? 0) / 1000),
          amountInStroops: amount,
          payoutInStroops: payout,
          won: payout > 0n,
          side: position.side,
          marketQuestion: position.marketQuestion,
          commitment: position.commitment,
          nullifier: position.nullifier,
          claimTxHash: position.claimTxHash,
        } satisfies ClaimedReputationRecord;
      })
  ), [marketMap, walletPositions]);

  const categories = useMemo(() => categoryChoices(claimedRecords), [claimedRecords]);

  useEffect(() => {
    if (categories.length > 0 && !categories.includes(selectedCategory)) {
      setSelectedCategory(categories[0]);
    }
  }, [categories, selectedCategory]);

  useEffect(() => {
    setSelectedThresholdValue(THRESHOLD_PRESETS[selectedThresholdMetric][0].value);
  }, [selectedThresholdMetric]);

  const snapshotPreview = useMemo(() => {
    if (!walletAddress || !selectedCategory || claimedRecords.length === 0) {
      return null;
    }

    return buildSnapshot(claimedRecords, {
      category: selectedCategory,
      subjectId: walletAddress,
      windowDays,
    });
  }, [claimedRecords, selectedCategory, walletAddress, windowDays]);

  const reputationScore = useMemo(() => reputationScoreFromAchievements(achievements), [achievements]);
  const totalTrades = claimedRecords.length;
  const totalMarkets = new Set(walletPositions.map((record) => record.marketId)).size;
  const totalCommitted = walletPositions.reduce((sum, record) => sum + BigInt(record.amountInStroops), 0n);
  const topCategory = useMemo(() => topCategoryForPositions(walletPositions), [walletPositions]);
  const totalCategories = useMemo(
    () => new Set(walletPositions.map((position) => position.category.toLowerCase())).size,
    [walletPositions],
  );
  const joinedDate = claimedRecords.length > 0
    ? Math.min(...claimedRecords.map((record) => record.claimedAt * 1000).filter(Boolean))
    : 0;
  const profileHandle = walletAddress ? `@${shortHash(walletAddress, 6, 4)}` : "@public-trader";
  const categoryTags = useMemo(
    () => [...new Set(walletPositions.map((position) => position.category.toLowerCase()))].slice(0, 4),
    [walletPositions],
  );
  const showcaseCards = useMemo(() => buildShowcaseCards(achievements), [achievements]);

  async function handleGenerateCredential() {
    if (!walletAddress) {
      setStatus("Connect your wallet first so the credential can be bound to your address.");
      return;
    }
    if (claimedRecords.length === 0) {
      setStatus("Claim at least one settled position before generating a reputation credential.");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const descriptor = claimMode === "percentile"
        ? createClaimDescriptor({ claimType: "percentile", band: selectedBand })
        : createClaimDescriptor({ claimType: "threshold", metric: selectedThresholdMetric, threshold: selectedThresholdValue });
      const reputationRecords = claimedRecords.map(({ marketId, subjectId, category, resolvedAt, claimedAt, amountInStroops, payoutInStroops, won }) => ({
        marketId,
        subjectId,
        category,
        resolvedAt,
        claimedAt,
        amountInStroops,
        payoutInStroops,
        won,
      }));

      const serialized = await generateReputationProof({
        subjectId: walletAddress,
        category: selectedCategory,
        windowDays,
        descriptor: claimMode === "percentile"
          ? { claimType: "percentile", band: selectedBand }
          : { claimType: "threshold", metric: selectedThresholdMetric, threshold: selectedThresholdValue },
        records: reputationRecords,
      });
      const verified = await verifyReputationProof(serialized);
      const parsed = JSON.parse(serialized) as {
        claim: ReputationClaimDescriptor;
        publicClaim: GeneratedCredential["publicClaim"];
        envelope: { proofHex: string; publicInputsHex: string[] };
      };

      const nextCredential = {
        serialized,
        isValid: verified.isValid,
        proofHex: parsed.envelope.proofHex,
        publicInputsHex: parsed.envelope.publicInputsHex,
        publicClaim: verified.portableClaim.publicClaim,
      };

      const nextEntry: AchievementCard = {
        ...nextCredential,
        createdAt: Date.now(),
        claim: parsed.claim,
      };
      setCredential(nextEntry);
      setAchievements((current) => [nextEntry, ...current].slice(0, 12));
      if (walletAddress) {
        await upsertAchievement(walletAddress, nextEntry as StoredReputationCredential);
      }
      setStatus(`${reputationStatementLabel(descriptor)} ready to share.`);
    } catch (error) {
      console.error("Failed to generate reputation credential:", error);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleVerifyCredential() {
    if (!credential) {
      return;
    }

    setIsVerifying(true);
    setStatus("");
    try {
      const verified = await verifyReputationProof(credential.serialized);
      setCredential((current) => current ? { ...current, isValid: verified.isValid, publicClaim: verified.portableClaim.publicClaim } : current);
      if (walletAddress && credential) {
        await upsertAchievement(walletAddress, {
          ...credential,
          isValid: verified.isValid,
          publicClaim: verified.portableClaim.publicClaim,
          createdAt: Date.now(),
          claim: credential.claim,
        } as StoredReputationCredential);
      }
      setStatus(verified.isValid ? "Credential verified successfully." : "Credential verification failed.");
    } catch (error) {
      console.error("Failed to verify reputation credential:", error);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsVerifying(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#050507] text-white selection:bg-white selection:text-black">
      <Navbar transparent={false} />

      <main className="px-4 py-24 sm:px-6 sm:py-28 md:px-8 md:py-32 lg:px-12">
        {isLoading ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-violet-400" />
              <span className="text-[10px] font-black uppercase tracking-[0.38em] text-violet-400/70">
                Loading Reputation
              </span>
            </div>
          </div>
        ) : (
          <div className="mx-auto max-w-[1280px]">
            <header className="mb-8 md:mb-12">
              <h1 className="text-lg sm:text-xl md:text-2xl font-black tracking-tight text-white mb-1 uppercase leading-none">
                Reputation
              </h1>
              <p className="text-white/40 font-medium text-[9px] sm:text-xs uppercase tracking-widest">
                Public trader profile and verifiable credentials
              </p>
            </header>

            <section className="grid gap-10 lg:grid-cols-[400px_minmax(0,1fr)]">
              <aside className="px-2 pt-2">
                <div className="flex items-start gap-6">
                  <div className="flex h-24 w-24 shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full border border-white/5 bg-[#121214] text-2xl font-black uppercase text-white">
                    {profileAvatar ? (
                      <img src={profileAvatar} alt={profileName} className="block h-full w-full min-h-full min-w-full rounded-full object-cover" />
                    ) : (
                      profileName.slice(0, 1)
                    )}
                  </div>
                  <div className="pt-1">
                    <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white leading-none">{profileName}</h1>
                    <p className="mt-2 text-sm sm:text-base leading-none text-white">{profileHandle}</p>
                    <p className="mt-3 text-[8px] font-black uppercase tracking-[0.28em] text-violet-300/55">Prediction market reputation</p>
                  </div>
                </div>

                <div className="mt-7">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-[0.26em] text-white/35">Reputation score</p>
                      <p className="mt-2 text-3xl font-black tracking-tight text-white">{reputationScore}</p>
                    </div>
                    <div className="text-right text-xs text-white/60">
                      <p>{totalMarkets} markets</p>
                      <p className="mt-1">{formatUsdc(totalCommitted)} collateral</p>
                    </div>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/8">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${reputationScore}%` }}
                      transition={{ duration: 0.7, ease: "easeOut" }}
                      className="h-full rounded-full bg-[linear-gradient(90deg,rgba(124,58,237,0.95),rgba(168,85,247,0.9),rgba(255,255,255,0.92))]"
                    />
                  </div>

                  <div className="mt-5 flex flex-wrap gap-4 text-xs text-white/48">
                    <p><span className="mr-2 font-black text-violet-300">{totalMarkets}</span>Markets</p>
                    <p><span className="mr-2 font-black text-violet-300">{formatUsdc(totalCommitted)}</span>Collateral</p>
                    <p><span className="mr-2 font-black text-violet-300">{achievements.length}</span>Creds</p>
                  </div>
                </div>

                <div className="mt-8 border-t border-white/8 pt-8">
                  <div className="space-y-3 text-[14px] text-white/78">
                    <div className="flex items-center gap-3 text-white/55">
                      <span className="text-sm">□</span>
                      <span>{walletAddress ? shortHash(walletAddress, 10, 8) : "Wallet not connected"}</span>
                    </div>
                    <div className="flex items-center gap-3 text-white/55">
                      <span className="text-sm">▦</span>
                      <span>{totalCategories > 0 ? `${totalCategories} active categor${totalCategories === 1 ? "y" : "ies"}` : "No active categories yet"}</span>
                    </div>
                    <p className="pt-1 text-sm leading-relaxed text-white">{profileBio}</p>
                  </div>

                </div>

                <div className="mt-8 border-t border-white/8 pt-8">
                  <div className="flex flex-wrap gap-3">
                    <button
                      type="button"
                      onClick={() => setIsCredModalOpen(true)}
                      className="inline-flex h-11 items-center justify-center rounded-xl bg-white px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-black transition hover:bg-white/90"
                    >
                      Generate Cred
                    </button>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(walletAddress || "")}
                      className="inline-flex h-11 items-center justify-center rounded-xl border border-white/10 bg-[#121214]/60 px-4 text-[11px] font-bold uppercase tracking-[0.12em] text-white transition hover:border-white/20"
                    >
                      Copy Wallet
                    </button>
                  </div>
                </div>

                <div className="mt-8 border-t border-white/8 pt-8">
                  <h2 className="text-base sm:text-lg font-black tracking-tight text-white">Coverage</h2>
                  <div className="mt-4 flex flex-wrap gap-2.5">
                    {categoryTags.length > 0 ? categoryTags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-xl border border-violet-500/20 bg-violet-500/10 px-3 py-1.5 text-xs uppercase tracking-[0.12em] text-violet-200"
                      >
                        {tag}
                      </span>
                    )) : (
                      <span className="text-sm text-white/45">Categories will appear after positions are settled and claimed.</span>
                    )}
                  </div>

                  <div className="mt-8 border-t border-white/8 pt-6 text-[9px] font-medium uppercase tracking-widest text-white/38">
                    Reputation score {reputationScore}/100 · {joinedDate ? formatShortDate(joinedDate) : "No history yet"} · {walletAddress ? shortHash(walletAddress, 8, 6) : "Wallet pending"}
                  </div>
                </div>
              </aside>

              <div className="min-w-0">
                <div className="border-b border-white/8">
                  <div className="flex items-center gap-6">
                    <button
                      type="button"
                      className="border-b-2 border-violet-400 pb-3 text-base sm:text-lg font-semibold text-violet-300"
                    >
                      Reputation
                    </button>
                  </div>
                </div>

                <div className="mt-10">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <h2 className="text-base sm:text-lg md:text-xl font-black uppercase tracking-tight text-white">Reputation Cards</h2>
                      <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-[10px] font-semibold text-violet-200">
                        {achievements.length}
                      </span>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    {showcaseCards.length === 0 ? (
                      <div className="xl:col-span-2 rounded-[22px] border border-white/5 bg-[#121214]/70 p-5">
                        <p className="text-base font-black tracking-tight text-white">No public creds yet</p>
                        <p className="mt-2 text-xs leading-relaxed text-white/55">
                          Reputation cards appear here after you generate public, verifiable credentials from your market activity.
                        </p>
                      </div>
                    ) : showcaseCards.map((card, index) => (
                      <div
                        key={card.id}
                        className="rounded-[22px] border border-white/5 bg-[#121214]/70 p-4"
                      >
                        <div className="flex items-center gap-2 text-xs text-white/55">
                          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-black text-xs font-bold text-white">
                            {profileName.slice(0, 1)}
                          </div>
                          <span>{profileName}</span>
                        </div>

                        <div className="mt-4 flex gap-4">
                          <div className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-xl text-xl font-black text-white ${
                            index % 4 === 0
                              ? "bg-[#9f15ff]"
                              : index % 4 === 1
                                ? "bg-[#f3efe5] text-[#111111]"
                                : index % 4 === 2
                                  ? "bg-[#1f1f1f]"
                                  : "bg-[#281e32]"
                          }`}>
                            {card.title.slice(0, 1)}
                          </div>

                          <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                              <h3 className="text-base sm:text-lg font-black leading-tight text-white">{card.title}</h3>
                              <span className="rounded-full border border-white/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/45">
                                {card.status}
                              </span>
                            </div>
                            <p className="mt-2 text-xs leading-relaxed text-white/72">{card.description}</p>
                            <p className="mt-3 text-xs text-white/40">{card.meta}</p>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
                          {card.tags.map((tag) => (
                            <span
                              key={`${card.id}-${tag}`}
                              className="rounded-xl border border-violet-500/20 bg-violet-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-violet-200"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      <ReputationModal
        isOpen={isCredModalOpen}
        onClose={() => setIsCredModalOpen(false)}
        walletAddress={walletAddress}
        categories={categories}
        claimedRecords={claimedRecords}
        claimMode={claimMode}
        setClaimMode={setClaimMode}
        selectedCategory={selectedCategory}
        setSelectedCategory={setSelectedCategory}
        windowDays={windowDays}
        setWindowDays={setWindowDays}
        selectedBand={selectedBand}
        setSelectedBand={setSelectedBand}
        selectedThresholdMetric={selectedThresholdMetric}
        setSelectedThresholdMetric={setSelectedThresholdMetric}
        selectedThresholdValue={selectedThresholdValue}
        setSelectedThresholdValue={setSelectedThresholdValue}
        busy={busy}
        status={status}
        credential={credential}
        isVerifying={isVerifying}
        onGenerate={handleGenerateCredential}
        onVerify={handleVerifyCredential}
      />

      <PublicProfileOnboardingModal
        isOpen={isProfileModalOpen}
        onOpenChange={setIsProfileModalOpen}
      />
    </div>
  );
}
