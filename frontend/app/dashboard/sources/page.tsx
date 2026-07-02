"use client";

import { useState, useEffect } from "react";
import { Navbar } from "@/components/landing/Navbar";
import { api } from "@/lib/api";
import { DataSource, TRUSTED_DATA_SOURCES } from "@/lib/data-sources";
import { loadReflectorPrice } from "@/lib/stellar";
import {
    Globe,
    ShieldCheck,
    Activity,
    Zap,
    BarChart3,
    Lock,
    ExternalLink,
    RefreshCw,
    Loader2,
    CheckCircle2,
    ChevronRight,
    ChevronDown,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";
import { ActivityFeed } from "@/components/dashboard/ActivityFeed";
import { ActiveAgents } from "@/components/dashboard/ActiveAgents";
import { Agent } from "@/lib/types";

export default function SourcesPage() {
    const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
    const [verifying, setVerifying] = useState<Record<number, boolean>>({});
    const [latestData, setLatestData] = useState<Record<number, { price: string; time: string; contract: string } | null>>({});
    const [isInitialLoading, setIsInitialLoading] = useState(true);
    const [agents, setAgents] = useState<Agent[]>([]);
    const supportedGroups = Array.from(new Set(TRUSTED_DATA_SOURCES.map((source) => source.group)));

    useEffect(() => {
        const fetchAgents = async () => {
            try {
                const fetchedAgents = await api.getAgents();
                setAgents(fetchedAgents);
            } catch (error) {
                console.error("Failed to fetch agents:", error);
            } finally {
                setIsInitialLoading(false);
            }
        };

        fetchAgents();
        const interval = setInterval(fetchAgents, 5000);
        return () => clearInterval(interval);
    }, []);

    const handleVerify = async (source: DataSource) => {
        setVerifying(prev => ({ ...prev, [source.id]: true }));
        try {
            const reflectorPrice = await loadReflectorPrice(source.oracleContract, source.ticker);
            if (!reflectorPrice) {
                throw new Error(`No Reflector price available for ${source.ticker}`);
            }
            setLatestData(prev => ({
                ...prev,
                [source.id]: {
                    price: reflectorPrice.formatted,
                    time: new Date(reflectorPrice.timestamp * 1000).toLocaleString(),
                    contract: source.oracleContract,
                }
            }));
        } catch (error) {
            console.error("Reflector fetch error:", error);
        } finally {
            setVerifying(prev => ({ ...prev, [source.id]: false }));
        }
    };

    return (
        <div className="h-screen bg-[#05030a] text-white selection:bg-violet-500/30 flex flex-col relative overflow-hidden">
            <Navbar transparent={false} />

            <div className="flex-1 pt-20 overflow-hidden relative flex">
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

                {/* Decorative background glow */}
                <div className="absolute top-[-120px] right-[-60px] w-[560px] h-[560px] bg-violet-500/[0.08] rounded-full blur-[140px] -z-10" />
                <div className="absolute bottom-[-120px] left-[-80px] w-[540px] h-[540px] bg-fuchsia-500/[0.06] rounded-full blur-[140px] -z-10" />
                <div className="absolute inset-x-0 top-0 h-40 bg-[radial-gradient(circle_at_top,rgba(168,85,247,0.16),transparent_60%)] -z-10" />

                <main className="h-full overflow-y-auto custom-scrollbar relative flex-1">
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
                                        <div className="absolute inset-0 bg-violet-500/20 blur-2xl rounded-full" />
                                        <Loader2 className="w-10 h-10 text-violet-400 animate-spin relative z-10" strokeWidth={1.5} />
                                    </div>
                                    <span className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-400/70 ml-2">
                                        Loading Sources
                                    </span>
                                </div>
                            </motion.div>
                        ) : (
                            <div key="content" className="max-w-7xl mx-auto px-4 sm:px-6 md:px-8 lg:px-12 py-6 md:py-12">
                                <header className="flex flex-col md:flex-row md:items-center justify-between gap-6 mb-8 md:mb-12">
                                    <div>
                                        <h1 className="text-xl sm:text-2xl md:text-3xl font-black tracking-tight text-white mb-2 uppercase">
                                            Sources
                                        </h1>
                                        <p className="text-white/40 font-medium text-sm uppercase tracking-widest">Reflector oracle assets</p>
                                    </div>
                                </header>

                                {/* Top Stats */}
                                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6 mb-8 md:mb-12">
                                    <div className="bg-white/[0.02] border border-white/5 p-6 md:p-8 rounded-2xl md:rounded-[2rem] flex flex-col gap-4 md:gap-6">
                                        <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-300">
                                            <Globe className="w-4 h-4 md:w-5 md:h-5" />
                                        </div>
                                        <div>
                                            <p className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-[0.25em] mb-1 md:mb-2.5">Infrastructure</p>
                                            <p className="text-xl md:text-3xl font-black text-violet-300 tracking-tight">Reflector Network</p>
                                        </div>
                                    </div>
                                    <div className="bg-white/[0.02] border border-white/5 p-6 md:p-8 rounded-2xl md:rounded-[2rem] flex flex-col gap-4 md:gap-6">
                                        <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-300">
                                            <ShieldCheck className="w-4 h-4 md:w-5 md:h-5" />
                                        </div>
                                        <div>
                                            <p className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-[0.25em] mb-1 md:mb-2.5">Protocol Verity</p>
                                            <p className="text-xl md:text-3xl font-black text-white tracking-tight">{TRUSTED_DATA_SOURCES.length} Assets</p>
                                        </div>
                                    </div>
                                    <div className="bg-white/[0.02] border border-white/5 p-6 md:p-8 rounded-2xl md:rounded-[2rem] flex flex-col gap-4 md:gap-6 lg:col-span-1 sm:col-span-2 lg:sm:col-span-1">
                                        <div className="w-8 h-8 md:w-10 md:h-10 rounded-lg md:rounded-xl bg-violet-500/10 border border-violet-500/20 flex items-center justify-center text-violet-300">
                                            <Zap className="w-4 h-4 md:w-5 md:h-5" />
                                        </div>
                                        <div>
                                            <p className="text-[9px] md:text-[10px] font-black text-white/20 uppercase tracking-[0.25em] mb-1 md:mb-2.5">Data Precision</p>
                                            <p className="text-xl md:text-3xl font-black text-white tracking-tight">{supportedGroups.length} Oracle Groups</p>
                                        </div>
                                    </div>
                                </div>

                                {/* Sources List */}
                                <div className="space-y-4 md:space-y-6">
                                    {TRUSTED_DATA_SOURCES.map((source) => (
                                        <div
                                            key={source.id}
                                            className="bg-white/[0.02] border border-white/5 rounded-2xl md:rounded-3xl p-6 md:p-8 hover:bg-white/[0.03] transition-all group"
                                        >
                                            <div className="flex flex-col xl:flex-row gap-6 md:gap-8 xl:items-center">
                                                {/* Main Identity */}
                                                <div className="flex-1">
                                                    <div className="flex items-center gap-4 md:gap-5 mb-4">
                                                        <div className="w-12 h-12 md:w-14 md:h-14 rounded-xl md:rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center overflow-hidden p-2 group-hover:border-violet-500/30 transition-all shrink-0">
                                                            <img src={source.icon} alt={source.name} className="w-full h-full object-contain filter group-hover:brightness-110 transition-all" />
                                                        </div>
                                                        <div>
                                                            <h2 className="text-xl md:text-2xl font-bold text-white tracking-tight leading-none mb-2">{source.name}</h2>
                                                            <div className="flex flex-wrap items-center gap-2 md:gap-3">
                                                                <span className="text-[9px] md:text-[10px] font-black text-violet-300 uppercase tracking-widest bg-violet-500/10 px-2 md:px-2.5 py-0.5 md:py-1 rounded-lg border border-violet-500/20">
                                                                    {source.type}
                                                                </span>
                                                                <span className="text-[9px] md:text-[10px] text-white/30 font-bold uppercase tracking-[0.2em]">{source.ticker} / USD</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <p className="text-white/50 font-medium leading-relaxed max-w-2xl text-[13px] md:text-[14px]">
                                                        Reflector source for {source.name} ({source.ticker}) used in market conditions.
                                                    </p>
                                                </div>

                                                {/* Metadata Attributes */}
                                                <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8 xl:w-[720px] p-4 md:p-6 lg:p-8 rounded-xl md:rounded-2xl bg-black/20 border border-white/5">
                                                    <div>
                                                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-3">Asset Type</p>
                                                        <div className="flex items-center gap-2">
                                                            <BarChart3 className="w-4 h-4 text-white/40" />
                                                            <p className="text-[13px] font-bold text-white uppercase">{source.group}</p>
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-3">Reference Price</p>
                                                        <div className="flex items-center gap-2">
                                                            {latestData[source.id] ? (
                                                                <div className="flex flex-col">
                                                                    <p className="text-[13px] font-bold text-emerald-400">${Number(latestData[source.id]?.price).toFixed(3)}</p>
                                                                    <p className="text-[9px] text-white/20 font-mono tracking-tighter">{latestData[source.id]?.time}</p>
                                                                </div>
                                                            ) : (
                                                                <div className="flex items-center gap-2 text-white/10 italic">
                                                                    <Lock className="w-3.5 h-3.5" />
                                                                    <p className="text-[13px] font-bold uppercase tracking-tighter">Encrypted</p>
                                                                </div>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div>
                                                        <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-3">Oracle Route</p>
                                                        <div className="flex items-center gap-2">
                                                            {latestData[source.id] ? (
                                                                <div className="flex flex-col">
                                                                    <p className="text-[11px] font-bold text-emerald-400 uppercase">Verified</p>
                                                                    <p className="text-[9px] text-white/20 font-mono tracking-tighter">
                                                                        {latestData[source.id]?.contract.slice(0, 8)}...{latestData[source.id]?.contract.slice(-6)}
                                                                    </p>
                                                                </div>
                                                            ) : (
                                                                <>
                                                                    <Activity className="w-4 h-4 text-white/20" />
                                                                    <p className="text-[13px] font-bold text-white/20">SUPPORTED</p>
                                                                </>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <div className="flex items-end">
                                                        <button
                                                            onClick={() => handleVerify(source)}
                                                            disabled={verifying[source.id]}
                                                            className={`w-full py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-2 whitespace-nowrap min-w-0 ${latestData[source.id]
                                                                ? 'bg-violet-500/10 text-violet-300 border border-violet-500/20 hover:bg-violet-500/20'
                                                                : 'bg-white/5 text-white/40 border border-white/10 hover:bg-white/10 hover:text-white'
                                                                }`}
                                                        >
                                                            {verifying[source.id] ? (
                                                                <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
                                                            ) : latestData[source.id] ? (
                                                                <RefreshCw className="w-3.5 h-3.5 flex-shrink-0" />
                                                            ) : (
                                                                <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
                                                            )}
                                                            <span className={verifying[source.id] ? "tracking-normal" : ""}>
                                                                {verifying[source.id] ? 'Verifying...' : latestData[source.id] ? 'Re-Verify' : 'Verify Route'}
                                                            </span>
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>

                                {/* Footer Info */}
                                <div className="mt-20 p-12 rounded-[2.5rem] bg-[linear-gradient(135deg,rgba(109,40,217,0.14),rgba(168,85,247,0.06))] border border-violet-500/15 flex flex-col lg:flex-row items-center gap-12 text-center lg:text-left overflow-hidden relative group">
                                    <div className="absolute top-0 right-0 p-8 text-violet-500/10 transition-transform group-hover:scale-110">
                                        <Activity className="w-64 h-64 -mr-20 -mt-20" />
                                    </div>
                                    <div className="relative z-10 flex-1">
                                        <h3 className="text-3xl font-black text-white mb-4 italic tracking-tight">Reflector x Aegis Oracle Layer</h3>
                                        <p className="text-[15px] font-medium text-white/60 leading-relaxed max-w-2xl">
                                            These are the Reflector assets currently supported by the app for building market conditions on Stellar.
                                        </p>
                                    </div>
                                    <div className="relative z-10 flex gap-4">
                                        <div className="p-4 bg-white/5 border border-white/10 rounded-2xl backdrop-blur-md">
                                            <p className="text-[10px] font-black text-white/20 uppercase tracking-widest mb-1.5 flex items-center gap-2">
                                                <div className="w-1.5 h-1.5 rounded-full bg-violet-400 animate-pulse" />
                                                Feed Status
                                            </p>
                                            <p className="text-2xl font-black text-violet-300">Live via Reflector</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </AnimatePresence>
                </main>

                {/* Mobile Pull Tab - Visible when sidebar is closed */}
                {!isMobileSidebarOpen && (
                    <button
                        onClick={() => setIsMobileSidebarOpen(true)}
                        className="xl:hidden fixed left-0 top-1/2 -translate-y-1/2 z-[130] bg-white/[0.03] hover:bg-white/[0.05] border-y border-r border-white/10 rounded-r-xl p-2.5 text-white/20 hover:text-white/40 transition-all flex items-center justify-center group backdrop-blur-sm"
                    >
                        <ChevronRight className="w-4 h-4 group-hover:scale-110 transition-transform" />
                        <div className="absolute left-full ml-2 px-2 py-1 rounded bg-black/80 border border-white/10 opacity-0 group-hover:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                            <span className="text-[10px] font-black uppercase tracking-widest">Feed & Agents</span>
                        </div>
                    </button>
                )}
            </div>
        </div>
    );
}
