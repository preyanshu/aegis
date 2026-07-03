"use client";

import { Buffer } from "buffer";
import type { User } from "@privy-io/react-auth";
import { profileBackendUrl } from "@/lib/profile-backend";
import {
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Keypair,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { AppConfig, WalletConfig } from "@/lib/server-config";

type StellarLinkedWallet = {
  address: string;
  publicKey?: string | null;
  public_key?: string | null;
  chainType?: "stellar";
  chain_type?: "stellar";
  type?: "wallet";
};

type SignRawHash = (input: {
  address: string;
  chainType: "stellar";
  hash: `0x${string}`;
}) => Promise<{ signature: `0x${string}` }>;

export type PrivyStellarWallet = StellarLinkedWallet;
export type StellarNativeBalanceSummary = {
  balance: string;
  baseReserve: string;
  minimumBalance: string;
  spendableBalance: string;
  sellingLiabilities: string;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
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

const TESTNET_USDC_ASSET_CODE = "USDC";
const TESTNET_USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

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

export function getBrowserConfig() {
  return getGlobalConfig();
}

export function setBrowserConfig(config: AppConfig) {
  (window as Window & { __BLIND_MARKET_CONFIG__?: AppConfig }).__BLIND_MARKET_CONFIG__ = config;
}

function server() {
  return new rpc.Server(getGlobalConfig().rpcUrl);
}

function horizonUrl() {
  const { rpcUrl } = getGlobalConfig();
  return rpcUrl.includes("testnet") ? "https://horizon-testnet.stellar.org" : "https://horizon.stellar.org";
}

async function loadLatestLedgerTimeSeconds() {
  const response = await fetch(getGlobalConfig().rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getLatestLedger",
    }),
  });

  if (!response.ok) {
    throw new Error(`failed to load latest Stellar ledger: ${response.status}`);
  }

  const payload = await response.json() as {
    result?: {
      closeTime?: string;
    };
  };

  const closeTime = Number(payload.result?.closeTime ?? 0);
  if (!Number.isFinite(closeTime) || closeTime <= 0) {
    throw new Error("latest Stellar ledger timestamp unavailable");
  }

  return closeTime;
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

function isTestnetNetwork() {
  return networkPassphrase().includes("Test");
}

function publicKeyFromWallet(wallet: WalletConfig) {
  return wallet.publicKey || Keypair.fromSecret(wallet.secret).publicKey();
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

function decimalStringToBigInt(value: string, decimals = 7) {
  const normalized = value.trim();
  if (!normalized) {
    return BigInt(0);
  }

  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [wholePart, fractionPart = ""] = unsigned.split(".");
  const safeWhole = wholePart === "" ? "0" : wholePart.replace(/\D/g, "") || "0";
  const paddedFraction = `${fractionPart.replace(/\D/g, "")}${"0".repeat(decimals)}`.slice(0, decimals);
  const scaled = BigInt(`${safeWhole}${paddedFraction}`);
  return negative ? -scaled : scaled;
}

function bigIntToDecimalString(value: bigint, decimals = 7) {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
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

function scValAddress(address: string) {
  return Address.fromString(address).toScVal();
}

function scValBool(value: boolean) {
  return xdr.ScVal.scvBool(value);
}

function scValSymbol(value: string) {
  return xdr.ScVal.scvSymbol(value);
}

function bytes32ScVal(hex: string) {
  return nativeToScVal(Buffer.from(hexToBytes(hex)), { type: "bytes" });
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

function reflectorOtherAssetScVal(assetSymbol: string) {
  return xdr.ScVal.scvVec([scValSymbol("Other"), scValSymbol(assetSymbol)]);
}

function decorateSignature(address: string, signatureHex: `0x${string}`) {
  const signer = Keypair.fromPublicKey(address);
  return new xdr.DecoratedSignature({
    hint: signer.signatureHint(),
    signature: Buffer.from(hexToBytes(signatureHex)),
  });
}

async function signAndSendTransaction(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  tx: ReturnType<TransactionBuilder["build"]>,
) {
  const txHash = tx.hash();
  const { signature } = await signRawHash({
    address: wallet.address,
    chainType: "stellar",
    hash: `0x${bytesToHex(txHash)}`,
  });

  tx.addDecoratedSignature(decorateSignature(wallet.address, signature));

  const sent = await server().sendTransaction(tx);
  if (sent.status === "ERROR") {
    console.error("Stellar transaction send failed", {
      walletAddress: wallet.address,
      txHash: bytesToHex(tx.hash()),
      status: sent.status,
      errorResult: sent.errorResult,
      envelopeXdr: tx.toXDR(),
    });
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  let got = await server().getTransaction(sent.hash);
  for (let index = 0; index < 60 && got.status === rpc.Api.GetTransactionStatus.NOT_FOUND; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    got = await server().getTransaction(sent.hash);
  }

  if (got.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
    console.error("Stellar transaction final status was not success", {
      walletAddress: wallet.address,
      txHash: sent.hash,
      status: got.status,
      envelopeXdr: tx.toXDR(),
      transaction: got,
    });
    throw new Error(`transaction ${sent.hash} did not succeed: ${got.status}`);
  }

  return {
    hash: sent.hash,
    returnValue: got.returnValue ? scValToNative(got.returnValue) : null,
  };
}

export function getPrivyStellarWallet(user: User | null | undefined): PrivyStellarWallet | null {
  const accounts = (user?.linkedAccounts ?? []) as Array<{
    address?: string;
    publicKey?: string | null;
    public_key?: string;
    chainType?: string;
    chain_type?: string;
    type?: string;
  }>;

  const wallet = accounts.find((account) => {
    const chainType = account.chainType ?? account.chain_type;
    return account.type === "wallet" && chainType === "stellar" && Boolean(account.address);
  });

  if (!wallet?.address) {
    return null;
  }

  return {
    address: wallet.address,
    publicKey: wallet.publicKey ?? wallet.public_key ?? wallet.address,
    public_key: wallet.public_key ?? wallet.publicKey ?? wallet.address,
    chainType: "stellar",
    chain_type: "stellar",
    type: "wallet",
  };
}

async function submitWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  method: string,
  args: xdr.ScVal[],
) {
  const contract = new Contract(contractId());
  const account = await server().getAccount(wallet.address);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await server().prepareTransaction(tx);
  return signAndSendTransaction(wallet, signRawHash, prepared);
}

export async function buySharesWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: {
    marketId: string;
    side: "YES" | "NO";
    amountInStroops: bigint;
    minSharesOut?: bigint;
  },
) {
  return submitWithPrivyWallet(wallet, signRawHash, "buy", [
    bytes32ScVal(input.marketId),
    scValAddress(wallet.address),
    nativeToScVal(input.side === "YES"),
    nativeToScVal(input.amountInStroops, { type: "i128" }),
    nativeToScVal(input.minSharesOut ?? BigInt(1), { type: "i128" }),
  ]);
}

function oracleConditionScVal(condition: {
  oracle_contract: string;
  asset_symbol: string;
  greater_or_equal: boolean;
  threshold: bigint;
}) {
  return scValMap([
    ["asset_symbol", xdr.ScVal.scvSymbol(condition.asset_symbol)],
    ["greater_or_equal", scValBool(condition.greater_or_equal)],
    ["oracle_contract", scValAddress(condition.oracle_contract)],
    ["threshold", nativeToScVal(condition.threshold, { type: "i128" })],
  ]);
}

function oracleConditionsInputScVal(input: {
  conditionCount: number;
  condition1: {
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  };
  condition2: {
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  };
  condition3: {
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  };
  condition4: {
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  };
  condition5: {
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  };
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

type CreateMarketInput = {
  marketId: string;
  question: string;
  category: string;
  oracleConditions: Array<{
    oracle_contract: string;
    asset_symbol: string;
    greater_or_equal: boolean;
    threshold: bigint;
  }>;
  conditionOperators: boolean[];
  endTimestamp: bigint;
  minBet: bigint;
  maxBet: bigint;
  feeBps: number;
};

function buildCreateMarketArgs(
  wallet: PrivyStellarWallet,
  input: CreateMarketInput,
) {
  const paddedConditions = [...input.oracleConditions];
  while (paddedConditions.length < 5) {
    paddedConditions.push({
      oracle_contract: wallet.address,
      asset_symbol: "NA",
      greater_or_equal: true,
      threshold: BigInt(0),
    });
  }

  return [
    scValAddress(wallet.address),
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
  ];
}

export async function createMarketWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: CreateMarketInput,
) {
  return submitWithPrivyWallet(wallet, signRawHash, "create_market", buildCreateMarketArgs(wallet, input));
}

export async function commitPositionWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: {
    marketId: string;
    owner: string;
    commitment: string;
    amountInStroops: bigint;
    proofHex: string;
  },
) {
  return submitWithPrivyWallet(wallet, signRawHash, "commit_position", buildCommitPositionArgs(input));
}

function buildCommitPositionArgs(input: {
  marketId: string;
  owner: string;
  commitment: string;
  amountInStroops: bigint;
  proofHex: string;
}) {
  return [
    bytes32ScVal(input.marketId),
    scValAddress(input.owner),
    bytes32ScVal(input.commitment),
    nativeToScVal(input.amountInStroops, { type: "i128" }),
    nativeToScVal(Buffer.from(hexToBytes(input.proofHex)), { type: "bytes" }),
  ];
}

export async function estimateCommitPositionFee(
  wallet: PrivyStellarWallet,
  input: {
    marketId: string;
    owner: string;
    commitment: string;
    amountInStroops: bigint;
    proofHex: string;
  },
) {
  const contract = new Contract(contractId());
  const account = await server().getAccount(wallet.address);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call("commit_position", ...buildCommitPositionArgs(input)))
    .setTimeout(120)
    .build();

  const simulation = await server().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error ?? "commit_position simulation failed");
  }

  const minResourceFee = BigInt(simulation.minResourceFee ?? "0");
  const classicFee = BigInt(tx.fee);
  const totalFee = classicFee + minResourceFee;

  return {
    classicFee,
    minResourceFee,
    totalFee,
  };
}

export async function claimWinningsWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: {
    marketId: string;
    commitment: string;
    nullifier: string;
    recipient: string;
    proofHex: string;
  },
) {
  return submitWithPrivyWallet(wallet, signRawHash, "claim_winnings", [
    bytes32ScVal(input.marketId),
    bytes32ScVal(input.commitment),
    bytes32ScVal(input.nullifier),
    scValAddress(input.recipient),
    nativeToScVal(Buffer.from(hexToBytes(input.proofHex)), { type: "bytes" }),
  ]);
}

export async function submitPrivateTallyWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
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
  return submitWithPrivyWallet(wallet, signRawHash, "submit_private_tally", [
    bytes32ScVal(input.marketId),
    bytes32ScVal(input.commitment),
    bytes32ScVal(input.nextTallyCommitment),
    bytes32ScVal(input.shareCommitmentRoot),
    nativeToScVal(Buffer.from(hexToBytes(input.proofHex)), { type: "bytes" }),
  ]);
}

export async function finalizePrivateTallyWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: {
    marketId: string;
    yesTotal: bigint;
    noTotal: bigint;
    talliedCount: number;
    aggregateCommitment: string;
    shardSigners: [string, string, string];
  },
) {
  return submitWithPrivyWallet(wallet, signRawHash, "finalize_private_tally", [
    bytes32ScVal(input.marketId),
    nativeToScVal(input.yesTotal, { type: "i128" }),
    nativeToScVal(input.noTotal, { type: "i128" }),
    nativeToScVal(input.talliedCount, { type: "u32" }),
    bytes32ScVal(input.aggregateCommitment),
    scValAddress(input.shardSigners[0]),
    scValAddress(input.shardSigners[1]),
    scValAddress(input.shardSigners[2]),
  ]);
}

export type TallySharePacket = {
  marketId: string;
  commitment: string;
  shardIndex: number;
  yesShare: string;
  noShare: string;
  shareSalt: string;
  shareCommitment: string;
};

export async function submitTallySharesToBackend(input: {
  tallyTxHash: string;
  shareCommitmentRoot: string;
  packets: TallySharePacket[];
}) {
  const response = await fetch(profileBackendUrl("/tally-shares"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tallyTxHash: input.tallyTxHash,
      shareCommitmentRoot: input.shareCommitmentRoot,
      packets: input.packets,
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error ?? "failed to submit tally shares");
  }

  return payload as { ok: true };
}

export async function estimateCreateMarketFee(
  wallet: PrivyStellarWallet,
  input: CreateMarketInput,
) {
  const contract = new Contract(contractId());
  const account = await server().getAccount(wallet.address);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(contract.call("create_market", ...buildCreateMarketArgs(wallet, input)))
    .setTimeout(120)
    .build();

  const simulation = await server().simulateTransaction(tx);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error ?? "create_market simulation failed");
  }

  const minResourceFee = BigInt(simulation.minResourceFee ?? "0");
  const classicFee = BigInt(tx.fee);
  const totalFee = classicFee + minResourceFee;

  return {
    classicFee,
    minResourceFee,
    totalFee,
  };
}

export async function sellSharesWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
  input: {
    marketId: string;
    side: "YES" | "NO";
    shareAmount: bigint;
    minUsdcOut?: bigint;
  },
) {
  return submitWithPrivyWallet(wallet, signRawHash, "sell", [
    bytes32ScVal(input.marketId),
    scValAddress(wallet.address),
    nativeToScVal(input.side === "YES"),
    nativeToScVal(input.shareAmount, { type: "i128" }),
    nativeToScVal(input.minUsdcOut ?? BigInt(1), { type: "i128" }),
  ]);
}

export async function loadUsdcBalance(address: string, signerLabel = "admin") {
  try {
    const raw = await readFromContract<unknown>(tokenContractId(), "balance", [scValAddress(address)], signerLabel);
    return asBigInt(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("trustline entry is missing for account")) {
      return BigInt(0);
    }
    throw error;
  }
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

export async function loadStellarNativeBalanceSummary(address: string): Promise<StellarNativeBalanceSummary> {
  const [accountResponse, latestLedgerResponse] = await Promise.all([
    fetch(`${horizonUrl()}/accounts/${address}`),
    fetch(`${horizonUrl()}/ledgers?order=desc&limit=1`),
  ]);

  if (!accountResponse.ok) {
    if (accountResponse.status === 404) {
      return {
        balance: "0",
        baseReserve: "0.5",
        minimumBalance: "0",
        spendableBalance: "0",
        sellingLiabilities: "0",
        subentryCount: 0,
        numSponsoring: 0,
        numSponsored: 0,
      };
    }
    throw new Error(`failed to load Stellar account ${address}: ${accountResponse.status}`);
  }

  if (!latestLedgerResponse.ok) {
    throw new Error(`failed to load latest Stellar ledger: ${latestLedgerResponse.status}`);
  }

  const account = await accountResponse.json() as {
    balances?: Array<{
      asset_type?: string;
      balance?: string;
      selling_liabilities?: string;
    }>;
    subentry_count?: number;
    num_sponsoring?: number;
    num_sponsored?: number;
  };
  const latestLedger = await latestLedgerResponse.json() as {
    _embedded?: {
      records?: Array<{
        base_reserve_in_stroops?: number;
      }>;
    };
  };

  const nativeBalance = account.balances?.find((entry) => entry.asset_type === "native");
  const balance = nativeBalance?.balance ?? "0";
  const sellingLiabilities = nativeBalance?.selling_liabilities ?? "0";
  const subentryCount = Number(account.subentry_count ?? 0);
  const numSponsoring = Number(account.num_sponsoring ?? 0);
  const numSponsored = Number(account.num_sponsored ?? 0);
  const baseReserveStroops = BigInt(latestLedger._embedded?.records?.[0]?.base_reserve_in_stroops ?? 5_000_000);
  const minimumBalanceUnits = BigInt(2 + subentryCount + numSponsoring - numSponsored);
  const minimumBalanceStroops = minimumBalanceUnits > 0n ? minimumBalanceUnits * baseReserveStroops : 0n;
  const spendableStroops = decimalStringToBigInt(balance) - minimumBalanceStroops - decimalStringToBigInt(sellingLiabilities);

  return {
    balance,
    baseReserve: bigIntToDecimalString(baseReserveStroops),
    minimumBalance: bigIntToDecimalString(minimumBalanceStroops),
    spendableBalance: bigIntToDecimalString(spendableStroops > 0n ? spendableStroops : 0n),
    sellingLiabilities,
    subentryCount,
    numSponsoring,
    numSponsored,
  };
}

export async function loadLatestLedgerTimestamp() {
  return loadLatestLedgerTimeSeconds();
}

export async function fundStellarTestnetAddress(address: string) {
  if (!isTestnetNetwork()) {
    throw new Error("Testnet faucet is only available on Stellar Testnet.");
  }

  return server().fundAddress(address);
}

export async function hasUsdcTestnetTrustline(address: string) {
  const response = await fetch(`${horizonUrl()}/accounts/${address}`);
  if (!response.ok) {
    if (response.status === 404) {
      return false;
    }
    throw new Error(`failed to load Stellar account ${address}: ${response.status}`);
  }

  const account = await response.json() as {
    balances?: Array<{
      asset_type?: string;
      asset_code?: string;
      asset_issuer?: string;
    }>;
  };

  return Boolean(account.balances?.find((entry) => (
    entry.asset_type === "credit_alphanum4"
    && entry.asset_code === TESTNET_USDC_ASSET_CODE
    && entry.asset_issuer === TESTNET_USDC_ISSUER
  )));
}

export async function ensureUsdcTestnetTrustlineWithPrivyWallet(
  wallet: PrivyStellarWallet,
  signRawHash: SignRawHash,
) {
  if (!isTestnetNetwork()) {
    throw new Error("USDC faucet support is only enabled on Stellar Testnet.");
  }

  const hasTrustline = await hasUsdcTestnetTrustline(wallet.address);
  if (hasTrustline) {
    return { created: false as const, hash: null };
  }

  const account = await server().getAccount(wallet.address);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: networkPassphrase(),
  })
    .addOperation(Operation.changeTrust({
      asset: new Asset(TESTNET_USDC_ASSET_CODE, TESTNET_USDC_ISSUER),
    }))
    .setTimeout(120)
    .build();

  const result = await signAndSendTransaction(wallet, signRawHash, tx);
  return { created: true as const, hash: result.hash };
}

export async function loadPosition(_marketId?: string, _address?: string) {
  void _marketId;
  void _address;
  return {
    yes_shares: BigInt(0),
    no_shares: BigInt(0),
  };
}

function formatReflectorDecimal(price: bigint, decimals: number) {
  if (decimals <= 0) {
    return price.toString();
  }

  const negative = price < 0n;
  const absolute = negative ? -price : price;
  const base = 10n ** BigInt(decimals);
  const whole = absolute / base;
  const fraction = absolute % base;

  if (fraction === 0n) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  const fractionText = fraction
    .toString()
    .padStart(decimals, "0")
    .slice(0, 3)
    .replace(/0+$/, "");

  if (!fractionText) {
    return `${negative ? "-" : ""}${whole.toString()}`;
  }

  return `${negative ? "-" : ""}${whole.toString()}.${fractionText}`;
}

type ReflectorLatestPriceResult = null | {
  price: bigint;
  decimals: number;
  formatted: string;
  timestamp: number;
};

type ReflectorHistoryResult = {
  decimals: number;
  points: Array<{
    timestamp: number;
    price: bigint;
    formatted: string;
  }>;
};

const reflectorLatestPriceCache = new Map<string, {
  expiresAt: number;
  value: ReflectorLatestPriceResult;
}>();
const reflectorLatestPriceInflight = new Map<string, Promise<ReflectorLatestPriceResult>>();
const reflectorHistoryCache = new Map<string, ReflectorHistoryResult>();
const reflectorHistoryInflight = new Map<string, Promise<ReflectorHistoryResult>>();

async function readFromContract<T = unknown>(
  targetContractId: string,
  method: string,
  args: xdr.ScVal[] = [],
  signerLabel = "admin",
) {
  const config = getGlobalConfig();
  const signer = config.wallets.find((entry) => entry.label === signerLabel) ?? config.wallets[0];
  const account = await server().getAccount(publicKeyFromWallet(signer));
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
    throw new Error(simulation.error ?? `${method} simulation failed`);
  }

  if (!simulation.result?.retval) {
    return null as T;
  }

  return scValToNative(simulation.result.retval) as T;
}

async function read<T = unknown>(method: string, args: xdr.ScVal[] = [], signerLabel = "admin") {
  return readFromContract<T>(contractId(), method, args, signerLabel);
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

export async function loadReflectorPrice(
  oracleContractId: string,
  assetSymbol: string,
) : Promise<ReflectorLatestPriceResult> {
  const cacheKey = `${oracleContractId}:${assetSymbol}`;
  const now = Date.now();
  const cached = reflectorLatestPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inflight = reflectorLatestPriceInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = (async () => {
    const [decimals, priceData] = await Promise.all([
      readFromContract<number>(oracleContractId, "decimals"),
      readFromContract<{ price?: bigint; timestamp?: bigint } | null>(oracleContractId, "lastprice", [
        reflectorOtherAssetScVal(assetSymbol),
      ]),
    ]);

    const value = (!priceData?.price || !priceData.timestamp)
      ? null
      : {
        price: BigInt(priceData.price),
        decimals: Number(decimals),
        formatted: formatReflectorDecimal(BigInt(priceData.price), Number(decimals)),
        timestamp: Number(priceData.timestamp),
      };

    reflectorLatestPriceCache.set(cacheKey, {
      expiresAt: now + 15_000,
      value,
    });

    return value;
  })();

  reflectorLatestPriceInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    reflectorLatestPriceInflight.delete(cacheKey);
  }
}

export async function loadReflectorPriceHistory(
  oracleContractId: string,
  assetSymbol: string,
  input?: {
    points?: number;
    intervalSeconds?: number;
    endTimestamp?: number;
    cacheBucketSeconds?: number;
  },
): Promise<ReflectorHistoryResult> {
  const points = Math.max(4, Math.min(input?.points ?? 24, 72));
  const intervalSeconds = Math.max(300, input?.intervalSeconds ?? 3600);
  const requestedEndTimestamp = input?.endTimestamp ?? Math.floor(Date.now() / 1000);
  const cacheBucketSeconds = Math.max(60, input?.cacheBucketSeconds ?? intervalSeconds);
  const endTimestamp = requestedEndTimestamp;
  const startTimestamp = endTimestamp - intervalSeconds * (points - 1);
  const normalizedCacheEndTimestamp = Math.floor(requestedEndTimestamp / cacheBucketSeconds) * cacheBucketSeconds;
  const cacheKey = `${oracleContractId}:${assetSymbol}:${points}:${intervalSeconds}:${normalizedCacheEndTimestamp}`;

  const cached = reflectorHistoryCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const inflight = reflectorHistoryInflight.get(cacheKey);
  if (inflight) {
    return inflight;
  }

  const request = (async () => {
    const decimals = Number(await readFromContract<number>(oracleContractId, "decimals"));
    const timestamps = Array.from({ length: points }, (_, index) => startTimestamp + index * intervalSeconds);

    const history = await Promise.all(
      timestamps.map(async (timestamp) => {
        const priceData = await readFromContract<{ price?: bigint; timestamp?: bigint } | null>(
          oracleContractId,
          "price",
          [
            reflectorOtherAssetScVal(assetSymbol),
            nativeToScVal(BigInt(timestamp), { type: "u64" }),
          ],
        ).catch(() => null);

        if (!priceData?.price || !priceData.timestamp) {
          return null;
        }

        const price = BigInt(priceData.price);
        const observedTimestamp = Number(priceData.timestamp);
        return {
          timestamp: observedTimestamp,
          price,
          formatted: formatReflectorDecimal(price, decimals),
        };
      }),
    );

    const value = {
      decimals,
      points: history.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry)),
    };

    reflectorHistoryCache.set(cacheKey, value);
    return value;
  })();

  reflectorHistoryInflight.set(cacheKey, request);
  try {
    return await request;
  } finally {
    reflectorHistoryInflight.delete(cacheKey);
  }
}
