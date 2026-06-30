"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { formatUsdc, mapMarketSummary, marketStatusLabel, payoutForPosition, positionStatusLabel } from "@/lib/blind-market";
import type { BlindMarketSummary, BlindPositionRecord } from "@/lib/types";
import { loadMarketIds, loadMarketView, type MarketView } from "@/lib/stellar";
import { usePrivy } from "@privy-io/react-auth";
import { ChevronDown, FolderLock, Loader2, MoveRight, ShieldCheck, Trophy, Wallet } from "lucide-react";
import { loadReputationSnapshot } from "@/lib/reputation-vault";

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

function marketQuestion(group: PositionGroup) {
  return group.market?.question ?? group.positions[0]?.marketQuestion ?? "Unknown market";
}

function marketCategory(group: PositionGroup) {
  return group.market?.category ?? group.positions[0]?.category ?? "private";
}

export default function PositionsPage() {
  const { user } = usePrivy();
  const [rows, setRows] = useState<StellarMarketRow[]>([]);
  const [savedPositions, setSavedPositions] = useState<BlindPositionRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);

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
          if (!market || position.claimedAt) {
            return sum;
          }
          return sum + payoutForPosition(market, BigInt(position.amountInStroops));
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
                <h1 className="text-xl sm:text-2xl md:text-3xl font-black tracking-tight text-white mb-1 leading-none">
                  My Positions
                </h1>
                <p className="text-white/45 text-sm sm:text-base">
                  Track your private commitments across every market from one clean view.
                </p>
              </div>
            </header>

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
                  <details key={group.marketId} className="group rounded-[28px] border border-white/5 bg-[#121214]/60 p-5 sm:p-6">
                    <summary className="list-none cursor-pointer">
                      <div className="flex flex-col gap-5 lg:flex-row lg:items-center lg:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="rounded-full border border-violet-500/15 bg-violet-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-violet-100/70">
                              {marketCategory(group)}
                            </span>
                            <span className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-white/45">
                              {group.market ? marketStatusLabel(group.market) : "Saved"}
                            </span>
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
                          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-violet-500/15 bg-violet-500/10 text-violet-200/70 transition-transform group-open:rotate-180">
                            <ChevronDown className="h-4 w-4" />
                          </div>
                        </div>
                      </div>
                    </summary>

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

                        <Link
                          href={`/dashboard?market=${group.marketId}`}
                          className="inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl border border-violet-500/15 bg-violet-500/10 px-4 text-[11px] font-black uppercase tracking-[0.18em] text-violet-50 transition-all hover:bg-violet-500/15"
                        >
                          Open Market
                          <MoveRight className="h-4 w-4" />
                        </Link>
                      </div>

                      <div className="rounded-2xl border border-white/6 bg-black/20">
                        {group.positions.map((position, index) => {
                          const amount = BigInt(position.amountInStroops);
                          const payout = group.market ? payoutForPosition(group.market, amount) : 0n;

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
                                      <span className="ml-2 font-semibold text-white">{group.market?.resolved ? formatUsdc(payout) : "Pending"}</span>
                                    </div>
                                  </div>
                                </div>

                                {["tally_submitted", "queued_for_auto_finalization", "finalizing"].includes(position.tallyStatus ?? "") && !position.claimTxHash ? (
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
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </details>
                ))}
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
