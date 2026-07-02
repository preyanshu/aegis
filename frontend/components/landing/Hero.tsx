"use client";

import Link from 'next/link';
import { motion } from 'framer-motion';
import { Button } from "@/components/ui/button";
import { ArrowRight, Play, Minus, X as XIcon } from "lucide-react";
import { FloatingTokens } from "./FloatingTokens";

export const Hero = () => (
    <section id="hero" className="relative pt-24 pb-16 px-6 w-full min-h-screen flex flex-col overflow-hidden">

        {/* --- Falling Violet Spotlight Beam Effect - Desktop Only --- */}
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1.5 }}
            className="hidden lg:block"
        >
            <div className="absolute top-[-200px] left-[85%] md:left-[72%] -translate-x-1/2 w-[150px] h-[900px] bg-white blur-[25px] pointer-events-none z-0 opacity-90" />
            <div className="absolute top-[-150px] left-[85%] md:left-[72%] -translate-x-1/2 w-[250px] h-[800px] bg-gradient-to-b from-white via-fuchsia-100/50 to-transparent blur-[40px] pointer-events-none z-0" />
            <div className="absolute top-[-100px] left-[85%] md:left-[72%] -translate-x-1/2 w-[400px] h-[750px] bg-gradient-to-b from-violet-300/50 via-fuchsia-400/30 to-transparent blur-[60px] pointer-events-none z-0 mix-blend-screen" />
            <div className="absolute top-[-50px] left-[85%] md:left-[72%] -translate-x-1/2 w-[800px] h-[700px] bg-gradient-to-b from-violet-500/20 via-fuchsia-600/10 to-transparent blur-[80px] pointer-events-none z-0" />
            <div className="absolute top-0 left-[85%] md:left-[72%] -translate-x-1/2 w-[1000px] h-[600px] bg-[radial-gradient(ellipse_at_top,var(--violet-glow)_0%,rgba(0,0,0,0)_70%)] pointer-events-none z-0" />
        </motion.div>

        {/* Subtle Text Glow for Mobile/Tablet */}
        <div className="lg:hidden absolute top-[15%] left-1/2 -translate-x-1/2 w-full max-w-[400px] h-[400px] bg-primary/10 blur-[120px] rounded-full pointer-events-none z-0" />

        {/* --- 3D Floor Grid --- */}
        <div
            className="absolute inset-0 z-0 pointer-events-none"
            style={{
                maskImage: 'linear-gradient(to bottom, transparent 0%, black 10%, black 80%, transparent 100%)'
            }}
        >
            <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 0.4 }}
                transition={{ duration: 2, delay: 0.5 }}
                className="absolute inset-0 mix-blend-screen"
                style={{
                    background: `
                  linear-gradient(transparent 99%, rgba(255, 255, 255, 0.15) 99%),
                  linear-gradient(90deg, transparent 99%, rgba(255, 255, 255, 0.15) 99%)
              `,
                    backgroundSize: '80px 80px',
                    transform: 'perspective(1200px) rotateX(60deg) translateY(200px) scale(2)',
                }}
            />
        </div>

        <div className="grid lg:grid-cols-2 gap-12 lg:gap-4 items-center relative z-10 flex-1 max-w-7xl mx-auto w-full mt-10 lg:-mt-20">
            <div className="space-y-6 pt-4 px-4 lg:pl-2 text-center lg:text-left">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2 }}
                >
                    <div className="flex items-center justify-center lg:justify-start gap-2 mb-6">
                        <span className="text-primary font-bold tracking-tighter text-lg">{'///'}</span>
                        <span className="text-white font-medium tracking-wide text-xs md:text-sm uppercase tracking-widest">
                            Private markets on Stellar
                        </span>
                    </div>
                </motion.div>
                <motion.h1
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.4 }}
                    className="text-[32px] md:text-5xl lg:text-6xl font-bold leading-[1.2] lg:leading-[1.1] tracking-tighter text-white"
                >
                    The most private <br />
                    <span className="text-transparent bg-clip-text bg-gradient-to-br from-white via-violet-100 to-violet-400">
                        prediction market stack
                    </span>
                </motion.h1>
                <motion.p
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.6 }}
                    className="text-gray-400 text-base md:text-lg max-w-md mx-auto lg:mx-0 leading-relaxed font-light"
                >
                    Hidden positions even after expiry. Dynamic oracle conditions. 5-node tallying. Private reputation.
                </motion.p>

                {/* --- Primary Button --- */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.8 }}
                    className="pt-4"
                >
                    <Link href="/dashboard">
                        <Button size="lg" className="group relative rounded-full font-bold text-black overflow-hidden shadow-[0_0_30px_var(--violet-glow)] text-lg h-14 px-10 bg-gradient-to-r from-violet-400 to-fuchsia-500 hover:from-violet-300 hover:to-fuchsia-400 border-none transition-all hover:scale-105 active:scale-95">
                            Launch
                            <ArrowRight className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" />
                        </Button>
                    </Link>
                </motion.div>
            </div>

            <div className="relative h-fit lg:h-full flex items-center justify-center mt-8 lg:mt-0">
                <motion.div
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ duration: 1.2, delay: 0.2 }}
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[250px] md:w-[400px] lg:w-[500px] h-[250px] md:h-[400px] lg:h-[500px] bg-primary/10 blur-[90px] rounded-full pointer-events-none"
                />
                <div className="w-full flex justify-center">
                    <FloatingTokens />
                </div>
            </div>
        </div>

        {/* Hero Features Footer */}
        <motion.div
            initial={{ opacity: 0, y: 50 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 1, duration: 0.8 }}
            className="relative lg:absolute bottom-0 left-0 right-0 z-20 w-full mb-8 mt-12 lg:mt-0"
        >
            <div className="flex flex-col lg:flex-row justify-between items-center lg:items-start gap-12 lg:gap-8 px-6 md:px-8 max-w-7xl mx-auto w-full">
                {[
                    {
                        title: 'Private by Default',
                        desc: 'Bet intent stays hidden. Only the final aggregate outcome surfaces after expiry and resolution.',
                        icon: Play
                    },
                    {
                        title: 'Dynamic Oracle Logic',
                        desc: 'Every market settles against its exact live data rule.',
                        icon: Minus
                    },
                    {
                        title: 'Proof-Backed Reputation',
                        desc: 'Turn real claims into attested private reputation.',
                        icon: XIcon
                    }
                ].map((f, i) => (
                    <div key={i} className="flex flex-col items-start text-left gap-2 group max-w-sm mx-auto lg:mx-0 w-fit">
                        <div className="flex items-center gap-3 mb-1">
                            <div className="relative flex items-center justify-center bg-white rounded-full p-1 shadow-[0_0_15px_rgba(255,255,255,0.3)] group-hover:shadow-[0_0_20px_var(--violet-glow)] transition-shadow">
                                <f.icon className="w-3 h-3 text-black fill-black" />
                            </div>
                            <h4 className="font-bold text-lg text-white tracking-tight group-hover:text-primary transition-colors">{f.title}</h4>
                        </div>
                        <p className="text-sm text-gray-400 leading-relaxed pl-9">{f.desc}</p>
                    </div>
                ))}
            </div>
        </motion.div>
    </section>
);
