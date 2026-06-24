import { MarketDashboard } from "@/components/market-dashboard";
import { getAppConfig } from "@/lib/server-config";

export default function Home() {
  const config = getAppConfig();
  return <MarketDashboard config={config} />;
}
