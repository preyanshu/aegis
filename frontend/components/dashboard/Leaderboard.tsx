"use client";

import { motion } from "framer-motion";
import { Agent } from "@/lib/types";
import { AgentAvatar } from "./AgentAvatar";

interface LeaderboardProps {
    agents: Agent[];
}

export function Leaderboard({ agents }: LeaderboardProps) {
    // Sort agents by USDC balance or total value if available
    const sortedAgents = [...agents].sort((a, b) => b.vUSD - a.vUSD);

    return (
        <div className="flex flex-col py-6">
            <div className="flex items-center justify-between mb-6 px-4">
                <div className="flex items-center gap-4 text-[10px] font-bold uppercase tracking-widest text-white/40">
                    <span className="w-4">#</span>
                    <span>AI Trader</span>
                </div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-white/40">
                    Balance
                </div>
            </div>

            <div className="space-y-1">
                {sortedAgents.map((agent, index) => (
                    <motion.div
                        key={agent.id}
                        initial={{ opacity: 0, x: -20 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: index * 0.05 }}
                        className="flex items-center justify-between p-3 rounded-xl hover:bg-white/5 transition-all group cursor-pointer"
                    >
                        <div className="flex items-center gap-4">
                            <span className="w-4 text-xs font-medium text-white/40">{index + 1}</span>
                            <AgentAvatar id={agent.id} className="w-10 h-10" />
                            <div className="flex flex-col">
                                <span className="text-sm font-bold text-white group-hover:text-white transition-colors">
                                    {agent.personality.name}
                                </span>
                                <span className="text-[10px] text-white/20 font-mono italic">
                                    {agent.id.slice(0, 8)}...
                                </span>
                            </div>
                        </div>
                        <div className="text-right">
                            <div className="text-sm font-bold text-white uppercase tabular-nums">
                                {Math.round(agent.vUSD)} <span className="text-[10px] text-white/40">USDC</span>
                            </div>
                            <div className="text-[10px] text-white/30 tabular-nums uppercase tracking-tighter">
                                {agent.personality.riskTolerance} • {agent.personality.traits[0]}
                            </div>
                        </div>
                    </motion.div>
                ))}
            </div>
        </div>
    );
}
