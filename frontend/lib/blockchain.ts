import { createPublicClient, http, formatUnits, parseAbi, parseUnits, parseGwei } from 'viem';
import abiData from './abi.json';
import { validateAndFixStrategies } from './strategy-fallback';
import type { MarketStrategy } from './types';
import { NETWORK_CONFIG, CONTRACT_ADDRESSES, GAS_CONFIG } from './config';

// Re-export router address for backward compatibility
export const ROUTER_ADDRESS = CONTRACT_ADDRESSES.router;

// Chain definition built from config
export const quantumEVM = {
    id: NETWORK_CONFIG.chainId,
    name: NETWORK_CONFIG.chainName,
    network: NETWORK_CONFIG.networkSlug,
    nativeCurrency: {
        decimals: NETWORK_CONFIG.nativeCurrency.decimals,
        name: NETWORK_CONFIG.nativeCurrency.name,
        symbol: NETWORK_CONFIG.nativeCurrency.symbol,
    },
    rpcUrls: {
        public: { http: [NETWORK_CONFIG.rpcUrl] },
        default: { http: [NETWORK_CONFIG.rpcUrl] },
    },
    blockExplorers: {
        default: {
            name: NETWORK_CONFIG.explorerName,
            url: NETWORK_CONFIG.explorerUrl,
        },
    },
} as const;

export const publicClient = createPublicClient({
    chain: quantumEVM,
    transport: http(NETWORK_CONFIG.rpcUrl),
});

export const aegisAbi = abiData;

export interface OnchainRoundInfo {
    roundNumber: bigint;
    roundStartTime: bigint;
    roundEndTime: bigint;
    roundDuration: bigint;
    proposalIds: string[];
    active: boolean;
}

export interface OnchainProposalStatus {
    id: string;
    name: string;
    description: string;
    evaluationLogic: string;
    mathematicalLogic: string;
    resolutionDeadline: bigint;
    poolAddress: `0x${string}`;
    resolved: boolean;
    isWinner: boolean;
    yesTWAP: bigint;
    timestamp: bigint;
}

interface WalletActionClient {
    getAddresses: () => Promise<readonly `0x${string}`[]>;
    writeContract: (params: {
        account: `0x${string}`;
        address: `0x${string}`;
        abi: readonly unknown[];
        functionName: string;
        args?: readonly unknown[];
        chain?: typeof quantumEVM;
        gasPrice?: bigint;
    }) => Promise<`0x${string}`>;
}

const toNumericPrice = (value: bigint | undefined): number => {
    if (!value) return 0;
    const parsed = Number(formatUnits(value, 18));
    if (Number.isNaN(parsed)) return 0;
    return parsed;
};

const asBigInt = (value: bigint | number | string | undefined | null): bigint => {
    if (typeof value === "bigint") return value;
    if (typeof value === "number") return BigInt(value);
    if (typeof value === "string" && value.trim().length > 0) return BigInt(value);
    return BigInt(0);
};

const safeFormatUnits = (value: bigint | number | string | undefined | null): number => {
    try {
        return Number(formatUnits(asBigInt(value), 18));
    } catch {
        return 0;
    }
};

export const getRoundInfo = async (): Promise<OnchainRoundInfo> => {
    return await publicClient.readContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'getRoundInfo',
    }) as OnchainRoundInfo;
};

export const getProposalStatus = async (proposalId: string): Promise<OnchainProposalStatus> => {
    return await publicClient.readContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'getProposalStatus',
        args: [proposalId],
    }) as OnchainProposalStatus;
};

export const getPoolReserves = async (proposalId: string): Promise<{ vUSDCReserve: bigint; yesReserve: bigint }> => {
    return await publicClient.readContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'getPoolReserves',
        args: [proposalId],
    }) as { vUSDCReserve: bigint; yesReserve: bigint };
};

export const getOnchainMarkets = async (): Promise<{ roundInfo: OnchainRoundInfo; strategies: MarketStrategy[] }> => {
    const roundInfo = await getRoundInfo();
    const proposalIds = roundInfo.proposalIds.filter((proposalId): proposalId is string => Boolean(proposalId && proposalId.length > 0));

    const strategies = await Promise.all(
        proposalIds.map(async (proposalId) => {
            try {
                const status = await getProposalStatus(proposalId);

                let reserves: { vUSDCReserve?: bigint; yesReserve?: bigint } = {};
                try {
                    reserves = await getPoolReserves(proposalId);
                } catch (error) {
                    console.warn(`Failed to read pool reserves for ${proposalId}`, error);
                }

                const yesTwap = toNumericPrice(status.yesTWAP);
                const noTwap = Math.max(0, 1 - yesTwap);
                const vUsdcReserve = asBigInt(reserves.vUSDCReserve);
                const yesReserve = asBigInt(reserves.yesReserve);
                const fallbackPrice = safeFormatUnits(vUsdcReserve);
                const yesPriceVUSD = yesTwap || fallbackPrice || 0;
                const noPriceVUSD = noTwap || fallbackPrice || 0;
                const timestamp = Number(status.timestamp ?? 0) * 1000;
                const resolutionDeadline = Number(status.resolutionDeadline ?? 0) * 1000;
                const tokenReserve = Number(formatUnits(yesReserve, 18));
                const volume = Number(formatUnits(vUsdcReserve, 18));

                return {
                    id: String(status.id ?? proposalId),
                    name: String(status.name ?? proposalId.slice(0, 8)),
                    description: String(status.description ?? ""),
                    evaluationLogic: String(status.evaluationLogic ?? ""),
                    mathematicalLogic: String(status.mathematicalLogic ?? ""),
                    usedDataSources: [],
                    resolutionDeadline,
                    yesToken: {
                        history: [{ price: yesTwap, timestamp }],
                        twap: yesTwap,
                        twapHistory: [{ twap: yesTwap, timestamp }],
                        tokenReserve,
                        volume,
                        priceVUSD: yesPriceVUSD || yesTwap,
                    },
                    noToken: {
                        history: [{ price: noTwap, timestamp }],
                        twap: noTwap,
                        twapHistory: [{ twap: noTwap, timestamp }],
                        tokenReserve,
                        volume,
                        priceVUSD: noPriceVUSD || noTwap,
                    },
                    timestamp,
                    resolved: Boolean(status.resolved),
                    winner: Boolean(status.resolved) ? (Boolean(status.isWinner) ? 'yes' : 'no') : null,
                } satisfies MarketStrategy;
            } catch (error) {
                console.warn(`Skipping malformed proposal ${proposalId}`, error);
                return null;
            }
        })
    );

    const validStrategies = strategies.filter((strategy) => strategy !== null) as MarketStrategy[];

    return {
        roundInfo,
        strategies: validateAndFixStrategies(validStrategies),
    };
};

export const getVUSDCBalance = async (address: string): Promise<string> => {
    try {
        const balance = await publicClient.readContract({
            address: ROUTER_ADDRESS as `0x${string}`,
            abi: aegisAbi,
            functionName: 'getVUSDCBalance',
            args: [address as `0x${string}`],
        });

        return formatUnits(balance as bigint, 18);
    } catch (error) {
        console.error('Error fetching vUSDC balance:', error);
        return '0.00';
    }
};

export const claimFaucet = async (walletClient: WalletActionClient): Promise<`0x${string}`> => {
    const [address] = await walletClient.getAddresses();

    // Use direct writeContract with explicit gas price from config
    return await walletClient.writeContract({
        account: address,
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'userFaucet',
        chain: quantumEVM,
        gasPrice: parseGwei(GAS_CONFIG.gasPriceGwei),
    });
};

export const getVUSDCTokenAddress = async (): Promise<`0x${string}`> => {
    return await publicClient.readContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'vUSDCToken',
    }) as `0x${string}`;
};

export const getYesTokenAddress = async (proposalId: string): Promise<`0x${string}`> => {
    return await publicClient.readContract({
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'getYesTokenAddress',
        args: [proposalId],
    }) as `0x${string}`;
};

export const getSwapQuote = async (proposalId: string, tokenIn: string, amountIn: string): Promise<string> => {
    if (!amountIn || isNaN(Number(amountIn)) || Number(amountIn) <= 0) return '0.00';
    try {
        const quote = await publicClient.readContract({
            address: ROUTER_ADDRESS as `0x${string}`,
            abi: aegisAbi,
            functionName: 'getSwapQuote',
            args: [proposalId, tokenIn as `0x${string}`, parseUnits(amountIn, 18)],
        });
        return formatUnits(quote as bigint, 18);
    } catch (error) {
        console.error('Error getting swap quote:', error);
        return '0.00';
    }
};

export const executeSwap = async (
    walletClient: WalletActionClient,
    proposalId: string,
    tokenIn: string,
    amountIn: string | bigint,
    minAmountOut: string
): Promise<`0x${string}`> => {
    const [address] = await walletClient.getAddresses();

    const finalAmountIn = typeof amountIn === 'bigint' ? amountIn : parseUnits(amountIn, 18);

    // Use direct writeContract with explicit gas price from config
    return await walletClient.writeContract({
        account: address,
        address: ROUTER_ADDRESS as `0x${string}`,
        abi: aegisAbi,
        functionName: 'swap',
        args: [proposalId, tokenIn as `0x${string}`, finalAmountIn, parseUnits(minAmountOut, 18)],
        chain: quantumEVM,
        gasPrice: parseGwei(GAS_CONFIG.gasPriceGwei),
    });
};

export const getYESBalance = async (proposalId: string, address: string): Promise<string> => {
    try {
        const balance = await publicClient.readContract({
            address: ROUTER_ADDRESS as `0x${string}`,
            abi: aegisAbi,
            functionName: 'getYESBalance',
            args: [proposalId, address as `0x${string}`],
        });

        return formatUnits(balance as bigint, 18);
    } catch (error) {
        console.error('Error fetching YES balance:', error);
        return '0.00';
    }
};

export const getRawYESBalance = async (proposalId: string, address: string): Promise<bigint> => {
    try {
        const balance = await publicClient.readContract({
            address: ROUTER_ADDRESS as `0x${string}`,
            abi: aegisAbi,
            functionName: 'getYESBalance',
            args: [proposalId, address as `0x${string}`],
        });
        return balance as bigint;
    } catch (error) {
        console.error('Error fetching raw YES balance:', error);
        return BigInt(0);
    }
};

const erc20Abi = parseAbi([
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address account) view returns (uint256)',
]);

export const getAllowance = async (tokenAddress: string, owner: string, spender: string): Promise<bigint> => {
    try {
        return await publicClient.readContract({
            address: tokenAddress as `0x${string}`,
            abi: erc20Abi,
            functionName: 'allowance',
            args: [owner as `0x${string}`, spender as `0x${string}`],
        }) as bigint;
    } catch (error) {
        console.error('Error fetching allowance:', error);
        return BigInt(0);
    }
};

export const approveToken = async (
    walletClient: WalletActionClient,
    tokenAddress: string,
    spender: string,
    amount: bigint = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff")
): Promise<`0x${string}`> => {
    const [address] = await walletClient.getAddresses();

    // Use direct writeContract with explicit gas price from config
    return await walletClient.writeContract({
        account: address,
        address: tokenAddress as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [spender as `0x${string}`, amount],
        chain: quantumEVM,
        gasPrice: parseGwei(GAS_CONFIG.gasPriceGwei),
    });
};
