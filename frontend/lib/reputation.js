const WINDOW_OPTIONS = [30, 90, 180];
const FIELD_MASK = (1n << 248n) - 1n;
const MAX_PEERS = 16;

const METRIC_CODES = {
  roi: 0,
  profit: 1,
  winRate: 2,
  participation: 3,
  exposure: 4,
};

export function stringSubjectToField(value) {
  let acc = 0n;
  for (let index = 0; index < value.length; index += 1) {
    acc = ((acc * 257n) + BigInt(value.charCodeAt(index))) & FIELD_MASK;
  }
  return acc;
}

export function categoryCodeForField(value) {
  return stringSubjectToField(value.toLowerCase());
}

export function windowDaysToField(value) {
  return BigInt(value);
}

export function claimTypeCode(claim) {
  return BigInt(claim.claimType === "percentile" ? 5 : claim.metricCode);
}

function stableSecretForSnapshot(subjectId, category, windowDays, records) {
  const seed = JSON.stringify({
    subjectId,
    category,
    windowDays,
    ids: records.map((record) => `${record.marketId}:${record.claimedAt}`).sort(),
  });
  return stringSubjectToField(seed);
}

function poseidonLikeCommitment(subjectId, category, windowDays, witnessSecret) {
  return (
    stringSubjectToField(subjectId) +
    categoryCodeForField(category) * 17n +
    BigInt(windowDays) * 257n +
    witnessSecret * 4099n
  ) & FIELD_MASK;
}

function normalizeRecord(record) {
  return {
    marketId: String(record.marketId),
    subjectId: String(record.subjectId),
    category: String(record.category).toLowerCase(),
    resolvedAt: Number(record.resolvedAt),
    claimedAt: Number(record.claimedAt),
    amountInStroops: BigInt(record.amountInStroops),
    payoutInStroops: BigInt(record.payoutInStroops),
    won: Boolean(record.won),
  };
}

export function createClaimDescriptor(descriptor) {
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

export function buildSnapshot(records, scope) {
  if (!WINDOW_OPTIONS.includes(scope.windowDays)) {
    throw new Error(`unsupported window: ${scope.windowDays}`);
  }

  const normalized = records.map(normalizeRecord);
  const filtered = normalized.filter((record) => (
    record.category === scope.category.toLowerCase()
    && record.claimedAt > 0
    && record.resolvedAt > 0
  ));

  const latestClaim = filtered.reduce((max, record) => Math.max(max, record.claimedAt), 0);
  const windowStart = latestClaim > 0 ? latestClaim - (scope.windowDays * 24 * 60 * 60) : 0;
  const windowed = filtered.filter((record) => record.claimedAt >= windowStart);

  const perSubject = new Map();
  for (const record of windowed) {
    const current = perSubject.get(record.subjectId) ?? [];
    current.push(record);
    perSubject.set(record.subjectId, current);
  }

  const witnessSecret = stableSecretForSnapshot(scope.subjectId, scope.category, scope.windowDays, windowed);
  return {
    subjectId: scope.subjectId,
    category: scope.category.toLowerCase(),
    windowDays: scope.windowDays,
    snapshotCommitment: poseidonLikeCommitment(scope.subjectId, scope.category.toLowerCase(), scope.windowDays, witnessSecret),
    witnessSecret,
    records: perSubject.get(scope.subjectId) ?? [],
    peerSubjects: [...perSubject.entries()]
      .filter(([subjectId]) => subjectId !== scope.subjectId)
      .map(([subjectId, subjectRecords]) => ({ subjectId, records: subjectRecords })),
  };
}

function metricsForRecords(records) {
  const participation = BigInt(records.length);
  const exposure = records.reduce((sum, record) => sum + record.amountInStroops, 0n);
  const profit = records.reduce((sum, record) => sum + (record.payoutInStroops - record.amountInStroops), 0n);
  const wins = BigInt(records.filter((record) => record.won).length);
  const roi = exposure > 0n ? (profit * 10_000n) / exposure : 0n;
  const winRate = participation > 0n ? (wins * 10_000n) / participation : 0n;

  return { participation, exposure, profit, roi, winRate };
}

function thresholdMetric(snapshot, metric) {
  const metrics = metricsForRecords(snapshot.records);
  if (metric === "roi") return metrics.roi;
  if (metric === "profit") return metrics.profit;
  if (metric === "winRate") return metrics.winRate;
  if (metric === "participation") return metrics.participation;
  return metrics.exposure;
}

function peerRankingData(snapshot) {
  const eligiblePeers = snapshot.peerSubjects
    .map(({ subjectId, records }) => ({ subjectId, metrics: metricsForRecords(records) }))
    .filter(({ metrics }) => metrics.participation >= 2n);
  const peerScores = eligiblePeers.map(({ metrics }) => metrics.roi).sort((left, right) => (left > right ? -1 : left < right ? 1 : 0));
  return { eligiblePeers, peerScores };
}

export function computeClaimMetric(snapshot, claim) {
  if (claim.claimType === "percentile") {
    const subjectMetrics = metricsForRecords(snapshot.records);
    const { eligiblePeers, peerScores } = peerRankingData(snapshot);
    const peers = peerScores.slice(0, MAX_PEERS);
    while (peers.length < MAX_PEERS) {
      peers.push(0n);
    }
    const peerEligible = Array.from({ length: MAX_PEERS }, (_, index) => index < Math.min(eligiblePeers.length, MAX_PEERS) ? 1n : 0n);
    return {
      publicThreshold: BigInt(claim.band),
      privateMetric: subjectMetrics.roi,
      eligibleCount: BigInt(Math.max(1, eligiblePeers.length + 1)),
      peerScores: peers,
      peerEligible,
      displayValue: `top ${claim.band}%`,
    };
  }

  const value = thresholdMetric(snapshot, claim.metric);
  return {
    publicThreshold: claim.threshold,
    privateMetric: value,
    eligibleCount: 1n,
    peerScores: Array.from({ length: MAX_PEERS }, () => 0n),
    peerEligible: Array.from({ length: MAX_PEERS }, () => 0n),
    displayValue: `${claim.metric} >= ${claim.threshold.toString()}`,
  };
}

export function buildReputationPublicInputs(snapshot, claim, metric) {
  return [
    claimTypeCode(claim),
    categoryCodeForField(snapshot.category),
    windowDaysToField(snapshot.windowDays),
    metric.publicThreshold,
    stringSubjectToField(snapshot.subjectId),
    snapshot.snapshotCommitment,
  ];
}

export function serializeReputationProof(payload) {
  return JSON.stringify({
    claim: payload.claim,
    publicClaim: {
      subjectId: payload.snapshot.subjectId,
      category: payload.snapshot.category,
      windowDays: payload.snapshot.windowDays,
      snapshotCommitment: `0x${payload.snapshot.snapshotCommitment.toString(16)}`,
      statement: payload.metric.displayValue,
    },
    envelope: payload.envelope,
  });
}

export function verifyPortableReputationClaim(serialized) {
  const parsed = JSON.parse(serialized);
  if (!parsed?.publicClaim?.subjectId || !parsed?.envelope?.proofHex) {
    throw new Error("invalid reputation proof payload");
  }
  return parsed;
}
