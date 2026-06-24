"use client";

import { useEffect, useState } from "react";
import type { AppConfig, WalletConfig } from "@/lib/server-config";
import {
  type MarketView,
  type Position,
  buyShares,
  bytesToHex,
  collectPositionPayout,
  createMarket,
  loadMarkets,
  loadPosition,
  loadSystemConfig,
  resolveMarket,
  sellShares,
  setBrowserConfig,
} from "@/lib/stellar";

type Props = {
  config: AppConfig;
};

type MarketRow = {
  marketId: string;
  view: MarketView;
  position: Position;
};

function toUsdc(stroops: bigint) {
  return Number(stroops) / 10_000_000;
}

function formatShort(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function randomMarketId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

function walletFromConfig(config: AppConfig, label: string) {
  return config.wallets.find((wallet) => wallet.label === label) ?? config.wallets[0];
}

async function loadMarketRows(walletLabel: string, config: AppConfig): Promise<MarketRow[]> {
  const wallet = walletFromConfig(config, walletLabel);
  const views = await loadMarkets(walletLabel);
  const positions = await Promise.all(
    views.map(async ({ marketId }) => loadPosition(marketId, wallet.publicKey, walletLabel)),
  );
  return views.map((entry, index) => ({
    ...entry,
    position: positions[index],
  }));
}

export function MarketDashboard({ config }: Props) {
  const [walletLabel, setWalletLabel] = useState(config.wallets[0].label);
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [system, setSystem] = useState<Awaited<ReturnType<typeof loadSystemConfig>> | null>(null);
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [buyAmountUsdc, setBuyAmountUsdc] = useState("1");
  const [sellSharesAmount, setSellSharesAmount] = useState("1");
  const [question, setQuestion] = useState("Will BTC be above $50,000 on July 1, 2026?");
  const [targetPrice, setTargetPrice] = useState("500000000000");
  const [endTimestamp, setEndTimestamp] = useState(() => {
    const date = new Date();
    date.setDate(date.getDate() + 7);
    return Math.floor(date.getTime() / 1000).toString();
  });
  const [minBet, setMinBet] = useState("1000000");
  const [maxBet, setMaxBet] = useState("1000000000");
  const [feeBps, setFeeBps] = useState("200");
  const [status, setStatus] = useState("Ready.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    setBrowserConfig(config);
  }, [config]);

  useEffect(() => {
    if (!selectedMarketId && markets[0]) {
      setSelectedMarketId(markets[0].marketId);
    }
  }, [markets, selectedMarketId]);

  useEffect(() => {
    let mounted = true;
    void (async () => {
      try {
        const [sys, rows] = await Promise.all([
          loadSystemConfig(),
          loadMarketRows(walletLabel, config),
        ]);
        if (!mounted) {
          return;
        }
        setSystem(sys);
        setMarkets(rows);
        if (!selectedMarketId && rows[0]) {
          setSelectedMarketId(rows[0].marketId);
        }
        setStatus(`Loaded ${rows.length} market${rows.length === 1 ? "" : "s"} for ${walletLabel}.`);
      } catch (loadError) {
        if (!mounted) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : String(loadError));
      }
    })();
    return () => {
      mounted = false;
    };
  }, [config, walletLabel]);

  const selectedMarket = markets.find((market) => market.marketId === selectedMarketId) ?? null;

  async function refreshMarkets(nextSelectedMarketId?: string) {
    const rows = await loadMarketRows(walletLabel, config);
    setMarkets(rows);
    if (nextSelectedMarketId) {
      setSelectedMarketId(nextSelectedMarketId);
    } else if (!selectedMarketId && rows[0]) {
      setSelectedMarketId(rows[0].marketId);
    }
  }

  async function runAction(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    try {
      await action();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateMarket() {
    await runAction("create", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const marketId = randomMarketId();
      const result = await createMarket(wallet, {
        marketId,
        question,
        targetPrice: BigInt(targetPrice),
        endTimestamp: BigInt(endTimestamp),
        minBet: BigInt(minBet),
        maxBet: BigInt(maxBet),
        feeBps: Number(feeBps),
      });
      await refreshMarkets(marketId);
      setStatus(`Created market ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  async function handleBuy(marketId: string, side: "YES" | "NO") {
    await runAction(`buy-${side}`, async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await buyShares(wallet, {
        marketId,
        side,
        amountInStroops: BigInt(Math.round(Number(buyAmountUsdc) * 10_000_000)),
      });
      await refreshMarkets(marketId);
      setStatus(`Bought ${side} shares for ${buyAmountUsdc} USDC at ${result.hash}.`);
    });
  }

  async function handleSell(marketId: string, side: "YES" | "NO") {
    await runAction(`sell-${side}`, async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await sellShares(wallet, {
        marketId,
        side,
        shareAmount: BigInt(Math.round(Number(sellSharesAmount) * 10_000_000)),
      });
      await refreshMarkets(marketId);
      setStatus(`Sold ${sellSharesAmount} ${side} shares at ${result.hash}.`);
    });
  }

  async function handleResolve(marketId: string) {
    await runAction("resolve", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await resolveMarket(wallet, marketId);
      await refreshMarkets(marketId);
      setStatus(`Resolved ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  async function handleCollect(marketId: string) {
    await runAction("collect", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await collectPositionPayout(wallet, marketId);
      await refreshMarkets(marketId);
      setStatus(`Collected payout for ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top_left,_rgba(82,36,255,0.24),_transparent_35%),radial-gradient(circle_at_top_right,_rgba(0,212,255,0.16),_transparent_25%),linear-gradient(180deg,#07111f_0%,#09182d_48%,#050812_100%)] text-slate-100">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-8 px-6 py-8 lg:px-10">
        <section className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur">
          <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl">
              <p className="mb-3 inline-flex rounded-full border border-cyan-400/25 bg-cyan-400/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.3em] text-cyan-200">
                BlindMarket
              </p>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                Trade YES and NO shares directly on Stellar.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                Markets run in parallel, quotes move with open interest, and each wallet can keep adding to either side or
                unwind shares before resolution. The dashboard talks to the Soroban contract directly from the browser.
              </p>
            </div>

            <div className="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300 lg:min-w-[320px]">
              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Wallet</span>
                <select
                  value={walletLabel}
                  onChange={(event) => setWalletLabel(event.target.value)}
                  className="rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-slate-100 outline-none"
                >
                  {config.wallets.map((wallet) => (
                    <option key={wallet.label} value={wallet.label}>
                      {wallet.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="rounded-xl border border-white/10 bg-slate-900/80 p-3">
                <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Address</div>
                <div className="mt-1 break-all font-mono text-xs text-slate-200">
                  {walletFromConfig(config, walletLabel).publicKey}
                </div>
              </div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-3 text-sm">
            <button
              onClick={() => {
                void refreshMarkets(selectedMarketId);
              }}
              className="rounded-full border border-white/10 bg-white/5 px-4 py-2 font-medium text-slate-100 transition hover:bg-white/10"
            >
              Refresh markets
            </button>
            <div className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-4 py-2 text-emerald-200">
              {status}
            </div>
            {error ? (
              <div className="rounded-full border border-rose-400/20 bg-rose-400/10 px-4 py-2 text-rose-200">
                {error}
              </div>
            ) : null}
          </div>

          {system ? (
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <InfoRow label="Contract" value={config.contractId} />
              <InfoRow label="USDC token" value={system.usdc_token} />
              <InfoRow label="Reflector" value={system.reflector_contract} />
              <InfoRow label="Admin" value={system.admin} />
            </div>
          ) : null}
        </section>

        <section className="grid gap-6 xl:grid-cols-[1.2fr_0.8fr]">
          <div className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.25)] backdrop-blur">
            <div className="flex items-center justify-between gap-4">
              <div>
                <h2 className="text-xl font-semibold text-white">Selected market</h2>
                <p className="mt-1 text-sm text-slate-400">Buy more shares, hold both sides, or sell shares back before resolution.</p>
              </div>
              <button
                onClick={() => {
                  if (markets[0]) {
                    setSelectedMarketId(markets[0].marketId);
                  }
                }}
                className="rounded-full border border-white/10 bg-slate-900 px-4 py-2 text-sm text-slate-100"
              >
                Focus first
              </button>
            </div>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="grid gap-2 sm:col-span-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Market id</span>
                <input
                  value={selectedMarketId}
                  onChange={(event) => setSelectedMarketId(event.target.value.trim())}
                  placeholder="64 hex chars"
                  className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 font-mono text-sm text-slate-100 outline-none placeholder:text-slate-500"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Buy amount (USDC)</span>
                <input
                  value={buyAmountUsdc}
                  onChange={(event) => setBuyAmountUsdc(event.target.value)}
                  inputMode="decimal"
                  className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-slate-100 outline-none"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Sell shares</span>
                <input
                  value={sellSharesAmount}
                  onChange={(event) => setSellSharesAmount(event.target.value)}
                  inputMode="decimal"
                  className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-slate-100 outline-none"
                />
              </label>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleBuy(selectedMarketId, "YES");
                }}
                className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
              >
                {busy === "buy-YES" ? "Buying..." : "Buy YES"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleBuy(selectedMarketId, "NO");
                }}
                className="rounded-full bg-rose-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-rose-400 disabled:opacity-60"
              >
                {busy === "buy-NO" ? "Buying..." : "Buy NO"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleSell(selectedMarketId, "YES");
                }}
                className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-5 py-3 text-sm font-semibold text-emerald-100 transition hover:bg-emerald-400/20 disabled:opacity-60"
              >
                {busy === "sell-YES" ? "Selling..." : "Sell YES"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleSell(selectedMarketId, "NO");
                }}
                className="rounded-full border border-rose-400/20 bg-rose-400/10 px-5 py-3 text-sm font-semibold text-rose-100 transition hover:bg-rose-400/20 disabled:opacity-60"
              >
                {busy === "sell-NO" ? "Selling..." : "Sell NO"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleResolve(selectedMarketId);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                {busy === "resolve" ? "Resolving..." : "Resolve market"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleCollect(selectedMarketId);
                }}
                className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-5 py-3 text-sm font-semibold text-cyan-100 transition hover:bg-cyan-400/20 disabled:opacity-60"
              >
                {busy === "collect" ? "Collecting..." : "Collect payout"}
              </button>
            </div>

            {selectedMarket ? (
              <>
                <div className="mt-6 grid gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300 sm:grid-cols-3">
                  <InfoRow label="Your YES shares" value={toUsdc(selectedMarket.position.yes_shares).toFixed(4)} />
                  <InfoRow label="Your NO shares" value={toUsdc(selectedMarket.position.no_shares).toFixed(4)} />
                  <InfoRow label="Payout status" value={selectedMarket.position.claimed ? "Claimed" : "Open"} />
                </div>

                <div className="mt-6 rounded-2xl border border-cyan-400/20 bg-cyan-400/5 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-cyan-200/70">Current market</div>
                      <h3 className="mt-1 text-lg font-semibold text-white">{selectedMarket.view.config.question}</h3>
                    </div>
                    <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">
                      {selectedMarket.view.state.resolved ? "Resolved" : "Running"}
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                    <InfoRow label="Total collateral" value={`${toUsdc(selectedMarket.view.state.total_committed).toFixed(2)} USDC`} />
                    <InfoRow label="YES quote" value={`${selectedMarket.view.state.public_yes_quote_bps} bps`} />
                    <InfoRow label="NO quote" value={`${selectedMarket.view.state.public_no_quote_bps} bps`} />
                    <InfoRow label="Ends at" value={new Date(Number(selectedMarket.view.config.end_timestamp) * 1000).toLocaleString()} />
                    <InfoRow label="YES outstanding" value={toUsdc(selectedMarket.view.state.yes_shares_outstanding).toFixed(4)} />
                    <InfoRow label="NO outstanding" value={toUsdc(selectedMarket.view.state.no_shares_outstanding).toFixed(4)} />
                    <InfoRow label="Outcome" value={selectedMarket.view.state.resolved ? (selectedMarket.view.state.outcome ? "YES" : "NO") : "Pending"} />
                    <InfoRow label="Winning pool" value={toUsdc(selectedMarket.view.state.winning_pool).toFixed(4)} />
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="grid gap-6">
            <section className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.25)] backdrop-blur">
              <h2 className="text-xl font-semibold text-white">Create market</h2>
              <p className="mt-1 text-sm text-slate-400">Each market gets its own id and can run in parallel with every other market.</p>

              <div className="mt-5 grid gap-4">
                <label className="grid gap-2">
                  <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Question</span>
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    rows={3}
                    className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                  />
                </label>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="grid gap-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Target price</span>
                    <input
                      value={targetPrice}
                      onChange={(event) => setTargetPrice(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">End timestamp</span>
                    <input
                      value={endTimestamp}
                      onChange={(event) => setEndTimestamp(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Min trade</span>
                    <input
                      value={minBet}
                      onChange={(event) => setMinBet(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Max trade</span>
                    <input
                      value={maxBet}
                      onChange={(event) => setMaxBet(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                  <label className="grid gap-2 sm:col-span-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Fee bps</span>
                    <input
                      value={feeBps}
                      onChange={(event) => setFeeBps(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                </div>

                <button
                  disabled={busy !== null}
                  onClick={() => {
                    void handleCreateMarket();
                  }}
                  className="rounded-full bg-cyan-400 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 disabled:opacity-60"
                >
                  {busy === "create" ? "Creating..." : "Create market"}
                </button>
              </div>
            </section>

            <section className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.25)] backdrop-blur">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="text-xl font-semibold text-white">All markets</h2>
                  <p className="mt-1 text-sm text-slate-400">This wallet’s live YES / NO balances are fetched directly from the contract.</p>
                </div>
                <div className="text-sm text-slate-400">{markets.length} total</div>
              </div>

              <div className="mt-5 grid gap-4">
                {markets.map((market) => (
                  <article
                    key={market.marketId}
                    className="rounded-2xl border border-white/10 bg-slate-950/60 p-4 transition hover:border-cyan-400/20 hover:bg-slate-950"
                  >
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[11px] uppercase tracking-[0.24em] text-slate-400">
                            {market.view.state.resolved ? "Resolved" : "Running"}
                          </span>
                          <span className="font-mono text-xs text-slate-500">{formatShort(market.marketId)}</span>
                          {selectedMarketId === market.marketId ? (
                            <span className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-2 py-1 text-[11px] text-cyan-100">
                              Selected
                            </span>
                          ) : null}
                        </div>
                        <h3 className="mt-3 text-lg font-semibold text-white">{market.view.config.question}</h3>
                        <div className="mt-3 grid gap-2 text-sm text-slate-400 sm:grid-cols-2">
                          <div>YES quote: {market.view.state.public_yes_quote_bps} bps</div>
                          <div>NO quote: {market.view.state.public_no_quote_bps} bps</div>
                          <div>Collateral: {toUsdc(market.view.state.total_committed).toFixed(2)} USDC</div>
                          <div>Outcome: {market.view.state.resolved ? (market.view.state.outcome ? "YES" : "NO") : "pending"}</div>
                          <div>Your YES: {toUsdc(market.position.yes_shares).toFixed(4)}</div>
                          <div>Your NO: {toUsdc(market.position.no_shares).toFixed(4)}</div>
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2">
                        <button
                          onClick={() => setSelectedMarketId(market.marketId)}
                          className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100"
                        >
                          Open
                        </button>
                        <button
                          onClick={() => {
                            setSelectedMarketId(market.marketId);
                            void handleBuy(market.marketId, "YES");
                          }}
                          className="rounded-full bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
                        >
                          Buy YES
                        </button>
                        <button
                          onClick={() => {
                            setSelectedMarketId(market.marketId);
                            void handleBuy(market.marketId, "NO");
                          }}
                          className="rounded-full bg-rose-500 px-3 py-2 text-sm font-semibold text-slate-950"
                        >
                          Buy NO
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>
      </div>
    </main>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-white/10 bg-slate-900/70 p-3">
      <div className="text-[11px] uppercase tracking-[0.2em] text-slate-500">{label}</div>
      <div className="mt-1 text-sm text-slate-100">{value}</div>
    </div>
  );
}
