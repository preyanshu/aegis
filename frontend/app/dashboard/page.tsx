"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Navbar } from "@/components/landing/Navbar";
import { MarketStatus } from "@/components/dashboard/MarketStatus";
import { MarketCard } from "@/components/dashboard/MarketCard";
import { MarketDetailView } from "@/components/dashboard/MarketDetailView";
import { CreateMarketModal } from "@/components/dashboard/CreateMarketModal";
import { buildDashboardState, mapMarketSummary } from "@/lib/blind-market";
import { loadMarketIds, loadMarketView, type MarketView } from "@/lib/stellar";
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Plus, Search, ChevronDown, Filter, ArrowDownUp, X } from "lucide-react";

type StellarMarketRow = {
  marketId: string;
  view: MarketView;
  creationIndex: number;
};

type SortBy = "newest" | "oldest" | "largest" | "smallest" | "status" | "ends_soon" | "ends_late" | "min_bet_high" | "min_bet_low" | "max_bet_high" | "max_bet_low";
type FilterStatus = "all" | "live" | "waiting" | "resolved";

export default function DashboardPage() {
  const searchParams = useSearchParams();
  const [now, setNow] = useState(Date.now());
  const [rows, setRows] = useState<StellarMarketRow[]>([]);
  const [selectedMarketId, setSelectedMarketId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [sortBy, setSortBy] = useState<SortBy>("newest");
  const [filterStatus, setFilterStatus] = useState<FilterStatus>("all");
  const [isInitialLoading, setIsInitialLoading] = useState(true);
  const [isCreateOpen, setIsCreateOpen] = useState(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const fetchMarkets = async () => {
    const marketIds = await loadMarketIds();
    const settled = await Promise.allSettled(
      marketIds.map(async (marketId, creationIndex) => ({
        marketId,
        creationIndex,
        view: await loadMarketView(marketId),
      })),
    );

    const nextRows = settled.flatMap((result) => {
      if (result.status === "fulfilled") {
        return [{
          marketId: result.value.marketId,
          view: result.value.view,
          creationIndex: result.value.creationIndex,
        }];
      }

      console.warn("Skipping unreadable market during dashboard refresh:", result.reason);
      return [];
    });

    setRows(nextRows);
  };

  useEffect(() => {
    let mounted = true;

    const run = async () => {
      try {
        const marketIds = await loadMarketIds();
        const settled = await Promise.allSettled(
          marketIds.map(async (marketId, creationIndex) => ({
            marketId,
            creationIndex,
            view: await loadMarketView(marketId),
          })),
        );
        if (!mounted) {
          return;
        }

        const nextRows = settled.flatMap((result) => {
          if (result.status === "fulfilled") {
            return [{
              marketId: result.value.marketId,
              view: result.value.view,
              creationIndex: result.value.creationIndex,
            }];
          }

          console.warn("Skipping unreadable market during dashboard boot:", result.reason);
          return [];
        });

        setRows(nextRows);
      } catch (error) {
        console.error("Failed to fetch dashboard data:", error);
      } finally {
        if (mounted) {
          setIsInitialLoading(false);
        }
      }
    };

    void run();
    const interval = setInterval(() => {
      void run();
    }, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const markets = useMemo(() => rows.map(mapMarketSummary), [rows]);
  const dashboardState = useMemo(() => buildDashboardState(markets), [markets]);
  const selectedMarket = markets.find((market) => market.marketId === selectedMarketId) ?? null;

  useEffect(() => {
    const linkedMarketId = searchParams.get("market");
    if (linkedMarketId) {
      setSelectedMarketId(linkedMarketId);
    }
  }, [searchParams]);

  const filteredMarkets = useMemo(() => {
    return markets
      .filter((market) => (
        market.question.toLowerCase().includes(searchQuery.toLowerCase())
        || market.category.toLowerCase().includes(searchQuery.toLowerCase())
        || market.oracleLogic.toLowerCase().includes(searchQuery.toLowerCase())
      ))
      .filter((market) => {
        if (filterStatus === "all") return true;
        if (filterStatus === "resolved") return market.resolved;
        
        const diff = market.endTimestamp - now;
        if (filterStatus === "waiting") return !market.resolved && diff <= 0;
        if (filterStatus === "live") return !market.resolved && diff > 0;
        return true;
      })
      .sort((left, right) => {
        if (sortBy === "largest") return Number(right.totalLockedCollateral - left.totalLockedCollateral);
        if (sortBy === "smallest") return Number(left.totalLockedCollateral - right.totalLockedCollateral);
        if (sortBy === "ends_soon") return left.endTimestamp - right.endTimestamp;
        if (sortBy === "ends_late") return right.endTimestamp - left.endTimestamp;
        if (sortBy === "min_bet_high") return Number(right.minBet - left.minBet);
        if (sortBy === "min_bet_low") return Number(left.minBet - right.minBet);
        if (sortBy === "max_bet_high") return Number(right.maxBet - left.maxBet);
        if (sortBy === "max_bet_low") return Number(left.maxBet - right.maxBet);
        if (sortBy === "oldest") return left.creationIndex - right.creationIndex;
        
        if (sortBy === "status") {
          if (left.resolved === right.resolved) return right.creationIndex - left.creationIndex;
          return left.resolved ? 1 : -1;
        }
        return right.creationIndex - left.creationIndex;
      });
  }, [markets, searchQuery, sortBy, filterStatus, now]);

  return (
    <div className="min-h-screen bg-[#050507] text-white selection:bg-white selection:text-black">
      <Navbar transparent={false} />
      <CreateMarketModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onCreated={fetchMarkets}
      />

      <main className="px-3 sm:px-6 md:px-8 lg:px-12 py-24 sm:py-28 md:py-32 relative">
        <AnimatePresence mode="wait">
          {isInitialLoading ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex min-h-[60vh] items-center justify-center"
            >
              <div className="flex flex-col items-center gap-4">
                <div className="relative">
                  <div className="absolute inset-0 bg-violet-500/20 blur-2xl rounded-full" />
                  <Loader2 className="w-10 h-10 text-violet-400 animate-spin relative z-10" strokeWidth={1.5} />
                </div>
                <span className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-400/70 ml-2">
                  Synchronizing
                </span>
              </div>
            </motion.div>
          ) : selectedMarket ? (
            <MarketDetailView
              key={selectedMarket.marketId}
              market={selectedMarket}
              onBack={() => setSelectedMarketId(null)}
              onMarketRefresh={fetchMarkets}
            />
          ) : (
            <motion.div
              key="grid"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            >
              <header className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-8 md:mb-12">
                <div>
                  <h1 className="text-xl sm:text-2xl md:text-3xl font-black tracking-tight text-white mb-1 uppercase leading-none">
                    Markets
                  </h1>
                  <p className="text-white/40 font-medium text-[10px] sm:text-sm uppercase tracking-widest">
                    Private prediction markets on Stellar
                  </p>
                </div>
                <button
                  onClick={() => setIsCreateOpen(true)}
                  className="h-12 px-5 rounded-xl border border-violet-400/20 bg-violet-500/14 text-violet-50 font-bold text-xs uppercase tracking-[0.2em] hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99] transition-all flex items-center justify-center gap-2.5 shadow-xl shadow-violet-950/30"
                >
                  <Plus className="w-4 h-4" />
                  Create Market
                </button>
              </header>

              <div className="flex flex-col md:flex-row md:items-center gap-4 mb-8">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                    <Search className="h-4 w-4 text-white/20" />
                  </div>
                  <input
                    type="text"
                    placeholder="Search markets, categories, or oracle logic..."
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    className="w-full bg-[#121214]/60 backdrop-blur-xl border border-white/5 rounded-xl py-4 pl-12 pr-4 text-sm text-white focus:outline-none focus:border-white/10 transition-all placeholder:text-white/20"
                  />
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <div className="relative">
                    <select
                      value={filterStatus}
                      onChange={(e) => setFilterStatus(e.target.value as FilterStatus)}
                      className="appearance-none bg-[#121214]/60 backdrop-blur-xl border border-white/5 rounded-xl py-3 pl-10 pr-10 text-[11px] font-black text-white uppercase tracking-widest focus:outline-none focus:border-white/10 transition-all cursor-pointer h-12"
                    >
                      <option value="all">All Status</option>
                      <option value="live">Live</option>
                      <option value="waiting">Waiting</option>
                      <option value="resolved">Resolved</option>
                    </select>
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                       <Filter className="h-4 w-4 text-white/40" />
                    </div>
                    <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none">
                       <ChevronDown className="h-4 w-4 text-white/40" />
                    </div>
                  </div>

                  <div className="relative">
                    <select
                      value={sortBy}
                      onChange={(e) => setSortBy(e.target.value as SortBy)}
                      className="appearance-none bg-[#121214]/60 backdrop-blur-xl border border-white/5 rounded-xl py-3 pl-10 pr-10 text-[11px] font-black text-white uppercase tracking-widest focus:outline-none focus:border-white/10 transition-all cursor-pointer h-12"
                    >
                      <option value="newest">Newest First</option>
                      <option value="oldest">Oldest First</option>
                      <option value="largest">Largest Vol</option>
                      <option value="smallest">Smallest Vol</option>
                      <option value="ends_soon">Ends Soonest</option>
                      <option value="ends_late">Ends Latest</option>
                      <option value="min_bet_high">Min Bet (High-Low)</option>
                      <option value="min_bet_low">Min Bet (Low-High)</option>
                      <option value="max_bet_high">Max Bet (High-Low)</option>
                      <option value="max_bet_low">Max Bet (Low-High)</option>
                      <option value="status">Status</option>
                    </select>
                    <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                       <ArrowDownUp className="h-4 w-4 text-white/40" />
                    </div>
                    <div className="absolute inset-y-0 right-4 flex items-center pointer-events-none">
                       <ChevronDown className="h-4 w-4 text-white/40" />
                    </div>
                  </div>

                  <AnimatePresence>
                    {(searchQuery || filterStatus !== "all" || sortBy !== "newest") && (
                      <motion.button
                        initial={{ opacity: 0, scale: 0.9, width: 0, marginLeft: 0 }}
                        animate={{ opacity: 1, scale: 1, width: 48, marginLeft: 4 }}
                        exit={{ opacity: 0, scale: 0.9, width: 0, marginLeft: 0 }}
                        onClick={() => {
                          setSearchQuery("");
                          setFilterStatus("all");
                          setSortBy("newest");
                        }}
                        className="flex items-center justify-center h-12 overflow-hidden rounded-xl border border-rose-500/10 bg-rose-500/5 text-rose-400 hover:bg-rose-500/10 hover:border-rose-500/20 transition-all shadow-sm shrink-0"
                        title="Clear filters"
                      >
                        <X className="w-5 h-5 shrink-0" />
                      </motion.button>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              <MarketStatus state={dashboardState} now={now} />

              {filteredMarkets.length === 0 ? (
                <div className="mt-10 p-8 rounded-3xl border border-white/5 bg-white/[0.02] text-center">
                  <p className="text-xl font-black text-white uppercase tracking-tight">No markets found</p>
                  <p className="text-white/40 mt-3 text-sm">
                    No matching private markets are live right now.
                  </p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-8 mt-8">
                  {filteredMarkets.map((market) => (
                    <MarketCard key={market.marketId} market={market} onClick={(id) => setSelectedMarketId(id)} />
                  ))}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}
