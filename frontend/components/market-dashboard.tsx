"use client";

import { useEffect, useState } from "react";
import type { AppConfig, WalletConfig } from "@/lib/server-config";
import {
  type CommitData,
  type MarketView,
  bytesToHex,
  commitPosition,
  collectPayout,
  createMarket,
  finalizeClaims,
  loadMarkets,
  loadSystemConfig,
  registerWin,
  resolveMarket,
  setBrowserConfig,
} from "@/lib/stellar";
import { generateClaimProof, generateCommitProof } from "@/lib/proofs";

type Props = {
  config: AppConfig;
};

type MarketRow = {
  marketId: string;
  view: MarketView;
};

type StoredBet = CommitData & {
  claimTxHash?: string;
  collectTxHash?: string;
};

const BET_STORAGE_KEY = "blind-market-bets";

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

function loadStoredBets(): Record<string, StoredBet> {
  if (typeof window === "undefined") {
    return {};
  }
  try {
    return JSON.parse(window.localStorage.getItem(BET_STORAGE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveStoredBets(bets: Record<string, StoredBet>) {
  window.localStorage.setItem(BET_STORAGE_KEY, JSON.stringify(bets));
}

function betKey(walletLabel: string, marketId: string) {
  return `${walletLabel}:${marketId}`;
}

function walletFromConfig(config: AppConfig, label: string) {
  return config.wallets.find((wallet) => wallet.label === label) ?? config.wallets[0];
}

export function MarketDashboard({ config }: Props) {
  const [walletLabel, setWalletLabel] = useState(config.wallets[0].label);
  const [markets, setMarkets] = useState<MarketRow[]>([]);
  const [system, setSystem] = useState<Awaited<ReturnType<typeof loadSystemConfig>> | null>(null);
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [amountUsdc, setAmountUsdc] = useState("1");
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
  const [storedBets, setStoredBets] = useState<Record<string, StoredBet>>({});

  useEffect(() => {
    setBrowserConfig(config);
    setStoredBets(loadStoredBets());
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
          loadMarkets(walletLabel),
        ]);
        if (!mounted) {
          return;
        }
        setSystem(sys);
        setMarkets(rows);
        if (!selectedMarketId && rows[0]) {
          setSelectedMarketId(rows[0].marketId);
        }
        setStatus(`Loaded ${rows.length} market${rows.length === 1 ? "" : "s"}.`);
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
  }, [walletLabel]);

  const selectedMarket = markets.find((market) => market.marketId === selectedMarketId) ?? null;
  const selectedBet = selectedMarketId ? storedBets[betKey(walletLabel, selectedMarketId)] ?? null : null;

  async function refreshMarkets(nextSelectedMarketId?: string) {
    const rows = await loadMarkets(walletLabel);
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

  async function handleCommit(marketId: string, side: "YES" | "NO") {
    const market = markets.find((entry) => entry.marketId === marketId) ?? null;
    if (!market) {
      setError("pick a market first");
      return;
    }

    await runAction(`commit-${side}`, async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const marketConfig = market.view.config;
      const proof = await generateCommitProof({
        side,
        amountUsdc: Number(amountUsdc),
        minBet: marketConfig.min_bet,
        maxBet: marketConfig.max_bet,
      });
      const result = await commitPosition(wallet, {
        marketId,
        commitment: proof.commitment,
        proofHex: proof.proofHex,
        amountInStroops: proof.amountInStroops,
      });

      const record: StoredBet = {
        marketId,
        side,
        amountUsdc: Number(amountUsdc),
        amountInStroops: proof.amountInStroops.toString(),
        salt: proof.salt,
        commitment: proof.commitment,
        nullifier: proof.nullifier,
        txHash: result.hash,
        walletLabel,
      };
      const next = {
        ...storedBets,
        [betKey(walletLabel, marketId)]: record,
      };
      setStoredBets(next);
      saveStoredBets(next);
      await refreshMarkets(marketId);
      setStatus(`${side} commitment submitted for ${formatShort(marketId)}.`);
    });
  }

  async function handleResolve(marketId: string) {
    if (!markets.find((entry) => entry.marketId === marketId)) {
      setError("pick a market first");
      return;
    }

    await runAction("resolve", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await resolveMarket(wallet, marketId);
      await refreshMarkets(marketId);
      setStatus(`Resolved ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  async function handleRegisterWin(marketId: string) {
    const market = markets.find((entry) => entry.marketId === marketId) ?? null;
    if (!market) {
      setError("pick a market first");
      return;
    }

    const bet = storedBets[betKey(walletLabel, marketId)] ?? null;
    if (!bet) {
      setError("no saved bet found for this wallet and market");
      return;
    }

    await runAction("register", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const state = market.view.state;
      if (!state.resolved) {
        throw new Error("market is not resolved yet");
      }
      const proof = await generateClaimProof({
        side: bet.side,
        amountInStroops: BigInt(bet.amountInStroops),
        salt: bet.salt,
        commitment: bet.commitment,
        nullifier: bet.nullifier,
        outcome: state.outcome,
      });
      const result = await registerWin(wallet, {
        marketId,
        commitment: proof.commitment,
        amountInStroops: BigInt(bet.amountInStroops),
        nullifier: proof.nullifier,
        proofHex: proof.proofHex,
      });
      const next = {
        ...storedBets,
        [betKey(walletLabel, marketId)]: {
          ...bet,
          claimTxHash: result.hash,
        },
      };
      setStoredBets(next);
      saveStoredBets(next);
      await refreshMarkets(marketId);
      setStatus(`Registered ${bet.side} claim for ${formatShort(marketId)}.`);
    });
  }

  async function handleFinalize(marketId: string) {
    if (!markets.find((entry) => entry.marketId === marketId)) {
      setError("pick a market first");
      return;
    }

    await runAction("finalize", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await finalizeClaims(wallet, marketId);
      await refreshMarkets(marketId);
      setStatus(`Finalized claims for ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  async function handleCollect(marketId: string) {
    if (!markets.find((entry) => entry.marketId === marketId)) {
      setError("pick a market first");
      return;
    }

    const bet = storedBets[betKey(walletLabel, marketId)] ?? null;
    if (!bet) {
      setError("no saved bet found for this wallet and market");
      return;
    }

    await runAction("collect", async () => {
      const wallet = walletFromConfig(config, walletLabel);
      const result = await collectPayout(wallet, {
        marketId,
        nullifier: bet.nullifier,
      });
      const next = {
        ...storedBets,
        [betKey(walletLabel, marketId)]: {
          ...bet,
          collectTxHash: result.hash,
        },
      };
      setStoredBets(next);
      saveStoredBets(next);
      await refreshMarkets(marketId);
      setStatus(`Collected payout for ${formatShort(marketId)}.`);
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
                Parallel private prediction markets on Stellar.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-7 text-slate-300 sm:text-base">
                Create many markets, keep each market’s positions private, and still show the public YES / NO quote curve
                in real time. Everything here talks to the Soroban contract directly from the browser.
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
                <p className="mt-1 text-sm text-slate-400">Pick a live market or enter a new id to work against it.</p>
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
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Commit amount</span>
                <input
                  value={amountUsdc}
                  onChange={(event) => setAmountUsdc(event.target.value)}
                  inputMode="numeric"
                  className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-slate-100 outline-none"
                />
              </label>

              <label className="grid gap-2">
                <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Selected wallet</span>
                <select
                  value={walletLabel}
                  onChange={(event) => setWalletLabel(event.target.value)}
                  className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-slate-100 outline-none"
                >
                  {config.wallets.map((wallet) => (
                    <option key={wallet.label} value={wallet.label}>
                      {wallet.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleCommit(selectedMarketId, "YES");
                }}
                className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
              >
                {busy === "commit-YES" ? "Committing..." : "Buy YES shares"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleCommit(selectedMarketId, "NO");
                }}
                className="rounded-full bg-rose-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-rose-400 disabled:opacity-60"
              >
                {busy === "commit-NO" ? "Committing..." : "Buy NO shares"}
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
                  void handleRegisterWin(selectedMarketId);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                {busy === "register" ? "Registering..." : "Register win"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleFinalize(selectedMarketId);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                {busy === "finalize" ? "Finalizing..." : "Finalize claims"}
              </button>
              <button
                disabled={busy !== null}
                onClick={() => {
                  void handleCollect(selectedMarketId);
                }}
                className="rounded-full border border-white/10 bg-white/5 px-5 py-3 text-sm font-semibold text-slate-100 transition hover:bg-white/10 disabled:opacity-60"
              >
                {busy === "collect" ? "Collecting..." : "Collect payout"}
              </button>
            </div>

            <div className="mt-6 grid gap-3 rounded-2xl border border-white/10 bg-slate-950/60 p-4 text-sm text-slate-300">
              <div className="flex items-center justify-between gap-4">
                <span className="text-slate-400">Saved position</span>
                <span className="font-mono text-xs text-slate-200">
                  {selectedBet ? `${selectedBet.side} · ${selectedBet.amountUsdc} USDC` : "none"}
                </span>
              </div>
              <div className="grid gap-2 font-mono text-xs text-slate-400">
                <div>commitment: {selectedBet ? selectedBet.commitment : "none"}</div>
                <div>nullifier: {selectedBet ? selectedBet.nullifier : "none"}</div>
                <div>claim tx: {selectedBet?.claimTxHash ?? "pending"}</div>
                <div>collect tx: {selectedBet?.collectTxHash ?? "pending"}</div>
              </div>
            </div>

            {selectedMarket ? (
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
                  <InfoRow label="Total committed" value={`${toUsdc(selectedMarket.view.state.total_committed).toFixed(2)} USDC`} />
                  <InfoRow label="YES quote" value={`${selectedMarket.view.state.public_yes_quote_bps} bps`} />
                  <InfoRow label="NO quote" value={`${selectedMarket.view.state.public_no_quote_bps} bps`} />
                  <InfoRow label="Ends at" value={new Date(Number(selectedMarket.view.config.end_timestamp) * 1000).toLocaleString()} />
                  <InfoRow label="Min bet" value={`${toUsdc(selectedMarket.view.config.min_bet).toFixed(2)} USDC`} />
                  <InfoRow label="Max bet" value={`${toUsdc(selectedMarket.view.config.max_bet).toFixed(2)} USDC`} />
                  <InfoRow label="Outcome" value={selectedMarket.view.state.resolved ? (selectedMarket.view.state.outcome ? "YES" : "NO") : "Pending"} />
                  <InfoRow label="Claims" value={selectedMarket.view.state.claims_finalized ? "Finalized" : "Open"} />
                </div>
              </div>
            ) : null}
          </div>

          <div className="grid gap-6">
            <section className="rounded-3xl border border-white/10 bg-white/5 p-6 shadow-[0_30px_80px_rgba(0,0,0,0.25)] backdrop-blur">
              <h2 className="text-xl font-semibold text-white">Create market</h2>
              <p className="mt-1 text-sm text-slate-400">Any market can run in parallel with the others. This just mints another id.</p>

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
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Min bet</span>
                    <input
                      value={minBet}
                      onChange={(event) => setMinBet(event.target.value)}
                      className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                    />
                  </label>
                  <label className="grid gap-2">
                    <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Max bet</span>
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
                  <p className="mt-1 text-sm text-slate-400">Every market is live at the same time and stored separately on-chain.</p>
                </div>
                <div className="text-sm text-slate-400">{markets.length} total</div>
              </div>

              <div className="mt-5 grid gap-4">
                {markets.map((market) => {
                  const bet = storedBets[betKey(walletLabel, market.marketId)] ?? null;
                  return (
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
                            <div>Pot: {toUsdc(market.view.state.total_committed).toFixed(2)} USDC</div>
                            <div>Outcome: {market.view.state.resolved ? (market.view.state.outcome ? "YES" : "NO") : "pending"}</div>
                          </div>
                          {bet ? (
                            <div className="mt-3 rounded-xl border border-emerald-400/20 bg-emerald-400/10 p-3 text-xs text-emerald-100">
                              Saved {bet.side} position for this wallet. Commitment is local only: {formatShort(bet.commitment)}
                            </div>
                          ) : null}
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
                              void handleCommit(market.marketId, "YES");
                            }}
                            className="rounded-full bg-emerald-500 px-3 py-2 text-sm font-semibold text-slate-950"
                          >
                            Buy YES
                          </button>
                          <button
                            onClick={() => {
                              setSelectedMarketId(market.marketId);
                              void handleCommit(market.marketId, "NO");
                            }}
                            className="rounded-full bg-rose-500 px-3 py-2 text-sm font-semibold text-slate-950"
                          >
                            Buy NO
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
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
