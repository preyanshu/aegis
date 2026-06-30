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
  category: string;
  oracle_conditions: OracleCondition[];
  condition_operators: boolean[];
  end_timestamp: bigint;
  min_bet: bigint;
  max_bet: bigint;
  fee_bps: number;
};

export type OracleCondition = {
  oracle_contract: string;
  asset_symbol: string;
  greater_or_equal: boolean;
  threshold: bigint;
};

export type ResolvedCondition = OracleCondition & {
  observed_price: bigint;
  observed_timestamp: bigint;
  satisfied: boolean;
};

export type MarketState = {
  total_locked_collateral: bigint;
  commitment_count: number;
  resolved: boolean;
  claims_finalized: boolean;
  tally_finalized: boolean;
  market_lifecycle: number;
  outcome: boolean;
  outcome_price: bigint;
  resolved_conditions: ResolvedCondition[];
  distributable_pot: bigint;
  winning_side_total: bigint;
  total_claimed_out: bigint;
  settled_at: bigint;
  tally_deadline: bigint;
  tallied_count: number;
  tally_commitment: string;
  aggregate_commitment: string;
  tallied_collateral_total: bigint;
  missed_tally_collateral: bigint;
  treasury_amount: bigint;
  yes_total: bigint;
  no_total: bigint;
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
  tally_update_verifier: string;
  tally_finalize_verifier: string;
  claim_verifier: string;
  shard_signer_1: string;
  shard_signer_2: string;
  shard_signer_3: string;
  shard_signer_4: string;
  shard_signer_5: string;
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
  return new rpc.Server(getGlobalConfig().rpcUrl);
}

function contractId() {
  return getGlobalConfig().contractId;
}

function tokenContractId() {
  return getGlobalConfig().usdcTokenId;
}

function networkPassphrase() {
  return getGlobalConfig().networkPassphrase;
}

function horizonUrl() {
  const { rpcUrl } = getGlobalConfig();
  return rpcUrl.includes("testnet") ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
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

function scValBool(value: boolean) {
  return xdr.ScVal.scvBool(value);
}

function scValMapEntry(key: string, val: xdr.ScVal) {
  return new xdr.ScMapEntry({
    key: xdr.ScVal.scvSymbol(key),
    val,
  });
}

function scValMap(entries: Array<[string, xdr.ScVal]>) {
  return xdr.ScVal.scvMap(
    entries
      .slice()
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, val]) => scValMapEntry(key, val)),
  );
}

function oracleConditionScVal(condition: OracleCondition) {
  return scValMap([
    ["asset_symbol", xdr.ScVal.scvSymbol(condition.asset_symbol)],
    ["greater_or_equal", scValBool(condition.greater_or_equal)],
    ["oracle_contract", scValAddress(condition.oracle_contract)],
    ["threshold", nativeToScVal(condition.threshold, { type: "i128" })],
  ]);
}

function oracleConditionsInputScVal(input: {
  conditionCount: number;
  condition1: OracleCondition;
  condition2: OracleCondition;
  condition3: OracleCondition;
  condition4: OracleCondition;
  condition5: OracleCondition;
  operator1IsAnd: boolean;
  operator2IsAnd: boolean;
  operator3IsAnd: boolean;
  operator4IsAnd: boolean;
}) {
  return scValMap([
    ["condition_1", oracleConditionScVal(input.condition1)],
    ["condition_2", oracleConditionScVal(input.condition2)],
    ["condition_3", oracleConditionScVal(input.condition3)],
    ["condition_4", oracleConditionScVal(input.condition4)],
    ["condition_5", oracleConditionScVal(input.condition5)],
    ["condition_count", nativeToScVal(input.conditionCount, { type: "u32" })],
    ["operator_1_is_and", scValBool(input.operator1IsAnd)],
    ["operator_2_is_and", scValBool(input.operator2IsAnd)],
    ["operator_3_is_and", scValBool(input.operator3IsAnd)],
    ["operator_4_is_and", scValBool(input.operator4IsAnd)],
  ]);
}

function asBigInt(value: unknown) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value instanceof Uint8Array) return BigInt(`0x${bytesToHex(value)}`);
  throw new Error(`cannot convert ${String(value)} to bigint`);
}

type ContractMap = Record<string, unknown>;

function normalizeOracleCondition(raw: ContractMap): OracleCondition {
  return {
    oracle_contract: String(raw.oracle_contract),
    asset_symbol: String(raw.asset_symbol),
    greater_or_equal: Boolean(raw.greater_or_equal),
    threshold: asBigInt(raw.threshold),
  };
}

function normalizeResolvedCondition(raw: ContractMap): ResolvedCondition {
  return {
    ...normalizeOracleCondition(raw),
    observed_price: asBigInt(raw.observed_price ?? 0),
    observed_timestamp: asBigInt(raw.observed_timestamp ?? 0),
    satisfied: Boolean(raw.satisfied),
  };
}

function normalizeMarketConfig(raw: ContractMap): MarketConfig {
  const count = Number(raw.condition_count ?? 0);
  return {
    creator: String(raw.creator),
    question: String(raw.question),
    category: String(raw.category),
    oracle_conditions: ([raw.condition_1, raw.condition_2, raw.condition_3, raw.condition_4, raw.condition_5] as ContractMap[])
      .slice(0, count)
      .map(normalizeOracleCondition),
    condition_operators: [raw.operator_1_is_and, raw.operator_2_is_and, raw.operator_3_is_and, raw.operator_4_is_and]
      .slice(0, Math.max(0, count - 1))
      .map((value: unknown) => Boolean(value)),
    end_timestamp: asBigInt(raw.end_timestamp),
    min_bet: asBigInt(raw.min_bet),
    max_bet: asBigInt(raw.max_bet),
    fee_bps: Number(raw.fee_bps),
  };
}

function normalizeMarketState(raw: ContractMap): MarketState {
  const resolvedCount = Number(raw.resolved_condition_count ?? 0);
  return {
    total_locked_collateral: asBigInt(raw.total_locked_collateral),
    commitment_count: Number(raw.commitment_count ?? 0),
    resolved: Boolean(raw.resolved),
    claims_finalized: Boolean(raw.claims_finalized),
    tally_finalized: Boolean(raw.tally_finalized),
    market_lifecycle: Number(raw.market_lifecycle ?? 0),
    outcome: Boolean(raw.outcome),
    outcome_price: asBigInt(raw.outcome_price),
    resolved_conditions: ([raw.resolved_condition_1, raw.resolved_condition_2, raw.resolved_condition_3, raw.resolved_condition_4, raw.resolved_condition_5] as ContractMap[])
      .slice(0, resolvedCount)
      .map(normalizeResolvedCondition),
    distributable_pot: asBigInt(raw.distributable_pot),
    winning_side_total: asBigInt(raw.winning_side_total),
    total_claimed_out: asBigInt(raw.total_claimed_out),
    settled_at: asBigInt(raw.settled_at ?? 0),
    tally_deadline: asBigInt(raw.tally_deadline ?? 0),
    tallied_count: Number(raw.tallied_count ?? 0),
    tally_commitment: raw.tally_commitment instanceof Uint8Array
      ? `0x${bytesToHex(raw.tally_commitment)}`
      : String(raw.tally_commitment ?? ""),
    aggregate_commitment: raw.aggregate_commitment instanceof Uint8Array
      ? `0x${bytesToHex(raw.aggregate_commitment)}`
      : String(raw.aggregate_commitment ?? ""),
    tallied_collateral_total: asBigInt(raw.tallied_collateral_total ?? 0),
    missed_tally_collateral: asBigInt(raw.missed_tally_collateral ?? 0),
    treasury_amount: asBigInt(raw.treasury_amount ?? 0),
    yes_total: asBigInt(raw.yes_total ?? 0),
    no_total: asBigInt(raw.no_total ?? 0),
  };
}

function normalizeView(raw: { config: ContractMap; state: ContractMap }): MarketView {
  return {
    config: normalizeMarketConfig(raw.config),
    state: normalizeMarketState(raw.state),
  };
}

async function readFromContract<T = unknown>(
  targetContractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  signerLabel = "admin",
): Promise<T> {
  const wallet = getGlobalConfig().wallets.find((entry) => entry.label === signerLabel) ?? getGlobalConfig().wallets[0];
  const account = await server().getAccount(publicKeyFromWallet(wallet));
  const contract = new Contract(targetContractId);
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

async function read<T = unknown>(method: string, args: xdr.ScVal[] = [], signerLabel = "admin") {
  return readFromContract<T>(contractId(), method, args, signerLabel);
}

async function submit(method: string, args: xdr.ScVal[], wallet: WalletConfig): Promise<TransactionResult> {
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
  for (let attempt = 0; attempt < 60 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    got = await server().getTransaction(sent.hash);
  }

  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    throw new Error(`transaction ${sent.hash} did not succeed: ${got.status}`);
  }

  return {
    hash: sent.hash,
    returnValue: got.returnValue ? scValToNative(got.returnValue) : null,
  };
}

function bytes32ScVal(hex: string) {
  return scValBytes(hex);
}

export async function loadSystemConfig() {
  return read<SystemConfig>("get_system_config");
}

export async function loadMarketIds(signerLabel = "admin") {
  const packed = await read<unknown>("get_market_ids", [], signerLabel);
  const bytes = packed instanceof Uint8Array ? packed : hexToBytes(String(packed));
  const ids: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    ids.push(bytesToHex(bytes.slice(offset, offset + 32)));
  }
  return ids.filter((id) => id.length === 64);
}

export async function loadMarketView(marketId: string, signerLabel = "admin") {
  const raw = await read<{ config: ContractMap; state: ContractMap }>("get_market_view", [bytes32ScVal(marketId)], signerLabel);
  return normalizeView(raw);
}

export async function loadMarkets(signerLabel = "admin") {
  const ids = await loadMarketIds(signerLabel);
  return Promise.all(ids.map(async (marketId) => ({ marketId, view: await loadMarketView(marketId, signerLabel) })));
}

export async function loadUsdcBalance(address: string, signerLabel = "admin") {
  const raw = await readFromContract<unknown>(tokenContractId(), "balance", [scValAddress(address)], signerLabel);
  return asBigInt(raw);
}

export async function loadXlmBalance(address: string) {
  const response = await fetch(`${horizonUrl()}/accounts/${address}`);
  if (!response.ok) {
    if (response.status === 404) {
      return "0";
    }
    throw new Error(`failed to load Stellar account ${address}: ${response.status}`);
  }

  const account = await response.json() as {
    balances?: Array<{ asset_type?: string; balance?: string }>;
  };
  return account.balances?.find((entry) => entry.asset_type === "native")?.balance ?? "0";
}

export async function createMarket(
  wallet: WalletConfig,
  input: {
    marketId: string;
    question: string;
    category: string;
    oracleConditions: OracleCondition[];
    conditionOperators: boolean[];
    endTimestamp: bigint;
    minBet: bigint;
    maxBet: bigint;
    feeBps: number;
  },
) {
  const paddedConditions = [...input.oracleConditions];
  while (paddedConditions.length < 5) {
    paddedConditions.push({
      oracle_contract: publicKeyFromWallet(wallet),
      asset_symbol: "NA",
      greater_or_equal: true,
      threshold: BigInt(0),
    });
  }

  return submit(
    "create_market",
    [
      scValAddress(publicKeyFromWallet(wallet)),
      bytes32ScVal(input.marketId),
      nativeToScVal(input.question, { type: "string" }),
      nativeToScVal(input.category, { type: "string" }),
      oracleConditionsInputScVal({
        conditionCount: input.oracleConditions.length,
        condition1: paddedConditions[0],
        condition2: paddedConditions[1],
        condition3: paddedConditions[2],
        condition4: paddedConditions[3],
        condition5: paddedConditions[4],
        operator1IsAnd: input.conditionOperators[0] ?? true,
        operator2IsAnd: input.conditionOperators[1] ?? true,
        operator3IsAnd: input.conditionOperators[2] ?? true,
        operator4IsAnd: input.conditionOperators[3] ?? true,
      }),
      nativeToScVal(input.endTimestamp, { type: "u64" }),
      nativeToScVal(input.minBet, { type: "i128" }),
      nativeToScVal(input.maxBet, { type: "i128" }),
      nativeToScVal(input.feeBps, { type: "u32" }),
    ],
    wallet,
  );
}

export async function commitPosition(
  wallet: WalletConfig,
  input: {
    marketId: string;
    owner: string;
    commitment: string;
    amountInStroops: bigint;
    proofHex: string;
  },
) {
  return submit(
    "commit_position",
    [
      bytes32ScVal(input.marketId),
      scValAddress(input.owner),
      bytes32ScVal(input.commitment),
      nativeToScVal(input.amountInStroops, { type: "i128" }),
      scValBytes(input.proofHex),
    ],
    wallet,
  );
}

export async function submitPrivateTally(
  wallet: WalletConfig,
  input: {
    marketId: string;
    commitment: string;
    previousTallyCommitment: string;
    nextTallyCommitment: string;
    shareCommitmentRoot: string;
    collateralAmount: bigint;
    proofHex: string;
  },
) {
  return submit(
    "submit_private_tally",
    [
      bytes32ScVal(input.marketId),
      bytes32ScVal(input.commitment),
      bytes32ScVal(input.nextTallyCommitment),
      bytes32ScVal(input.shareCommitmentRoot),
      scValBytes(input.proofHex),
    ],
    wallet,
  );
}

export async function finalizePrivateTally(
  wallet: WalletConfig,
  input: {
    marketId: string;
    yesTotal: bigint;
    noTotal: bigint;
    talliedCount: number;
    aggregateCommitment: string;
    shardSigners: [string, string, string];
  },
) {
  return submit(
    "finalize_private_tally",
    [
      bytes32ScVal(input.marketId),
      nativeToScVal(input.yesTotal, { type: "i128" }),
      nativeToScVal(input.noTotal, { type: "i128" }),
      nativeToScVal(input.talliedCount, { type: "u32" }),
      bytes32ScVal(input.aggregateCommitment),
      scValAddress(input.shardSigners[0]),
      scValAddress(input.shardSigners[1]),
      scValAddress(input.shardSigners[2]),
    ],
    wallet,
  );
}

export async function resolveMarket() {
  throw new Error("resolveMarket is deprecated; use submitPrivateTally and finalizePrivateTally");
}

export async function claimWinnings(
  wallet: WalletConfig,
  input: {
    marketId: string;
    commitment: string;
    nullifier: string;
    recipient: string;
    proofHex: string;
  },
) {
  return submit(
    "claim_winnings",
    [
      bytes32ScVal(input.marketId),
      bytes32ScVal(input.commitment),
      bytes32ScVal(input.nullifier),
      scValAddress(input.recipient),
      scValBytes(input.proofHex),
    ],
    wallet,
  );
}
