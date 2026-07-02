"use client";

import { useEffect, useMemo, useState } from "react";
import Image from "next/image";
import { useParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, Loader2, X } from "lucide-react";
import { fetchReputationShare, type ReputationShareRecord } from "@/lib/reputation-share";
import { formatUsdc } from "@/lib/blind-market";
import { DEFAULT_PROFILE_AVATAR } from "@/lib/profile-avatar";
import { verifyReputationProof } from "@/lib/proofs";
import { reputationStatementLabel, verifyAttestedRecordSignature, type SerializedReputationClaimDescriptor } from "@/lib/reputation";

function shortHash(value: string, start = 8, end = 6) {
  if (!value) return "—";
  if (value.length <= start + end + 3) return value;
  return `${value.slice(0, start)}...${value.slice(-end)}`;
}

type PublicShowcaseCard = {
  id: string;
  title: string;
  serialized: string;
  category: string;
  description: string;
  meta: string;
  snapshotRecordCount: number;
  scorePoints: number;
  tags: string[];
  status: string;
  snapshotRoot: string;
  proofHex: string;
  publicInputsHex: string[];
  attestorKeyId: string;
  claim: SerializedReputationClaimDescriptor;
  proofValid: boolean;
  snapshotVerified: boolean;
  createdAt: number;
};

type PublicAchievement = ReputationShareRecord["snapshot"]["achievements"][number];

function scoreForAchievement(achievement: PublicAchievement) {
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

function achievementCreatedAtValue(achievement: PublicAchievement) {
  return achievement.publicClaim.createdAt ?? achievement.createdAt ?? 0;
}

function achievementFamilyKey(achievement: PublicAchievement) {
  const { claim, publicClaim } = achievement;
  const baseKey = `${publicClaim.category.toLowerCase()}:${publicClaim.windowDays}`;
  if (claim.claimType === "percentile") {
    return `${baseKey}:percentile`;
  }
  return `${baseKey}:threshold:${claim.metric}`;
}

function achievementStrengthValue(achievement: PublicAchievement) {
  const { claim } = achievement;
  if (claim.claimType === "percentile") {
    return claim.band === 10 ? 3 : claim.band === 25 ? 2 : 1;
  }
  return Number(claim.threshold);
}

function compareAchievementsForScoring(left: PublicAchievement, right: PublicAchievement) {
  const strengthDelta = achievementStrengthValue(left) - achievementStrengthValue(right);
  if (strengthDelta !== 0) {
    return strengthDelta;
  }
  return achievementCreatedAtValue(left) - achievementCreatedAtValue(right);
}

function achievementsUsedForReputationScore(achievements: PublicAchievement[]) {
  const strongestByFamily = new Map<string, PublicAchievement>();

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

function reputationScoreFromAchievements(achievements: PublicAchievement[]) {
  if (achievements.length === 0) {
    return 0;
  }

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

function buildPublicCards(achievements: ReputationShareRecord["snapshot"]["achievements"]): PublicShowcaseCard[] {
  return achievements
    .filter((achievement) => !achievement.archivedAt)
    .map((achievement) => {
      const card: PublicShowcaseCard = {
        id: `${achievement.proofHex}-${achievement.createdAt}`,
        title: reputationStatementLabel(achievement.claim),
        serialized: achievement.serialized,
        category: achievement.publicClaim.category,
        description: `Proof-backed reputation statement for ${achievement.publicClaim.category} over a ${achievement.publicClaim.windowDays}-day window.`,
        meta: `Created ${formatCredentialCreatedAt(achievement.publicClaim.createdAt ?? achievement.createdAt)} · ${credentialWindowLabel(achievement.publicClaim.windowDays)}`,
        snapshotRecordCount: achievement.publicClaim.snapshotRecordCount ?? 1,
        scorePoints: scoreForAchievement(achievement),
        tags: [],
        status: achievement.proofValid && achievement.snapshotVerified ? "verified" : "draft",
        snapshotRoot: achievement.publicClaim.snapshotRoot,
        proofHex: achievement.proofHex,
        publicInputsHex: achievement.publicInputsHex,
        attestorKeyId: achievement.attestorKeyId,
        claim: achievement.claim,
        proofValid: achievement.proofValid,
        snapshotVerified: achievement.snapshotVerified,
        createdAt: achievement.createdAt,
      };

      return {
        ...card,
        tags: [
          card.category,
          `${card.scorePoints} pts`,
        ],
      };
    });
}

function PublicShowcaseCardView({
  card,
  profileName,
  profileAvatar,
  onShowDetails,
  onVerify,
  verifyingCardId,
  verificationNotice,
}: {
  card: PublicShowcaseCard;
  profileName: string;
  profileAvatar: string;
  onShowDetails: (card: PublicShowcaseCard) => void;
  onVerify: (card: PublicShowcaseCard) => void;
  verifyingCardId: string | null;
  verificationNotice: { cardId: string; message: string } | null;
}) {
  return (
    <div className="relative flex h-full flex-col rounded-[24px] border border-white/8 bg-[#101013] p-5">
      <div className="flex items-center justify-between gap-3 text-xs text-white/55">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 overflow-hidden rounded-full border border-white/8 bg-black">
            <img src={profileAvatar || DEFAULT_PROFILE_AVATAR} alt={profileName} className="h-full w-full object-cover" />
          </div>
          <span className="text-[13px] text-white/62">{profileName}</span>
        </div>
        <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/72">
          {card.proofValid && card.snapshotVerified ? "Verified" : "Draft"}
        </span>
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
        <p className="mt-3 text-[11px] font-semibold text-emerald-300">{verificationNotice.message}</p>
      ) : null}
    </div>
  );
}

function PublicShowcaseDetailsModal({
  card,
  onClose,
}: {
  card: PublicShowcaseCard | null;
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

  async function copyText(value: string) {
    await navigator.clipboard.writeText(value);
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
                <h3 className="mt-2 text-xl font-black tracking-tight text-white sm:text-2xl">{card.title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-white/55">{card.description}</p>
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
                {[card.category, `${card.scorePoints} pts`].map((tag) => (
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
                    {card.snapshotRoot}
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
                    {card.attestorKeyId}
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

export default function ReputationSharePage({ params }: { params: { slug: string } }) {
  const [share, setShare] = useState<ReputationShareRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCard, setSelectedCard] = useState<PublicShowcaseCard | null>(null);
  const [verifyingCardId, setVerifyingCardId] = useState<string | null>(null);
  const [verificationNotice, setVerificationNotice] = useState<{ cardId: string; message: string } | null>(null);
  const routeParams = useParams<{ slug?: string | string[] }>();

  const slug = Array.isArray(routeParams?.slug)
    ? routeParams.slug[0]
    : routeParams?.slug ?? params?.slug;

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (!slug) {
        if (!mounted) return;
        setShare(null);
        setError("This reputation share could not be found.");
        setLoading(false);
        return;
      }

      try {
        const nextShare = await fetchReputationShare(slug);
        if (!mounted) return;
        setShare(nextShare);
        setError(nextShare ? null : "This reputation share could not be found.");
      } catch (nextError) {
        if (!mounted) return;
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    void run();
    return () => {
      mounted = false;
    };
  }, [slug]);

  const activeCards = useMemo(
    () => buildPublicCards(share?.snapshot.achievements ?? []),
    [share],
  );
  const summary = share?.snapshot.summary ?? null;
  const legacyPositions = share?.snapshot.positions ?? [];
  const attestedRecords = share?.snapshot.attestedRecords ?? [];
  const profileName = share?.snapshot.profile.displayName || "Public trader";
  const profileBio = share?.snapshot.profile.bio || "Trading on Aegis with a public reputation profile.";
  const profileHandle = `@${shortHash(share?.walletAddress ?? "", 6, 4)}`;
  const reputationScore = useMemo(
    () => reputationScoreFromAchievements(share?.snapshot.achievements ?? []),
    [share],
  );
  const totalMarkets = summary?.totalMarkets ?? new Set(legacyPositions.map((position) => position.marketId)).size;
  const totalCommitted = summary
    ? BigInt(summary.totalCollateralInStroops ?? "0")
    : legacyPositions.reduce((sum, record) => sum + BigInt(record.amountInStroops), 0n);
  const derivedCategoryTags = [
    ...new Set(
      [
        ...legacyPositions.map((position) => position.category.toLowerCase()),
        ...attestedRecords.map((record) => record.category.toLowerCase()),
        ...activeCards.map((card) => card.category.toLowerCase()),
      ].filter(Boolean),
    ),
  ];
  const categoryTags = summary?.categories?.length
    ? summary.categories
    : derivedCategoryTags.slice(0, 4);
  const totalCategories = summary?.totalCategories ?? derivedCategoryTags.length;

  async function handleVerifyCard(card: PublicShowcaseCard) {
    setVerifyingCardId(card.id);
    try {
      const scopedAttestedRecords = (share?.snapshot.attestedRecords ?? []).filter((record) => (
        verifyAttestedRecordSignature(record)
        && record.category.toLowerCase() === card.category.toLowerCase()
      ));

      if (scopedAttestedRecords.length === 0) {
        throw new Error(`No attested records are available for ${card.category} in this public snapshot.`);
      }

      const verified = await verifyReputationProof(card.serialized, scopedAttestedRecords);
      setVerificationNotice({
        cardId: card.id,
        message: verified.isValid ? "Verified successfully" : "Verification failed",
      });
      window.setTimeout(() => {
        setVerificationNotice((current) => (current?.cardId === card.id ? null : current));
      }, 2500);
    } catch (error) {
      setVerificationNotice({
        cardId: card.id,
        message: error instanceof Error ? error.message : "Verification failed",
      });
      window.setTimeout(() => {
        setVerificationNotice((current) => (current?.cardId === card.id ? null : current));
      }, 3500);
    } finally {
      setVerifyingCardId(null);
    }
  }

  return (
    <div className="min-h-screen bg-[#050507] text-white selection:bg-white selection:text-black">
      <main className="px-4 py-24 sm:px-6 sm:py-28 md:px-8 md:py-32 lg:px-12">
        {loading ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-10 w-10 animate-spin text-violet-400" />
              <span className="text-[10px] font-black uppercase tracking-[0.38em] text-violet-400/70">
                Loading Reputation
              </span>
            </div>
          </div>
        ) : error ? (
          <div className="mx-auto mt-12 max-w-3xl rounded-[32px] border border-white/6 bg-[#121214]/70 p-8">
            <p className="text-xl font-black text-white">Share not available</p>
            <p className="mt-3 text-sm text-white/55">{error}</p>
          </div>
        ) : (
          <div className="mx-auto max-w-[1280px]">
            <section className="grid gap-10 lg:grid-cols-[400px_minmax(0,1fr)]">
              <aside className="px-2 pt-2">
                <div className="flex items-start gap-6">
                  <div className="flex h-24 w-24 shrink-0 aspect-square items-center justify-center overflow-hidden rounded-full border border-white/5 bg-[#121214] text-2xl font-black uppercase text-white">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={share?.snapshot.profile.avatarDataUrl || DEFAULT_PROFILE_AVATAR} alt={profileName} className="block h-full w-full min-h-full min-w-full rounded-full object-cover" />
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
                    <p><span className="mr-2 font-black text-violet-300">{activeCards.length}</span>Creds</p>
                  </div>
                </div>

                <div className="mt-8 border-t border-white/8 pt-8">
                  <div className="space-y-3 text-[14px] text-white/78">
                    <div className="flex items-center gap-3 text-white/55">
                      <span className="text-sm">□</span>
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{share?.walletAddress ? shortHash(share.walletAddress, 10, 8) : "Wallet pending"}</span>
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
                    Reputation score {reputationScore}/100 · {share ? formatShortDate(share.createdAt) : "No history yet"} · {share?.walletAddress ? shortHash(share.walletAddress, 8, 6) : "Wallet pending"}
                  </div>
                </div>
              </aside>

              <div className="min-w-0">
                <div className="border-b border-white/8">
                  <div className="flex items-center gap-6">
                    <div className="border-b-2 border-violet-400 pb-3 text-base sm:text-lg font-semibold text-violet-300">
                      Reputation
                    </div>
                  </div>
                </div>

                <div className="mt-10">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex items-center gap-3">
                      <h2 className="text-base sm:text-lg md:text-xl font-black uppercase tracking-tight text-white">Reputation Cards</h2>
                      <span className="rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1 text-[10px] font-semibold text-violet-200">
                        {activeCards.length}
                      </span>
                    </div>
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    {activeCards.length === 0 ? (
                      <div className="xl:col-span-2 rounded-[22px] border border-white/5 bg-[#121214]/70 p-5">
                        <p className="text-base font-black tracking-tight text-white">No public creds yet</p>
                        <p className="mt-2 text-xs leading-relaxed text-white/55">
                          Reputation cards will appear here after they are published into this public snapshot.
                        </p>
                      </div>
                    ) : (
                      activeCards.map((card) => (
                        <PublicShowcaseCardView
                          key={card.id}
                          card={card}
                          profileName={profileName}
                          profileAvatar={share?.snapshot.profile.avatarDataUrl || DEFAULT_PROFILE_AVATAR}
                          verifyingCardId={verifyingCardId}
                          verificationNotice={verificationNotice}
                          onShowDetails={(nextCard) => setSelectedCard(nextCard)}
                          onVerify={(nextCard) => void handleVerifyCard(nextCard)}
                        />
                      ))
                    )}
                  </div>
                </div>
              </div>
            </section>
          </div>
        )}
      </main>

      <PublicShowcaseDetailsModal card={selectedCard} onClose={() => setSelectedCard(null)} />
    </div>
  );
}
