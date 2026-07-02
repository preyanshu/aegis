import { amountUsdcToStroops, derivePositionArtifacts, marketIdToField, padHex32 } from "@/lib/proof-artifacts";
import {
  buildMerkleProof,
  buildReputationPublicInputs,
  buildSnapshot,
  computeRecordCommitmentFallback,
  claimTypeCode,
  computeClaimMetric,
  createClaimDescriptor,
  merkleDepth,
  merkleLeafCount,
  serializeReputationProof,
  verifyAttestedRecordSignature,
  stringSubjectToField,
  verifyPortableReputationClaim,
  windowDaysToField,
  type AttestedReputationRecord,
  type ReputationRecordInput,
  type ReputationWindowDays,
} from "@/lib/reputation";
import { bytesToHex } from "@/lib/stellar";
import type { CompiledCircuit } from "@noir-lang/types";
import { Buffer } from "buffer";

type CircuitArtifact = CompiledCircuit;

const proofOptions = { keccak: true };
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

let commitCircuitPromise: Promise<CircuitArtifact> | null = null;
let tallyUpdateCircuitPromise: Promise<CircuitArtifact> | null = null;
let tallyFinalizeCircuitPromise: Promise<CircuitArtifact> | null = null;
let claimCircuitPromise: Promise<CircuitArtifact> | null = null;
let reputationCircuitPromise: Promise<CircuitArtifact> | null = null;

function installBigIntBufferPolyfill() {
  type BigIntBufferMethods = {
    writeBigUInt64BE?: (value: bigint, offset?: number) => number;
    readBigUInt64BE?: (offset?: number) => bigint;
    writeBigInt64BE?: (value: bigint, offset?: number) => number;
    readBigInt64BE?: (offset?: number) => bigint;
  };

  const installOnPrototype = (prototype: Uint8Array & BigIntBufferMethods) => {
    if (!prototype.writeBigUInt64BE) {
      prototype.writeBigUInt64BE = function writeBigUInt64BE(value: bigint, offset = 0) {
        let remaining = BigInt.asUintN(64, value);
        for (let index = 7; index >= 0; index -= 1) {
          this[offset + index] = Number(remaining & 0xffn);
          remaining >>= 8n;
        }
        return offset + 8;
      };
    }

    if (!prototype.readBigUInt64BE) {
      prototype.readBigUInt64BE = function readBigUInt64BE(offset = 0) {
        let value = 0n;
        for (let index = 0; index < 8; index += 1) {
          value = (value << 8n) | BigInt(this[offset + index] ?? 0);
        }
        return value;
      };
    }

    if (!prototype.writeBigInt64BE) {
      prototype.writeBigInt64BE = function writeBigInt64BE(value: bigint, offset = 0) {
        return this.writeBigUInt64BE!(BigInt.asUintN(64, value), offset);
      };
    }

    if (!prototype.readBigInt64BE) {
      prototype.readBigInt64BE = function readBigInt64BE(offset = 0) {
        const value = this.readBigUInt64BE!(offset);
        return value > 0x7fffffffffffffffn ? value - 0x10000000000000000n : value;
      };
    }
  };

  const bufferPrototype = Buffer.prototype as Buffer & {
    writeBigUInt64BE?: (value: bigint, offset?: number) => number;
    readBigUInt64BE?: (offset?: number) => bigint;
    writeBigInt64BE?: (value: bigint, offset?: number) => number;
    readBigInt64BE?: (offset?: number) => bigint;
  };
  installOnPrototype(bufferPrototype);
  installOnPrototype(Uint8Array.prototype as Uint8Array & BigIntBufferMethods);
}

function randomFieldSalt() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return `0x${bytesToHex(bytes)}`;
}

export function randomWitnessSalt() {
  return randomFieldSalt();
}

export async function computeRecordCommitment(input: {
  walletAddress: string;
  marketId: string;
  category: string;
  amountInStroops: bigint;
  payoutInStroops: bigint;
  won: boolean;
  claimedAt: number;
  witnessSalt: string;
}) {
  return computeRecordCommitmentFallback({
    ...input,
    witnessSalt: BigInt(input.witnessSalt),
  });
}

function randomBigIntBelow(maxExclusive: bigint) {
  if (maxExclusive <= 1n) {
    return 0n;
  }

  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return BigInt(`0x${bytesToHex(bytes)}`) % maxExclusive;
}

function additiveShares(total: bigint, count: number) {
  const shares: bigint[] = [];
  let remaining = ((total % FIELD_MODULUS) + FIELD_MODULUS) % FIELD_MODULUS;
  for (let index = 0; index < count - 1; index += 1) {
    const next = randomBigIntBelow(FIELD_MODULUS);
    shares.push(next);
    remaining = (remaining + FIELD_MODULUS - next) % FIELD_MODULUS;
  }
  shares.push(remaining);
  return shares;
}

async function ensurePoseidon() {
  installBigIntBufferPolyfill();
  if (typeof globalThis !== "undefined") {
    (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;
  }
  const { BarretenbergSync, Fr: FrBarretenberg } = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  await BarretenbergSync.initSingleton();
  return {
    poseidon2Permutation: async (inputs: Array<bigint | number | string>) => {
      const api = BarretenbergSync.getSingleton();
      const result = await api.poseidon2Permutation(
        inputs.map((input) => new FrBarretenberg(typeof input === "string" ? BigInt(input) : BigInt(input))),
      );
      return result.map((field: { toBuffer(): Uint8Array }) => BigInt(`0x${bytesToHex(field.toBuffer())}`));
    },
  };
}

function loadCircuit(path: string, current: Promise<CircuitArtifact> | null) {
  return current ?? fetch(path).then((response) => {
    if (!response.ok) {
      throw new Error(`failed to load circuit artifact: ${response.status}`);
    }
    return response.json();
  });
}

function envelopeToProofData(envelope: { proofHex: string; publicInputsHex: string[] }) {
  return {
    proof: Uint8Array.from(Buffer.from(envelope.proofHex.replace(/^0x/i, ""), "hex")),
    publicInputs: envelope.publicInputsHex.map((value) => BigInt(value).toString()),
  };
}

export async function generateCommitProof(input: {
  marketId: string;
  side: "YES" | "NO";
  amountUsdc: number;
  minBet: bigint;
  maxBet: bigint;
}) {
  commitCircuitPromise = loadCircuit("/circuits/commit.json", commitCircuitPromise);
  const commitCircuit = await commitCircuitPromise;
  const { poseidon2Permutation } = await ensurePoseidon();

  const salt = randomFieldSalt();
  const amountInStroops = amountUsdcToStroops(input.amountUsdc);
  const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
    marketId: input.marketId,
    side: input.side,
    amountInStroops,
    salt,
  });

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(commitCircuit);
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(commitCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: amountInStroops.toString(),
    salt,
    commitment: artifacts.commitmentHex,
    market_id: artifacts.marketField.toString(),
    min_amount: input.minBet.toString(),
    max_amount: input.maxBet.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    amountInStroops,
    commitment: artifacts.commitmentHex,
    nullifier: artifacts.nullifierHex,
    proofHex: `0x${bytesToHex(proof.proof)}`,
    salt,
  };
}

export async function generateTallyUpdateProof(input: {
  marketId: string;
  side: "YES" | "NO";
  amountInStroops: bigint;
  salt: string;
  commitment: string;
  previousTallyCommitment: string;
}) {
  tallyUpdateCircuitPromise = loadCircuit("/circuits/tally_update.json", tallyUpdateCircuitPromise);
  const tallyCircuit = await tallyUpdateCircuitPromise;
  const { poseidon2Permutation } = await ensurePoseidon();
  const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
    marketId: input.marketId,
    side: input.side,
    amountInStroops: input.amountInStroops,
    salt: input.salt,
  });

  if (input.commitment.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
    throw new Error("tally proof inputs do not reproduce the saved commitment");
  }

  const [nextTallyCommitment] = await poseidon2Permutation([
    BigInt(input.previousTallyCommitment),
    BigInt(input.commitment),
    input.amountInStroops,
    artifacts.direction,
  ]);

  const yesShares = additiveShares(input.side === "YES" ? input.amountInStroops : 0n, 5);
  const noShares = additiveShares(input.side === "NO" ? input.amountInStroops : 0n, 5);
  const shareSalts = Array.from({ length: 5 }, () => randomFieldSalt());
  const shareCommitments: string[] = [];
  let shareCommitmentRoot = 0n;
  for (let index = 0; index < 5; index += 1) {
    const [saltCommitment] = await poseidon2Permutation([
      artifacts.marketField,
      BigInt(input.commitment),
      BigInt(index + 1),
      BigInt(shareSalts[index]),
    ]);
    const [shareCommitment] = await poseidon2Permutation([
      saltCommitment,
      yesShares[index],
      noShares[index],
      0n,
    ]);
    const [nextRoot] = await poseidon2Permutation([
      shareCommitmentRoot,
      shareCommitment,
      BigInt(index + 1),
      0n,
    ]);
    shareCommitmentRoot = nextRoot;
    shareCommitments.push(padHex32(shareCommitment));
  }

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(tallyCircuit);
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(tallyCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: input.amountInStroops.toString(),
    salt: input.salt,
    commitment: artifacts.commitmentHex,
    market_id: artifacts.marketField.toString(),
    collateral_amount: input.amountInStroops.toString(),
    previous_tally_commitment: input.previousTallyCommitment,
    next_tally_commitment: padHex32(BigInt(nextTallyCommitment)),
    yes_shares: yesShares.map((share) => share.toString()),
    no_shares: noShares.map((share) => share.toString()),
    share_salts: shareSalts,
    share_commitment_root: padHex32(shareCommitmentRoot),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitment: artifacts.commitmentHex,
    nextTallyCommitment: padHex32(BigInt(nextTallyCommitment)),
    shareCommitmentRoot: padHex32(shareCommitmentRoot),
    sharePackets: yesShares.map((yesShare, index) => ({
      marketId: input.marketId,
      commitment: artifacts.commitmentHex,
      shardIndex: index + 1,
      yesShare: yesShare.toString(),
      noShare: noShares[index].toString(),
      shareSalt: shareSalts[index],
      shareCommitment: shareCommitments[index],
    })),
    proofHex: `0x${bytesToHex(proof.proof)}`,
    publicInputsHex: proof.publicInputs.map((value) => `0x${BigInt(value).toString(16)}`),
  };
}

export async function generateTallyFinalizeProof(input: {
  marketId: string;
  outcome: boolean;
  finalTallyCommitment: string;
  winningSideTotal: bigint;
  positions: Array<{
    side: "YES" | "NO";
    amountInStroops: bigint;
    salt: string;
    commitment: string;
  }>;
}) {
  tallyFinalizeCircuitPromise = loadCircuit("/circuits/tally_finalize.json", tallyFinalizeCircuitPromise);
  const tallyCircuit = await tallyFinalizeCircuitPromise;
  const { poseidon2Permutation } = await ensurePoseidon();

  const maxEntries = 16;
  const directions = Array<bigint>(maxEntries).fill(0n);
  const amounts = Array<bigint>(maxEntries).fill(0n);
  const salts = Array<string>(maxEntries).fill("0x0");
  const included = Array<bigint>(maxEntries).fill(0n);

  for (let index = 0; index < Math.min(input.positions.length, maxEntries); index += 1) {
    const position = input.positions[index];
    directions[index] = position.side === "YES" ? 1n : 0n;
    amounts[index] = position.amountInStroops;
    salts[index] = position.salt;
    included[index] = 1n;
    const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
      marketId: input.marketId,
      side: position.side,
      amountInStroops: position.amountInStroops,
      salt: position.salt,
    });
    if (position.commitment.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
      throw new Error("finalization inputs do not reproduce one of the saved commitments");
    }
  }

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(tallyCircuit);
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(tallyCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    market_id: marketIdToField(input.marketId).toString(),
    final_tally_commitment: input.finalTallyCommitment,
    outcome: input.outcome ? "1" : "0",
    winning_side_total: input.winningSideTotal.toString(),
    directions: directions.map((value) => value.toString()),
    amounts: amounts.map((value) => value.toString()),
    salts,
    included: included.map((value) => value.toString()),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    proofHex: `0x${bytesToHex(proof.proof)}`,
    publicInputsHex: proof.publicInputs.map((value) => `0x${BigInt(value).toString(16)}`),
  };
}

export async function generateClaimProof(input: {
  marketId: string;
  side: "YES" | "NO";
  amountInStroops: bigint;
  salt: string;
  commitment: string;
  nullifier?: string;
  outcome: boolean;
  distributablePot: bigint;
  winningSideTotal: bigint;
}) {
  claimCircuitPromise = loadCircuit("/circuits/claim.json", claimCircuitPromise);
  const claimCircuit = await claimCircuitPromise;
  const { poseidon2Permutation } = await ensurePoseidon();
  const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
    marketId: input.marketId,
    side: input.side,
    amountInStroops: input.amountInStroops,
    salt: input.salt,
  });

  if (input.commitment.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
    throw new Error("claim proof inputs do not reproduce the saved commitment");
  }
  if (input.nullifier && input.nullifier.toLowerCase() !== artifacts.nullifierHex.toLowerCase()) {
    throw new Error("claim proof inputs do not reproduce the saved nullifier");
  }

  const payout = (input.amountInStroops * input.distributablePot) / input.winningSideTotal;
  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(claimCircuit);
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(claimCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: input.amountInStroops.toString(),
    salt: input.salt,
    commitment: artifacts.commitmentHex,
    market_id: artifacts.marketField.toString(),
    outcome: input.outcome ? "1" : "0",
    nullifier: artifacts.nullifierHex,
    distributable_pot: input.distributablePot.toString(),
    winning_side_total: input.winningSideTotal.toString(),
    payout: payout.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitment: artifacts.commitmentHex,
    nullifier: artifacts.nullifierHex,
    payout,
    proofHex: `0x${bytesToHex(proof.proof)}`,
  };
}

export async function generateReputationProof(input: {
  subjectId: string;
  category: string;
  windowDays: ReputationWindowDays;
  attestedRecords: AttestedReputationRecord[];
  attestorKeyId: string;
  onProgress?: (message: string) => void;
  descriptor:
    | { claimType: "percentile"; band: 10 | 25 | 50 }
    | { claimType: "threshold"; metric: "roi" | "profit" | "winRate" | "participation" | "exposure"; threshold: string | number | bigint };
  records: ReputationRecordInput[];
}) {
  input.onProgress?.("Loading reputation circuit...");
  reputationCircuitPromise = loadCircuit("/circuits/reputation.json", reputationCircuitPromise);
  const reputationCircuit = await reputationCircuitPromise;
  input.onProgress?.("Building attested snapshot...");
  const snapshot = buildSnapshot(input.records, {
    category: input.category,
    subjectId: input.subjectId,
    windowDays: input.windowDays,
    attestedRecords: input.attestedRecords,
  });
  const claim = createClaimDescriptor(input.descriptor);
  const metric = computeClaimMetric(snapshot, claim);
  const includedRecords = snapshot.records.slice(0, merkleLeafCount());
  const paddedRecords = Array.from({ length: merkleLeafCount() }, (_, index) => includedRecords[index] ?? null);
  input.onProgress?.("Preparing Merkle witnesses...");
  const siblingPaths = paddedRecords.map((record) => {
    if (!record?.recordCommitment) {
      return Array.from({ length: merkleDepth() }, () => "0");
    }
    const leafIndex = snapshot.sortedCommitments.findIndex((value) => value === record.recordCommitment);
    const proof = leafIndex >= 0 ? buildMerkleProof(snapshot.merkleTree, leafIndex) : [];
    return Array.from({ length: merkleDepth() }, (_, proofIndex) => (proof[proofIndex] ?? 0n).toString());
  });
  const leafIndices = paddedRecords.map((record) => {
    if (!record?.recordCommitment) {
      return "0";
    }
    const leafIndex = snapshot.sortedCommitments.findIndex((value) => value === record.recordCommitment);
    return String(Math.max(0, leafIndex));
  });

  input.onProgress?.("Preparing prover...");
  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(reputationCircuit);
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(reputationCircuit.bytecode, { threads: 1 });
  input.onProgress?.("Computing private witness...");
  const { witness } = await noir.execute({
    claim_type: claimTypeCode(claim).toString(),
    category_code: stringSubjectToField(snapshot.category).toString(),
    window_days: windowDaysToField(snapshot.windowDays).toString(),
    threshold_or_band: metric.publicThreshold.toString(),
    subject: stringSubjectToField(snapshot.subjectId).toString(),
    snapshot_root: snapshot.snapshotRoot.toString(),
    market_ids: paddedRecords.map((record) => record ? marketIdToField(record.marketId).toString() : "0"),
    amounts: paddedRecords.map((record) => (record?.amountInStroops ?? 0n).toString()),
    payouts: paddedRecords.map((record) => (record?.payoutInStroops ?? 0n).toString()),
    won_bits: paddedRecords.map((record) => (record?.won ? 1n : 0n).toString()),
    claimed_at: paddedRecords.map((record) => BigInt(record?.claimedAt ?? 0).toString()),
    record_salts: paddedRecords.map((record) => (record?.witnessSalt ?? 0n).toString()),
    included: paddedRecords.map((record) => (record ? "1" : "0")),
    record_commitments: paddedRecords.map((record) => (record?.recordCommitment ?? 0n).toString()),
    merkle_siblings: siblingPaths,
    leaf_indices: leafIndices,
    metric_value: metric.privateMetric.toString(),
    eligible_count: metric.eligibleCount.toString(),
    peer_scores: metric.peerScores.map((value: bigint) => value.toString()),
    peer_eligible: metric.peerEligible.map((value: bigint) => value.toString()),
  });
  input.onProgress?.("Generating zero-knowledge proof...");
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();
  input.onProgress?.("Packaging portable credential...");

  return serializeReputationProof({
    claim,
    snapshot,
    metric,
    envelope: {
      proofHex: `0x${bytesToHex(proof.proof)}`,
      publicInputsHex: buildReputationPublicInputs(snapshot, claim, metric).map((value) => `0x${value.toString(16)}`),
      attestorKeyId: input.attestorKeyId,
    },
  });
}

export async function verifyReputationProof(serialized: string, attestedRecords: AttestedReputationRecord[] = []) {
  const parsed = verifyPortableReputationClaim(serialized);
  reputationCircuitPromise = loadCircuit("/circuits/reputation.json", reputationCircuitPromise);
  const reputationCircuit = await reputationCircuitPromise;
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(reputationCircuit.bytecode, { threads: 1 });
  const proofValid = await backend.verifyProof(envelopeToProofData(parsed.envelope), proofOptions);
  await backend.destroy?.();
  const snapshotVerified = attestedRecords.length > 0
    && attestedRecords.every((record) => (
      record.attestorKeyId === parsed.publicClaim.attestorKeyId
      && verifyAttestedRecordSignature(record)
    ));
  return { proofValid, snapshotVerified, isValid: proofValid && snapshotVerified, portableClaim: parsed };
}
