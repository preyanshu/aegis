"use client";

import { useState } from "react";
import { MessageSquare, Clock, ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Agent } from "@/lib/types";
import { AgentAvatar } from "./AgentAvatar";
import { AnimatePresence, motion } from "framer-motion";
import { getExplorerTxUrl } from "@/lib/config";

export function ActivityFeed({ agents, userTrades = [], filterStrategyId, activeProposalName }: { agents: Agent[], userTrades?: any[], filterStrategyId?: string | null, activeProposalName?: string | null }) {
    const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

    const toggleExpand = (id: string) => {
        const newSet = new Set(expandedIds);
        if (newSet.has(id)) newSet.delete(id);
        else newSet.add(id);
        setExpandedIds(newSet);
    };

    // Aggregate and sort activity (Strictly Trades)
    let activities = [
        ...agents.flatMap(agent => (agent.trades || []).map((t: any) => ({
            ...t,
            agentName: agent.personality.name,
            agentId: agent.id,
            status: t.type.toUpperCase(),
            uniqueId: `${agent.id}-${t.timestamp}-${t.strategyId}-${t.quantity}`
        }))),
        ...userTrades.map((t: any) => ({
            ...t,
            agentName: t.agentName || "You",
            agentId: "user",
            status: t.type.toUpperCase(),
            uniqueId: `user-${t.timestamp}-${t.strategyId}-${t.quantity}`
        }))
    ];

    if (filterStrategyId) {
        activities = activities.filter(a => a.strategyId === filterStrategyId);
    }

    activities = activities.sort((a, b) => {
        const timeA = typeof a.timestamp === 'string' ? new Date(a.timestamp).getTime() : a.timestamp;
        const timeB = typeof b.timestamp === 'string' ? new Date(b.timestamp).getTime() : b.timestamp;
        return (timeB || 0) - (timeA || 0);
    });

    return (
        <div className="flex flex-col">
            <div className="px-6 py-8">
                <div className="flex flex-col gap-1 mb-6">
                    <div className="text-lg font-bold text-white tracking-tight flex items-center gap-3">
                        <Clock className="w-5 h-5 text-white/40" />
                        Recent Trades
                    </div>
                    {filterStrategyId && activeProposalName && (
                        <div className="text-xs font-medium text-emerald-500/90 leading-tight">
                            Showing trades for {activeProposalName}
                        </div>
                    )}
                </div>

                <div className="space-y-3">
                    {activities.length === 0 ? (
                        <div className="flex flex-col items-center justify-center py-12 px-4 text-center border border-dashed border-white/5 rounded-2xl bg-white/[0.01]">
                            <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center mb-3">
                                <MessageSquare className="w-5 h-5 text-white/20" />
                            </div>
                            <p className="text-[10px] font-black text-white/30 uppercase tracking-[0.2em] mb-1">No Activity Yet</p>
                            <p className="text-[10px] text-white/20 font-medium">Trades will appear here live</p>
                        </div>
                    ) : (
                        <AnimatePresence initial={false} mode="popLayout">
                            {activities.map((activity, i) => {
                                const isExpanded = expandedIds.has(activity.uniqueId);
                                return (
                                    <motion.div
                                        key={activity.uniqueId}
                                        layout
                                        initial={{ opacity: 0, y: -20, scale: 0.95 }}
                                        animate={{ opacity: 1, y: 0, scale: 1 }}
                                        exit={{ opacity: 0, scale: 0.95 }}
                                        transition={{
                                            type: "spring",
                                            stiffness: 400,
                                            damping: 30,
                                            mass: 1
                                        }}
                                        className="bg-white/[0.03] border border-white/10 rounded-xl p-4 hover:border-white/20 transition-all duration-300 group"
                                    >
                                        <div className="flex items-center justify-between mb-3">
                                            <div className="flex items-center gap-3">
                                                <AgentAvatar id={activity.agentId} className="w-6 h-6" />
                                                <span className="text-sm font-bold text-white">
                                                    {activity.agentName}
                                                </span>
                                            </div>
                                            <div className={`px-2 py-0.5 rounded text-[10px] font-bold tracking-wider border ${activity.status === 'BUY' ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' :
                                                'bg-red-500/20 text-red-400 border-red-500/30'
                                                }`}>
                                                {activity.status}
                                            </div>
                                        </div>

                                        <div className="flex items-center gap-2 text-xs text-white/70 font-medium mb-3">
                                            <span className="text-white font-bold whitespace-nowrap">{activity.quantity.toFixed(1)} {activity.tokenType?.toUpperCase()}</span>
                                            <span className="text-white/30">@</span>
                                            <span className="text-emerald-400 font-bold">${activity.price.toFixed(2)}</span>
                                            <span className="ml-auto text-white/40 font-bold">#{activity.strategyId.split('-')[1]}</span>
                                        </div>

                                        {activity.reasoning && (
                                            <div className="mt-2 text-left">
                                                <button
                                                    onClick={() => toggleExpand(activity.uniqueId)}
                                                    className="flex items-center gap-2 text-[10px] uppercase font-bold tracking-widest text-white/50 hover:text-white/80 transition-colors w-full"
                                                >
                                                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                                                    {isExpanded ? 'Hide Reasoning' : 'View Reasoning'}
                                                </button>

                                                <AnimatePresence>
                                                    {isExpanded && (
                                                        <motion.div
                                                            initial={{ height: 0, opacity: 0 }}
                                                            animate={{ height: "auto", opacity: 1 }}
                                                            exit={{ height: 0, opacity: 0 }}
                                                            className="overflow-hidden"
                                                        >
                                                            <div className="mt-2 relative pl-4 py-2 border-l-2 border-white/30 bg-white/[0.04] rounded-r-lg">
                                                                <p className="text-[11px] leading-relaxed text-white/90 font-medium break-words">
                                                                    {activity.reasoning}
                                                                </p>
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        )}

                                        <div className="mt-3 flex items-center justify-between">
                                            <div className="text-[10px] font-bold text-white/50">
                                                {new Date(activity.timestamp || 0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </div>
                                            <div className="flex items-center gap-3">
                                                {activity.txHash && (
                                                    <a
                                                        href={getExplorerTxUrl(activity.txHash)}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-400/80 hover:text-emerald-400 transition-colors group"
                                                    >
                                                        <span className="font-mono">{activity.txHash.slice(0, 6)}...{activity.txHash.slice(-4)}</span>
                                                        <ExternalLink className="w-3 h-3 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-transform" />
                                                    </a>
                                                )}
                                                <div className="text-[10px] font-bold text-white/30 tracking-wider">
                                                    SECURED
                                                </div>
                                            </div>
                                        </div>
                                    </motion.div>
                                );
                            })}
                        </AnimatePresence>
                    )}
                </div>
            </div>
        </div>
    );
}
