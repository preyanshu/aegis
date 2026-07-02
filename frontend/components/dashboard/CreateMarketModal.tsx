"use client";

import { useEffect, useMemo, useState } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useCreateWallet, useSignRawHash } from "@privy-io/react-auth/extended-chains";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowRight, Check, Info, Loader2, Sparkles, Wand2, Wallet, X } from "lucide-react";
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from "@/lib/privy-stellar-wallet";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TRUSTED_DATA_SOURCES } from "@/lib/data-sources";
import { createMarketWithPrivyWallet, estimateCreateMarketFee, fundStellarTestnetAddress, getBrowserConfig, getPrivyStellarWallet, loadLatestLedgerTimestamp, loadReflectorPrice, loadStellarNativeBalanceSummary, loadUsdcBalance } from "@/lib/stellar";

interface CreateMarketModalProps {
    isOpen: boolean;
    onClose: () => void;
    onCreated?: () => Promise<void> | void;
}

type DraftCondition = {
    assetSymbol: string;
    oracleContract: string;
    comparator: "gte" | "lte";
    threshold: string;
    joinWithNext: "AND" | "OR";
};

type AiMarketDraft = {
    question: string;
    category: "macro" | "crypto" | "eth-related" | "fx" | "commodities";
    resolutionDateTime: string;
    minBet: string;
    maxBet: string;
    feeBps: string;
    conditions: Array<{
        assetSymbol: string;
        comparator: "gte" | "lte";
        threshold: string;
        joinWithNext?: "AND" | "OR";
    }>;
    assumptions?: string[];
};

type LivePriceMap = Record<string, Awaited<ReturnType<typeof loadReflectorPrice>>>;

const CATEGORY_OPTIONS = ["macro", "crypto", "eth-related", "fx", "commodities"];
const TOTAL_STEPS = 5;
const USDC_DECIMALS = 7;
const XLM_DECIMALS = 7;
const DEFAULT_FEE_BPS = "200";

function unixToLocalDateTime(timestamp: string) {
    const date = new Date(Number(timestamp) * 1000);
    const timezoneOffset = date.getTimezoneOffset() * 60_000;
    return new Date(date.getTime() - timezoneOffset).toISOString().slice(0, 16);
}

function localDateTimeToUnix(value: string) {
    return Math.floor(new Date(value).getTime() / 1000).toString();
}

function decimalToStroops(value: string, decimals = USDC_DECIMALS) {
    const normalized = value.trim();
    if (!normalized) {
        return BigInt(0);
    }

    const [wholePart, fractionPart = ""] = normalized.split(".");
    const safeWhole = wholePart === "" ? "0" : wholePart;
    const paddedFraction = `${fractionPart.replace(/\D/g, "")}${"0".repeat(decimals)}`.slice(0, decimals);
    return BigInt(`${safeWhole}${paddedFraction}`);
}

function decimalToScaledBigInt(value: string, decimals: number) {
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

function stroopsToDecimal(value: string, decimals = USDC_DECIMALS) {
    const amount = BigInt(value);
    const negative = amount < 0n;
    const absolute = negative ? -amount : amount;
    const base = 10n ** BigInt(decimals);
    const whole = absolute / base;
    const fraction = (absolute % base).toString().padStart(decimals, "0").replace(/0+$/, "");
    return `${negative ? "-" : ""}${whole.toString()}${fraction ? `.${fraction}` : ""}`;
}

function formatUsdcInput(value: string) {
    const numeric = Number.parseFloat(value);
    if (Number.isNaN(numeric)) {
        return value;
    }
    return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits: 7,
    }).format(numeric);
}

function formatXlmAmount(value: string, maximumFractionDigits = XLM_DECIMALS) {
    const numeric = Number.parseFloat(value);
    if (Number.isNaN(numeric)) {
        return value;
    }
    return new Intl.NumberFormat("en-US", {
        minimumFractionDigits: 0,
        maximumFractionDigits,
    }).format(numeric);
}

function explorerTransactionUrl(hash: string) {
    const passphrase = getBrowserConfig().networkPassphrase;
    const networkSegment = passphrase.includes("Test") ? "testnet" : "public";
    return `https://stellar.expert/explorer/${networkSegment}/tx/${hash}`;
}

function currentNetworkLabel() {
    if (typeof window === "undefined") {
        return "Stellar Testnet";
    }
    const passphrase = getBrowserConfig().networkPassphrase;
    return passphrase.includes("Test") ? "Stellar Testnet" : "Stellar Mainnet";
}

function shortenAddress(address: string, leading = 6, trailing = 4) {
    if (address.length <= leading + trailing + 3) {
        return address;
    }
    return `${address.slice(0, leading)}...${address.slice(-trailing)}`;
}

function defaultDraftCondition(): DraftCondition {
    const source = TRUSTED_DATA_SOURCES[0];
    return {
        assetSymbol: source.ticker,
        oracleContract: source.oracleContract,
        comparator: "gte",
        threshold: source.price,
        joinWithNext: "AND",
    };
}

function randomMarketId() {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    bytes[0] = 0;
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function deadlineFromQuestion(question: string) {
    const lower = question.toLowerCase();
    const now = new Date();
    if (lower.includes("tomorrow")) {
        return Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000).toString();
    }
    if (lower.includes("this week") || lower.includes("friday")) {
        return Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000).toString();
    }
    if (lower.includes("this month") || lower.includes("month")) {
        return Math.floor((Date.now() + 30 * 24 * 60 * 60 * 1000) / 1000).toString();
    }
    if (lower.includes("this year") || lower.includes("year")) {
        return Math.floor((Date.now() + 180 * 24 * 60 * 60 * 1000) / 1000).toString();
    }
    if (lower.includes("today")) {
        const end = new Date(now);
        end.setHours(23, 59, 0, 0);
        return Math.floor(end.getTime() / 1000).toString();
    }
    return Math.floor((Date.now() + 7 * 24 * 60 * 60 * 1000) / 1000).toString();
}

function guessCategory(question: string, ticker: string) {
    const lower = question.toLowerCase();
    if (["BTC", "SOL", "XRP", "ADA", "LINK", "ATOM", "XLM"].includes(ticker)) {
        return "crypto";
    }
    if (ticker === "ETH") {
        return lower.includes("ecosystem") || lower.includes("eth") ? "eth-related" : "crypto";
    }
    if (["EUR", "GBP", "CHF", "CAD", "MXN", "ARS", "BRL", "THB", "EURC"].includes(ticker)) {
        return "fx";
    }
    if (["XAU"].includes(ticker)) {
        return "commodities";
    }
    if (lower.includes("macro") || lower.includes("inflation") || lower.includes("fed")) {
        return "macro";
    }
    return "macro";
}

function inferComparator(question: string) {
    const lower = question.toLowerCase();
    if (lower.includes("below") || lower.includes("under") || lower.includes("less than") || lower.includes("stay under")) {
        return "lte" as const;
    }
    return "gte" as const;
}

function inferTicker(question: string) {
    const upper = question.toUpperCase();
    return TRUSTED_DATA_SOURCES.find((source) => upper.includes(source.ticker)) ?? TRUSTED_DATA_SOURCES[0];
}

function inferThreshold(question: string, sourcePrice: string) {
    const match = question.match(/(?:\$|USD\s*)?([0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?)/i);
    if (match) {
        return match[1].replace(/,/g, "");
    }
    return sourcePrice;
}

function normalizeDraftConditionFromAi(condition: AiMarketDraft["conditions"][number], index: number): DraftCondition {
    const source = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === condition.assetSymbol);
    if (!source) {
        throw new Error(`AI selected unsupported asset ${condition.assetSymbol} for condition ${index + 1}.`);
    }

    return {
        assetSymbol: source.ticker,
        oracleContract: source.oracleContract,
        comparator: condition.comparator,
        threshold: condition.threshold,
        joinWithNext: condition.joinWithNext === "OR" ? "OR" : "AND",
    };
}

function formatTimestamp(timestamp: string) {
    return new Date(Number(timestamp) * 1000).toLocaleString();
}

function FieldHint({
    label,
    text,
}: {
    label: string;
    text: string;
}) {
    return (
        <div className="group relative inline-flex items-center gap-1.5">
            <span>{label}</span>
            <span className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-white/10 bg-white/[0.04] text-white/35 transition-colors group-hover:text-white/70 group-hover:border-white/20">
                <Info className="h-2.5 w-2.5" />
            </span>
            <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-56 rounded-xl border border-white/10 bg-[#0d0d10] px-3 py-2 text-[11px] font-medium normal-case tracking-normal text-white/70 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100">
                {text}
            </div>
        </div>
    );
}

function LogicPreview({
    conditions,
    tone = "neutral",
}: {
    conditions: DraftCondition[];
    tone?: "neutral" | "accent";
}) {
    const comparatorClassName = tone === "accent"
        ? "border-fuchsia-400/20 bg-fuchsia-500/10 text-fuchsia-200"
        : "border-white/10 bg-white/[0.05] text-white";
    const valueClassName = tone === "accent"
        ? "border-violet-400/15 bg-violet-500/[0.1] text-violet-100"
        : "border-white/10 bg-black/20 text-white/85";

    return (
        <div className="space-y-3">
            {conditions.map((condition, index) => (
                <div key={`${condition.assetSymbol}-logic-${index}`} className="space-y-3">
                    {index > 0 ? (
                        <div className="flex items-center gap-3">
                            <div className="h-px flex-1 bg-white/6" />
                            <span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-white/45">
                                {conditions[index - 1]?.joinWithNext}
                            </span>
                            <div className="h-px flex-1 bg-white/6" />
                        </div>
                    ) : null}

                    <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 font-black text-white">
                            {condition.assetSymbol}
                        </span>
                        <span className={`rounded-full px-3 py-1.5 font-mono font-black border ${comparatorClassName}`}>
                            {condition.comparator === "gte" ? ">=" : "<="}
                        </span>
                        <span className={`rounded-2xl px-3.5 py-1.5 font-mono font-black border ${valueClassName}`}>
                            {condition.threshold}
                        </span>
                    </div>
                </div>
            ))}
        </div>
    );
}

export function CreateMarketModal({ isOpen, onClose, onCreated }: CreateMarketModalProps) {
    const { user, authenticated } = usePrivy();
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
    const stellarWalletAddress = stellarWallet?.address ?? null;
    const [step, setStep] = useState(1);
    const [question, setQuestion] = useState("Will BTC remain above $50,000 by expiry?");
    const [category, setCategory] = useState("macro");
    const [draftConditions, setDraftConditions] = useState<DraftCondition[]>([defaultDraftCondition()]);
    const [endTimestamp, setEndTimestamp] = useState(() => Math.floor(Date.now() / 1000 + 7 * 24 * 60 * 60).toString());
    const [resolutionDateTime, setResolutionDateTime] = useState(() => unixToLocalDateTime(Math.floor(Date.now() / 1000 + 7 * 24 * 60 * 60).toString()));
    const [minBet, setMinBet] = useState(() => stroopsToDecimal("10000000"));
    const [maxBet, setMaxBet] = useState(() => stroopsToDecimal("250000000"));
    const [feeBps, setFeeBps] = useState(DEFAULT_FEE_BPS);
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [isMagicLoading, setIsMagicLoading] = useState(false);
    const [livePrices, setLivePrices] = useState<LivePriceMap>({});
    const [loadingAssets, setLoadingAssets] = useState<Record<string, boolean>>({});
    const [xlmBalance, setXlmBalance] = useState<string>("0");
    const [xlmSpendableBalance, setXlmSpendableBalance] = useState<string>("0");
    const [xlmMinimumBalance, setXlmMinimumBalance] = useState<string>("0");
    const [walletBalance, setWalletBalance] = useState<string>("0");
    const [estimatedFeeXlm, setEstimatedFeeXlm] = useState<string>("");
    const [isEstimatingFee, setIsEstimatingFee] = useState(false);
    const [isFundingWallet, setIsFundingWallet] = useState(false);
    const [createdTxHash, setCreatedTxHash] = useState<string | null>(null);
    const [error, setError] = useState("");

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
                console.warn("Privy Stellar wallet limit reached for this user.");
                return;
            }
            console.error("Failed to create Privy Stellar wallet:", creationError);
        });
    }, [authenticated, createWallet, stellarWallet]);

    useEffect(() => {
        if (!stellarWalletAddress || !isOpen) {
            return;
        }

        let cancelled = false;
        const loadBalance = async () => {
            try {
                await refreshWalletBalances(stellarWalletAddress);
            } catch (balanceError) {
                console.error("Failed to load USDC balance for review step:", balanceError);
                if (!cancelled) {
                    setWalletBalance("0");
                    setXlmBalance("0");
                    setXlmSpendableBalance("0");
                    setXlmMinimumBalance("0");
                }
            }
        };

        void loadBalance();
        return () => {
            cancelled = true;
        };
    }, [isOpen, stellarWalletAddress]);

    const hasInsufficientFeeBalance = useMemo(() => {
        if (!estimatedFeeXlm) {
            return false;
        }

        try {
            return decimalToStroops(xlmSpendableBalance, XLM_DECIMALS) < decimalToStroops(estimatedFeeXlm, XLM_DECIMALS);
        } catch {
            return false;
        }
    }, [estimatedFeeXlm, xlmSpendableBalance]);

    const isTestnet = useMemo(() => currentNetworkLabel() === "Stellar Testnet", []);

    async function refreshWalletBalances(address: string) {
        const [balance, nativeBalance] = await Promise.all([
            loadUsdcBalance(address),
            loadStellarNativeBalanceSummary(address),
        ]);
        setWalletBalance(stroopsToDecimal(balance.toString()));
        setXlmBalance(nativeBalance.balance);
        setXlmSpendableBalance(nativeBalance.spendableBalance);
        setXlmMinimumBalance(nativeBalance.minimumBalance);
    }

    useEffect(() => {
        if (!isOpen) {
            return;
        }

        const uniqueSources = Array.from(new Set(draftConditions.map((condition) => condition.assetSymbol)))
            .map((assetSymbol) => TRUSTED_DATA_SOURCES.find((source) => source.ticker === assetSymbol))
            .filter((source): source is NonNullable<typeof source> => Boolean(source));

        uniqueSources.forEach((source) => {
            if (livePrices[source.ticker] !== undefined || loadingAssets[source.ticker]) {
                return;
            }

            setLoadingAssets((current) => ({ ...current, [source.ticker]: true }));
            void loadReflectorPrice(source.oracleContract, source.ticker)
                .then((price) => {
                    setLivePrices((current) => ({ ...current, [source.ticker]: price }));
                    if (price) {
                        setDraftConditions((current) => current.map((condition) => (
                            condition.assetSymbol === source.ticker && condition.threshold === source.price
                                ? { ...condition, threshold: price.formatted }
                                : condition
                        )));
                    }
                })
                .catch((loadError) => {
                    console.error(`Failed to load Reflector price for ${source.ticker}:`, loadError);
                    setLivePrices((current) => ({ ...current, [source.ticker]: null }));
                })
                .finally(() => {
                    setLoadingAssets((current) => ({ ...current, [source.ticker]: false }));
                });
        });
    }, [draftConditions, isOpen, livePrices, loadingAssets]);

    useEffect(() => {
        if (!isOpen || step !== 5 || !authenticated || !stellarWallet || !stellarWalletAddress) {
            return;
        }

        let cancelled = false;
        const estimateFee = async () => {
            setIsEstimatingFee(true);
            try {
                const oracleConditions = draftConditions.map((condition) => {
                    const livePrice = livePrices[condition.assetSymbol];
                    if (!livePrice) {
                        throw new Error(`Live Reflector metadata is unavailable for ${condition.assetSymbol}. Wait for the oracle feed to load and try again.`);
                    }

                    return {
                        oracle_contract: condition.oracleContract,
                        asset_symbol: condition.assetSymbol,
                        greater_or_equal: condition.comparator === "gte",
                        threshold: decimalToScaledBigInt(condition.threshold, livePrice.decimals),
                    };
                });

                const feeEstimate = await estimateCreateMarketFee(stellarWallet, {
                    marketId: randomMarketId(),
                    question,
                    category,
                    oracleConditions,
                    conditionOperators: draftConditions.slice(0, -1).map((condition) => condition.joinWithNext === "AND"),
                    endTimestamp: BigInt(endTimestamp),
                    minBet: decimalToStroops(minBet),
                    maxBet: decimalToStroops(maxBet),
                    feeBps: Number(feeBps),
                });

                if (!cancelled) {
                    setEstimatedFeeXlm(stroopsToDecimal(feeEstimate.totalFee.toString(), XLM_DECIMALS));
                }
            } catch (estimateError) {
                console.error("Failed to estimate market creation fee:", estimateError);
                if (!cancelled) {
                    setEstimatedFeeXlm("");
                }
            } finally {
                if (!cancelled) {
                    setIsEstimatingFee(false);
                }
            }
        };

        void estimateFee();
        return () => {
            cancelled = true;
        };
    }, [
        authenticated,
        category,
        draftConditions,
        endTimestamp,
        feeBps,
        isOpen,
        livePrices,
        maxBet,
        minBet,
        question,
        step,
        stellarWallet,
        stellarWalletAddress,
    ]);

    function reset() {
        setStep(1);
        setQuestion("Will BTC remain above $50,000 by expiry?");
        setCategory("macro");
        setDraftConditions([defaultDraftCondition()]);
        const defaultEndTimestamp = Math.floor(Date.now() / 1000 + 7 * 24 * 60 * 60).toString();
        setEndTimestamp(defaultEndTimestamp);
        setResolutionDateTime(unixToLocalDateTime(defaultEndTimestamp));
        setMinBet(stroopsToDecimal("10000000"));
        setMaxBet(stroopsToDecimal("250000000"));
        setFeeBps(DEFAULT_FEE_BPS);
        setIsSubmitting(false);
        setIsMagicLoading(false);
        setLivePrices({});
        setLoadingAssets({});
        setXlmBalance("0");
        setXlmSpendableBalance("0");
        setXlmMinimumBalance("0");
        setWalletBalance("0");
        setEstimatedFeeXlm("");
        setIsEstimatingFee(false);
        setIsFundingWallet(false);
        setCreatedTxHash(null);
        setError("");
    }

    function handleClose() {
        if (isSubmitting && !createdTxHash) {
            return;
        }
        // Reset state before closing to ensure modal fully cleans up
        reset();
        onClose();
    }

    async function handleGetFunds() {
        if (!stellarWalletAddress || !isTestnet) {
            return;
        }

        setIsFundingWallet(true);
        setError("");
        try {
            await fundStellarTestnetAddress(stellarWalletAddress);
            await refreshWalletBalances(stellarWalletAddress);
        } catch (fundingError) {
            setError(fundingError instanceof Error ? fundingError.message : String(fundingError));
        } finally {
            setIsFundingWallet(false);
        }
    }

    function updateCondition(index: number, next: Partial<DraftCondition>) {
        setDraftConditions((current) => current.map((condition, currentIndex) => (
            currentIndex === index ? { ...condition, ...next } : condition
        )));
    }

    function addCondition() {
        if (draftConditions.length >= 5) {
            return;
        }
        setDraftConditions((current) => [...current, defaultDraftCondition()]);
    }

    function removeCondition(index: number) {
        setDraftConditions((current) => current.filter((_, currentIndex) => currentIndex !== index));
    }

    async function handleMagic() {
        setIsMagicLoading(true);
        setError("");
        try {
            const currentLedgerTimestamp = await loadLatestLedgerTimestamp();
            const response = await fetch("/api/market-draft", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify({
                    prompt: question,
                    currentLedgerTimestamp,
                    browserTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                    browserUtcOffsetMinutes: new Date().getTimezoneOffset(),
                }),
            });
            const payload = await response.json().catch(() => null) as { draft?: AiMarketDraft; error?: string } | null;

            if (!response.ok || !payload?.draft) {
                throw new Error(payload?.error ?? "AI could not generate a resolvable market from that prompt.");
            }

            const draft = payload.draft;
            const nextConditions = draft.conditions.map(normalizeDraftConditionFromAi);
            const nextResolutionUnix = localDateTimeToUnix(draft.resolutionDateTime);

            setQuestion(draft.question);
            setCategory(draft.category);
            setDraftConditions(nextConditions);
            setResolutionDateTime(draft.resolutionDateTime);
            setEndTimestamp(nextResolutionUnix);
            setMinBet(draft.minBet);
            setMaxBet(draft.maxBet);
            setFeeBps(draft.feeBps || DEFAULT_FEE_BPS);
            setStep(5);
        } catch (magicError) {
            setError(magicError instanceof Error ? magicError.message : "Magic Fill could not build a market from that prompt.");
        } finally {
            setIsMagicLoading(false);
        }
    }

    async function handleSubmit() {
        if (!authenticated || !stellarWallet) {
            setError("Connect your Privy Stellar wallet before creating a market.");
            return;
        }

        if (isEstimatingFee) {
            setError("Still estimating the Stellar network fee. Give it a moment and try again.");
            return;
        }

        if (!estimatedFeeXlm) {
            setError("We could not estimate the Stellar network fee yet. Re-open the review step and try again.");
            return;
        }

        if (hasInsufficientFeeBalance) {
            setError(`Your wallet needs at least ${formatXlmAmount(estimatedFeeXlm)} XLM to cover this transaction fee.`);
            return;
        }

        setIsSubmitting(true);
        setError("");
        try {
            const marketId = randomMarketId();
            const result = await createMarketWithPrivyWallet(stellarWallet, signRawHash, {
                marketId,
                question,
                category,
                oracleConditions: draftConditions.map((condition) => {
                    const livePrice = livePrices[condition.assetSymbol];
                    if (!livePrice) {
                        throw new Error(`Live Reflector metadata is unavailable for ${condition.assetSymbol}. Wait for the oracle feed to load and try again.`);
                    }

                    return {
                        oracle_contract: condition.oracleContract,
                        asset_symbol: condition.assetSymbol,
                        greater_or_equal: condition.comparator === "gte",
                        threshold: decimalToScaledBigInt(condition.threshold, livePrice.decimals),
                    };
                }),
                conditionOperators: draftConditions.slice(0, -1).map((condition) => condition.joinWithNext === "AND"),
                endTimestamp: BigInt(endTimestamp),
                minBet: decimalToStroops(minBet),
                maxBet: decimalToStroops(maxBet),
                feeBps: Number(feeBps),
            });
            setCreatedTxHash(result.hash);
            setIsSubmitting(false);
            void Promise.resolve(onCreated?.()).catch((refreshError) => {
                console.warn("Market created, but dashboard refresh hit an error:", refreshError);
            });
            return;
        } catch (submitError) {
                setError(submitError instanceof Error ? submitError.message : String(submitError));
            } finally {
                setIsSubmitting(false);
            }
    }

    return (
        <AnimatePresence>
            {isOpen ? (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        onClick={handleClose}
                        className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                    />

                    <motion.div
                        initial={{ opacity: 0, scale: 0.98, y: 10 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98, y: 10 }}
                        className="relative flex w-full max-w-2xl max-h-[min(92vh,860px)] flex-col bg-[#0a0a0c] border border-white/10 rounded-2xl overflow-hidden shadow-2xl"
                    >
                        <div className="shrink-0 px-5 sm:px-8 py-5 sm:py-6 flex items-center justify-between border-b border-white/5">
                            <div className="flex items-center gap-4">
                                <button onClick={handleClose} className="p-1.5 -ml-1 text-white/20 hover:text-white transition-colors">
                                    <ArrowLeft className="w-4.5 h-4.5" />
                                </button>
                                <div>
                                    <h2 className="text-sm font-bold text-white uppercase tracking-widest mt-0.5">Create Private Market</h2>
                                    <p className="text-[10px] text-white/35 uppercase tracking-[0.22em] mt-2">Step {step} of {TOTAL_STEPS}</p>
                                </div>
                            </div>
                            <button onClick={handleClose} className="p-1.5 hover:bg-white/5 rounded-full transition-colors text-white/20 hover:text-white">
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="shrink-0 px-5 sm:px-8 pt-5 sm:pt-6">
                            <div className="grid grid-cols-5 gap-3">
                                {[1, 2, 3, 4, 5].map((currentStep) => (
                                    <div key={currentStep} className={`rounded-full h-1.5 transition-colors ${currentStep <= step ? "bg-fuchsia-400" : "bg-white/10"}`} />
                                ))}
                            </div>
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden custom-scrollbar p-5 sm:p-8 space-y-7">
                            {step === 1 ? (
                                <div className="space-y-8">
                                    <div className="rounded-3xl border border-violet-400/15 bg-violet-500/6 p-5 sm:p-6">
                                        <div className="flex items-start justify-between gap-4">
                                            <div>
                                                <p className="text-[10px] font-black text-fuchsia-200/70 uppercase tracking-[0.22em] mb-3">AI Magic</p>
                                                <h3 className="text-xl font-black text-white tracking-tight">Start from a question</h3>
                                                <p className="text-sm text-white/55 mt-3 leading-relaxed">
                                                    Fill the full market draft from a prompt, including category, exact resolution time, and up to 5 oracle conditions.
                                                </p>
                                            </div>
                                            <button
                                                onClick={() => void handleMagic()}
                                                disabled={isMagicLoading}
                                                className="shrink-0 flex h-12 items-center justify-center gap-2.5 rounded-xl border border-violet-400/20 bg-violet-500/14 px-5 text-xs font-bold uppercase tracking-[0.2em] text-violet-50 transition-all hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99] shadow-xl shadow-violet-950/30 disabled:opacity-70"
                                            >
                                                {isMagicLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                                                Magic Fill
                                            </button>
                                        </div>
                                    </div>

                                    <div className="space-y-3">
                                        <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">Market Question</label>
                                        <textarea
                                            value={question}
                                            onChange={(event) => setQuestion(event.target.value)}
                                            className="w-full min-h-28 sm:min-h-32 bg-white/[0.04] border border-white/10 rounded-xl p-4 sm:p-5 text-base text-white font-medium outline-none focus:border-white/30 focus:bg-white/[0.06] transition-all placeholder:text-white/10"
                                            placeholder="Will ETH close above $4,000 this month?"
                                        />
                                    </div>
                                </div>
                            ) : null}

                            {step === 2 ? (
                                <div className="space-y-8">
                                    <div>
                                        <p className="text-[10px] font-black text-white/40 uppercase tracking-[0.22em] mb-3">Market Basics</p>
                                        <h3 className="text-xl font-black text-white tracking-tight">Confirm creator and category</h3>
                                        <p className="text-sm text-white/55 mt-3">The creator wallet comes from the connected Privy account, while the category shapes reputation grouping later.</p>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                                        <div className="space-y-3">
                                            <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">Creator Wallet</label>
                                            <div className="flex h-9 w-full items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-sm shadow-xs">
                                                <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-violet-400/20 bg-violet-500/10 text-violet-200">
                                                    <Wallet className="h-3.5 w-3.5" />
                                                </span>
                                                <div className="min-w-0">
                                                    <p className="truncate text-sm font-medium text-white">
                                                        {stellarWallet?.address ? `${stellarWallet.address.slice(0, 6)}...${stellarWallet.address.slice(-4)}` : "No Stellar wallet connected"}
                                                    </p>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">Category</label>
                                            <Select value={category} onValueChange={setCategory}>
                                                <SelectTrigger className="w-full bg-white/[0.04] border-white/10 rounded-xl h-12 text-sm text-white font-medium">
                                                    <SelectValue placeholder="Select category" />
                                                </SelectTrigger>
                                                <SelectContent className="bg-[#0a0a0c] border-white/10">
                                                    {CATEGORY_OPTIONS.map((option) => (
                                                        <SelectItem key={option} value={option} className="text-white hover:bg-white/5 focus:bg-white/5 cursor-pointer capitalize">
                                                            {option}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        </div>
                                    </div>

                                    <div className="rounded-3xl border border-white/5 bg-white/[0.02] p-5 sm:p-6 space-y-3">
                                        <p className="text-[10px] text-white/30 uppercase font-black tracking-[0.2em]">Current Prompt</p>
                                        <p className="text-lg font-black text-white tracking-tight">{question}</p>
                                    </div>
                                </div>
                            ) : null}

                            {step === 3 ? (
                                <div className="space-y-6">
                                    <div className="flex items-start justify-between gap-4">
                                        <div>
                                            <p className="text-[10px] font-black text-white/40 uppercase tracking-[0.22em] mb-3">Condition Resolution</p>
                                            <h3 className="text-xl font-black text-white tracking-tight">Define oracle logic</h3>
                                            <p className="text-sm text-white/55 mt-3">Use up to five Reflector-backed checks and link them with AND / OR.</p>
                                        </div>
                                        <button
                                            onClick={addCondition}
                                            disabled={draftConditions.length >= 5}
                                            className="shrink-0 rounded-xl border border-dashed border-white/10 px-4 py-3 text-[10px] font-bold uppercase tracking-widest text-white/50 hover:border-violet-400/20 hover:text-violet-200 transition-all disabled:opacity-40"
                                        >
                                            <span className="inline-flex items-center gap-2">
                                                <Sparkles className="w-3.5 h-3.5" />
                                                Add Condition
                                            </span>
                                        </button>
                                    </div>

                                    <div className="hidden md:grid md:grid-cols-[minmax(0,1.5fr)_120px_180px_52px] gap-3 px-2">
                                        <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">
                                            <FieldHint
                                                label="Asset"
                                                text="Pick the Reflector-backed asset whose live price will drive this condition."
                                            />
                                        </p>
                                        <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">
                                            <FieldHint
                                                label="Rule"
                                                text="Choose whether the observed oracle value must end above or below the target."
                                            />
                                        </p>
                                        <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">
                                            <FieldHint
                                                label="Target"
                                                text="This is the numeric oracle threshold the market will resolve against."
                                            />
                                        </p>
                                        <div />
                                    </div>

                                    <div className="space-y-3">
                                        {draftConditions.map((condition, index) => {
                                            const selectedSource = TRUSTED_DATA_SOURCES.find((source) => source.ticker === condition.assetSymbol);
                                            const livePrice = livePrices[condition.assetSymbol];
                                            const isLivePriceLoading = loadingAssets[condition.assetSymbol];
                                            return (
                                                <div key={`${condition.assetSymbol}-${index}`} className="space-y-3">
                                                    {index > 0 ? (
                                                        <div className="flex items-center gap-2 py-1">
                                                            <div className="flex-1 h-px bg-white/5" />
                                                            <div className="flex gap-1">
                                                                {(["AND", "OR"] as const).map((connector) => (
                                                                    <button
                                                                        key={connector}
                                                                        onClick={() => updateCondition(index - 1, { joinWithNext: connector })}
                                                                        className={`px-4 py-1.5 rounded-md text-[10px] font-bold uppercase tracking-widest transition-all ${draftConditions[index - 1]?.joinWithNext === connector
                                                                            ? "border border-fuchsia-400/30 bg-fuchsia-500/10 text-fuchsia-200"
                                                                            : "bg-white/[0.02] border border-white/5 text-white/30 hover:text-white/60"
                                                                            }`}
                                                                    >
                                                                        {connector}
                                                                    </button>
                                                                ))}
                                                            </div>
                                                            <div className="flex-1 h-px bg-white/5" />
                                                        </div>
                                                    ) : null}

                                                    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1.5fr)_120px_180px_52px] items-stretch gap-3 p-3 sm:p-4 rounded-2xl bg-white/[0.02] border border-white/5">
                                                        <div className="min-w-0">
                                                            <div className="mb-2 flex items-center justify-between md:hidden">
                                                                <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">Asset</p>
                                                                {selectedSource ? (
                                                                    <span className="text-[10px] font-bold text-white/35 uppercase tracking-[0.18em]">
                                                                        {selectedSource.type}
                                                                    </span>
                                                                ) : null}
                                                            </div>
                                                            <Select
                                                                value={condition.assetSymbol}
                                                                onValueChange={(value) => {
                                                                    const source = TRUSTED_DATA_SOURCES.find((entry) => entry.ticker === value);
                                                                    updateCondition(index, {
                                                                        assetSymbol: value,
                                                                        oracleContract: source?.oracleContract ?? condition.oracleContract,
                                                                        threshold: livePrices[value]?.formatted ?? source?.price ?? condition.threshold,
                                                                    });
                                                                }}
                                                            >
                                                                <SelectTrigger className="w-full bg-black/20 border-white/10 rounded-xl h-14 text-sm text-white font-medium">
                                                                    <SelectValue placeholder="Select source" />
                                                                </SelectTrigger>
                                                                <SelectContent className="bg-[#0a0a0c] border-white/10">
                                                                    {TRUSTED_DATA_SOURCES.map((source) => (
                                                                        <SelectItem key={source.id} value={source.ticker} className="text-white hover:bg-white/5 focus:bg-white/5 cursor-pointer">
                                                                            <div className="flex items-center gap-2">
                                                                                {/* eslint-disable-next-line @next/next/no-img-element */}
                                                                                <img src={source.icon} className="w-4 h-4 object-contain" alt={source.ticker} />
                                                                                <span>{source.ticker}</span>
                                                                            </div>
                                                                        </SelectItem>
                                                                    ))}
                                                                </SelectContent>
                                                            </Select>
                                                            {selectedSource ? (
                                                                <div className="mt-3 rounded-xl border border-white/5 bg-black/20 px-3 py-2">
                                                                    <div className="flex items-center justify-between gap-3">
                                                                        <div>
                                                                            <p className="text-sm font-black text-white">{selectedSource.name}</p>
                                                                            <p className="text-[10px] uppercase tracking-[0.18em] text-white/30 font-bold mt-1">
                                                                                {selectedSource.group} · Oracle
                                                                            </p>
                                                                        </div>
                                                                        <div className="text-right">
                                                                            <div className="flex items-center justify-end gap-2">
                                                                                {isLivePriceLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-violet-200/70" /> : null}
                                                                                <p className="text-sm font-mono font-black text-violet-200">
                                                                                    {livePrice?.formatted ?? selectedSource.price}
                                                                                </p>
                                                                            </div>
                                                                            <p className="text-[10px] uppercase tracking-[0.18em] text-white/25 font-bold mt-1">
                                                                                {livePrice ? "Reflector Live" : "Fallback Ref"}
                                                                            </p>
                                                                        </div>
                                                                    </div>
                                                                </div>
                                                            ) : null}
                                                        </div>

                                                        <div>
                                                            <div className="mb-2 md:hidden">
                                                                <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">Rule</p>
                                                            </div>
                                                            <Select value={condition.comparator} onValueChange={(value: "gte" | "lte") => updateCondition(index, { comparator: value })}>
                                                                <SelectTrigger className="w-full bg-black/20 border-white/10 rounded-xl h-14 justify-center px-0 text-sm font-mono font-bold text-fuchsia-200">
                                                                    <SelectValue />
                                                                </SelectTrigger>
                                                                <SelectContent className="bg-[#0a0a0c] border-white/10">
                                                                    <SelectItem value="gte" className="font-mono text-fuchsia-200 hover:bg-white/5 focus:bg-white/5 cursor-pointer">&gt;=</SelectItem>
                                                                    <SelectItem value="lte" className="font-mono text-fuchsia-200 hover:bg-white/5 focus:bg-white/5 cursor-pointer">&lt;=</SelectItem>
                                                                </SelectContent>
                                                            </Select>
                                                            <p className="mt-3 text-[11px] text-white/35 leading-relaxed">
                                                                {condition.comparator === "gte"
                                                                    ? "Condition passes when the oracle prints at or above the target."
                                                                    : "Condition passes when the oracle prints at or below the target."}
                                                            </p>
                                                        </div>

                                                        <div>
                                                            <div className="mb-2 md:hidden">
                                                                <p className="text-[10px] font-black text-white/25 uppercase tracking-[0.22em]">Target</p>
                                                            </div>
                                                            <input
                                                                type="number"
                                                                value={condition.threshold}
                                                                onChange={(event) => updateCondition(index, { threshold: event.target.value })}
                                                                className="w-full bg-black/20 border border-white/10 rounded-xl h-14 px-4 text-sm font-mono text-white outline-none focus:border-white/20 transition-all placeholder:text-white/10"
                                                                placeholder={livePrice?.formatted ?? selectedSource?.price ?? "0"}
                                                            />
                                                            <p className="mt-3 text-[11px] text-white/35 leading-relaxed">
                                                                Use the quoted oracle unit for this asset. Defaulting to the current reference price is usually a good starting point.
                                                            </p>
                                                        </div>

                                                        <div className="flex items-start justify-end md:justify-center">
                                                            {draftConditions.length > 1 ? (
                                                                <button
                                                                    onClick={() => removeCondition(index)}
                                                                    className="w-12 h-12 shrink-0 flex items-center justify-center rounded-xl bg-red-500/5 border border-red-500/10 text-red-500/40 hover:text-red-400 hover:border-red-500/30 hover:bg-red-500/10 transition-all"
                                                                >
                                                                    <X className="w-4 h-4" />
                                                                </button>
                                                            ) : (
                                                                <div className="hidden md:block" />
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>

                                    <div className="rounded-2xl border border-violet-400/15 bg-[linear-gradient(180deg,rgba(168,85,247,0.08),rgba(255,255,255,0.01))] p-5">
                                        <div className="flex items-center justify-between gap-4 mb-4">
                                            <div>
                                                <p className="text-[9px] font-bold text-fuchsia-200/60 uppercase tracking-widest mb-2">Condition Preview</p>
                                                <h4 className="text-lg font-black text-white tracking-tight">How this market resolves</h4>
                                            </div>
                                            <div className="rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] text-violet-100">
                                                {draftConditions.length} rule{draftConditions.length > 1 ? "s" : ""}
                                            </div>
                                        </div>
                                        <div className="space-y-3">
                                            <LogicPreview conditions={draftConditions} tone="accent" />
                                        </div>
                                    </div>
                                </div>
                            ) : null}

                            {step === 4 ? (
                                <div className="space-y-8">
                                    <div>
                                        <p className="text-[10px] font-black text-white/40 uppercase tracking-[0.22em] mb-3">Settlement & Limits</p>
                                        <h3 className="text-xl font-black text-white tracking-tight">Finalize launch settings</h3>
                                        <p className="text-sm text-white/55 mt-3">Set expiry and collateral bounds here, then review everything in the final approval step.</p>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                                        <div className="space-y-3">
                                            <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">
                                                <FieldHint
                                                    label="Resolution Time"
                                                    text="Choose the exact local date and time when oracle resolution becomes eligible."
                                                />
                                            </label>
                                            <input
                                                type="datetime-local"
                                                value={resolutionDateTime}
                                                onChange={(event) => {
                                                    setResolutionDateTime(event.target.value);
                                                    setEndTimestamp(localDateTimeToUnix(event.target.value));
                                                }}
                                                className="w-full bg-white/[0.04] border border-white/10 rounded-xl h-12 px-4 text-sm text-white outline-none focus:border-white/30 [color-scheme:dark]"
                                            />
                                            <p className="text-[11px] text-white/35">Stored onchain as {formatTimestamp(endTimestamp)}.</p>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">
                                                <FieldHint
                                                    label="Min Bet"
                                                    text="Smallest commitment size allowed for a single private position, entered in USDC."
                                                />
                                            </label>
                                            <input
                                                type="number"
                                                value={minBet}
                                                onChange={(event) => setMinBet(event.target.value)}
                                                min="0"
                                                step="0.0000001"
                                                className="w-full bg-white/[0.04] border border-white/10 rounded-xl h-12 px-4 text-sm font-mono text-white outline-none focus:border-white/30"
                                            />
                                            <p className="text-[11px] text-white/35">{formatUsdcInput(minBet || "0")} USDC</p>
                                        </div>

                                        <div className="space-y-3">
                                            <label className="block text-[11px] font-bold text-white/50 uppercase tracking-[0.2em]">
                                                <FieldHint
                                                    label="Max Bet"
                                                    text="Largest commitment size one wallet can place in this market, entered in USDC."
                                                />
                                            </label>
                                            <input
                                                type="number"
                                                value={maxBet}
                                                onChange={(event) => setMaxBet(event.target.value)}
                                                min="0"
                                                step="0.0000001"
                                                className="w-full bg-white/[0.04] border border-white/10 rounded-xl h-12 px-4 text-sm font-mono text-white outline-none focus:border-white/30"
                                            />
                                            <p className="text-[11px] text-white/35">{formatUsdcInput(maxBet || "0")} USDC</p>
                                        </div>

                                    </div>

                                    <div className="min-w-0 rounded-3xl border border-white/5 bg-white/[0.02] p-5 sm:p-6 space-y-4 overflow-hidden">
                                        <div className="flex items-center justify-between gap-4">
                                            <div className="min-w-0">
                                                <p className="text-[10px] text-white/30 uppercase font-black tracking-[0.2em]">Launch Summary</p>
                                                <h4 className="mt-3 text-lg font-black tracking-tight text-white break-words">{question}</h4>
                                            </div>
                                            <div className="px-3 py-1 rounded-full border border-violet-400/20 bg-violet-500/10 text-[10px] uppercase tracking-[0.2em] font-black text-violet-100">
                                                {category}
                                            </div>
                                        </div>
                                        <div className="space-y-4">
                                            <div>
                                                <p className="text-[10px] text-white/30 uppercase font-black tracking-[0.18em] mb-3">Resolution Logic</p>
                                                <LogicPreview conditions={draftConditions} />
                                            </div>
                                            <div className="grid min-w-0 grid-cols-1 gap-4 text-sm text-white/70 md:grid-cols-2">
                                                <div className="min-w-0">Resolve: <span className="font-mono text-white/90 break-words">{formatTimestamp(endTimestamp)}</span></div>
                                                <div className="min-w-0">Min / Max: <span className="font-mono text-white/90 break-words">{formatUsdcInput(minBet)} / {formatUsdcInput(maxBet)} USDC</span></div>
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            ) : null}

                            {step === 5 ? (
                                <div className="space-y-6">
                                    {createdTxHash ? (
                                        <div className="rounded-[24px] border border-violet-400/20 bg-[linear-gradient(180deg,rgba(168,85,247,0.14),rgba(255,255,255,0.02))] p-6 sm:p-7">
                                            <div className="flex flex-col items-center text-center">
                                                <div className="flex h-16 w-16 items-center justify-center rounded-full border border-violet-400/30 bg-violet-500/12 shadow-[0_0_40px_rgba(168,85,247,0.16)]">
                                                    <Check className="h-8 w-8 text-violet-100" />
                                                </div>
                                                <p className="mt-5 text-[10px] font-black uppercase tracking-[0.22em] text-fuchsia-200/70">Transaction Confirmed</p>
                                                <h4 className="mt-2 text-xl font-black tracking-tight text-white">Market created successfully</h4>
                                                <p className="mt-2 max-w-md text-sm text-white/50">
                                                    Your private market is now live on Stellar and ready for participants to commit positions.
                                                </p>

                                                <div className="mt-6 w-full max-w-2xl rounded-2xl border border-white/8 bg-black/20 p-4 text-left">
                                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Transaction Hash</p>
                                                    <p className="mt-2 text-sm font-mono text-white break-all">{createdTxHash}</p>
                                                </div>

                                                <div className="mt-5 flex flex-col gap-3 sm:flex-row">
                                                    <a
                                                        href={explorerTransactionUrl(createdTxHash)}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="flex h-11 items-center justify-center gap-2 rounded-xl border border-violet-400/20 bg-violet-500/14 px-5 text-[11px] font-bold uppercase tracking-[0.18em] text-violet-50 transition-all hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99]"
                                                    >
                                                        View Explorer
                                                    </a>
                                                </div>
                                            </div>
                                        </div>
                                    ) : (
                                        <>
                                            <div>
                                                <p className="text-[10px] font-black text-white/40 uppercase tracking-[0.22em] mb-3">Review & Launch</p>
                                                <h3 className="text-lg font-black text-white tracking-tight">Approve transaction</h3>
                                                <p className="text-sm text-white/50 mt-2">
                                                    {`Review the payload, wallet balance, and network fee before signing on ${currentNetworkLabel()}.`}
                                                </p>
                                            </div>

                                            <div className="rounded-[28px] border border-white/8 bg-[linear-gradient(180deg,rgba(255,255,255,0.04),rgba(255,255,255,0.015))] p-4 sm:p-5">
                                                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                                    <div className="min-w-0">
                                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/35">Signing Wallet</p>
                                                        <div className="group relative mt-2 inline-flex max-w-full">
                                                            <p className="text-sm font-semibold text-white">
                                                                {stellarWallet?.address ? shortenAddress(stellarWallet.address, 8, 6) : "Wallet not connected"}
                                                            </p>
                                                            {stellarWallet?.address ? (
                                                                <div className="pointer-events-none absolute left-0 top-full z-20 mt-2 w-max max-w-[18rem] rounded-xl border border-white/10 bg-[#0d0d10] px-3 py-2 text-[11px] font-medium tracking-normal text-white/70 opacity-0 shadow-2xl transition-opacity group-hover:opacity-100">
                                                                    {stellarWallet.address}
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>
                                                    <div className="inline-flex items-center gap-2 self-start rounded-full border border-violet-400/15 bg-violet-500/10 px-3 py-1.5">
                                                        <span className="h-2 w-2 rounded-full bg-fuchsia-300" />
                                                        <span className="text-[10px] font-black uppercase tracking-[0.2em] text-violet-100">{isTestnet ? "Testnet" : "Mainnet"}</span>
                                                    </div>
                                                </div>

                                                <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                                    <div className="rounded-2xl border border-white/6 bg-black/20 p-3.5">
                                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Available XLM</p>
                                                        <p className="mt-2 text-lg font-semibold text-white">{formatXlmAmount(xlmSpendableBalance, 4)} XLM</p>
                                                        <p className="mt-1 text-[11px] text-white/35">Spendable after Stellar reserve.</p>
                                                    </div>
                                                    <div className="rounded-2xl border border-white/6 bg-black/20 p-3.5">
                                                        <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/25">Available USDC</p>
                                                        <p className="mt-2 text-lg font-semibold text-white">{formatUsdcInput(walletBalance)} USDC</p>
                                                        <p className="mt-1 text-[11px] text-white/35">Collateral token in this wallet.</p>
                                                    </div>
                                                </div>

                                                <div className="mt-4 border-t border-white/8 pt-4">
                                                    <div className="flex items-start justify-between gap-4">
                                                        <div className="min-w-0">
                                                            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-white/30">Action</p>
                                                            <h4 className="mt-2 text-base font-black leading-tight text-white break-words">{question}</h4>
                                                        </div>
                                                        <div className="shrink-0 rounded-full border border-violet-400/15 bg-violet-500/10 px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-violet-100">
                                                            {category}
                                                        </div>
                                                    </div>
                                                </div>

                                                <div className="mt-4 border-t border-white/8 pt-4">
                                                    <div className="space-y-3">
                                                        <div className="flex items-center justify-between gap-4 text-sm">
                                                            <span className="text-white/45">Network fee</span>
                                                            <span className="font-mono text-white">
                                                                {isEstimatingFee ? "Estimating..." : estimatedFeeXlm ? `${formatXlmAmount(estimatedFeeXlm)} XLM` : "Unavailable"}
                                                            </span>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 text-sm">
                                                            <span className="text-white/45">Wallet balance</span>
                                                            <span className="font-mono text-right text-white">{formatXlmAmount(xlmBalance)} XLM</span>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 text-sm">
                                                            <span className="text-white/45">Reserved minimum</span>
                                                            <span className="font-mono text-right text-white">{formatXlmAmount(xlmMinimumBalance)} XLM</span>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 text-sm">
                                                            <span className="text-white/45">Resolution time</span>
                                                            <span className="font-mono text-right text-white">{formatTimestamp(endTimestamp)}</span>
                                                        </div>
                                                        <div className="flex items-center justify-between gap-4 text-sm">
                                                            <span className="text-white/45">Bet range</span>
                                                            <span className="font-mono text-right text-white">{formatUsdcInput(minBet)} to {formatUsdcInput(maxBet)} USDC</span>
                                                        </div>
                                                    </div>
                                                </div>

                                                {hasInsufficientFeeBalance ? (
                                                    <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/8 px-4 py-3">
                                                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                                                            <p className="text-[11px] text-amber-200">
                                                                Your wallet can spend about {formatXlmAmount(xlmSpendableBalance)} XLM after Stellar reserve, but this transaction currently needs about {formatXlmAmount(estimatedFeeXlm)} XLM.
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

                                                <div className="mt-4 border-t border-white/8 pt-4">
                                                    <p className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-200/65">Resolution Logic</p>
                                                    <div className="mt-3">
                                                        <LogicPreview conditions={draftConditions} tone="accent" />
                                                    </div>
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>
                            ) : null}

                            {error ? (
                                <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4">
                                    <p className="text-[11px] text-red-300">{error}</p>
                                </div>
                            ) : null}
                        </div>

                        <div className="shrink-0 px-5 sm:px-8 py-4 sm:py-6 border-t border-white/5 flex items-center justify-between gap-4 bg-[#0a0a0c]">
                            <button
                                onClick={() => setStep((current) => Math.max(1, current - 1))}
                                disabled={step === 1 || isSubmitting}
                                className="text-[10px] font-bold text-white/20 uppercase tracking-widest hover:text-white transition-colors disabled:opacity-0"
                            >
                                Previous
                            </button>

                            <div className="flex items-center gap-3">
                                {createdTxHash ? (
                                    <button
                                        onClick={(e) => { e.stopPropagation(); handleClose(); }}
                                        className="flex h-12 items-center justify-center gap-2.5 rounded-xl border border-violet-400/20 bg-violet-500/14 px-6 text-xs font-bold uppercase tracking-[0.2em] text-violet-50 transition-all hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99] shadow-xl shadow-violet-950/30"
                                    >
                                        Done
                                    </button>
                                ) : step < TOTAL_STEPS ? (
                                    <button
                                        onClick={() => setStep((current) => Math.min(TOTAL_STEPS, current + 1))}
                                        className="flex h-12 items-center justify-center gap-2.5 rounded-xl border border-violet-400/20 bg-violet-500/14 px-6 text-xs font-bold uppercase tracking-[0.2em] text-violet-50 transition-all hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99] shadow-xl shadow-violet-950/30"
                                    >
                                        {step === TOTAL_STEPS - 1 ? "Review" : "Next"}
                                        <ArrowRight className="w-4 h-4" />
                                    </button>
                                ) : (
                                    <button
                                        onClick={() => void handleSubmit()}
                                        disabled={isSubmitting || !authenticated || !stellarWallet || isEstimatingFee || !estimatedFeeXlm || hasInsufficientFeeBalance}
                                        className="flex h-12 items-center justify-center gap-2.5 rounded-xl border border-violet-400/20 bg-violet-500/14 px-6 text-xs font-bold uppercase tracking-[0.2em] text-violet-50 transition-all hover:border-violet-300/35 hover:bg-violet-500/22 active:scale-[0.99] shadow-xl shadow-violet-950/30 disabled:opacity-70"
                                    >
                                        {isSubmitting ? (
                                            <>
                                                <Loader2 className="w-4 h-4 animate-spin" />
                                                Launching...
                                            </>
                                        ) : isEstimatingFee ? (
                                            "Estimating Fee"
                                        ) : hasInsufficientFeeBalance ? (
                                            "Insufficient XLM"
                                        ) : !estimatedFeeXlm ? (
                                            "Fee Unavailable"
                                        ) : (
                                            <>
                                                Approve & Launch
                                                <ArrowRight className="w-4 h-4" />
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        </div>
                    </motion.div>
                </div>
            ) : null}
        </AnimatePresence>
    );
}
