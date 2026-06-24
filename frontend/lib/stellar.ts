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
  total_committed: bigint;
  public_yes_quote_bps: bigint;
  public_no_quote_bps: bigint;
  yes_shares_outstanding: bigint;
  no_shares_outstanding: bigint;
  resolved: boolean;
  claims_finalized: boolean;
  outcome: boolean;
  outcome_price: bigint;
  resolved_conditions: ResolvedCondition[];
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

const QUOTE_SCALE_BPS = BigInt(10_000);
const LMSR_MIN_BPS = BigInt(1);
const LMSR_MAX_BPS = BigInt(9_999);
const LMSR_X_MIN = BigInt(-4_000);
const LMSR_X_MAX = BigInt(4_000);
const LMSR_STEP = BigInt(250);
const LMSR_LIQUIDITY_PARAM = BigInt(10_000_000);
const TRADE_SLICE = BigInt(100_000);
const LMSR_PRICE_TABLE = [
  BigInt(180), BigInt(230), BigInt(293), BigInt(373), BigInt(474), BigInt(601), BigInt(759), BigInt(953),
  BigInt(1192), BigInt(1480), BigInt(1824), BigInt(2227), BigInt(2689), BigInt(3208), BigInt(3775), BigInt(4378),
  BigInt(5000), BigInt(5622), BigInt(6225), BigInt(6792), BigInt(7311), BigInt(7773), BigInt(8176), BigInt(8520),
  BigInt(8808), BigInt(9047), BigInt(9241), BigInt(9399), BigInt(9526), BigInt(9627), BigInt(9707), BigInt(9770),
  BigInt(9820),
] as const;

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

function tokenContractId() {
  return getGlobalConfig().usdcTokenId;
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

function scValVec(items: xdr.ScVal[]) {
  return xdr.ScVal.scvVec(items);
}

function scValSymbol(value: string) {
  return xdr.ScVal.scvSymbol(value);
}

function scValBool(value: boolean) {
  return xdr.ScVal.scvBool(value);
}

function scValMapEntry(key: string, val: xdr.ScVal) {
  return new xdr.ScMapEntry({
    key: scValSymbol(key),
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
    ["oracle_contract", scValAddress(condition.oracle_contract)],
    ["asset_symbol", scValSymbol(condition.asset_symbol)],
    ["greater_or_equal", scValBool(condition.greater_or_equal)],
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
    ["condition_count", nativeToScVal(input.conditionCount, { type: "u32" })],
    ["condition_1", oracleConditionScVal(input.condition1)],
    ["condition_2", oracleConditionScVal(input.condition2)],
    ["condition_3", oracleConditionScVal(input.condition3)],
    ["condition_4", oracleConditionScVal(input.condition4)],
    ["condition_5", oracleConditionScVal(input.condition5)],
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
  const count = Number(raw.condition_count ?? 0);
  const conditions = [
    raw.condition_1,
    raw.condition_2,
    raw.condition_3,
    raw.condition_4,
    raw.condition_5,
  ]
    .slice(0, count)
    .map(normalizeOracleCondition);

  return {
    creator: String(raw.creator),
    question: String(raw.question),
    oracle_conditions: conditions,
    condition_operators: [
      raw.operator_1_is_and,
      raw.operator_2_is_and,
      raw.operator_3_is_and,
      raw.operator_4_is_and,
    ]
      .slice(0, Math.max(0, count - 1))
      .map((value: unknown) => Boolean(value)),
    end_timestamp: asBigInt(raw.end_timestamp),
    min_bet: asBigInt(raw.min_bet),
    max_bet: asBigInt(raw.max_bet),
    fee_bps: Number(raw.fee_bps),
  };
}

function normalizeOracleCondition(raw: any): OracleCondition {
  return {
    oracle_contract: String(raw.oracle_contract),
    asset_symbol: String(raw.asset_symbol),
    greater_or_equal: Boolean(raw.greater_or_equal),
    threshold: asBigInt(raw.threshold),
  };
}

function normalizeResolvedCondition(raw: any): ResolvedCondition {
  return {
    ...normalizeOracleCondition(raw),
    observed_price: asBigInt(raw.observed_price),
    observed_timestamp: asBigInt(raw.observed_timestamp ?? 0),
    satisfied: Boolean(raw.satisfied),
  };
}

function normalizeMarketState(raw: any): MarketState {
  const resolvedCount = Number(raw.resolved_condition_count ?? 0);
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
    resolved_conditions: [
      raw.resolved_condition_1,
      raw.resolved_condition_2,
      raw.resolved_condition_3,
      raw.resolved_condition_4,
      raw.resolved_condition_5,
    ]
      .slice(0, resolvedCount)
      .map(normalizeResolvedCondition),
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

async function readFromContract<T = unknown>(
  targetContractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  signerLabel = "admin",
): Promise<T> {
  const wallet = getGlobalConfig().wallets.find((entry) => entry.label === signerLabel) ?? getGlobalConfig().wallets[0];
  const signer = publicKeyFromWallet(wallet);
  const contract = new Contract(targetContractId);
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

async function read<T = unknown>(method: string, args: xdr.ScVal[] = [], signerLabel = "admin"): Promise<T> {
  return readFromContract<T>(contractId(), method, args, signerLabel);
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

export async function loadUsdcBalance(address: string, signerLabel = "admin") {
  const raw = await readFromContract<unknown>(tokenContractId(), "balance", [scValAddress(address)], signerLabel);
  return asBigInt(raw);
}

export async function createMarket(
  wallet: WalletConfig,
  input: {
    marketId: string;
    question: string;
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

  const conditionStruct = (condition: OracleCondition) =>
    oracleConditionScVal(condition);

  return submit(
    "create_market",
    [
      scValAddress(publicKeyFromWallet(wallet)),
      bytes32ScVal(input.marketId),
      nativeToScVal(input.question, { type: "string" }),
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

export function estimateSharesForBudget(
  state: Pick<MarketState, "yes_shares_outstanding" | "no_shares_outstanding">,
  side: "YES" | "NO",
  amountInStroops: bigint,
) {
  if (amountInStroops <= BigInt(0)) {
    return BigInt(0);
  }

  let low = BigInt(0);
  let high = BigInt(1);
  const maxHigh = amountInStroops * QUOTE_SCALE_BPS;

  while (high < maxHigh && estimateBuyCost(state, side, high) <= amountInStroops) {
    const next = high * BigInt(2);
    if (next <= high) {
      break;
    }
    high = next > maxHigh ? maxHigh : next;
  }

  while (low < high) {
    const mid = low + (high - low + BigInt(1)) / BigInt(2);
    if (estimateBuyCost(state, side, mid) <= amountInStroops) {
      low = mid;
    } else {
      high = mid - BigInt(1);
    }
  }

  return low;
}

function estimateBuyCost(
  state: Pick<MarketState, "yes_shares_outstanding" | "no_shares_outstanding">,
  side: "YES" | "NO",
  shareAmount: bigint,
) {
  let remaining = shareAmount;
  let filled = BigInt(0);
  let totalCost = BigInt(0);

  while (remaining > BigInt(0)) {
    const chunk = remaining > TRADE_SLICE ? TRADE_SLICE : remaining;
    const midpoint = filled + chunk / BigInt(2);
    const yesMid = side === "YES" ? state.yes_shares_outstanding + midpoint : state.yes_shares_outstanding;
    const noMid = side === "NO" ? state.no_shares_outstanding + midpoint : state.no_shares_outstanding;
    const priceBps = side === "YES" ? lmsrQuoteBps(yesMid, noMid).yes : lmsrQuoteBps(yesMid, noMid).no;

    totalCost += (chunk * priceBps + QUOTE_SCALE_BPS - BigInt(1)) / QUOTE_SCALE_BPS;
    remaining -= chunk;
    filled += chunk;
  }

  return totalCost;
}

function lmsrQuoteBps(yesShares: bigint, noShares: bigint) {
  const yes = interpolatedYesQuoteBps(yesShares - noShares);
  return { yes, no: QUOTE_SCALE_BPS - yes };
}

function interpolatedYesQuoteBps(delta: bigint) {
  const scaled = (delta * BigInt(1000)) / LMSR_LIQUIDITY_PARAM;
  const clamped = scaled < LMSR_X_MIN ? LMSR_X_MIN : scaled > LMSR_X_MAX ? LMSR_X_MAX : scaled;
  const offset = clamped - LMSR_X_MIN;
  const index = Number(offset / LMSR_STEP);
  const remainder = offset % LMSR_STEP;

  if (remainder === BigInt(0) || index >= LMSR_PRICE_TABLE.length - 1) {
    return clampBps(LMSR_PRICE_TABLE[index]);
  }

  const left = LMSR_PRICE_TABLE[index];
  const right = LMSR_PRICE_TABLE[index + 1];
  return clampBps(left + ((right - left) * remainder) / LMSR_STEP);
}

function clampBps(value: bigint) {
  if (value < LMSR_MIN_BPS) return LMSR_MIN_BPS;
  if (value > LMSR_MAX_BPS) return LMSR_MAX_BPS;
  return value;
}
