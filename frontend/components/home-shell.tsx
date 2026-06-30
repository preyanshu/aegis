"use client";

import dynamic from "next/dynamic";
import type { AppConfig } from "@/lib/server-config";

const MarketDashboard = dynamic(
  () => import("@/components/market-dashboard").then((module) => module.MarketDashboard),
  { ssr: false },
);

type Props = {
  config: AppConfig;
};

export function HomeShell({ config }: Props) {
  return <MarketDashboard config={config} />;
}
