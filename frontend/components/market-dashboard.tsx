"use client";

import { useEffect, useMemo, useState } from "react";
import type { AppConfig, WalletConfig } from "@/lib/server-config";
import {
  type MarketView,
  type OracleCondition,
  type Position,
  buyShares,
  bytesToHex,
  collectPositionPayout,
  estimateSharesForBudget,
  createMarket,
  loadMarkets,
  loadPosition,
  loadSystemConfig,
  loadUsdcBalance,
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

type PricePoint = {
  at: number;
  yesBps: number;
  noBps: number;
};

type OracleAssetOption = {
  symbol: string;
  oracleContract: string;
  group: string;
};

type DraftCondition = {
  assetSymbol: string;
  oracleContract: string;
  comparator: "gte" | "lte";
  threshold: string;
  joinWithNext: "AND" | "OR";
};

const EXTERNAL_REFLECTOR_TESTNET = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const FIAT_REFLECTOR_TESTNET = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";

const ORACLE_ASSET_OPTIONS: OracleAssetOption[] = [
  { symbol: "BTC", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "ETH", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "USDT", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Stable" },
  { symbol: "XRP", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "SOL", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "USDC", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Stable" },
  { symbol: "ADA", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "AVAX", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "DOT", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "MATIC", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "LINK", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "DAI", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Stable" },
  { symbol: "ATOM", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "XLM", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "UNI", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Crypto" },
  { symbol: "EURC", oracleContract: EXTERNAL_REFLECTOR_TESTNET, group: "Stable" },
  { symbol: "EUR", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "GBP", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "CHF", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "CAD", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "MXN", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "ARS", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "BRL", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "THB", oracleContract: FIAT_REFLECTOR_TESTNET, group: "FX" },
  { symbol: "XAU", oracleContract: FIAT_REFLECTOR_TESTNET, group: "Commodity" },
];

function toUsdc(stroops: bigint) {
  return Number(stroops) / 10_000_000;
}

function formatShort(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-8)}`;
}

function formatPriceBps(bps: bigint) {
  return `${(Number(bps) / 100).toFixed(2)}%`;
}

function formatRelativeTime(timestamp: number) {
  const ageSeconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) {
    return `${ageSeconds}s ago`;
  }
  const minutes = Math.floor(ageSeconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function defaultDraftCondition(): DraftCondition {
  return {
    assetSymbol: "BTC",
    oracleContract: EXTERNAL_REFLECTOR_TESTNET,
    comparator: "gte",
    threshold: "500000000000",
    joinWithNext: "AND",
  };
}

function conditionFromAsset(symbol: string) {
  return ORACLE_ASSET_OPTIONS.find((option) => option.symbol === symbol) ?? ORACLE_ASSET_OPTIONS[0];
}

function draftToOracleCondition(condition: DraftCondition): OracleCondition {
  return {
    oracle_contract: condition.oracleContract,
    asset_symbol: condition.assetSymbol,
    greater_or_equal: condition.comparator === "gte",
    threshold: BigInt(condition.threshold),
  };
}

function formatComparator(greaterOrEqual: boolean) {
  return greaterOrEqual ? ">=" : "<=";
}

function describeCondition(condition: OracleCondition) {
  return `${condition.asset_symbol} ${formatComparator(condition.greater_or_equal)} ${condition.threshold.toString()}`;
}

function describeMarketLogic(view: MarketView) {
  if (view.config.oracle_conditions.length === 0) {
    return "No oracle conditions";
  }
  return view.config.oracle_conditions
    .map((condition, index) => {
      const connector = index < view.config.condition_operators.length
        ? view.config.condition_operators[index] ? " AND " : " OR "
        : "";
      return `${describeCondition(condition)}${connector}`;
    })
    .join("");
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
  const [priceHistory, setPriceHistory] = useState<Record<string, PricePoint[]>>({});
  const [system, setSystem] = useState<Awaited<ReturnType<typeof loadSystemConfig>> | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<bigint>(BigInt(0));
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [buyAmountUsdc, setBuyAmountUsdc] = useState("1");
  const [sellSharesAmount, setSellSharesAmount] = useState("1");
  const [question, setQuestion] = useState("Will BTC stay below $50,000 and ETH stay above $2,000 at resolution?");
  const [draftConditions, setDraftConditions] = useState<DraftCondition[]>([
    { ...defaultDraftCondition(), comparator: "lte" },
    {
      assetSymbol: "ETH",
      oracleContract: EXTERNAL_REFLECTOR_TESTNET,
      comparator: "gte",
      threshold: "20000000000",
      joinWithNext: "AND",
    },
  ]);
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
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);

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
        const wallet = walletFromConfig(config, walletLabel);
        const [sys, rows] = await Promise.all([
          loadSystemConfig(),
          loadMarketRows(walletLabel, config),
        ]);
        const balance = await loadUsdcBalance(wallet.publicKey, walletLabel);
        if (!mounted) {
          return;
        }
        setSystem(sys);
        setMarkets(rows);
        setUsdcBalance(balance);
        setPriceHistory((current) => mergeHistory(current, rows));
        setLastUpdatedAt(Date.now());
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

  useEffect(() => {
    const interval = window.setInterval(() => {
      void refreshMarkets();
    }, 5000);
    return () => window.clearInterval(interval);
  }, [walletLabel, config, selectedMarketId]);

  const selectedMarket = markets.find((market) => market.marketId === selectedMarketId) ?? null;
  const selectedHistory = selectedMarketId ? priceHistory[selectedMarketId] ?? [] : [];
  const liveYesPrice = selectedMarket ? formatPriceBps(selectedMarket.view.state.public_yes_quote_bps) : "--";
  const liveNoPrice = selectedMarket ? formatPriceBps(selectedMarket.view.state.public_no_quote_bps) : "--";
  const selectedMarketLogic = selectedMarket ? describeMarketLogic(selectedMarket.view) : "--";
  const selectedWallet = walletFromConfig(config, walletLabel);
  const selectedWalletTotalShares = selectedMarket
    ? toUsdc(selectedMarket.position.yes_shares + selectedMarket.position.no_shares).toFixed(4)
    : "0.0000";
  const buyAmountInStroops = useMemo(() => {
    const numeric = Number(buyAmountUsdc);
    if (!Number.isFinite(numeric) || numeric <= 0) {
      return BigInt(0);
    }
    return BigInt(Math.round(numeric * 10_000_000));
  }, [buyAmountUsdc]);
  const buyPreview = useMemo(() => {
    if (!selectedMarket || buyAmountInStroops <= BigInt(0)) {
      return null;
    }
    return {
      yesShares: estimateSharesForBudget(selectedMarket.view.state, "YES", buyAmountInStroops),
      noShares: estimateSharesForBudget(selectedMarket.view.state, "NO", buyAmountInStroops),
    };
  }, [selectedMarket, buyAmountInStroops]);
  const exceedsBalance = buyAmountInStroops > usdcBalance;
  const marketBias = useMemo(() => {
    if (!selectedMarket) {
      return "Balanced";
    }
    const yes = Number(selectedMarket.view.state.public_yes_quote_bps);
    const no = Number(selectedMarket.view.state.public_no_quote_bps);
    if (Math.abs(yes - no) < 40) {
      return "Balanced";
    }
    return yes > no ? "Leaning YES" : "Leaning NO";
  }, [selectedMarket]);

  async function refreshMarkets(nextSelectedMarketId?: string) {
    const wallet = walletFromConfig(config, walletLabel);
    const rows = await loadMarketRows(walletLabel, config);
    const balance = await loadUsdcBalance(wallet.publicKey, walletLabel);
    setMarkets(rows);
    setUsdcBalance(balance);
    setPriceHistory((current) => mergeHistory(current, rows));
    setLastUpdatedAt(Date.now());
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
        oracleConditions: draftConditions.map(draftToOracleCondition),
        conditionOperators: draftConditions.slice(0, -1).map((condition) => condition.joinWithNext === "AND"),
        endTimestamp: BigInt(endTimestamp),
        minBet: BigInt(minBet),
        maxBet: BigInt(maxBet),
        feeBps: Number(feeBps),
      });
      await refreshMarkets(marketId);
      setStatus(`Created market ${formatShort(marketId)} at ${result.hash}.`);
    });
  }

  function updateDraftCondition(index: number, next: Partial<DraftCondition>) {
    setDraftConditions((current) =>
      current.map((condition, currentIndex) =>
        currentIndex === index ? { ...condition, ...next } : condition,
      ),
    );
  }

  function addDraftCondition() {
    setDraftConditions((current) =>
      current.length >= 5 ? current : [...current, defaultDraftCondition()],
    );
  }

  function removeDraftCondition(index: number) {
    setDraftConditions((current) =>
      current.length === 1 ? current : current.filter((_, currentIndex) => currentIndex !== index),
    );
  }

  async function handleBuy(marketId: string, side: "YES" | "NO") {
    if (buyAmountInStroops > usdcBalance) {
      setError(
        `Insufficient USDC balance. ${walletLabel} has ${toUsdc(usdcBalance).toFixed(6)} USDC available.`,
      );
      return;
    }

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
                  {selectedWallet.publicKey}
                </div>
                <div className="mt-3 text-[11px] uppercase tracking-[0.2em] text-slate-500">USDC balance</div>
                <div className="mt-1 text-sm text-slate-100">{toUsdc(usdcBalance).toFixed(6)} USDC</div>
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
            {lastUpdatedAt ? (
              <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-slate-300">
                Updated {formatRelativeTime(lastUpdatedAt)}
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

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <EstimatePanel
                label="If you buy YES"
                value={buyPreview ? `${toUsdc(buyPreview.yesShares).toFixed(4)} YES shares` : "--"}
                detail={
                  buyPreview
                    ? exceedsBalance
                      ? `Need more than ${toUsdc(usdcBalance).toFixed(6)} USDC in this wallet`
                      : `for ${buyAmountUsdc} USDC at current LMSR curve`
                    : "Enter a buy amount"
                }
                tone="yes"
              />
              <EstimatePanel
                label="If you buy NO"
                value={buyPreview ? `${toUsdc(buyPreview.noShares).toFixed(4)} NO shares` : "--"}
                detail={
                  buyPreview
                    ? exceedsBalance
                      ? `Need more than ${toUsdc(usdcBalance).toFixed(6)} USDC in this wallet`
                      : `for ${buyAmountUsdc} USDC at current LMSR curve`
                    : "Enter a buy amount"
                }
                tone="no"
              />
            </div>

            <div className="mt-5 flex flex-wrap gap-3">
              <button
                disabled={busy !== null || exceedsBalance}
                onClick={() => {
                  void handleBuy(selectedMarketId, "YES");
                }}
                className="rounded-full bg-emerald-500 px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-60"
              >
                {busy === "buy-YES" ? "Buying..." : "Buy YES"}
              </button>
              <button
                disabled={busy !== null || exceedsBalance}
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
                <div className="mt-6 grid gap-3 sm:grid-cols-4">
                  <MetricPanel label="Live YES" value={liveYesPrice} tone="yes" />
                  <MetricPanel label="Live NO" value={liveNoPrice} tone="no" />
                  <MetricPanel label="Wallet exposure" value={`${selectedWalletTotalShares} shares`} tone="neutral" />
                  <MetricPanel label="Market bias" value={marketBias} tone="neutral" />
                </div>

                <div className="mt-6 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/70">
                  <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.24em] text-slate-500">Live Price Curve</div>
                      <div className="mt-1 text-sm text-slate-200">YES and NO quotes sampled from contract refreshes.</div>
                    </div>
                    <div className="text-xs text-slate-400">
                      {selectedHistory.length > 0 ? `${selectedHistory.length} points` : "Waiting for points"}
                    </div>
                  </div>
                  <div className="p-4">
                    <PriceChart points={selectedHistory} />
                  </div>
                </div>

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
                      <p className="mt-2 text-sm text-cyan-100/80">{selectedMarketLogic}</p>
                    </div>
                    <div className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1 text-xs font-semibold text-cyan-100">
                      {selectedMarket.view.state.resolved ? "Resolved" : "Running"}
                    </div>
                  </div>
                  <div className="mt-4 grid gap-3 text-sm text-slate-300 sm:grid-cols-2">
                    <InfoRow label="Total collateral" value={`${toUsdc(selectedMarket.view.state.total_committed).toFixed(2)} USDC`} />
                    <InfoRow label="YES quote" value={`${selectedMarket.view.state.public_yes_quote_bps} bps (${liveYesPrice})`} />
                    <InfoRow label="NO quote" value={`${selectedMarket.view.state.public_no_quote_bps} bps (${liveNoPrice})`} />
                    <InfoRow label="Ends at" value={new Date(Number(selectedMarket.view.config.end_timestamp) * 1000).toLocaleString()} />
                    <InfoRow label="YES outstanding" value={toUsdc(selectedMarket.view.state.yes_shares_outstanding).toFixed(4)} />
                    <InfoRow label="NO outstanding" value={toUsdc(selectedMarket.view.state.no_shares_outstanding).toFixed(4)} />
                    <InfoRow label="Outcome" value={selectedMarket.view.state.resolved ? (selectedMarket.view.state.outcome ? "YES" : "NO") : "Pending"} />
                    <InfoRow label="Winning pool" value={toUsdc(selectedMarket.view.state.winning_pool).toFixed(4)} />
                  </div>
                  {selectedMarket.view.state.resolved_conditions.length > 0 ? (
                    <div className="mt-4 grid gap-2">
                      {selectedMarket.view.state.resolved_conditions.map((condition, index) => (
                        <div
                          key={`${selectedMarketId}-resolved-${index}`}
                          className="rounded-xl border border-white/10 bg-slate-950/50 px-3 py-2 text-sm text-slate-300"
                        >
                          <span className="font-medium text-white">{describeCondition(condition)}</span>
                          {` | observed ${condition.observed_price.toString()} | ${condition.satisfied ? "true" : "false"}`}
                        </div>
                      ))}
                    </div>
                  ) : null}
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

                <div className="grid gap-3">
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em] text-slate-400">Oracle conditions</div>
                      <div className="mt-1 text-sm text-slate-500">Up to 5 conditions, evaluated left to right with AND / OR connectors.</div>
                    </div>
                    <button
                      type="button"
                      disabled={draftConditions.length >= 5}
                      onClick={addDraftCondition}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-100 disabled:opacity-50"
                    >
                      Add condition
                    </button>
                  </div>

                  {draftConditions.map((condition, index) => (
                    <div
                      key={`draft-condition-${index}`}
                      className="grid gap-3 rounded-2xl border border-white/10 bg-slate-950/50 p-4"
                    >
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Asset</span>
                          <select
                            value={condition.assetSymbol}
                            onChange={(event) => {
                              const nextAsset = conditionFromAsset(event.target.value);
                              updateDraftCondition(index, {
                                assetSymbol: nextAsset.symbol,
                                oracleContract: nextAsset.oracleContract,
                              });
                            }}
                            className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                          >
                            {ORACLE_ASSET_OPTIONS.map((option) => (
                              <option key={option.symbol} value={option.symbol}>
                                {option.symbol} · {option.group}
                              </option>
                            ))}
                          </select>
                        </label>

                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Comparator</span>
                          <select
                            value={condition.comparator}
                            onChange={(event) =>
                              updateDraftCondition(index, {
                                comparator: event.target.value as "gte" | "lte",
                              })
                            }
                            className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                          >
                            <option value="gte">Greater or equal</option>
                            <option value="lte">Less or equal</option>
                          </select>
                        </label>

                        <label className="grid gap-2">
                          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Threshold</span>
                          <input
                            value={condition.threshold}
                            onChange={(event) => updateDraftCondition(index, { threshold: event.target.value })}
                            className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                          />
                        </label>

                        <div className="flex items-end">
                          <button
                            type="button"
                            disabled={draftConditions.length === 1}
                            onClick={() => removeDraftCondition(index)}
                            className="w-full rounded-2xl border border-rose-400/20 bg-rose-400/10 px-4 py-3 text-sm font-medium text-rose-100 disabled:opacity-50"
                          >
                            Remove
                          </button>
                        </div>
                      </div>

                      {index < draftConditions.length - 1 ? (
                        <label className="grid gap-2 sm:max-w-xs">
                          <span className="text-xs uppercase tracking-[0.2em] text-slate-400">Connector to next</span>
                          <select
                            value={condition.joinWithNext}
                            onChange={(event) =>
                              updateDraftCondition(index, {
                                joinWithNext: event.target.value as "AND" | "OR",
                              })
                            }
                            className="rounded-2xl border border-white/10 bg-slate-900 px-4 py-3 text-sm text-slate-100 outline-none"
                          >
                            <option value="AND">AND</option>
                            <option value="OR">OR</option>
                          </select>
                        </label>
                      ) : null}

                      <div className="text-xs text-slate-500">
                        Oracle contract: <span className="font-mono">{condition.oracleContract}</span>
                      </div>
                    </div>
                  ))}
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
                        <div className="mt-2 text-sm text-slate-500">{describeMarketLogic(market.view)}</div>
                        <div className="mt-3 grid gap-2 text-sm text-slate-400 sm:grid-cols-2">
                          <div>YES quote: {formatPriceBps(market.view.state.public_yes_quote_bps)}</div>
                          <div>NO quote: {formatPriceBps(market.view.state.public_no_quote_bps)}</div>
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

function MetricPanel({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "yes" | "no" | "neutral";
}) {
  const className =
    tone === "yes"
      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
      : tone === "no"
        ? "border-rose-400/25 bg-rose-400/10 text-rose-100"
        : "border-white/10 bg-slate-900/70 text-slate-100";

  return (
    <div className={`rounded-2xl border p-4 ${className}`}>
      <div className="text-[11px] uppercase tracking-[0.24em] text-current/70">{label}</div>
      <div className="mt-2 text-xl font-semibold">{value}</div>
    </div>
  );
}

function EstimatePanel({
  label,
  value,
  detail,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  tone: "yes" | "no";
}) {
  const className =
    tone === "yes"
      ? "border-emerald-400/20 bg-emerald-400/8 text-emerald-100"
      : "border-rose-400/20 bg-rose-400/8 text-rose-100";

  return (
    <div className={`rounded-2xl border p-4 ${className}`}>
      <div className="text-[11px] uppercase tracking-[0.24em] text-current/70">{label}</div>
      <div className="mt-2 text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-current/70">{detail}</div>
    </div>
  );
}

function PriceChart({ points }: { points: PricePoint[] }) {
  if (points.length < 2) {
    return (
      <div className="flex h-60 items-center justify-center rounded-xl border border-dashed border-white/10 bg-slate-950/50 text-sm text-slate-500">
        Waiting for live quote history
      </div>
    );
  }

  const width = 760;
  const height = 240;
  const padding = 18;
  const minTime = points[0].at;
  const maxTime = points[points.length - 1].at;
  const timeSpan = Math.max(1, maxTime - minTime);

  const mapX = (point: PricePoint) =>
    padding + ((point.at - minTime) / timeSpan) * (width - padding * 2);
  const mapY = (bps: number) =>
    height - padding - (bps / 10000) * (height - padding * 2);

  const yesPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${mapX(point).toFixed(2)} ${mapY(point.yesBps).toFixed(2)}`)
    .join(" ");
  const noPath = points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${mapX(point).toFixed(2)} ${mapY(point.noBps).toFixed(2)}`)
    .join(" ");

  const latest = points[points.length - 1];

  return (
    <div className="space-y-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="h-60 w-full overflow-visible rounded-xl bg-[linear-gradient(180deg,rgba(15,23,42,0.65),rgba(2,6,23,0.95))]">
        {[2500, 5000, 7500].map((bps) => {
          const y = mapY(bps);
          return (
            <g key={bps}>
              <line x1={padding} y1={y} x2={width - padding} y2={y} stroke="rgba(148,163,184,0.18)" strokeDasharray="4 6" />
              <text x={width - padding + 4} y={y + 4} fill="rgba(148,163,184,0.75)" fontSize="10">
                {(bps / 100).toFixed(0)}%
              </text>
            </g>
          );
        })}
        <path d={yesPath} fill="none" stroke="rgb(52 211 153)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        <path d={noPath} fill="none" stroke="rgb(251 113 133)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={mapX(latest)} cy={mapY(latest.yesBps)} r="4" fill="rgb(52 211 153)" />
        <circle cx={mapX(latest)} cy={mapY(latest.noBps)} r="4" fill="rgb(251 113 133)" />
      </svg>
      <div className="flex flex-wrap gap-3 text-xs text-slate-300">
        <span className="inline-flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/10 px-3 py-1">
          <span className="h-2 w-2 rounded-full bg-emerald-400" />
          YES {formatPriceBps(BigInt(latest.yesBps))}
        </span>
        <span className="inline-flex items-center gap-2 rounded-full border border-rose-400/20 bg-rose-400/10 px-3 py-1">
          <span className="h-2 w-2 rounded-full bg-rose-400" />
          NO {formatPriceBps(BigInt(latest.noBps))}
        </span>
      </div>
    </div>
  );
}

function mergeHistory(history: Record<string, PricePoint[]>, rows: MarketRow[]) {
  const next = { ...history };
  const now = Date.now();

  for (const row of rows) {
    const point = {
      at: now,
      yesBps: Number(row.view.state.public_yes_quote_bps),
      noBps: Number(row.view.state.public_no_quote_bps),
    };
    const existing = next[row.marketId] ?? [];
    const last = existing[existing.length - 1];
    if (last && last.yesBps === point.yesBps && last.noBps === point.noBps) {
      continue;
    }
    next[row.marketId] = [...existing, point].slice(-48);
  }

  return next;
}
