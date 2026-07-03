"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Navbar } from "@/components/landing/Navbar";
import { expectedPayoutForPosition, formatUsdc, mapMarketSummary, marketStatusLabel, payoutForPosition, positionStatusLabel } from "@/lib/blind-market";
import type { BlindMarketSummary, BlindPositionRecord } from "@/lib/types";
import { claimWinningsWithPrivyWallet, getBrowserConfig, getPrivyStellarWallet, loadMarketIds, loadMarketView, submitPrivateTallyWithPrivyWallet, submitTallySharesToBackend, type MarketView } from "@/lib/stellar";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { AlertCircle, Check, ChevronDown, ExternalLink, FolderLock, Loader2, MoveRight, ShieldCheck, Trophy, X } from "lucide-react";
import { attestClaimRecord, loadReputationSnapshot, markClaimedPosition, upsertAttestedRecord, upsertPrivateReputationWitness } from "@/lib/reputation-vault";
import { computeRecordCommitment, generateClaimProof, generateTallyUpdateProof, randomWitnessSalt } from "@/lib/proofs";
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from "@/lib/privy-stellar-wallet";

type StellarMarketRow = {
  marketId: string;
  view: MarketView;
};

type PositionGroup = {
  marketId: string;
  market: BlindMarketSummary | null;
  positions: BlindPositionRecord[];
  totalCommitted: bigint;
  totalClaimable: bigint;
  yesCommitted: bigint;
  noCommitted: bigint;
};

type PreparedActionReview =
  | {
      kind: "tally";
      group: PositionGroup;
      positions: BlindPositionRecord[];
      retryCount: number;
      newCount: number;
    }
  | {
      kind: "claim";
      group: PositionGroup;
      positions: BlindPositionRecord[];
      totalPayout: bigint;
    };

function marketQuestion(group: PositionGroup) {
  return group.market?.question ?? group.positions[0]?.marketQuestion ?? "Unknown market";
}

function marketCategory(group: PositionGroup) {
  return group.market?.category ?? group.positions[0]?.category ?? "private";
}

function isSubmittedOrQueued(position: BlindPositionRecord) {
  return position.tallyStatus === "tally_submitted"
    || position.tallyStatus === "queued_for_auto_finalization"
    || position.tallyStatus === "finalizing"
    || Boolean(position.talliedAt);
}

function explorerTransactionUrl(hash: string) {
  const networkSegment = getBrowserConfig().networkPassphrase.includes("Test") ? "testnet" : "public";
  return `https://stellar.expert/explorer/${networkSegment}/tx/${hash}`;
}

export default function PositionsPage() {
  const { user, authenticated, login } = usePrivy();
  const { createWallet } = useCreateWallet();
  const { signRawHash } = useSignRawHash();
  const [rows, setRows] = useState<StellarMarketRow[]>([]);
  const [savedPositions, setSavedPositions] = useState<BlindPositionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState("");
  const [expandedMarketGroup, setExpandedMarketGroup] = useState<string | null>(null);
  const [expandedPositionDetails, setExpandedPositionDetails] = useState<string | null>(null);
  const [isActionReviewOpen, setIsActionReviewOpen] = useState(false);
  const [preparedAction, setPreparedAction] = useState<PreparedActionReview | null>(null);
  const [actionTxHashes, setActionTxHashes] = useState<string[]>([]);
  const [actionReviewError, setActionReviewError] = useState("");
  const [now, setNow] = useState(Date.now());
  const stellarWallet = getPrivyStellarWallet(user);

  const walletAddress = useMemo(() => {
    const accounts = (user?.linkedAccounts ?? []) as Array<{
      address?: string;
      chainType?: string;
      chain_type?: string;
      type?: string;
    }>;

    return accounts.find((account) => (
      account.type === "wallet"
      && (account.chainType === "stellar" || account.chain_type === "stellar")
      && account.address
    ))?.address ?? "";
  }, [user]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!authenticated || stellarWallet) {
      return;
    }

    ensurePrivyStellarWallet({
      authenticated,
      hasWallet: Boolean(stellarWallet),
      createWallet,
    }).catch((error) => {
      if (isPrivyStellarWalletLimitError(error)) {
        return;
      }
      console.error("Failed to create Privy Stellar wallet for positions page:", error);
    });
  }, [authenticated, createWallet, stellarWallet]);

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      if (!walletAddress) {
        setSavedPositions([]);
        return;
      }

      try {
        const snapshot = await loadReputationSnapshot(walletAddress);
        if (mounted) {
          setSavedPositions(snapshot.positions);
        }
      } catch (error) {
        console.error("Failed to load reputation snapshot for positions page:", error);
      }
    };

    void run();

    return () => {
      mounted = false;
    };
  }, [walletAddress]);

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

        const nextRows = settled.flatMap((result) => (
          result.status === "fulfilled"
            ? [{ marketId: result.value.marketId, view: result.value.view }]
            : []
        ));

        setRows(nextRows);
      } catch (error) {
        console.error("Failed to load markets for positions page:", error);
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
  const marketMap = useMemo(
    () => new Map(markets.map((market) => [market.marketId, market])),
    [markets],
  );

  const refreshPositions = async () => {
    if (!walletAddress) {
      setSavedPositions([]);
      return;
    }
    const snapshot = await loadReputationSnapshot(walletAddress);
    setSavedPositions(snapshot.positions);
  };

  const refreshMarkets = async () => {
    const marketIds = await loadMarketIds();
    const settled = await Promise.allSettled(
      marketIds.map(async (marketId) => ({
        marketId,
        view: await loadMarketView(marketId),
      })),
    );

    const nextRows = settled.flatMap((result) => (
      result.status === "fulfilled"
        ? [{ marketId: result.value.marketId, view: result.value.view }]
        : []
    ));
    setRows(nextRows);
  };

  function resetActionReview() {
    setIsActionReviewOpen(false);
    setPreparedAction(null);
    setActionTxHashes([]);
    setActionReviewError("");
  }

  function openBatchTallyReview(group: PositionGroup) {
    if (!authenticated) {
      void login();
      return;
    }

    const positions = [...retryableTallyPositionsForGroup(group), ...pendingTallyPositionsForGroup(group)];
    if (positions.length === 0) {
      return;
    }

    setActionReviewError("");
    setActionTxHashes([]);
    setPreparedAction({
      kind: "tally",
      group,
      positions,
      retryCount: retryableTallyPositionsForGroup(group).length,
      newCount: pendingTallyPositionsForGroup(group).length,
    });
    setIsActionReviewOpen(true);
  }

  function openBatchClaimReview(group: PositionGroup) {
    if (!authenticated) {
      void login();
      return;
    }

    const positions = claimablePositionsForGroup(group);
    if (positions.length === 0) {
      return;
    }

    const totalPayout = positions.reduce((sum, position) => sum + payoutForPosition(group.market!, BigInt(position.amountInStroops)), 0n);
    setActionReviewError("");
    setActionTxHashes([]);
    setPreparedAction({
      kind: "claim",
      group,
      positions,
      totalPayout,
    });
    setIsActionReviewOpen(true);
  }

  const walletPositions = useMemo(
    () => savedPositions.filter((position) => !walletAddress || position.owner === walletAddress),
    [savedPositions, walletAddress],
  );

  const groupedPositions = useMemo(() => {
    const grouped = new Map<string, BlindPositionRecord[]>();

    walletPositions.forEach((position) => {
      const current = grouped.get(position.marketId) ?? [];
      current.push(position);
      grouped.set(position.marketId, current);
    });

    return Array.from(grouped.entries())
      .map(([marketId, positions]) => {
        const market = marketMap.get(marketId) ?? null;
        const totalCommitted = positions.reduce((sum, position) => sum + BigInt(position.amountInStroops), 0n);
        const yesCommitted = positions
          .filter((position) => position.side === "YES")
          .reduce((sum, position) => sum + BigInt(position.amountInStroops), 0n);
        const noCommitted = positions
          .filter((position) => position.side === "NO")
          .reduce((sum, position) => sum + BigInt(position.amountInStroops), 0n);
        const totalClaimable = positions.reduce((sum, position) => {
          if (position.claimedAt) {
            return sum;
          }
          const payout = expectedPayoutForPosition(position, market);
          return payout === null ? sum : sum + payout;
        }, 0n);

        return {
          marketId,
          market,
          positions: positions.slice().sort((left, right) => Number(BigInt(right.amountInStroops) - BigInt(left.amountInStroops))),
          totalCommitted,
          totalClaimable,
          yesCommitted,
          noCommitted,
        } satisfies PositionGroup;
      })
      .sort((left, right) => Number(right.totalCommitted - left.totalCommitted));
  }, [marketMap, walletPositions]);

  function groupNeedsTally(group: PositionGroup) {
    if (!group.market) {
      return false;
    }

    return !group.market.resolved && now >= group.market.endTimestamp && now < group.market.tallyDeadline;
  }

  function pendingTallyPositionsForGroup(group: PositionGroup) {
    if (!group.market || !groupNeedsTally(group)) {
      return [];
    }

    return group.positions.filter((position) => (
      position.tallyStatus !== "queued_for_auto_finalization"
      && position.tallyStatus !== "finalizing"
      && position.tallyStatus !== "tally_submitted"
      && position.tallyStatus !== "share_upload_failed"
    ));
  }

  function retryableTallyPositionsForGroup(group: PositionGroup) {
    return group.positions.filter((position) => position.tallyStatus === "share_upload_failed");
  }

  function claimablePositionsForGroup(group: PositionGroup) {
    if (
      !group.market
      || !group.market.resolved
      || !group.market.outcome
      || group.market.winningSideTotal <= 0n
      || group.market.distributablePot <= 0n
    ) {
      return [];
    }

    return group.positions.filter((position) => (
      !position.claimedAt
      && isSubmittedOrQueued(position)
      && position.side === group.market?.outcome
    ));
  }

  async function submitTallyForPosition(group: PositionGroup, position: BlindPositionRecord, previousTallyCommitment: string) {
    if (!stellarWallet || !walletAddress || !group.market) {
      throw new Error("Connect your Privy Stellar wallet before submitting a tally.");
    }

    let submittedTxHash: string | null = position.tallyTxHash ?? null;
    let submittedShareCommitmentRoot = position.shareCommitmentRoot ?? "";
    let submittedSharePackets = position.tallySharePackets ?? [];

    try {
      const proof = await generateTallyUpdateProof({
        marketId: group.marketId,
        side: position.side,
        amountInStroops: BigInt(position.amountInStroops),
        salt: position.salt,
        commitment: position.commitment,
        previousTallyCommitment,
      });

      const tx = await submitPrivateTallyWithPrivyWallet(stellarWallet, signRawHash, {
        marketId: group.marketId,
        commitment: position.commitment,
        previousTallyCommitment,
        nextTallyCommitment: proof.nextTallyCommitment,
        shareCommitmentRoot: proof.shareCommitmentRoot,
        collateralAmount: BigInt(position.amountInStroops),
        proofHex: proof.proofHex,
      });

      submittedTxHash = tx.hash;
      submittedShareCommitmentRoot = proof.shareCommitmentRoot;
      submittedSharePackets = proof.sharePackets;

      await submitTallySharesToBackend({
        tallyTxHash: tx.hash,
        shareCommitmentRoot: proof.shareCommitmentRoot,
        packets: proof.sharePackets,
      });

      const talliedAt = Date.now();
      setSavedPositions((current) => current.map((entry) => (
        entry.commitment === position.commitment
          ? {
            ...entry,
            tallyTxHash: tx.hash,
            tallyStatus: "queued_for_auto_finalization",
            talliedAt,
            shareCommitmentRoot: proof.shareCommitmentRoot,
            tallySharePackets: proof.sharePackets,
          }
          : entry
      )));
      await markClaimedPosition(walletAddress, position.commitment, {
        tallyTxHash: tx.hash,
        tallyStatus: "queued_for_auto_finalization",
        talliedAt,
        shareCommitmentRoot: proof.shareCommitmentRoot,
        tallySharePackets: proof.sharePackets,
      });

      return {
        nextTallyCommitment: proof.nextTallyCommitment,
        txHash: tx.hash,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (submittedTxHash) {
        setSavedPositions((current) => current.map((entry) => (
          entry.commitment === position.commitment
            ? {
              ...entry,
              tallyTxHash: submittedTxHash ?? entry.tallyTxHash,
              tallyStatus: "share_upload_failed",
              shareCommitmentRoot: submittedShareCommitmentRoot || entry.shareCommitmentRoot,
              tallySharePackets: submittedSharePackets.length > 0 ? submittedSharePackets : entry.tallySharePackets,
            }
            : entry
        )));
        await markClaimedPosition(walletAddress, position.commitment, {
          tallyTxHash: submittedTxHash ?? position.tallyTxHash,
          tallyStatus: "share_upload_failed",
          shareCommitmentRoot: submittedShareCommitmentRoot || position.shareCommitmentRoot,
          tallySharePackets: submittedSharePackets.length > 0 ? submittedSharePackets : position.tallySharePackets,
        });
      }
      throw new Error(message);
    }
  }

  async function claimSinglePosition(group: PositionGroup, position: BlindPositionRecord) {
    if (!stellarWallet || !walletAddress || !group.market?.outcome) {
      throw new Error("Connect your Privy Stellar wallet before claiming.");
    }

    const proof = await generateClaimProof({
      marketId: group.marketId,
      side: position.side,
      amountInStroops: BigInt(position.amountInStroops),
      salt: position.salt,
      commitment: position.commitment,
      outcome: group.market.outcome === "YES",
      distributablePot: group.market.distributablePot,
      winningSideTotal: group.market.winningSideTotal,
    });

    const tx = await claimWinningsWithPrivyWallet(stellarWallet, signRawHash, {
      marketId: group.marketId,
      commitment: proof.commitment,
      nullifier: proof.nullifier,
      recipient: position.owner,
      proofHex: proof.proofHex,
    });

    const claimedAt = Date.now();
    setSavedPositions((current) => current.map((entry) => (
      entry.commitment === position.commitment
        ? { ...entry, nullifier: proof.nullifier, claimTxHash: tx.hash, claimedAt, reputationAttestationStatus: "pending" }
        : entry
    )));
    await markClaimedPosition(walletAddress, position.commitment, {
      nullifier: proof.nullifier,
      claimTxHash: tx.hash,
      claimedAt,
      reputationAttestationStatus: "pending",
    });

    const payoutInStroops = payoutForPosition(group.market, BigInt(position.amountInStroops));
    const witnessSalt = randomWitnessSalt();
    const recordCommitment = await computeRecordCommitment({
      walletAddress,
      marketId: group.marketId,
      category: group.market.category,
      amountInStroops: BigInt(position.amountInStroops),
      payoutInStroops,
      won: payoutInStroops > 0n,
      claimedAt: Math.floor(claimedAt / 1000),
      witnessSalt,
    });
    await upsertPrivateReputationWitness(walletAddress, {
      marketId: group.marketId,
      commitment: position.commitment,
      nullifier: proof.nullifier,
      side: position.side,
      amountInStroops: position.amountInStroops,
      payoutInStroops: payoutInStroops.toString(),
      won: payoutInStroops > 0n,
      claimedAt: Math.floor(claimedAt / 1000),
      resolvedAt: group.market.settledAt ? Math.floor(group.market.settledAt / 1000) : 0,
      category: group.market.category.toLowerCase(),
      witnessSalt,
      recordCommitment,
    });

    try {
      const attestedRecord = await attestClaimRecord({
        walletAddress,
        marketId: group.marketId,
        commitment: position.commitment,
        nullifier: proof.nullifier,
        claimTxHash: tx.hash,
        category: group.market.category,
        recordCommitment,
        witnessSalt,
        claimedAt,
      });
      await upsertAttestedRecord(walletAddress, attestedRecord);
      await upsertPrivateReputationWitness(walletAddress, {
        marketId: group.marketId,
        commitment: position.commitment,
        nullifier: proof.nullifier,
        side: position.side,
        amountInStroops: position.amountInStroops,
        payoutInStroops: payoutInStroops.toString(),
        won: payoutInStroops > 0n,
        claimedAt: attestedRecord.claimedAt,
        resolvedAt: attestedRecord.resolvedAt,
        category: group.market.category.toLowerCase(),
        witnessSalt,
        recordCommitment,
      });
      setSavedPositions((current) => current.map((entry) => (
        entry.commitment === position.commitment
          ? { ...entry, reputationAttestationStatus: "attested" }
          : entry
      )));
      await markClaimedPosition(walletAddress, position.commitment, {
        reputationAttestationStatus: "attested",
      });
    } catch (attestationError) {
      console.error("Claim attestation failed:", attestationError);
    }

    return tx.hash;
  }

  async function handleBatchTally(group: PositionGroup) {
    if (!authenticated) {
      await login();
      return;
    }

    const positions = [...retryableTallyPositionsForGroup(group), ...pendingTallyPositionsForGroup(group)];
    if (positions.length === 0) {
      return;
    }

    setBusyAction(`tally:${group.marketId}`);
    setActionError("");
    let completedCount = 0;
    try {
      let liveView = await loadMarketView(group.marketId);
      let liveMarket = mapMarketSummary({ marketId: group.marketId, view: liveView });
      let previousTallyCommitment = liveMarket.tallyCommitment || `0x${"0".repeat(64)}`;
      const txHashes: string[] = [];

      for (const position of positions) {
        const result = await submitTallyForPosition(group, position, previousTallyCommitment);
        previousTallyCommitment = result.nextTallyCommitment;
        txHashes.push(result.txHash);
        completedCount += 1;
        liveView = await loadMarketView(group.marketId);
        liveMarket = mapMarketSummary({ marketId: group.marketId, view: liveView });
        previousTallyCommitment = liveMarket.tallyCommitment || previousTallyCommitment;
      }

      setActionTxHashes(txHashes);
      await Promise.all([refreshMarkets(), refreshPositions()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(
        completedCount > 0
          ? `${completedCount} tall${completedCount === 1 ? "y" : "ies"} submitted before the batch stopped. ${message}`
          : message,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleBatchClaim(group: PositionGroup) {
    if (!authenticated) {
      await login();
      return;
    }

    const positions = claimablePositionsForGroup(group);
    if (positions.length === 0) {
      return;
    }

    setBusyAction(`claim:${group.marketId}`);
    setActionError("");
    let completedCount = 0;
    const txHashes: string[] = [];
    try {
      for (const position of positions) {
        const txHash = await claimSinglePosition(group, position);
        txHashes.push(txHash);
        completedCount += 1;
      }

      setActionTxHashes(txHashes);
      await Promise.all([refreshMarkets(), refreshPositions()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionError(
        completedCount > 0
          ? `${completedCount} claim${completedCount === 1 ? "" : "s"} completed before the batch stopped. ${message}`
          : message,
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function handleApproveActionReview() {
    if (!preparedAction) {
      return;
    }

    try {
      if (preparedAction.kind === "tally") {
        await handleBatchTally(preparedAction.group);
      } else {
        await handleBatchClaim(preparedAction.group);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionReviewError(message);
      throw error;
    }
  }

  const needsAttention = groupedPositions.some((group) => (
    retryableTallyPositionsForGroup(group).length > 0
    || pendingTallyPositionsForGroup(group).length > 0
    || claimablePositionsForGroup(group).length > 0
  ));

  const totalCommitted = useMemo(
    () => groupedPositions.reduce((sum, group) => sum + group.totalCommitted, 0n),
    [groupedPositions],
  );
  const totalClaimable = useMemo(
    () => groupedPositions.reduce((sum, group) => sum + group.totalClaimable, 0n),
    [groupedPositions],
  );
  const totalOpenPositions = walletPositions.filter((position) => !position.claimedAt).length;
  const totalClaimedPositions = walletPositions.filter((position) => position.claimedAt).length;

  return (
    <div className="min-h-screen bg-[#050507] text-white selection:bg-white selection:text-black">
      <Navbar transparent={false} />

      <main className="relative px-3 py-24 sm:px-6 sm:py-28 md:px-8 md:py-32 lg:px-12">
        {isLoading ? (
          <div className="flex min-h-[60vh] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div className="relative">
                <div className="absolute inset-0 bg-violet-500/20 blur-2xl rounded-full" />
                <Loader2 className="w-10 h-10 text-violet-400 animate-spin relative z-10" strokeWidth={1.5} />
              </div>
              <span className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-400/70 ml-2">
                Loading Positions
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-8">
            <header>
              <div>
                <div className="mb-1 flex items-center gap-3">
                  <h1 className="text-xl sm:text-2xl md:text-3xl font-black tracking-tight text-white leading-none">
                    My Positions
                  </h1>
                  {needsAttention ? (
                    <span className="inline-flex h-6 min-w-6 items-center justify-center rounded-full border border-red-500/25 bg-red-500/12 px-2 text-[10px] font-black uppercase tracking-[0.18em] text-red-200">
                      !
                    </span>
                  ) : null}
                </div>
                <p className="text-white/45 text-sm sm:text-base">
                  Track your private commitments across every market from one clean view.
                </p>
              </div>
            </header>

            {actionError ? (
              <div className="rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100/85">
                {actionError}
              </div>
            ) : null}

            <section className="grid grid-cols-1 gap-3 md:grid-cols-[1.4fr_1fr_1fr]">
              <div className="rounded-[28px] border border-white/5 bg-[#121214]/60 p-5 sm:p-6">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/45">Portfolio</p>
                <p className="mt-3 text-3xl font-black tracking-tight text-violet-300">{formatUsdc(totalCommitted)}</p>
                <p className="mt-2 text-sm text-white/45">Total private exposure across all saved markets.</p>
              </div>
              <div className="rounded-[28px] border border-white/5 bg-[#121214]/60 p-5 sm:p-6">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/40">Claimable</p>
                <p className="mt-3 text-2xl font-black tracking-tight text-white">{formatUsdc(totalClaimable)}</p>
                <p className="mt-2 text-sm text-white/45">Available after resolved winning positions.</p>
              </div>
              <div className="rounded-[28px] border border-white/5 bg-[#121214]/60 p-5 sm:p-6">
                <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/40">Commitments</p>
                <p className="mt-3 text-2xl font-black tracking-tight text-white">{totalOpenPositions}</p>
                <p className="mt-2 text-sm text-white/45">{totalClaimedPositions} already claimed.</p>
              </div>
            </section>

            {groupedPositions.length === 0 ? (
              <div className="rounded-[32px] border border-white/5 bg-[#121214]/70 p-10 text-center">
                <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-white/10 bg-white/[0.03]">
                  <FolderLock className="h-6 w-6 text-white/35" />
                </div>
                <h2 className="mt-5 text-xl font-black text-white">No private positions yet</h2>
                <p className="mt-2 text-sm text-white/50">
                  Once you commit to a market, your saved private positions will show up here for tracking and claims.
                </p>
                <Link
                  href="/dashboard"
                  className="mt-6 inline-flex h-11 items-center justify-center rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-violet-50"
                >
                  Browse Markets
                </Link>
              </div>
            ) : (
              <section className="space-y-4">
                {groupedPositions.map((group) => (
                  <div key={group.marketId} className="rounded-[28px] border border-white/5 bg-[#121214]/60 p-5 sm:p-6">
                    <button
                      type="button"
                      onClick={() => setExpandedMarketGroup((current) => (
                        current === group.marketId ? null : group.marketId
                      ))}
                      className="w-full cursor-pointer text-left"
                      aria-expanded={expandedMarketGroup === group.marketId}
                    >
                      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-violet-500/15 bg-violet-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-violet-100/70">
                              {marketCategory(group)}
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-white/45">
                              {group.market ? marketStatusLabel(group.market) : "Saved"}
                            </span>
                            {retryableTallyPositionsForGroup(group).length > 0 || pendingTallyPositionsForGroup(group).length > 0 || claimablePositionsForGroup(group).length > 0 ? (
                              <span className="inline-flex items-center gap-1 rounded-full border border-red-500/25 bg-red-500/12 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-red-200">
                                <AlertCircle className="h-3.5 w-3.5" />
                                Needs Action
                              </span>
                            ) : null}
                          </div>
                          <h2 className="mt-4 max-w-3xl text-lg sm:text-xl font-black leading-tight text-white">
                            {marketQuestion(group)}
                          </h2>
                        </div>

                        <div className="flex items-center gap-3 sm:gap-5">
                          <div className="text-left sm:text-right">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Exposure</p>
                            <p className="mt-2 text-lg font-black text-white">{formatUsdc(group.totalCommitted)}</p>
                          </div>
                          <div className="text-left sm:text-right">
                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Claimable</p>
                            <p className="mt-2 text-lg font-black text-white">{group.market?.resolved ? formatUsdc(group.totalClaimable) : "Pending"}</p>
                          </div>
                          <motion.div
                            animate={{ rotate: expandedMarketGroup === group.marketId ? 180 : 0 }}
                            transition={{ duration: 0.22, ease: "easeOut" }}
                            className="flex h-10 w-10 items-center justify-center rounded-full border border-violet-500/15 bg-violet-500/10 text-violet-200/70"
                          >
                            <ChevronDown className="h-4 w-4" />
                          </motion.div>
                        </div>
                      </div>
                    </button>

                    <AnimatePresence initial={false}>
                      {expandedMarketGroup === group.marketId ? (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.26, ease: "easeOut" }}
                          className="overflow-hidden"
                        >
                          <div className="mt-6 space-y-4 border-t border-white/6 pt-5">
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                              <div className="flex flex-wrap items-center gap-5 text-sm text-white/55">
                                <div>
                                  <span className="text-white/30">YES</span>
                                  <span className="ml-2 font-semibold text-white">{formatUsdc(group.yesCommitted)}</span>
                                </div>
                                <div>
                                  <span className="text-white/30">NO</span>
                                  <span className="ml-2 font-semibold text-white">{formatUsdc(group.noCommitted)}</span>
                                </div>
                                <div>
                                  <span className="text-white/30">Commitments</span>
                                  <span className="ml-2 font-semibold text-white">{group.positions.length}</span>
                                </div>
                              </div>

                              <div className="flex flex-wrap items-center gap-2">
                                {pendingTallyPositionsForGroup(group).length > 0 || retryableTallyPositionsForGroup(group).length > 0 ? (
                                  <button
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      openBatchTallyReview(group);
                                    }}
                                    disabled={busyAction === `tally:${group.marketId}`}
                                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-white/10 bg-white px-4 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-white/90 disabled:opacity-60"
                                  >
                                    {busyAction === `tally:${group.marketId}` ? "Tallying..." : `Tally ${pendingTallyPositionsForGroup(group).length + retryableTallyPositionsForGroup(group).length}`}
                                  </button>
                                ) : null}
                                {claimablePositionsForGroup(group).length > 0 ? (
                                  <button
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      openBatchClaimReview(group);
                                    }}
                                    disabled={busyAction === `claim:${group.marketId}`}
                                    className="inline-flex h-10 shrink-0 items-center justify-center rounded-xl border border-emerald-500/15 bg-emerald-500/10 px-4 text-[11px] font-black uppercase tracking-[0.18em] text-emerald-50 transition-all hover:bg-emerald-500/15 disabled:opacity-60"
                                  >
                                    {busyAction === `claim:${group.marketId}` ? "Claiming..." : `Claim ${claimablePositionsForGroup(group).length}`}
                                  </button>
                                ) : null}
                                <Link
                                  href={`/dashboard?market=${group.marketId}`}
                                  className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-violet-500/15 bg-violet-500/10 px-4 text-[11px] font-black uppercase tracking-[0.18em] text-violet-50 transition-all hover:bg-violet-500/15"
                                >
                                  Open Market
                                  <MoveRight className="h-4 w-4" />
                                </Link>
                              </div>
                            </div>

                            <div className="rounded-2xl border border-white/6 bg-black/20">
                              {group.positions.map((position, index) => {
                                const amount = BigInt(position.amountInStroops);
                                const payout = expectedPayoutForPosition(position, group.market);

                                return (
                                  <div
                                    key={position.commitment}
                                    className={`px-4 py-4 sm:px-5 ${index < group.positions.length - 1 ? "border-b border-white/6" : ""}`}
                                  >
                                    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                      <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span className="rounded-full border border-violet-500/15 bg-violet-500/10 px-2.5 py-0.5 text-[10px] font-black uppercase tracking-[0.2em] text-violet-100/70">
                                            {position.side}
                                          </span>
                                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">
                                            Commit #{index + 1}
                                          </span>
                                          <span className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">
                                            {positionStatusLabel(position, group.market)}
                                          </span>
                                        </div>
                                        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                                          <div>
                                            <span className="text-white/30">Amount</span>
                                            <span className="ml-2 font-semibold text-white">{formatUsdc(amount)}</span>
                                          </div>
                                          <div>
                                            <span className="text-white/30">Expected Payout</span>
                                            <span className="ml-2 font-semibold text-white">{group.market?.resolved ? (payout !== null ? formatUsdc(payout) : "Not eligible") : "Pending"}</span>
                                          </div>
                                        </div>
                                      </div>

                                      {!group.market?.resolved && ["tally_submitted", "queued_for_auto_finalization", "finalizing"].includes(position.tallyStatus ?? "") && !position.claimTxHash ? (
                                        <div className="inline-flex items-center gap-2 rounded-full border border-emerald-500/15 bg-emerald-500/10 px-3 py-1">
                                          <ShieldCheck className="h-3.5 w-3.5 text-emerald-300" />
                                          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-emerald-200">Queued for Auto-Finalization</span>
                                        </div>
                                      ) : position.tallyStatus === "share_upload_failed" ? (
                                        <div className="inline-flex items-center gap-2 rounded-full border border-amber-500/15 bg-amber-500/10 px-3 py-1">
                                          <ShieldCheck className="h-3.5 w-3.5 text-amber-300" />
                                          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-amber-200">Share Upload Failed</span>
                                        </div>
                                      ) : position.claimTxHash ? (
                                        <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1">
                                          <Trophy className="h-3.5 w-3.5 text-white/55" />
                                          <span className="text-[10px] font-black uppercase tracking-[0.18em] text-white/70">Claimed</span>
                                        </div>
                                      ) : null}
                                    </div>
                                    <div className="mt-4 overflow-hidden rounded-2xl border border-white/6 bg-white/[0.02]">
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          setExpandedPositionDetails((current) => (
                                            current === position.commitment ? null : position.commitment
                                          ));
                                        }}
                                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-[10px] font-black uppercase tracking-[0.18em] text-white/55 transition-colors hover:bg-white/[0.03] hover:text-white/75"
                                        aria-expanded={expandedPositionDetails === position.commitment}
                                      >
                                        <span>Advanced details</span>
                                        <motion.span
                                          animate={{ rotate: expandedPositionDetails === position.commitment ? 180 : 0 }}
                                          transition={{ duration: 0.2, ease: "easeOut" }}
                                          className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-white/8 bg-black/20"
                                        >
                                          <ChevronDown className="h-3.5 w-3.5" />
                                        </motion.span>
                                      </button>
                                      <AnimatePresence initial={false}>
                                        {expandedPositionDetails === position.commitment ? (
                                          <motion.div
                                            initial={{ height: 0, opacity: 0 }}
                                            animate={{ height: "auto", opacity: 1 }}
                                            exit={{ height: 0, opacity: 0 }}
                                            transition={{ duration: 0.24, ease: "easeOut" }}
                                            className="overflow-hidden border-t border-white/6"
                                          >
                                            <div className="grid gap-3 px-4 py-4 text-[11px]">
                                              <div>
                                                <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Commitment Hash</span>
                                                <p className="font-mono break-all text-white/60">{position.commitment}</p>
                                              </div>
                                              <div>
                                                <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Nullifier</span>
                                                <p className="font-mono break-all text-white/60">{position.nullifier}</p>
                                              </div>
                                              <div>
                                                <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Salt</span>
                                                <p className="font-mono break-all text-white/60">{position.salt}</p>
                                              </div>
                                              {position.commitTxHash ? (
                                                <div>
                                                  <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Commit Tx Hash</span>
                                                  <p className="font-mono break-all text-white/60">{position.commitTxHash}</p>
                                                </div>
                                              ) : null}
                                              {position.tallyTxHash ? (
                                                <div>
                                                  <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Tally Tx Hash</span>
                                                  <p className="font-mono break-all text-white/60">{position.tallyTxHash}</p>
                                                </div>
                                              ) : null}
                                              {position.claimTxHash ? (
                                                <div>
                                                  <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Claim Tx Hash</span>
                                                  <p className="font-mono break-all text-white/60">{position.claimTxHash}</p>
                                                </div>
                                              ) : null}
                                              {position.shareCommitmentRoot ? (
                                                <div>
                                                  <span className="mb-1 block text-[9px] font-black uppercase tracking-[0.2em] text-white/25">Share Commitment Root</span>
                                                  <p className="font-mono break-all text-white/60">{position.shareCommitmentRoot}</p>
                                                </div>
                                              ) : null}
                                            </div>
                                          </motion.div>
                                        ) : null}
                                      </AnimatePresence>
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                ))}
              </section>
            )}
          </div>
        )}
      </main>

      <AnimatePresence>
        {isActionReviewOpen && preparedAction ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-4 backdrop-blur-md">
            <motion.div
              initial={{ opacity: 0, y: 12, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.98 }}
              transition={{ duration: 0.22, ease: "easeOut" }}
              className="relative max-h-[88vh] w-full max-w-[760px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#0b0b0e] shadow-[0_32px_120px_rgba(0,0,0,0.55)]"
            >
              <button
                type="button"
                onClick={() => {
                  const actionBusy = preparedAction.kind === "tally"
                    ? busyAction === `tally:${preparedAction.group.marketId}`
                    : busyAction === `claim:${preparedAction.group.marketId}`;
                  if (actionBusy) {
                    return;
                  }
                  resetActionReview();
                }}
                className="absolute right-5 top-5 z-10 rounded-full border border-white/10 bg-white/[0.03] p-2 text-white/50 transition-colors hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>

              <div className="space-y-4 p-4 sm:p-5">
                {actionTxHashes.length > 0 ? (
                  <div className="rounded-[24px] border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.14),rgba(255,255,255,0.02))] p-6 sm:p-7">
                    <div className="flex flex-col items-center text-center">
                      <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/12 shadow-[0_0_40px_rgba(16,185,129,0.16)]">
                        <Check className="h-8 w-8 text-emerald-300" />
                      </div>
                      <p className="mt-5 text-[10px] font-black uppercase tracking-[0.22em] text-emerald-300/70">Transaction Confirmed</p>
                      <h4 className="mt-2 text-xl font-black tracking-tight text-white">
                        {preparedAction.kind === "tally" ? "Tally approved successfully" : "Claim approved successfully"}
                      </h4>
                      <p className="mt-2 max-w-md text-sm text-white/50">
                        {preparedAction.kind === "tally"
                          ? "Your hidden positions have been submitted into the private tally flow."
                          : "Your winning commitment has been claimed onchain and your receipt is ready."}
                      </p>

                      <div className="mt-6 w-full max-w-2xl rounded-2xl border border-white/8 bg-black/20 p-4 text-left">
                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">
                          {actionTxHashes.length === 1 ? "Transaction Hash" : "Transaction Hashes"}
                        </p>
                        <div className="mt-2 space-y-2">
                          {actionTxHashes.map((hash) => (
                            <p key={hash} className="text-sm font-mono text-white break-all">{hash}</p>
                          ))}
                        </div>
                      </div>

                      <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                        {actionTxHashes[0] ? (
                          <a
                            href={explorerTransactionUrl(actionTxHashes[0])}
                            target="_blank"
                            rel="noreferrer"
                            className="flex h-11 items-center justify-center gap-2 rounded-xl border border-emerald-400/20 bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-emerald-50 active:scale-[0.99]"
                          >
                            View Explorer
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null}
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            resetActionReview();
                          }}
                          className="flex h-11 items-center justify-center rounded-xl border border-emerald-400/30 bg-emerald-500/10 px-5 text-[11px] font-black uppercase tracking-[0.18em] text-emerald-200 transition-all hover:bg-emerald-500/20 active:scale-[0.99]"
                        >
                          Done
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="mb-2 text-[10px] font-black uppercase tracking-[0.22em] text-white/40">Review & Approve</p>
                      <h3 className="text-lg font-black tracking-tight text-white">
                        {preparedAction.kind === "tally"
                          ? `Approve ${preparedAction.positions.length === 1 ? "1 tally" : `${preparedAction.positions.length} tallies`}`
                          : `Approve ${preparedAction.positions.length === 1 ? "1 claim" : `${preparedAction.positions.length} claims`}`}
                      </h3>
                      <p className="mt-1 text-sm text-white/50">
                        {preparedAction.kind === "tally"
                          ? "Review the tally batch before signing on Stellar."
                          : "Review the claim batch before signing on Stellar."}
                      </p>
                    </div>

                    <div className="rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-4">
                      <div className="grid grid-cols-2 gap-2.5">
                        <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Market</p>
                          <p className="mt-1.5 text-sm font-semibold text-white break-words">{marketQuestion(preparedAction.group)}</p>
                        </div>
                        <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">
                            {preparedAction.kind === "tally" ? "Workflow" : "Payout"}
                          </p>
                          <p className="mt-1.5 text-sm font-semibold text-white">
                            {preparedAction.kind === "tally"
                              ? `${preparedAction.newCount} new / ${preparedAction.retryCount} retry`
                              : formatUsdc(preparedAction.totalPayout)}
                          </p>
                        </div>
                      </div>
                    </div>

                    {actionReviewError ? (
                      <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                        <p className="text-[11px] text-red-300">{actionReviewError}</p>
                      </div>
                    ) : null}

                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        onClick={() => resetActionReview()}
                        disabled={busyAction === `tally:${preparedAction.group.marketId}` || busyAction === `claim:${preparedAction.group.marketId}`}
                        className="h-10 rounded-xl border border-white/10 px-5 text-[11px] font-black uppercase tracking-[0.18em] text-white/70 transition-colors hover:bg-white/[0.05] disabled:opacity-60"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleApproveActionReview()}
                        disabled={busyAction === `tally:${preparedAction.group.marketId}` || busyAction === `claim:${preparedAction.group.marketId}`}
                        className="h-10 rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-violet-50 disabled:opacity-60"
                      >
                        {busyAction === `tally:${preparedAction.group.marketId}` || busyAction === `claim:${preparedAction.group.marketId}`
                          ? "Submitting..."
                          : preparedAction.kind === "tally"
                            ? "Approve Tally"
                            : "Approve Claim"}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </motion.div>
          </div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
