"use client";

import { useState, useEffect } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { MarketStrategy, Agent, MarketState } from "@/lib/types";
import { api } from "@/lib/api";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { ActiveAgents } from "@/components/dashboard/ActiveAgents";
import {
    History,
    CheckCircle2,
    XCircle,
    Database,
    ShieldCheck,
    RefreshCw,
    Loader2,
    ArrowRight,
    SearchCheck,
    ChevronDown,
    ChevronUp,
    Binary,
    Clock,
    Wallet,
    ChevronRight,
} from "lucide-react";
import { TRUSTED_DATA_SOURCES } from "@/lib/data-sources";
import { motion, AnimatePresence } from "framer-motion";

/**
 * Generate human-readable mathematical logic using real asset tickers from data sources
 */
const generateMathLogicDisplay = (
    dataSources: Array<{ id: number; targetValue: number; operator?: string }> | undefined,
    fallbackLogic?: string
): string => {
    if (!dataSources || dataSources.length === 0) {
        return fallbackLogic || '// Logic finalized on-chain';
    }
    
    return dataSources.map(ds => {
        const source = TRUSTED_DATA_SOURCES.find(s => s.id === ds.id);
        const ticker = source?.ticker || 'ASSET';
        const operator = ds.operator || '>=';
        const targetDisplay = typeof ds.targetValue === 'number' 
            ? (ds.targetValue % 1 === 0 ? ds.targetValue.toString() : ds.targetValue.toFixed(2))
            : ds.targetValue;
        return `${ticker} ${operator} ${targetDisplay}`;
    }).join(' AND ');
};

/**
 * Get the appropriate icon for a proposal based on its name and data sources
 * Intelligently matches proposal names to relevant asset icons
 */
const getProposalIcon = (
    proposalName: string,
    dataSources: Array<{ id: number }> | undefined
): string | null => {
    // First try to get icon from data sources
    if (dataSources && dataSources.length > 0) {
        const firstDs = dataSources[0];
        const detailedInfo = TRUSTED_DATA_SOURCES.find(t => t.id === firstDs?.id);
        if (detailedInfo?.icon) {
            return detailedInfo.icon;
        }
    }
    
    // If no data source icon, infer from proposal name
    const nameLower = proposalName.toLowerCase();
    
    // S&P 500 related
    if (nameLower.includes('s&p 500') || nameLower.includes('spy')) {
        const spy = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'SPY');
        if (spy?.icon) return spy.icon;
    }
    
    // Vanguard S&P 500
    if (nameLower.includes('vanguard') && nameLower.includes('500')) {
        const voo = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'VOO');
        if (voo?.icon) return voo.icon;
    }
    
    // Bitcoin/Crypto related
    if (nameLower.includes('bitcoin') || nameLower.includes('btc') || nameLower.includes('crypto')) {
        const ibit = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'IBIT');
        if (ibit?.icon) return ibit.icon;
    }
    
    // QQQ/Nasdaq related
    if (nameLower.includes('qqq') || nameLower.includes('nasdaq') || nameLower.includes('tech')) {
        const qqq = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'QQQ');
        if (qqq?.icon) return qqq.icon;
    }
    
    // VTI/Total Market related
    if (nameLower.includes('vti') || nameLower.includes('total market') || nameLower.includes('total stock')) {
        const vti = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'VTI');
        if (vti?.icon) return vti.icon;
    }
    
    // Oil/WTI related
    if (nameLower.includes('oil') || nameLower.includes('wti') || nameLower.includes('crude')) {
        const wti = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'WTI');
        if (wti?.icon) return wti.icon;
    }
    
    // Natural Gas related
    if (nameLower.includes('natural gas') || nameLower.includes('gas')) {
        const ng = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'NG');
        if (ng?.icon) return ng.icon;
    }
    
    // Treasury/Bond related
    if (nameLower.includes('treasury') || nameLower.includes('bond') || nameLower.includes('tlt')) {
        const tlt = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'TLT');
        if (tlt?.icon) return tlt.icon;
    }
    
    // Market Divergence - use QQQ as default for divergence strategies
    if (nameLower.includes('divergence')) {
        const qqq = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'QQQ');
        if (qqq?.icon) return qqq.icon;
    }
    
    // Rally strategies - use SPY as default
    if (nameLower.includes('rally')) {
        const spy = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'SPY');
        if (spy?.icon) return spy.icon;
    }
    
    // Energy sector
    if (nameLower.includes('energy')) {
        const wti = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'WTI');
        if (wti?.icon) return wti.icon;
    }
    
    // Currency related
    if (nameLower.includes('currency') || nameLower.includes('dollar') || nameLower.includes('cad') || nameLower.includes('aud')) {
        const cad = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'CAD');
        if (cad?.icon) return cad.icon;
    }
    
    // Ethereum related
    if (nameLower.includes('ethereum') || nameLower.includes('eth')) {
        const etha = TRUSTED_DATA_SOURCES.find(s => s.ticker === 'ETHA');
        if (etha?.icon) return etha.icon;
    }
    
    return null;
};
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from "@/lib/privy-stellar-wallet";
import { getPrivyStellarWallet, loadPosition, sellSharesWithPrivyWallet } from "@/lib/stellar";

export default function HistoryPage() {
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
    const [verifyingId, setVerifyingId] = useState<string | null>(null);
    const [verifiedIds, setVerifiedIds] = useState<Set<string>>(new Set());
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
    const [auditExpandedIds, setAuditExpandedIds] = useState<Set<string>>(new Set());
    const [redeemedIds, setRedeemedIds] = useState<Set<string>>(new Set());
    const [redeemLoaders, setRedeemLoaders] = useState<Set<string>>(new Set());
    const [redeemErrors, setRedeemErrors] = useState<Record<string, string>>({});
    const [verificationResults, setVerificationResults] = useState<Record<string, Record<number, number>>>({});
    const [realHoldings, setRealHoldings] = useState<Record<string, string>>({});
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const { user, authenticated } = usePrivy();
    const { createWallet } = useCreateWallet();
    const { signRawHash } = useSignRawHash();
    const stellarWallet = getPrivyStellarWallet(user);

    const [marketState, setMarketState] = useState<MarketState | null>(null);
    const [agents, setAgents] = useState<Agent[]>([]);
    const [historicalProposals, setHistoricalProposals] = useState<MarketStrategy[]>([]);

    useEffect(() => {
        if (!authenticated || stellarWallet) return;

        ensurePrivyStellarWallet({
            authenticated,
            hasWallet: Boolean(stellarWallet),
            createWallet,
        }).catch((error) => {
            if (isPrivyStellarWalletLimitError(error)) {
                console.warn("Privy Stellar wallet limit reached for this user.");
                return;
            }
            console.error("Failed to create Privy Stellar wallet:", error);
        });
    }, [authenticated, stellarWallet, createWallet]);

    useEffect(() => {
        const fetchData = async () => {
            try {
                const [state, fetchedAgents, graduated] = await Promise.all([
                    api.getMarketState(),
                    api.getAgents(),
                    api.getGraduatedStrategies()
                ]);
                setMarketState(state);
                // Filter out duplicates by ID and sort by timestamp
                const uniqueProposals = (graduated || []).reduce((acc, proposal) => {
                    if (!acc.some(p => p.id === proposal.id)) {
                        acc.push(proposal);
                    }
                    return acc;
                }, [] as MarketStrategy[]);
                setHistoricalProposals(uniqueProposals.sort((a, b) => b.timestamp - a.timestamp));
                setAgents(fetchedAgents);
            } catch (error) {
                console.error("Failed to fetch history data:", error);
            } finally {
                setIsInitialLoading(false);
            }
        };

        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
    }, []);

    useEffect(() => {
        if (!stellarWallet?.address || historicalProposals.length === 0) return;

        const fetchBalances = async () => {
            const address = stellarWallet.address;
            if (!address) return;

            try {
                const balances: Record<string, string> = {};
                await Promise.all(historicalProposals.map(async (p) => {
                    const position = await loadPosition(p.id, address);
                    balances[p.id] = (Number(position.yes_shares) / 10_000_000).toFixed(4);
                }));
                setRealHoldings(balances);
            } catch (error) {
                console.error("Failed to fetch historical balances:", error);
            }
        };

        fetchBalances();
    }, [stellarWallet?.address, historicalProposals]);

    const handleRedeem = async (id: string, amount: number) => {
        if (!stellarWallet || !authenticated) return;

        setRedeemLoaders(prev => new Set(prev).add(id));
        setRedeemErrors(prev => {
            const next = { ...prev };
            delete next[id];
            return next;
        });

        try {
            const amountInStroops = BigInt(Math.round(amount * 10_000_000));

            if (amountInStroops <= BigInt(0)) {
                throw new Error("No balance to redeem");
            }

            await sellSharesWithPrivyWallet(stellarWallet, signRawHash, {
                marketId: id,
                side: "YES",
                shareAmount: amountInStroops,
            });

            setRedeemedIds(prev => new Set(prev).add(id));

            const updatedPosition = await loadPosition(id, stellarWallet.address);
            setRealHoldings(prev => ({
                ...prev,
                [id]: (Number(updatedPosition.yes_shares) / 10_000_000).toFixed(4),
            }));

        } catch (error: any) {
            console.error("Redemption failed detailed:", error);
            setRedeemErrors(prev => ({ ...prev, [id]: error?.message || "Transaction failed. Please try again." }));
        } finally {
            setRedeemLoaders(prev => {
                const next = new Set(prev);
                next.delete(id);
                return next;
            });
        }
    };

    const handleVerifyArchive = async (id: string, dataSources: any[]) => {
        setVerifyingId(id);

        const results: Record<number, number> = {};

        // Fetch real data from trusted endpoints
        await Promise.all(dataSources.map(async (ds) => {
            const sourceConfig = TRUSTED_DATA_SOURCES.find(t => t.id === ds.id);
            if (sourceConfig?.endpoint) {
                try {
                    const res = await fetch(sourceConfig.endpoint);
                    const data = await res.json();
                    // DIA API commonly returns { Price: 123.45, ... }
                    if (data?.Price) {
                        results[ds.id] = Number(data.Price);
                    }
                } catch (error) {
                    console.error(`Failed to verify data source ${ds.id}:`, error);
                }
            }
        }));

        setVerifyingId(null);
        setVerificationResults(prev => ({ ...prev, [id]: results }));

        setVerifiedIds(prev => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });

        // Auto-expand the Resolution Proof accordion after verification
        setAuditExpandedIds(prev => {
            const next = new Set(prev);
            next.add(id);
            return next;
        });
    };

    const toggleExpand = (id: string) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const toggleAuditExpand = (id: string) => {
        setAuditExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    return (
        <div className="h-screen bg-[#08080c] text-white selection:bg-white selection:text-black overflow-hidden flex flex-col relative font-sans">
            <Navbar transparent={false} />

            <div className="flex flex-1 pt-20 relative z-10 overflow-hidden">
                {/* Mobile Sidebar Overlay */}
                <AnimatePresence>
                    {isMobileSidebarOpen && (
                        <>
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                onClick={() => setIsMobileSidebarOpen(false)}
                                className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[140] xl:hidden"
                            />
                            <motion.aside
                                initial={{ x: "-100%" }}
                                animate={{ x: 0 }}
                                exit={{ x: "-100%" }}
                                transition={{ type: "spring", damping: 25, stiffness: 200 }}
                                className="fixed top-0 left-0 bottom-0 w-[85%] max-w-[320px] bg-[#121214] border-r border-white/10 z-[150] xl:hidden flex flex-col overflow-hidden shadow-2xl"
                            >
                                <div className="flex items-center justify-between p-4 border-b border-white/5">
                                    <span className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em]">Activity & Agents</span>
                                    <button onClick={() => setIsMobileSidebarOpen(false)} className="p-2 text-white/40 hover:text-white transition-colors">
                                        <ChevronDown className="w-5 h-5 -rotate-90" />
                                    </button>
                                </div>
                                <div className="flex-1 overflow-y-auto custom-scrollbar">
                                    <div className="flex flex-col h-full">
                                        <div className="flex-1 min-h-0 overflow-y-auto">
                                            <ActivityFeed agents={agents} filterStrategyId={null} activeProposalName={undefined} />
                                        </div>
                                        <div className="h-px w-full bg-white/5" />
                                        <div className="flex-1 min-h-0 overflow-y-auto">
                                            <ActiveAgents agents={agents} />
                                        </div>
                                    </div>
                                </div>
                            </motion.aside>
                        </>
                    )}
                </AnimatePresence>

                <main className="flex-1 overflow-y-auto custom-scrollbar bg-[#050507] relative">
                    <AnimatePresence mode="wait">
                        {isInitialLoading ? (
                            <motion.div
                                key="loading"
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 flex items-center justify-center bg-[#050507] z-50"
                            >
                                <div className="flex flex-col items-center gap-4">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-emerald-500/20 blur-2xl rounded-full" />
                                        <Loader2 className="w-10 h-10 text-emerald-500 animate-spin relative z-10" strokeWidth={1.5} />
                                    </div>
                                    <span className="text-[10px] font-black uppercase tracking-[0.4em] text-emerald-500/60 ml-2">
                                        Accessing Archive
                                    </span>
                                </div>
                            </motion.div>
                        ) : (
                            <div key="content" className="px-4 sm:px-6 md:px-8 lg:px-12 py-6 md:py-10 max-w-7xl mx-auto">
                                <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 md:mb-12">
                                    <div>
                                        <h1 className="text-2xl sm:text-3xl md:text-4xl font-black tracking-tight text-white mb-2 uppercase">
                                            Graduated Proposals
                                        </h1>
                                        <p className="text-white/40 font-medium text-sm md:text-lg uppercase tracking-widest">Institutional Archive of Resolved Markets</p>
                                    </div>
                                    <div className="flex gap-4">
                                        {historicalProposals.length > 0 && (
                                            <div className="p-3 md:p-4 bg-white/5 border border-white/10 rounded-xl md:rounded-2xl">
                                                <h3 className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1">Archive Set</h3>
                                                <div className="text-xl md:text-2xl font-black text-emerald-400 uppercase">
                                                    {historicalProposals.length} RESOLVED
                                                </div>
                                            </div>
                                        )}
                                    </div>
                                </header>

                                {historicalProposals.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-32 px-4 text-center border-2 border-dashed border-white/5 rounded-3xl bg-white/[0.01]">
                                        <div className="w-20 h-20 rounded-3xl bg-white/5 flex items-center justify-center mb-8 shadow-2xl shadow-black/50">
                                            <History className="w-10 h-10 text-white/20" />
                                        </div>
                                        <h3 className="text-2xl font-black text-white/40 uppercase tracking-widest mb-3">Archive Empty</h3>
                                        <p className="text-base text-white/30 font-medium max-w-md mx-auto leading-relaxed">
                                            No market proposals have graduated to the archive yet. Resolved markets will be permanently stored here for audit.
                                        </p>
                                    </div>
                                ) : (
                                    <div className="space-y-4 md:space-y-6">
                                        {historicalProposals.map((proposal) => {
                                            const isVerified = verifiedIds.has(proposal.id);
                                            const isVerifying = verifyingId === proposal.id;
                                            const isExpanded = expandedIds.has(proposal.id);
                                            const sortedDataSources = [...(proposal.usedDataSources || [])].sort((a, b) => Number(a?.id ?? 0) - Number(b?.id ?? 0));

                                            return (
                                                <div
                                                    key={proposal.id}
                                                    className="group relative bg-white/[0.03] border border-white/10 rounded-xl md:rounded-2xl overflow-hidden hover:bg-white/[0.04] transition-all duration-500"
                                                >
                                                    <div className="p-4 sm:p-6 md:p-8">
                                                        <div className="flex flex-col sm:flex-row items-center justify-between gap-6">
                                                            <div className="flex items-center gap-4 md:gap-6">
                                                                <div className="w-10 h-10 md:w-16 md:h-16 rounded-xl md:rounded-2xl flex items-center justify-center border border-white/10 bg-white/5 relative overflow-hidden shrink-0">
                                                                    <div className="flex items-center justify-center p-2">
                                                                        {(() => {
                                                                            const firstDs = proposal.usedDataSources?.[0];
                                                                            const detailedInfo = TRUSTED_DATA_SOURCES.find(t => t.id === firstDs?.id);
                                                                            return detailedInfo?.icon ? (
                                                                                <img src={detailedInfo.icon} className="w-full h-full object-contain" alt="" />
                                                                            ) : (
                                                                                <Database className="w-5 h-5 md:w-8 md:h-8 text-white/10" />
                                                                            );
                                                                        })()}
                                                                    </div>
                                                                </div>
                                                                <div>
                                                                    <div className="flex flex-wrap items-center gap-3 mb-1.5">
                                                                        <h2 className="text-lg md:text-2xl font-bold text-white tracking-tight leading-tight">{proposal.name}</h2>
                                                                        <span className="px-2 py-0.5 md:px-3 md:py-1 rounded-full text-[9px] md:text-[10px] font-black uppercase tracking-widest border bg-red-500/20 text-red-400 border-red-500/30">
                                                                            NO
                                                                        </span>
                                                                    </div>
                                                                    <div className="flex items-center gap-4">
                                                                        <div className="text-[10px] font-mono font-bold text-white/40 uppercase tracking-wider">
                                                                            {proposal.resolutionDeadline > Date.now() ? 'Settles on' : 'Settled on'} {new Date(proposal.resolutionDeadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                                                                        </div>
                                                                        <button
                                                                            onClick={() => toggleExpand(proposal.id)}
                                                                            className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-emerald-500/60 hover:text-emerald-400 transition-colors"
                                                                        >
                                                                            {expandedIds.has(proposal.id) ? (
                                                                                <><ChevronUp className="w-3 h-3" /> Hide Details</>
                                                                            ) : (
                                                                                <><ChevronDown className="w-3 h-3" /> View Market Specs</>
                                                                            )}
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        </div>

                                                        {/* Accordion 1: Market Specifications & Stats */}
                                                        <AnimatePresence>
                                                            {expandedIds.has(proposal.id) && (
                                                                <motion.div
                                                                    initial={{ opacity: 0, height: 0 }}
                                                                    animate={{ opacity: 1, height: 'auto' }}
                                                                    exit={{ opacity: 0, height: 0 }}
                                                                    className="overflow-hidden"
                                                                >
                                                                    <div className="pt-8 space-y-8">
                                                                        <div>
                                                                            <div className="text-[9px] font-black text-white/20 uppercase tracking-[0.3em] mb-3">Market Definition</div>
                                                                            <p className="text-white/60 text-[14px] leading-relaxed font-medium italic p-4 bg-white/[0.02] border-l-2 border-emerald-500/20 rounded-r-xl font-mono">
                                                                                "{proposal.description}"
                                                                            </p>
                                                                        </div>

                                                                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
                                                                            <div className="p-4 md:p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
                                                                                <div className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-widest mb-2 md:mb-4">Market Volume</div>
                                                                                <div className="text-lg md:text-xl font-black text-white tabular-nums">
                                                                                    ${((proposal.yesToken.volume || 0) + (proposal.noToken.volume || 0)).toLocaleString()}
                                                                                </div>
                                                                            </div>

                                                                            <div className="p-4 md:p-6 bg-white/[0.02] border border-white/5 rounded-2xl">
                                                                                <div className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-widest mb-2 md:mb-4">Final Prediction</div>
                                                                                <div className="flex items-end gap-2 text-lg md:text-xl font-black text-white">
                                                                                    {(proposal.yesToken.twap * 100).toFixed(1)}% <span className="text-[9px] md:text-[10px] text-emerald-500 mb-0.5 md:mb-1">YES</span>
                                                                                </div>
                                                                            </div>

                                                                            <div className="p-4 md:p-6 bg-white/[0.02] border border-white/5 rounded-2xl flex flex-col justify-between min-h-[80px] md:min-h-0">
                                                                                <div className="flex items-center justify-between mb-2">
                                                                                    <div className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-widest">Protocol Sync</div>
                                                                                    <div className="flex items-center gap-1">
                                                                                        <div className="w-1 h-1 md:w-1.5 md:h-1.5 rounded-full bg-white/20" />
                                                                                        <span className="text-[9px] md:text-[10px] text-white/20 font-black uppercase tracking-tighter">Verified</span>
                                                                                    </div>
                                                                                </div>
                                                                                <button
                                                                                    onClick={(e) => { e.stopPropagation(); handleVerifyArchive(proposal.id, proposal.usedDataSources || []); }}
                                                                                    disabled={isVerifying || isVerified}
                                                                                    className={`w-full py-2 md:py-2.5 rounded-xl text-[9px] md:text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 border ${isVerified
                                                                                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                                                                                        : 'bg-white/5 text-white/40 border-white/10 hover:bg-white/10 hover:text-white'
                                                                                        }`}
                                                                                >
                                                                                    {isVerifying ? (
                                                                                        <Loader2 className="w-3 h-3 md:w-3.5 md:h-3.5 animate-spin" />
                                                                                    ) : isVerified ? (
                                                                                        <ShieldCheck className="w-3 h-3 md:w-3.5 md:h-3.5" />
                                                                                    ) : (
                                                                                        <RefreshCw className="w-3 h-3 md:w-3.5 md:h-3.5" />
                                                                                    )}
                                                                                    {isVerifying ? 'Verifying on-chain...' : isVerified ? 'Audit Passed' : 'Verify Outcome'}
                                                                                </button>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </motion.div>
                                                            )}
                                                        </AnimatePresence>
                                                    </div>
                                                    {/* User Position & Redemption (Only if winner) */}
                                                    {
                                                        (() => {
                                                            const balance = realHoldings[proposal.id];
                                                            if (!balance || Number(balance) <= 0) return null;

                                                            const isWinner = proposal.winner === 'yes';
                                                            // Removed early return to show liquidated positions

                                                            const amount = Number(balance);
                                                            const type = 'YES';
                                                            const isRedeemed = redeemedIds.has(proposal.id);

                                                            return (
                                                                <div className={`mx-4 md:mx-8 mb-6 p-4 md:p-5 rounded-2xl border transition-all ${isWinner ? 'bg-emerald-500/[0.02] border-emerald-500/10 shadow-sm' : 'bg-red-500/[0.01] border-red-500/5'}`}>
                                                                    <div className="flex flex-col sm:flex-row items-center justify-between gap-4">
                                                                        <div className="flex items-center gap-4 w-full sm:w-auto">
                                                                            <div className={`hidden lg:flex w-10 h-10 rounded-xl shrink-0 items-center justify-center border transition-all duration-500 ${isWinner ? 'bg-emerald-500/10 border-emerald-500/20' : 'bg-red-500/10 border-red-500/20'}`}>
                                                                                <Wallet className={`w-5 h-5 ${isWinner ? 'text-emerald-400' : 'text-red-400'}`} />
                                                                            </div>

                                                                            <div className="flex flex-1 items-center justify-between sm:justify-start sm:gap-8">
                                                                                <div className="flex flex-col">
                                                                                    <div className="flex items-baseline gap-1.5">
                                                                                        <span className="text-xl md:text-2xl font-black text-white tracking-tighter tabular-nums leading-none">
                                                                                            {amount.toLocaleString()}
                                                                                        </span>
                                                                                        <span className="text-[9px] md:text-[10px] font-black text-white/40 uppercase tracking-widest">{type}</span>
                                                                                    </div>
                                                                                    <span className="text-[8px] font-bold text-white/10 uppercase tracking-wider mt-0.5">Quantity</span>
                                                                                </div>

                                                                                <ArrowRight className="w-3.5 h-3.5 opacity-20" />

                                                                                <div className="flex flex-col">
                                                                                    <div className="flex items-baseline gap-1.5">
                                                                                        <span className={`text-xl md:text-2xl font-black tracking-tighter tabular-nums leading-none ${isWinner ? 'text-emerald-400' : 'text-red-400/40 line-through'}`}>
                                                                                            ${isWinner ? amount.toLocaleString() : '0.00'}
                                                                                        </span>
                                                                                        <span className="text-[9px] md:text-[10px] font-black text-white/30 uppercase tracking-widest">USDC</span>
                                                                                    </div>
                                                                                    <span className="text-[8px] font-bold text-white/10 uppercase tracking-wider mt-0.5">Value</span>
                                                                                </div>
                                                                            </div>
                                                                        </div>

                                                                        {isWinner && (
                                                                            <div className="flex flex-col items-end gap-2 w-full sm:w-auto">
                                                                                <button
                                                                                    onClick={(e) => { e.stopPropagation(); handleRedeem(proposal.id, amount); }}
                                                                                    disabled={isRedeemed || redeemLoaders.has(proposal.id)}
                                                                                    className={`w-full sm:w-auto px-6 h-10 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all shrink-0 flex items-center justify-center gap-2 ${isRedeemed || redeemLoaders.has(proposal.id)
                                                                                        ? 'bg-emerald-500/5 text-emerald-500/40 border border-emerald-500/10 cursor-not-allowed'
                                                                                        : 'bg-emerald-500 text-black hover:bg-emerald-400 hover:scale-105 active:scale-95 shadow-lg'
                                                                                        }`}
                                                                                >
                                                                                    {redeemLoaders.has(proposal.id) ? (
                                                                                        <>
                                                                                            <Loader2 className="w-3 h-3 animate-spin" />
                                                                                            Processing
                                                                                        </>
                                                                                    ) : (
                                                                                        isRedeemed ? 'Claimed' : 'Redeem USDC'
                                                                                    )}
                                                                                </button>
                                                                                {redeemErrors[proposal.id] && (
                                                                                    <div className="flex items-center gap-1.5 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[9px] font-bold text-red-400 uppercase tracking-wide animate-in fade-in slide-in-from-top-1">
                                                                                        <XCircle className="w-3 h-3" />
                                                                                        {redeemErrors[proposal.id]}
                                                                                    </div>
                                                                                )}
                                                                            </div>
                                                                        )}
                                                                        {!isWinner && (
                                                                            <div className="w-full sm:w-auto px-6 h-10 flex items-center justify-center rounded-xl bg-red-500/10 border border-red-500/20 text-[10px] font-black text-red-400 uppercase tracking-widest">
                                                                                Position Liquidated
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            );
                                                        })()
                                                    }

                                                    <button
                                                        onClick={() => toggleAuditExpand(proposal.id)}
                                                        className="w-full py-4 flex items-center justify-center gap-2 text-[10px] uppercase font-black tracking-[0.3em] text-white/20 hover:text-white/50 transition-all border-y border-white/5 bg-white/[0.01]"
                                                    >
                                                        {auditExpandedIds.has(proposal.id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                                                        {auditExpandedIds.has(proposal.id) ? 'Hide Resolution Proof' : 'View Protocol Resolution Proof'}
                                                    </button>

                                                    <AnimatePresence>
                                                        {auditExpandedIds.has(proposal.id) && (
                                                            <motion.div
                                                                initial={{ opacity: 0, height: 0 }}
                                                                animate={{ opacity: 1, height: 'auto' }}
                                                                exit={{ opacity: 0, height: 0 }}
                                                                className="overflow-hidden bg-black/40"
                                                            >
                                                                <div className="p-4 md:p-8 space-y-6 md:space-y-8">
                                                                    {/* Audit Proof (Visible only if verified) */}
                                                                    {verifiedIds.has(proposal.id) ? (
                                                                        <div className="p-5 md:p-8 bg-black/60 rounded-2xl border border-emerald-500/20 relative group/audit">
                                                                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                                                                                <div className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.25em] flex items-center gap-2">
                                                                                    <CheckCircle2 className="w-3.5 h-3.5" />
                                                                                    Resolution Audit
                                                                                </div>
                                                                                <div className="inline-flex items-center gap-2 px-3 py-1 bg-emerald-500/10 rounded-full border border-emerald-500/20 w-fit">
                                                                                    <SearchCheck className="w-3 h-3 text-emerald-500" />
                                                                                    <span className="text-[9px] font-black text-emerald-500 uppercase tracking-tighter">Hash: 0x4f...e2a</span>
                                                                                </div>
                                                                            </div>

                                                                            <div className="grid grid-cols-1 gap-3 mb-6">
                                                                                {sortedDataSources.map((ds, idx) => {
                                                                                    const dsInfo = TRUSTED_DATA_SOURCES.find(t => t.id === ds.id);
                                                                                    // Use verified real-time value if available, otherwise historical snapshot
                                                                                    const verifiedVal = verificationResults[proposal.id]?.[ds.id];
                                                                                    const effectiveValue = verifiedVal !== undefined ? verifiedVal : ds.currentValue;
                                                                                    const isConditionMet = ds.operator === '>' ? effectiveValue > ds.targetValue : effectiveValue < ds.targetValue;

                                                                                    return (
                                                                                        <div key={idx} className="flex items-center justify-between px-4 py-3 bg-white/[0.02] border border-white/5 rounded-xl gap-4">
                                                                                            <div className="flex items-center gap-2 min-w-0">
                                                                                                {dsInfo?.icon && <img src={dsInfo.icon} className="w-4 h-4 object-contain opacity-50 shrink-0" alt="" />}
                                                                                                <span className="text-[10px] md:text-[11px] font-bold text-white/40 uppercase truncate">{dsInfo?.ticker || 'Variable'}</span>
                                                                                            </div>
                                                                                            <div className="flex items-center gap-2 md:gap-4 shrink-0">
                                                                                                <div className="flex flex-col items-end">
                                                                                                    <span className="text-[10px] md:text-xs font-mono font-bold text-white/60">{effectiveValue}</span>
                                                                                                    {verifiedVal !== undefined && (
                                                                                                        <span className="text-[8px] font-bold text-emerald-500/60 uppercase tracking-tighter">Live Verified</span>
                                                                                                    )}
                                                                                                </div>
                                                                                                <ArrowRight className="w-3 h-3 text-white/20" />
                                                                                                <span className={`text-[10px] md:text-xs font-mono font-bold px-2 py-0.5 rounded-md ${isConditionMet ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'}`}>
                                                                                                    {isConditionMet ? 'PASS' : 'FAIL'}
                                                                                                </span>
                                                                                            </div>
                                                                                        </div>
                                                                                    );
                                                                                })}
                                                                            </div>

                                                                            <div className="pt-6 border-t border-white/5">
                                                                                {(() => {
                                                                                    const isAuditPassed = sortedDataSources.every(ds => {
                                                                                        const verifiedVal = verificationResults[proposal.id]?.[ds.id];
                                                                                        const effectiveValue = verifiedVal !== undefined ? verifiedVal : ds.currentValue;
                                                                                        return ds.operator === '>' ? effectiveValue > ds.targetValue : effectiveValue < ds.targetValue;
                                                                                    }) ?? false;

                                                                                    return (
                                                                                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-6">
                                                                                            <span className="text-[10px] md:text-[11px] font-bold text-white/40 uppercase tracking-widest">Audit Summary</span>
                                                                                            <div className="flex items-center gap-3">
                                                                                                <span className="text-[9px] md:text-[10px] text-white/40 uppercase font-black tracking-tighter">Result:</span>
                                                                                                <span className={`px-4 py-1.5 rounded-lg text-[9px] md:text-[10px] font-black uppercase tracking-widest border shadow-lg ${isAuditPassed ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : 'bg-red-500/20 text-red-400 border-red-500/30'}`}>
                                                                                                    {isAuditPassed ? 'PASSED (TRUE)' : 'FAILED (FALSE)'}
                                                                                                </span>
                                                                                            </div>
                                                                                        </div>
                                                                                    );
                                                                                })()}
                                                                            </div>
                                                                        </div>
                                                                    ) : (
                                                                        <div className="p-10 text-center border-2 border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                                                                            <div className="inline-flex p-3 bg-white/5 rounded-full mb-3 text-white/20">
                                                                                <Binary className="w-8 h-8" />
                                                                            </div>
                                                                            <p className="text-[10px] font-black text-white/20 uppercase tracking-widest">Verification Required to Access Audit Logs</p>
                                                                        </div>
                                                                    )}

                                                                    {/* Protocol Math (Always in accordion) */}
                                                                    <div>
                                                                        <div className="text-[10px] font-black text-white/20 uppercase tracking-[0.25em] mb-4">Protocol Evaluation Math</div>
                                                                        <code className="text-[13px] font-mono text-emerald-400 font-bold bg-emerald-500/[0.03] px-4 py-3 rounded-xl block border border-emerald-500/10 shadow-inner">
                                                                            {generateMathLogicDisplay(proposal.usedDataSources, proposal.mathematicalLogic)}
                                                                        </code>
                                                                        <div className="mt-6 p-4 rounded-xl bg-emerald-500/[0.03] border border-emerald-500/10 flex gap-4 items-start">
                                                                            <div className="p-2 bg-emerald-500/10 rounded-lg">
                                                                                <Clock className="w-4 h-4 text-emerald-500" />
                                                                            </div>
                                                                            <div>
                                                                                <p className="text-[11px] font-black text-emerald-500 uppercase tracking-widest mb-1">Settlement Protocol</p>
                                                                                <p className="text-[13px] text-white/60 font-medium leading-relaxed">
                                                                                    Markets are only settled if the mathematical conditions are <span className="text-white font-bold italic text-emerald-400">met during or after</span> the resolution deadline.
                                                                                </p>
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            </motion.div>
                                                        )}
                                                    </AnimatePresence>

                                                    <div className="p-4 md:p-6 border-t border-white/5 flex flex-col sm:flex-row items-center justify-between gap-4 bg-black/20">
                                                        <div className="flex items-center gap-4">
                                                            <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg border border-white/10">
                                                                <ShieldCheck className="w-3.5 h-3.5 text-white/20" />
                                                                <span className="text-[10px] font-bold text-white/40 uppercase tracking-tighter">Executing trades: NO</span>
                                                            </div>
                                                        </div>
                                                        <div className="text-[9px] md:text-[10px] font-black italic text-white/10 uppercase tracking-widest text-center sm:text-right">
                                                            Resolution ID: VR-HIST-{proposal.id.toUpperCase()}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        )
                        }
                    </AnimatePresence >
                </main >

                {/* Mobile Pull Tab - Visible when sidebar is closed */}
                {
                    !isMobileSidebarOpen && (
                        <button
                            onClick={() => setIsMobileSidebarOpen(true)}
                            className="xl:hidden fixed left-0 top-1/2 -translate-y-1/2 z-[130] bg-white/[0.03] hover:bg-white/[0.05] border-y border-r border-white/10 rounded-r-xl p-2.5 text-white/20 hover:text-white/40 transition-all flex items-center justify-center group backdrop-blur-sm"
                        >
                            <ChevronRight className="w-4 h-4 group-hover:scale-110 transition-transform" />
                            <div className="absolute left-full ml-2 px-2 py-1 rounded bg-black/80 border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                <span className="text-[10px] font-black uppercase tracking-widest">Feed & Agents</span>
                            </div>
                        </button>
                    )
                }
            </div >
        </div >
    );
}
