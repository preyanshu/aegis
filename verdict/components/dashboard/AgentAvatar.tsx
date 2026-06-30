"use client";

interface AgentAvatarProps {
    id: string;
    className?: string;
}

export function AgentAvatar({ id, className = "w-14 h-14" }: AgentAvatarProps) {
    const getGradient = (agentId: string) => {
        if (agentId === 'agent-1') return 'bg-[radial-gradient(circle_at_50%_50%,#3b82f6,#8b5cf6,#ec4899)]';
        if (agentId === 'agent-2') return 'bg-[radial-gradient(circle_at_50%_50%,#10b981,#06b6d4,#3b82f6)]';
        if (agentId === 'agent-3') return 'bg-[radial-gradient(circle_at_50%_50%,#f59e0b,#ef4444,#8b5cf6)]';
        return 'bg-[radial-gradient(circle_at_50%_50%,#ec4899,#f43f5e,#fde047)]';
    };

    return (
        <div className={`${className} rounded-full overflow-hidden relative border border-white/10 transition-all bg-black flex-shrink-0`}>
            <div className={`absolute inset-0 blur-[4px] opacity-70 contrast-[1.2] ${getGradient(id)}`} />
            <div className="absolute inset-0 bg-gradient-to-tr from-black/40 via-transparent to-white/10" />
        </div>
    );
}
