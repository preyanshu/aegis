"use client";

import { useState, useEffect } from "react";
import type { BlindMarketSummary } from "@/lib/types";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, ChevronUp, Database, LockKeyhole, ShieldCheck, Wallet } from "lucide-react";
import { formatCompactAddress, formatUsdc, marketStatusLabel, loadSavedPositions } from "@/lib/blind-market";
import { getBrowserConfig, walletByLabel, walletPublicKey } from "@/lib/stellar";

interface MarketCardProps {
    market: BlindMarketSummary;
    onClick?: (id: string) => void;
}

function formatDate(timestamp: number) {
    return new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function LiveCountdown({ endTimestamp, resolved }: { endTimestamp: number, resolved: boolean }) {
    const [timeLeft, setTimeLeft] = useState("");

    useEffect(() => {
        if (resolved) {
            setTimeLeft("Resolved");
            return;
        }
        
        const update = () => {
            const now = Date.now();
            const diff = endTimestamp - now;

            if (diff <= 0) {
                setTimeLeft("Waiting Resolution");
                return;
            }

            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
            const minutes = Math.floor((diff / 1000 / 60) % 60);
            const seconds = Math.floor((diff / 1000) % 60);

            if (days > 0) {
                setTimeLeft(`Ends in ${days}d ${hours}h`);
            } else if (hours > 0) {
                setTimeLeft(`Ends in ${hours}h ${minutes}m`);
            } else if (minutes > 0) {
                setTimeLeft(`Ends in ${minutes}m ${seconds}s`);
            } else {
                setTimeLeft(`Ends in ${seconds}s`);
            }
        };

        update();
        const interval = setInterval(update, 1000);
        return () => clearInterval(interval);
    }, [endTimestamp, resolved]);

    if (!timeLeft) {
        return <span>...</span>;
    }

    return <span>{timeLeft}</span>;
}

export function MarketCard({ market, onClick }: MarketCardProps) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [hasPosition, setHasPosition] = useState(false);
    const status = marketStatusLabel(market);

    useEffect(() => {
        try {
            const config = getBrowserConfig();
            const walletLabel = config.wallets[0]?.label ?? "admin";
            const wallet = walletByLabel(walletLabel);
            const walletPublic = wallet ? walletPublicKey(walletLabel) : "";
            
            const savedPositions = loadSavedPositions();
            const positions = savedPositions.filter((p: any) => p.owner === walletPublic && p.marketId === market.marketId);
            setHasPosition(positions.length > 0);
        } catch (e) {
            console.error("Failed to load positions for card:", e);
        }
    }, [market.marketId]);

    return (
        <div
            onClick={() => onClick?.(market.marketId)}
            className="group relative bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-4 sm:p-6 rounded-2xl hover:border-white/20 transition-all duration-500 hover:shadow-[0_0_40px_rgba(255,255,255,0.02)] cursor-pointer"
        >
            <div className="flex items-start justify-between gap-4 mb-7">
                <div className="flex items-start gap-5">
                    <div className="w-14 h-14 rounded-xl bg-white/[0.04] border border-white/10 flex items-center justify-center shrink-0 shadow-sm">
                        <span className="text-sm uppercase tracking-widest text-white/70 font-bold">{market.category.substring(0, 4)}</span>
                    </div>
                    <h3 className="text-lg sm:text-xl font-bold text-white tracking-tight leading-snug pt-1">
                        {market.question}
                    </h3>
                </div>
                <div className="flex flex-col items-end gap-2 shrink-0">
                    <div className={`px-3 py-1 rounded-full border text-[10px] uppercase font-black tracking-widest whitespace-nowrap ${market.resolved ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" : "bg-violet-500/10 border-violet-500/20 text-violet-300"}`}>
                        {status}
                    </div>
                    {hasPosition && (
                        <div className="px-3 py-1 rounded-full border text-[10px] uppercase font-black tracking-widest whitespace-nowrap bg-blue-500/10 border-blue-500/20 text-blue-300 flex items-center gap-1.5 shadow-sm">
                            <Wallet className="w-3 h-3" />
                            Position
                        </div>
                    )}
                </div>
            </div>

            <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 mb-7">
                <div className="flex-1 flex items-center justify-center gap-2 py-3 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-300 font-semibold text-base transition-colors">
                    <LockKeyhole className="w-4 h-4 sm:w-5 sm:h-5" />
                    Encrypted
                </div>
                <button className="flex-1 sm:flex-none px-10 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-bold text-base transition-colors hover:bg-emerald-500/20">
                    Yes
                </button>
                <button className="flex-1 sm:flex-none px-10 py-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 font-bold text-base transition-colors hover:bg-rose-500/20">
                    No
                </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm font-medium text-white/50">
                <span>{formatUsdc(market.totalLockedCollateral)} Vol.</span>
                <span className="text-white/20">•</span>
                <span>{market.commitmentCount} position{market.commitmentCount !== 1 ? 's' : ''}</span>
                <span className="text-white/20">•</span>
                <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${market.resolved ? 'bg-violet-400' : 'bg-emerald-400 shadow-[0_0_8px_rgba(52,211,153,0.5)]'}`} />
                    <span className="text-white/80">
                        <LiveCountdown endTimestamp={market.endTimestamp} resolved={market.resolved} />
                    </span>
                </div>
                <span className="text-white/20">•</span>
                <span className="uppercase">{market.category}</span>
            </div>

            <button
                onClick={(event) => {
                    event.stopPropagation();
                    setIsExpanded(!isExpanded);
                }}
                className="mt-6 w-full py-3 flex items-center justify-center gap-2 text-[10px] uppercase font-bold tracking-[0.2em] text-white/40 hover:text-white/70 transition-all border-t border-white/10"
            >
                {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                {isExpanded ? "Hide Market Details" : "View Market Details"}
            </button>

            <AnimatePresence>
                {isExpanded ? (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.3, ease: "easeInOut" }}
                        className="overflow-hidden"
                    >
                        <div className="mt-6 space-y-5 pt-2">
                            <div className="border border-white/5 bg-white/[0.02] rounded-2xl p-4 sm:p-5">
                                <p className="text-[10px] text-white/30 uppercase font-black tracking-[0.25em] mb-4">
                                    Resolution Logic
                                </p>
                                <p className="text-sm text-white/70 leading-relaxed">
                                    {market.oracleLogic}
                                </p>
                            </div>

                            <div className="grid grid-cols-1 gap-3">
                                {market.conditions.map((condition, index) => (
                                    <div key={`${condition.assetSymbol}-${index}`} className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-2xl bg-white/[0.03] border border-white/8 p-4">
                                        <div className="w-10 h-10 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center">
                                            <Database className="w-4 h-4 text-white/40" />
                                        </div>
                                        <div className="min-w-0">
                                            <p className="text-sm font-black text-white tracking-tight">{condition.assetSymbol}</p>
                                            <p className="text-[11px] text-white/35 truncate">
                                                Oracle {formatCompactAddress(condition.oracleContract)}
                                            </p>
                                        </div>
                                        <div className="text-right">
                                            <p className="text-sm font-black text-white">{condition.comparator} {condition.threshold.toString()}</p>
                                            <p className="text-[9px] text-white/20 font-black uppercase tracking-[0.22em]">Condition</p>
                                        </div>
                                    </div>
                                ))}
                            </div>

                            <div className="flex items-center justify-between rounded-2xl bg-white/[0.02] border border-white/5 p-4">
                                <div className="flex items-center gap-3">
                                    <Wallet className="w-4 h-4 text-white/40" />
                                    <span className="text-[10px] uppercase tracking-[0.22em] text-white/30 font-black">Creator</span>
                                </div>
                                <span className="text-xs font-mono text-white/75">{formatCompactAddress(market.creator)}</span>
                            </div>

                            {market.resolved ? (
                                <div className="rounded-2xl border border-emerald-500/15 bg-emerald-500/5 p-4">
                                    <div className="flex items-center gap-3 mb-3">
                                        <ShieldCheck className="w-4 h-4 text-emerald-300" />
                                        <span className="text-[10px] uppercase tracking-[0.22em] text-emerald-200/80 font-black">Settlement Outputs</span>
                                    </div>
                                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                                        <div>
                                            <p className="text-[9px] uppercase tracking-[0.22em] text-white/20 font-black mb-2">Outcome</p>
                                            <p className="text-sm font-black text-white">{market.outcome}</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] uppercase tracking-[0.22em] text-white/20 font-black mb-2">Pot</p>
                                            <p className="text-sm font-black text-white">{formatUsdc(market.distributablePot)}</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] uppercase tracking-[0.22em] text-white/20 font-black mb-2">Winning Total</p>
                                            <p className="text-sm font-black text-white">{formatUsdc(market.winningSideTotal)}</p>
                                        </div>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </motion.div>
                ) : null}
            </AnimatePresence>
        </div>
    );
}
