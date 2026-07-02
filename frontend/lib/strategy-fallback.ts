import { MarketStrategy } from "./types";
import { TRUSTED_DATA_SOURCES } from "./data-sources";

/**
 * Fallback Data Sources - Valid IDs to use when backend provides invalid/missing sources
 */
export const FALLBACK_DATA_SOURCES = [
    { id: 12245, name: "SPY", ticker: "SPY" }, // S&P 500 ETF Trust SPDR
    { id: 12249, name: "QQQ", ticker: "QQQ" }, // QQQ Trust Invesco
    { id: 12251, name: "IBIT", ticker: "IBIT" }, // Bitcoin Trust iShares
    { id: 12243, name: "VOO", ticker: "VOO" }, // S&P 500 ETF Vanguard
    { id: 12247, name: "VTI", ticker: "VTI" }, // Total Stock Market ETF Vanguard
    { id: 12288, name: "WTI", ticker: "WTI" }, // Crude Oil
    { id: 12292, name: "NG", ticker: "NG" }, // Natural Gas
    { id: 12276, name: "TLT", ticker: "TLT" }, // 20+ Year Treasury Bond
] as const;

/**
 * Simple hash function to generate a deterministic number from a string
 * Used to ensure consistent fallback selection based on strategy ID
 */
const hashString = (str: string): number => {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return Math.abs(hash);
};

/**
 * Get a deterministic fallback data source based on strategy ID
 * This ensures the same strategy always gets the same fallback
 */
export const getDeterministicFallbackDataSource = (strategyId: string, index: number = 0) => {
    const hash = hashString(strategyId + index.toString());
    const fallbackIndex = hash % FALLBACK_DATA_SOURCES.length;
    const fallback = FALLBACK_DATA_SOURCES[fallbackIndex];
    const fullSource = TRUSTED_DATA_SOURCES.find(s => s.id === fallback.id);
    
    if (!fullSource) {
        throw new Error(`Fallback data source ${fallback.id} not found in TRUSTED_DATA_SOURCES`);
    }
    
    const currentPrice = parseFloat(fullSource.price) || 100;
    // Use deterministic target: 5% above current price
    const targetValue = currentPrice * 1.05;
    
    return {
        id: fullSource.id,
        currentValue: currentPrice,
        targetValue: targetValue,
        operator: '>' as const, // Always use '>' for consistency
    };
};

/**
 * Get a random fallback data source (legacy - use getDeterministicFallbackDataSource instead)
 * @deprecated Use getDeterministicFallbackDataSource for consistent results
 */
export const getRandomFallbackDataSource = () => {
    // Default to SPY for consistency when no strategy ID is available
    const fallback = FALLBACK_DATA_SOURCES[0]; // SPY
    const fullSource = TRUSTED_DATA_SOURCES.find(s => s.id === fallback.id);
    
    if (!fullSource) {
        throw new Error(`Fallback data source ${fallback.id} not found in TRUSTED_DATA_SOURCES`);
    }
    
    const currentPrice = parseFloat(fullSource.price) || 100;
    
    return {
        id: fullSource.id,
        currentValue: currentPrice,
        targetValue: currentPrice * 1.05,
        operator: '>' as const,
    };
};

/**
 * Validate if a data source ID exists in TRUSTED_DATA_SOURCES
 */
export const isValidDataSourceId = (id: number): boolean => {
    return TRUSTED_DATA_SOURCES.some(source => source.id === id);
};

/**
 * Get valid data source info by ID, or return deterministic fallback
 */
export const getValidDataSource = (id: number, strategyId: string = 'default', index: number = 0) => {
    const source = TRUSTED_DATA_SOURCES.find(s => s.id === id);
    if (source) {
        return {
            id: source.id,
            currentValue: parseFloat(source.price) || 0,
            targetValue: parseFloat(source.price) * 1.1,
            operator: '>' as const,
        };
    }
    // Return deterministic fallback if invalid
    return getDeterministicFallbackDataSource(strategyId, index);
};

/**
 * Generate mathematical logic using real asset tickers from data sources
 */
export const generateMathLogicWithRealTickers = (dataSources: Array<{ id: number; targetValue: number; operator: string }>): string => {
    return dataSources.map(ds => {
        const source = TRUSTED_DATA_SOURCES.find(s => s.id === ds.id);
        const ticker = source?.ticker || 'ASSET';
        return `${ticker} ${ds.operator} ${typeof ds.targetValue === 'number' ? ds.targetValue.toFixed(2) : ds.targetValue}`;
    }).join(' AND ');
};

/**
 * Validate and fix strategy data sources
 * Replaces invalid IDs with valid fallback sources (deterministically based on strategy ID)
 * Uses real asset tickers in mathematical logic
 */
export const validateAndFixStrategy = (strategy: MarketStrategy): MarketStrategy => {
    if (!strategy.usedDataSources || strategy.usedDataSources.length === 0) {
        // If no data sources, add a deterministic fallback based on strategy ID
        const fallbackSource = getDeterministicFallbackDataSource(strategy.id);
        const source = TRUSTED_DATA_SOURCES.find(s => s.id === fallbackSource.id);
        const ticker = source?.ticker || 'ASSET';
        return {
            ...strategy,
            usedDataSources: [fallbackSource],
            mathematicalLogic: strategy.mathematicalLogic || `${ticker} ${fallbackSource.operator} ${fallbackSource.targetValue.toFixed(2)}`,
        };
    }

    // Validate and fix each data source (use index for deterministic fallback selection)
    const fixedDataSources = strategy.usedDataSources.map((ds, index) => {
        if (isValidDataSourceId(ds.id)) {
            // Valid ID, but ensure we have proper values
            const source = TRUSTED_DATA_SOURCES.find(s => s.id === ds.id);
            return {
                id: ds.id,
                currentValue: ds.currentValue || (source ? parseFloat(source.price) : 0),
                targetValue: ds.targetValue || (source ? parseFloat(source.price) * 1.1 : 0),
                operator: ds.operator || '>',
            };
        } else {
            // Invalid ID, replace with deterministic fallback based on strategy ID and index
            console.warn(`Invalid data source ID ${ds.id} in strategy ${strategy.id}, using fallback`);
            return getDeterministicFallbackDataSource(strategy.id, index);
        }
    });

    // Generate mathematical logic with real asset tickers
    const fixedMathematicalLogic = generateMathLogicWithRealTickers(fixedDataSources);

    return {
        ...strategy,
        usedDataSources: fixedDataSources,
        mathematicalLogic: fixedMathematicalLogic,
    };
};

/**
 * Validate and fix multiple strategies
 */
export const validateAndFixStrategies = (strategies: MarketStrategy[]): MarketStrategy[] => {
    return strategies.map(validateAndFixStrategy);
};

