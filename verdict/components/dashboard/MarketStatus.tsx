"use client";

import type { BlindDashboardState } from "@/lib/types";
import { BarChart3, Clock3, ShieldCheck, Wallet } from "lucide-react";
import { formatUsdc } from "@/lib/blind-market";

interface MarketStatusProps {
    state: BlindDashboardState;
    now: number;
}

function timeUntil(target: number | null, now: number) {
    if (!target || target <= now) {
        return "Awaiting";
    }

    const remaining = target - now;
    const hours = Math.floor(remaining / (1000 * 60 * 60));
    const minutes = Math.floor((remaining % (1000 * 60 * 60)) / (1000 * 60));

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

export function MarketStatus({ state, now }: MarketStatusProps) {
    const stats = [
        {
            label: "Next Close",
            value: timeUntil(state.nextDeadline, now),
            icon: Clock3,
            iconColor: "text-white/60",
        },
        {
            label: "Open Markets",
            value: state.openCount.toString(),
            icon: BarChart3,
            iconColor: "text-white/60",
        },
        {
            label: "Resolved",
            value: state.resolvedCount.toString(),
            icon: ShieldCheck,
            iconColor: "text-white/60",
        },
        {
            label: "Locked Collateral",
            value: formatUsdc(state.totalCommitted),
            icon: Wallet,
            iconColor: "text-white/60",
        },
    ];

    return (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-12">
            {stats.map((stat) => (
                <div
                    key={stat.label}
                    className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-4 sm:p-5 rounded-[20px] flex flex-col gap-4"
                >
                    <div className="w-9 h-9 sm:w-10 sm:h-10 rounded-lg bg-white/[0.03] flex items-center justify-center">
                        <stat.icon className={`w-4 h-4 sm:w-4.5 sm:h-4.5 ${stat.iconColor}`} />
                    </div>

                    <div className="space-y-0.5 sm:space-y-1">
                        <p className="text-[8px] sm:text-[9px] text-white/40 uppercase tracking-[0.2em] font-black">
                            {stat.label}
                        </p>
                        <p className="text-lg sm:text-2xl font-black text-white tracking-tight">
                            {stat.value}
                        </p>
                    </div>
                </div>
            ))}
        </div>
    );
}
