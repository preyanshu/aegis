export interface BlindMarketCondition {
    oracleContract: string;
    assetSymbol: string;
    comparator: ">=" | "<=";
    threshold: bigint;
}

export interface BlindResolvedCondition extends BlindMarketCondition {
    observedPrice: bigint;
    observedTimestamp: number;
    satisfied: boolean;
}

export interface BlindMarketSummary {
    marketId: string;
    question: string;
    category: string;
    creator: string;
    endTimestamp: number;
    minBet: bigint;
    maxBet: bigint;
    feeBps: number;
    commitmentCount: number;
    totalLockedCollateral: bigint;
    resolved: boolean;
    claimsFinalized: boolean;
    tallyFinalized: boolean;
    marketLifecycle: number;
    outcome: "YES" | "NO" | null;
    outcomePrice: bigint;
    distributablePot: bigint;
    winningSideTotal: bigint;
    totalClaimedOut: bigint;
    settledAt: number | null;
    tallyDeadline: number;
    talliedCount: number;
    tallyCommitment: string;
    oracleLogic: string;
    conditionOperators: boolean[];
    conditions: BlindMarketCondition[];
    resolvedConditions: BlindResolvedCondition[];
}

export interface BlindPositionRecord {
    marketId: string;
    marketQuestion: string;
    category: string;
    owner: string;
    side: "YES" | "NO";
    amountInStroops: string;
    salt: string;
    commitment: string;
    nullifier: string;
    commitTxHash?: string;
    tallyTxHash?: string;
    tallyStatus?: "pending" | "tally_submitted" | "share_upload_failed" | "queued_for_auto_finalization" | "finalizing" | "missed_tally_window" | "ready_to_finalize" | "finalized";
    talliedAt?: number;
    shareCommitmentRoot?: string;
    tallySharePackets?: Array<{
        marketId: string;
        commitment: string;
        shardIndex: number;
        yesShare: string;
        noShare: string;
        shareSalt: string;
        shareCommitment: string;
    }>;
    claimTxHash?: string;
    claimedAt?: number;
    reputationAttestationStatus?: "pending" | "attested";
}

export interface BlindDashboardState {
    markets: BlindMarketSummary[];
    timestamp: number;
    nextDeadline: number | null;
    openCount: number;
    resolvedCount: number;
    totalCommitted: bigint;
}

export interface MarketStrategy {
    id: string;
    name: string;
    description: string;
    evaluationLogic: string;
    mathematicalLogic?: string;
    usedDataSources?: Array<{
        id: number;
        currentValue: number;
        targetValue: number;
        operator?: string;
    }>;
    resolutionDeadline: number;
    yesToken: TokenInfo;
    noToken: TokenInfo;
    timestamp: number;
    resolved: boolean;
    winner: 'yes' | 'no' | null;
}

export interface TokenInfo {
    tokenReserve?: number;
    volume?: number;
    history: Array<{ price: number; timestamp: number }>;
    twap: number;
    twapHistory?: Array<{ twap: number; timestamp: number }>;
    priceVUSD?: number; // Actual USDC price per token for swaps
}

// Market state with multiple strategies
export interface MarketState {
    strategies: MarketStrategy[];
    timestamp: number;
    roundNumber: number;
    roundStartTime: number;
    roundEndTime: number;
    roundDuration: number; // in milliseconds
    roundsUntilResolution: number;
    lastRoundEndTime: number | null;
    isExecutingTrades: boolean;
    isMakingBatchLLMCall: boolean;
}

export type StrategyType = 'yes-no' | 'twap' | 'momentum' | 'mean-reversion';

export interface AgentPersonality {
    name: string;
    riskTolerance: 'low' | 'medium' | 'high';
    aggressiveness: number; // 0-1
    memo: string;
    traits: string[];
}

export interface AgentTokenHoldings {
    strategyId: string;
    tokenType: 'yes' | 'no';
    quantity: number;
}

export interface AgentRoundMemory {
    action: 'buy' | 'sell' | 'hold';
    strategyId: string;
    tokenType: 'yes' | 'no';
    quantity: number;
    price: number;
    reasoning: string;
    timestamp: number;
}

export interface Agent {
    id: string;
    personality: AgentPersonality;
    vUSD: number;
    tokenHoldings: AgentTokenHoldings[];
    wallet: {
        address: string;
        derivationPath: string;
    };
    trades: Array<{
        type: 'buy' | 'sell';
        strategyId: string;
        tokenType: 'yes' | 'no';
        price: number;
        quantity: number;
        timestamp: number;
        reasoning?: string;
        txHash?: string;
    }>;
}

export interface LogEntry {
    timestamp: string;
    source: 'System' | 'Market' | 'Trading' | 'Agents' | 'LLM';
    level: 'info' | 'warn' | 'error' | 'debug';
    message: string;
}

export interface TradeDecision {
    agentId: string;
    action: 'buy' | 'sell' | 'hold';
    strategyId: string;
    tokenType: 'yes' | 'no';
    quantity: number;
    price: number;
    reasoning: string;
}

export interface CustomProposal {
    name: string;
    description: string;
    evaluationLogic: string;
    mathematicalLogic: string;
    usedDataSources: Array<{
        id: number;
        currentValue: number;
        targetValue: number;
        operator: string;
    }>;
    resolutionDeadline?: number;
    initialLiquidity?: number;
}

export interface InjectedProposalResponse {
    success: boolean;
    message?: string;
    proposal?: {
        id: string;
        name: string;
        yesToken: string;
        poolId: string;
        txHash: string;
    };
    error?: string;
}
