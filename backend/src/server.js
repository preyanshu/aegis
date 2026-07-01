import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { randomBytes } from "node:crypto";
import { loadEnv } from "./env.js";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
} from "@stellar/stellar-sdk";
import { Buffer } from "node:buffer";

loadEnv({ preserve: ["PORT", "MONGODB_URI", "CORS_ORIGIN", "MARKET_CONTRACT_ID"] });

const PORT = Number(process.env.PORT ?? 4001);
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/verdict";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const FINALIZE_CRON_MS = Number(process.env.FINALIZE_CRON_MS ?? 30000);
const SHARD_COUNT = 5;
const SHARD_THRESHOLD = 3;
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

mongoose.set("strictQuery", true);

const profileSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, unique: true, index: true, trim: true },
    displayName: { type: String, required: true, trim: true, maxlength: 80 },
    avatarDataUrl: { type: String, default: null, trim: true, maxlength: 2000000 },
    bio: { type: String, default: null, trim: true, maxlength: 240 },
    syncMode: { type: String, default: "server", trim: true, maxlength: 16 },
    source: { type: String, default: "privy", trim: true, maxlength: 32 },
    onboardedAt: { type: Date, default: Date.now },
    lastSeenAt: { type: Date, default: Date.now },
  },
  {
    timestamps: true,
  },
);

const PublicProfile = mongoose.model("PublicProfile", profileSchema);
const vaultEntrySchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true },
    marketQuestion: { type: String, required: true },
    category: { type: String, required: true },
    owner: { type: String, required: true },
    side: { type: String, required: true },
    amountInStroops: { type: String, required: true },
    salt: { type: String, required: true },
    commitment: { type: String, required: true, index: true },
    nullifier: { type: String, required: true },
    commitTxHash: { type: String, default: null },
    tallyTxHash: { type: String, default: null },
    tallyStatus: { type: String, default: "pending", trim: true, maxlength: 32 },
    talliedAt: { type: Number, default: null },
    claimTxHash: { type: String, default: null },
    claimedAt: { type: Number, default: null },
    committedAt: { type: Number, default: null },
  },
  { _id: false },
);

const credentialSchema = new mongoose.Schema(
  {
    serialized: { type: String, required: true },
    proofHex: { type: String, required: true },
    publicInputsHex: { type: [String], default: [] },
    snapshotRoot: { type: String, required: true },
    attestorKeyId: { type: String, required: true },
    proofValid: { type: Boolean, required: true },
    snapshotVerified: { type: Boolean, required: true },
    archivedAt: { type: Number, default: null },
    publicClaim: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Number, required: true },
    claim: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  { _id: false },
);

const vaultSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, unique: true, index: true, trim: true },
    syncMode: { type: String, default: "server", trim: true, maxlength: 16 },
    positions: { type: [vaultEntrySchema], default: [] },
    attestedRecords: { type: [mongoose.Schema.Types.Mixed], default: [] },
    achievements: { type: [credentialSchema], default: [] },
    updatedAt: { type: Number, default: Date.now },
  },
);

const ReputationVault = mongoose.model("ReputationVault", vaultSchema);

const reputationShareSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, index: true, trim: true },
    slug: { type: String, required: true, unique: true, index: true, trim: true },
    version: { type: Number, required: true, min: 1 },
    snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now },
  },
  { timestamps: false },
);
reputationShareSchema.index({ walletAddress: 1, version: 1 }, { unique: true });
const ReputationShare = mongoose.model("ReputationShare", reputationShareSchema);

const tallyShareSchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true, index: true, trim: true },
    commitment: { type: String, required: true, index: true, trim: true },
    owner: { type: String, default: null, trim: true },
    shardIndex: { type: Number, required: true, min: 1, max: SHARD_COUNT },
    yesShare: { type: String, required: true, trim: true },
    noShare: { type: String, required: true, trim: true },
    shareSalt: { type: String, required: true, trim: true },
    shareCommitment: { type: String, required: true, trim: true },
    shareCommitmentRoot: { type: String, required: true, trim: true },
    tallyTxHash: { type: String, required: true, trim: true },
    createdAt: { type: Number, default: Date.now },
  },
  { timestamps: true },
);
tallyShareSchema.index({ marketId: 1, commitment: 1, shardIndex: 1 }, { unique: true });
const TallyShare = mongoose.model("TallyShare", tallyShareSchema);

const attestedRecordSchema = new mongoose.Schema(
  {
    walletAddress: { type: String, required: true, index: true, trim: true },
    marketId: { type: String, required: true, trim: true },
    category: { type: String, required: true, trim: true },
    claimedAt: { type: Number, required: true },
    resolvedAt: { type: Number, required: true },
    recordCommitment: { type: String, required: true, trim: true },
    attestorSignature: { type: String, required: true, trim: true },
    attestorKeyId: { type: String, required: true, trim: true },
    claimTxHash: { type: String, required: true, trim: true },
    positionCommitment: { type: String, required: true, trim: true },
    claimNullifier: { type: String, required: true, trim: true },
  },
  { timestamps: true },
);
attestedRecordSchema.index(
  { walletAddress: 1, marketId: 1, positionCommitment: 1, claimTxHash: 1 },
  { unique: true },
);
const AttestedReputationRecord = mongoose.model("AttestedReputationRecord", attestedRecordSchema);

const finalizationJobSchema = new mongoose.Schema(
  {
    marketId: { type: String, required: true, unique: true, index: true, trim: true },
    status: { type: String, required: true, default: "queued", trim: true },
    txHash: { type: String, default: null, trim: true },
    error: { type: String, default: null },
    updatedAt: { type: Number, default: Date.now },
  },
);
const FinalizationJob = mongoose.model("FinalizationJob", finalizationJobSchema);

const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(
  cors({
    origin: CORS_ORIGIN === "*" ? "*" : CORS_ORIGIN.split(",").map((item) => item.trim()).filter(Boolean),
    credentials: false,
  }),
);

function normalizeWalletAddress(value) {
  return String(value ?? "").trim();
}

function normalizeCategory(value) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizeHex(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  return raw.startsWith("0x") ? raw.toLowerCase() : `0x${raw.toLowerCase()}`;
}

function containsForbiddenWitnessFields(value) {
  if (!value || typeof value !== "object") return false;
  const forbidden = new Set(["side", "salt", "direction", "amount", "rawWitness", "witness"]);
  return Object.keys(value).some((key) => forbidden.has(key));
}

function parseSharePacket(raw, fallback = {}) {
  if (containsForbiddenWitnessFields(raw)) {
    throw new Error("payload contains forbidden witness fields");
  }
  const packet = {
    marketId: normalizeHex(raw.marketId ?? fallback.marketId),
    commitment: normalizeHex(raw.commitment ?? fallback.commitment),
    owner: raw.owner ? normalizeWalletAddress(raw.owner) : null,
    shardIndex: Number(raw.shardIndex),
    yesShare: String(raw.yesShare ?? "").trim(),
    noShare: String(raw.noShare ?? "").trim(),
    shareSalt: normalizeHex(raw.shareSalt),
    shareCommitment: normalizeHex(raw.shareCommitment),
    shareCommitmentRoot: normalizeHex(raw.shareCommitmentRoot ?? fallback.shareCommitmentRoot),
    tallyTxHash: String(raw.tallyTxHash ?? fallback.tallyTxHash ?? "").trim(),
  };
  if (!packet.marketId || !packet.commitment || !packet.shareCommitmentRoot || !packet.tallyTxHash) {
    throw new Error("marketId, commitment, shareCommitmentRoot, and tallyTxHash are required");
  }
  if (!Number.isInteger(packet.shardIndex) || packet.shardIndex < 1 || packet.shardIndex > SHARD_COUNT) {
    throw new Error("shardIndex must be between 1 and 5");
  }
  if (!/^\d+$/.test(packet.yesShare) || !/^\d+$/.test(packet.noShare)) {
    throw new Error("shares must be unsigned decimal strings");
  }
  if (!packet.shareSalt || !packet.shareCommitment) {
    throw new Error("shareSalt and shareCommitment are required");
  }
  return packet;
}

function stellarConfig() {
  const required = ["STELLAR_RPC", "STELLAR_NETWORK", "MARKET_CONTRACT_ID"];
  if (required.some((name) => !process.env[name])) return null;
  const finalizerSecret = process.env.FINALIZER_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY;
  if (!finalizerSecret) return null;
  const shardSecrets = [
    process.env.SHARD_1_SECRET_KEY ?? process.env.ADMIN_SECRET_KEY,
    process.env.SHARD_2_SECRET_KEY ?? process.env.USER2_SECRET_KEY,
    process.env.SHARD_3_SECRET_KEY ?? process.env.USER3_SECRET_KEY,
  ].filter(Boolean);
  return {
    rpcUrl: process.env.STELLAR_RPC,
    networkPassphrase: process.env.STELLAR_NETWORK,
    contractId: process.env.MARKET_CONTRACT_ID,
    finalizer: Keypair.fromSecret(finalizerSecret),
    shardSigners: shardSecrets.map((secret) => Keypair.fromSecret(secret)),
  };
}

function hexToBytes(hex) {
  return Buffer.from(normalizeHex(hex).slice(2), "hex");
}

function bytes32ScVal(hex) {
  return nativeToScVal(hexToBytes(hex), { type: "bytes" });
}

function scValAddress(address) {
  return nativeToScVal(Address.fromString(address), { type: "address" });
}

function bytesToHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function padHex32(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function asBigInt(value) {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (value instanceof Uint8Array) return BigInt(`0x${bytesToHex(value)}`);
  return BigInt(0);
}

function modField(value) {
  const normalized = value % FIELD_MODULUS;
  return normalized >= 0n ? normalized : normalized + FIELD_MODULUS;
}

function stringToField(value) {
  let acc = 0n;
  for (let index = 0; index < value.length; index += 1) {
    acc = ((acc * 257n) + BigInt(value.charCodeAt(index))) & ((1n << 248n) - 1n);
  }
  return acc;
}

function marketIdToField(marketId) {
  return BigInt(normalizeHex(marketId)) & ((1n << 248n) - 1n);
}

function combineFieldLike(inputs) {
  let acc = 0n;
  for (const input of inputs) {
    acc = ((acc * 1315423911n) + (BigInt(input) & ((1n << 248n) - 1n))) & ((1n << 248n) - 1n);
  }
  return acc;
}

function computeRecordCommitment(input) {
  return padHex32(combineFieldLike([
    stringToField(input.walletAddress.toLowerCase()),
    marketIdToField(input.marketId),
    stringToField(input.category.toLowerCase()),
    BigInt(input.amountInStroops),
    BigInt(input.payoutInStroops),
    input.won ? 1n : 0n,
    BigInt(input.claimedAt),
    BigInt(input.witnessSalt),
  ]));
}

function buildAttestationMessage(record) {
  return [
    record.walletAddress.trim().toLowerCase(),
    record.marketId.trim().toLowerCase(),
    record.category.trim().toLowerCase(),
    String(record.claimedAt),
    String(record.resolvedAt),
    record.recordCommitment.trim().toLowerCase(),
  ].join("|");
}

function attestorKeypair() {
  const secret = process.env.REPUTATION_ATTESTOR_SECRET_KEY
    ?? process.env.FINALIZER_SECRET_KEY
    ?? process.env.ADMIN_SECRET_KEY;
  if (!secret) {
    throw new Error("reputation attestor secret key is not configured");
  }
  return Keypair.fromSecret(secret);
}

function signAttestedRecord(record) {
  const signer = attestorKeypair();
  return {
    attestorSignature: `0x${bytesToHex(signer.sign(Buffer.from(buildAttestationMessage(record), "utf8")))}`,
    attestorKeyId: signer.publicKey(),
  };
}

async function getTransactionResult(hash) {
  const cfg = stellarConfig();
  if (!cfg) throw new Error("stellar finalizer env is not configured");
  const server = new rpc.Server(cfg.rpcUrl);
  return server.getTransaction(hash);
}

async function readContract(method, args = []) {
  const cfg = stellarConfig();
  if (!cfg) throw new Error("stellar finalizer env is not configured");
  const server = new rpc.Server(cfg.rpcUrl);
  const account = await server.getAccount(cfg.finalizer.publicKey());
  const contract = new Contract(cfg.contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  }).addOperation(contract.call(method, ...args)).setTimeout(60).build();
  const prepared = await server.prepareTransaction(tx);
  const simulation = await server.simulateTransaction(prepared);
  if (rpc.Api.isSimulationError(simulation)) {
    throw new Error(simulation.error ?? "simulation failed");
  }
  return scValToNative(simulation.result?.retval);
}

async function loadMarketIds() {
  const packed = await readContract("get_market_ids");
  const bytes = packed instanceof Uint8Array ? packed : hexToBytes(String(packed));
  const ids = [];
  for (let offset = 0; offset < bytes.length; offset += 32) {
    ids.push(`0x${bytesToHex(bytes.slice(offset, offset + 32))}`);
  }
  return ids;
}

async function loadMarketState(marketId) {
  try {
    return await readContract("get_market_state", [bytes32ScVal(marketId)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`market lookup failed for ${marketId}: ${message}`);
  }
}

async function loadMarketConfig(marketId) {
  try {
    return await readContract("get_market_config", [bytes32ScVal(marketId)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`market config lookup failed for ${marketId}: ${message}`);
  }
}

async function loadCommitmentRecord(marketId, commitment) {
  try {
    return await readContract("get_commitment_record", [bytes32ScVal(marketId), bytes32ScVal(commitment)]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`commitment lookup failed for ${marketId}/${commitment}: ${message}`);
  }
}

async function submitFinalize(marketId, aggregate) {
  const cfg = stellarConfig();
  if (!cfg) throw new Error("stellar finalizer env is not configured");
  if (cfg.shardSigners.length < SHARD_THRESHOLD) {
    throw new Error("at least 3 shard signer secret keys are required");
  }
  const selectedShardSigners = cfg.shardSigners.slice(0, SHARD_THRESHOLD);
  const server = new rpc.Server(cfg.rpcUrl);
  const account = await server.getAccount(cfg.finalizer.publicKey());
  const contract = new Contract(cfg.contractId);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: cfg.networkPassphrase,
  })
    .addOperation(contract.call(
      "finalize_private_tally",
      bytes32ScVal(marketId),
      nativeToScVal(aggregate.yesTotal, { type: "i128" }),
      nativeToScVal(aggregate.noTotal, { type: "i128" }),
      nativeToScVal(aggregate.talliedCommitmentCount, { type: "u32" }),
      bytes32ScVal(aggregate.aggregateCommitment),
      scValAddress(selectedShardSigners[0].publicKey()),
      scValAddress(selectedShardSigners[1].publicKey()),
      scValAddress(selectedShardSigners[2].publicKey()),
    ))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(cfg.finalizer);
  try {
    const sent = await server.sendTransaction(prepared);
    if (sent.status === "ERROR") {
      throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
    }
    for (;;) {
      const result = await server._getTransaction(sent.hash);
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS || result.status === "SUCCESS") {
        return sent.hash;
      }
      if (result.status === rpc.Api.GetTransactionStatus.FAILED || result.status === "FAILED") {
        throw new Error(`transaction failed: ${JSON.stringify(result)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  } catch (error) {
    console.error("finalize submit failed", {
      marketId,
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

async function aggregateMarketShares(marketId) {
  const rows = await TallyShare.find({ marketId: normalizeHex(marketId) }).lean();
  const byCommitment = new Map();
  for (const row of rows) {
    const entry = byCommitment.get(row.commitment) ?? {
      commitment: row.commitment,
      shareCommitmentRoot: row.shareCommitmentRoot,
      shards: new Map(),
    };
    entry.shards.set(row.shardIndex, row);
    byCommitment.set(row.commitment, entry);
  }

  let yesTotal = 0n;
  let noTotal = 0n;
  let talliedCommitmentCount = 0;
  for (const entry of byCommitment.values()) {
    if (entry.shards.size !== SHARD_COUNT) continue;
    talliedCommitmentCount += 1;
    for (const row of entry.shards.values()) {
      yesTotal = modField(yesTotal + BigInt(row.yesShare));
      noTotal = modField(noTotal + BigInt(row.noShare));
    }
  }

  const state = await loadMarketState(marketId);
  const aggregateCommitment = state.tally_commitment instanceof Uint8Array
    ? `0x${bytesToHex(state.tally_commitment)}`
    : normalizeHex(state.tally_commitment);

  return {
    marketId: normalizeHex(marketId),
    yesTotal,
    noTotal,
    talliedCommitmentCount,
    aggregateCommitment,
    storedCommitmentCount: byCommitment.size,
    completeCommitmentCount: talliedCommitmentCount,
  };
}

function serializeProfile(profile) {
  return {
    walletAddress: profile.walletAddress,
    displayName: profile.displayName,
    avatarDataUrl: profile.avatarDataUrl ?? null,
    bio: profile.bio ?? null,
    syncMode: profile.syncMode ?? "server",
    source: profile.source,
    onboardedAt: profile.onboardedAt?.toISOString?.() ?? null,
    lastSeenAt: profile.lastSeenAt?.toISOString?.() ?? null,
    createdAt: profile.createdAt?.toISOString?.() ?? null,
    updatedAt: profile.updatedAt?.toISOString?.() ?? null,
  };
}

function serializeVault(vault) {
  return {
    walletAddress: vault.walletAddress,
    syncMode: vault.syncMode ?? "server",
    positions: Array.isArray(vault.positions) ? vault.positions : [],
    attestedRecords: Array.isArray(vault.attestedRecords) ? vault.attestedRecords : [],
    achievements: Array.isArray(vault.achievements) ? vault.achievements : [],
    updatedAt: typeof vault.updatedAt === "number" ? vault.updatedAt : Date.now(),
  };
}

function serializeShareSnapshot(share) {
  const snapshot = share.snapshot ?? {};
  return {
    walletAddress: share.walletAddress,
    slug: share.slug,
    version: share.version,
    shareUrl: `/reputation/share/${share.slug}`,
    snapshot: {
      profile: snapshot.profile ?? {
        displayName: "",
        bio: "",
        avatarDataUrl: null,
      },
      summary: snapshot.summary ?? {
        totalMarkets: Array.isArray(snapshot.positions)
          ? new Set(snapshot.positions.map((position) => position.marketId)).size
          : 0,
        totalCollateralInStroops: Array.isArray(snapshot.positions)
          ? snapshot.positions.reduce((sum, position) => sum + BigInt(position.amountInStroops ?? "0"), 0n).toString()
          : "0",
        totalCategories: Array.isArray(snapshot.positions)
          ? new Set(snapshot.positions.map((position) => String(position.category ?? "").toLowerCase()).filter(Boolean)).size
          : 0,
        categories: Array.isArray(snapshot.positions)
          ? [...new Set(snapshot.positions.map((position) => String(position.category ?? "").toLowerCase()).filter(Boolean))].slice(0, 4)
          : [],
      },
      attestedRecords: Array.isArray(snapshot.attestedRecords) ? snapshot.attestedRecords : [],
      achievements: Array.isArray(snapshot.achievements) ? snapshot.achievements : [],
      positions: Array.isArray(snapshot.positions) ? snapshot.positions : [],
    },
    createdAt: typeof share.createdAt === "number" ? share.createdAt : Date.now(),
    updatedAt: typeof share.updatedAt === "number" ? share.updatedAt : Date.now(),
  };
}

function serializeAttestedRecord(record) {
  return {
    walletAddress: record.walletAddress,
    marketId: record.marketId,
    category: record.category,
    claimedAt: record.claimedAt,
    resolvedAt: record.resolvedAt,
    recordCommitment: record.recordCommitment,
    attestorSignature: record.attestorSignature,
    attestorKeyId: record.attestorKeyId,
    claimTxHash: record.claimTxHash,
  };
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "verdict-profile-backend" });
});

app.get("/profiles/:walletAddress", async (req, res) => {
  const walletAddress = normalizeWalletAddress(req.params.walletAddress);
  if (!walletAddress) {
    return res.status(400).json({ error: "walletAddress is required" });
  }

  const profile = await PublicProfile.findOne({ walletAddress }).lean();
  if (!profile) {
    return res.status(404).json({ profile: null });
  }

  return res.json({ profile: serializeProfile(profile) });
});

app.post("/profiles/upsert", async (req, res) => {
  const walletAddress = normalizeWalletAddress(req.body?.walletAddress);
  const displayName = String(req.body?.displayName ?? "").trim().slice(0, 80);
  const avatarDataUrl = String(req.body?.avatarDataUrl ?? req.body?.avatarUrl ?? "").trim();
  const bio = String(req.body?.bio ?? "").trim().slice(0, 240);
  const syncMode = String(req.body?.syncMode ?? "server").trim() === "local" ? "local" : "server";
  const source = String(req.body?.source ?? "privy").trim().slice(0, 32) || "privy";

  if (!walletAddress) {
    return res.status(400).json({ error: "walletAddress is required" });
  }

  if (!displayName) {
    return res.status(400).json({ error: "displayName is required" });
  }

  const nextAvatarDataUrl = avatarDataUrl || null;
  const nextBio = bio || null;

  const profile = await PublicProfile.findOneAndUpdate(
    { walletAddress },
    {
      $set: {
        walletAddress,
        displayName,
        avatarDataUrl: nextAvatarDataUrl,
        bio: nextBio,
        syncMode,
        source,
        lastSeenAt: new Date(),
      },
      $setOnInsert: {
        onboardedAt: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  return res.json({ profile: serializeProfile(profile) });
});

app.get("/vault/:walletAddress", async (req, res) => {
  const walletAddress = normalizeWalletAddress(req.params.walletAddress);
  if (!walletAddress) {
    return res.status(400).json({ error: "walletAddress is required" });
  }

  const vault = await ReputationVault.findOne({ walletAddress }).lean();
  if (!vault) {
    return res.status(404).json({ vault: null });
  }

  return res.json({ vault: serializeVault(vault) });
});

app.post("/vault/upsert", async (req, res) => {
  const walletAddress = normalizeWalletAddress(req.body?.walletAddress);
  const syncMode = String(req.body?.syncMode ?? "server").trim() === "local" ? "local" : "server";
  const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
  const attestedRecords = Array.isArray(req.body?.attestedRecords) ? req.body.attestedRecords : [];
  const achievements = Array.isArray(req.body?.achievements) ? req.body.achievements : [];

  if (!walletAddress) {
    return res.status(400).json({ error: "walletAddress is required" });
  }

  const vault = await ReputationVault.findOneAndUpdate(
    { walletAddress },
    {
      $set: {
        walletAddress,
        syncMode,
        positions,
        attestedRecords,
        achievements,
        updatedAt: Date.now(),
      },
    },
    {
      upsert: true,
      new: true,
      runValidators: true,
      setDefaultsOnInsert: true,
    },
  );

  return res.json({ vault: serializeVault(vault) });
});

app.post("/reputation-shares", async (req, res) => {
  try {
    const walletAddress = normalizeWalletAddress(req.body?.walletAddress);
    const snapshot = req.body?.snapshot ?? {};

    if (!walletAddress) {
      return res.status(400).json({ error: "walletAddress is required" });
    }

    const latest = await ReputationShare.findOne({ walletAddress }).sort({ version: -1, createdAt: -1 }).lean();
    const nextVersion = Number(latest?.version ?? 0) + 1;
    const slug = `rep-${nextVersion.toString(36)}-${randomBytes(4).toString("hex")}`;
    const createdAt = Date.now();

    const share = await ReputationShare.create({
      walletAddress,
      slug,
      version: nextVersion,
      snapshot: {
        profile: snapshot.profile ?? {
          displayName: "",
          bio: "",
          avatarDataUrl: null,
        },
        summary: snapshot.summary ?? {
          totalMarkets: 0,
          totalCollateralInStroops: "0",
          totalCategories: 0,
          categories: [],
        },
        attestedRecords: Array.isArray(snapshot.attestedRecords) ? snapshot.attestedRecords : [],
        achievements: Array.isArray(snapshot.achievements)
          ? snapshot.achievements.filter((achievement) => !achievement?.archivedAt)
          : [],
      },
      createdAt,
      updatedAt: createdAt,
    });

    return res.status(201).json({ share: serializeShareSnapshot(share) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = message.includes("duplicate key");
    return res.status(duplicate ? 409 : 400).json({ error: duplicate ? "duplicate share snapshot" : message });
  }
});

app.get("/reputation-shares/:slug", async (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    return res.status(400).json({ error: "slug is required" });
  }

  const share = await ReputationShare.findOne({ slug }).lean();
  if (!share) {
    return res.status(404).json({ share: null });
  }

  return res.json({ share: serializeShareSnapshot(share) });
});

app.post("/reputation/attest-claim", async (req, res) => {
  try {
    const walletAddress = normalizeWalletAddress(req.body?.walletAddress);
    const marketId = normalizeHex(req.body?.marketId);
    const commitment = normalizeHex(req.body?.commitment);
    const nullifier = normalizeHex(req.body?.nullifier);
    const claimTxHash = String(req.body?.claimTxHash ?? "").trim();
    const category = normalizeCategory(req.body?.category);
    const recordCommitment = normalizeHex(req.body?.recordCommitment);
    const witnessSalt = normalizeHex(req.body?.witnessSalt);
    const claimedAtHint = Number(req.body?.claimedAt ?? 0);

    if (!walletAddress || !marketId || !commitment || !nullifier || !claimTxHash || !category || !recordCommitment || !witnessSalt) {
      return res.status(400).json({ error: "walletAddress, marketId, commitment, nullifier, claimTxHash, category, recordCommitment, and witnessSalt are required" });
    }

    const existing = await AttestedReputationRecord.findOne({
      walletAddress,
      marketId,
      positionCommitment: commitment,
      claimTxHash,
    }).lean();
    if (existing) {
      return res.json({ record: serializeAttestedRecord(existing) });
    }

    const tx = await getTransactionResult(claimTxHash);
    if (tx.status !== rpc.Api.GetTransactionStatus.SUCCESS && tx.status !== "SUCCESS") {
      return res.status(400).json({ error: "claim transaction did not succeed" });
    }

    let marketState;
    try {
      marketState = await loadMarketState(marketId);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        hint: "Verify that MARKET_CONTRACT_ID points to the same network where the market was created and that this marketId exists on-chain.",
      });
    }
    if (!Boolean(marketState.resolved) || !Boolean(marketState.claims_finalized)) {
      return res.status(400).json({ error: "market is not claim-ready" });
    }

    let marketConfig;
    try {
      marketConfig = await loadMarketConfig(marketId);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        hint: "The backend can reach the contract, but this market config is missing on-chain.",
      });
    }

    let commitmentRecord;
    try {
      commitmentRecord = await loadCommitmentRecord(marketId, commitment);
    } catch (error) {
      return res.status(400).json({
        error: error instanceof Error ? error.message : String(error),
        hint: "The claim commitment was not found in the on-chain market state. Double-check that you claimed this exact market on the same network.",
      });
    }
    if (!commitmentRecord) {
      return res.status(404).json({ error: "commitment not found" });
    }

    if (String(commitmentRecord.owner ?? "").trim() !== walletAddress) {
      return res.status(400).json({ error: "commitment owner does not match walletAddress" });
    }

    if (!Boolean(commitmentRecord.claimed)) {
      return res.status(400).json({ error: "commitment has not been claimed on-chain" });
    }

    const canonicalCategory = normalizeCategory(marketConfig.category);
    if (canonicalCategory !== category) {
      return res.status(400).json({ error: "category mismatch" });
    }

    const payoutInStroops = (
      BigInt(commitmentRecord.collateral_amount ?? 0)
      * BigInt(marketState.distributable_pot ?? 0)
    ) / BigInt(marketState.winning_side_total ?? 1);
    const txCreatedAtSeconds = tx.createdAt
      ? Math.floor(new Date(tx.createdAt).getTime() / 1000)
      : NaN;
    const claimedAt = Number.isFinite(txCreatedAtSeconds) && txCreatedAtSeconds > 0
      ? txCreatedAtSeconds
      : claimedAtHint > 0
        ? Math.floor(claimedAtHint / 1000)
        : Math.floor(Date.now() / 1000);
    const resolvedAt = Number(BigInt(marketState.settled_at ?? 0));
    const expectedRecordCommitment = computeRecordCommitment({
      walletAddress,
      marketId,
      category,
      amountInStroops: BigInt(commitmentRecord.collateral_amount ?? 0),
      payoutInStroops,
      won: payoutInStroops > 0n,
      claimedAt,
      witnessSalt: BigInt(witnessSalt),
    });

    if (expectedRecordCommitment !== recordCommitment) {
      return res.status(400).json({ error: "record commitment does not match attested claim facts" });
    }

    const signedFields = signAttestedRecord({
      walletAddress,
      marketId,
      category,
      claimedAt,
      resolvedAt,
      recordCommitment,
    });
    const saved = await AttestedReputationRecord.create({
      walletAddress,
      marketId,
      category,
      claimedAt,
      resolvedAt,
      recordCommitment,
      claimTxHash,
      positionCommitment: commitment,
      claimNullifier: nullifier,
      ...signedFields,
    });

    await ReputationVault.findOneAndUpdate(
      { walletAddress },
      {
        $set: { updatedAt: Date.now() },
        $addToSet: { attestedRecords: serializeAttestedRecord(saved) },
      },
      { upsert: true, new: true },
    );

    return res.status(201).json({ record: serializeAttestedRecord(saved) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = message.includes("duplicate key");
    return res.status(duplicate ? 409 : 400).json({ error: duplicate ? "duplicate claim attestation" : message });
  }
});

app.get("/reputation-records/:walletAddress", async (req, res) => {
  const walletAddress = normalizeWalletAddress(req.params.walletAddress);
  if (!walletAddress) {
    return res.status(400).json({ error: "walletAddress is required" });
  }

  const records = await AttestedReputationRecord.find({ walletAddress }).sort({ claimedAt: -1, createdAt: -1 }).lean();
  return res.json({ records: records.map(serializeAttestedRecord) });
});

app.post("/tally-shares", async (req, res) => {
  try {
    const body = req.body ?? {};
    if (containsForbiddenWitnessFields(body)) {
      return res.status(400).json({ error: "payload contains forbidden witness fields" });
    }
    const packets = Array.isArray(body.packets)
      ? body.packets.map((packet) => parseSharePacket(packet, body))
      : [parseSharePacket(body)];
    const saved = [];
    for (const packet of packets) {
      const row = await TallyShare.create(packet);
      saved.push({ commitment: row.commitment, shardIndex: row.shardIndex });
    }
    return res.status(201).json({ ok: true, saved });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const duplicate = message.includes("duplicate key");
    return res.status(duplicate ? 409 : 400).json({ error: duplicate ? "duplicate shard submission" : message });
  }
});

app.get("/tally-shares/:marketId/status", async (req, res) => {
  const marketId = normalizeHex(req.params.marketId);
  const rows = await TallyShare.find({ marketId }).lean();
  const commitments = new Map();
  for (const row of rows) {
    const current = commitments.get(row.commitment) ?? [];
    current.push(row.shardIndex);
    commitments.set(row.commitment, current);
  }
  return res.json({
    marketId,
    commitmentCount: commitments.size,
    completeCommitmentCount: Array.from(commitments.values()).filter((shards) => new Set(shards).size === SHARD_COUNT).length,
    commitments: Array.from(commitments.entries()).map(([commitment, shards]) => ({
      commitment,
      shards: Array.from(new Set(shards)).sort((a, b) => a - b),
    })),
  });
});

app.get("/tally-shares/:marketId/aggregate", async (req, res) => {
  try {
    const state = await loadMarketState(req.params.marketId);
    const deadline = Number(asBigInt(state.tally_deadline ?? 0));
    if (deadline && Math.floor(Date.now() / 1000) < deadline) {
      return res.status(409).json({ error: "tally deadline has not passed" });
    }
    const aggregate = await aggregateMarketShares(req.params.marketId);
    return res.json({
      ...aggregate,
      yesTotal: aggregate.yesTotal.toString(),
      noTotal: aggregate.noTotal.toString(),
    });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/jobs/resolve-due-markets", async (_req, res) => {
  return res.status(410).json({
    error: "legacy resolve job is disabled; use /jobs/finalize-due-markets",
  });
});

let finalizeLoopActive = false;

async function finalizeDueMarkets() {
  const ids = await loadMarketIds();
  const results = [];
  const now = Math.floor(Date.now() / 1000);

  for (const marketId of ids) {
    const state = await loadMarketState(marketId);
    if (Boolean(state.resolved) || Boolean(state.tally_finalized)) continue;
    const deadline = Number(asBigInt(state.tally_deadline ?? 0));
    if (!deadline || now < deadline) continue;

    await FinalizationJob.findOneAndUpdate(
      { marketId },
      { $set: { marketId, status: "finalizing", error: null, updatedAt: Date.now() } },
      { upsert: true },
    );

    try {
      const aggregate = await aggregateMarketShares(marketId);
      if (aggregate.talliedCommitmentCount === 0) {
        await FinalizationJob.findOneAndUpdate(
          { marketId },
          { $set: { status: "skipped_no_complete_tallies", error: null, updatedAt: Date.now() } },
          { upsert: true },
        );
        results.push({ marketId, status: "skipped_no_complete_tallies" });
        continue;
      }

      const txHash = await submitFinalize(marketId, aggregate);
      await FinalizationJob.findOneAndUpdate(
        { marketId },
        { $set: { status: "finalized", txHash, error: null, updatedAt: Date.now() } },
        { upsert: true },
      );
      results.push({ marketId, status: "finalized", txHash });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await FinalizationJob.findOneAndUpdate(
        { marketId },
        { $set: { status: "error", error: message, updatedAt: Date.now() } },
        { upsert: true },
      );
      results.push({ marketId, status: "error", error: message });
    }
  }

  return results;
}

async function runFinalizeCronTick() {
  if (finalizeLoopActive) {
    return;
  }

  finalizeLoopActive = true;
  try {
    const results = await finalizeDueMarkets();
    if (results.length > 0) {
      console.log("[finalize-cron] processed due markets", JSON.stringify(results));
    }
  } catch (error) {
    console.error("[finalize-cron] failed", error);
  } finally {
    finalizeLoopActive = false;
  }
}

app.post("/jobs/finalize-due-markets", async (_req, res) => {
  try {
    const results = await finalizeDueMarkets();
    return res.json({ ok: true, results });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  app.listen(PORT, () => {
    console.log(`Profile backend listening on http://localhost:${PORT}`);
  });
  setInterval(runFinalizeCronTick, Math.max(5000, FINALIZE_CRON_MS));
  void runFinalizeCronTick();
}

start().catch((error) => {
  console.error("Failed to start profile backend:", error);
  process.exit(1);
});
