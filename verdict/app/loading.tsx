"use client";

import { Loader2 } from "lucide-react";
import { motion } from "framer-motion";

export default function Loading() {
    return (
        <div className="fixed inset-0 bg-[#050507] z-[9999] flex items-center justify-center">
            <div className="relative flex flex-col items-center gap-6">
                {/* Visual Glow behind the spinner */}
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-violet-500/20 blur-[60px] rounded-full" />

                <motion.div
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 0.5 }}
                    className="relative"
                >
                    <Loader2 className="w-12 h-12 text-violet-500 animate-spin" strokeWidth={1.5} />
                </motion.div>

                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2, duration: 0.5 }}
                    className="flex flex-col items-center gap-2"
                >
                    <span className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-500/60 ml-1">
                        Initializing
                    </span>
                    <h2 className="text-xl font-black text-white uppercase tracking-tighter">
                        Blind Market Protocol
                    </h2>
                    <p className="text-xs text-white/40 font-medium mt-4 max-w-md text-center px-4">
                        <span className="text-violet-500/80">Demo Mode:</span> Backend server is on a free cloud service. 
                        Initial request may take time due to server boot up.
                    </p>
                    <a 
                        href="https://youtu.be/tWkDE01Nmeo" 
                        target="_blank" 
                        rel="noopener noreferrer"
                        className="text-[10px] text-violet-400/80 hover:text-violet-400 font-medium mt-2 underline transition-colors"
                    >
                        Watch Demo Video →
                    </a>
                </motion.div>
            </div>
        </div>
    );
}
