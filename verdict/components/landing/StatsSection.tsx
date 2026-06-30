"use client";

import { motion } from 'framer-motion';
import { CountingNumber } from "./CountingNumber";

const stats = [
    { label: 'REFLECTOR ASSETS SUPPORTED', value: 25, suffix: '' },
    { label: 'STELLAR VERIFICATION TARGET', value: 1, suffix: 'X' },
    { label: 'AGENTIC MARKET SURFACE', value: 24, suffix: '/7' },
];

export const StatsSection = () => (
    <section id="stats" className="py-20 lg:py-24 px-6 border-t border-white/5 bg-background">
        <div className="max-w-7xl mx-auto grid lg:grid-cols-2 gap-16 lg:gap-20">
            <motion.div
                initial={{ opacity: 0, x: -30 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.8 }}
                className="text-left"
            >
                <span className="text-primary text-sm font-medium mb-4 block tracking-wide uppercase">WHY IT MATTERS</span>
                <h2 className="text-4xl md:text-5xl font-bold mb-6 lg:mb-8 leading-tight text-white">A sharper fit for <br /> Stellar ZK</h2>
                <p className="text-gray-400 text-lg">Private positions, autonomous agents, Reflector-fed conditions, and a proof-verifiable settlement path on Stellar.</p>
            </motion.div>
            <div className="flex flex-col gap-10 justify-center">
                {stats.map((stat, i) => (
                    <motion.div
                        key={i}
                        initial={{ opacity: 0, x: 30 }}
                        whileInView={{ opacity: 1, x: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6, delay: i * 0.15 }}
                        className="flex items-baseline justify-between border-b border-white/10 pb-6 group hover:border-primary/50 transition-colors"
                    >
                        <span className="text-3xl md:text-5xl font-bold text-white group-hover:text-primary transition-colors">
                            <CountingNumber value={stat.value} suffix={stat.suffix} />
                        </span>
                        <span className="text-gray-500 uppercase text-sm tracking-wider ml-4 text-right">{stat.label}</span>
                    </motion.div>
                ))}
            </div>
        </div>
    </section>
);
