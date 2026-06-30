import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSnapshot,
  computeClaimMetric,
  createClaimDescriptor,
  verifyPortableReputationClaim,
} from "../frontend/lib/reputation.js";

const records = [
  {
    marketId: "m1",
    subjectId: "alice",
    category: "macro",
    resolvedAt: 1_720_000_000,
    claimedAt: 1_720_000_100,
    amountInStroops: "10000000",
    payoutInStroops: "15000000",
    won: true,
  },
  {
    marketId: "m2",
    subjectId: "alice",
    category: "macro",
    resolvedAt: 1_720_100_000,
    claimedAt: 1_720_100_100,
    amountInStroops: "10000000",
    payoutInStroops: "9000000",
    won: false,
  },
  {
    marketId: "m3",
    subjectId: "bob",
    category: "macro",
    resolvedAt: 1_720_100_000,
    claimedAt: 1_720_100_200,
    amountInStroops: "10000000",
    payoutInStroops: "12000000",
    won: true,
  },
  {
    marketId: "m4",
    subjectId: "bob",
    category: "macro",
    resolvedAt: 1_720_200_000,
    claimedAt: 1_720_200_200,
    amountInStroops: "10000000",
    payoutInStroops: "13000000",
    won: true,
  },
];

describe("reputation snapshots", () => {
  it("builds a deterministic category/window snapshot from claimed records", () => {
    const first = buildSnapshot(records, { category: "macro", subjectId: "alice", windowDays: 90 });
    const second = buildSnapshot(records, { category: "macro", subjectId: "alice", windowDays: 90 });

    assert.equal(first.snapshotCommitment.toString(), second.snapshotCommitment.toString());
    assert.equal(first.records.length, 2);
    assert.equal(first.peerSubjects.length, 1);
  });

  it("computes threshold metrics without revealing the raw record set", () => {
    const snapshot = buildSnapshot(records, { category: "macro", subjectId: "alice", windowDays: 90 });
    const claim = createClaimDescriptor({ claimType: "threshold", metric: "participation", threshold: "2" });
    const metric = computeClaimMetric(snapshot, claim);

    assert.equal(metric.privateMetric.toString(), "2");
    assert.equal(metric.publicThreshold.toString(), "2");
  });

  it("accepts portable proof envelopes with the expected public schema", () => {
    const parsed = verifyPortableReputationClaim(JSON.stringify({
      claim: { claimType: "percentile", band: 25, metricCode: 0 },
      publicClaim: {
        subjectId: "alice",
        category: "macro",
        windowDays: 90,
        snapshotCommitment: "0x1234",
        statement: "top 25%",
      },
      envelope: {
        proofHex: "0xdeadbeef",
        publicInputsHex: ["0x1", "0x2"],
      },
    }));

    assert.equal(parsed.publicClaim.category, "macro");
    assert.equal(parsed.publicClaim.windowDays, 90);
  });
});
