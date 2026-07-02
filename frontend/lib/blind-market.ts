import type { BlindDashboardState, BlindMarketCondition, BlindMarketSummary, BlindPositionRecord, BlindResolvedCondition } from "@/lib/types";
import type { MarketView, OracleCondition, ResolvedCondition } from "@/lib/stellar";

export const POSITION_STORAGE_KEY = "blind-market-private-positions-v2";
const STROOPS_PER_USDC = 10_000_000;

function shortComparator(condition: { greater_or_equal?: boolean } | OracleCondition | ResolvedCondition) {
  return condition.greater_or_equal ? ">=" : "<=";
}

function formatThreshold(threshold: bigint) {
  const absolute = threshold < BigInt(0) ? -threshold : threshold;
  if (absolute >= 1_000_000n) {
    return threshold.toLocaleString();
  }
  return threshold.toString();
}

function conditionLabel(condition: OracleCondition | ResolvedCondition) {
  return `${condition.asset_symbol} ${shortComparator(condition)} ${formatThreshold(condition.threshold)}`;
}

export function formatOracleLogic(view: MarketView) {
  if (view.config.oracle_conditions.length === 0) {
    return "No oracle conditions";
  }

  return view.config.oracle_conditions
    .map((condition, index) => {
      const connector = index < view.config.condition_operators.length
        ? view.config.condition_operators[index] ? " AND " : " OR "
        : "";
      return `${conditionLabel(condition)}${connector}`;
    })
    .join("");
}

function mapCondition(condition: OracleCondition): BlindMarketCondition {
  return {
    oracleContract: condition.oracle_contract,
    assetSymbol: condition.asset_symbol,
    comparator: shortComparator(condition),
    threshold: condition.threshold,
  };
}

function mapResolvedCondition(condition: ResolvedCondition): BlindResolvedCondition {
  return {
    ...mapCondition(condition),
    observedPrice: condition.observed_price,
    observedTimestamp: Number(condition.observed_timestamp) > 0 ? Number(condition.observed_timestamp) * 1000 : 0,
    satisfied: condition.satisfied,
  };
}

export function mapMarketSummary(row: { marketId: string; view: MarketView; creationIndex?: number }): BlindMarketSummary {
  return {
    marketId: row.marketId,
    creationIndex: row.creationIndex ?? 0,
    question: row.view.config.question,
    category: row.view.config.category,
    creator: row.view.config.creator,
    endTimestamp: Number(row.view.config.end_timestamp) * 1000,
    minBet: row.view.config.min_bet,
    maxBet: row.view.config.max_bet,
    feeBps: row.view.config.fee_bps,
    commitmentCount: row.view.state.commitment_count,
    totalLockedCollateral: row.view.state.total_locked_collateral,
    resolved: row.view.state.resolved,
    claimsFinalized: row.view.state.claims_finalized,
    tallyFinalized: row.view.state.tally_finalized,
    marketLifecycle: row.view.state.market_lifecycle,
    outcome: row.view.state.resolved ? (row.view.state.outcome ? "YES" : "NO") : null,
    outcomePrice: row.view.state.outcome_price,
    distributablePot: row.view.state.distributable_pot,
    winningSideTotal: row.view.state.winning_side_total,
    totalClaimedOut: row.view.state.total_claimed_out,
    settledAt: Number(row.view.state.settled_at) > 0 ? Number(row.view.state.settled_at) * 1000 : null,
    tallyDeadline: Number(row.view.state.tally_deadline) > 0 ? Number(row.view.state.tally_deadline) * 1000 : Number(row.view.config.end_timestamp) * 1000 + 2 * 60 * 1000,
    talliedCount: row.view.state.tallied_count,
    tallyCommitment: row.view.state.tally_commitment,
    oracleLogic: formatOracleLogic(row.view),
    conditionOperators: row.view.config.condition_operators,
    conditions: row.view.config.oracle_conditions.map(mapCondition),
    resolvedConditions: row.view.state.resolved_conditions.map(mapResolvedCondition),
  };
}

export function buildDashboardState(markets: BlindMarketSummary[]): BlindDashboardState {
  const now = Date.now();
  const nextDeadline = markets
    .filter((market) => !market.resolved && market.endTimestamp > now)
    .map((market) => market.endTimestamp)
    .sort((left, right) => left - right)[0] ?? null;

  return {
    markets,
    timestamp: now,
    nextDeadline,
    openCount: markets.filter((market) => !market.resolved).length,
    resolvedCount: markets.filter((market) => market.resolved).length,
    totalCommitted: markets.reduce((sum, market) => sum + market.totalLockedCollateral, BigInt(0)),
  };
}

export function stroopsToUsdc(value: bigint) {
  return Number(value) / STROOPS_PER_USDC;
}

export function formatUsdc(value: bigint) {
  const amount = stroopsToUsdc(value);
  if (value > 0n && amount < 0.01) {
    return "<$0.01";
  }
  return `$${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatCompactAddress(value: string) {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function marketStatusLabel(market: BlindMarketSummary) {
  if (market.resolved) {
    return market.claimsFinalized ? "Resolved" : "Resolved";
  }
  const now = Date.now();
  if (now < market.endTimestamp) {
    return "Open";
  }
  if (now < market.tallyDeadline) {
    return market.talliedCount > 0 ? "Needs Tally" : "Awaiting Private Tally";
  }
  if (market.tallyFinalized) {
    return "Resolved";
  }
  return market.talliedCount > 0 ? "Queued for Auto-Finalization" : "Missed Tally Window";
}

export function positionStatusLabel(position: BlindPositionRecord, market: BlindMarketSummary | null) {
  if (position.claimedAt) {
    return "Claimed";
  }
  const positionTallied = position.tallyStatus === "tally_submitted"
    || position.tallyStatus === "queued_for_auto_finalization"
    || position.tallyStatus === "finalizing"
    || Boolean(position.talliedAt);
  if (market?.resolved) {
    if (!positionTallied) {
      return "Missed tally window";
    }
    if (market.outcome === null) {
      return "Settled";
    }
    if (position.side !== market.outcome) {
      return "Lost";
    }
    if (market.winningSideTotal <= 0n || market.distributablePot <= 0n) {
      return "No payout";
    }
    return "Claim available";
  }
  if (position.tallyStatus === "tally_submitted") {
    return "Queued for auto-finalization";
  }
  if (position.tallyStatus === "queued_for_auto_finalization") {
    return "Queued for auto-finalization";
  }
  if (position.tallyStatus === "finalizing") {
    return "Finalizing";
  }
  if (position.tallyStatus === "share_upload_failed") {
    return "Share upload failed";
  }
  if (market && Date.now() >= market.tallyDeadline) {
    return "Missed tally window";
  }
  if (market && Date.now() >= market.endTimestamp) {
    return "Needs tally";
  }
  return "Committed";
}

export function loadSavedPositions() {
  if (typeof window === "undefined") {
    return [] as BlindPositionRecord[];
  }

  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) {
      return [];
    }
    return JSON.parse(raw) as BlindPositionRecord[];
  } catch {
    return [];
  }
}

export function savePositions(positions: BlindPositionRecord[]) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(positions, null, 2));
}

export function payoutForPosition(summary: BlindMarketSummary, amountInStroops: bigint) {
  if (!summary.resolved || summary.winningSideTotal <= BigInt(0)) {
    return BigInt(0);
  }
  return (amountInStroops * summary.distributablePot) / summary.winningSideTotal;
}

export function expectedPayoutForPosition(position: BlindPositionRecord, market: BlindMarketSummary | null) {
  if (!market?.resolved || market.outcome === null) {
    return null;
  }

  const positionTallied = position.tallyStatus === "tally_submitted"
    || position.tallyStatus === "queued_for_auto_finalization"
    || position.tallyStatus === "finalizing"
    || Boolean(position.talliedAt);

  if (!positionTallied) {
    return null;
  }
  if (position.side !== market.outcome) {
    return null;
  }
  if (market.winningSideTotal <= 0n || market.distributablePot <= 0n) {
    return null;
  }

  return payoutForPosition(market, BigInt(position.amountInStroops));
}
