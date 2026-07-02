"use client";

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ArrowLeft, ArrowRight, Loader2, Plus, Check, Info, Brain } from 'lucide-react';
import { TRUSTED_DATA_SOURCES, DataSource } from '@/lib/data-sources';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { api } from '@/lib/api';

interface CreateProposalModalProps {
    isOpen: boolean;
    onClose: () => void;
    onLaunchSuccess?: () => void;
    activeAgentsCount: number;
    currentProposalsCount: number;
    roundStartTime?: number;
    roundEndTime?: number;
    roundDuration?: number;
    isExecutingTrades?: boolean;
    now?: number;
}

export const CreateProposalModal = ({
    isOpen,
    onClose,
    onLaunchSuccess,
    activeAgentsCount,
    currentProposalsCount,
    roundStartTime,
    roundEndTime,
    roundDuration,
    isExecutingTrades,
    now
}: CreateProposalModalProps) => {
    const [view, setView] = useState<'summary' | 'designer'>('summary');
    const [step, setStep] = useState(1);

    // Proposal States
    const [name, setName] = useState('');
    const [selectedSources, setSelectedSources] = useState<DataSource[]>([]);

    // Condition Builder State
    interface Condition {
        source: string;
        operator: string;
        value: string;
        connector: 'AND' | 'OR' | null;
    }
    const [conditions, setConditions] = useState<Condition[]>([{ source: '', operator: '>', value: '', connector: null }]);

    // Async States
    const [isExecuting, setIsExecuting] = useState(false);
    const [executionComplete, setExecutionComplete] = useState(false);
    const [executionError, setExecutionError] = useState<string | null>(null);

    const TOTAL_STEPS = 3;

    const reset = () => {
        setTimeout(() => {
            setView('summary');
            setStep(1);
            setName('');
            setSelectedSources([]);
            setConditions([{ source: '', operator: '>', value: '', connector: null }]);
            setIsExecuting(false);
            setExecutionComplete(false);
            setExecutionError(null);
        }, 300);
    };

    const handleClose = () => {
        if (isExecuting) return;
        onClose();
        reset();
    };

    const [executionPhase, setExecutionPhase] = useState<'initializing' | 'synthesizing' | 'injecting' | 'starting' | 'executing'>('initializing');

    const executeLaunch = async () => {
        setIsExecuting(true);
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

        try {
            // 1. Synthesize Agents if they don't exist
            if (activeAgentsCount === 0) {
                setExecutionPhase('synthesizing');
                await api.initAgents(); // Must succeed
                await wait(2000);       // Visual pacing
            }

            // 2. Inject Custom Proposal if user has designed one
            if (name && selectedSources.length > 0) {
                setExecutionPhase('injecting');
                
                // Build the proposal payload
                const customProposal = buildProposalPayload();
                
                await api.injectProposal(customProposal);
                await wait(1500); // Visual pacing
            }

            // 3. Transmitting the start request
            setExecutionPhase('starting');

            // Only proceed to 'executing' state if the API call succeeds
            // Add minimum delay to prevent flashing state
            // We run these logically in parallel to minimize total wait, 
            // but Promise.all ensures we only proceed if api.startTradeLoop() does NOT throw.
            await Promise.all([
                api.startTradeLoop(),
                wait(1500)
            ]);

            // If we are here, BOTH (or all required) calls succeeded.

            // Briefly show success state before closing
            setExecutionPhase('executing');
            setExecutionComplete(true);

            onLaunchSuccess?.();
            await wait(1500); // Allow user to see the "Round Active" checkmark
            handleClose();
        } catch (error) {
            console.error("Failed to launch market:", error);
            const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
            setExecutionError(errorMessage);
            setIsExecuting(false);
            setExecutionPhase('initializing');
            
            // Auto-clear error after 5 seconds
            setTimeout(() => setExecutionError(null), 5000);
        }
    };

    // Helper function to build proposal payload from user input
    const buildProposalPayload = () => {
        // Generate description from conditions
        const conditionText = conditions
            .filter(c => c.source && c.value)
            .map((c, i) => {
                const source = selectedSources.find(s => s.ticker === c.source);
                const text = `${source?.name || c.source} (${c.source}) ${c.operator} ${c.value}`;
                return i < conditions.length - 1 ? `${text} ${c.connector || 'AND'}` : text;
            })
            .join(' ');

        const description = conditionText || `${name} will be evaluated based on selected data sources`;

        // Build evaluation logic (human readable)
        const evaluationLogic = conditions
            .filter(c => c.source && c.value)
            .map((c, i) => {
                const text = `${c.source} ${c.operator} ${c.value}`;
                return i < conditions.length - 1 ? `${text} ${c.connector || 'AND'}` : text;
            })
            .join(' ');

        // Build mathematical logic (machine readable)
        const mathematicalLogic = conditions
            .filter(c => c.source && c.value)
            .map((c, i) => {
                const text = `price ${c.operator} ${c.value}`;
                return i < conditions.length - 1 ? `${text} ${c.connector?.toLowerCase() || 'and'}` : text;
            })
            .join(' ');

        // Map selected sources to usedDataSources format
        const usedDataSources = selectedSources.map(source => {
            // Find matching condition for this source
            const condition = conditions.find(c => c.source === source.ticker);
            
            return {
                id: source.id,
                currentValue: parseFloat(source.price),
                targetValue: condition?.value ? parseFloat(condition.value) : parseFloat(source.price) * 1.1,
                operator: condition?.operator || '>'
            };
        });

        // Default resolution deadline: 24 hours from now
        const resolutionDeadline = Date.now() + (24 * 60 * 60 * 1000);

        return {
            name,
            description,
            evaluationLogic: evaluationLogic || `${name} evaluation`,
            mathematicalLogic: mathematicalLogic || 'price > 0',
            usedDataSources,
            resolutionDeadline,
            initialLiquidity: 2000
        };
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={handleClose}
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                    />

                    <motion.div
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative w-full max-w-lg bg-[#0a0a0c] border border-white/10 rounded-2xl overflow-hidden shadow-2xl flex flex-col"
                    >
                        {/* Status Overlay */}
                        <AnimatePresence>
                            {isExecuting && (
                                <motion.div
                                    initial={{ opacity: 0 }}
                                    animate={{ opacity: 1 }}
                                    className="absolute inset-0 z-[210] bg-[#0a0a0c]/98 flex flex-col items-center justify-center p-8 text-center"
                                >
                                    {executionComplete ? (
                                        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="space-y-4">
                                            <div className="w-12 h-12 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto">
                                                <Check className="w-6 h-6 text-emerald-500" strokeWidth={2} />
                                            </div>
                                            <div className="space-y-1">
                                                <h3 className="text-lg font-bold text-white tracking-tight uppercase">Round Active</h3>
                                                <p className="text-xs text-white/40">Market is live and agents are trading.</p>
                                            </div>
                                        </motion.div>
                                    ) : (
                                        <div className="space-y-6">
                                            <Loader2 className="w-8 h-8 text-emerald-500 animate-spin mx-auto" strokeWidth={1.5} />
                                            <div className="space-y-1.5">
                                                <h3 className="text-sm font-bold text-white tracking-widest uppercase">
                                                    {executionPhase === 'synthesizing'
                                                        ? 'Synthesizing Agents'
                                                        : executionPhase === 'injecting'
                                                            ? 'Injecting Custom Strategy'
                                                            : executionPhase === 'starting'
                                                                ? 'Connecting to Market'
                                                                : 'Initializing Round'}
                                                </h3>
                                                <p className="text-[9px] text-white/40 uppercase tracking-[0.2em]">
                                                    {executionPhase === 'synthesizing'
                                                        ? 'Generating specialized behaviors...'
                                                        : executionPhase === 'injecting'
                                                            ? 'Deploying custom proposal on-chain...'
                                                            : executionPhase === 'starting'
                                                                ? 'Synchronizing directives...'
                                                                : 'Broadcasting signals...'}
                                                </p>
                                            </div>
                                        </div>
                                    )}
                                </motion.div>
                            )}
                        </AnimatePresence>

                        {view === 'summary' ? (
                            /* REFINED SUMMARY VIEW (Synchronized with Dashboard) */
                            <div className="flex flex-col w-full p-6 sm:p-8">
                                <div className="flex items-center justify-between mb-8">
                                    <h2 className="text-[10px] font-black text-white/50 uppercase tracking-[0.2em]">Launch Interface</h2>
                                    <button onClick={handleClose} className="p-1.5 hover:bg-white/5 rounded-full transition-colors text-white/20 hover:text-white">
                                        <X className="w-5 h-5" />
                                    </button>
                                </div>

                                {/* Stats Grid - Synchronized with Dashboard scaling */}
                                <div className="grid grid-cols-3 gap-3 mb-6">
                                    <div className="bg-white/[0.03] border border-white/5 rounded-xl p-6 flex flex-col items-center justify-center gap-2 group hover:border-white/10 transition-all">
                                        <p className="text-[9px] font-black text-white/60 uppercase tracking-[0.15em] text-center">Active Agents</p>
                                        <p className="text-xl font-bold text-white tabular-nums">{activeAgentsCount}</p>
                                    </div>
                                    <div className="bg-white/[0.03] border border-white/5 rounded-xl p-6 flex flex-col items-center justify-center gap-2 group hover:border-white/10 transition-all">
                                        <p className="text-[9px] font-black text-white/60 uppercase tracking-[0.15em] text-center">Total Proposals</p>
                                        <p className="text-xl font-bold text-white tabular-nums">{currentProposalsCount}</p>
                                    </div>
                                    <div className="bg-white/[0.03] border border-white/5 rounded-xl p-6 flex flex-col items-center justify-center gap-2 group hover:border-white/10 transition-all">
                                        <p className="text-[9px] font-black text-white/60 uppercase tracking-[0.15em] text-center">
                                            {isExecutingTrades ? "Round Time" : "Round Duration"}
                                        </p>
                                        <p className="text-xl font-bold text-emerald-400 tabular-nums uppercase">
                                            {isExecutingTrades && roundStartTime && roundDuration && now ? (() => {
                                                const computedEndTime = roundStartTime + roundDuration;
                                                const diff = Math.min(roundDuration, Math.max(0, computedEndTime - now));
                                                const m = Math.floor(diff / 60000);
                                                const s = Math.floor((diff % 60000) / 1000);
                                                return m > 0 ? `${m}m ${s}s` : `${s}s`;
                                            })() : (roundDuration ? (() => {
                                                const dm = Math.floor(roundDuration / 60000);
                                                const ds = Math.floor((roundDuration % 60000) / 1000);
                                                return dm > 0 ? `${dm}m ${ds}s` : `${ds}s`;
                                            })() : '--')}
                                        </p>
                                    </div>
                                </div>

                                {/* Info Bar - Compacted */}
                                <div className="bg-[#121214]/40 border border-white/5 rounded-xl p-5 flex items-start gap-4 mb-8">
                                    <div className="shrink-0 pt-0.5">
                                        <Info className="w-4 h-4 text-white/30" />
                                    </div>
                                    <p className="text-[10px] sm:text-[11px] font-medium text-white/80 uppercase tracking-tight leading-relaxed">
                                        Confirming enters your proposal into the evaluation round. Agents start assessing strategic viability immediately.
                                    </p>
                                </div>

                                {/* Error Display */}
                                {executionError && (
                                    <motion.div
                                        initial={{ opacity: 0, y: -10 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        exit={{ opacity: 0 }}
                                        className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 flex items-start gap-3 mb-6"
                                    >
                                        <div className="shrink-0 pt-0.5">
                                            <X className="w-4 h-4 text-red-400" />
                                        </div>
                                        <div className="flex-1">
                                            <p className="text-[10px] font-bold text-red-400 uppercase tracking-widest mb-1">Execution Failed</p>
                                            <p className="text-[11px] text-red-300/80">{executionError}</p>
                                        </div>
                                        <button
                                            onClick={() => setExecutionError(null)}
                                            className="shrink-0 p-1 hover:bg-red-500/10 rounded transition-colors"
                                        >
                                            <X className="w-3 h-3 text-red-400/60 hover:text-red-400" />
                                        </button>
                                    </motion.div>
                                )}

                                {/* Injected Proposal Review (High Fidelity Reference) */}
                                {name && (
                                    <motion.div
                                        initial={{ opacity: 0, y: 5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className="relative mb-6 p-6 rounded-3xl bg-[#030704] border border-emerald-500/20 overflow-hidden group/proposal"
                                    >
                                        {/* Background Decor */}
                                        <Brain className="absolute -right-2 -top-2 w-32 h-32 text-emerald-500/[0.03] -rotate-12 pointer-events-none" />

                                        <div className="relative z-10 space-y-6">
                                            {/* Header */}
                                            <div className="flex justify-between items-start">
                                                <div className="space-y-1.5">
                                                    <p className="text-[10px] font-black italic text-emerald-500 uppercase tracking-[0.2em]">Strategic Proposal</p>
                                                    <h3 className="text-2xl font-black text-white tracking-tight truncate max-w-[280px]">{name}</h3>
                                                </div>
                                                <button
                                                    onClick={() => { setName(''); setSelectedSources([]); setConditions([{ source: '', operator: '>', value: '', connector: null }]); }}
                                                    className="p-1 px-2 rounded-md bg-white/5 border border-white/5 text-[9px] font-bold text-white/20 hover:text-white/60 hover:border-white/10 transition-all uppercase tracking-widest"
                                                >
                                                    Clear Proposal
                                                </button>
                                            </div>

                                            {/* Details Grid */}
                                            <div className="grid grid-cols-2 gap-8">
                                                <div className="space-y-2">
                                                    <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Logic Structure</p>
                                                    <p className="text-sm font-bold text-white/80 font-mono tracking-tight truncate">
                                                        {conditions.some(c => c.source && c.value)
                                                            ? conditions.map((c, i) => `${c.source} ${c.operator} ${c.value}${i < conditions.length - 1 ? ` ${c.connector || 'AND'} ` : ''}`).join('')
                                                            : 'Auto-Evaluated'
                                                        }
                                                    </p>
                                                </div>
                                                <div className="space-y-3">
                                                    <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest">Intelligence Sources</p>
                                                    <div className="flex gap-2">
                                                        {selectedSources.length > 0 ? selectedSources.map(s => (
                                                            <div key={s.id} className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center p-1.5">
                                                                <img src={s.icon} className="w-full h-full object-contain" alt={s.ticker} />
                                                            </div>
                                                        )) : (
                                                            <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center">
                                                                <Check className="w-4 h-4 text-white/20" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Resolution Window */}
                                            <div className="pt-2">
                                                <p className="text-[10px] font-bold text-white/20 uppercase tracking-widest mb-1.5">Resolution Window</p>
                                                <p className="text-[11px] font-bold text-emerald-500 uppercase tracking-widest">
                                                    24h • {new Date(Date.now() + 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, {new Date(Date.now() + 86400000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
                                                </p>
                                            </div>
                                        </div>
                                    </motion.div>
                                )}

                                <div className="flex flex-col gap-3">
                                    <button
                                        onClick={executeLaunch}
                                        className="w-full h-14 bg-white text-black rounded-xl font-bold text-xs uppercase tracking-[0.2em] hover:bg-emerald-50 active:scale-[0.99] transition-all flex items-center justify-center gap-2.5 shadow-xl"
                                    >
                                        <span className="mt-0.5">Execute Market</span>
                                        <ArrowRight className="w-4 h-4" />
                                    </button>

                                    <button
                                        onClick={() => setView('designer')}
                                        className={`w-full h-12 border border-dashed rounded-lg flex items-center justify-center gap-2 transition-all group ${name ? 'border-emerald-500/10 text-emerald-500/40 hover:text-emerald-500 hover:bg-emerald-500/[0.02]' : 'border-white/20 text-white/60 hover:text-emerald-50 hover:bg-white/[0.02]'}`}
                                    >
                                        {name ? <Check className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                                        <span className="text-[9px] font-bold uppercase tracking-widest text-inherit">
                                            {name ? 'Modify Custom Strategy' : 'Inject Custom Strategy'}
                                        </span>
                                    </button>
                                </div>
                            </div>
                        ) : (
                            /* DESIGNER VIEW (Applying refined dashboard aesthetic) */
                            <div className="flex flex-col w-full">
                                <div className="px-8 py-6 flex items-center justify-between border-b border-white/5">
                                    <div className="flex items-center gap-4">
                                        <button onClick={() => setView('summary')} className="p-1.5 -ml-1 text-white/20 hover:text-white transition-colors">
                                            <ArrowLeft className="w-4.5 h-4.5" />
                                        </button>
                                        <h2 className="text-sm font-bold text-white uppercase tracking-widest mt-0.5">Custom Strategy</h2>
                                    </div>
                                    <div className="text-[9px] font-black text-emerald-500/60 uppercase tracking-widest px-2.5 py-1 bg-emerald-500/5 border border-emerald-500/10 rounded-md">
                                        Step {step} / {TOTAL_STEPS}
                                    </div>
                                </div>

                                <div className="p-6 sm:p-12 pb-8 space-y-8 sm:space-y-16 min-h-[400px] sm:min-h-[440px]">
                                    <AnimatePresence mode="wait">
                                        <motion.div
                                            key={step}
                                            initial={{ opacity: 0, x: 5 }}
                                            animate={{ opacity: 1, x: 0 }}
                                            exit={{ opacity: 0, x: -5 }}
                                            className="space-y-12"
                                        >
                                            {step === 1 && (
                                                <div>
                                                    <label className="block text-[13px] font-bold text-white/50 uppercase tracking-[0.2em] mb-6">Strategy Label</label>
                                                    <input
                                                        type="text" autoFocus value={name} onChange={(e) => setName(e.target.value)}
                                                        placeholder="Name your proposal"
                                                        className="w-full bg-white/[0.04] border border-white/10 rounded-xl p-6 text-base text-white font-medium outline-none focus:border-white/30 focus:bg-white/[0.06] transition-all placeholder:text-white/10"
                                                    />
                                                </div>
                                            )}

                                            {step === 2 && (
                                                <div>
                                                    <label className="block text-[13px] font-bold text-white/50 uppercase tracking-[0.2em] mb-6">Market Sources</label>
                                                    <div className="grid grid-cols-2 gap-3 max-h-[320px] overflow-y-auto pr-2 custom-scrollbar">
                                                        {TRUSTED_DATA_SOURCES.map((s) => {
                                                            const isSelected = selectedSources.find(x => x.id === s.id);
                                                            return (
                                                                <button
                                                                    key={s.id}
                                                                    onClick={() => isSelected ? setSelectedSources(selectedSources.filter(x => x.id !== s.id)) : setSelectedSources([...selectedSources, s])}
                                                                    className={`flex items-center gap-3 p-3.5 rounded-xl border transition-all text-left group ${isSelected ? 'bg-white/5 border-white/20 text-white' : 'bg-white/[0.01] border-white/5 text-white/20 hover:border-white/10'}`}
                                                                >
                                                                    <div className="w-9 h-9 rounded-lg bg-black/40 flex items-center justify-center p-1.5 border border-white/10">
                                                                        <img src={s.icon} className="w-full h-full object-contain" alt={s.ticker} />
                                                                    </div>
                                                                    <span className="text-[12px] font-bold tracking-tight uppercase">{s.ticker}</span>
                                                                    {isSelected && <Check className="w-3.5 h-3.5 ml-auto text-emerald-500" strokeWidth={3} />}
                                                                </button>
                                                            );
                                                        })}
                                                    </div>
                                                </div>
                                            )}

                                            {step === 3 && (
                                                <div className="space-y-6">
                                                    <label className="block text-[13px] font-bold text-white/50 uppercase tracking-[0.2em]">Activation Logic</label>

                                                    {/* Condition Rows */}
                                                    <div className="space-y-4 max-h-[300px] overflow-y-auto pr-2 custom-scrollbar">
                                                        {conditions.map((cond, idx) => (
                                                            <div key={idx} className="space-y-3">
                                                                {/* Connector (AND/OR) - shown for rows after the first */}
                                                                {idx > 0 && (
                                                                    <div className="flex items-center gap-2 py-2">
                                                                        <div className="flex-1 h-px bg-white/5" />
                                                                        <div className="flex gap-1">
                                                                            {(['AND', 'OR'] as const).map(c => (
                                                                                <button
                                                                                    key={c}
                                                                                    onClick={() => {
                                                                                        const updated = [...conditions];
                                                                                        updated[idx - 1].connector = c;
                                                                                        setConditions(updated);
                                                                                    }}
                                                                                    className={`px-4 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${conditions[idx - 1]?.connector === c
                                                                                        ? 'bg-emerald-500/10 border border-emerald-500/30 text-emerald-400'
                                                                                        : 'bg-white/[0.02] border border-white/5 text-white/30 hover:text-white/60'
                                                                                        }`}
                                                                                >
                                                                                    {c}
                                                                                </button>
                                                                            ))}
                                                                        </div>
                                                                        <div className="flex-1 h-px bg-white/5" />
                                                                    </div>
                                                                )}

                                                                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 p-4 rounded-xl bg-white/[0.02] border border-white/5 group-hover/row:border-white/10 transition-colors relative">
                                                                    {/* Source Select */}
                                                                    <div className="flex-1 min-w-0">
                                                                        <Select
                                                                            value={cond.source}
                                                                            onValueChange={(value) => {
                                                                                const updated = [...conditions];
                                                                                updated[idx].source = value;
                                                                                setConditions(updated);
                                                                            }}
                                                                        >
                                                                            <SelectTrigger className="w-full bg-black/20 border-white/10 rounded-lg h-11 text-sm text-white font-medium focus:ring-0 focus:ring-offset-0">
                                                                                <SelectValue placeholder="Select Source" />
                                                                            </SelectTrigger>
                                                                            <SelectContent className="bg-[#0a0a0c] border-white/10">
                                                                                {selectedSources.map(s => (
                                                                                    <SelectItem key={s.id} value={s.ticker} className="text-white hover:bg-white/5 focus:bg-white/5 cursor-pointer">
                                                                                        <div className="flex items-center gap-2">
                                                                                            <img src={s.icon} className="w-4 h-4 object-contain" alt={s.ticker} />
                                                                                            <span>{s.ticker}</span>
                                                                                        </div>
                                                                                    </SelectItem>
                                                                                ))}
                                                                            </SelectContent>
                                                                        </Select>
                                                                    </div>

                                                                    <div className="flex items-center gap-2">
                                                                        {/* Operator Select */}
                                                                        <Select
                                                                            value={cond.operator}
                                                                            onValueChange={(value) => {
                                                                                const updated = [...conditions];
                                                                                updated[idx].operator = value;
                                                                                setConditions(updated);
                                                                            }}
                                                                        >
                                                                            <SelectTrigger className="w-[4.5rem] bg-black/20 border-white/10 rounded-lg h-11 text-sm font-mono text-emerald-400 font-bold justify-center focus:ring-0 focus:ring-offset-0 px-0">
                                                                                <SelectValue />
                                                                            </SelectTrigger>
                                                                            <SelectContent className="bg-[#0a0a0c] border-white/10 min-w-[4.5rem]">
                                                                                {['>', '<', '>=', '<=', '==', '!='].map(op => (
                                                                                    <SelectItem key={op} value={op} className="text-emerald-400 font-mono hover:bg-white/5 focus:bg-white/5 cursor-pointer justify-center">
                                                                                        {op}
                                                                                    </SelectItem>
                                                                                ))}
                                                                            </SelectContent>
                                                                        </Select>

                                                                        {/* Value Input */}
                                                                        <div className="relative flex-1 sm:flex-none">
                                                                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[9px] font-bold text-white/20 uppercase tracking-widest pointer-events-none">Val</span>
                                                                            <input
                                                                                type="number"
                                                                                value={cond.value}
                                                                                onChange={(e) => {
                                                                                    const updated = [...conditions];
                                                                                    updated[idx].value = e.target.value;
                                                                                    setConditions(updated);
                                                                                }}
                                                                                className="w-full sm:w-24 bg-black/20 border border-white/10 rounded-lg h-11 pl-9 pr-3 text-sm font-mono text-white outline-none focus:border-white/20 transition-all placeholder:text-white/10"
                                                                                placeholder="0"
                                                                            />
                                                                        </div>

                                                                        {/* Remove Row */}
                                                                        {conditions.length > 1 && (
                                                                            <button
                                                                                onClick={() => setConditions(conditions.filter((_, i) => i !== idx))}
                                                                                className="w-11 h-11 shrink-0 flex items-center justify-center rounded-lg bg-red-500/5 border border-red-500/10 text-red-500/40 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-all"
                                                                            >
                                                                                <X className="w-4 h-4" />
                                                                            </button>
                                                                        )}
                                                                    </div>
                                                                </div>
                                                            </div>
                                                        ))}
                                                    </div>

                                                    {/* Add Condition */}
                                                    <button
                                                        onClick={() => setConditions([...conditions, { source: '', operator: '>', value: '', connector: null }])}
                                                        className="w-full py-3 rounded-xl border border-dashed border-white/10 hover:border-emerald-500/20 text-white/30 hover:text-emerald-400 transition-all flex items-center justify-center gap-2 group"
                                                    >
                                                        <Plus className="w-4 h-4" />
                                                        <span className="text-[11px] font-bold uppercase tracking-widest">Add Condition</span>
                                                    </button>

                                                    {/* Preview */}
                                                    <div className="bg-white/[0.02] border border-white/5 rounded-xl p-4">
                                                        <p className="text-[9px] font-bold text-white/20 uppercase tracking-widest mb-2">Preview</p>
                                                        <p className="font-mono text-sm text-emerald-400/80">
                                                            {conditions.map((c, i) =>
                                                                `${c.source || '?'} ${c.operator} ${c.value || '?'}${i < conditions.length - 1 ? ` ${conditions[i].connector || 'AND'} ` : ''}`
                                                            ).join('')}
                                                        </p>
                                                    </div>
                                                </div>
                                            )}
                                        </motion.div>
                                    </AnimatePresence>
                                </div>

                                <div className="p-6 sm:p-12 pt-0 flex justify-between items-center mt-auto">
                                    <button
                                        onClick={() => setStep(s => s > 1 ? s - 1 : 1)}
                                        disabled={step === 1}
                                        className="text-[10px] font-bold text-white/10 uppercase tracking-widest hover:text-white transition-colors disabled:opacity-0"
                                    >
                                        Previous
                                    </button>
                                    <button
                                        onClick={() => step < TOTAL_STEPS ? setStep(s => s + 1) : setView('summary')}
                                        className="h-12 px-8 bg-white text-black rounded-xl text-[10px] font-bold uppercase tracking-[0.15em] hover:bg-emerald-50 active:scale-[0.98] transition-all shadow-xl"
                                    >
                                        {step === TOTAL_STEPS ? 'Ready' : 'Continue'}
                                    </button>
                                </div>
                            </div>
                        )}
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
