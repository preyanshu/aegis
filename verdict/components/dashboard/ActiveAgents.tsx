"use client";

import { Agent } from "@/lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { Users, Shield, TrendingUp, TrendingDown, Target, ArrowRight, Wallet, ExternalLink } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import Link from "next/link";
import { getExplorerAddressUrl } from "@/lib/config";

interface ActiveAgentsProps {
    agents: Agent[];
}

export function ActiveAgents({ agents }: ActiveAgentsProps) {
    return (
        <div className="flex flex-col border-t border-white/5 bg-[#0a0a0e]/50 backdrop-blur-sm">
            <div className="px-6 py-8">
                <div className="flex items-center justify-between mb-6">
                    <div className="text-lg font-bold text-white tracking-tight flex items-center gap-3">
                        <Users className="w-5 h-5 text-white/40" />
                        Active Agents
                    </div>
                    <Link href="/dashboard/agents">
                        <button className="p-1.5 rounded-lg bg-white/5 border border-white/10 text-white/40 hover:text-white hover:bg-white/10 hover:border-white/20 transition-all group">
                            <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition-transform" />
                        </button>
                    </Link>
                </div>

                <div className="space-y-3">
                    {agents.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 px-4 text-center border border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                            <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center mb-3">
                                <Users className="w-5 h-5 text-white/20" />
                            </div>
                            <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-1">No Active Agents</p>
                            <p className="text-[10px] text-white/20 font-medium">Launch a strategy to deploy agents</p>
                        </div>
                    ) : (
                        <AnimatePresence initial={false} mode="popLayout">
                            {agents.map((agent) => (
                                <motion.div
                                    key={agent.id}
                                    layout
                                    initial={{ opacity: 0, x: -20 }}
                                    animate={{ opacity: 1, x: 0 }}
                                    exit={{ opacity: 0, x: -20 }}
                                    transition={{ type: "spring", stiffness: 400, damping: 30 }}
                                    className="bg-white/[0.03] border border-white/10 rounded-xl p-4 hover:border-white/20 transition-all duration-300 group"
                                >
                                    <div className="flex items-start gap-3 mb-4">
                                        <AgentAvatar id={agent.id} className="w-6 h-6" />
                                        <div className="flex-1 min-w-0">
                                            <div className="flex items-center justify-between mb-1">
                                                <p className="text-sm font-bold text-white truncate mr-2">
                                                    {agent.personality.name}
                                                </p>
                                                <p className="text-base font-mono font-bold text-white flex-shrink-0">
                                                    ${(agent.vUSD ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                                                </p>
                                            </div>
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] text-white/50 uppercase font-black tracking-widest bg-white/5 px-2 py-0.5 rounded">
                                                    {agent.personality.riskTolerance}
                                                </span>
                                                {agent.wallet?.address && (
                                                    <a
                                                        href={getExplorerAddressUrl(agent.wallet.address)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[9px] font-mono text-white/50 hover:text-emerald-400 transition-all uppercase flex items-center gap-1.5 bg-white/5 px-1.5 py-0.5 rounded border border-white/5 hover:border-emerald-500/30 group/wallet"
                                                    >
                                                        {agent.wallet.address.slice(0, 4)}...{agent.wallet.address.slice(-4)}
                                                        <ExternalLink className="w-2 h-2 opacity-30 group-hover/wallet:opacity-100 transition-opacity" />
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-2 gap-4 pt-4 border-t border-white/5">
                                        <div>
                                            <p className="text-[10px] text-white/40 uppercase font-bold mb-2.5 tracking-wider">Primary Model</p>
                                            <div className="flex flex-wrap gap-1.5">
                                                {agent.personality.traits.slice(0, 2).map((trait, i) => (
                                                    <span key={i} className="text-[10px] text-white/70 border border-white/10 bg-white/5 px-2 py-0.5 rounded shadow-sm">
                                                        {trait}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="text-right flex flex-col items-end">
                                            <p className="text-[10px] text-white/40 uppercase font-bold mb-2.5 tracking-wider">Aggressiveness</p>
                                            <div className="flex gap-1 mt-0.5">
                                                {[1, 2, 3, 4, 5].map((i) => (
                                                    <div
                                                        key={i}
                                                        className={`w-3.5 h-1.5 rounded-full transition-colors ${i <= (agent.personality.aggressiveness * 5)
                                                            ? 'bg-emerald-500/60 shadow-[0_0_8px_rgba(16,185,129,0.2)]'
                                                            : 'bg-white/10'
                                                            }`}
                                                    />
                                                ))}
                                            </div>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </AnimatePresence>
                    )}
                </div>
            </div>
        </div>
    );
}
