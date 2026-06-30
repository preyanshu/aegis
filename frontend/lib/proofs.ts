import { amountUsdcToStroops, derivePositionArtifacts, marketIdToField, padHex32 } from "@/lib/proof-artifacts";
import {
  buildSnapshot,
  buildReputationPublicInputs,
  categoryCodeForField,
  claimTypeCode,
  computeClaimMetric,
  createClaimDescriptor,
  serializeReputationProof,
  stringSubjectToField,
  verifyPortableReputationClaim,
  windowDaysToField,
} from "@/lib/reputation";
import { bytesToHex } from "@/lib/stellar";
import { Buffer } from "buffer";
import type { CompiledCircuit } from "@noir-lang/types";

type CircuitArtifact = CompiledCircuit;

const proofOptions = { keccak: true };
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

let commitCircuitPromise: Promise<CircuitArtifact> | null = null;
let tallyUpdateCircuitPromise: Promise<CircuitArtifact> | null = null;
let tallyFinalizeCircuitPromise: Promise<CircuitArtifact> | null = null;
let claimCircuitPromise: Promise<CircuitArtifact> | null = null;
let reputationCircuitPromise: Promise<CircuitArtifact> | null = null;

function randomFieldSalt() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return `0x${bytesToHex(bytes)}`;
}

function randomBigIntBelow(maxExclusive: bigint) {
  if (maxExclusive <= 1n) return 0n;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const value = BigInt(`0x${bytesToHex(bytes)}`);
  return value % maxExclusive;
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
  // @ts-expect-error browser bundle path is intentionally deep-imported
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

function proofDataToEnvelope(proofData: { proof: Uint8Array; publicInputs: bigint[] }) {
  return {
    proofHex: `0x${bytesToHex(proofData.proof)}`,
    publicInputsHex: proofData.publicInputs.map((value) => `0x${value.toString(16)}`),
  };
}

function envelopeToProofData(envelope: { proofHex: string; publicInputsHex: string[] }) {
  return {
    proof: Uint8Array.from(Buffer.from(envelope.proofHex.replace(/^0x/i, ""), "hex")),
    publicInputs: envelope.publicInputsHex.map((value) => BigInt(value)),
  };
}

function snapshotWithCircuitCommitment(snapshot: {
  subjectId: string;
  category: string;
  windowDays: 30 | 90 | 180;
  witnessSecret: bigint;
  snapshotCommitment: bigint;
}, commitment: bigint) {
  return {
    ...snapshot,
    snapshotCommitment: commitment,
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
  // @ts-expect-error browser bundle path is intentionally deep-imported
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
    publicInputsHex: proof.publicInputs.map((value: bigint) => `0x${value.toString(16)}`),
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
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(tallyCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: input.amountInStroops.toString(),
    salt: input.salt,
    yes_shares: yesShares.map((share) => share.toString()),
    no_shares: noShares.map((share) => share.toString()),
    share_salts: shareSalts,
    commitment: artifacts.commitmentHex,
    market_id: artifacts.marketField.toString(),
    collateral_amount: input.amountInStroops.toString(),
    previous_tally_commitment: input.previousTallyCommitment,
    next_tally_commitment: padHex32(BigInt(nextTallyCommitment)),
    share_commitment_root: padHex32(shareCommitmentRoot),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitment: artifacts.commitmentHex,
    nextTallyCommitment: padHex32(BigInt(nextTallyCommitment)),
    shareCommitmentRoot: padHex32(shareCommitmentRoot),
    tallySharePackets: yesShares.map((yesShare, index) => ({
      marketId: input.marketId,
      commitment: artifacts.commitmentHex,
      shardIndex: index + 1,
      yesShare: yesShare.toString(),
      noShare: noShares[index].toString(),
      shareSalt: shareSalts[index],
      shareCommitment: shareCommitments[index],
    })),
    proofHex: `0x${bytesToHex(proof.proof)}`,
    publicInputsHex: proof.publicInputs.map((value: bigint) => `0x${value.toString(16)}`),
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
  // @ts-expect-error browser bundle path is intentionally deep-imported
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
    publicInputsHex: proof.publicInputs.map((value: bigint) => `0x${value.toString(16)}`),
  };
}

export async function generateClaimProof(input: {
  marketId: string;
  side: "YES" | "NO";
  amountInStroops: bigint;
  salt: string;
  commitment: string;
  nullifier: string;
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
  if (input.nullifier.toLowerCase() !== artifacts.nullifierHex.toLowerCase()) {
    throw new Error("claim proof inputs do not reproduce the saved nullifier");
  }

  const payout = (input.amountInStroops * input.distributablePot) / input.winningSideTotal;
  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(claimCircuit);
  // @ts-expect-error browser bundle path is intentionally deep-imported
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
    publicInputsHex: proof.publicInputs.map((value: bigint) => `0x${value.toString(16)}`),
  };
}

export async function generateReputationProof(input: {
  subjectId: string;
  category: string;
  windowDays: 30 | 90 | 180;
  descriptor: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
}) {
  reputationCircuitPromise = loadCircuit("/circuits/reputation.json", reputationCircuitPromise);
  const reputationCircuit = await reputationCircuitPromise;
  const baseSnapshot = buildSnapshot(input.records, {
    category: input.category,
    subjectId: input.subjectId,
    windowDays: input.windowDays,
  });
  const claim = createClaimDescriptor(input.descriptor);
  const { poseidon2Permutation } = await ensurePoseidon();
  const [snapshotCommitment] = await poseidon2Permutation([
    stringSubjectToField(baseSnapshot.subjectId),
    categoryCodeForField(baseSnapshot.category),
    windowDaysToField(baseSnapshot.windowDays),
    baseSnapshot.witnessSecret,
  ]);
  const snapshot = snapshotWithCircuitCommitment(baseSnapshot, snapshotCommitment);
  const metric = computeClaimMetric(snapshot, claim);

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(reputationCircuit);
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(reputationCircuit.bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    claim_type: claimTypeCode(claim).toString(),
    category_code: categoryCodeForField(snapshot.category).toString(),
    window_days: windowDaysToField(snapshot.windowDays).toString(),
    threshold_or_band: metric.publicThreshold.toString(),
    subject: stringSubjectToField(snapshot.subjectId).toString(),
    snapshot_commitment: snapshot.snapshotCommitment.toString(),
    metric_value: metric.privateMetric.toString(),
    eligible_count: metric.eligibleCount.toString(),
    witness_secret: snapshot.witnessSecret.toString(),
    peer_scores: metric.peerScores.map((value: bigint) => value.toString()),
    peer_eligible: metric.peerEligible.map((value: bigint) => value.toString()),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return serializeReputationProof({
    claim,
    snapshot,
    metric,
    envelope: {
      proofHex: `0x${bytesToHex(proof.proof)}`,
      publicInputsHex: buildReputationPublicInputs(snapshot, claim, metric).map((value) => `0x${value.toString(16)}`),
    },
  });
}

export async function verifyReputationProof(serialized: string) {
  const parsed = verifyPortableReputationClaim(serialized);
  reputationCircuitPromise = loadCircuit("/circuits/reputation.json", reputationCircuitPromise);
  const reputationCircuit = await reputationCircuitPromise;
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend(reputationCircuit.bytecode, { threads: 1 });
  const isValid = await backend.verifyProof(envelopeToProofData(parsed.envelope), proofOptions);
  await backend.destroy?.();
  return { isValid, portableClaim: parsed };
}

export { marketIdToField };
