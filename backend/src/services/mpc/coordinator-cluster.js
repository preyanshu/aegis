import mongoose from "mongoose";
import { reconstructSecretString, splitSecretString } from "./shamir.js";

const NODE_COUNT = 5;
const SHARD_THRESHOLD = 3;
const DEFAULT_COORDINATOR_DB_NAME = "aegis_mpc_coordinator";
const DEFAULT_NODE_URLS = [
  "http://127.0.0.1:4101",
  "http://127.0.0.1:4102",
  "http://127.0.0.1:4103",
  "http://127.0.0.1:4104",
  "http://127.0.0.1:4105",
];

function buildCoordinatorConnection() {
  const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/aegis";
  const dbName = process.env.MPC_COORDINATOR_DB ?? DEFAULT_COORDINATOR_DB_NAME;
  return mongoose.createConnection(uri, { dbName });
}

function buildNodeUrls() {
  return Array.from({ length: NODE_COUNT }, (_unused, index) => (
    process.env[`MPC_NODE_${index + 1}_URL`] ?? DEFAULT_NODE_URLS[index]
  ));
}

function buildPacketId(packet) {
  return [
    packet.marketId,
    packet.commitment,
    String(packet.shardIndex),
    packet.tallyTxHash,
  ].map((part) => String(part).trim().toLowerCase()).join(":");
}

function buildCoordinatorModels(connection) {
  const packetSchema = new mongoose.Schema(
    {
      packetId: { type: String, required: true, unique: true, index: true, trim: true },
      marketId: { type: String, required: true, index: true, trim: true },
      commitment: { type: String, required: true, index: true, trim: true },
      owner: { type: String, default: null, trim: true },
      shardIndex: { type: Number, required: true, min: 1, max: NODE_COUNT },
      shareCommitmentRoot: { type: String, required: true, trim: true },
      tallyTxHash: { type: String, required: true, trim: true },
      createdAt: { type: Number, default: Date.now },
    },
    { timestamps: false },
  );
  packetSchema.index({ marketId: 1, commitment: 1, shardIndex: 1 }, { unique: true });

  const jobSchema = new mongoose.Schema(
    {
      marketId: { type: String, required: true, unique: true, index: true, trim: true },
      status: { type: String, required: true, default: "queued", trim: true },
      txHash: { type: String, default: null, trim: true },
      error: { type: String, default: null },
      updatedAt: { type: Number, default: Date.now },
    },
    { timestamps: false },
  );

  return {
    packet: connection.model("MpcCoordinatorPacket", packetSchema),
    job: connection.model("MpcCoordinatorJob", jobSchema),
  };
}

async function fetchJson(url, init = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(init.headers ?? {}),
      },
    });

    const payload = await response.json().catch(() => null);
    return { response, payload };
  } finally {
    clearTimeout(timeout);
  }
}

async function healthCheck(url) {
  try {
    const { response } = await fetchJson(`${url}/health`);
    return response.ok;
  } catch {
    return false;
  }
}

export function createMpcCluster() {
  const nodeUrls = buildNodeUrls();
  const coordinatorConnection = buildCoordinatorConnection();
  const coordinatorModels = buildCoordinatorModels(coordinatorConnection);

  async function postShareToNode(nodeIndex, packetId, packet, share) {
    const url = nodeUrls[nodeIndex];
    const { response, payload } = await fetchJson(`${url}/shares/upsert`, {
      method: "POST",
      body: JSON.stringify({
        packetId,
        marketId: packet.marketId,
        commitment: packet.commitment,
        shardIndex: packet.shardIndex,
        owner: packet.owner ?? null,
        shareCommitmentRoot: packet.shareCommitmentRoot,
        tallyTxHash: packet.tallyTxHash,
        nodeIndex: nodeIndex + 1,
        share,
      }),
    });

    if (!response.ok) {
      throw new Error(payload?.error ?? `failed to store share on node ${nodeIndex + 1}`);
    }
  }

  async function readShareFromNode(nodeIndex, packetId) {
    const url = nodeUrls[nodeIndex];
    try {
      const { response, payload } = await fetchJson(`${url}/shares/${encodeURIComponent(packetId)}`);
      if (!response.ok || !payload?.share) {
        return null;
      }
      return payload.share;
    } catch {
      return null;
    }
  }

  return {
    async ready() {
      await coordinatorConnection.asPromise();
      void Promise.allSettled(nodeUrls.map(healthCheck));
    },

    async close() {
      await coordinatorConnection.close();
    },

    async storePacket(packet) {
      const packetId = buildPacketId(packet);
      const secretBundle = JSON.stringify({
        marketId: packet.marketId,
        commitment: packet.commitment,
        owner: packet.owner ?? null,
        shardIndex: packet.shardIndex,
        yesShare: packet.yesShare,
        noShare: packet.noShare,
        shareSalt: packet.shareSalt,
        shareCommitment: packet.shareCommitment,
        shareCommitmentRoot: packet.shareCommitmentRoot,
        tallyTxHash: packet.tallyTxHash,
      });
      const shares = splitSecretString(secretBundle, { threshold: SHARD_THRESHOLD, shareCount: NODE_COUNT });

      await coordinatorModels.packet.findOneAndUpdate(
        { packetId },
        {
          $set: {
            packetId,
            marketId: packet.marketId,
            commitment: packet.commitment,
            owner: packet.owner ?? null,
            shardIndex: packet.shardIndex,
            shareCommitmentRoot: packet.shareCommitmentRoot,
            tallyTxHash: packet.tallyTxHash,
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

      await Promise.all(shares.map((share, nodeIndex) => postShareToNode(nodeIndex, packetId, packet, share)));

      return {
        packetId,
        nodeCount: NODE_COUNT,
        threshold: SHARD_THRESHOLD,
      };
    },

    async listPacketsForMarket(marketId) {
      return coordinatorModels.packet.find({ marketId }).sort({ shardIndex: 1, createdAt: 1 }).lean();
    },

    async loadPacketShareCounts(packetId) {
      const results = await Promise.all(nodeUrls.map(async (_url, nodeIndex) => readShareFromNode(nodeIndex, packetId)));
      return results.filter(Boolean).length;
    },

    async reconstructPacket(packetId) {
      const shares = [];
      for (let index = 0; index < nodeUrls.length; index += 1) {
        const share = await readShareFromNode(index, packetId);
        if (share) {
          shares.push(share);
        }
        if (shares.length >= SHARD_THRESHOLD) {
          break;
        }
      }

      if (shares.length < SHARD_THRESHOLD) {
        return null;
      }

      return JSON.parse(reconstructSecretString(shares));
    },

    async getMarketStatus(marketId) {
      const packets = await this.listPacketsForMarket(marketId);
      const packetStatuses = await Promise.all(packets.map(async (packet) => ({
        packetId: packet.packetId,
        commitment: packet.commitment,
        shardIndex: packet.shardIndex,
        nodeShareCount: await this.loadPacketShareCounts(packet.packetId),
      })));

      const commitments = new Map();
      for (const packet of packetStatuses) {
        const current = commitments.get(packet.commitment) ?? [];
        current.push(packet.shardIndex);
        commitments.set(packet.commitment, current);
      }

      return {
        marketId,
        packetCount: packets.length,
        commitmentCount: commitments.size,
        completePacketCount: packetStatuses.filter((packet) => packet.nodeShareCount >= SHARD_THRESHOLD).length,
        completeCommitmentCount: packetStatuses.filter((packet) => packet.nodeShareCount >= SHARD_THRESHOLD).length,
        commitments: Array.from(commitments.entries()).map(([commitment, shards]) => ({
          commitment,
          shards: Array.from(new Set(shards)).sort((left, right) => left - right),
        })),
        packets: packetStatuses,
      };
    },

    async upsertJob(marketId, patch) {
      return coordinatorModels.job.findOneAndUpdate(
        { marketId },
        {
          $set: {
            marketId,
            updatedAt: Date.now(),
            ...patch,
          },
        },
        {
          upsert: true,
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
        },
      );
    },
  };
}
