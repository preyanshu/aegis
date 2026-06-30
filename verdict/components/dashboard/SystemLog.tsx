"use client";

import { useEffect, useState, useRef } from "react";
import { Terminal, Search, Trash2, ExternalLink, ShieldCheck, AlertCircle, Info, Bug } from "lucide-react";
import { Agent } from "@/lib/types";
import { motion, AnimatePresence } from "framer-motion";
import { TRUSTED_DATA_SOURCES } from "@/lib/data-sources";

import { LogEntry } from "@/lib/types";
import { api } from "@/lib/api";

interface SystemLogProps {
    agents: Agent[];
}

export function SystemLog({ agents }: SystemLogProps) {
    const [logs, setLogs] = useState<LogEntry[]>([]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const lastScrollInteraction = useRef<number>(0);
    const isFirstRender = useRef(true);

    useEffect(() => {
        const fetchLogs = async () => {
            try {
                const fetchedLogs = await api.getLogs();
                setLogs(fetchedLogs);
            } catch (error) {
                console.error("Failed to fetch logs:", error);
            }
        };

        fetchLogs();
        const interval = setInterval(fetchLogs, 3000);
        return () => clearInterval(interval);
    }, []);

    const [filterQuery, setFilterQuery] = useState("");

    const filteredLogs = logs.filter(log =>
        log.message.toLowerCase().includes(filterQuery.toLowerCase()) ||
        log.level.toLowerCase().includes(filterQuery.toLowerCase()) ||
        log.source.toLowerCase().includes(filterQuery.toLowerCase())
    );

    useEffect(() => {
        if (!scrollRef.current) return;

        const now = Date.now();
        const timeSinceInteraction = now - lastScrollInteraction.current;

        // Forced scroll on first load or if no interaction in last 10s
        if (isFirstRender.current || timeSinceInteraction > 10000) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            if (isFirstRender.current) isFirstRender.current = false;
        }
    }, [logs]);

    const handleManualScroll = () => {
        if (!scrollRef.current) return;
        const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;

        // If user is not at the very bottom, consider it an interaction
        const isAtBottom = Math.abs(scrollHeight - clientHeight - scrollTop) < 10;
        if (!isAtBottom) {
            lastScrollInteraction.current = Date.now();
        }
    };

    const renderMessage = (message: string) => {
        const urlRegex = /(https?:\/\/[^\s]+)/g;
        const parts = message.split(urlRegex);

        return parts.map((part, i) => {
            if (part.match(urlRegex)) {
                // Determine if it's an etherscan link
                const isExplorer = part.includes('etherscan.io') || part.includes('solscan.io') || part.includes('mantlescan.xyz') || part.includes('explorer');
                const label = isExplorer ? 'VIEW TRANSACTION' : 'OPEN LINK';

                return (
                    <a
                        key={i}
                        href={part}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-2 mt-2 px-3 py-1.5 rounded-lg bg-emerald-500/5 text-emerald-400 hover:bg-emerald-500/10 transition-all border border-emerald-500/10 group/link w-fit"
                    >
                        <span className="text-[9px] font-black uppercase tracking-widest">{label}</span>
                        <ExternalLink className="w-3 h-3 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5 transition-transform" />
                    </a>
                );
            }
            return <span key={i} className="opacity-90">{part}</span>;
        });
    };

    const getLevelConfig = (level: string) => {
        switch (level.toLowerCase()) {
            case 'error': return { icon: AlertCircle, color: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/20', label: 'CRITICAL' };
            case 'warn': return { icon: AlertCircle, color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/20', label: 'WARNING' };
            case 'debug': return { icon: Bug, color: 'text-emerald-500/50', bg: 'bg-emerald-500/5', border: 'border-emerald-500/10', label: 'VERBOSE' };
            case 'info': return { icon: Info, color: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/20', label: 'SECURE' };
            default: return { icon: ShieldCheck, color: 'text-white/40', bg: 'bg-white/5', border: 'border-white/10', label: 'SYSTEM' };
        }
    };

    return (
        <div className="flex flex-col h-full bg-transparent font-sans">
            {/* Sticky Header & Filter */}
            <div className="p-6 pb-2 bg-transparent">
                <div className="flex items-center justify-between mb-6">
                    <div className="flex items-center gap-3">
                        <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                            <Terminal className="w-4 h-4 text-emerald-500" />
                        </div>
                        <div>
                            <h2 className="text-sm font-black text-white tracking-[0.2em] uppercase leading-none mb-1">System Logs</h2>
                            <div className="flex items-center gap-1.5">
                                <span className="w-1 h-1 rounded-full bg-emerald-500 animate-pulse" />
                                <span className="text-[8px] font-bold text-white/20 uppercase tracking-widest">Protocol Live</span>
                            </div>
                        </div>
                    </div>
                </div>
                <div className="relative group">
                    <Search className="absolute left-4 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/20 group-focus-within:text-emerald-500 transition-colors" />
                    <input
                        type="text"
                        value={filterQuery}
                        onChange={(e) => setFilterQuery(e.target.value)}
                        placeholder="Trace protocol operations..."
                        className="w-full bg-[#121214] border border-white/5 rounded-xl py-3 pl-11 pr-4 text-[11px] text-white/80 placeholder:text-white/10 focus:outline-none focus:border-emerald-500/20 focus:bg-white/[0.02] transition-all font-medium uppercase tracking-wider"
                    />
                </div>
            </div>

            <div
                ref={scrollRef}
                onScroll={handleManualScroll}
                className="flex-1 overflow-y-auto p-4 md:p-6 pt-2 space-y-4 custom-scrollbar bg-transparent"
            >
                {agents.length === 0 && logs.length === 0 ? (
                    <div className="h-full flex flex-col items-center justify-center text-center p-6 bg-white/[0.01] rounded-[2rem] border border-dashed border-white/5 mx-4">
                        <Terminal className="w-8 h-8 text-white/5 mb-4" />
                        <p className="text-[9px] font-black text-white/10 uppercase tracking-[0.3em]">Initialize Fleet to stream data</p>
                    </div>
                ) : (
                    <div className="flex flex-col gap-3">
                        <AnimatePresence initial={false}>
                            {filteredLogs.map((log, index) => {
                                const config = getLevelConfig(log.level);
                                const Icon = config.icon;
                                return (
                                    <motion.div
                                        key={`${log.timestamp}-${index}`}
                                        initial={{ opacity: 0, y: 10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="group relative"
                                    >
                                        <div className="bg-[#121214]/30 backdrop-blur-xl border border-white/5 rounded-2xl p-4 hover:bg-white/[0.04] transition-all duration-500">
                                            <div className="flex items-center justify-between gap-4 mb-3">
                                                <div className="flex items-center gap-3">
                                                    <div className={`w-1.5 h-4 rounded-full ${config.bg.replace('10', '40')} transition-colors`} />
                                                    <div className="flex flex-col">
                                                        <span className={`text-[10px] font-black uppercase tracking-[0.3em] ${config.color}`}>
                                                            {log.source}
                                                        </span>
                                                        <span className="text-[8px] font-black text-white/20 uppercase tracking-widest mt-0.5">
                                                            {config.label} NODE
                                                        </span>
                                                    </div>
                                                </div>
                                                <div className="text-[9px] font-mono text-white/20 font-black tracking-tighter bg-white/5 px-2 py-0.5 rounded-md border border-white/5">
                                                    {new Date(log.timestamp).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                                </div>
                                            </div>
                                            <div className="text-[12px] font-medium text-white/60 leading-relaxed font-mono selection:bg-emerald-500/30 break-words flex flex-col">
                                                {renderMessage(log.message)}
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    </div>
                )}
            </div>

            <div className="p-4 bg-[#050507]/40 backdrop-blur-xl border-t border-white/5 flex items-center justify-between mx-2 mb-2 rounded-2xl">
                <div className="flex items-center gap-3">
                    <div className="flex -space-x-1">
                        {[1, 2, 3].map(i => (
                            <div key={i} className="w-1.5 h-1.5 rounded-full bg-emerald-500/20 border border-emerald-500/30" />
                        ))}
                    </div>
                    <span className="text-[9px] font-black text-white/10 uppercase tracking-[0.2em]">Monitoring Enabled</span>
                </div>
                <button
                    onClick={() => setLogs([])}
                    className="flex items-center gap-2 group px-4 py-2 rounded-xl hover:bg-red-500/5 transition-all border border-transparent hover:border-red-500/10"
                >
                    <Trash2 className="w-3 h-3 text-white/10 group-hover:text-red-400 transition-colors" />
                    <span className="text-[9px] font-black text-white/10 group-hover:text-red-400 transition-colors tracking-widest uppercase">
                        Clear Node
                    </span>
                </button>
            </div>
        </div>
    );
}
