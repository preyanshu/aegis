"use client";

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";
import { FeatureCard } from "./FeatureCard";

export const FeaturesSection = () => (
    <section id="features" className="py-20 lg:py-32 px-6 max-w-7xl mx-auto">
        <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.8 }}
            className="flex flex-col lg:flex-row justify-between items-start lg:items-end mb-16 lg:mb-20 gap-8"
        >
            <div className="max-w-3xl">
                <span className="text-primary text-sm font-medium mb-4 block tracking-wider uppercase">WHY VERDICT?</span>
                <h2 className="text-4xl md:text-5xl lg:text-6xl font-bold leading-tight text-white">
                    A stronger hackathon story <br className="hidden md:block" /> than a generic dashboard
                </h2>
            </div>
            <div className="lg:mb-4 w-full lg:w-auto">
                <p className="text-gray-400 text-base max-w-sm mb-8 text-left">
                    This is a private, agentic prediction market where zero-knowledge and Stellar are both load-bearing parts of the product.
                </p>
                <motion.div whileHover={{ scale: 1.02 }} whileTap={{ scale: 0.98 }} className="w-fit">
                    <Link href="/dashboard">
                        <Button className="bg-secondary hover:bg-secondary/80 text-white h-14 px-8 rounded-2xl text-base font-semibold transition-colors flex items-center gap-2 border border-white/5 shadow-lg shadow-violet-900/20">
                            Explore the Market <ArrowRight className="w-5 h-5 ml-1" />
                        </Button>
                    </Link>
                </motion.div>
            </div>
        </motion.div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8 text-left">
            <FeatureCard
                index={0}
                title="Private Prediction Flow"
                desc="Users and agents can take positions without exposing full intent up front, which makes privacy the product rather than a feature checkbox."
                illustration={
                    <svg width="100%" height="100%" viewBox="0 0 240 100" fill="none">
                        <path d="M40 70 C 80 70, 100 20, 200 30" stroke="var(--primary)" strokeWidth="3" fill="none" strokeLinecap="round" />
                        <path d="M40 70 C 80 70, 100 20, 200 30" stroke="var(--primary)" strokeWidth="8" fill="none" strokeLinecap="round" opacity="0.1" />
                        <circle cx="200" cy="30" r="4" fill="var(--primary)" />
                        <rect x="20" y="20" width="40" height="3" rx="1.5" fill="white" fillOpacity="0.06" />
                        <rect x="20" y="28" width="20" height="3" rx="1.5" fill="var(--primary)" fillOpacity="0.3" />
                    </svg>
                }
            />
            <FeatureCard
                index={1}
                title="Agentic by Construction"
                desc="The interface is built around running agents, comparing behavior, and treating autonomous strategies as first-class market participants."
                illustration={
                    <svg width="100%" height="100%" viewBox="0 0 240 100" fill="none">
                        <circle cx="120" cy="50" r="25" stroke="var(--primary)" strokeOpacity="0.1" strokeWidth="1" fill="none" />
                        <circle cx="120" cy="50" r="8" fill="var(--primary)" />
                        {[0, 60, 120, 180, 240, 300].map((angle) => {
                            const x = 120 + 45 * Math.cos((angle * Math.PI) / 180);
                            const y = 50 + 45 * Math.sin((angle * Math.PI) / 180);
                            return (
                                <g key={angle}>
                                    <line x1="120" y1="50" x2={x} y2={y} stroke="var(--primary)" strokeOpacity="0.2" strokeWidth="1.5" />
                                    <circle cx={x} cy={y} r="4" fill="var(--card)" stroke="var(--primary)" strokeOpacity="0.2" strokeWidth="1" />
                                </g>
                            );
                        })}
                    </svg>
                }
            />
            <FeatureCard
                index={2}
                title="Real ZK on Stellar"
                desc="This project targets proof verification on Stellar contracts instead of just mentioning ZK in the deck or README."
                illustration={
                    <svg width="100%" height="100%" viewBox="0 0 240 100" fill="none">
                        <rect x="70" y="25" width="100" height="50" rx="12" fill="var(--primary)" fillOpacity="0.02" stroke="var(--primary)" strokeOpacity="0.1" strokeWidth="1" />
                        <path d="M105 50 L115 60 L135 40" stroke="var(--primary)" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
                        <rect x="85" y="38" width="30" height="2" rx="1" fill="white" fillOpacity="0.05" />
                        <rect x="85" y="60" width="40" height="2" rx="1" fill="white" fillOpacity="0.05" />
                    </svg>
                }
            />
            <FeatureCard
                index={3}
                wide
                title="Built for Real-World Assets and Outcomes"
                desc="Stellar is strongest when real money, stable assets, and verifiable settlement matter. Verdict fits that lane with oracle-driven markets and private execution."
                illustration={
                    <svg width="100%" height="100%" viewBox="0 0 540 300" fill="none">
                        <g transform="translate(60, 50)">
                            <rect x="0" y="0" width="180" height="200" rx="20" fill="var(--primary)" fillOpacity="0.03" stroke="var(--primary)" strokeWidth="2" />
                            <rect x="30" y="30" width="80" height="8" rx="4" fill="var(--primary)" />
                            <path d="M30 160 Q 90 120, 150 140" stroke="var(--primary)" strokeWidth="4" fill="none" strokeLinecap="round" />
                            <circle cx="150" cy="140" r="6" fill="var(--primary)" />
                        </g>
                        <g transform="translate(300, 70)">
                            <rect x="0" y="0" width="160" height="160" rx="20" fill="white" fillOpacity="0.01" stroke="white" strokeOpacity="0.06" strokeWidth="1" />
                            <rect x="25" y="25" width="60" height="6" rx="3" fill="white" fillOpacity="0.06" />
                            <path d="M25 130 Q 80 135, 135 125" stroke="white" strokeOpacity="0.06" strokeWidth="2" fill="none" strokeLinecap="round" />
                        </g>
                        <path d="M250 150 L290 150" stroke="var(--primary)" strokeOpacity="0.2" strokeWidth="2" strokeDasharray="6 6" />
                    </svg>
                }
            />
            <FeatureCard
                index={4}
                title="Reflector + Proof Verifiers"
                desc="Market conditions come from supported Reflector oracle routes, while the resolution story is framed around Noir and on-chain verification."
                illustration={
                    <svg width="100%" height="100%" viewBox="0 0 240 100" fill="none">
                        <rect x="100" y="30" width="40" height="40" rx="8" fill="var(--primary)" fillOpacity="0.02" stroke="var(--primary)" strokeWidth="1" />
                        <g opacity="0.3">
                            <line x1="20" y1="20" x2="90" y2="40" stroke="var(--primary)" strokeWidth="1" strokeDasharray="4 2" />
                            <line x1="20" y1="80" x2="90" y2="60" stroke="var(--primary)" strokeWidth="1" strokeDasharray="4 2" />
                            <circle cx="20" cy="20" r="3" fill="var(--primary)" />
                            <circle cx="20" cy="80" r="3" fill="var(--primary)" />
                        </g>
                        <g transform="translate(150, 40)">
                            <rect x="0" y="0" width="10" height="10" rx="2" fill="white" fillOpacity="0.06" />
                            <rect x="15" y="0" width="10" height="10" rx="2" fill="white" fillOpacity="0.04" />
                            <rect x="0" y="15" width="10" height="10" rx="2" fill="white" fillOpacity="0.02" />
                        </g>
                        <circle cx="120" cy="50" r="4" fill="var(--primary)" />
                    </svg>
                }
            />
        </div>
    </section>
);
