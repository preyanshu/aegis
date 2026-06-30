import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { Noir } from "@noir-lang/noir_js";
import {
  buildReputationPublicInputs,
  buildSnapshot,
  categoryCodeForField,
  claimTypeCode,
  computeClaimMetric,
  createClaimDescriptor,
  stringSubjectToField,
  verifyPortableReputationClaim,
  windowDaysToField,
} from "../frontend/lib/reputation.js";
import { createUltraHonkBackend, initBarretenberg, poseidon2PermutationFields } from "../scripts/barretenberg.js";

const reputationCircuit = JSON.parse(await readFile("./circuits/reputation/target/reputation.json", "utf8"));
const proofOptions = { keccak: true };

const records = [
  { marketId: "m1", subjectId: "alice", category: "macro", resolvedAt: 1_720_000_000, claimedAt: 1_720_000_100, amountInStroops: "10000000", payoutInStroops: "15000000", won: true },
  { marketId: "m2", subjectId: "alice", category: "macro", resolvedAt: 1_720_010_000, claimedAt: 1_720_010_100, amountInStroops: "10000000", payoutInStroops: "9000000", won: false },
  { marketId: "m3", subjectId: "bob", category: "macro", resolvedAt: 1_720_020_000, claimedAt: 1_720_020_100, amountInStroops: "10000000", payoutInStroops: "11000000", won: true },
  { marketId: "m4", subjectId: "bob", category: "macro", resolvedAt: 1_720_030_000, claimedAt: 1_720_030_100, amountInStroops: "10000000", payoutInStroops: "13000000", won: true },
  { marketId: "m5", subjectId: "carol", category: "macro", resolvedAt: 1_720_040_000, claimedAt: 1_720_040_100, amountInStroops: "10000000", payoutInStroops: "17000000", won: true },
  { marketId: "m6", subjectId: "carol", category: "macro", resolvedAt: 1_720_050_000, claimedAt: 1_720_050_100, amountInStroops: "10000000", payoutInStroops: "19000000", won: true },
];

async function realSnapshot(scope) {
  const snapshot = buildSnapshot(records, scope);
  const [snapshotCommitment] = await poseidon2PermutationFields([
    stringSubjectToField(snapshot.subjectId),
    categoryCodeForField(snapshot.category),
    windowDaysToField(snapshot.windowDays),
    snapshot.witnessSecret,
  ]);
  return { ...snapshot, snapshotCommitment: BigInt(snapshotCommitment) };
}

async function generateReputationProofForClaim(claimDescriptor) {
  await initBarretenberg();
  const snapshot = await realSnapshot({ category: "macro", subjectId: "alice", windowDays: 90 });
  const claim = createClaimDescriptor(claimDescriptor);
  const metric = computeClaimMetric(snapshot, claim);

  const noir = new Noir(reputationCircuit);
  const backend = createUltraHonkBackend(reputationCircuit.bytecode);
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
    peer_scores: metric.peerScores.map((value) => value.toString()),
    peer_eligible: metric.peerEligible.map((value) => value.toString()),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  const verified = await backend.verifyProof({
    proof: proof.proof,
    publicInputs: buildReputationPublicInputs(snapshot, claim, metric),
  }, proofOptions);
  await backend.destroy?.();

  return { snapshot, claim, metric, proof, verified };
}

describe("reputation zk proofs", () => {
  it("generates and verifies a real threshold proof", async () => {
    const result = await generateReputationProofForClaim({
      claimType: "threshold",
      metric: "participation",
      threshold: "2",
    });

    assert.equal(result.verified, true);
    assert.equal(result.metric.privateMetric.toString(), "2");
  });

  it("generates and verifies a real percentile-band proof", async () => {
    const result = await generateReputationProofForClaim({
      claimType: "percentile",
      band: 100,
    });

    assert.equal(result.verified, true);
    assert.equal(result.metric.eligibleCount.toString(), "3");
  });

  it("fails when the claim threshold is above the actual metric", async () => {
    await initBarretenberg();
    const snapshot = await realSnapshot({ category: "macro", subjectId: "alice", windowDays: 90 });
    const claim = createClaimDescriptor({ claimType: "threshold", metric: "participation", threshold: "3" });
    const metric = computeClaimMetric(snapshot, claim);

    const noir = new Noir(reputationCircuit);
    await assert.rejects(
      noir.execute({
        claim_type: claimTypeCode(claim).toString(),
        category_code: categoryCodeForField(snapshot.category).toString(),
        window_days: windowDaysToField(snapshot.windowDays).toString(),
        threshold_or_band: metric.publicThreshold.toString(),
        subject: stringSubjectToField(snapshot.subjectId).toString(),
        snapshot_commitment: snapshot.snapshotCommitment.toString(),
        metric_value: metric.privateMetric.toString(),
        eligible_count: metric.eligibleCount.toString(),
        witness_secret: snapshot.witnessSecret.toString(),
        peer_scores: metric.peerScores.map((value) => value.toString()),
        peer_eligible: metric.peerEligible.map((value) => value.toString()),
      }),
    );
  });

  it("rejects malformed portable reputation payloads", () => {
    assert.throws(() => verifyPortableReputationClaim(JSON.stringify({ nope: true })));
  });
});
