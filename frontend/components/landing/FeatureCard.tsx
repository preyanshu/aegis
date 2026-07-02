"use client";

import { motion } from 'framer-motion';
import { Card } from "@/components/ui/card";
import { ArrowUpRight } from "lucide-react";
import React from 'react';

interface FeatureCardProps {
    title: string;
    desc: string;
    wide?: boolean;
    illustration: React.ReactNode;
    index: number;
}

export const FeatureCard = ({ title, desc, wide = false, illustration, index }: FeatureCardProps) => (
    <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, margin: "-100px" }}
        transition={{ duration: 0.6, delay: index * 0.1, ease: "easeOut" }}
        className={`${wide ? 'md:col-span-2' : 'md:col-span-1'} h-full`}
    >
        <Card className="h-full bg-card border-white/5 rounded-2xl relative overflow-hidden group hover:border-primary/30 transition-all duration-500 border flex flex-col">
            <div className={`flex flex-col h-full ${wide ? 'md:flex-row' : 'p-4'}`}>
                {/* Illustration Area */}
                <div className={`
          relative flex items-center justify-center overflow-hidden
          ${wide ? 'md:w-[60%] h-[240px] md:h-auto self-stretch' : 'w-full aspect-[16/9] rounded-2xl'}
        `}>
                    <motion.div
                        whileHover={{ y: -4, scale: 1.02 }}
                        transition={{ type: "spring", stiffness: 200, damping: 15 }}
                        className="w-full h-full"
                    >
                        {illustration}
                    </motion.div>
                </div>

                <div className={`flex flex-col justify-center flex-1 ${wide ? 'md:px-10 md:py-12 p-8' : 'px-3 pt-6 pb-2'}`}>
                    <h3 className="text-2xl font-bold mb-4 text-white tracking-tight leading-tight">{title}</h3>
                    <p className="text-sm text-gray-400 leading-relaxed font-light mb-8">{desc}</p>

                    {wide && (
                        <motion.div
                            whileHover={{ x: 5 }}
                            className="flex items-center gap-2 text-primary text-sm font-semibold tracking-wide cursor-pointer hover:underline group/link w-fit"
                        >
                            Learn more
                            <ArrowUpRight className="w-4 h-4 group-hover/link:-translate-y-0.5 group-hover/link:translate-x-0.5 transition-transform" />
                        </motion.div>
                    )}
                </div>
            </div>
        </Card>
    </motion.div>
);
