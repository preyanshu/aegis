"use client";

import { Navbar } from "@/components/landing/Navbar";
import { Hero } from "@/components/landing/Hero";
import { FeaturesSection } from "@/components/landing/FeaturesSection";
import { StatsSection } from "@/components/landing/StatsSection";
import { Footer } from "@/components/landing/Footer";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-background text-white font-sans overflow-x-hidden relative">
      <Navbar />
      <main>
        <Hero />
        <FeaturesSection />
        <StatsSection />
      </main>
      <Footer />
    </div>
  );
}