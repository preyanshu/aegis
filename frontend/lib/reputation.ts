import { Keypair } from "@stellar/stellar-sdk";
import { Buffer } from "buffer";
import { marketIdToField, padHex32 } from "@/lib/proof-artifacts";

const WINDOW_OPTIONS = [30, 90, 180] as const;
const FIELD_MASK = (1n << 248n) - 1n;
const MAX_PEERS = 16;
const MERKLE_LEAF_COUNT = 16;
const MERKLE_DEPTH = 4;

const METRIC_CODES = {
  roi: 0,
  profit: 1,
  winRate: 2,
  participation: 3,
  exposure: 4,
} as const;

export type ReputationWindowDays = (typeof WINDOW_OPTIONS)[number];
export type ReputationMetric = keyof typeof METRIC_CODES;

export type ReputationThresholdClaim = {
  claimType: "threshold";
  metric: ReputationMetric;
  threshold: bigint | string;
  metricCode: number;
};

export type ReputationPercentileClaim = {
  claimType: "percentile";
  band: 10 | 25 | 50;
  metricCode: number;
};

export type ReputationClaimDescriptor = ReputationThresholdClaim | ReputationPercentileClaim;

export type SerializedReputationClaimDescriptor =
  | ReputationPercentileClaim
  | {
    claimType: "threshold";
    metric: ReputationMetric;
    threshold: string;
    metricCode: number;
  };

export type ReputationRecordInput = {
  marketId: string;
  subjectId: string;
  category: string;
  resolvedAt: number;
  claimedAt: number;
  amountInStroops: bigint | string;
  payoutInStroops: bigint | string;
  won: boolean;
  recordCommitment?: bigint | string;
  witnessSalt?: bigint | string;
};

export type AttestedReputationRecord = {
  walletAddress: string;
  marketId: string;
  category: string;
  claimedAt: number;
  resolvedAt: number;
  recordCommitment: string;
  attestorSignature: string;
  attestorKeyId: string;
  claimTxHash: string;
};

export type PrivateReputationWitness = {
  marketId: string;
  commitment: string;
  nullifier: string;
  side: "YES" | "NO";
  amountInStroops: string;
  payoutInStroops: string;
  won: boolean;
  claimedAt: number;
  resolvedAt: number;
  category: string;
  witnessSalt: string;
  recordCommitment: string;
};

type NormalizedRecord = {
  marketId: string;
  subjectId: string;
  category: string;
  resolvedAt: number;
  claimedAt: number;
  amountInStroops: bigint;
  payoutInStroops: bigint;
  won: boolean;
  recordCommitment: bigint;
  witnessSalt: bigint;
};

export type ReputationSnapshot = {
  subjectId: string;
  category: string;
  windowDays: ReputationWindowDays;
  snapshotRoot: bigint;
  records: NormalizedRecord[];
  attestedRecords: AttestedReputationRecord[];
  peerSubjects: Array<{ subjectId: string; records: NormalizedRecord[] }>;
  merkleTree: bigint[];
  merkleLeaves: bigint[];
  sortedCommitments: bigint[];
};

export type ReputationMetricResult = {
  publicThreshold: bigint;
  privateMetric: bigint;
  eligibleCount: bigint;
  peerScores: bigint[];
  peerEligible: bigint[];
  displayValue: string;
};

export type PortableReputationClaimPayload = {
  claim: SerializedReputationClaimDescriptor;
  publicClaim: {
    subjectId: string;
    category: string;
    windowDays: ReputationWindowDays;
    snapshotRoot: string;
    attestorKeyId: string;
    createdAt: number;
    snapshotRecordCount: number;
    statement: string;
  };
  envelope: {
    proofHex: string;
    publicInputsHex: string[];
  };
};

export function stringSubjectToField(value: string) {
  let acc = 0n;
  for (let index = 0; index < value.length; index += 1) {
    acc = ((acc * 257n) + BigInt(value.charCodeAt(index))) & FIELD_MASK;
  }
  return acc;
}

export function categoryCodeForField(value: string) {
  return stringSubjectToField(value.toLowerCase());
}

export function windowDaysToField(value: ReputationWindowDays) {
  return BigInt(value);
}

export function claimTypeCode(claim: ReputationClaimDescriptor) {
  return BigInt(claim.claimType === "percentile" ? 5 : claim.metricCode);
}

function normalizeRecord(record: ReputationRecordInput): NormalizedRecord {
  return {
    marketId: String(record.marketId).toLowerCase(),
    subjectId: String(record.subjectId).toLowerCase(),
    category: String(record.category).toLowerCase(),
    resolvedAt: Number(record.resolvedAt),
    claimedAt: Number(record.claimedAt),
    amountInStroops: BigInt(record.amountInStroops),
    payoutInStroops: BigInt(record.payoutInStroops),
    won: Boolean(record.won),
    recordCommitment: BigInt(record.recordCommitment ?? 0),
    witnessSalt: BigInt(record.witnessSalt ?? 0),
  };
}

function hexToBytes(hex: string) {
  const clean = hex.replace(/^0x/i, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(clean.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function combineFieldLike(inputs: bigint[]) {
  let acc = 0n;
  for (const input of inputs) {
    acc = ((acc * 1315423911n) + (input & FIELD_MASK)) & FIELD_MASK;
  }
  return acc;
}

function formatUsdcFromStroops(value: bigint) {
  const whole = value / 10_000_000n;
  const fraction = (value % 10_000_000n).toString().padStart(7, "0").replace(/0+$/, "");
  return fraction ? `${whole.toString()}.${fraction} USDC` : `${whole.toString()} USDC`;
}

function formatBasisPoints(value: bigint) {
  const percent = Number(value) / 100;
  return Number.isInteger(percent) ? `${percent.toFixed(0)}%` : `${percent.toFixed(2)}%`;
}

function formatClaimThreshold(claim: ReputationThresholdClaim) {
  const threshold = BigInt(claim.threshold);
  if (claim.metric === "roi" || claim.metric === "winRate") {
    return formatBasisPoints(threshold);
  }
  if (claim.metric === "profit" || claim.metric === "exposure") {
    return formatUsdcFromStroops(threshold);
  }
  return threshold.toString();
}

function claimBackedMetricLabel(metric: ReputationMetric) {
  if (metric === "winRate") return "claim-backed win rate";
  if (metric === "roi") return "claim-backed ROI";
  if (metric === "profit") return "claim-backed profit";
  if (metric === "participation") return "claim-backed participation";
  return "claim-backed exposure";
}

export function buildAttestationMessage(record: {
  walletAddress: string;
  marketId: string;
  category: string;
  claimedAt: number;
  resolvedAt: number;
  recordCommitment: string;
}) {
  return [
    record.walletAddress.trim().toLowerCase(),
    record.marketId.trim().toLowerCase(),
    record.category.trim().toLowerCase(),
    String(record.claimedAt),
    String(record.resolvedAt),
    record.recordCommitment.trim().toLowerCase(),
  ].join("|");
}

export function verifyAttestedRecordSignature(record: AttestedReputationRecord) {
  try {
    const keypair = Keypair.fromPublicKey(record.attestorKeyId);
    return keypair.verify(
      Buffer.from(buildAttestationMessage(record), "utf8"),
      Buffer.from(hexToBytes(record.attestorSignature)),
    );
  } catch {
    return false;
  }
}

export function computeRecordCommitmentFallback(input: {
  walletAddress: string;
  marketId: string;
  category: string;
  amountInStroops: bigint;
  payoutInStroops: bigint;
  won: boolean;
  claimedAt: number;
  witnessSalt: bigint;
}) {
  return padHex32(combineFieldLike([
    stringSubjectToField(input.walletAddress.toLowerCase()),
    marketIdToField(input.marketId),
    categoryCodeForField(input.category),
    input.amountInStroops,
    input.payoutInStroops,
    input.won ? 1n : 0n,
    BigInt(input.claimedAt),
    input.witnessSalt,
  ]));
}

export function buildMerkleTree(commitments: bigint[]) {
  const leaves = commitments.slice(0, MERKLE_LEAF_COUNT);
  while (leaves.length < MERKLE_LEAF_COUNT) {
    leaves.push(0n);
  }

  const tree = [...leaves];
  let level = leaves;
  while (level.length > 1) {
    const next: bigint[] = [];
    for (let index = 0; index < level.length; index += 2) {
      next.push(combineFieldLike([level[index] ?? 0n, level[index + 1] ?? 0n]));
    }
    tree.push(...next);
    level = next;
  }

  return { leaves, tree, root: level[0] ?? 0n };
}

export function buildMerkleProof(tree: bigint[], leafIndex: number) {
  const siblings: bigint[] = [];
  let index = leafIndex;
  let levelOffset = 0;
  let width = MERKLE_LEAF_COUNT;

  while (width > 1) {
    siblings.push(tree[levelOffset + (index ^ 1)] ?? 0n);
    levelOffset += width;
    index = Math.floor(index / 2);
    width /= 2;
  }

  return siblings;
}

export function merkleLeafCount() {
  return MERKLE_LEAF_COUNT;
}

export function merkleDepth() {
  return MERKLE_DEPTH;
}

export function createClaimDescriptor(
  descriptor:
    | { claimType: "percentile"; band: 10 | 25 | 50 }
    | { claimType: "threshold"; metric: ReputationMetric; threshold: string | number | bigint },
): ReputationClaimDescriptor {
  if (descriptor.claimType === "percentile") {
    return {
      claimType: "percentile",
      band: descriptor.band,
      metricCode: METRIC_CODES.roi,
    };
  }

  return {
    claimType: "threshold",
    metric: descriptor.metric,
    threshold: BigInt(descriptor.threshold),
    metricCode: METRIC_CODES[descriptor.metric],
  };
}

export function buildSnapshot(records: ReputationRecordInput[], scope: {
  category: string;
  subjectId: string;
  windowDays: ReputationWindowDays;
  attestedRecords?: AttestedReputationRecord[];
}) {
  if (!WINDOW_OPTIONS.includes(scope.windowDays)) {
    throw new Error(`unsupported window: ${scope.windowDays}`);
  }

  const subjectId = scope.subjectId.toLowerCase();
  const normalized = records.map(normalizeRecord);
  const filtered = normalized.filter((record) => (
    record.category === scope.category.toLowerCase()
    && record.claimedAt > 0
    && record.resolvedAt > 0
  ));

  const latestClaim = filtered.reduce((max, record) => Math.max(max, record.claimedAt), 0);
  const windowStart = latestClaim > 0 ? latestClaim - (scope.windowDays * 24 * 60 * 60) : 0;
  const windowed = filtered.filter((record) => record.claimedAt >= windowStart);

  const perSubject = new Map<string, NormalizedRecord[]>();
  for (const record of windowed) {
    const current = perSubject.get(record.subjectId) ?? [];
    current.push(record);
    perSubject.set(record.subjectId, current);
  }

  const attestedRecords = (scope.attestedRecords ?? []).filter((record) => (
    record.walletAddress.toLowerCase() === subjectId
    && record.category.toLowerCase() === scope.category.toLowerCase()
    && record.claimedAt >= windowStart
  ));
  const sortedCommitments = attestedRecords
    .map((record) => BigInt(record.recordCommitment))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  const merkle = buildMerkleTree(sortedCommitments);

  return {
    subjectId,
    category: scope.category.toLowerCase(),
    windowDays: scope.windowDays,
    snapshotRoot: merkle.root,
    records: perSubject.get(subjectId) ?? [],
    attestedRecords,
    peerSubjects: [...perSubject.entries()]
      .filter(([recordSubjectId]) => recordSubjectId !== subjectId)
      .map(([subjectId, subjectRecords]) => ({ subjectId, records: subjectRecords })),
    merkleTree: merkle.tree,
    merkleLeaves: merkle.leaves,
    sortedCommitments,
  } satisfies ReputationSnapshot;
}

function metricsForRecords(records: NormalizedRecord[]) {
  const participation = BigInt(records.length);
  const exposure = records.reduce((sum, record) => sum + record.amountInStroops, 0n);
  const profit = records.reduce((sum, record) => sum + (record.payoutInStroops - record.amountInStroops), 0n);
  const wins = BigInt(records.filter((record) => record.won).length);
  const roi = exposure > 0n ? (profit * 10_000n) / exposure : 0n;
  const winRate = participation > 0n ? (wins * 10_000n) / participation : 0n;

  return { participation, exposure, profit, roi, winRate };
}

function thresholdMetric(snapshot: ReputationSnapshot, metric: ReputationMetric) {
  const metrics = metricsForRecords(snapshot.records);
  if (metric === "roi") return metrics.roi;
  if (metric === "profit") return metrics.profit;
  if (metric === "winRate") return metrics.winRate;
  if (metric === "participation") return metrics.participation;
  return metrics.exposure;
}

function peerRankingData(snapshot: ReputationSnapshot) {
  const eligiblePeers = snapshot.peerSubjects
    .map(({ subjectId, records }) => ({ subjectId, metrics: metricsForRecords(records) }))
    .filter(({ metrics }) => metrics.participation >= 2n);
  const peerScores = eligiblePeers
    .map(({ metrics }) => metrics.roi)
    .sort((left, right) => (left > right ? -1 : left < right ? 1 : 0));
  return { eligiblePeers, peerScores };
}

export function computeClaimMetric(snapshot: ReputationSnapshot, claim: ReputationClaimDescriptor): ReputationMetricResult {
  if (claim.claimType === "percentile") {
    const subjectMetrics = metricsForRecords(snapshot.records);
    const { eligiblePeers, peerScores } = peerRankingData(snapshot);
    const peers = peerScores.slice(0, MAX_PEERS);
    while (peers.length < MAX_PEERS) {
      peers.push(0n);
    }
    const peerEligible = Array.from(
      { length: MAX_PEERS },
      (_, index) => index < Math.min(eligiblePeers.length, MAX_PEERS) ? 1n : 0n,
    );
    return {
      publicThreshold: BigInt(claim.band),
      privateMetric: subjectMetrics.roi,
      eligibleCount: BigInt(Math.max(1, eligiblePeers.length + 1)),
      peerScores: peers,
      peerEligible,
      displayValue: `top ${claim.band}%`,
    };
  }

  const threshold = BigInt(claim.threshold);
  const value = thresholdMetric(snapshot, claim.metric);
  return {
    publicThreshold: threshold,
    privateMetric: value,
    eligibleCount: 1n,
    peerScores: Array.from({ length: MAX_PEERS }, () => 0n),
    peerEligible: Array.from({ length: MAX_PEERS }, () => 0n),
    displayValue: `${claimBackedMetricLabel(claim.metric)} >= ${formatClaimThreshold(claim)} over ${snapshot.windowDays}-day window`,
  };
}

export function buildReputationPublicInputs(
  snapshot: ReputationSnapshot,
  claim: ReputationClaimDescriptor,
  metric: ReputationMetricResult,
) {
  return [
    claimTypeCode(claim),
    categoryCodeForField(snapshot.category),
    windowDaysToField(snapshot.windowDays),
    metric.publicThreshold,
    stringSubjectToField(snapshot.subjectId),
    snapshot.snapshotRoot,
  ];
}

export function serializeReputationProof(payload: {
  claim: ReputationClaimDescriptor;
  snapshot: ReputationSnapshot;
  metric: ReputationMetricResult;
  envelope: {
    proofHex: string;
    publicInputsHex: string[];
    attestorKeyId: string;
  };
}) {
  const serializedClaim: SerializedReputationClaimDescriptor = payload.claim.claimType === "threshold"
    ? {
      ...payload.claim,
      threshold: payload.claim.threshold.toString(),
    }
    : payload.claim;
  return JSON.stringify({
    claim: serializedClaim,
    publicClaim: {
      subjectId: payload.snapshot.subjectId,
      category: payload.snapshot.category,
      windowDays: payload.snapshot.windowDays,
      snapshotRoot: `0x${payload.snapshot.snapshotRoot.toString(16)}`,
      attestorKeyId: payload.envelope.attestorKeyId,
      createdAt: Date.now(),
      snapshotRecordCount: payload.snapshot.records.length,
      statement: payload.metric.displayValue,
    },
    envelope: {
      proofHex: payload.envelope.proofHex,
      publicInputsHex: payload.envelope.publicInputsHex,
    },
  });
}

export function verifyPortableReputationClaim(serialized: string): PortableReputationClaimPayload {
  const parsed = JSON.parse(serialized) as PortableReputationClaimPayload;
  if (!parsed?.publicClaim?.subjectId || !parsed?.envelope?.proofHex) {
    throw new Error("invalid reputation proof payload");
  }
  return parsed;
}

export function reputationStatementLabel(claim: ReputationClaimDescriptor) {
  if (claim.claimType === "percentile") {
    return `Proven top ${claim.band}% claim-backed ROI`;
  }

  const metricLabel = claimBackedMetricLabel(claim.metric);

  const threshold = BigInt(claim.threshold);
  const thresholdLabel = claim.metric === "roi" || claim.metric === "winRate"
    ? formatBasisPoints(threshold)
    : claim.metric === "profit" || claim.metric === "exposure"
      ? formatUsdcFromStroops(threshold)
      : threshold.toString();

  return `Proven ${metricLabel} >= ${thresholdLabel}`;
}
