"use client";

import { useEffect, useState } from "react";
import type { AppConfig } from "@/lib/server-config";
import { generateClaimProof, generateCommitProof, generateReputationProof, verifyReputationProof } from "@/lib/proofs";
import { buildSnapshot, createClaimDescriptor } from "@/lib/reputation";
import {
  type MarketView,
  type OracleCondition,
  claimWinnings,
  commitPosition,
  createMarket,
  loadMarkets,
  loadSystemConfig,
  loadUsdcBalance,
  setBrowserConfig,
  walletByLabel,
  walletPublicKey,
} from "@/lib/stellar";

type Props = {
  config: AppConfig;
};

type LocalPosition = {
  marketId: string;
  marketQuestion: string;
  category: string;
  owner: string;
  side: "YES" | "NO";
  amountInStroops: string;
  salt: string;
  commitment: string;
  nullifier: string;
  claimTxHash?: string;
  claimedAt?: number;
};

type DraftCondition = {
  assetSymbol: string;
  oracleContract: string;
  comparator: "gte" | "lte";
  threshold: string;
  joinWithNext: "AND" | "OR";
};

const STORAGE_KEY = "blind-market-private-positions-v2";
const EXTERNAL_REFLECTOR_TESTNET = "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63";
const FIAT_REFLECTOR_TESTNET = "CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W";
const CATEGORY_OPTIONS = ["macro", "crypto", "eth-related", "fx", "commodities"];

const ORACLE_ASSET_OPTIONS = [
  { symbol: "BTC", oracleContract: EXTERNAL_REFLECTOR_TESTNET },
  { symbol: "ETH", oracleContract: EXTERNAL_REFLECTOR_TESTNET },
  { symbol: "SOL", oracleContract: EXTERNAL_REFLECTOR_TESTNET },
  { symbol: "XAU", oracleContract: FIAT_REFLECTOR_TESTNET },
  { symbol: "EUR", oracleContract: FIAT_REFLECTOR_TESTNET },
];

function toUsdc(stroops: bigint) {
  return Number(stroops) / 10_000_000;
}

function randomMarketId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  bytes[0] = 0;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

function loadSavedPositions() {
  if (typeof window === "undefined") {
    return [] as LocalPosition[];
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as LocalPosition[];
  } catch {
    return [];
  }
}

function savePositions(positions: LocalPosition[]) {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(positions, null, 2));
}

function draftToOracleCondition(condition: DraftCondition): OracleCondition {
  return {
    oracle_contract: condition.oracleContract,
    asset_symbol: condition.assetSymbol,
    greater_or_equal: condition.comparator === "gte",
    threshold: BigInt(condition.threshold),
  };
}

function formatTimestamp(timestamp: bigint) {
  if (timestamp === 0n) {
    return "not settled";
  }
  return new Date(Number(timestamp) * 1000).toLocaleString();
}

export function MarketDashboard({ config }: Props) {
  const [walletLabel, setWalletLabel] = useState(config.wallets[0].label);
  const [markets, setMarkets] = useState<Array<{ marketId: string; view: MarketView }>>([]);
  const [savedPositions, setSavedPositions] = useState<LocalPosition[]>(() => loadSavedPositions());
  const [usdcBalance, setUsdcBalance] = useState<bigint>(0n);
  const [status, setStatus] = useState("Privacy-safe market dashboard ready.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [selectedMarketId, setSelectedMarketId] = useState("");
  const [question, setQuestion] = useState("Will BTC remain below $50,000 by expiry?");
  const [category, setCategory] = useState("macro");
  const [draftConditions, setDraftConditions] = useState<DraftCondition[]>([defaultDraftCondition()]);
  const [endTimestamp, setEndTimestamp] = useState(() => Math.floor(Date.now() / 1000 + 7 * 24 * 60 * 60).toString());
  const [minBet, setMinBet] = useState("10000000");
  const [maxBet, setMaxBet] = useState("250000000");
  const [feeBps, setFeeBps] = useState("200");
  const [commitAmountUsdc, setCommitAmountUsdc] = useState("10");
  const [resolveWinningTotal, setResolveWinningTotal] = useState("0");
  const [backupJson, setBackupJson] = useState("");
  const [reputationCredential, setReputationCredential] = useState("");
  const [previewNow] = useState(() => Date.now());

  useEffect(() => {
    setBrowserConfig(config);
  }, [config]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const wallet = walletByLabel(walletLabel) ?? config.wallets[0];
        const [rows, balance] = await Promise.all([
          loadMarkets(walletLabel),
          loadUsdcBalance(wallet.publicKey, walletLabel),
          loadSystemConfig(),
        ]);
        if (cancelled) {
          return;
        }
        setMarkets(rows);
        setUsdcBalance(balance);
        if (!selectedMarketId && rows[0]) {
          setSelectedMarketId(rows[0].marketId);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [config, walletLabel, selectedMarketId]);

  const selectedMarket = markets.find((market) => market.marketId === selectedMarketId) ?? null;

  const walletPublic = walletPublicKey(walletLabel);
  const walletPositions = savedPositions.filter((position) => position.owner === walletPublic);
  const selectedMarketPositions = walletPositions.filter((position) => position.marketId === selectedMarketId);

  async function refreshMarkets() {
    const wallet = walletByLabel(walletLabel) ?? config.wallets[0];
    const [rows, balance] = await Promise.all([
      loadMarkets(walletLabel),
      loadUsdcBalance(wallet.publicKey, walletLabel),
    ]);
    setMarkets(rows);
    setUsdcBalance(balance);
  }

  function persistPositions(next: LocalPosition[]) {
    setSavedPositions(next);
    savePositions(next);
    setBackupJson(JSON.stringify(next, null, 2));
  }

  async function handleCreateMarket() {
    const wallet = walletByLabel(walletLabel);
    if (!wallet) {
      return;
    }

    setBusy("create");
    setError("");
    try {
      const marketId = randomMarketId();
      await createMarket(wallet, {
        marketId,
        question,
        category,
        oracleConditions: draftConditions.map(draftToOracleCondition),
        conditionOperators: draftConditions.slice(0, -1).map((condition) => condition.joinWithNext === "AND"),
        endTimestamp: BigInt(endTimestamp),
        minBet: BigInt(minBet),
        maxBet: BigInt(maxBet),
        feeBps: Number(feeBps),
      });
      await refreshMarkets();
      setSelectedMarketId(marketId);
      setStatus(`Created private ${category} market ${marketId.slice(0, 10)}…`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : String(createError));
    } finally {
      setBusy(null);
    }
  }

  async function handleCommit(side: "YES" | "NO") {
    if (!selectedMarket) {
      return;
    }
    const wallet = walletByLabel(walletLabel);
    if (!wallet) {
      return;
    }

    setBusy(`commit-${side}`);
    setError("");
    try {
      const proof = await generateCommitProof({
        marketId: selectedMarket.marketId,
        side,
        amountUsdc: Number(commitAmountUsdc),
        minBet: selectedMarket.view.config.min_bet,
        maxBet: selectedMarket.view.config.max_bet,
      });
      const tx = await commitPosition(wallet, {
        marketId: selectedMarket.marketId,
        owner: wallet.publicKey,
        commitment: proof.commitment,
        amountInStroops: proof.amountInStroops,
        proofHex: proof.proofHex,
      });

      const next = [
        ...savedPositions,
        {
          marketId: selectedMarket.marketId,
          marketQuestion: selectedMarket.view.config.question,
          category: selectedMarket.view.config.category,
          owner: wallet.publicKey,
          side,
          amountInStroops: proof.amountInStroops.toString(),
          salt: proof.salt,
          commitment: proof.commitment,
          nullifier: proof.nullifier,
        },
      ];
      persistPositions(next);
      await refreshMarkets();
      setStatus(`Committed hidden ${side} position. Save your backup before claiming later. Tx ${tx.hash.slice(0, 10)}…`);
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : String(commitError));
    } finally {
      setBusy(null);
    }
  }

  async function handleResolveMarket() {
    setError("Use the private tally finalize flow in the dashboard.");
  }

  async function handleClaim(position: LocalPosition) {
    const wallet = walletByLabel(walletLabel);
    if (!wallet) {
      return;
    }
    const market = markets.find((entry) => entry.marketId === position.marketId);
    if (!market || !market.view.state.resolved) {
      setError("market not resolved yet");
      return;
    }

    setBusy(`claim-${position.commitment}`);
    setError("");
    try {
      const claimProof = await generateClaimProof({
        marketId: position.marketId,
        side: position.side,
        amountInStroops: BigInt(position.amountInStroops),
        salt: position.salt,
        commitment: position.commitment,
        nullifier: position.nullifier,
        outcome: market.view.state.outcome,
        distributablePot: market.view.state.distributable_pot,
        winningSideTotal: market.view.state.winning_side_total,
      });
      const tx = await claimWinnings(wallet, {
        marketId: position.marketId,
        commitment: position.commitment,
        nullifier: position.nullifier,
        recipient: wallet.publicKey,
        proofHex: claimProof.proofHex,
      });

      const next = savedPositions.map((entry) => (
        entry.commitment === position.commitment
          ? { ...entry, claimTxHash: tx.hash, claimedAt: Date.now() }
          : entry
      ));
      persistPositions(next);
      await refreshMarkets();
      setStatus(`Claim submitted for ${position.commitment.slice(0, 10)}…`);
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : String(claimError));
    } finally {
      setBusy(null);
    }
  }

  function handleImportBackup() {
    try {
      const imported = JSON.parse(backupJson) as LocalPosition[];
      persistPositions(imported);
      setStatus(`Imported ${imported.length} private position records.`);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : String(importError));
    }
  }

  async function handleGenerateReputation() {
    const claimed = walletPositions.filter((position) => position.claimedAt);
    if (claimed.length === 0) {
      setError("claim at least one settled position first");
      return;
    }

    setBusy("reputation");
    setError("");
    try {
      const records = claimed.map((position) => {
        const market = markets.find((entry) => entry.marketId === position.marketId);
        const payout = market?.view.state.winning_side_total
          ? (BigInt(position.amountInStroops) * market.view.state.distributable_pot) / market.view.state.winning_side_total
          : 0n;
        return {
          marketId: position.marketId,
          subjectId: position.owner,
          category: position.category,
          resolvedAt: Number(market?.view.state.settled_at ?? 0n),
          claimedAt: Math.floor((position.claimedAt ?? Date.now()) / 1000),
          amountInStroops: position.amountInStroops,
          payoutInStroops: payout.toString(),
          won: market ? position.side === (market.view.state.outcome ? "YES" : "NO") : false,
        };
      });

      const serialized = await generateReputationProof({
        subjectId: walletPublic,
        category,
        windowDays: 90,
        descriptor: createClaimDescriptor({ claimType: "percentile", band: 25 }),
        records,
      });
      const verified = await verifyReputationProof(serialized);
      setReputationCredential(serialized);
      setStatus(`Generated ${verified.isValid ? "verified" : "unverified"} portable reputation credential.`);
    } catch (proofError) {
      setError(proofError instanceof Error ? proofError.message : String(proofError));
    } finally {
      setBusy(null);
    }
  }

  const previewSnapshot = buildSnapshot(
    walletPositions
      .filter((position) => position.claimedAt)
      .map((position) => ({
        marketId: position.marketId,
        subjectId: position.owner,
        category: position.category,
        resolvedAt: Math.floor((previewNow - 86_400_000) / 1000),
        claimedAt: Math.floor((position.claimedAt ?? previewNow) / 1000),
        amountInStroops: position.amountInStroops,
        payoutInStroops: position.amountInStroops,
        won: true,
      })),
    { category, subjectId: walletPublic, windowDays: 90 },
  );

  return (
    <main className="min-h-screen bg-[linear-gradient(180deg,#f6f1e8_0%,#efe8d9_45%,#e7dfce_100%)] px-4 py-8 text-stone-900">
      <div className="mx-auto max-w-6xl space-y-6">
        <section className="rounded-[28px] border border-stone-300 bg-white/75 p-6 shadow-[0_20px_60px_rgba(77,55,26,0.12)] backdrop-blur">
          <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.25em] text-stone-500">BlindMarket</p>
              <h1 className="font-serif text-4xl text-stone-900">Private positions, hidden flow, proof-backed reputation</h1>
              <p className="mt-2 max-w-2xl text-sm text-stone-600">
                Open markets reveal only privacy-safe metadata. Your side, size details, and claim secrets stay local until you decide to claim.
              </p>
            </div>
            <div className="grid gap-2 rounded-2xl bg-stone-900 px-4 py-3 text-sm text-stone-100">
              <label className="font-medium">Wallet</label>
              <select className="rounded-xl bg-stone-100 px-3 py-2 text-stone-900" value={walletLabel} onChange={(event) => setWalletLabel(event.target.value)}>
                {config.wallets.map((wallet) => (
                  <option key={wallet.label} value={wallet.label}>{wallet.label}</option>
                ))}
              </select>
              <span>USDC balance: {toUsdc(usdcBalance).toFixed(2)}</span>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
            <h2 className="font-serif text-2xl">Create a market</h2>
            <div className="mt-4 grid gap-3">
              <input className="rounded-2xl border border-stone-300 px-4 py-3" value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Question" />
              <select className="rounded-2xl border border-stone-300 px-4 py-3" value={category} onChange={(event) => setCategory(event.target.value)}>
                {CATEGORY_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
              <div className="grid gap-3 md:grid-cols-2">
                <input className="rounded-2xl border border-stone-300 px-4 py-3" value={endTimestamp} onChange={(event) => setEndTimestamp(event.target.value)} placeholder="End timestamp" />
                <input className="rounded-2xl border border-stone-300 px-4 py-3" value={feeBps} onChange={(event) => setFeeBps(event.target.value)} placeholder="Fee bps" />
                <input className="rounded-2xl border border-stone-300 px-4 py-3" value={minBet} onChange={(event) => setMinBet(event.target.value)} placeholder="Min bet stroops" />
                <input className="rounded-2xl border border-stone-300 px-4 py-3" value={maxBet} onChange={(event) => setMaxBet(event.target.value)} placeholder="Max bet stroops" />
              </div>
              {draftConditions.map((condition, index) => (
                <div key={`${condition.assetSymbol}-${index}`} className="grid gap-3 rounded-2xl border border-stone-200 bg-stone-50 p-4 md:grid-cols-4">
                  <select className="rounded-xl border border-stone-300 px-3 py-2" value={condition.assetSymbol} onChange={(event) => {
                    const option = ORACLE_ASSET_OPTIONS.find((entry) => entry.symbol === event.target.value) ?? ORACLE_ASSET_OPTIONS[0];
                    setDraftConditions((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, assetSymbol: option.symbol, oracleContract: option.oracleContract } : entry));
                  }}>
                    {ORACLE_ASSET_OPTIONS.map((option) => <option key={option.symbol} value={option.symbol}>{option.symbol}</option>)}
                  </select>
                  <select className="rounded-xl border border-stone-300 px-3 py-2" value={condition.comparator} onChange={(event) => {
                    setDraftConditions((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, comparator: event.target.value as "gte" | "lte" } : entry));
                  }}>
                    <option value="gte">&gt;=</option>
                    <option value="lte">&lt;=</option>
                  </select>
                  <input className="rounded-xl border border-stone-300 px-3 py-2" value={condition.threshold} onChange={(event) => {
                    setDraftConditions((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, threshold: event.target.value } : entry));
                  }} />
                  {index < draftConditions.length - 1 ? (
                    <select className="rounded-xl border border-stone-300 px-3 py-2" value={condition.joinWithNext} onChange={(event) => {
                      setDraftConditions((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, joinWithNext: event.target.value as "AND" | "OR" } : entry));
                    }}>
                      <option value="AND">AND</option>
                      <option value="OR">OR</option>
                    </select>
                  ) : (
                    <button className="rounded-xl border border-dashed border-stone-400 px-3 py-2 text-sm" onClick={() => setDraftConditions((current) => [...current, defaultDraftCondition()])}>Add condition</button>
                  )}
                </div>
              ))}
              <button className="rounded-2xl bg-stone-900 px-4 py-3 text-stone-100" disabled={busy === "create"} onClick={() => void handleCreateMarket()}>
                {busy === "create" ? "Creating..." : "Create private market"}
              </button>
            </div>
          </div>

          <div className="rounded-[28px] border border-stone-300 bg-stone-900 p-6 text-stone-100">
            <h2 className="font-serif text-2xl">Secret backup</h2>
            <p className="mt-3 text-sm text-stone-300">
              Commit salts and commitment metadata are your recovery material. Export after every position, and import here on a new browser before claiming.
            </p>
            <textarea className="mt-4 min-h-56 w-full rounded-2xl bg-stone-100 px-4 py-3 font-mono text-xs text-stone-900" value={backupJson || JSON.stringify(savedPositions, null, 2)} onChange={(event) => setBackupJson(event.target.value)} />
            <div className="mt-3 flex gap-3">
              <button className="rounded-2xl bg-amber-300 px-4 py-3 text-stone-900" onClick={handleImportBackup}>Import backup</button>
              <button className="rounded-2xl border border-stone-500 px-4 py-3" onClick={() => setBackupJson(JSON.stringify(savedPositions, null, 2))}>Refresh export</button>
            </div>
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
            <div className="flex items-center justify-between">
              <h2 className="font-serif text-2xl">Open and settled markets</h2>
              <button className="rounded-2xl border border-stone-300 px-4 py-2 text-sm" onClick={() => void refreshMarkets()}>Refresh</button>
            </div>
            <div className="mt-4 grid gap-3">
              {markets.map((market) => (
                <button
                  key={market.marketId}
                  className={`rounded-2xl border px-4 py-4 text-left ${market.marketId === selectedMarketId ? "border-stone-900 bg-stone-900 text-stone-100" : "border-stone-300 bg-stone-50"}`}
                  onClick={() => setSelectedMarketId(market.marketId)}
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.2em]">{market.view.config.category}</div>
                      <div className="mt-1 font-medium">{market.view.config.question}</div>
                    </div>
                    <div className="text-right text-sm">
                      <div>{market.view.state.resolved ? "Resolved" : "Open"}</div>
                      <div>Total pot: {toUsdc(market.view.state.total_locked_collateral).toFixed(2)} USDC</div>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
            <h2 className="font-serif text-2xl">Selected market</h2>
            {selectedMarket ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-2xl bg-stone-50 p-4 text-sm">
                  <div className="font-medium">{selectedMarket.view.config.question}</div>
                  <div className="mt-2">Category: {selectedMarket.view.config.category}</div>
                  <div>Commitments: {selectedMarket.view.state.commitment_count}</div>
                  <div>Total locked: {toUsdc(selectedMarket.view.state.total_locked_collateral).toFixed(2)} USDC</div>
                  {selectedMarket.view.state.resolved ? (
                    <>
                      <div>Outcome: {selectedMarket.view.state.outcome ? "YES" : "NO"}</div>
                      <div>Distributable pot: {toUsdc(selectedMarket.view.state.distributable_pot).toFixed(2)} USDC</div>
                      <div>Winning-side aggregate: {toUsdc(selectedMarket.view.state.winning_side_total).toFixed(2)} USDC</div>
                      <div>Settled at: {formatTimestamp(selectedMarket.view.state.settled_at)}</div>
                    </>
                  ) : (
                    <div>Open until {new Date(Number(selectedMarket.view.config.end_timestamp) * 1000).toLocaleString()}</div>
                  )}
                </div>

                {!selectedMarket.view.state.resolved ? (
                  <>
                    <input className="w-full rounded-2xl border border-stone-300 px-4 py-3" value={commitAmountUsdc} onChange={(event) => setCommitAmountUsdc(event.target.value)} placeholder="Commit amount (USDC)" />
                    <div className="grid grid-cols-2 gap-3">
                      <button className="rounded-2xl bg-emerald-600 px-4 py-3 text-white" disabled={busy === "commit-YES"} onClick={() => void handleCommit("YES")}>
                        {busy === "commit-YES" ? "Committing..." : "Commit hidden YES"}
                      </button>
                      <button className="rounded-2xl bg-rose-600 px-4 py-3 text-white" disabled={busy === "commit-NO"} onClick={() => void handleCommit("NO")}>
                        {busy === "commit-NO" ? "Committing..." : "Commit hidden NO"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="rounded-2xl border border-dashed border-stone-300 p-4 text-sm">
                    Only the winner-side aggregate is disclosed here. Losing-side totals remain hidden.
                  </div>
                )}

                <div className="rounded-2xl border border-stone-200 p-4">
                  <div className="mb-2 font-medium">Resolver controls</div>
                  <input className="w-full rounded-2xl border border-stone-300 px-4 py-3" value={resolveWinningTotal} onChange={(event) => setResolveWinningTotal(event.target.value)} placeholder="Winning-side total in stroops" />
                  <button className="mt-3 w-full rounded-2xl bg-stone-900 px-4 py-3 text-stone-100" disabled={busy === "resolve"} onClick={() => void handleResolveMarket()}>
                    {busy === "resolve" ? "Resolving..." : "Resolve with winner aggregate"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="mt-4 text-sm text-stone-600">Select a market to manage commitments or claim after settlement.</p>
            )}
          </div>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1.1fr,0.9fr]">
          <div className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
            <h2 className="font-serif text-2xl">Your hidden positions</h2>
            <div className="mt-4 grid gap-3">
              {selectedMarketPositions.length === 0 ? (
                <p className="text-sm text-stone-600">No local secret material saved for this market yet.</p>
              ) : selectedMarketPositions.map((position) => (
                <div key={position.commitment} className="rounded-2xl border border-stone-200 bg-stone-50 p-4 text-sm">
                  <div className="font-medium">{position.marketQuestion}</div>
                  <div className="mt-2">Commitment: {position.commitment.slice(0, 18)}…</div>
                  <div>Amount: {toUsdc(BigInt(position.amountInStroops)).toFixed(2)} USDC</div>
                  <div>Claim status: {position.claimedAt ? "Claimed" : "Waiting"}</div>
                  <button className="mt-3 rounded-2xl bg-amber-300 px-4 py-3 text-stone-900" disabled={busy === `claim-${position.commitment}`} onClick={() => void handleClaim(position)}>
                    {busy === `claim-${position.commitment}` ? "Claiming..." : "Generate claim proof and claim"}
                  </button>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
            <h2 className="font-serif text-2xl">Portable reputation</h2>
            <p className="mt-3 text-sm text-stone-600">
              Reputation is computed from claimed settled positions only, segmented by category and fixed windows.
            </p>
            <div className="mt-4 rounded-2xl bg-stone-50 p-4 text-sm">
              <div>Window preview: 90d</div>
              <div>Category: {previewSnapshot.category}</div>
              <div>Claimed records in scope: {previewSnapshot.records.length}</div>
            </div>
            <button className="mt-4 w-full rounded-2xl bg-stone-900 px-4 py-3 text-stone-100" disabled={busy === "reputation"} onClick={() => void handleGenerateReputation()}>
              {busy === "reputation" ? "Generating..." : "Generate top-25% 90d credential"}
            </button>
            <textarea className="mt-4 min-h-56 w-full rounded-2xl border border-stone-300 px-4 py-3 font-mono text-xs" value={reputationCredential} onChange={(event) => setReputationCredential(event.target.value)} placeholder="Portable credential appears here" />
          </div>
        </section>

        <section className="rounded-[28px] border border-stone-300 bg-white/85 p-6">
          <div className="font-medium text-stone-900">Status</div>
          <p className="mt-2 text-sm text-stone-700">{status}</p>
          {error ? <p className="mt-2 text-sm text-rose-700">{error}</p> : null}
        </section>
      </div>
    </main>
  );
}
