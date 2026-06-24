"use client";

import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import type { AppConfig, WalletConfig } from "@/lib/server-config";

export type MarketConfig = {
  creator: string;
  question: string;
  target_price: bigint;
  end_timestamp: bigint;
  min_bet: bigint;
  max_bet: bigint;
  fee_bps: number;
};

export type MarketState = {
  total_committed: bigint;
  public_yes_quote_bps: bigint;
  public_no_quote_bps: bigint;
  yes_shares_outstanding: bigint;
  no_shares_outstanding: bigint;
  resolved: boolean;
  claims_finalized: boolean;
  outcome: boolean;
  outcome_price: bigint;
  distributable_pot: bigint;
  winning_pool: bigint;
  registered_claim_amount: bigint;
};

export type MarketView = {
  config: MarketConfig;
  state: MarketState;
};

export type SystemConfig = {
  admin: string;
  usdc_token: string;
  reflector_contract: string;
  commit_verifier: string;
  claim_verifier: string;
};

export type Position = {
  yes_shares: bigint;
  no_shares: bigint;
  claimed: boolean;
};

export type TransactionResult = {
  hash: string;
  returnValue: unknown;
};

function getGlobalConfig(): AppConfig {
  if (typeof window === "undefined") {
    throw new Error("stellar helpers must run in the browser");
  }

  const config = (window as Window & { __BLIND_MARKET_CONFIG__?: AppConfig }).__BLIND_MARKET_CONFIG__;
  if (!config) {
    throw new Error("missing browser config");
  }
  return config;
}

export function setBrowserConfig(config: AppConfig) {
  (window as Window & { __BLIND_MARKET_CONFIG__?: AppConfig }).__BLIND_MARKET_CONFIG__ = config;
}

function server() {
  const { rpcUrl } = getGlobalConfig();
  return new rpc.Server(rpcUrl);
}

function contractId() {
  return getGlobalConfig().contractId;
}

function networkPassphrase() {
  return getGlobalConfig().networkPassphrase;
}

function publicKeyFromWallet(wallet: WalletConfig) {
  return Keypair.fromSecret(wallet.secret).publicKey();
}

export function walletByLabel(label: string) {
  return getGlobalConfig().wallets.find((wallet) => wallet.label === label) ?? null;
}

export function walletPublicKey(label: string) {
  const wallet = walletByLabel(label);
  if (!wallet) {
    throw new Error(`unknown wallet: ${label}`);
  }
  return publicKeyFromWallet(wallet);
}

export function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string) {
  const clean = hex.replace(/^0x/i, "");
  if (clean.length % 2 !== 0) {
    throw new Error(`invalid hex string length: ${hex}`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function scValBytes(hex: string) {
  return nativeToScVal(Buffer.from(hexToBytes(hex)), { type: "bytes" });
}

function scValAddress(address: string) {
  return Address.fromString(address).toScVal();
}

function asBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value instanceof Uint8Array) return BigInt(`0x${bytesToHex(value)}`);
  throw new Error(`cannot convert ${String(value)} to bigint`);
}

function asHex(value: unknown) {
  if (typeof value === "string") {
    return value.replace(/^0x/i, "").toLowerCase();
  }
  if (value instanceof Uint8Array) {
    return bytesToHex(value).toLowerCase();
  }
  if (Array.isArray(value)) {
    return bytesToHex(Uint8Array.from(value)).toLowerCase();
  }
  throw new Error(`cannot convert ${String(value)} to hex`);
}

function normalizeMarketConfig(raw: any): MarketConfig {
  return {
    creator: String(raw.creator),
    question: String(raw.question),
    target_price: asBigInt(raw.target_price),
    end_timestamp: asBigInt(raw.end_timestamp),
    min_bet: asBigInt(raw.min_bet),
    max_bet: asBigInt(raw.max_bet),
    fee_bps: Number(raw.fee_bps),
  };
}

function normalizeMarketState(raw: any): MarketState {
  return {
    total_committed: asBigInt(raw.total_committed),
    public_yes_quote_bps: asBigInt(raw.public_yes_quote_bps),
    public_no_quote_bps: asBigInt(raw.public_no_quote_bps),
    yes_shares_outstanding: asBigInt(raw.yes_shares_outstanding),
    no_shares_outstanding: asBigInt(raw.no_shares_outstanding),
    resolved: Boolean(raw.resolved),
    claims_finalized: Boolean(raw.claims_finalized),
    outcome: Boolean(raw.outcome),
    outcome_price: asBigInt(raw.outcome_price),
    distributable_pot: asBigInt(raw.distributable_pot),
    winning_pool: asBigInt(raw.winning_pool),
    registered_claim_amount: asBigInt(raw.registered_claim_amount),
  };
}

function normalizeView(raw: any): MarketView {
  return {
    config: normalizeMarketConfig(raw.config),
    state: normalizeMarketState(raw.state),
  };
}

function normalizePosition(raw: any): Position {
  return {
    yes_shares: asBigInt(raw.yes_shares),
    no_shares: asBigInt(raw.no_shares),
    claimed: Boolean(raw.claimed),
  };
}

async function read<T = unknown>(method: string, args: xdr.ScVal[] = [], signerLabel = "admin"): Promise<T> {
  const wallet = getGlobalConfig().wallets.find((entry) => entry.label === signerLabel) ?? getGlobalConfig().wallets[0];
  const signer = publicKeyFromWallet(wallet);
  const contract = new Contract(contractId());
  const account = await server().getAccount(signer);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(60)
    .build();

  const prepared = await server().prepareTransaction(tx);
  const simulation = await server().simulateTransaction(prepared);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error ?? "simulation failed");
  }

  return scValToNative(simulation.result?.retval as xdr.ScVal) as T;
}

async function submit(
  method: string,
  args: xdr.ScVal[],
  wallet: WalletConfig,
): Promise<TransactionResult> {
  const contract = new Contract(contractId());
  const account = await server().getAccount(publicKeyFromWallet(wallet));
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await server().prepareTransaction(tx);
  prepared.sign(Keypair.fromSecret(wallet.secret));

  const sent = await server().sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  let got = await server().getTransaction(sent.hash);
  for (let i = 0; i < 60 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    got = await server().getTransaction(sent.hash);
  }

  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} did not succeed: ${got.status}`);
  }

  let returnValue: unknown = null;
  if (got.returnValue) {
    returnValue = scValToNative(got.returnValue);
  }

  return { hash: sent.hash, returnValue };
}

function bytes32ScVal(hex: string) {
  return scValBytes(hex);
}

export async function loadSystemConfig() {
  return read<SystemConfig>("get_system_config");
}

export async function loadMarketIds(signerLabel = "admin") {
  const packed = await read<unknown>("get_market_ids", [], signerLabel);
  const bytes = packed instanceof Uint8Array ? packed : hexToBytes(asHex(packed));
  const ids: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    ids.push(bytesToHex(bytes.slice(offset, offset + 32)));
  }
  return ids.filter((id) => id.length === 64);
}

export async function loadMarketView(marketId: string, signerLabel = "admin") {
  const raw = await read<any>("get_market_view", [bytes32ScVal(marketId)], signerLabel);
  return normalizeView(raw);
}

export async function loadMarkets(signerLabel = "admin") {
  const ids = await loadMarketIds(signerLabel);
  const views = await Promise.all(ids.map(async (marketId) => ({ marketId, view: await loadMarketView(marketId, signerLabel) })));
  return views;
}

export async function loadMarketConfig(marketId: string, signerLabel = "admin") {
  const raw = await read<any>("get_market_config", [bytes32ScVal(marketId)], signerLabel);
  return normalizeMarketConfig(raw);
}

export async function loadMarketState(marketId: string, signerLabel = "admin") {
  const raw = await read<any>("get_market_state", [bytes32ScVal(marketId)], signerLabel);
  return normalizeMarketState(raw);
}

export async function loadPosition(marketId: string, address: string, signerLabel = "admin") {
  const raw = await read<any>("get_position", [bytes32ScVal(marketId), scValAddress(address)], signerLabel);
  return normalizePosition(raw);
}

export async function createMarket(
  wallet: WalletConfig,
  input: {
    marketId: string;
    question: string;
    targetPrice: bigint;
    endTimestamp: bigint;
    minBet: bigint;
    maxBet: bigint;
    feeBps: number;
  },
) {
  return submit(
    "create_market",
    [
      scValAddress(publicKeyFromWallet(wallet)),
      bytes32ScVal(input.marketId),
      nativeToScVal(input.question, { type: "string" }),
      nativeToScVal(input.targetPrice, { type: "i128" }),
      nativeToScVal(input.endTimestamp, { type: "u64" }),
      nativeToScVal(input.minBet, { type: "i128" }),
      nativeToScVal(input.maxBet, { type: "i128" }),
      nativeToScVal(input.feeBps, { type: "u32" }),
    ],
    wallet,
  );
}

export async function buyShares(
  wallet: WalletConfig,
  input: {
    marketId: string;
    side: "YES" | "NO";
    amountInStroops: bigint;
    minSharesOut?: bigint;
  },
) {
  return submit(
    "buy",
    [
      bytes32ScVal(input.marketId),
      scValAddress(publicKeyFromWallet(wallet)),
      nativeToScVal(input.side === "YES"),
      nativeToScVal(input.amountInStroops, { type: "i128" }),
      nativeToScVal(input.minSharesOut ?? BigInt(1), { type: "i128" }),
    ],
    wallet,
  );
}

export async function sellShares(
  wallet: WalletConfig,
  input: {
    marketId: string;
    side: "YES" | "NO";
    shareAmount: bigint;
    minUsdcOut?: bigint;
  },
) {
  return submit(
    "sell",
    [
      bytes32ScVal(input.marketId),
      scValAddress(publicKeyFromWallet(wallet)),
      nativeToScVal(input.side === "YES"),
      nativeToScVal(input.shareAmount, { type: "i128" }),
      nativeToScVal(input.minUsdcOut ?? BigInt(1), { type: "i128" }),
    ],
    wallet,
  );
}

export async function resolveMarket(wallet: WalletConfig, marketId: string) {
  return submit("resolve", [bytes32ScVal(marketId)], wallet);
}

export async function collectPositionPayout(wallet: WalletConfig, marketId: string) {
  return submit(
    "collect_position",
    [bytes32ScVal(marketId), scValAddress(publicKeyFromWallet(wallet))],
    wallet,
  );
}
