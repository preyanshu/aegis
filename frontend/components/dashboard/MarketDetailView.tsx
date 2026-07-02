"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import type { BlindMarketSummary, BlindPositionRecord } from "@/lib/types";
import {
    ArrowLeft,
    ArrowUpDown,
    Check,
    Clock3,
    Database,
    ExternalLink,
    Info,
    Loader2,
    LockKeyhole,
    Scale,
    Shield,
    ShieldCheck,
    Trophy,
    TrendingUp,
    Wallet,
    X,
    Zap,
} from "lucide-react";
import { motion } from "framer-motion";
import { AreaSeries, createChart, LineSeries, type LineData, type UTCTimestamp } from "lightweight-charts";
import {
    claimWinningsWithPrivyWallet,
    commitPositionWithPrivyWallet,
    estimateCommitPositionFee,
    fundStellarTestnetAddress,
    getBrowserConfig,
    getPrivyStellarWallet,
    loadMarketView,
    loadReflectorPrice,
    loadReflectorPriceHistory,
    loadStellarNativeBalanceSummary,
    loadUsdcBalance,
    submitPrivateTallyWithPrivyWallet,
    submitTallySharesToBackend,
} from "@/lib/stellar";
import { computeRecordCommitment, generateClaimProof, generateCommitProof, generateTallyUpdateProof, randomWitnessSalt } from "@/lib/proofs";
import { formatCompactAddress, formatUsdc, mapMarketSummary, marketStatusLabel, payoutForPosition, positionStatusLabel, stroopsToUsdc } from "@/lib/blind-market";
import { TRUSTED_DATA_SOURCES } from "@/lib/data-sources";
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from "@/lib/privy-stellar-wallet";
import { attestClaimRecord, loadReputationSnapshot, markClaimedPosition, upsertAttestedRecord, upsertCommittedPosition, upsertPrivateReputationWitness } from "@/lib/reputation-vault";
import { marketCategoryArt } from "@/lib/market-category-art";

interface MarketDetailViewProps {
    market: BlindMarketSummary;
    onBack: () => void;
    onMarketRefresh?: () => Promise<void> | void;
}

function formatTimestamp(timestamp: number | null) {
    if (!timestamp) {
        return "Pending";
    }
    return new Date(timestamp).toLocaleString();
}

function formatCompactTimestamp(timestamp: number | null) {
    if (!timestamp) {
        return "Pending";
    }

    return new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
    }).format(new Date(timestamp));
}

function formatPercentage(value: number) {
    const normalized = value / 100;
    if (normalized === 0 || normalized === 1) {
        return normalized.toString();
    }
    return normalized.toFixed(2);
}

function formatCountdown(targetTimestamp: number, currentTimestamp: number) {
    const remainingMs = Math.max(0, targetTimestamp - currentTimestamp);
    const totalSeconds = Math.floor(remainingMs / 1000);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
}

type ReflectorSeries = {
    assetSymbol: string;
    oracleContract: string;
    decimals: number;
    latestLabel: string;
    latestTimestamp: number | null;
    lineColor: string;
    points: Array<LineData>;
};

const CHART_LINE_COLORS = ["#8b5cf6", "#22d3ee", "#f97316", "#10b981", "#f43f5e"];
const XLM_DECIMALS = 7;

type PreparedCommit = Awaited<ReturnType<typeof generateCommitProof>>;
type PreparedCommitReview = {
    proof: PreparedCommit;
    side: "YES" | "NO";
    amountUsdc: string;
};

function humanizeCommitFlowError(error: unknown, preparedCommit: PreparedCommitReview | null) {
    const raw = error instanceof Error ? error.message : String(error);
    if (
        raw.includes("resulting balance is not within the allowed range")
        || (raw.includes("contract call failed") && raw.includes("transfer"))
    ) {
        const amount = preparedCommit?.amountUsdc ?? "the selected";
        return `Insufficient USDC balance for this order. Your wallet needs about ${amount} USDC available before the contract can lock the collateral.`;
    }

    return raw;
}

async function evaluateOracleOutcome(market: BlindMarketSummary) {
    if (market.conditions.length === 0) {
        return false;
    }

    const results = [];
    for (const condition of market.conditions) {
        const price = await loadReflectorPrice(condition.oracleContract, condition.assetSymbol);
        if (!price) {
            throw new Error(`oracle price unavailable for ${condition.assetSymbol}`);
        }

        results.push(condition.comparator === ">=" ? price.price >= condition.threshold : price.price <= condition.threshold);
    }

    let value = results[0];
    for (let index = 1; index < results.length; index += 1) {
        const isAnd = market.conditionOperators[index - 1] ?? true;
        value = isAnd ? value && results[index] : value || results[index];
    }

    return value;
}

function formatOracleThreshold(rawThreshold: bigint, decimals: number) {
    if (decimals <= 0) {
        return rawThreshold.toString();
    }

    const base = 10n ** BigInt(decimals);
    const whole = rawThreshold / base;
    const fraction = (rawThreshold % base).toString().padStart(decimals, "0").slice(0, 3).replace(/0+$/, "");
    return fraction ? `${whole.toString()}.${fraction}` : whole.toString();
}

function thresholdLabel(symbol: string, rawThreshold: bigint, decimals: number) {
    void symbol;
    return formatOracleThreshold(rawThreshold, decimals);
}

function readableConditionLabel(
    condition: BlindMarketSummary["conditions"][number],
    decimals: number,
) {
    return `${condition.assetSymbol} ${condition.comparator} ${thresholdLabel(condition.assetSymbol, condition.threshold, decimals)}`;
}

function formatUsdcInput(value: bigint) {
    return stroopsToUsdc(value).toLocaleString(undefined, {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
        useGrouping: false,
    });
}

function decimalToStroops(value: string, decimals = XLM_DECIMALS) {
    const normalized = value.trim();
    if (!normalized) {
        return BigInt(0);
    }

    const negative = normalized.startsWith("-");
    const unsigned = negative ? normalized.slice(1) : normalized;
    const [wholePart, fractionPart = ""] = unsigned.split(".");
    const safeWhole = wholePart === "" ? "0" : wholePart.replace(/\D/g, "") || "0";
    const paddedFraction = `${fractionPart.replace(/\D/g, "")}${"0".repeat(decimals)}`.slice(0, decimals);
    const scaled = BigInt(`${safeWhole}${paddedFraction}`);
    return negative ? -scaled : scaled;
}

function stroopsStringToDecimal(value: string, decimals = XLM_DECIMALS) {
    const amount = BigInt(value);
    const negative = amount < 0n;
    const absolute = negative ? -amount : amount;
    const base = 10n ** BigInt(decimals);
    const whole = absolute / base;
    const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function formatDecimalAmount(value: string, maximumFractionDigits = 4) {
    const numeric = Number.parseFloat(value);
    if (Number.isNaN(numeric)) {
        return value;
    }

    return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits,
    }).format(numeric);
}

function currentNetworkLabel() {
    if (typeof window === "undefined") {
        return "Stellar Testnet";
    }
    return getBrowserConfig().networkPassphrase.includes("Test") ? "Stellar Testnet" : "Stellar Mainnet";
}

function explorerTransactionUrl(hash: string) {
    const networkSegment = getBrowserConfig().networkPassphrase.includes("Test") ? "testnet" : "public";
    return `https://stellar.expert/explorer/${networkSegment}/tx/${hash}`;
}

function shortenAddress(address: string, leading = 8, trailing = 6) {
    if (address.length <= leading + trailing + 3) {
        return address;
    }
    return `${address.slice(0, leading)}...${address.slice(-trailing)}`;
}

function InlineHint({ text }: { text: string }) {
    return (
        <span className="group relative inline-flex items-center">
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/35 transition-colors group-hover:border-white/20 group-hover:text-white/70">
                <Info className="h-2.5 w-2.5" />
            </span>
            <span className="pointer-events-none absolute right-0 top-full z-20 mt-2 w-56 rounded-xl border border-white/10 bg-[#0d0d10] px-3 py-2 text-[11px] font-medium normal-case tracking-normal text-white/70 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100">
                {text}
            </span>
        </span>
    );
}

function ReflectorChart({
    series,
    activeAsset,
    thresholdValue,
}: {
    series: ReflectorSeries[];
    activeAsset: string;
    thresholdValue: number | null;
}) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const activeSeries = series.find((item) => item.assetSymbol === activeAsset) ?? series[0];

    useEffect(() => {
        if (!containerRef.current || !activeSeries) {
            return;
        }

        const chart = createChart(containerRef.current, {
            layout: {
                background: { color: "transparent" },
                textColor: "#ffffff60",
                attributionLogo: false,
            },
            grid: {
                vertLines: { color: "#ffffff05" },
                horzLines: { color: "#ffffff05" },
            },
            width: containerRef.current.clientWidth,
            height: 400,
            rightPriceScale: {
                borderVisible: false,
            },
            timeScale: {
                borderVisible: false,
                timeVisible: true,
                secondsVisible: false,
            },
        });

        const areaSeries = chart.addSeries(AreaSeries, {
            lineColor: activeSeries.lineColor,
            topColor: `${activeSeries.lineColor}30`,
            bottomColor: `${activeSeries.lineColor}08`,
            lineWidth: 2,
            crosshairMarkerRadius: 4,
            priceFormat: {
                type: "price",
                precision: 3,
                minMove: 0.001,
            },
        });
        areaSeries.setData(activeSeries.points);

        if (thresholdValue !== null) {
            const thresholdSeries = chart.addSeries(LineSeries, {
                color: "#ffffff30",
                lineWidth: 1,
                lineStyle: 2,
                lastValueVisible: false,
                priceLineVisible: false,
                crosshairMarkerVisible: false,
                priceFormat: {
                    type: "price",
                    precision: 3,
                    minMove: 0.001,
                },
            });
            thresholdSeries.setData(
                activeSeries.points.map((point) => ({
                    time: point.time,
                    value: thresholdValue,
                })),
            );
        }

        chart.timeScale().fitContent();

        const handleResize = () => {
            if (containerRef.current) {
                chart.applyOptions({ width: containerRef.current.clientWidth });
            }
        };
        window.addEventListener("resize", handleResize);

        return () => {
            window.removeEventListener("resize", handleResize);
            chart.remove();
        };
    }, [activeSeries, thresholdValue]);

    return (
        <div ref={containerRef} className="h-[300px] w-full sm:h-[400px]" />
    );
}

export function MarketDetailView({ market, onBack, onMarketRefresh }: MarketDetailViewProps) {
    const { user, authenticated, login } = usePrivy();
    const { createWallet } = useCreateWallet();
    const { signRawHash } = useSignRawHash();
    const rawStellarWallet = getPrivyStellarWallet(user);
    const stellarWallet = useMemo(() => {
        if (!rawStellarWallet?.address) {
            return null;
        }

        return {
            address: rawStellarWallet.address,
            publicKey: rawStellarWallet.publicKey ?? rawStellarWallet.public_key ?? rawStellarWallet.address,
            public_key: rawStellarWallet.public_key ?? rawStellarWallet.publicKey ?? rawStellarWallet.address,
            chainType: "stellar" as const,
            chain_type: "stellar" as const,
            type: "wallet" as const,
        };
    }, [
        rawStellarWallet?.address,
        rawStellarWallet?.publicKey,
        rawStellarWallet?.public_key,
    ]);
    const [savedPositions, setSavedPositions] = useState<BlindPositionRecord[]>([]);
    const [commitSide, setCommitSide] = useState<"YES" | "NO">("YES");
    const [commitAmountUsdc, setCommitAmountUsdc] = useState("10");
    const [busy, setBusy] = useState<string | null>(null);
    const [status, setStatus] = useState("This market stores only commitments onchain while it is open.");
    const [commitError, setCommitError] = useState("");
    const [usdcBalance, setUsdcBalance] = useState<bigint>(BigInt(0));
    const [xlmBalance, setXlmBalance] = useState("0");
    const [xlmSpendableBalance, setXlmSpendableBalance] = useState("0");
    const [xlmMinimumBalance, setXlmMinimumBalance] = useState("0");
    const [assetSeries, setAssetSeries] = useState<ReflectorSeries[]>([]);
    const [activeAsset, setActiveAsset] = useState<string>("");
    const [chartBusy, setChartBusy] = useState(false);
    const [isCommitReviewOpen, setIsCommitReviewOpen] = useState(false);
    const [preparedCommit, setPreparedCommit] = useState<PreparedCommitReview | null>(null);
    const [commitReviewError, setCommitReviewError] = useState("");
    const [estimatedCommitFeeXlm, setEstimatedCommitFeeXlm] = useState("");
    const [isEstimatingCommitFee, setIsEstimatingCommitFee] = useState(false);
    const [isFundingWallet, setIsFundingWallet] = useState(false);
    const [commitTxHash, setCommitTxHash] = useState<string | null>(null);
    const [now, setNow] = useState(Date.now());

    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);

    const walletPublic = stellarWallet?.address ?? "";
    const isTestnet = useMemo(() => currentNetworkLabel() === "Stellar Testnet", []);
    const walletPositions = useMemo(
        () => savedPositions.filter((position) => position.owner === walletPublic && position.marketId === market.marketId),
        [market.marketId, savedPositions, walletPublic],
    );
    const isSubmittedOrQueued = (position: BlindPositionRecord) => (
        position.tallyStatus === "tally_submitted"
        || position.tallyStatus === "queued_for_auto_finalization"
        || position.tallyStatus === "finalizing"
        || Boolean(position.talliedAt)
    );
    const claimablePositions = walletPositions.filter((position) => (
        market.resolved
        && !position.claimedAt
        && market.outcome !== null
        && isSubmittedOrQueued(position)
        && position.side === market.outcome
    ));
    const walletCommittedCollateral = useMemo(
        () => walletPositions.reduce((sum, position) => sum + BigInt(position.amountInStroops), BigInt(0)),
        [walletPositions],
    );
    const walletYesCommittedCollateral = useMemo(
        () => walletPositions
            .filter((position) => position.side === "YES")
            .reduce((sum, position) => sum + BigInt(position.amountInStroops), BigInt(0)),
        [walletPositions],
    );
    const walletNoCommittedCollateral = useMemo(
        () => walletPositions
            .filter((position) => position.side === "NO")
            .reduce((sum, position) => sum + BigInt(position.amountInStroops), BigInt(0)),
        [walletPositions],
    );
    const walletTalliedPositions = useMemo(
        () => walletPositions.filter((position) => isSubmittedOrQueued(position)),
        [walletPositions],
    );
    const walletAllTallied = walletPositions.length > 0 && walletTalliedPositions.length === walletPositions.length;
    const tallyCountdown = walletAllTallied && !market.resolved && now < market.tallyDeadline
        ? formatCountdown(market.tallyDeadline, now)
        : "";
    const marketNeedsTally = !market.resolved && now >= market.endTimestamp && now < market.tallyDeadline;
    const marketReadyToFinalize = !market.resolved && now >= market.tallyDeadline;
    const pendingTallyPositions = useMemo(
        () => walletPositions.filter((position) => (
            position.tallyStatus !== "queued_for_auto_finalization"
            && position.tallyStatus !== "finalizing"
            && position.tallyStatus !== "tally_submitted"
            && position.tallyStatus !== "share_upload_failed"
            && marketNeedsTally
        )),
        [marketNeedsTally, walletPositions],
    );
    const retryableTallyPositions = useMemo(
        () => walletPositions.filter((position) => position.tallyStatus === "share_upload_failed"),
        [walletPositions],
    );
    const batchedTallyPositions = useMemo(
        () => [...retryableTallyPositions, ...pendingTallyPositions],
        [pendingTallyPositions, retryableTallyPositions],
    );
    const walletClaimableTotal = useMemo(
        () => claimablePositions.reduce((sum, position) => sum + payoutForPosition(market, BigInt(position.amountInStroops)), BigInt(0)),
        [claimablePositions, market],
    );
    const resolvedYesPercentage = market.resolved ? (market.outcome === "YES" ? 100 : 0) : null;
    const resolvedNoPercentage = market.resolved ? (market.outcome === "NO" ? 100 : 0) : null;
    const remainingClaimable = useMemo(
        () => (market.distributablePot > market.totalClaimedOut ? market.distributablePot - market.totalClaimedOut : BigInt(0)),
        [market.distributablePot, market.totalClaimedOut],
    );
    const uniqueConditions = useMemo(() => {
        const seen = new Set<string>();
        return market.conditions.filter((condition) => {
            const key = `${condition.assetSymbol}:${condition.oracleContract}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        });
    }, [market.conditions]);
    const latestPriceRefreshBucket = Math.floor(now / 15_000);
    const reflectorHistoryBucket = Math.floor(now / 1000 / 300) * 300;
    const reflectorRequestKey = useMemo(
        () => uniqueConditions.map((condition) => `${condition.oracleContract}:${condition.assetSymbol}`).join("|"),
        [uniqueConditions],
    );
    const activeSeries = assetSeries.find((entry) => entry.assetSymbol === activeAsset) ?? assetSeries[0];
    const activeCondition = uniqueConditions.find((entry) => entry.assetSymbol === activeSeries?.assetSymbol);
    const heroAsset = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === uniqueConditions[0]?.assetSymbol);
    const categoryArt = marketCategoryArt(market.category);
    const activeThresholdLabel = activeCondition && activeSeries
        ? `${activeCondition.assetSymbol} ${activeCondition.comparator} ${thresholdLabel(activeCondition.assetSymbol, activeCondition.threshold, activeSeries.decimals)}`
        : "Threshold unavailable";
    const activeThresholdValue = useMemo(() => {
        if (!activeCondition || !activeSeries) {
            return null;
        }
        return Number.parseFloat(formatOracleThreshold(activeCondition.threshold, activeSeries.decimals));
    }, [activeCondition, activeSeries]);
    const hasInsufficientFeeBalance = useMemo(() => {
        if (!estimatedCommitFeeXlm) {
            return false;
        }

        try {
            return decimalToStroops(xlmSpendableBalance, XLM_DECIMALS) < decimalToStroops(estimatedCommitFeeXlm, XLM_DECIMALS);
        } catch {
            return false;
        }
    }, [estimatedCommitFeeXlm, xlmSpendableBalance]);
    const commitAmountInStroops = useMemo(() => {
        try {
            return decimalToStroops(commitAmountUsdc);
        } catch {
            return 0n;
        }
    }, [commitAmountUsdc]);
    const isCommitAmountMissing = commitAmountUsdc.trim().length === 0 || commitAmountInStroops <= 0n;
    const isBelowMinCommit = !isCommitAmountMissing && commitAmountInStroops < market.minBet;
    const isAboveMaxCommit = !isCommitAmountMissing && commitAmountInStroops > market.maxBet;
    const hasInsufficientUsdcBalance = !isCommitAmountMissing && commitAmountInStroops > usdcBalance;

    useEffect(() => {
        if (!authenticated || stellarWallet) {
            return;
        }

        ensurePrivyStellarWallet({
            authenticated,
            hasWallet: Boolean(stellarWallet),
            createWallet,
        }).catch((creationError) => {
            if (isPrivyStellarWalletLimitError(creationError)) {
                return;
            }
            console.error("Failed to create Privy Stellar wallet:", creationError);
        });
    }, [authenticated, createWallet, stellarWallet]);

    async function refreshWalletBalances(address: string) {
        const [balance, nativeBalance] = await Promise.all([
            loadUsdcBalance(address),
            loadStellarNativeBalanceSummary(address),
        ]);
        setUsdcBalance(balance);
        setXlmBalance(nativeBalance.balance);
        setXlmSpendableBalance(nativeBalance.spendableBalance);
        setXlmMinimumBalance(nativeBalance.minimumBalance);
    }

    useEffect(() => {
        let cancelled = false;

        const run = async () => {
            if (!walletPublic) {
                setSavedPositions([]);
                return;
            }

            try {
                const [balance, nativeBalance, snapshot] = await Promise.all([
                    loadUsdcBalance(walletPublic),
                    loadStellarNativeBalanceSummary(walletPublic),
                    loadReputationSnapshot(walletPublic),
                ]);
                if (!cancelled) {
                    setUsdcBalance(balance);
                    setXlmBalance(nativeBalance.balance);
                    setXlmSpendableBalance(nativeBalance.spendableBalance);
                    setXlmMinimumBalance(nativeBalance.minimumBalance);
                    setSavedPositions(snapshot.positions);
                }
            } catch (loadError) {
                if (!cancelled) {
                    setCommitError(loadError instanceof Error ? loadError.message : String(loadError));
                }
            }
        };

        void run();

        return () => {
            cancelled = true;
        };
    }, [walletPublic]);

    useEffect(() => {
        if (uniqueConditions.length === 0) {
            setAssetSeries([]);
            return;
        }

        let cancelled = false;
        void (async () => {
            setChartBusy(true);
            try {
                const nextSeries = await Promise.all(
                    uniqueConditions.map(async (condition, index) => {
                        const [latest, history] = await Promise.all([
                            loadReflectorPrice(condition.oracleContract, condition.assetSymbol),
                            loadReflectorPriceHistory(condition.oracleContract, condition.assetSymbol, {
                                points: 24,
                                intervalSeconds: 3600,
                                endTimestamp: reflectorHistoryBucket,
                                cacheBucketSeconds: 300,
                            }),
                        ]);

                        return {
                            assetSymbol: condition.assetSymbol,
                            oracleContract: condition.oracleContract,
                            decimals: history.decimals,
                            latestLabel: latest?.formatted ?? history.points.at(-1)?.formatted ?? "Unavailable",
                            latestTimestamp: latest?.timestamp ?? history.points.at(-1)?.timestamp ?? null,
                            lineColor: CHART_LINE_COLORS[index % CHART_LINE_COLORS.length],
                            points: history.points.map((entry) => ({
                                time: entry.timestamp as UTCTimestamp,
                                value: Number(entry.formatted),
                            })),
                        } satisfies ReflectorSeries;
                    }),
                );

                if (!cancelled) {
                    setAssetSeries(nextSeries.filter((entry) => entry.points.length > 0));
                    setActiveAsset((current) => current || nextSeries[0]?.assetSymbol || "");
                }
            } catch (chartError) {
                if (!cancelled) {
                    console.error(chartError);
                }
            } finally {
                if (!cancelled) {
                    setChartBusy(false);
                }
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [latestPriceRefreshBucket, reflectorHistoryBucket, reflectorRequestKey, uniqueConditions]);

    function handleSetMaxCommitAmount() {
        const maxAllowed = usdcBalance < market.maxBet ? usdcBalance : market.maxBet;
        setCommitAmountUsdc(formatUsdcInput(maxAllowed));
    }

    async function refreshAfterMutation(successMessage: string) {
        await onMarketRefresh?.();
        if (walletPublic) {
            await refreshWalletBalances(walletPublic);
        }
        setStatus(successMessage);
    }

    function resetCommitReview() {
        setIsCommitReviewOpen(false);
        setPreparedCommit(null);
        setCommitReviewError("");
        setEstimatedCommitFeeXlm("");
        setIsEstimatingCommitFee(false);
        setIsFundingWallet(false);
        setCommitTxHash(null);
    }

    function commitGuardrailErrorMessage() {
        if (market.resolved || marketNeedsTally || marketReadyToFinalize) {
            return "Orders can only be executed while the market is open.";
        }
        if (isCommitAmountMissing) {
            return "Enter a USDC amount before preparing the order.";
        }
        if (isBelowMinCommit || isAboveMaxCommit) {
            return `Commit amount must stay within ${formatUsdc(market.minBet)} and ${formatUsdc(market.maxBet)}.`;
        }
        if (hasInsufficientUsdcBalance) {
            return `Need at least ${formatUsdc(commitAmountInStroops)} in USDC to place this order.`;
        }
        return null;
    }

    async function handleOpenCommitReview() {
        if (!authenticated) {
            await login();
            return;
        }

        if (!stellarWallet || !walletPublic) {
            setCommitError("Connect your Privy Stellar wallet before placing an order.");
            return;
        }

        const guardrailError = commitGuardrailErrorMessage();
        if (guardrailError) {
            setCommitError(guardrailError);
            setCommitReviewError(guardrailError);
            return;
        }

        setBusy("commit");
        setCommitError("");
        setCommitReviewError("");
        setCommitTxHash(null);
        try {
            const proof = await generateCommitProof({
                marketId: market.marketId,
                side: commitSide,
                amountUsdc: Number(commitAmountUsdc),
                minBet: market.minBet,
                maxBet: market.maxBet,
            });

            setPreparedCommit({
                proof,
                side: commitSide,
                amountUsdc: commitAmountUsdc,
            });
            setIsCommitReviewOpen(true);
            setIsEstimatingCommitFee(true);

            try {
                const [_, feeEstimate] = await Promise.all([
                    refreshWalletBalances(walletPublic),
                    estimateCommitPositionFee(stellarWallet, {
                        marketId: market.marketId,
                        owner: walletPublic,
                        commitment: proof.commitment,
                        amountInStroops: proof.amountInStroops,
                        proofHex: proof.proofHex,
                    }),
                ]);

                setEstimatedCommitFeeXlm(stroopsStringToDecimal(feeEstimate.totalFee.toString(), XLM_DECIMALS));
            } catch (estimateError) {
                console.error("Estimate execute order fee failed:", estimateError);
                const nextError = humanizeCommitFlowError(estimateError, {
                    proof,
                    side: commitSide,
                    amountUsdc: commitAmountUsdc,
                });
                setEstimatedCommitFeeXlm("");
                setCommitError(nextError);
                setCommitReviewError(nextError);
                setIsCommitReviewOpen(true);
            }
        } catch (prepareError) {
            console.error("Prepare execute order failed:", prepareError);
            const nextError = humanizeCommitFlowError(prepareError, null);
            setCommitError(nextError);
            setCommitReviewError(nextError);
            resetCommitReview();
        } finally {
            setBusy(null);
            setIsEstimatingCommitFee(false);
        }
    }

    async function handleCommit() {
        if (!stellarWallet || !walletPublic || !preparedCommit) {
            return;
        }

        setBusy("commit-submit");
        setCommitError("");
        setCommitReviewError("");
        try {
            const tx = await commitPositionWithPrivyWallet(stellarWallet, signRawHash, {
                marketId: market.marketId,
                owner: walletPublic,
                commitment: preparedCommit.proof.commitment,
                amountInStroops: preparedCommit.proof.amountInStroops,
                proofHex: preparedCommit.proof.proofHex,
            });

            const committedPosition: BlindPositionRecord = {
                marketId: market.marketId,
                marketQuestion: market.question,
                category: market.category,
                owner: walletPublic,
                side: preparedCommit.side,
                amountInStroops: preparedCommit.proof.amountInStroops.toString(),
                salt: preparedCommit.proof.salt,
                commitment: preparedCommit.proof.commitment,
                nullifier: preparedCommit.proof.nullifier,
                commitTxHash: tx.hash,
                tallyStatus: "pending",
                claimedAt: undefined,
            };
            setSavedPositions((current) => [committedPosition, ...current.filter((entry) => entry.commitment !== committedPosition.commitment)]);
            await upsertCommittedPosition(walletPublic, committedPosition);

            setCommitTxHash(tx.hash);
            await refreshAfterMutation(`Committed a hidden ${preparedCommit.side} position for ${preparedCommit.amountUsdc} USDC.`);
        } catch (commitError) {
            console.error("Execute order failed:", commitError);
            const nextError = humanizeCommitFlowError(commitError, preparedCommit);
            setCommitError(nextError);
            setCommitReviewError(nextError);
            setIsCommitReviewOpen(true);
        } finally {
            setBusy(null);
        }
    }

    async function submitTallyForPosition(position: BlindPositionRecord, previousTallyCommitment: string) {
        if (!stellarWallet || !walletPublic) {
            throw new Error("Connect your Privy Stellar wallet before submitting a tally.");
        }

        let submittedTxHash: string | null = position.tallyTxHash ?? null;
        let submittedShareCommitmentRoot = position.shareCommitmentRoot ?? "";
        let submittedSharePackets = position.tallySharePackets ?? [];
        try {
            const proof = await generateTallyUpdateProof({
                marketId: market.marketId,
                side: position.side,
                amountInStroops: BigInt(position.amountInStroops),
                salt: position.salt,
                commitment: position.commitment,
                previousTallyCommitment,
            });

            const tx = await submitPrivateTallyWithPrivyWallet(stellarWallet, signRawHash, {
                marketId: market.marketId,
                commitment: position.commitment,
                previousTallyCommitment,
                nextTallyCommitment: proof.nextTallyCommitment,
                shareCommitmentRoot: proof.shareCommitmentRoot,
                collateralAmount: BigInt(position.amountInStroops),
                proofHex: proof.proofHex,
            });
            submittedTxHash = tx.hash;
            submittedShareCommitmentRoot = proof.shareCommitmentRoot;
            submittedSharePackets = proof.sharePackets;

            await submitTallySharesToBackend({
                tallyTxHash: tx.hash,
                shareCommitmentRoot: proof.shareCommitmentRoot,
                packets: proof.sharePackets,
            });

            const talliedAt = Date.now();
            setSavedPositions((current) => current.map((entry) => (
                entry.commitment === position.commitment
                    ? {
                        ...entry,
                        tallyTxHash: tx.hash,
                        tallyStatus: "queued_for_auto_finalization",
                        talliedAt,
                        shareCommitmentRoot: proof.shareCommitmentRoot,
                        tallySharePackets: proof.sharePackets,
                    }
                    : entry
            )));
            await markClaimedPosition(walletPublic, position.commitment, {
                tallyTxHash: tx.hash,
                tallyStatus: "queued_for_auto_finalization",
                talliedAt,
                shareCommitmentRoot: proof.shareCommitmentRoot,
                tallySharePackets: proof.sharePackets,
            });

            return proof.nextTallyCommitment;
        } catch (tallyError) {
            console.error("Submit private tally failed:", tallyError);
            const message = tallyError instanceof Error ? tallyError.message : String(tallyError);
            if (submittedTxHash) {
                setSavedPositions((current) => current.map((entry) => (
                    entry.commitment === position.commitment
                        ? {
                            ...entry,
                            tallyTxHash: submittedTxHash ?? entry.tallyTxHash,
                            tallyStatus: "share_upload_failed",
                            shareCommitmentRoot: submittedShareCommitmentRoot || entry.shareCommitmentRoot,
                            tallySharePackets: submittedSharePackets.length > 0 ? submittedSharePackets : entry.tallySharePackets,
                        }
                        : entry
                )));
                await markClaimedPosition(walletPublic, position.commitment, {
                    tallyTxHash: submittedTxHash ?? position.tallyTxHash,
                    tallyStatus: "share_upload_failed",
                    shareCommitmentRoot: submittedShareCommitmentRoot || position.shareCommitmentRoot,
                    tallySharePackets: submittedSharePackets.length > 0 ? submittedSharePackets : position.tallySharePackets,
                });
            }
            throw new Error(message);
        }
    }

    async function handleSubmitAllTallies() {
        if (batchedTallyPositions.length === 0) {
            return;
        }

        setBusy("tally-batch");
        setCommitError("");
        let completedCount = 0;
        try {
            let liveView = await loadMarketView(market.marketId);
            let liveMarket = mapMarketSummary({ marketId: market.marketId, view: liveView });
            let previousTallyCommitment = liveMarket.tallyCommitment || `0x${"0".repeat(64)}`;

            for (const position of batchedTallyPositions) {
                previousTallyCommitment = await submitTallyForPosition(position, previousTallyCommitment);
                completedCount += 1;
                liveView = await loadMarketView(market.marketId);
                liveMarket = mapMarketSummary({ marketId: market.marketId, view: liveView });
                previousTallyCommitment = liveMarket.tallyCommitment || previousTallyCommitment;
            }

            await onMarketRefresh?.();
            setStatus(
                completedCount === 1
                    ? "Private tally submitted and share packets uploaded. Auto-finalization is queued."
                    : `${completedCount} private tallies submitted and uploaded. Auto-finalization is queued.`,
            );
        } catch (tallyError) {
            const message = tallyError instanceof Error ? tallyError.message : String(tallyError);
            setCommitError(
                completedCount > 0
                    ? `${completedCount} tall${completedCount === 1 ? "y" : "ies"} submitted before the batch stopped. ${message}`
                    : message,
            );
            await onMarketRefresh?.();
        } finally {
            setBusy(null);
        }
    }

    async function handleGetFunds() {
        if (!walletPublic || !isTestnet) {
            return;
        }

        setIsFundingWallet(true);
        setCommitError("");
        setCommitReviewError("");
        try {
            await fundStellarTestnetAddress(walletPublic);
            await refreshWalletBalances(walletPublic);
        } catch (fundingError) {
            const message = fundingError instanceof Error ? fundingError.message : String(fundingError);
            setCommitError(message);
            setCommitReviewError(message);
        } finally {
            setIsFundingWallet(false);
        }
    }

    async function claimSinglePosition(position: BlindPositionRecord) {
        if (!stellarWallet || !market.outcome) {
            throw new Error("Connect your Privy Stellar wallet before claiming.");
        }

        const proof = await generateClaimProof({
            marketId: market.marketId,
            side: position.side,
            amountInStroops: BigInt(position.amountInStroops),
            salt: position.salt,
            commitment: position.commitment,
            nullifier: position.nullifier,
            outcome: market.outcome === "YES",
            distributablePot: market.distributablePot,
            winningSideTotal: market.winningSideTotal,
        });

        const tx = await claimWinningsWithPrivyWallet(stellarWallet, signRawHash, {
            marketId: market.marketId,
            commitment: proof.commitment,
            nullifier: proof.nullifier,
            recipient: position.owner,
            proofHex: proof.proofHex,
        });

        const claimedAt = Date.now();
        setSavedPositions((current) => current.map((entry) => (
            entry.commitment === position.commitment
                ? { ...entry, claimTxHash: tx.hash, claimedAt, reputationAttestationStatus: "pending" }
                : entry
        )));
        await markClaimedPosition(walletPublic, position.commitment, {
            claimTxHash: tx.hash,
            claimedAt,
            reputationAttestationStatus: "pending",
        });

        const payoutInStroops = payoutForPosition(market, BigInt(position.amountInStroops));
        const witnessSalt = randomWitnessSalt();
        const recordCommitment = await computeRecordCommitment({
            walletAddress: walletPublic,
            marketId: market.marketId,
            category: market.category,
            amountInStroops: BigInt(position.amountInStroops),
            payoutInStroops,
            won: payoutInStroops > 0n,
            claimedAt: Math.floor(claimedAt / 1000),
            witnessSalt,
        });
        await upsertPrivateReputationWitness(walletPublic, {
            marketId: market.marketId,
            commitment: position.commitment,
            nullifier: position.nullifier,
            side: position.side,
            amountInStroops: position.amountInStroops,
            payoutInStroops: payoutInStroops.toString(),
            won: payoutInStroops > 0n,
            claimedAt: Math.floor(claimedAt / 1000),
            resolvedAt: market.settledAt ? Math.floor(market.settledAt / 1000) : 0,
            category: market.category.toLowerCase(),
            witnessSalt,
            recordCommitment,
        });

        try {
            const attestedRecord = await attestClaimRecord({
                walletAddress: walletPublic,
                marketId: market.marketId,
                commitment: position.commitment,
                nullifier: position.nullifier,
                claimTxHash: tx.hash,
                category: market.category,
                recordCommitment,
                witnessSalt,
                claimedAt,
            });
            await upsertAttestedRecord(walletPublic, attestedRecord);
            await upsertPrivateReputationWitness(walletPublic, {
                marketId: market.marketId,
                commitment: position.commitment,
                nullifier: position.nullifier,
                side: position.side,
                amountInStroops: position.amountInStroops,
                payoutInStroops: payoutInStroops.toString(),
                won: payoutInStroops > 0n,
                claimedAt: attestedRecord.claimedAt,
                resolvedAt: attestedRecord.resolvedAt,
                category: market.category.toLowerCase(),
                witnessSalt,
                recordCommitment,
            });
            setSavedPositions((current) => current.map((entry) => (
                entry.commitment === position.commitment
                    ? { ...entry, reputationAttestationStatus: "attested" }
                    : entry
            )));
            await markClaimedPosition(walletPublic, position.commitment, {
                reputationAttestationStatus: "attested",
            });
        } catch (attestationError) {
            console.error("Claim attestation failed:", attestationError);
        }

        return proof.payout;
    }

    async function handleClaim(position: BlindPositionRecord) {
        setBusy(position.commitment);
        setCommitError("");
        try {
            const payout = await claimSinglePosition(position);
            await refreshAfterMutation(`Claimed ${formatUsdc(payout)} from the market pot.`);
        } catch (claimError) {
            console.error("Claim winnings failed:", claimError);
            setCommitError(claimError instanceof Error ? claimError.message : String(claimError));
        } finally {
            setBusy(null);
        }
    }

    async function handleClaimAll() {
        if (claimablePositions.length === 0) {
            return;
        }

        setBusy("claim-batch");
        setCommitError("");
        let completedCount = 0;
        let totalPayout = 0n;
        try {
            for (const position of claimablePositions) {
                totalPayout += await claimSinglePosition(position);
                completedCount += 1;
            }
            await refreshAfterMutation(
                completedCount === 1
                    ? `Claimed ${formatUsdc(totalPayout)} from the market pot.`
                    : `Claimed ${formatUsdc(totalPayout)} across ${completedCount} positions.`,
            );
        } catch (claimError) {
            console.error("Batch claim failed:", claimError);
            const message = claimError instanceof Error ? claimError.message : String(claimError);
            setCommitError(
                completedCount > 0
                    ? `${completedCount} claim${completedCount === 1 ? "" : "s"} completed before the batch stopped. ${message}`
                    : message,
            );
        } finally {
            setBusy(null);
        }
    }

    return (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -20 }}
            className="flex flex-col gap-8"
        >
            <div className="flex flex-col gap-6">
                <button
                    onClick={onBack}
                    className="flex items-center gap-2 text-white/40 hover:text-white transition-colors group w-fit"
                >
                    <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
                    <span className="text-sm font-bold uppercase tracking-widest">Back to Markets</span>
                </button>

                <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-6 sm:gap-8">
                    <div className="flex flex-col sm:flex-row items-center sm:items-start gap-4 sm:gap-6 text-center sm:text-left">
                        <div className={categoryArt ? "flex h-20 w-20 shrink-0 items-center justify-center overflow-visible sm:h-24 sm:w-24" : "flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.03] sm:h-20 sm:w-20"}>
                            {categoryArt ? (
                                <img
                                    src={categoryArt}
                                    alt={`${market.category} market`}
                                    className="h-20 w-20 object-contain sm:h-24 sm:w-24"
                                />
                            ) : heroAsset?.icon ? (
                                <img
                                    src={heroAsset.icon}
                                    alt={heroAsset.name}
                                    className="h-10 w-10 object-contain sm:h-12 sm:w-12"
                                />
                            ) : (
                                <LockKeyhole className="w-8 h-8 sm:w-10 sm:h-10 text-white/20" />
                            )}
                        </div>
                        <div className="flex flex-col items-center sm:items-start min-w-0 w-full">
                            <h1 className="text-xl sm:text-2xl lg:text-3xl font-black text-white tracking-tight leading-tight mb-3 break-words w-full">
                                {market.question}
                            </h1>
                            <div className="flex flex-wrap items-center justify-center sm:justify-start gap-2 sm:gap-3">
                                <span className="bg-white/5 border border-white/10 px-2 sm:px-3 py-1 rounded text-[9px] sm:text-[10px] font-bold text-white/60 uppercase tracking-widest italic">
                                    {market.category}
                                </span>
                                <div className={`px-2 sm:px-2.5 py-0.5 rounded-full border text-[9px] sm:text-[10px] uppercase font-black tracking-widest italic whitespace-nowrap ${market.resolved ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-300" : "bg-violet-500/10 border-violet-500/20 text-violet-300"}`}>
                                    {marketStatusLabel(market)}
                                </div>
                                <div className="flex items-center gap-2 px-2 sm:px-3 py-1 rounded-full bg-white/5 border border-white/10 text-white/40 text-[9px] sm:text-[10px] uppercase font-bold tracking-widest leading-none">
                                    <Clock3 className="w-3 h-3" />
                                    {market.resolved ? formatTimestamp(market.settledAt) : formatTimestamp(market.endTimestamp)}
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 sm:gap-4 shrink-0">
                        <div className={`px-4 sm:px-6 py-3 sm:py-4 rounded-2xl text-center ${
                            market.resolved
                                ? market.outcome === "YES"
                                    ? "bg-emerald-500/10 border border-emerald-500/20"
                                    : "bg-red-500/10 border border-red-500/20"
                                : "bg-violet-500/10 border border-violet-500/20"
                        }`}>
                            <p className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.2em] mb-1 ${
                                market.resolved
                                    ? market.outcome === "YES"
                                        ? "text-emerald-300"
                                        : "text-red-300"
                                    : "text-violet-300"
                            }`}>YES Side</p>
                            {market.resolved ? (
                                <div className="pt-1">
                                    <p className={`text-lg font-black tracking-tight ${market.outcome === "YES" ? "text-emerald-200" : "text-red-200"}`}>
                                        {formatPercentage(resolvedYesPercentage ?? 0)}
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center justify-center pt-1">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-violet-400/20 bg-violet-400/10">
                                        <LockKeyhole className="h-3.5 w-3.5 text-violet-200/80" />
                                    </div>
                                </div>
                            )}
                        </div>
                        <div className={`px-4 sm:px-6 py-3 sm:py-4 rounded-2xl text-center ${
                            market.resolved
                                ? market.outcome === "NO"
                                    ? "bg-emerald-500/10 border border-emerald-500/20"
                                    : "bg-red-500/10 border border-red-500/20"
                                : "bg-violet-500/10 border border-violet-500/20"
                        }`}>
                            <p className={`text-[9px] sm:text-[10px] font-bold uppercase tracking-[0.2em] mb-1 ${
                                market.resolved
                                    ? market.outcome === "NO"
                                        ? "text-emerald-300"
                                        : "text-red-300"
                                    : "text-violet-300"
                            }`}>NO Side</p>
                            {market.resolved ? (
                                <div className="pt-1">
                                    <p className={`text-lg font-black tracking-tight ${market.outcome === "NO" ? "text-emerald-200" : "text-red-200"}`}>
                                        {formatPercentage(resolvedNoPercentage ?? 0)}
                                    </p>
                                </div>
                            ) : (
                                <div className="flex items-center justify-center pt-1">
                                    <div className="flex h-8 w-8 items-center justify-center rounded-full border border-violet-400/20 bg-violet-400/10">
                                        <LockKeyhole className="h-3.5 w-3.5 text-violet-200/80" />
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-3 gap-8">
                <div className="xl:col-span-2 space-y-8">
                    <div className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-5 sm:p-8 rounded-2xl sm:rounded-3xl">
                        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-6 mb-8">
                            <div className="flex items-center gap-3">
                                <TrendingUp className="w-5 h-5 text-white/60 shrink-0" />
                                <h2 className="text-lg sm:text-xl font-bold text-white whitespace-nowrap">Price Trajectory</h2>
                            </div>
                            <div className="flex bg-white/5 p-1 rounded-xl w-full sm:w-auto">
                                {assetSeries.map((item) => (
                                    <button
                                        key={item.assetSymbol}
                                        onClick={() => setActiveAsset(item.assetSymbol)}
                                        className={`flex-1 sm:flex-none px-4 py-2 rounded-lg text-xs font-bold transition-all ${
                                            activeAsset === item.assetSymbol
                                                ? "bg-white text-black"
                                                : "text-white/40 hover:text-white"
                                        }`}
                                    >
                                        {item.assetSymbol}
                                    </button>
                                ))}
                            </div>
                        </div>

                        {chartBusy && assetSeries.length === 0 ? (
                            <div className="flex h-[300px] sm:h-[400px] items-center justify-center">
                                <div className="flex items-center gap-3 text-white/50">
                                    <Loader2 className="h-4 w-4 animate-spin" />
                                    <span className="text-sm font-medium">Loading Reflector history...</span>
                                </div>
                            </div>
                        ) : assetSeries.length > 0 ? (
                            <div className="relative">
                                {chartBusy ? (
                                    <div className="pointer-events-none absolute right-3 top-3 z-10 inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/45 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.18em] text-white/70 backdrop-blur-sm">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Refreshing
                                    </div>
                                ) : null}
                                <ReflectorChart
                                    series={assetSeries}
                                    activeAsset={activeAsset}
                                    thresholdValue={activeThresholdValue}
                                />
                            </div>
                        ) : (
                            <div className="flex h-[300px] sm:h-[400px] items-center justify-center text-sm text-white/45">
                                No Reflector history available for the assets in this market yet.
                            </div>
                        )}

                        <div className="grid grid-cols-2 gap-4 mt-8 border-t border-white/5 pt-8 sm:grid-cols-4">
                            <div>
                                <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">Total Committed</p>
                                <p className="text-lg font-black text-white sm:text-xl">{formatUsdc(market.totalLockedCollateral)}</p>
                            </div>
                            <div>
                                <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">Your Committed</p>
                                <p className="text-lg font-black text-violet-300 sm:text-xl">{formatUsdc(walletCommittedCollateral)}</p>
                            </div>
                            <div>
                                <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">{market.resolved ? "Claimed Out" : "Total Commitments"}</p>
                                <p className="text-lg font-black text-white sm:text-xl">{market.resolved ? formatUsdc(market.totalClaimedOut) : market.commitmentCount}</p>
                            </div>
                            <div>
                                <p className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em] mb-2">{market.resolved ? "Remaining Claimable" : "Your Commitments"}</p>
                                <p className="text-lg font-black text-white sm:text-xl">{market.resolved ? formatUsdc(remainingClaimable) : walletPositions.length}</p>
                            </div>
                        </div>
                    </div>

                    <div className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-5 sm:p-8 rounded-2xl sm:rounded-3xl space-y-8">
                        <div>
                            <div className="flex items-center gap-3 mb-4">
                                <Zap className="w-5 h-5 text-white/60" />
                                <h3 className="text-lg font-bold text-white">Market Definition</h3>
                            </div>
                            <div className="flex flex-col gap-4">
                                <div className="rounded-[28px] border border-white/5 bg-white/[0.03] px-5 py-5 sm:px-6 sm:py-6">
                                    <p className="text-[10px] font-black uppercase tracking-[0.24em] text-white/25">Market Question</p>
                                    <p className="mt-3 max-w-4xl text-xl font-black leading-tight text-white sm:text-2xl">
                                        {market.question}
                                    </p>
                                    <div className="mt-5 flex flex-wrap gap-2">
                                        <span className="rounded-full border border-white/8 bg-black/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                                            {market.category}
                                        </span>
                                        <span className="rounded-full border border-white/8 bg-black/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                                            {market.conditions.length} Oracle Check{market.conditions.length > 1 ? "s" : ""}
                                        </span>
                                        <span className="rounded-full border border-white/8 bg-black/15 px-3 py-1.5 text-[10px] font-black uppercase tracking-[0.2em] text-white/55">
                                            Ends {formatTimestamp(market.endTimestamp)}
                                        </span>
                                    </div>
                                </div>

                                <div className="rounded-[28px] border border-white/5 bg-white/[0.03] px-5 py-5 sm:px-6 sm:py-6">
                                    <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Min Bet</p>
                                            <p className="mt-2 text-xl font-black text-white">{formatUsdc(market.minBet)}</p>
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Max Bet</p>
                                            <p className="mt-2 text-xl font-black text-white">{formatUsdc(market.maxBet)}</p>
                                        </div>
                                        <div>
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/25">Creator Wallet</p>
                                            <p className="mt-2 text-lg font-black text-white">{formatCompactAddress(market.creator)}</p>
                                            <p className="mt-1 font-mono text-[11px] text-white/34">{shortenAddress(market.creator, 12, 8)}</p>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1.15fr_0.85fr]">
                            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 sm:p-6">
                                <div className="flex items-center gap-3 mb-4">
                                    <Database className="w-5 h-5 text-white/60" />
                                    <h3 className="text-lg font-bold text-white">Oracle Data Sources</h3>
                                </div>
                                <p className="mb-5 text-sm leading-relaxed text-white/45">
                                    Live market inputs used at resolution. Current values stream from Reflector while the market is open.
                                </p>
                                <div className="max-h-[280px] overflow-y-auto pr-1 space-y-3 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                                    {market.conditions.map((condition, index) => {
                                        const source = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === condition.assetSymbol);
                                        const seriesEntry = assetSeries.find((entry) => (
                                            entry.assetSymbol === condition.assetSymbol
                                            && entry.oracleContract === condition.oracleContract
                                        ));

                                        return (
                                            <div key={`${condition.assetSymbol}-${index}`} className="rounded-xl border border-white/5 bg-black/15 p-3">
                                                <div className="flex items-center justify-between gap-3">
                                                    <div className="flex items-center gap-3">
                                                        <div className="w-8 h-8 rounded-lg bg-white/5 p-1.5 overflow-hidden flex items-center justify-center shrink-0">
                                                            {source?.icon ? (
                                                                <img src={source.icon} alt={source.name} className="w-full h-full object-contain" />
                                                            ) : (
                                                                <Database className="w-3.5 h-3.5 text-white/40" />
                                                            )}
                                                        </div>
                                                        <div>
                                                            <p className="text-sm font-bold text-white leading-tight">{source?.name ?? condition.assetSymbol}</p>
                                                            <p className="text-[9px] text-white/35 uppercase font-bold tracking-[0.2em]">{condition.assetSymbol}</p>
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <p className="text-base font-black tracking-tight text-white">{seriesEntry?.latestLabel ?? "NA"}</p>
                                                        <p className="text-[8px] text-white/20 font-bold uppercase tracking-[0.2em] leading-none mt-0.5">Live Value</p>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <div className="rounded-2xl border border-white/5 bg-white/[0.03] p-5 sm:p-6">
                                <div className="flex items-center gap-3 mb-4">
                                    <Shield className="w-5 h-5 text-violet-200/80" />
                                    <h3 className="text-lg font-bold text-white">Settlement Window</h3>
                                </div>
                                <p className="mb-5 text-sm leading-relaxed text-white/42">
                                    Commitments stay private through expiry, then each position is tallied before the final aggregate can be proven on-chain.
                                </p>
                                <div className="rounded-2xl border border-white/5 bg-black/15 px-4 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
                                    <div className="grid grid-cols-2 gap-x-5 gap-y-4">
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/38">Expiry</p>
                                            <p className="text-sm font-semibold text-white/88">{formatCompactTimestamp(market.endTimestamp)}</p>
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/38">Tally Deadline</p>
                                            <p className="text-sm font-semibold text-white/88">{formatCompactTimestamp(market.tallyDeadline)}</p>
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/38">Tallied</p>
                                            <p className="text-sm font-semibold text-white/88">{market.talliedCount}</p>
                                        </div>
                                        <div className="space-y-1">
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-violet-200/38">Lifecycle</p>
                                            <p className="text-sm font-semibold text-white/88">{marketStatusLabel(market)}</p>
                                        </div>
                                    </div>
                                </div>
                                <div className="mt-5">
                                    <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                                        <p className="text-[10px] font-black uppercase tracking-[0.24em] text-violet-200/38">Resolution Logic</p>
                                        <span className="text-[11px] text-white/46">
                                            {market.resolved ? (
                                                <>
                                                    Resolved <span className="font-semibold text-emerald-300">{formatCompactTimestamp(market.settledAt)}</span>
                                                </>
                                            ) : (
                                                <>
                                                    Evaluates at <span className="font-semibold text-white/85">{formatCompactTimestamp(market.endTimestamp)}</span>
                                                </>
                                            )}
                                        </span>
                                    </div>
                                    <div className="rounded-2xl border border-white/5 bg-black/15 p-3">
                                        <div className="flex flex-col gap-2.5">
                                        {market.conditions.map((condition, index) => {
                                            const decimals = assetSeries.find((entry) => (
                                                entry.assetSymbol === condition.assetSymbol
                                                && entry.oracleContract === condition.oracleContract
                                            ))?.decimals ?? 0;
                                            const source = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === condition.assetSymbol);

                                            const operator = market.conditionOperators && index > 0
                                                ? (market.conditionOperators[index - 1] ? "AND" : "OR")
                                                : null;

                                            const resolvedCondition = market.resolvedConditions?.[index];

                                            return (
                                                <div key={`${condition.assetSymbol}-logic-group-${index}`} className="flex flex-col gap-2.5">
                                                    {operator && (
                                                        <div className="px-1">
                                                            <span className="text-[9px] font-black uppercase tracking-[0.22em] text-violet-200/28">
                                                                {operator}
                                                            </span>
                                                        </div>
                                                    )}
                                                    <div className={`rounded-xl border px-4 py-3 ${
                                                        resolvedCondition?.satisfied 
                                                            ? "border-emerald-500/20 bg-emerald-500/[0.04]"
                                                            : market.resolved
                                                                ? "border-red-500/20 bg-red-500/[0.03]"
                                                                : "border-violet-500/12 bg-violet-500/[0.05]"
                                                    }`}>
                                                        <div className="flex flex-wrap items-start justify-between gap-3">
                                                            <div className="flex min-w-0 items-center gap-3">
                                                                <div className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-white/8 bg-white/[0.04] p-1.5">
                                                                    {source?.icon ? (
                                                                        <img src={source.icon} alt={source.name} className="h-full w-full object-contain" />
                                                                    ) : (
                                                                        <Database className="h-4 w-4 text-white/40" />
                                                                    )}
                                                                </div>
                                                                <div className="min-w-0">
                                                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/28">
                                                                        {source?.name ?? condition.assetSymbol}
                                                                    </p>
                                                                    <span className={`mt-1 block text-base font-semibold leading-snug ${
                                                                        resolvedCondition?.satisfied 
                                                                            ? "text-emerald-300"
                                                                            : market.resolved
                                                                                ? "text-red-300"
                                                                                : "text-white"
                                                                    }`}>
                                                                        {readableConditionLabel(condition, decimals)}
                                                                    </span>
                                                                </div>
                                                            </div>
                                                            {resolvedCondition && (
                                                                <span className={`rounded-full border px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.18em] ${
                                                                    resolvedCondition.satisfied 
                                                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400" 
                                                                        : "border-red-500/30 bg-red-500/10 text-red-400"
                                                                }`}>
                                                                    {resolvedCondition.satisfied ? "SATISFIED" : "FAILED"}
                                                                </span>
                                                            )}
                                                        </div>
                                                        {resolvedCondition && resolvedCondition.observedTimestamp > 0 && (
                                                            <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-white/42">
                                                                <span>Observed</span>
                                                                <span className="font-semibold text-white/72">{formatOracleThreshold(resolvedCondition.observedPrice, decimals)}</span>
                                                                <span>at</span>
                                                                <span className="font-semibold text-white/62">{formatCompactTimestamp(resolvedCondition.observedTimestamp)}</span>
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                            );
                                        })}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-5 sm:p-8 rounded-2xl sm:rounded-3xl space-y-6">
                        <div className="flex items-center gap-3">
                            <Wallet className="w-5 h-5 text-violet-200/80" />
                            <h2 className="text-lg sm:text-xl font-bold text-white">Private Position Vault</h2>
                        </div>

                        <div className="space-y-6">
                            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 sm:p-6">
                                <div className="mb-5 flex items-start justify-between gap-3">
                                    <div>
                                        <p className="text-[10px] uppercase tracking-[0.22em] text-violet-200/38 font-black">Portfolio Summary</p>
                                        <p className="mt-2 text-sm text-white/50">Your private exposure in this market is tracked and claimed commitment by commitment.</p>
                                    </div>
                                    <div className="rounded-full border border-violet-500/15 bg-violet-500/[0.06] px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-violet-100/70">
                                        {walletPositions.length} commitments
                                    </div>
                                </div>

                                <div className="grid grid-cols-2 gap-x-6 gap-y-4 border-t border-white/6 pt-4 sm:grid-cols-4">
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Total Private</p>
                                        <p className="mt-1.5 text-base font-semibold text-white">{formatUsdc(walletCommittedCollateral)}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-200/38">YES Exposure</p>
                                        <p className="mt-1.5 text-base font-semibold text-white">{formatUsdc(walletYesCommittedCollateral)}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">NO Exposure</p>
                                        <p className="mt-1.5 text-base font-semibold text-white">{formatUsdc(walletNoCommittedCollateral)}</p>
                                    </div>
                                    <div>
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Claimable</p>
                                        <p className="mt-1.5 text-base font-semibold text-white">{market.resolved ? formatUsdc(walletClaimableTotal) : "Pending"}</p>
                                    </div>
                                </div>
                            </div>

                            <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 sm:p-6">
                                <div className="mb-4 flex items-center justify-between gap-3">
                                    <div>
                                        <p className="text-[10px] uppercase tracking-[0.22em] text-violet-200/38 font-black">Individual Commitments</p>
                                        <p className="mt-2 text-sm text-white/50">Detailed private positions saved for this wallet.</p>
                                    </div>
                                </div>

                                {batchedTallyPositions.length > 0 ? (
                                    <button
                                        className="mb-4 w-full rounded-2xl border border-white/10 bg-white px-4 py-3 text-xs font-black uppercase tracking-[0.2em] text-black transition-colors hover:bg-white/90 disabled:opacity-60"
                                        disabled={busy === "tally-batch"}
                                        onClick={() => void handleSubmitAllTallies()}
                                    >
                                        {busy === "tally-batch"
                                            ? "Submitting tallies..."
                                            : retryableTallyPositions.length > 0 && pendingTallyPositions.length > 0
                                                ? `Tally all positions and retry ${retryableTallyPositions.length} upload${retryableTallyPositions.length === 1 ? "" : "s"}`
                                                : retryableTallyPositions.length > 0
                                                    ? `Retry ${retryableTallyPositions.length} tally upload${retryableTallyPositions.length === 1 ? "" : "s"}`
                                                    : `Tally all ${pendingTallyPositions.length} position${pendingTallyPositions.length === 1 ? "" : "s"}`}
                                    </button>
                                ) : null}

                                <div className="max-h-[260px] space-y-3 overflow-y-auto pr-2 scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
                                    {walletPositions.length === 0 ? (
                                        <div className="rounded-2xl border border-white/5 bg-black/20 p-5">
                                            <p className="text-sm text-white/55">
                                                No private positions saved for this wallet on this market yet.
                                            </p>
                                        </div>
                                    ) : (
                                        walletPositions.map((position, index) => {
                                            const amount = BigInt(position.amountInStroops);
                                            const payout = payoutForPosition(market, amount);
                                            return (
                                                <div key={position.commitment} className="rounded-2xl border border-white/5 bg-black/20 p-4">
                                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                                        <div className="flex items-center gap-2">
                                                            <span className={`rounded-full border px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${
                                                                position.side === "YES"
                                                                    ? "border-violet-500/20 bg-violet-500/[0.08] text-violet-100/80"
                                                                    : "border-white/10 bg-white/[0.04] text-white/70"
                                                            }`}>
                                                                {position.side}
                                                            </span>
                                                            <span className="text-[10px] uppercase tracking-[0.22em] text-white/25 font-black">
                                                                Commit #{index + 1}
                                                            </span>
                                                        </div>
                                                        <span className="text-[10px] uppercase tracking-[0.22em] text-white/30 font-black">
                                                            {positionStatusLabel(position, market)}
                                                        </span>
                                                    </div>
                                                    <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                                                        <div>
                                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Amount</p>
                                                            <p className="font-semibold text-white">{stroopsToUsdc(amount).toFixed(2)} USDC</p>
                                                        </div>
                                                        <div>
                                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Expected Payout</p>
                                                            <p className="font-semibold text-white">{market.resolved ? formatUsdc(payout) : "Pending"}</p>
                                                        </div>
                                                    </div>
                                                    <div className="mt-4 border-t border-white/6 pt-3 text-[11px] font-mono text-white/35 break-all">
                                                        {position.commitment}
                                                    </div>
                                                    {position.tallyStatus === "share_upload_failed" ? (
                                                        <div className="mt-4 rounded-2xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-xs font-black uppercase tracking-[0.18em] text-amber-100/80">
                                                            Included in next retry batch
                                                        </div>
                                                    ) : position.tallyStatus !== "queued_for_auto_finalization" && position.tallyStatus !== "finalizing" && position.tallyStatus !== "tally_submitted" && marketNeedsTally ? (
                                                        <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs font-black uppercase tracking-[0.18em] text-white/60">
                                                            Included in next tally batch
                                                        </div>
                                                    ) : position.tallyStatus === "tally_submitted" || position.tallyStatus === "queued_for_auto_finalization" ? (
                                                        <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs font-black uppercase tracking-[0.18em] text-white/60">
                                                            Queued for auto-finalization
                                                        </div>
                                                    ) : position.tallyStatus === "finalizing" ? (
                                                        <div className="mt-4 rounded-2xl border border-white/8 bg-white/[0.03] px-4 py-3 text-xs font-black uppercase tracking-[0.18em] text-white/60">
                                                            Finalizing
                                                        </div>
                                                    ) : null}
                                                </div>
                                            );
                                        })
                                    )}
                                </div>
                            </div>

                            {walletAllTallied && !market.resolved ? (
                                <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="flex items-center gap-2">
                                            <Clock3 className="h-4 w-4 text-white/60" />
                                            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-white/35">Next Step</p>
                                        </div>
                                        <span className="text-[10px] font-black uppercase tracking-[0.22em] text-white/40">
                                            {walletTalliedPositions.length}/{walletPositions.length} tallied
                                        </span>
                                    </div>
                                    <p className="mt-3 text-sm leading-relaxed text-white/60">
                                        {marketReadyToFinalize
                                            ? "The tally window is closed. The backend will finalize this market automatically."
                                            : `All of your positions are tallied. Auto-finalization starts in ${tallyCountdown}.`}
                                    </p>
                                    <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 border-t border-white/6 pt-4 text-sm">
                                        <div>
                                            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/25">Tally Deadline</p>
                                            <p className="mt-1 font-semibold text-white">{formatCompactTimestamp(market.tallyDeadline)}</p>
                                        </div>
                                        <div>
                                            <p className="text-[9px] font-black uppercase tracking-[0.22em] text-white/25">Countdown</p>
                                            <p className="mt-1 font-semibold text-white">{marketReadyToFinalize ? "Ready now" : tallyCountdown}</p>
                                        </div>
                                    </div>
                                </div>
                            ) : null}

                            {market.resolved ? (
                                <div className={`rounded-2xl border p-5 ${
                                    market.outcome === "YES"
                                        ? "border-emerald-500/15 bg-emerald-500/5"
                                        : "border-red-500/15 bg-red-500/5"
                                }`}>
                                    <div className="mb-4 flex items-center gap-2">
                                        <ShieldCheck className={`h-4 w-4 ${market.outcome === "YES" ? "text-emerald-300" : "text-red-300"}`} />
                                        <p className={`text-[10px] font-black uppercase tracking-[0.22em] ${
                                            market.outcome === "YES" ? "text-emerald-200/80" : "text-red-200/80"
                                        }`}>
                                            Settlement Data
                                        </p>
                                    </div>
                                    <div className="grid grid-cols-2 gap-x-6 gap-y-4">
                                        <div>
                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Outcome</p>
                                            <p className="text-base font-semibold text-white">{market.outcome}</p>
                                        </div>
                                        <div>
                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Settled</p>
                                            <p className="text-sm font-semibold text-white">{formatCompactTimestamp(market.settledAt)}</p>
                                        </div>
                                        <div>
                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Distributable Pot</p>
                                            <p className="text-base font-semibold text-white">{formatUsdc(market.distributablePot)}</p>
                                        </div>
                                        <div>
                                            <p className="mb-1.5 text-[9px] font-black uppercase tracking-[0.22em] text-white/20">Winning Total</p>
                                            <p className="text-base font-semibold text-white">{formatUsdc(market.winningSideTotal)}</p>
                                        </div>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </div>
                </div>

                <div className="space-y-6">
                    <div className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-5 sm:p-8 rounded-2xl sm:rounded-3xl">
                        <div className="flex items-center gap-3 mb-8">
                            <Scale className="w-5 h-5 text-white/60" />
                            <h2 className="text-xl font-bold text-white">Execution Commit</h2>
                        </div>

                        <div className="space-y-6">
                            <div className="space-y-4">
                                <div className="p-4 rounded-2xl bg-white/5 border border-white/10">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
                                            You Pay
                                        </span>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest">
                                                Balance: {formatUsdc(usdcBalance)}
                                            </span>
                                            <button
                                                type="button"
                                                onClick={handleSetMaxCommitAmount}
                                                className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-1 text-[9px] font-black uppercase tracking-[0.2em] text-white/70 transition-colors hover:bg-white/[0.09] hover:text-white"
                                            >
                                                Max
                                            </button>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-0">
                                        <input
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            placeholder="10"
                                            value={commitAmountUsdc}
                                            onChange={(event) => setCommitAmountUsdc(event.target.value)}
                                            className="bg-transparent border-none text-xl sm:text-2xl font-bold text-white focus:outline-none flex-1 w-full min-w-0 appearance-none [moz-appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
                                        />
                                        <div className="bg-white/10 px-3 py-1.5 rounded-xl flex items-center gap-2 shrink-0">
                                            <div className="w-5 h-5 rounded-full bg-white/15 flex items-center justify-center text-[10px] font-black text-white">U</div>
                                            <span className="text-sm font-bold text-white">USDC</span>
                                        </div>
                                    </div>
                                </div>

                                <div className="flex justify-center -my-3 relative z-10">
                                    <div className="w-8 h-8 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center text-white/40 shadow-lg shrink-0">
                                        <ArrowUpDown className="w-4 h-4" />
                                    </div>
                                </div>

                                <div className="p-4 rounded-2xl bg-white/5 border border-white/10 overflow-hidden">
                                    <div className="flex justify-between items-center mb-2">
                                        <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest whitespace-nowrap">
                                            You Buy
                                        </span>
                                        <span className="text-[10px] font-bold text-white/40 uppercase tracking-widest whitespace-nowrap ml-2">
                                            Range: {formatUsdc(market.minBet)} to {formatUsdc(market.maxBet)}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-4 min-w-0">
                                        <div className="text-xl sm:text-2xl font-bold text-white/90 flex-1 truncate min-w-0">
                                            {commitAmountUsdc || "0.00"}
                                        </div>
                                        <div className="flex items-center gap-2 shrink-0">
                                            <button
                                                type="button"
                                                onClick={() => setCommitSide(commitSide === "YES" ? "NO" : "YES")}
                                                className={`inline-flex items-center gap-2 rounded-xl border px-3 py-1.5 font-bold uppercase text-[10px] transition-colors ${
                                                    commitSide === "YES"
                                                        ? "bg-violet-500/10 border-violet-500/20 text-violet-300"
                                                        : "bg-red-500/10 border-red-500/20 text-red-300"
                                                }`}
                                            >
                                                <span>{commitSide}</span>
                                                <span className="text-white/35">Position</span>
                                                <ArrowUpDown className="h-3.5 w-3.5 text-white/45" />
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-3 px-2">
                                <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-widest">
                                    <span className="text-white/20">Privacy</span>
                                    <span className="text-violet-300">Hidden Onchain</span>
                                </div>
                                <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-widest">
                                    <span className="text-white/20">Commitment Type</span>
                                    <span className={commitSide === "YES" ? "text-violet-300" : "text-red-300"}>{commitSide} Position</span>
                                </div>
                            </div>

                            <button
                                onClick={() => {
                                    if (!authenticated) {
                                        void login();
                                        return;
                                    }
                                    void handleOpenCommitReview();
                                }}
                                disabled={busy === "commit" || busy === "commit-submit"}
                                className="w-full py-5 rounded-2xl text-sm font-black uppercase tracking-[0.2em] transition-all shadow-xl hover:-translate-y-1 active:scale-95 flex items-center justify-center gap-2 disabled:opacity-50 disabled:translate-y-0 disabled:active:scale-100 bg-violet-500 text-white hover:bg-violet-400"
                            >
                                {busy === "commit" ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Preparing Review...
                                    </>
                                ) : busy === "commit-submit" ? (
                                    <>
                                        <Loader2 className="w-4 h-4 animate-spin" />
                                        Submitting Order...
                                    </>
                                ) : !authenticated ? "Connect Wallet" : `Execute ${commitSide} Order`}
                            </button>

                            {commitError && !isCommitReviewOpen ? (
                                <p className="text-[10px] font-bold text-red-500 bg-red-500/10 border border-red-500/20 p-3 rounded-xl text-center">
                                    {commitError}
                                </p>
                            ) : null}
                        </div>
                    </div>

                    <div className="bg-white/[0.02] border border-white/5 p-6 rounded-3xl">
                        <div className="mb-4 flex items-center justify-between gap-3">
                            <h4 className="text-[10px] font-bold text-white/20 uppercase tracking-[0.2em]">Global Sentiment</h4>
                            {!market.resolved ? (
                                <InlineHint text="During the live market, side totals and odds stay hidden to protect trader privacy. The app only reveals settlement data after resolution." />
                            ) : null}
                        </div>
                        <div className="space-y-4">
                            {market.resolved ? (
                                <div className="w-full h-2 bg-white/5 rounded-full overflow-hidden flex">
                                    <div className="h-full bg-emerald-500/40" style={{ width: `${market.outcome === "YES" ? 100 : 0}%` }} />
                                    <div className="h-full bg-red-500/40" style={{ width: `${market.outcome === "NO" ? 100 : 0}%` }} />
                                </div>
                            ) : (
                                <div className="relative flex h-10 items-center justify-center overflow-hidden rounded-full border border-violet-500/20 bg-violet-500/10">
                                    <div className="absolute inset-0 bg-[linear-gradient(90deg,rgba(168,85,247,0.14),rgba(139,92,246,0.22),rgba(168,85,247,0.14))]" />
                                    <div className="relative inline-flex items-center gap-2 text-violet-200/85">
                                        <LockKeyhole className="h-4 w-4" />
                                        <span className="text-[10px] font-black uppercase tracking-[0.22em]">Market sentiment is hidden until settlement</span>
                                    </div>
                                </div>
                            )}
                            {market.resolved ? (
                                <div className="flex justify-between text-[10px] font-bold uppercase tracking-widest">
                                    <span className="text-emerald-400/60">{`${market.outcome === "YES" ? 100 : 0}% YES WON`}</span>
                                    <span className="text-red-400/60">{`${market.outcome === "NO" ? 100 : 0}% NO WON`}</span>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="bg-[#121214]/60 backdrop-blur-xl border border-white/5 p-5 sm:p-8 rounded-2xl sm:rounded-3xl">
                        <div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                                <Trophy className="w-5 h-5 text-white/60" />
                                <h2 className="text-xl font-bold text-white">Claim Winnings</h2>
                            </div>
                            {claimablePositions.length > 1 ? (
                                <button
                                    onClick={() => void handleClaimAll()}
                                    disabled={busy === "claim-batch"}
                                    className="inline-flex h-11 items-center justify-center rounded-xl border border-emerald-500/20 bg-emerald-500/10 px-4 text-[11px] font-black uppercase tracking-[0.18em] text-emerald-100 transition-colors hover:bg-emerald-500/15 disabled:opacity-60"
                                >
                                    {busy === "claim-batch" ? "Claiming all..." : `Claim all ${claimablePositions.length}`}
                                </button>
                            ) : null}
                        </div>

                        <div className="space-y-4">
                            {claimablePositions.length === 0 ? (
                                <div className="rounded-2xl border border-white/5 bg-white/[0.02] p-5 text-sm text-white/55">
                                    {market.resolved
                                        ? "No claimable winning commitments found for this wallet."
                                        : "Claims unlock after the market resolves and the winning aggregate is published."}
                                </div>
                            ) : (
                                claimablePositions.map((position) => {
                                    const payout = payoutForPosition(market, BigInt(position.amountInStroops));
                                    return (
                                        <div key={position.commitment} className="rounded-2xl border border-white/5 bg-white/[0.02] p-5">
                                            <div className="flex items-center justify-between gap-3 mb-4">
                                                <span className="text-[10px] uppercase tracking-[0.22em] text-white/30 font-black">Winning commitment</span>
                                                <span className="text-sm font-black text-white">{formatUsdc(payout)}</span>
                                            </div>
                                            <p className="text-[11px] text-white/35 font-mono break-all mb-4">
                                                {position.commitment}
                                            </p>
                                            <button
                                                onClick={() => void handleClaim(position)}
                                                disabled={busy === position.commitment}
                                                className="w-full rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-[10px] uppercase tracking-[0.22em] font-black text-emerald-200 hover:bg-emerald-500/15 transition-colors disabled:opacity-60"
                                            >
                                                {busy === position.commitment ? "Claiming..." : "Generate Claim Proof"}
                                            </button>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>



                    {status ? (
                        <div className="rounded-3xl border border-white/5 bg-white/[0.02] p-5">
                            <p className="text-sm leading-relaxed text-white/70">
                                {status}
                            </p>
                        </div>
                    ) : null}
                </div>
            </div>

            {isCommitReviewOpen ? (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-4 py-4 backdrop-blur-md">
                    <div className="relative max-h-[88vh] w-full max-w-[760px] overflow-y-auto rounded-[28px] border border-white/10 bg-[#0b0b0e] shadow-[0_32px_120px_rgba(0,0,0,0.55)]">
                        <button
                            type="button"
                            onClick={() => {
                                if (busy === "commit-submit") {
                                    return;
                                }
                                resetCommitReview();
                            }}
                            className="absolute right-5 top-5 z-10 rounded-full border border-white/10 bg-white/[0.03] p-2 text-white/50 transition-colors hover:text-white"
                        >
                            <X className="h-4 w-4" />
                        </button>

                        <div className="space-y-4 p-4 sm:p-5">
                            <div>
                                <p className="text-[10px] font-black text-white/40 uppercase tracking-[0.22em] mb-2">Review & Launch</p>
                                <h3 className="text-lg font-black text-white tracking-tight">{commitTxHash ? "Transaction confirmed" : "Approve transaction"}</h3>
                                <p className="mt-1 text-sm text-white/50">
                                    {commitTxHash
                                        ? "Your private order is committed on Stellar. You can inspect the transaction or close this receipt."
                                        : `Review the order before signing on ${currentNetworkLabel()}.`}
                                </p>
                            </div>

                            <div className="rounded-[24px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-4">
                                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/35">Signing Wallet</p>
                                        <div className="group relative mt-1 inline-flex max-w-full">
                                            <p className="text-sm font-semibold text-white">
                                                {walletPublic ? shortenAddress(walletPublic) : "Wallet not connected"}
                                            </p>
                                            {walletPublic ? (
                                                <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-max max-w-[18rem] rounded-xl border border-white/10 bg-[#0d0d10] px-3 py-2 text-[11px] font-medium tracking-normal text-white/70 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100">
                                                    {walletPublic}
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>
                                    <div className="inline-flex items-center gap-2 self-start rounded-full border border-violet-500/20 bg-violet-500/10 px-3 py-1">
                                        <span className="h-2 w-2 rounded-full bg-violet-300" />
                                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-200">{isTestnet ? "Testnet" : "Mainnet"}</span>
                                    </div>
                                </div>

                                <div className="mt-3 grid grid-cols-2 gap-2.5">
                                    <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Available XLM</p>
                                        <p className="mt-1.5 text-lg font-semibold text-white">{formatDecimalAmount(xlmSpendableBalance, 4)} XLM</p>
                                    </div>
                                    <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Available USDC</p>
                                        <p className="mt-1.5 text-lg font-semibold text-white">{formatUsdc(usdcBalance)}</p>
                                    </div>
                                </div>

                                <div className="mt-3 border-t border-white/8 pt-3">
                                    <div className="flex items-start justify-between gap-4">
                                        <div className="min-w-0">
                                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Order</p>
                                            <h4 className="mt-1.5 text-base font-black leading-tight text-white break-words">
                                                Commit {preparedCommit?.amountUsdc ?? commitAmountUsdc} USDC
                                            </h4>
                                        </div>
                                        <div className={`shrink-0 rounded-full border px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${preparedCommit?.side === "YES" ? "border-violet-500/20 bg-violet-500/10 text-violet-300" : "border-red-500/20 bg-red-500/10 text-red-300"}`}>
                                            {preparedCommit?.side ?? commitSide}
                                        </div>
                                    </div>
                                </div>

                                <div className="mt-3 border-t border-white/8 pt-3">
                                    <div className="grid grid-cols-2 gap-2.5">
                                        <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Network Fee</p>
                                            <p className="mt-1.5 text-base font-semibold text-white">
                                                {isEstimatingCommitFee ? "Estimating..." : estimatedCommitFeeXlm ? `${formatDecimalAmount(estimatedCommitFeeXlm, 7)} XLM` : "Unavailable"}
                                            </p>
                                        </div>
                                        <div className="rounded-2xl border border-white/6 bg-black/20 p-3">
                                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Range</p>
                                            <p className="mt-1.5 text-base font-semibold text-white">{formatUsdc(market.minBet)} to {formatUsdc(market.maxBet)}</p>
                                        </div>
                                    </div>
                                </div>

                                {hasInsufficientFeeBalance ? (
                                    <div className="mt-3 rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3">
                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                            <p className="text-[11px] text-amber-200">
                                                Your wallet can spend about {formatDecimalAmount(xlmSpendableBalance)} XLM after Stellar reserve, but this transaction currently needs about {formatDecimalAmount(estimatedCommitFeeXlm)} XLM.
                                            </p>
                                            {isTestnet ? (
                                                <button
                                                    onClick={() => void handleGetFunds()}
                                                    disabled={isFundingWallet}
                                                    className="h-10 shrink-0 rounded-xl border border-amber-400/20 bg-amber-300/90 px-4 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-amber-200 disabled:opacity-70"
                                                >
                                                    {isFundingWallet ? "Funding..." : "Get Funds"}
                                                </button>
                                            ) : null}
                                        </div>
                                    </div>
                                ) : null}

                            </div>

                            {commitTxHash ? (
                                <div className="rounded-[24px] border border-emerald-500/20 bg-[linear-gradient(180deg,rgba(16,185,129,0.14),rgba(255,255,255,0.02))] p-6 sm:p-7">
                                    <div className="flex flex-col items-center text-center">
                                        <div className="flex h-16 w-16 items-center justify-center rounded-full border border-emerald-400/30 bg-emerald-500/12 shadow-[0_0_40px_rgba(16,185,129,0.16)]">
                                            <Check className="h-8 w-8 text-emerald-300" />
                                        </div>
                                        <p className="mt-5 text-[10px] font-black uppercase tracking-[0.22em] text-emerald-300/70">Transaction Confirmed</p>
                                        <h4 className="mt-2 text-xl font-black tracking-tight text-white">Order committed successfully</h4>
                                        <p className="mt-2 max-w-md text-sm text-white/50">
                                            Your hidden {preparedCommit?.side?.toLowerCase()} commitment is now locked onchain and will stay private until settlement.
                                        </p>

                                        <div className="mt-6 w-full max-w-2xl rounded-2xl border border-white/8 bg-black/20 p-4 text-left">
                                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Transaction Hash</p>
                                            <p className="mt-2 text-sm font-mono text-white break-all">{commitTxHash}</p>
                                        </div>

                                        <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                                            <a
                                                href={explorerTransactionUrl(commitTxHash)}
                                                target="_blank"
                                                rel="noreferrer"
                                                className="h-11 px-5 bg-white text-black rounded-xl font-bold text-[11px] uppercase tracking-[0.18em] hover:bg-emerald-50 active:scale-[0.99] transition-all flex items-center justify-center gap-2"
                                            >
                                                View Explorer
                                                <ExternalLink className="h-3.5 w-3.5" />
                                            </a>
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    {commitReviewError ? (
                                        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
                                            <p className="text-[11px] text-red-300">{commitReviewError}</p>
                                        </div>
                                    ) : null}

                                    <div className="flex items-center justify-end gap-3">
                                        <button
                                            type="button"
                                            onClick={() => resetCommitReview()}
                                            disabled={busy === "commit-submit"}
                                            className="h-10 rounded-xl border border-white/10 px-5 text-[11px] font-black uppercase tracking-[0.18em] text-white/70 transition-colors hover:bg-white/[0.05] disabled:opacity-60"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => void handleCommit()}
                                            disabled={busy === "commit-submit" || isEstimatingCommitFee || hasInsufficientFeeBalance || !preparedCommit}
                                            className="h-10 rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition-all hover:bg-violet-50 disabled:opacity-60"
                                        >
                                            {busy === "commit-submit" ? "Submitting..." : "Approve Transaction"}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            ) : null}
        </motion.div>
    );
}
