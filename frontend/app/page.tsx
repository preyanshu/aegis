import { getAppConfig } from "@/lib/server-config";
import { HomeShell } from "@/components/home-shell";

export default function Home() {
  try {
    const config = getAppConfig();
    return <HomeShell config={config} />;
  } catch (error) {
    return (
      <main className="min-h-screen bg-[linear-gradient(180deg,#f6f1e8_0%,#efe8d9_45%,#e7dfce_100%)] px-6 py-12 text-stone-900">
        <div className="mx-auto max-w-3xl rounded-[28px] border border-stone-300 bg-white/85 p-8 shadow-[0_20px_60px_rgba(77,55,26,0.12)]">
          <p className="text-sm uppercase tracking-[0.25em] text-stone-500">BlindMarket</p>
          <h1 className="mt-3 font-serif text-4xl">Environment setup required</h1>
          <p className="mt-4 text-sm text-stone-700">
            The dashboard builds successfully, but it needs Stellar demo environment variables before it can load live wallets and contracts.
          </p>
          <pre className="mt-6 overflow-x-auto rounded-2xl bg-stone-900 p-4 text-xs text-stone-100">
            {error instanceof Error ? error.message : String(error)}
          </pre>
        </div>
      </main>
    );
  }
}
