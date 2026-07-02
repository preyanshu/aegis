import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import mongoose from "mongoose";
import { loadEnv } from "../../env.js";

loadEnv({
  preserve: [
    "PORT",
    "MONGODB_URI",
    "MPC_NODE_DB",
    "MPC_NODE_INDEX",
    "MPC_NODE_PORT",
  ],
});

const PORT = Number(process.env.PORT ?? process.env.MPC_NODE_PORT ?? 4101);
const NODE_INDEX = Number(process.env.MPC_NODE_INDEX ?? 1);
const MONGODB_URI = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/aegis";
const MPC_NODE_DB = process.env.MPC_NODE_DB ?? `aegis_mpc_node_${NODE_INDEX}`;

mongoose.set("strictQuery", true);

const nodeShareSchema = new mongoose.Schema(
  {
    packetId: { type: String, required: true, unique: true, index: true, trim: true },
    marketId: { type: String, required: true, index: true, trim: true },
    commitment: { type: String, required: true, index: true, trim: true },
    shardIndex: { type: Number, required: true, min: 1, max: 5 },
    nodeIndex: { type: Number, required: true, min: 1, max: 5 },
    owner: { type: String, default: null, trim: true },
    shareCommitmentRoot: { type: String, required: true, trim: true },
    tallyTxHash: { type: String, required: true, trim: true },
    share: { type: mongoose.Schema.Types.Mixed, required: true },
    createdAt: { type: Number, default: Date.now },
    updatedAt: { type: Number, default: Date.now },
  },
  { timestamps: false },
);

const app = express();
let nodeConnection = null;
let shareModel = null;
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(morgan("tiny"));
app.use(cors({ origin: "*", credentials: false }));

function normalizePacketId(value) {
  return String(value ?? "").trim();
}

function validateShareBody(body) {
  const packetId = normalizePacketId(body?.packetId);
  const marketId = normalizePacketId(body?.marketId);
  const commitment = normalizePacketId(body?.commitment);
  const share = body?.share;
  const shardIndex = Number(body?.shardIndex ?? 0);
  const nodeIndex = Number(body?.nodeIndex ?? NODE_INDEX);
  const shareCommitmentRoot = normalizePacketId(body?.shareCommitmentRoot);
  const tallyTxHash = normalizePacketId(body?.tallyTxHash);

  if (!packetId || !marketId || !commitment || !shareCommitmentRoot || !tallyTxHash) {
    throw new Error("packetId, marketId, commitment, shareCommitmentRoot, and tallyTxHash are required");
  }

  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > 5) {
    throw new Error("shardIndex must be between 1 and 5");
  }

  if (nodeIndex !== NODE_INDEX) {
    throw new Error(`nodeIndex mismatch for node ${NODE_INDEX}`);
  }

  if (!share || typeof share !== "object" || typeof share.x !== "number" || !Array.isArray(share.values)) {
    throw new Error("share must be a Shamir share object");
  }

  return {
    packetId,
    marketId,
    commitment,
    shardIndex,
    nodeIndex,
    owner: body?.owner ? String(body.owner).trim() : null,
    shareCommitmentRoot,
    tallyTxHash,
    share,
  };
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    nodeIndex: NODE_INDEX,
    dbName: MPC_NODE_DB,
  });
});

app.post("/shares/upsert", async (req, res) => {
  try {
    const share = validateShareBody(req.body ?? {});
    const saved = await shareModel.findOneAndUpdate(
      { packetId: share.packetId },
      {
        $set: {
          ...share,
          updatedAt: Date.now(),
        },
        $setOnInsert: {
          createdAt: Date.now(),
        },
      },
      {
        upsert: true,
        new: true,
        runValidators: true,
        setDefaultsOnInsert: true,
      },
    );

    return res.status(201).json({
      share: {
        packetId: saved.packetId,
        marketId: saved.marketId,
        commitment: saved.commitment,
        shardIndex: saved.shardIndex,
        nodeIndex: saved.nodeIndex,
        owner: saved.owner,
        shareCommitmentRoot: saved.shareCommitmentRoot,
        tallyTxHash: saved.tallyTxHash,
        share: saved.share,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(400).json({ error: message });
  }
});

app.get("/shares/:packetId", async (req, res) => {
  const packetId = normalizePacketId(req.params.packetId);
  if (!packetId) {
    return res.status(400).json({ error: "packetId is required" });
  }

  const share = await shareModel.findOne({ packetId }).lean();
  if (!share) {
    return res.status(404).json({ share: null });
  }

  return res.json({
    share: {
      packetId: share.packetId,
      marketId: share.marketId,
      commitment: share.commitment,
      shardIndex: share.shardIndex,
      nodeIndex: share.nodeIndex,
      owner: share.owner,
      shareCommitmentRoot: share.shareCommitmentRoot,
      tallyTxHash: share.tallyTxHash,
      share: share.share,
    },
  });
});

async function start() {
  nodeConnection = mongoose.createConnection(MONGODB_URI, { dbName: MPC_NODE_DB });
  await nodeConnection.asPromise();
  shareModel = nodeConnection.model("MpcNodeShare", nodeShareSchema);
  app.listen(PORT, () => {
    console.log(`MPC node ${NODE_INDEX} listening on http://localhost:${PORT}`);
  });
}

export async function startMpcNodeService() {
  await start();
}
