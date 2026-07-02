"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "framer-motion";
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDown, Copy, HelpCircle, Loader2, MoreVertical, Share2, ShieldCheck, Sparkles, X } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { Navbar } from "@/components/landing/Navbar";
import { PublicProfileSettingsModal } from "@/components/profile/PublicProfileSettingsModal";
import { mapMarketSummary, payoutForPosition, formatUsdc } from "@/lib/blind-market";
import { DEFAULT_PROFILE_AVATAR } from "@/lib/profile-avatar";
import { computeRecordCommitment, generateReputationProof, verifyReputationProof } from "@/lib/proofs";
import {
  buildSnapshot,
  createClaimDescriptor,
  reputationStatementLabel,
  verifyAttestedRecordSignature,
  type AttestedReputationRecord,
  type PrivateReputationWitness,
  type ReputationRecordInput,
  type ReputationMetric,
  type ReputationWindowDays,
  type SerializedReputationClaimDescriptor,
} from "@/lib/reputation";
import { getPrivyStellarWallet, loadMarketIds, loadMarketView, type MarketView } from "@/lib/stellar";
import { type BlindPositionRecord } from "@/lib/types";
import {
  attestClaimRecord,
  loadReputationSnapshot,
  markClaimedPosition,
  archiveAchievement,
  removeAchievement,
  replaceAchievements,
  upsertAchievement,
  upsertAttestedRecord,
  type ReputationSyncMode,
  type StoredReputationCredential,
} from "@/lib/reputation-vault";
import { createReputationShare, reputationSharePath } from "@/lib/reputation-share";

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
  witnessSalt: string;
  recordCommitment: string;
};

type GeneratedCredential = {
  serialized: string;
  proofHex: string;
  publicInputsHex: string[];
  snapshotRoot: string;
  attestorKeyId: string;
  proofValid: boolean;
  snapshotVerified: boolean;
  displayOrder?: number;
  archivedAt?: number | null;
  publicClaim: {
    subjectId: string;
    category: string;
    windowDays: ReputationWindowDays;
    snapshotRoot: string;
    attestorKeyId: string;
    createdAt: number;
    snapshotRecordCount: number;
    statement: string;
  };
};

type AchievementCard = GeneratedCredential & {
  id: string;
  createdAt: number;
  claim: SerializedReputationClaimDescriptor;
};

const WINDOW_OPTIONS: ReputationWindowDays[] = [30, 90, 180];
const PERCENTILE_BANDS = [10, 25, 50] as const;
const THRESHOLD_PRESETS = {
  roi: [
    { label: "Claim ROI > 20%", value: 2000n },
    { label: "Claim ROI > 50%", value: 5000n },
  ],
  profit: [
    { label: "Claim profit > 5 USDC", value: 50_000_000n },
    { label: "Claim profit > 10 USDC", value: 100_000_000n },
  ],
  winRate: [
    { label: "Claim win rate > 60%", value: 6000n },
    { label: "Claim win rate > 75%", value: 7500n },
  ],
  participation: [
    { label: "3 claimed markets", value: 3n },
    { label: "5 claimed markets", value: 5n },
  ],
  exposure: [
    { label: "50 USDC claim exposure", value: 500000000n },
    { label: "100 USDC claim exposure", value: 1000000000n },
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

function normalizeHexish(value: string | null | undefined) {
  return (value ?? "").toLowerCase().replace(/^0x/, "");
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
  return reputationStatementLabel(achievement.claim);
}

function compactField(value: string, start = 10, end = 8) {
  return shortHash(value, start, end);
}

function downloadJson(filename: string, value: unknown) {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

function scoreForAchievement(achievement: AchievementCard) {
  const claim = achievement.claim;
  if (claim.claimType === "percentile") {
    const baseScore = claim.band === 10 ? 22 : claim.band === 25 ? 15 : 9;
    const windowBonus = achievement.publicClaim.windowDays === 180
      ? 4
      : achievement.publicClaim.windowDays === 90
        ? 2
        : 0;
    return baseScore + windowBonus;
  }

  const threshold = Number(claim.threshold);
  const metricScore = claim.metric === "winRate"
    ? Math.max(10, Math.min(16, Math.round(threshold / 1250)))
    : claim.metric === "roi"
      ? Math.max(9, Math.min(15, Math.round(threshold / 900)))
      : claim.metric === "profit"
        ? Math.max(8, Math.min(14, Math.round(threshold / 12_500_000)))
        : claim.metric === "participation"
          ? Math.max(6, Math.min(11, threshold * 2))
          : Math.max(7, Math.min(12, Math.round(threshold / 125_000_000)));

  const windowBonus = achievement.publicClaim.windowDays === 180
    ? 4
    : achievement.publicClaim.windowDays === 90
      ? 2
      : 0;

  return metricScore + windowBonus;
}

function achievementCreatedAtValue(achievement: AchievementCard) {
  return achievement.publicClaim.createdAt ?? achievement.createdAt ?? 0;
}

function achievementFamilyKey(achievement: AchievementCard) {
  const { claim, publicClaim } = achievement;
  const baseKey = `${publicClaim.category.toLowerCase()}:${publicClaim.windowDays}`;
  if (claim.claimType === "percentile") {
    return `${baseKey}:percentile`;
  }
  return `${baseKey}:threshold:${claim.metric}`;
}

function achievementStrengthValue(achievement: AchievementCard) {
  const { claim } = achievement;
  if (claim.claimType === "percentile") {
    return claim.band === 10 ? 3 : claim.band === 25 ? 2 : 1;
  }
  return Number(claim.threshold);
}

function compareAchievementsForScoring(left: AchievementCard, right: AchievementCard) {
  const strengthDelta = achievementStrengthValue(left) - achievementStrengthValue(right);
  if (strengthDelta !== 0) {
    return strengthDelta;
  }
  return achievementCreatedAtValue(left) - achievementCreatedAtValue(right);
}

function achievementsUsedForReputationScore(achievements: AchievementCard[]) {
  const strongestByFamily = new Map<string, AchievementCard>();

  achievements
    .filter((achievement) => !achievement.archivedAt && achievement.proofValid && achievement.snapshotVerified)
    .forEach((achievement) => {
      const familyKey = achievementFamilyKey(achievement);
      const current = strongestByFamily.get(familyKey);
      if (!current || compareAchievementsForScoring(achievement, current) > 0) {
        strongestByFamily.set(familyKey, achievement);
      }
    });

  return Array.from(strongestByFamily.values());
}

function metricsFromRecords(records: Array<{
  amountInStroops: bigint;
  payoutInStroops: bigint;
  won: boolean;
}>) {
  const participation = BigInt(records.length);
  const exposure = records.reduce((sum, record) => sum + record.amountInStroops, 0n);
  const profit = records.reduce((sum, record) => sum + (record.payoutInStroops - record.amountInStroops), 0n);
  const wins = BigInt(records.filter((record) => record.won).length);
  const roi = exposure > 0n ? (profit * 10_000n) / exposure : 0n;
  const winRate = participation > 0n ? (wins * 10_000n) / participation : 0n;

  return {
    roi,
    profit,
    winRate,
    participation,
    exposure,
  };
}

function metricLabel(metric: ReputationMetric) {
  if (metric === "winRate") return "win rate";
  if (metric === "roi") return "ROI";
  return metric;
}

function reputationScoreFromAchievements(achievements: AchievementCard[]) {
  const scoringAchievements = achievementsUsedForReputationScore(achievements);
  if (scoringAchievements.length === 0) {
    return 0;
  }

  const rawScore = scoringAchievements.reduce((sum, achievement) => sum + scoreForAchievement(achievement), 0);
  const marketCoverage = scoringAchievements.reduce(
    (max, achievement) => Math.max(max, achievement.publicClaim.snapshotRecordCount ?? 1),
    1,
  );
  const marketCountCeiling = Math.min(100, 24 + marketCoverage * 8);
  return Math.max(0, Math.min(100, Math.min(rawScore, marketCountCeiling)));
}

function plainTextExport(credential: GeneratedCredential | null) {
  if (!credential) {
    return "Generate a reputation credential to export it here.";
  }

  return [
    "Aegis zk reputation credential",
    `Subject: ${credential.publicClaim.subjectId}`,
    `Category: ${credential.publicClaim.category}`,
    `Window: ${credential.publicClaim.windowDays}d`,
    `Created at: ${formatCredentialCreatedAt(credential.publicClaim.createdAt)}`,
    `Snapshot size: ${credentialSnapshotSizeLabel(credential.publicClaim.snapshotRecordCount)}`,
    `Statement: ${credential.publicClaim.statement}`,
    `Snapshot root: ${credential.publicClaim.snapshotRoot}`,
    `Proof hash: ${credential.proofHex}`,
    `Proof valid: ${credential.proofValid ? "yes" : "no"}`,
    `Snapshot verified: ${credential.snapshotVerified ? "yes" : "no"}`,
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

function credentialWindowLabel(days: number) {
  return `${days}-day window`;
}

function formatCredentialCreatedAt(timestampMs: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestampMs);
}

function credentialSnapshotSizeLabel(value?: number) {
  const safeValue = value ?? 1;
  return `${safeValue.toString()} market${safeValue === 1 ? "" : "s"}`;
}

function normalizeAchievementDisplayOrder(achievements: AchievementCard[]) {
  return achievements.map((achievement, index) => ({
    ...achievement,
    id: achievement.id ?? `${achievement.proofHex}-${achievement.publicClaim.createdAt ?? achievement.createdAt ?? index}`,
    displayOrder: typeof achievement.displayOrder === "number" ? achievement.displayOrder : index,
  }));
}

type ReputationTrendPoint = {
  label: string;
  score: number;
};

type ShowcaseCredentialCard = {
  id: string;
  title: string;
  serialized: string;
  category: string;
  description: string;
  meta: string;
  snapshotRecordCount: number;
  displayOrder?: number;
  archivedAt?: number | null;
  tags: string[];
  status: string;
  snapshotRoot: string;
  proofHex: string;
  publicInputsHex: string[];
  attestorKeyId: string;
  claim: SerializedReputationClaimDescriptor;
};

type SortableCredentialCardProps = {
  card: ShowcaseCredentialCard;
  profileName: string;
  profileAvatar: string | null;
  openCardMenuId: string | null;
  selectedCardTab: "active" | "archive";
  removingCardId: string | null;
  verifyingCardId: string | null;
  verificationNotice: { cardId: string; message: string } | null;
  onToggleMenu: (cardId: string) => void;
  onArchive: (card: ShowcaseCredentialCard) => void;
  onRemove: (card: ShowcaseCredentialCard) => void;
  onShowDetails: (card: ShowcaseCredentialCard) => void;
  onVerify: (card: ShowcaseCredentialCard) => void;
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
    return achievements.map((achievement) => ({
      id: `${achievement.proofHex}-${achievement.createdAt}`,
      title: achievementLabel(achievement),
      serialized: achievement.serialized,
      category: achievement.publicClaim.category,
      description: `Proof-backed reputation statement for ${achievement.publicClaim.category} over a ${achievement.publicClaim.windowDays}-day window.`,
      meta: `Created ${formatCredentialCreatedAt(achievement.publicClaim.createdAt ?? achievement.createdAt)} · ${credentialWindowLabel(achievement.publicClaim.windowDays)}`,
      snapshotRecordCount: achievement.publicClaim.snapshotRecordCount ?? 1,
      displayOrder: achievement.displayOrder,
      tags: [achievement.publicClaim.category, `${scoreForAchievement(achievement)} pts`],
      status: achievement.proofValid && achievement.snapshotVerified ? "verified" : "draft",
      snapshotRoot: achievement.publicClaim.snapshotRoot,
      proofHex: achievement.proofHex,
      publicInputsHex: achievement.publicInputsHex,
      attestorKeyId: achievement.attestorKeyId,
      archivedAt: achievement.archivedAt ?? null,
      claim: achievement.claim,
    }));
  }
  return [];
}

function SortableCredentialCard({
  card,
  profileName,
  profileAvatar,
  openCardMenuId,
  selectedCardTab,
  removingCardId,
  verifyingCardId,
  verificationNotice,
  onToggleMenu,
  onArchive,
  onRemove,
  onShowDetails,
  onVerify,
}: SortableCredentialCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: card.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 30 : undefined,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="h-full touch-none"
      {...attributes}
      {...listeners}
    >
      <div
        className={`relative flex h-full flex-col rounded-[24px] border border-white/8 bg-[#101013] p-5 transition ${
          isDragging ? "cursor-grabbing opacity-90 shadow-[0_18px_40px_rgba(0,0,0,0.34)]" : "cursor-grab"
        }`}
      >
        <div className="flex items-center justify-between gap-3 text-xs text-white/55">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 overflow-hidden rounded-full border border-white/8 bg-black">
              <img src={profileAvatar || DEFAULT_PROFILE_AVATAR} alt={profileName} className="h-full w-full object-cover" />
            </div>
            <span className="text-[13px] text-white/62">{profileName}</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex items-center gap-2">
              <button
                type="button"
                onClick={() => onToggleMenu(card.id)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/50 transition hover:bg-white/[0.06] hover:text-white"
                aria-label="Card options"
              >
                <MoreVertical className="h-4 w-4" />
              </button>
              <AnimatePresence>
                {openCardMenuId === card.id ? (
                  <motion.div
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.15 }}
                    className="absolute right-0 top-11 z-20 w-52 overflow-hidden rounded-2xl border border-white/10 bg-[#101012] p-2 shadow-2xl"
                  >
                    <button
                      type="button"
                      onClick={() => onArchive(card)}
                      disabled={selectedCardTab !== "archive" && Boolean(card.archivedAt)}
                      className="flex w-full items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm text-sky-200 transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <Sparkles className="h-4 w-4" />
                      {selectedCardTab === "archive"
                        ? "Remove from archive"
                        : card.archivedAt
                          ? "Archived"
                          : "Archive"}
                    </button>
                    <button
                      type="button"
                      onClick={() => onRemove(card)}
                      disabled={removingCardId === card.id}
                      className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm text-rose-200 transition hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      <X className="h-4 w-4" />
                      Remove
                    </button>
                  </motion.div>
                ) : null}
              </AnimatePresence>
            </div>
          </div>
        </div>

        <div className="mt-5 flex gap-4">
          <div className="mt-0.5 h-11 w-11 shrink-0 overflow-hidden">
            <Image
              src="/reputation.png"
              alt="Reputation badge"
              width={44}
              height={44}
              className="h-full w-full object-cover"
            />
          </div>

          <div className="min-w-0 flex-1">
            <h3 className="text-[27px] font-semibold leading-[1.05] tracking-[-0.04em] text-white sm:text-[30px]">{card.title}</h3>
            <p className="mt-3 text-[12px] leading-6 text-white/42">{card.meta}</p>
            <p className="mt-2 text-[10px] font-black uppercase tracking-[0.18em] text-white/28">
              {credentialSnapshotSizeLabel(card.snapshotRecordCount)}
            </p>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-2">
          {card.tags.map((tag) => (
            <span
              key={`${card.id}-${tag}`}
              className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-white/70"
            >
              {tag}
            </span>
          ))}
          {card.archivedAt ? (
            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-white/70">
              Archived on {formatShortDate(card.archivedAt)}
            </span>
          ) : null}
        </div>

        <div className="mt-auto pt-5">
          <hr className="border-white/8" />
          <div className="pt-4">
            <div className="flex flex-wrap items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => onShowDetails(card)}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/72 transition hover:bg-white/[0.06]"
              >
                Show details
              </button>
              <button
                type="button"
                onClick={() => onVerify(card)}
                disabled={verifyingCardId !== null}
                className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-white px-3 text-[10px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {verifyingCardId === card.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                {verifyingCardId === card.id ? "Verifying..." : "Verify"}
              </button>
            </div>
          </div>
        </div>
        {verificationNotice?.cardId === card.id ? (
          <p className="mt-3 text-[11px] font-semibold text-emerald-300">
            {verificationNotice.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ShowcaseDetailsModal({
  card,
  onClose,
}: {
  card: ShowcaseCredentialCard | null;
  onClose: () => void;
}) {
  const open = Boolean(card);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open && card ? (
        <div className="fixed inset-0 z-[240] flex items-center justify-center p-4 sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/72 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <motion.div
            className="relative z-10 flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-[32px] border border-white/10 bg-[#101012] shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 border-b border-white/6 px-5 py-5 sm:px-6">
              <div className="min-w-0">
                <p className="text-[10px] font-black uppercase tracking-[0.26em] text-white/30">Show details</p>
                <h3 className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">
                  {card.title}
                </h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">
                  {card.description}
                </p>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/70 transition hover:bg-white/[0.08] hover:text-white"
                aria-label="Close details"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto custom-scrollbar px-5 py-5 sm:px-6">
              <div className="flex flex-wrap gap-2 justify-center">
                {card.tags.map((tag) => (
                  <span
                    key={`${card.id}-${tag}`}
                    className="rounded-xl border border-violet-500/20 bg-violet-500/10 px-2.5 py-1 text-[10px] uppercase tracking-[0.14em] text-violet-200"
                  >
                    {tag}
                  </span>
                ))}
              </div>

              <div className="mt-5 rounded-[28px] border border-white/8 bg-white/[0.04] px-5 py-5 shadow-[0_18px_45px_rgba(0,0,0,0.28)]">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-black uppercase tracking-[0.26em] text-white/25">Proof hash</p>
                    <p className="mt-1 text-xs text-white/35">Primary proof envelope value.</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText(card.proofHex)}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08]"
                  >
                    <Copy className="h-3.5 w-3.5" />
                    Copy
                  </button>
                </div>
                <div className="mt-3 max-h-48 overflow-auto custom-scrollbar break-all whitespace-pre-wrap font-mono text-sm leading-relaxed text-white sm:text-base">
                  {card.proofHex}
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Snapshot root</p>
                    <button
                      type="button"
                      onClick={() => void copyText(card.snapshotRoot)}
                      className="inline-flex h-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/65 transition hover:bg-white/[0.08]"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-2 max-h-24 overflow-auto custom-scrollbar font-mono text-xs leading-relaxed text-white/80 break-all">
                    {compactField(card.snapshotRoot)}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Attestor key</p>
                    <button
                      type="button"
                      onClick={() => void copyText(card.attestorKeyId)}
                      className="inline-flex h-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/65 transition hover:bg-white/[0.08]"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-2 max-h-24 overflow-auto custom-scrollbar font-mono text-xs leading-relaxed text-white/80 break-all">
                    {compactField(card.attestorKeyId)}
                  </div>
                </div>
              </div>

              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Public inputs</p>
                    <button
                      type="button"
                      onClick={() => void copyText(card.publicInputsHex.join(" · "))}
                      className="inline-flex h-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/65 transition hover:bg-white/[0.08]"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-2 max-h-28 overflow-auto custom-scrollbar font-mono text-xs leading-relaxed text-white/80 break-all">
                    {card.publicInputsHex.join(" · ")}
                  </div>
                </div>

                <div className="rounded-2xl border border-white/6 bg-white/[0.03] px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Claim payload</p>
                    <button
                      type="button"
                      onClick={() => void copyText(JSON.stringify(card.claim, null, 2))}
                      className="inline-flex h-7 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-2.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/65 transition hover:bg-white/[0.08]"
                    >
                      <Copy className="h-3 w-3" />
                    </button>
                  </div>
                  <pre className="mt-2 max-h-28 overflow-auto custom-scrollbar rounded-xl bg-black/20 p-3 font-mono text-[11px] leading-relaxed text-white/70 whitespace-pre-wrap break-words">
                    {JSON.stringify(card.claim, null, 2)}
                  </pre>
                </div>
              </div>

              <div className="mt-5 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  onClick={() => void copyText(JSON.stringify(card, null, 2))}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08]"
                >
                  <Copy className="h-3.5 w-3.5" />
                  Copy JSON
                </button>
                <button
                  type="button"
                  onClick={() => downloadJson(`reputation-card-${card.id}.json`, card)}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08]"
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08]"
                >
                  Close
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function RemoveAchievementModal({
  card,
  isRemoving,
  onClose,
  onConfirm,
}: {
  card: AchievementCard | null;
  isRemoving: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const open = Boolean(card);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  return (
    <AnimatePresence>
      {open && card ? (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/72 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <motion.div
            className="relative z-10 w-full max-w-md overflow-hidden rounded-[28px] border border-white/10 bg-[#101012] shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-white/6 px-5 py-5">
              <p className="text-[10px] font-black uppercase tracking-[0.26em] text-rose-300/70">Confirm removal</p>
              <h3 className="mt-2 text-lg font-black tracking-tight text-white">Remove this reputation card?</h3>
              <p className="mt-2 text-sm leading-relaxed text-white/55">
                This will delete the card from local storage, and from the server vault too if you are in server-backed sync mode.
              </p>
            </div>

            <div className="px-5 py-5">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Card</p>
                <p className="mt-2 text-sm font-semibold text-white">
                  {card.publicClaim?.statement ?? "Reputation card"}
                </p>
              </div>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isRemoving}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onConfirm}
                  disabled={isRemoving}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-rose-400/20 bg-rose-500/10 px-3 text-[10px] font-black uppercase tracking-[0.18em] text-rose-200 transition hover:bg-rose-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isRemoving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {isRemoving ? "Removing..." : "Remove"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function ShareReputationModal({
  shareUrl,
  version,
  onClose,
}: {
  shareUrl: string | null;
  version: number | null;
  onClose: () => void;
}) {
  const open = Boolean(shareUrl);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose, open]);

  async function handleCopy() {
    if (!shareUrl) {
      return;
    }
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <AnimatePresence>
      {open && shareUrl ? (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/72 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
          />

          <motion.div
            className="relative z-10 w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-[#101012] shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-white/6 px-5 py-5">
              <p className="text-[10px] font-black uppercase tracking-[0.26em] text-violet-300/70">Public share ready</p>
              <h3 className="mt-2 text-lg font-black tracking-tight text-white">
                Your reputation link is live
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/55">
                Anyone with this link can view your public reputation snapshot{typeof version === "number" ? ` · v${version}` : ""}.
              </p>
            </div>

            <div className="px-5 py-5">
              <div className="rounded-2xl border border-white/8 bg-white/[0.04] px-4 py-3">
                <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Share link</p>
                <div className="mt-3 flex items-center gap-3">
                  <p className="min-w-0 flex-1 break-all text-sm text-white/88">{shareUrl}</p>
                  <button
                    type="button"
                    onClick={() => void handleCopy()}
                    className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/75 transition hover:bg-white/[0.08]"
                    aria-label="Copy share link"
                    title="Copy share link"
                  >
                    <Copy className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-3 text-xs text-white/45">
                  {copied ? "Link copied to clipboard." : "Share this link anywhere you want people to view your public reputation page."}
                </p>
              </div>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={() => window.open(shareUrl, "_blank", "noopener,noreferrer")}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08]"
                >
                  Open link
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-violet-400/20 bg-violet-500/10 px-3 text-[10px] font-black uppercase tracking-[0.18em] text-violet-200 transition hover:bg-violet-500/15"
                >
                  Done
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}

function LocalShareWarningModal({
  open,
  onClose,
  onContinue,
  isSharing,
}: {
  open: boolean;
  onClose: () => void;
  onContinue: () => void;
  isSharing: boolean;
}) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isSharing) {
        onClose();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [isSharing, onClose, open]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-[250] flex items-center justify-center p-4 sm:p-6">
          <motion.div
            className="absolute inset-0 bg-black/72 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={isSharing ? undefined : onClose}
          />

          <motion.div
            className="relative z-10 w-full max-w-xl overflow-hidden rounded-[28px] border border-white/10 bg-[#101012] shadow-[0_28px_90px_rgba(0,0,0,0.65)]"
            initial={{ opacity: 0, y: 18, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 260, damping: 24 }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="border-b border-white/6 px-5 py-5">
              <p className="text-[10px] font-black uppercase tracking-[0.26em] text-amber-300/70">Local mode notice</p>
              <h3 className="mt-2 text-lg font-black tracking-tight text-white">
                Link generation needs server storage
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-white/55">
                Your profile is currently in local mode, so this public share does not exist on the server yet. Link generation is not possible unless we first upload the minimal public snapshot needed for the shared page.
              </p>
            </div>

            <div className="px-5 py-5">
              <div className="rounded-2xl border border-amber-400/15 bg-amber-500/10 px-4 py-3 text-sm leading-relaxed text-white/75">
                Continuing will send only these fields to the server:
                your public profile, public summary stats, attested verification records, and active reputation cards.
                It will not upload your full private local history.
              </div>

              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSharing}
                  className="inline-flex h-9 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] px-3 text-[10px] font-black uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={onContinue}
                  disabled={isSharing}
                  className="inline-flex h-9 items-center justify-center gap-2 rounded-full border border-amber-400/20 bg-amber-500/10 px-3 text-[10px] font-black uppercase tracking-[0.18em] text-amber-200 transition hover:bg-amber-500/15 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isSharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  {isSharing ? "Publishing..." : "Continue"}
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
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
  credential: AchievementCard | null;
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
  const [isGenerateStarting, setIsGenerateStarting] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setStep(1);
      setIsGenerateStarting(false);
      return;
    }
    setStep(1);
    setIsGenerateStarting(false);
  }, [isOpen]);

  useEffect(() => {
    if (!busy) {
      setIsGenerateStarting(false);
    }
  }, [busy]);

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

  const snapshotMetrics = useMemo(() => (
    snapshotPreview ? metricsFromRecords(snapshotPreview.records) : null
  ), [snapshotPreview]);

  const percentileAvailability = useMemo(() => {
    if (!snapshotPreview || !snapshotMetrics) {
      return PERCENTILE_BANDS.map((band) => ({
        band,
        achievable: false,
        reason: "No eligible snapshot is available yet.",
      }));
    }

    const eligiblePeers = snapshotPreview.peerSubjects
      .map(({ records }) => metricsFromRecords(records))
      .filter((metrics) => metrics.participation >= 2n);
    const eligibleCount = BigInt(Math.max(1, eligiblePeers.length + 1));
    const rank = 1n + BigInt(eligiblePeers.filter((metrics) => metrics.roi > snapshotMetrics.roi).length);

    return PERCENTILE_BANDS.map((band) => {
      const achievable = rank * 100n <= eligibleCount * BigInt(band);
      return {
        band,
        achievable,
        reason: achievable
          ? ""
          : `Your current rank is ${rank.toString()} of ${eligibleCount.toString()} eligible subjects, so top ${band}% is not reachable yet.`,
      };
    });
  }, [snapshotMetrics, snapshotPreview]);

  const thresholdAvailability = useMemo(() => {
    if (!snapshotMetrics) {
      return Object.entries(THRESHOLD_PRESETS).reduce((acc, [metric, options]) => {
        acc[metric as keyof typeof THRESHOLD_PRESETS] = options.map((option) => ({
          ...option,
          achievable: false,
          reason: "No eligible snapshot is available yet.",
        }));
        return acc;
      }, {} as Record<keyof typeof THRESHOLD_PRESETS, Array<{ label: string; value: bigint; achievable: boolean; reason: string }>>);
    }

    const values = {
      roi: snapshotMetrics.roi,
      profit: snapshotMetrics.profit,
      winRate: snapshotMetrics.winRate,
      participation: snapshotMetrics.participation,
      exposure: snapshotMetrics.exposure,
    } satisfies Record<ReputationMetric, bigint>;

    return Object.entries(THRESHOLD_PRESETS).reduce((acc, [metric, options]) => {
      const currentValue = values[metric as ReputationMetric];
      acc[metric as keyof typeof THRESHOLD_PRESETS] = options.map((option) => {
        const achievable = currentValue >= option.value;
        return {
          ...option,
          achievable,
          reason: achievable
            ? ""
            : `Current ${metricLabel(metric as ReputationMetric)} is ${humanizeThreshold(metric as keyof typeof THRESHOLD_PRESETS, currentValue)}.`,
        };
      });
      return acc;
    }, {} as Record<keyof typeof THRESHOLD_PRESETS, Array<{ label: string; value: bigint; achievable: boolean; reason: string }>>);
  }, [snapshotMetrics]);

  const selectedThresholdOptions = thresholdAvailability[selectedThresholdMetric];
  const selectedThresholdOption = selectedThresholdOptions.find((option) => option.value === selectedThresholdValue) ?? null;
  const selectedBandOption = percentileAvailability.find((option) => option.band === selectedBand) ?? null;
  const selectedClaimIsFeasible = claimMode === "percentile"
    ? Boolean(selectedBandOption?.achievable)
    : Boolean(selectedThresholdOption?.achievable);
  const selectedClaimReason = claimMode === "percentile"
    ? selectedBandOption?.reason ?? ""
    : selectedThresholdOption?.reason ?? "";

  const categoryAvailability = useMemo(() => {
    const counts = new Map<string, number>();
    for (const record of claimedRecords) {
      const key = record.category.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    return categories.map((category) => ({
      category,
      count: counts.get(category.toLowerCase()) ?? 0,
    }));
  }, [categories, claimedRecords]);

  const selectedCategoryAvailability = useMemo(
    () => categoryAvailability.find((entry) => entry.category === selectedCategory) ?? null,
    [categoryAvailability, selectedCategory],
  );

  const windowAvailability = useMemo(() => WINDOW_OPTIONS.map((option) => {
    const preview = buildSnapshot(claimedRecords, {
      category: selectedCategory || categories[0] || "macro",
      subjectId: walletAddress,
      windowDays: option,
    });

    return {
      option,
      count: preview.records.length,
    };
  }), [claimedRecords, categories, selectedCategory, walletAddress]);

  const currentWindowAvailability = useMemo(
    () => windowAvailability.find((entry) => entry.option === windowDays) ?? null,
    [windowAvailability, windowDays],
  );

  const generationBlocker = useMemo(() => {
    if (!walletAddress) {
      return "Connect your wallet first.";
    }
    if (claimedRecords.length === 0) {
      return "No claim-backed records are available yet.";
    }
    if (!selectedCategoryAvailability || selectedCategoryAvailability.count === 0) {
      return "This category has no witness-backed claims yet.";
    }
    if (!currentWindowAvailability || currentWindowAvailability.count === 0) {
      return "This window would generate an empty snapshot, so the credential would fail.";
    }
    if (!selectedClaimIsFeasible) {
      return selectedClaimReason || "This claim type is not achievable from the current snapshot.";
    }
    return "";
  }, [claimedRecords.length, currentWindowAvailability, selectedCategoryAvailability, selectedClaimIsFeasible, selectedClaimReason, walletAddress]);

  const exportText = plainTextExport(credential);
  const totalSteps = 3;
  const canMoveForward = step === 1
    ? categoryAvailability.some((entry) => entry.count > 0)
    : step === 2
      ? Boolean(selectedCategory) && Boolean(selectedCategoryAvailability?.count) && selectedClaimIsFeasible
      : !generationBlocker;
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
                        {categoryAvailability.length === 0 ? (
                          <div className="flex items-center gap-2 rounded-full border border-white/8 bg-black/20 px-4 py-2 text-sm text-white/45">
                            <span>No eligible categories yet</span>
                            <HelpTip text="We only allow categories from settled positions you have already claimed. Open positions are not eligible for a public cred." />
                          </div>
                        ) : categoryAvailability.map(({ category, count }) => {
                          const disabled = count === 0;
                          const reason = disabled
                            ? "No witness-backed claims are available for this category yet."
                            : undefined;
                          return (
                            <button
                              key={category}
                              type="button"
                              onClick={() => setSelectedCategory(category)}
                              disabled={disabled}
                              title={reason}
                              className={`rounded-full border px-3 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                selectedCategory === category
                                  ? "border-white/20 bg-white text-black"
                                  : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                              }`}
                            >
                              {category}
                              <span className="ml-2 text-[9px] font-semibold tracking-[0.12em] text-white/35">
                                {count > 0 ? count : "locked"}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {selectedCategoryAvailability && selectedCategoryAvailability.count === 0 ? (
                        <p className="mt-3 text-xs leading-relaxed text-amber-300/70">
                          This category has no claim-backed witness data, so it stays disabled until a real attested claim exists.
                        </p>
                      ) : null}
                    </div>

                    <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Window</p>
                      <div className="mt-4 grid grid-cols-3 gap-2">
                        {windowAvailability.map(({ option, count }) => {
                          const disabled = count === 0;
                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => setWindowDays(option)}
                              disabled={disabled}
                              title={disabled ? "No claims fall inside this window for the selected category." : undefined}
                              className={`rounded-2xl border px-3 py-3 text-sm font-black transition disabled:cursor-not-allowed disabled:opacity-40 ${
                                windowDays === option
                                  ? "border-white/20 bg-white text-black"
                                  : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                              }`}
                            >
                              {option}d
                            </button>
                          );
                        })}
                      </div>
                      {currentWindowAvailability && currentWindowAvailability.count === 0 ? (
                        <p className="mt-3 text-xs leading-relaxed text-amber-300/70">
                          This window would produce an empty credential snapshot, so it is disabled.
                        </p>
                      ) : null}
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
                          disabled={selectedCategoryAvailability?.count === 0}
                          title={selectedCategoryAvailability?.count === 0 ? "Add a claim-backed record to this category before using percentile creds." : undefined}
                          className={`rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                            claimMode === "percentile" ? "bg-white text-black" : "text-white/55 hover:text-white"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          Percentile
                        </button>
                        <button
                          type="button"
                          onClick={() => setClaimMode("threshold")}
                          disabled={selectedCategoryAvailability?.count === 0}
                          title={selectedCategoryAvailability?.count === 0 ? "Add a claim-backed record to this category before using threshold creds." : undefined}
                          className={`rounded-full px-4 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                            claimMode === "threshold" ? "bg-white text-black" : "text-white/55 hover:text-white"
                          } disabled:cursor-not-allowed disabled:opacity-40`}
                        >
                          Threshold
                        </button>
                      </div>
                      {selectedCategoryAvailability?.count === 0 ? (
                        <p className="mt-3 text-xs leading-relaxed text-amber-300/70">
                          Claim style controls stay locked until the selected category has at least one attested claim with a local witness.
                        </p>
                      ) : null}
                    </div>

                    {claimMode === "percentile" ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Band</p>
                        <div className="mt-4 grid grid-cols-3 gap-2">
                          {percentileAvailability.map(({ band, achievable, reason }) => (
                            <button
                              key={band}
                              type="button"
                              onClick={() => setSelectedBand(band)}
                              disabled={!achievable}
                              title={!achievable ? reason : undefined}
                              className={`rounded-2xl border px-3 py-3 text-sm font-black transition ${
                                selectedBand === band
                                  ? "border-white/20 bg-white text-black"
                                  : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                              } disabled:cursor-not-allowed disabled:opacity-40`}
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
                            {Object.keys(THRESHOLD_PRESETS).map((metric) => {
                              const metricKey = metric as keyof typeof THRESHOLD_PRESETS;
                              const options = thresholdAvailability[metricKey];
                              const metricEnabled = options.some((option) => option.achievable);
                              const disabledReason = metricEnabled ? undefined : `No ${metric} threshold is achievable from the current snapshot.`;
                              return (
                                <button
                                  key={metric}
                                  type="button"
                                  onClick={() => setSelectedThresholdMetric(metricKey)}
                                  disabled={!metricEnabled}
                                  title={disabledReason}
                                  className={`rounded-full border px-3 py-2 text-[11px] font-black uppercase tracking-[0.18em] transition ${
                                    selectedThresholdMetric === metric
                                      ? "border-white/20 bg-white text-black"
                                      : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                                  } disabled:cursor-not-allowed disabled:opacity-40`}
                                >
                                  {metric}
                                </button>
                              );
                            })}
                          </div>
                        </div>

                        <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5">
                          <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Threshold</p>
                          <div className="mt-4 grid gap-2 sm:grid-cols-2">
                            {selectedThresholdOptions.map((option) => (
                              <button
                                key={`${selectedThresholdMetric}-${option.value.toString()}`}
                                type="button"
                                onClick={() => setSelectedThresholdValue(option.value)}
                                disabled={!option.achievable}
                                title={!option.achievable ? option.reason : undefined}
                                className={`rounded-2xl border px-4 py-3 text-left transition ${
                                  selectedThresholdValue === option.value
                                    ? "border-white/20 bg-white text-black"
                                    : "border-white/8 bg-black/20 text-white/55 hover:text-white"
                                } disabled:cursor-not-allowed disabled:opacity-40`}
                              >
                                <p className="text-sm font-black">{option.label}</p>
                                <p className="mt-1 text-xs text-white/45">{humanizeThreshold(selectedThresholdMetric, option.value)}</p>
                              </button>
                            ))}
                          </div>
                          {selectedClaimReason ? (
                            <p className="mt-3 text-xs leading-relaxed text-amber-300/70">
                              {selectedClaimReason}
                            </p>
                          ) : null}
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
                      <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-white/70">
                        This credential currently scores only attested claim-backed records. Resolved losing commitments without claim attestation do not count yet, so ROI and win-rate style creds can read stronger than full market history.
                      </div>
                      {generationBlocker ? (
                        <div className="mt-4 rounded-2xl border border-amber-400/20 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-white/70">
                          {generationBlocker}
                        </div>
                      ) : null}
                    </div>

                    {status ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5 text-sm leading-relaxed text-white/60">
                        {status}
                      </div>
                    ) : null}

                    {credential ? (
                      <div className="rounded-[28px] border border-white/8 bg-white/[0.03] p-5 sm:p-6">
                        <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:justify-between">
                          <div className="flex items-start gap-4">
                            <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-[22px] bg-gradient-to-br from-violet-500 via-fuchsia-500 to-indigo-500 text-2xl font-black text-white shadow-[0_14px_30px_rgba(126,34,206,0.35)]">
                              {credential.claim.claimType === "percentile"
                                ? "%"
                                : credential.claim.metric === "winRate"
                                  ? "W"
                                  : credential.claim.metric === "roi"
                                    ? "R"
                                    : credential.claim.metric === "profit"
                                      ? "$"
                                      : credential.claim.metric === "participation"
                                        ? "P"
                                        : "E"}
                            </div>
                            <div className="min-w-0">
                              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Generated credential</p>
                              <h3 className="mt-2 text-2xl font-black tracking-tight text-white sm:text-3xl">
                                {reputationStatementLabel(credential.claim)}
                              </h3>
                              <p className="mt-3 max-w-2xl text-sm leading-relaxed text-white/55">
                                Proof-backed reputation statement for {credential.publicClaim.category} over a {credentialWindowLabel(credential.publicClaim.windowDays)}.
                              </p>
                              <p className="mt-3 text-xs leading-relaxed text-white/40">
                                Created {formatCredentialCreatedAt(credential.publicClaim.createdAt)} · Snapshot size {credentialSnapshotSizeLabel(credential.publicClaim.snapshotRecordCount)}
                              </p>
                              <div className="mt-4 flex flex-wrap gap-2">
                                <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
                                  {credential.publicClaim.category}
                                </span>
                                <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
                                  {credentialWindowLabel(credential.publicClaim.windowDays)}
                                </span>
                                <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
                                  {credentialSnapshotSizeLabel(credential.publicClaim.snapshotRecordCount)}
                                </span>
                                <span className="inline-flex items-center rounded-full border border-white/10 bg-black/20 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white/70">
                                  {credential.publicClaim.attestorKeyId.slice(0, 8)}...
                                </span>
                              </div>
                            </div>
                          </div>
                          <div className={`inline-flex items-center gap-2 self-start rounded-full border px-3 py-1.5 ${credential.proofValid && credential.snapshotVerified ? "border-white/10 bg-white/[0.05]" : "border-white/10 bg-black/20"}`}>
                            <ShieldCheck className={`h-4 w-4 ${credential.proofValid && credential.snapshotVerified ? "text-white/75" : "text-white/55"}`} />
                            <span className={`text-[10px] font-black uppercase tracking-[0.18em] ${credential.proofValid && credential.snapshotVerified ? "text-white/80" : "text-white/55"}`}>
                              {credential.proofValid && credential.snapshotVerified ? "Verified" : "Pending"}
                            </span>
                          </div>
                        </div>

                        <div className="mt-6 grid gap-3 md:grid-cols-3">
                          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Subject</p>
                            <p className="mt-3 font-mono text-xs text-white/80 break-all">{compactField(credential.publicClaim.subjectId)}</p>
                          </div>
                          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Snapshot root</p>
                            <p className="mt-3 font-mono text-xs text-white/80 break-all">{compactField(credential.publicClaim.snapshotRoot)}</p>
                          </div>
                          <div className="rounded-2xl border border-white/6 bg-black/20 p-4">
                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Proof hash</p>
                            <p className="mt-3 font-mono text-xs text-white/80 break-all">{compactField(credential.proofHex)}</p>
                          </div>
                        </div>

                        <div className="mt-4 flex flex-wrap gap-2">
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

                        <details className="group mt-5 rounded-[24px] border border-white/8 bg-black/20 px-4 py-4">
                          <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                            <div>
                              <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/28">Advanced</p>
                              <p className="mt-2 text-sm text-white/52">Commitment, attestor, and proof envelope details.</p>
                            </div>
                            <ChevronDown className="h-4 w-4 shrink-0 text-white/45 transition group-open:rotate-180 group-open:text-white/75" />
                          </summary>

                          <div className="mt-4 grid gap-3 lg:grid-cols-2">
                            <div className="rounded-2xl border border-white/6 bg-[#09090b] p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Attestor key</p>
                              <p className="mt-3 font-mono text-xs text-white/80 break-all">{compactField(credential.publicClaim.attestorKeyId)}</p>
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-[#09090b] p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Window</p>
                              <p className="mt-3 text-sm text-white/80">{credentialWindowLabel(credential.publicClaim.windowDays)}</p>
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-[#09090b] p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Public inputs</p>
                              <p className="mt-3 font-mono text-xs leading-relaxed text-white/75 break-words">{credential.publicInputsHex.join(" · ")}</p>
                            </div>
                            <div className="rounded-2xl border border-white/6 bg-[#09090b] p-4">
                              <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Claim JSON</p>
                              <pre className="mt-3 max-h-48 overflow-auto font-mono text-[11px] leading-relaxed text-white/75 whitespace-pre-wrap break-words">
                                {JSON.stringify(credential.claim, null, 2)}
                              </pre>
                            </div>
                          </div>
                        </details>
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
                    setIsGenerateStarting(true);
                    void onGenerate();
                  }}
                  disabled={busy || isGenerateStarting || !canMoveForward}
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white/90 disabled:opacity-60"
                >
                  {busy || isGenerateStarting ? <Loader2 className="h-4 w-4 animate-spin" /> : step < 3 ? null : <Sparkles className="h-4 w-4" />}
                  {step < 3 ? "Next" : busy || isGenerateStarting ? "Generating..." : "Create credential"}
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
  const [attestedRecords, setAttestedRecords] = useState<AttestedReputationRecord[]>([]);
  const [privateWitnesses, setPrivateWitnesses] = useState<PrivateReputationWitness[]>([]);
  const [achievements, setAchievements] = useState<AchievementCard[]>([]);
  const [profileName, setProfileName] = useState("Public trader");
  const [profileBio, setProfileBio] = useState("No public market bio yet. Start participating to build a visible reputation trail.");
  const [profileAvatar, setProfileAvatar] = useState<string | null>(DEFAULT_PROFILE_AVATAR);
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
  const [retryingCommitment, setRetryingCommitment] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [credential, setCredential] = useState<AchievementCard | null>(null);
  const [sharingReputation, setSharingReputation] = useState(false);
  const [showLocalShareWarning, setShowLocalShareWarning] = useState(false);
  const [selectedCard, setSelectedCard] = useState<ShowcaseCredentialCard | null>(null);
  const [selectedCardTab, setSelectedCardTab] = useState<"active" | "archive">("active");
  const [openCardMenuId, setOpenCardMenuId] = useState<string | null>(null);
  const [cardPendingRemoval, setCardPendingRemoval] = useState<AchievementCard | null>(null);
  const [removingCardId, setRemovingCardId] = useState<string | null>(null);
  const [verifyingCardId, setVerifyingCardId] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<{ cardId: string; message: string } | null>(null);
  const [shareModalState, setShareModalState] = useState<{ url: string; version: number } | null>(null);
  const verificationNoticeTimer = useRef<number | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, {
    activationConstraint: { distance: 8 },
  }));

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
      setProfileAvatar(googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR);
      setSavedPositions([]);
      setAttestedRecords([]);
      setPrivateWitnesses([]);
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
          avatarDataUrl: googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR,
        });

        if (!mounted) {
          return;
        }

        setSavedPositions(snapshot.positions);
        setAttestedRecords(snapshot.attestedRecords);
        setPrivateWitnesses(snapshot.privateReputationWitnesses);
        setAchievements(normalizeAchievementDisplayOrder(snapshot.achievements as AchievementCard[]));
        setProfileName(snapshot.profile.displayName || "Public trader");
        setProfileBio(snapshot.profile.bio || "No public market bio yet. Start participating to build a visible reputation trail.");
        setProfileAvatar(snapshot.profile.avatarDataUrl || DEFAULT_PROFILE_AVATAR);
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

  const validAttestedRecords = useMemo(
    () => attestedRecords.filter((record) => verifyAttestedRecordSignature(record) && record.walletAddress.toLowerCase() === walletAddress.toLowerCase()),
    [attestedRecords, walletAddress],
  );
  const witnessByRecordCommitment = useMemo(
    () => new Map(privateWitnesses.map((witness) => [witness.recordCommitment.toLowerCase(), witness])),
    [privateWitnesses],
  );
  const attestedClaimTxHashes = useMemo(
    () => new Set(validAttestedRecords.map((record) => normalizeHexish(record.claimTxHash)).filter(Boolean)),
    [validAttestedRecords],
  );
  const attestedRecordCommitments = useMemo(
    () => new Set(validAttestedRecords.map((record) => normalizeHexish(record.recordCommitment)).filter(Boolean)),
    [validAttestedRecords],
  );
  const claimedRecords = useMemo(() => (
    validAttestedRecords.flatMap((record) => {
      const witness = witnessByRecordCommitment.get(record.recordCommitment.toLowerCase());
      if (!witness) {
        return [];
      }
      const position = walletPositions.find((entry) => entry.commitment === witness.commitment);
      return [{
        marketId: record.marketId,
        subjectId: record.walletAddress,
        category: record.category,
        resolvedAt: record.resolvedAt,
        claimedAt: record.claimedAt,
        amountInStroops: BigInt(witness.amountInStroops),
        payoutInStroops: BigInt(witness.payoutInStroops),
        won: witness.won,
        side: witness.side,
        marketQuestion: position?.marketQuestion ?? marketMap.get(record.marketId)?.question ?? "Attested market",
        commitment: witness.commitment,
        nullifier: witness.nullifier,
        claimTxHash: record.claimTxHash,
        witnessSalt: witness.witnessSalt,
        recordCommitment: record.recordCommitment,
      } satisfies ClaimedReputationRecord];
    })
  ), [marketMap, validAttestedRecords, walletPositions, witnessByRecordCommitment]);

  const unavailableAttestedRecords = useMemo(
    () => validAttestedRecords.filter((record) => !witnessByRecordCommitment.has(record.recordCommitment.toLowerCase())),
    [validAttestedRecords, witnessByRecordCommitment],
  );
  const pendingAttestationPositions = useMemo(
    () => walletPositions.filter((position) => {
      if (!position.claimedAt) {
        return false;
      }

      if (position.reputationAttestationStatus === "attested") {
        return false;
      }

      if (position.claimTxHash && attestedClaimTxHashes.has(normalizeHexish(position.claimTxHash))) {
        return false;
      }

      const witness = privateWitnesses.find((entry) => entry.commitment === position.commitment);
      if (witness && attestedRecordCommitments.has(normalizeHexish(witness.recordCommitment))) {
        return false;
      }

      return true;
    }),
    [attestedClaimTxHashes, attestedRecordCommitments, privateWitnesses, walletPositions],
  );
  const categories = useMemo(
    () => [...new Set(validAttestedRecords.map((record) => record.category.toLowerCase()))].sort(),
    [validAttestedRecords],
  );

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
      attestedRecords: validAttestedRecords,
    });
  }, [claimedRecords, selectedCategory, validAttestedRecords, walletAddress, windowDays]);

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
  const activeShowcaseCards = useMemo(
    () => showcaseCards.filter((card) => !card.archivedAt),
    [showcaseCards],
  );
  const archivedShowcaseCards = useMemo(
    () => showcaseCards.filter((card) => Boolean(card.archivedAt)),
    [showcaseCards],
  );
  const visibleShowcaseCards = selectedCardTab === "archive" ? archivedShowcaseCards : activeShowcaseCards;
  const backgroundJobMessage = busy
    ? status || "Generating reputation credential in the background..."
    : status;
  const generationPhases: string[] = [
    "Checking witness data",
    "Building snapshot",
    "Preparing inclusion proofs",
    "Preparing prover",
    "Computing private witness",
    "Generating proof",
    "Packaging credential",
  ];
  const generationStepIndex = (() => {
    const message = backgroundJobMessage.toLowerCase();
    if (!busy) return -1;
    if (message.includes("checking local witness")) return 0;
    if (message.includes("building attested snapshot")) return 1;
    if (message.includes("preparing merkle")) return 2;
    if (message.includes("preparing prover")) return 3;
    if (message.includes("computing private witness")) return 4;
    if (message.includes("generating zero-knowledge proof") || message.includes("generating proof")) return 5;
    if (message.includes("packaging portable credential") || message.includes("packaging credential")) return 6;
    return 0;
  })();
  const generationStep = generationStepIndex >= 0
    ? (generationPhases[generationStepIndex] ?? "Generating credential")
    : "Generating credential";
  const generationProgress = generationStepIndex >= 0 ? Math.max(8, ((generationStepIndex + 1) / generationPhases.length) * 100) : 0;

  function resetCredentialComposerState() {
    setClaimMode("percentile");
    setWindowDays(90);
    setSelectedCategory("macro");
    setSelectedBand(25);
    setSelectedThresholdMetric("roi");
    setSelectedThresholdValue(THRESHOLD_PRESETS.roi[0].value);
    setCredential(null);
    setStatus("");
    setIsVerifying(false);
  }

  function closeCredentialModal() {
    setIsCredModalOpen(false);
    resetCredentialComposerState();
  }

  function openCredentialModal() {
    resetCredentialComposerState();
    setIsCredModalOpen(true);
  }

  async function handleReorderShowcaseCards(nextCards: ShowcaseCredentialCard[]) {
    if (!walletAddress) {
      return;
    }

    const nextSerializedOrder = nextCards.map((card) => card.serialized);
    const reorderedVisible = nextSerializedOrder
      .map((serialized) => achievements.find((achievement) => achievement.serialized === serialized))
      .filter((achievement): achievement is AchievementCard => Boolean(achievement));

    const nextAchievements = normalizeAchievementDisplayOrder(
      achievements.reduce<AchievementCard[]>((result, achievement) => {
        const shouldReplaceFromVisibleTab = selectedCardTab === "archive"
          ? Boolean(achievement.archivedAt)
          : !achievement.archivedAt;

        if (!shouldReplaceFromVisibleTab) {
          result.push(achievement);
          return result;
        }

        const nextVisibleAchievement = reorderedVisible.shift();
        if (nextVisibleAchievement) {
          result.push(nextVisibleAchievement);
        }
        return result;
      }, []),
    );

    setAchievements(nextAchievements);

    try {
      await replaceAchievements(walletAddress, nextAchievements as StoredReputationCredential[]);
    } catch (error) {
      console.error("Failed to save reputation card order:", error);
      setStatus(error instanceof Error ? error.message : "Failed to save card order.");
    }
  }

  async function handleDropReorderCard(cardId: string, targetCardId: string) {
    const currentVisibleCards = selectedCardTab === "archive" ? archivedShowcaseCards : activeShowcaseCards;
    if (currentVisibleCards.length < 2) {
      return;
    }

    if (cardId === targetCardId) {
      return;
    }

    const fromIndex = currentVisibleCards.findIndex((entry) => entry.id === cardId);
    const toIndex = currentVisibleCards.findIndex((entry) => entry.id === targetCardId);

    if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
      return;
    }

    const reorderedVisibleCards = arrayMove(currentVisibleCards, fromIndex, toIndex);
    await handleReorderShowcaseCards(reorderedVisibleCards);
  }

  function handleCardDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    void handleDropReorderCard(String(active.id), String(over.id));
  }

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
    setStatus("Checking local witness data...");
    try {
      for (const record of claimedRecords) {
        const expectedCommitment = await computeRecordCommitment({
          walletAddress,
          marketId: record.marketId,
          category: record.category,
          amountInStroops: BigInt(record.amountInStroops),
          payoutInStroops: BigInt(record.payoutInStroops),
          won: Boolean(record.won),
          claimedAt: record.claimedAt,
          witnessSalt: record.witnessSalt,
        });

        if (expectedCommitment.toLowerCase() !== record.recordCommitment.toLowerCase()) {
          throw new Error(
            `Local witness data does not match the stored commitment for market ${record.marketId}. This usually means the claim snapshot is stale or was created with different claim fields.`,
          );
        }
      }

      const descriptor = claimMode === "percentile"
        ? createClaimDescriptor({ claimType: "percentile", band: selectedBand })
        : createClaimDescriptor({ claimType: "threshold", metric: selectedThresholdMetric, threshold: selectedThresholdValue });
      const scopedAttestedRecords = validAttestedRecords.filter((record) => record.category.toLowerCase() === selectedCategory.toLowerCase());
      const attestorKeyId = scopedAttestedRecords[0]?.attestorKeyId;
      if (!attestorKeyId) {
        throw new Error("No attested records are available for that category yet.");
      }
      const reputationRecords = claimedRecords.map(({ marketId, subjectId, category, resolvedAt, claimedAt, amountInStroops, payoutInStroops, won, recordCommitment, witnessSalt }) => ({
        marketId,
        subjectId,
        category,
        resolvedAt,
        claimedAt,
        amountInStroops,
        payoutInStroops,
        won,
        recordCommitment,
        witnessSalt,
      }));

      const serialized = await generateReputationProof({
        subjectId: walletAddress,
        category: selectedCategory,
        windowDays,
        attestedRecords: scopedAttestedRecords,
        attestorKeyId,
        onProgress: (message) => setStatus(message),
        descriptor: claimMode === "percentile"
          ? { claimType: "percentile", band: selectedBand }
          : { claimType: "threshold", metric: selectedThresholdMetric, threshold: selectedThresholdValue },
        records: reputationRecords,
      });
      setStatus("Verifying generated credential...");
      const verified = await verifyReputationProof(serialized, scopedAttestedRecords);
      const parsed = JSON.parse(serialized) as {
        claim: SerializedReputationClaimDescriptor;
        publicClaim: GeneratedCredential["publicClaim"];
        envelope: { proofHex: string; publicInputsHex: string[] };
      };

      const nextCredential = {
        serialized,
        proofHex: parsed.envelope.proofHex,
        publicInputsHex: parsed.envelope.publicInputsHex,
        snapshotRoot: verified.portableClaim.publicClaim.snapshotRoot,
        attestorKeyId: verified.portableClaim.publicClaim.attestorKeyId,
        proofValid: verified.proofValid,
        snapshotVerified: verified.snapshotVerified,
        displayOrder: 0,
        publicClaim: verified.portableClaim.publicClaim,
      };

      const nextEntry: AchievementCard = {
        ...nextCredential,
        id: `${nextCredential.proofHex}-${verified.portableClaim.publicClaim.createdAt}`,
        createdAt: verified.portableClaim.publicClaim.createdAt,
        claim: parsed.claim,
      };
      const nextAchievements = normalizeAchievementDisplayOrder([nextEntry, ...achievements.filter((entry) => entry.serialized !== nextEntry.serialized)]);
      setCredential(nextEntry);
      setAchievements(nextAchievements);
      if (walletAddress) {
        setStatus("Saving credential to your local profile...");
        await replaceAchievements(walletAddress, nextAchievements as StoredReputationCredential[]);
      }
      setStatus(verified.isValid
        ? `${reputationStatementLabel(descriptor)} ready to share.`
        : "Credential generated, but attested snapshot verification did not pass.");
    } catch (error) {
      console.error("Failed to generate reputation credential:", error);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleGenerateCredentialFromModal() {
    closeCredentialModal();
    await handleGenerateCredential();
  }

  async function publishReputationShare() {
    if (!walletAddress) {
      setStatus("Connect your wallet first so the share can be tied to your profile.");
      return;
    }

    if (walletPositions.length === 0 && achievements.length === 0) {
      setStatus("Add a position or reputation card before creating a public share.");
      return;
    }

    setSharingReputation(true);
    setStatus("Publishing public reputation share...");
    try {
      const share = await createReputationShare({
        walletAddress,
        snapshot: {
          profile: {
            displayName: profileName,
            bio: profileBio,
            avatarDataUrl: profileAvatar,
          },
          summary: {
            totalMarkets,
            totalCollateralInStroops: totalCommitted.toString(),
            totalCategories,
            categories: categoryTags,
          },
          attestedRecords: validAttestedRecords,
          achievements: achievements.filter((achievement) => !achievement.archivedAt),
        },
      });
      const shareUrl = `${window.location.origin}${reputationSharePath(share.slug)}`;
      setShareModalState({ url: shareUrl, version: share.version });
      setStatus(`Public share v${share.version} is ready.`);
      setShowLocalShareWarning(false);
    } catch (error) {
      console.error("Failed to publish reputation share:", error);
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setSharingReputation(false);
    }
  }

  async function handleShareReputation() {
    if (syncMode === "local") {
      setShowLocalShareWarning(true);
      return;
    }

    await publishReputationShare();
  }

  async function handleVerifyCredential() {
    if (!credential) {
      return;
    }

    setIsVerifying(true);
    setStatus("");
    try {
      const scopedAttestedRecords = validAttestedRecords.filter((record) => record.category.toLowerCase() === credential.publicClaim.category.toLowerCase());
      const verified = await verifyReputationProof(credential.serialized, scopedAttestedRecords);
      setCredential((current) => current ? {
        ...current,
        proofValid: verified.proofValid,
        snapshotVerified: verified.snapshotVerified,
        publicClaim: verified.portableClaim.publicClaim,
      } : current);
      if (walletAddress && credential) {
        await upsertAchievement(walletAddress, {
          ...credential,
          proofValid: verified.proofValid,
          snapshotVerified: verified.snapshotVerified,
          publicClaim: verified.portableClaim.publicClaim,
          createdAt: verified.portableClaim.publicClaim.createdAt,
          displayOrder: credential.displayOrder,
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

  async function handleVerifyShowcaseCard(card: ShowcaseCredentialCard) {
    if (verifyingCardId) {
      return;
    }

    if (verificationNoticeTimer.current) {
      window.clearTimeout(verificationNoticeTimer.current);
      verificationNoticeTimer.current = null;
    }

    setVerifyingCardId(card.id);
    try {
      const scopedAttestedRecords = validAttestedRecords.filter((record) => record.category.toLowerCase() === card.category.toLowerCase());
      if (scopedAttestedRecords.length === 0) {
        throw new Error(`No attested records are available for ${card.category} yet.`);
      }

      await verifyReputationProof(card.serialized, scopedAttestedRecords);
      setVerificationNotice({ cardId: card.id, message: "Verified successfully" });
      verificationNoticeTimer.current = window.setTimeout(() => {
        setVerificationNotice((current) => (current?.cardId === card.id ? null : current));
        verificationNoticeTimer.current = null;
      }, 3000);
    } catch (error) {
      console.error("Failed to verify reputation credential:", error);
      setVerificationNotice({ cardId: card.id, message: error instanceof Error ? error.message : String(error) });
      verificationNoticeTimer.current = window.setTimeout(() => {
        setVerificationNotice((current) => (current?.cardId === card.id ? null : current));
        verificationNoticeTimer.current = null;
      }, 4000);
    } finally {
      setVerifyingCardId(null);
    }
  }

  function findAchievementBySerialized(serialized: string) {
    return achievements.find((entry) => entry.serialized === serialized) ?? null;
  }

  async function handleRemoveAchievement(card: AchievementCard | ShowcaseCredentialCard) {
    if (!walletAddress) {
      setStatus("Connect your wallet first.");
      return;
    }

    const target = "publicClaim" in card ? card : findAchievementBySerialized(card.serialized);
    if (!target) {
      setStatus("Could not find that reputation card anymore.");
      return;
    }

    setRemovingCardId(target.id);
    setOpenCardMenuId(null);
    setCardPendingRemoval(null);

    try {
      await removeAchievement(walletAddress, target.serialized);
      setAchievements((current) => current.filter((entry) => entry.serialized !== target.serialized));
      setCredential((current) => (current?.serialized === target.serialized ? null : current));
      setSelectedCard((current) => (current?.id === target.id ? null : current));
      setStatus("Reputation card removed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to remove reputation card.");
    } finally {
      setRemovingCardId(null);
    }
  }

  async function handleArchiveAchievement(card: AchievementCard | ShowcaseCredentialCard) {
    if (!walletAddress) {
      setStatus("Connect your wallet first.");
      return;
    }

    const target = "publicClaim" in card ? card : findAchievementBySerialized(card.serialized);
    if (!target) {
      setStatus("Could not find that reputation card anymore.");
      return;
    }

    setOpenCardMenuId(null);

    try {
      const shouldArchive = selectedCardTab !== "archive";
      const archivedAt = shouldArchive ? Date.now() : null;
      await archiveAchievement(walletAddress, target.serialized, shouldArchive);
      setAchievements((current) => current.map((entry) => (
        entry.serialized === target.serialized ? { ...entry, archivedAt } : entry
      )));
      setStatus(shouldArchive ? "Reputation card archived." : "Removed from archive.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to update archived state.");
    }
  }

  async function handleRetryAttestation(position: BlindPositionRecord) {
    if (!walletAddress) {
      setStatus("Connect your wallet first so the retry can be bound to the right account.");
      return;
    }
    if (!position.claimTxHash || !position.claimedAt) {
      setStatus("This claim is missing its transaction hash locally, so the backend cannot re-attest it from here.");
      return;
    }

    const witness = privateWitnesses.find((entry) => entry.commitment === position.commitment);
    if (!witness) {
      setStatus("Missing local witness data for that claim, so attestation cannot be retried from this browser.");
      return;
    }

    setRetryingCommitment(position.commitment);
    setStatus("Retrying attestation...");
    try {
      const attestedRecord = await attestClaimRecord({
        walletAddress,
        marketId: position.marketId,
        commitment: position.commitment,
        nullifier: position.nullifier,
        claimTxHash: position.claimTxHash,
        category: position.category,
        recordCommitment: witness.recordCommitment,
        witnessSalt: witness.witnessSalt,
        claimedAt: position.claimedAt,
      });
      setAttestedRecords((current) => [attestedRecord, ...current.filter((entry) => entry.recordCommitment !== attestedRecord.recordCommitment)]);
      await upsertAttestedRecord(walletAddress, attestedRecord);
      await markClaimedPosition(walletAddress, position.commitment, { reputationAttestationStatus: "attested" });
      setSavedPositions((current) => current.map((entry) => (
        entry.commitment === position.commitment ? { ...entry, reputationAttestationStatus: "attested" } : entry
      )));
      setStatus("Claim attestation completed.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRetryingCommitment(null);
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
            </header>

            <section className="grid gap-10 lg:grid-cols-[400px_minmax(0,1fr)]">
              <aside className="px-2 pt-2">
                <div className="flex items-start gap-6">
                  <div className="flex h-24 w-24 shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full border border-white/5 bg-[#121214] text-2xl font-black uppercase text-white">
                    <img src={profileAvatar || DEFAULT_PROFILE_AVATAR} alt={profileName} className="block h-full w-full min-h-full min-w-full rounded-full object-cover" />
                  </div>
                  <div className="pt-1">
                    <h1 className="text-xl sm:text-2xl font-black tracking-tight text-white leading-none">{profileName}</h1>
                    <p className="mt-2 text-sm sm:text-base leading-none text-white">{profileHandle}</p>
                  </div>
                </div>

                <div className="mt-7">
                  <div className="flex items-end justify-between gap-3">
                    <div>
                      <p className="text-[9px] font-black uppercase tracking-[0.26em] text-white/35">Reputation score</p>
                      <p className="mt-2 text-3xl font-black tracking-tight text-white">{reputationScore}</p>
                    </div>
                  </div>

                  <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/8">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${reputationScore}%` }}
                      transition={{ duration: 0.7, ease: "easeOut" }}
                      className="h-full rounded-full bg-violet-400"
                    />
                  </div>

                  <div className="mt-5 flex flex-wrap gap-4 text-xs text-white/48">
                    <p><span className="mr-2 font-black text-violet-300">{totalMarkets}</span>Markets</p>
                    <p><span className="mr-2 font-black text-violet-300">{formatUsdc(totalCommitted)}</span>Collateral</p>
                    <p><span className="mr-2 font-black text-violet-300">{activeShowcaseCards.length}</span>Creds</p>
                  </div>
                </div>

                <div className="mt-8 border-t border-white/8 pt-8">
                  <div className="space-y-3 text-[14px] text-white/78">
                    <div className="flex items-center gap-3 text-white/55">
                      <span className="text-sm">□</span>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{walletAddress ? shortHash(walletAddress, 10, 8) : "Wallet not connected"}</span>
                        {walletAddress ? (
                          <button
                            type="button"
                            onClick={() => void navigator.clipboard.writeText(walletAddress)}
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/55 transition hover:border-white/20 hover:bg-white/[0.08] hover:text-white"
                            aria-label="Copy wallet address"
                            title="Copy wallet address"
                          >
                            <Copy className="h-3 w-3" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-white/55">
                      <span className="text-sm">▦</span>
                      <span>{totalCategories > 0 ? `${totalCategories} active categor${totalCategories === 1 ? "y" : "ies"}` : "No active categories yet"}</span>
                    </div>
                    <p className="pt-1 text-sm leading-relaxed text-white">{profileBio}</p>
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
                      onClick={() => setSelectedCardTab("active")}
                      className={`border-b-2 pb-3 text-base sm:text-lg font-semibold transition ${selectedCardTab === "active" ? "border-violet-400 text-violet-300" : "border-transparent text-white/40 hover:text-white/65"}`}
                    >
                      Reputation
                    </button>
                    <button
                      type="button"
                      onClick={() => setSelectedCardTab("archive")}
                      className={`border-b-2 pb-3 text-base sm:text-lg font-semibold transition ${selectedCardTab === "archive" ? "border-violet-400 text-violet-300" : "border-transparent text-white/40 hover:text-white/65"}`}
                    >
                      Archive
                    </button>
                  </div>
                </div>

                <div className="mt-10">
                  {pendingAttestationPositions.length > 0 ? (
                    <div className="mb-6 rounded-[22px] border border-amber-400/20 bg-amber-500/10 p-5">
                      <p className="text-sm font-black tracking-tight text-white">Pending attestation</p>
                      <p className="mt-2 text-xs leading-relaxed text-white/60">
                        Your claims were successful, but {pendingAttestationPositions.length} reputation record{pendingAttestationPositions.length === 1 ? "" : "s"} still need backend attestation before they can power a private credential.
                      </p>
                      <div className="mt-4 flex flex-wrap gap-2">
                        {pendingAttestationPositions.map((position) => (
                          <button
                            key={position.commitment}
                            type="button"
                            onClick={() => void handleRetryAttestation(position)}
                            disabled={retryingCommitment === position.commitment}
                            title={
                              !position.claimTxHash
                                ? "Missing claim transaction hash"
                                : !position.claimedAt
                                  ? "Missing claim timestamp"
                                  : !privateWitnesses.some((entry) => entry.commitment === position.commitment)
                                    ? "Missing local witness data"
                                    : undefined
                            }
                            className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-[11px] font-black uppercase tracking-[0.16em] text-white transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {retryingCommitment === position.commitment ? "Retrying..." : `Retry ${position.category}`}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {unavailableAttestedRecords.length > 0 ? (
                    <div className="mb-6 rounded-[22px] border border-white/6 bg-[#121214]/70 p-5">
                      <p className="text-sm font-black tracking-tight text-white">Unavailable private witnesses</p>
                      <p className="mt-2 text-xs leading-relaxed text-white/55">
                        {unavailableAttestedRecords.length} attested record{unavailableAttestedRecords.length === 1 ? "" : "s"} are missing local witness data on this browser, so they cannot be included in a private credential yet.
                      </p>
                    </div>
                  ) : null}

                  {status && !busy ? (
                    <div className="mb-6 rounded-[22px] border border-white/8 bg-white/[0.03] p-4 text-sm leading-relaxed text-white/70">
                      {status}
                    </div>
                  ) : null}

                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <h2 className="text-base sm:text-lg md:text-xl font-black uppercase tracking-tight text-white">Reputation Cards</h2>
                      <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-[10px] font-semibold text-violet-200">
                        {visibleShowcaseCards.length}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedCardTab === "active" ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleShareReputation()}
                            disabled={sharingReputation}
                            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-white transition hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-60"
                          >
                            {sharingReputation ? <Loader2 className="h-4 w-4 animate-spin" /> : <Share2 className="h-4 w-4" />}
                            {sharingReputation ? "Sharing..." : "Share"}
                          </button>
                          <button
                            type="button"
                            onClick={() => openCredentialModal()}
                            className="inline-flex h-10 items-center justify-center rounded-xl bg-white px-4 text-[11px] font-bold uppercase tracking-[0.16em] text-black transition hover:bg-white/90"
                          >
                            Generate Cred
                          </button>
                        </>
                      ) : null}
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    {busy ? (
                      <div className="flex h-full min-h-[392px] flex-col rounded-[28px] border border-white/6 bg-[#121214]/80 p-5 shadow-[0_18px_50px_rgba(0,0,0,0.28)] overflow-hidden">
                        <div className="flex items-center justify-between gap-3 text-xs text-white/55">
                          <div className="flex items-center gap-2">
                            <div className="h-7 w-7 overflow-hidden rounded-full border border-white/8 bg-black">
                              <img src={profileAvatar || DEFAULT_PROFILE_AVATAR} alt={profileName} className="h-full w-full object-cover" />
                            </div>
                            <span>{profileName}</span>
                          </div>
                          <span className="rounded-full border border-violet-400/20 bg-violet-400/10 px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-violet-200">
                            in progress
                          </span>
                        </div>

                        <div className="mt-8 flex flex-1 flex-col items-center justify-center gap-4 text-center">
                          <Loader2 className="h-7 w-7 animate-spin text-violet-300" />
                          <p className="text-xs font-black uppercase tracking-[0.22em] text-white/65">
                            {generationStep}
                          </p>
                          <div className="w-full max-w-[18rem]">
                            <div className="h-1.5 overflow-hidden rounded-full bg-white/8">
                              <div
                                className="h-full rounded-full bg-white/65 transition-all duration-300"
                                style={{ width: `${generationProgress}%` }}
                              />
                            </div>
                            <p className="mt-2 text-[10px] font-black uppercase tracking-[0.18em] text-white/35">
                              Approx. total 1-3 min
                            </p>
                          </div>
                          <div className="inline-flex items-center gap-2 rounded-full border border-amber-400/20 bg-amber-400/10 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-amber-200">
                            <span className="h-1.5 w-1.5 rounded-full bg-amber-300" />
                            Keep the Reputation page open
                          </div>
                        </div>
                      </div>
                    ) : null}
                    {visibleShowcaseCards.length === 0 ? (
                      <div className="xl:col-span-2 rounded-[22px] border border-white/5 bg-[#121214]/70 p-5">
                        <p className="text-base font-black tracking-tight text-white">
                          {selectedCardTab === "archive" ? "No archived creds yet" : "No public creds yet"}
                        </p>
                        <p className="mt-2 text-xs leading-relaxed text-white/55">
                          {selectedCardTab === "archive"
                            ? "Archived reputation cards will appear here after you move them out of the active tab."
                            : "Reputation cards appear here after you generate public, verifiable credentials from your market activity."}
                        </p>
                      </div>
                    ) : (
                      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleCardDragEnd}>
                        <SortableContext items={visibleShowcaseCards.map((card) => card.id)} strategy={rectSortingStrategy}>
                          {visibleShowcaseCards.map((card) => (
                            <SortableCredentialCard
                              key={card.id}
                              card={card}
                              profileName={profileName}
                              profileAvatar={profileAvatar}
                              openCardMenuId={openCardMenuId}
                              selectedCardTab={selectedCardTab}
                              removingCardId={removingCardId}
                              verifyingCardId={verifyingCardId}
                              verificationNotice={verificationNotice}
                              onToggleMenu={(cardId) => setOpenCardMenuId((current) => (current === cardId ? null : cardId))}
                              onArchive={(nextCard) => {
                                setOpenCardMenuId(null);
                                void handleArchiveAchievement(nextCard);
                              }}
                              onRemove={(nextCard) => {
                                setOpenCardMenuId(null);
                                setCardPendingRemoval(findAchievementBySerialized(nextCard.serialized));
                              }}
                              onShowDetails={(nextCard) => {
                                setOpenCardMenuId(null);
                                setSelectedCard(nextCard);
                              }}
                              onVerify={(nextCard) => {
                                setOpenCardMenuId(null);
                                void handleVerifyShowcaseCard(nextCard);
                              }}
                            />
                          ))}
                        </SortableContext>
                      </DndContext>
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      <ShowcaseDetailsModal card={selectedCard} onClose={() => setSelectedCard(null)} />
      <RemoveAchievementModal
        card={cardPendingRemoval}
        isRemoving={Boolean(cardPendingRemoval && removingCardId === cardPendingRemoval.id)}
        onClose={() => setCardPendingRemoval(null)}
        onConfirm={() => {
          if (cardPendingRemoval) {
            void handleRemoveAchievement(cardPendingRemoval);
          }
        }}
      />
      <ShareReputationModal
        shareUrl={shareModalState?.url ?? null}
        version={shareModalState?.version ?? null}
        onClose={() => setShareModalState(null)}
      />
      <LocalShareWarningModal
        open={showLocalShareWarning}
        isSharing={sharingReputation}
        onClose={() => setShowLocalShareWarning(false)}
        onContinue={() => {
          void publishReputationShare();
        }}
      />

      <ReputationModal
        isOpen={isCredModalOpen}
        onClose={closeCredentialModal}
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
        onGenerate={handleGenerateCredentialFromModal}
        onVerify={handleVerifyCredential}
      />

      <PublicProfileSettingsModal
        isOpen={isProfileModalOpen}
        onOpenChange={setIsProfileModalOpen}
      />
    </div>
  );
}
