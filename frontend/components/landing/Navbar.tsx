"use client";

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Wallet, LogOut, Copy, RefreshCw, Settings, Cloud, HardDrive } from "lucide-react";
import { Logo } from "./Logo";
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { usePrivy } from '@privy-io/react-auth';
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from '@/lib/privy-stellar-wallet';
import { ensureUsdcTestnetTrustlineWithPrivyWallet, fundStellarTestnetAddress, getPrivyStellarWallet, loadMarketIds, loadMarketView, loadUsdcBalance, loadXlmBalance } from '@/lib/stellar';
import { Loader2 } from 'lucide-react';
import { DEFAULT_PROFILE_AVATAR } from '@/lib/profile-avatar';
import { loadExistingReputationSnapshot } from '@/lib/reputation-vault';
import { mapMarketSummary } from '@/lib/blind-market';
import type { BlindPositionRecord } from '@/lib/types';

interface NavbarProps {
    transparent?: boolean;
}

type GoogleProfile = {
    email?: string;
    name?: string;
    picture?: string;
};

export const Navbar = ({ transparent = true }: NavbarProps) => {
    const [isOpen, setIsOpen] = useState(false);
    const [isAccountOpen, setIsAccountOpen] = useState(false);
    const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
    const pathname = usePathname();
    const isLandingPage = pathname === '/';
    const { login, logout, authenticated, user } = usePrivy();
    const { createWallet } = useCreateWallet();
    const { signRawHash } = useSignRawHash();
    const googleProfile = user?.google as GoogleProfile | undefined;
    const [usdcBalance, setUsdcBalance] = useState<string>('0.00');
    const [xlmBalance, setXlmBalance] = useState<string>('0.0000000');
    const [claimingXlmFaucet, setClaimingXlmFaucet] = useState(false);
    const [claimingUsdcFaucet, setClaimingUsdcFaucet] = useState(false);
    const [fundingMessage, setFundingMessage] = useState<string>('');
    const [profileName, setProfileName] = useState<string>(googleProfile?.name ?? 'Public trader');
    const [profileBio, setProfileBio] = useState<string>('No public bio yet.');
    const [profileAvatar, setProfileAvatar] = useState<string | null>(googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR);
    const [profileSyncMode, setProfileSyncMode] = useState<'server' | 'local'>('server');
    const [positionsNeedAttention, setPositionsNeedAttention] = useState(false);
    const stellarWallet = getPrivyStellarWallet(user);

    useEffect(() => {
        if (!authenticated || stellarWallet) return;

        ensurePrivyStellarWallet({
            authenticated,
            hasWallet: Boolean(stellarWallet),
            createWallet,
        }).catch((error) => {
            if (isPrivyStellarWalletLimitError(error)) {
                console.warn('Privy Stellar wallet limit reached for this user.');
                return;
            }
            console.error('Failed to create Privy Stellar wallet:', error);
        });
    }, [authenticated, stellarWallet, createWallet]);

    useEffect(() => {
        if (!stellarWallet?.address) return;

        const updateBalance = async () => {
            const [rawUsdcBalance, rawXlmBalance] = await Promise.all([
                loadUsdcBalance(stellarWallet.address),
                loadXlmBalance(stellarWallet.address),
            ]);
            setUsdcBalance((Number(rawUsdcBalance) / 10_000_000).toFixed(2));
            setXlmBalance(Number(rawXlmBalance).toFixed(4));
        };

        updateBalance();
        const interval = setInterval(updateBalance, 5000);
        return () => clearInterval(interval);
    }, [stellarWallet?.address]);

    useEffect(() => {
        if (!stellarWallet?.address) {
            setProfileName(googleProfile?.name ?? 'Public trader');
            setProfileBio('No public bio yet.');
            setProfileAvatar(googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR);
            setProfileSyncMode('server');
            return;
        }

        let mounted = true;
        const run = async () => {
            try {
                const snapshot = await loadExistingReputationSnapshot(stellarWallet.address);
                if (!mounted) return;

                setProfileName(snapshot?.profile.displayName?.trim() || googleProfile?.name || 'Public trader');
                setProfileBio(snapshot?.profile.bio?.trim() || 'No public bio yet.');
                setProfileAvatar(snapshot?.profile.avatarDataUrl || googleProfile?.picture || DEFAULT_PROFILE_AVATAR);
                setProfileSyncMode(snapshot?.syncMode ?? 'server');
            } catch {
                if (!mounted) return;
                setProfileName(googleProfile?.name || 'Public trader');
                setProfileBio('No public bio yet.');
                setProfileAvatar(googleProfile?.picture || DEFAULT_PROFILE_AVATAR);
                setProfileSyncMode('server');
            }
        };

        void run();
        return () => {
            mounted = false;
        };
    }, [googleProfile?.name, googleProfile?.picture, stellarWallet?.address]);

    useEffect(() => {
        if (!stellarWallet?.address) {
            setPositionsNeedAttention(false);
            return;
        }

        let mounted = true;
        const run = async () => {
            try {
                const [snapshot, marketIds] = await Promise.all([
                    loadExistingReputationSnapshot(stellarWallet.address),
                    loadMarketIds(),
                ]);

                if (!mounted) return;
                const positions = (snapshot?.positions ?? []).filter((position) => (
                    position.owner.toLowerCase() === stellarWallet.address.toLowerCase()
                ));

                if (positions.length === 0) {
                    setPositionsNeedAttention(false);
                    return;
                }

                const settled = await Promise.allSettled(marketIds.map(async (marketId) => ({
                    marketId,
                    view: await loadMarketView(marketId),
                })));
                if (!mounted) return;

                const marketMap = new Map(
                    settled
                        .flatMap((result) => result.status === "fulfilled" ? [mapMarketSummary(result.value)] : [])
                        .map((market) => [market.marketId, market]),
                );

                const hasAttention = positions.some((position: BlindPositionRecord) => {
                    const market = marketMap.get(position.marketId);
                    if (!market) {
                        return position.tallyStatus === "share_upload_failed";
                    }

                    const marketNeedsTally = !market.resolved && Date.now() >= market.endTimestamp && Date.now() < market.tallyDeadline;
                    const needsTally = marketNeedsTally
                        && position.tallyStatus !== "queued_for_auto_finalization"
                        && position.tallyStatus !== "finalizing"
                        && position.tallyStatus !== "tally_submitted"
                        && position.tallyStatus !== "share_upload_failed";
                    const canClaim = market.resolved
                        && market.outcome !== null
                        && !position.claimedAt
                        && (position.tallyStatus === "tally_submitted"
                            || position.tallyStatus === "queued_for_auto_finalization"
                            || position.tallyStatus === "finalizing"
                            || Boolean(position.talliedAt))
                        && position.side === market.outcome;

                    return position.tallyStatus === "share_upload_failed" || needsTally || canClaim;
                });

                setPositionsNeedAttention(hasAttention);
            } catch {
                if (mounted) {
                    setPositionsNeedAttention(false);
                }
            }
        };

        void run();
        const interval = setInterval(() => {
            void run();
        }, 15000);

        return () => {
            mounted = false;
            clearInterval(interval);
        };
    }, [stellarWallet?.address]);

    const landingLinks = [
        { name: 'Overview', href: '#hero' },
        { name: 'How It Works', href: '#features' },
        { name: 'Signals', href: '#stats' },
        { name: 'Docs', href: 'https://github.com/preyanshu/aegis' }
    ];

    const dashboardLinks = [
        { name: 'Home', href: '/dashboard' },
        { name: 'My Positions', href: '/dashboard/positions' },
        { name: 'Reputation', href: '/dashboard/reputation' },
        { name: 'Agents', href: '/dashboard/agents' },
        { name: 'Sources', href: '/dashboard/sources' },
        { name: 'History', href: '/dashboard/history' },
        { name: 'Docs', href: 'https://github.com/preyanshu/aegis' }
    ];

    const currentLinks = isLandingPage ? landingLinks : dashboardLinks;

    useEffect(() => {
        if (user) {
            console.log("Full Privy User Object:", user);
        }
    }, [user]);

    const refreshBalances = async () => {
        if (!stellarWallet?.address) return;
        try {
            const [rawUsdcBalance, rawXlmBalance] = await Promise.all([
                loadUsdcBalance(stellarWallet.address),
                loadXlmBalance(stellarWallet.address),
            ]);
            setUsdcBalance((Number(rawUsdcBalance) / 10_000_000).toFixed(2));
            setXlmBalance(Number(rawXlmBalance).toFixed(4));
        } catch (error) {
            console.error('Balance refresh failed:', error);
        }
    };

    const formatFundingError = (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes('account already funded to starting balance')) {
            return 'This wallet already received the current testnet XLM faucet allotment.';
        }
        if (message.includes('trustline entry is missing for account')) {
            return 'The USDC trustline is not ready yet. Try again in a moment.';
        }
        return message;
    };

    const handleClaimXlmFaucet = async () => {
        if (!stellarWallet?.address) return;
        setClaimingXlmFaucet(true);
        setFundingMessage('');
        try {
            await fundStellarTestnetAddress(stellarWallet.address);
            await refreshBalances();
            setFundingMessage('Testnet XLM requested successfully.');
        } catch (error) {
            console.error('XLM faucet failed:', error);
            setFundingMessage(formatFundingError(error));
        } finally {
            setClaimingXlmFaucet(false);
        }
    };

    const handleClaimUsdcFaucet = async () => {
        if (!stellarWallet?.address || !stellarWallet) return;
        setClaimingUsdcFaucet(true);
        setFundingMessage('');
        try {
            await ensureUsdcTestnetTrustlineWithPrivyWallet(stellarWallet, signRawHash);
            await refreshBalances();
            setFundingMessage('USDC trustline ready. Opening Circle faucet...');
            window.open('https://faucet.circle.com/', '_blank', 'noopener,noreferrer');
        } catch (error) {
            console.error('USDC faucet preparation failed:', error);
            setFundingMessage(formatFundingError(error));
        } finally {
            setClaimingUsdcFaucet(false);
        }
    };

    const truncateAddress = (address: string) => {
        return `${address.slice(0, 6)}...${address.slice(-4)}`;
    };

    const displayName = profileName.trim() || googleProfile?.name || 'Public trader';
    const displayBio = profileBio.trim() || 'No public bio yet.';
    const displayAddress = stellarWallet?.address ? truncateAddress(stellarWallet.address) : 'Creating...';
    const displayHandle = stellarWallet?.address ? `@${truncateAddress(stellarWallet.address)}` : (user?.google?.email || '@connecting');
    const fullIdentityName = user?.google?.name || displayName;
    const fullIdentityEmail = user?.google?.email;
    const formattedUsdcBalance = Number(usdcBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const formattedXlmBalance = Number(xlmBalance).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });

    const renderAccountPanel = (mobile = false) => (
        <div className={mobile ? "space-y-6" : "space-y-5"}>
            <div className="rounded-[24px] border border-white/10 bg-[#0f0f12] p-4 text-white">
                <div className="relative space-y-4">
                    <div className="flex items-start gap-4">
                        <div className={`${mobile ? 'h-[72px] w-[72px]' : 'h-16 w-16'} shrink-0 overflow-hidden rounded-[20px] border border-white/10 bg-white/[0.05]`}>
                            <img src={profileAvatar || DEFAULT_PROFILE_AVATAR} alt={displayName} className="h-full w-full object-cover" />
                        </div>

                        <div className="min-w-0 flex-1">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <p className={`${mobile ? 'text-[28px]' : 'text-xl'} truncate font-black tracking-[-0.04em] text-white`}>
                                        {displayName}
                                    </p>
                                    <p className="mt-1 truncate font-mono text-[11px] uppercase tracking-[0.12em] text-violet-200/65">
                                        {displayHandle}
                                    </p>
                                </div>
                                <button
                                    onClick={() => {
                                        window.dispatchEvent(new Event("verdict-open-profile-settings"));
                                        window.dispatchEvent(new Event("aegis-open-profile-settings"));
                                    }}
                                    className={`${mobile ? 'h-11 w-11' : 'h-10 w-10'} group inline-flex shrink-0 items-center justify-center rounded-full border border-violet-400/20 bg-violet-500/10 text-violet-200 transition hover:border-violet-400/35 hover:bg-violet-500/14 hover:text-white`}
                                    aria-label="Edit profile"
                                >
                                    <Settings className={`${mobile ? 'h-[18px] w-[18px]' : 'h-4 w-4'} transition-transform duration-500 group-hover:rotate-180`} />
                                </button>
                            </div>

                            <p className={`${mobile ? 'mt-3 text-[15px]' : 'mt-2 text-sm'} line-clamp-3 max-w-[30ch] leading-relaxed text-white/62`}>
                                {displayBio}
                            </p>
                        </div>
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-violet-400/20 bg-violet-500/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-violet-100/90">
                            {profileSyncMode === "server" ? <Cloud className="h-3 w-3 text-violet-200" /> : <HardDrive className="h-3 w-3 text-violet-200" />}
                            {profileSyncMode === "server" ? "Cloud backed" : "Local vault"}
                        </span>
                        <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.08em] text-white/76">
                            <span className="h-1.5 w-1.5 rounded-full bg-violet-300/80" />
                            Stellar testnet
                        </span>
                    </div>

                    <div className="border-t border-violet-400/12 pt-4">
                        <div className="flex items-start justify-between gap-3">
                            <div>
                                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Wallet balance</p>
                                <p className={`${mobile ? 'mt-3 text-4xl' : 'mt-2 text-3xl'} font-black tracking-[-0.05em] text-white`}>
                                    ${formattedUsdcBalance}
                                </p>
                            </div>
                            <button
                                onClick={refreshBalances}
                                disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-violet-400/15 bg-violet-500/10 text-violet-200/75 transition hover:border-violet-400/30 hover:bg-violet-500/14 disabled:opacity-50"
                                aria-label="Refresh balances"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                            </button>
                        </div>

                        <div className="mt-4 flex items-end justify-between gap-4 border-t border-white/8 pt-4">
                            <div>
                                <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-violet-200/55">USDC</p>
                                <p className="mt-2 text-lg font-black tracking-tight text-white">{formattedUsdcBalance}</p>
                            </div>
                            <div className="text-right">
                                <p className="font-mono text-[11px] uppercase tracking-[0.1em] text-violet-200/55">XLM</p>
                                <p className="mt-2 text-lg font-black tracking-tight text-white/88">{formattedXlmBalance}</p>
                            </div>
                        </div>

                        <div className="mt-4 flex items-start justify-between gap-3 border-t border-white/8 pt-4">
                            <div className="min-w-0">
                                <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Connected identity</p>
                                <p className="mt-2 truncate text-sm font-semibold text-white">{fullIdentityName}</p>
                                {fullIdentityEmail ? (
                                    <p className="mt-1 truncate text-xs text-white/45">{fullIdentityEmail}</p>
                                ) : null}
                                <p className="mt-3 font-mono text-xs text-white/55">{displayAddress}</p>
                            </div>
                            <button
                                onClick={() => {
                                    if (stellarWallet?.address) {
                                        navigator.clipboard.writeText(stellarWallet.address);
                                    }
                                }}
                                className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-violet-400/15 bg-violet-500/10 text-violet-200/75 transition hover:border-violet-400/30 hover:bg-violet-500/14 hover:text-white"
                                aria-label="Copy wallet address"
                            >
                                <Copy className="h-4 w-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <button
                    onClick={handleClaimXlmFaucet}
                    disabled={claimingXlmFaucet || claimingUsdcFaucet}
                    className={`${mobile ? 'py-4 text-[11px]' : 'py-3 text-[10px]'} rounded-full border border-white/10 bg-white text-black font-semibold uppercase tracking-[0.16em] transition-all hover:bg-white/90 disabled:opacity-50`}
                >
                    {claimingXlmFaucet ? (
                        <span className="inline-flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Funding...
                        </span>
                    ) : (
                        "Get XLM"
                    )}
                </button>
                <button
                    onClick={handleClaimUsdcFaucet}
                    disabled={claimingXlmFaucet || claimingUsdcFaucet}
                    className={`${mobile ? 'py-4 text-[11px]' : 'py-3 text-[10px]'} rounded-full border border-white/10 bg-white/[0.03] text-white font-semibold uppercase tracking-[0.16em] transition-all hover:bg-white/[0.06] disabled:opacity-50`}
                >
                    {claimingUsdcFaucet ? (
                        <span className="inline-flex items-center justify-center gap-2">
                            <Loader2 className="h-4 w-4 animate-spin" />
                            Preparing...
                        </span>
                    ) : (
                        "Get USDC"
                    )}
                </button>
            </div>

            {fundingMessage ? (
                <div className="rounded-[16px] border border-white/10 bg-white/[0.03] px-4 py-3">
                    <p className="text-[11px] leading-relaxed text-white/65">{fundingMessage}</p>
                </div>
            ) : null}

            <button
                onClick={() => logout()}
                className={`${mobile ? 'py-4 text-[11px]' : 'py-3 text-[10px]'} w-full rounded-full border border-red-400/18 bg-red-500/10 text-red-300 font-semibold uppercase tracking-[0.16em] transition-all hover:bg-red-500/14 hover:text-red-200`}
            >
                <span className="inline-flex items-center justify-center gap-2">
                    <LogOut className={`${mobile ? 'h-4 w-4' : 'h-3.5 w-3.5'}`} />
                    Disconnect Session
                </span>
            </button>
        </div>
    );

    return (
        <>
            <motion.nav
                initial={{ y: -20, opacity: 0 }}
                animate={{
                    y: 0,
                    opacity: 1,
                    backgroundColor: isOpen ? "rgba(8, 8, 12, 0.98)" : (transparent ? "rgba(0, 0, 0, 0)" : "rgba(8, 8, 12, 0.85)"),
                    backdropFilter: isOpen ? "blur(40px)" : (transparent ? "blur(0px)" : "blur(40px)"),
                }}
                transition={{
                    y: { duration: 0.5, ease: "easeOut" },
                    opacity: { duration: 0.5 },
                    backgroundColor: { duration: 0.3 },
                    backdropFilter: { duration: 0.3 }
                }}
                className={`fixed top-0 left-0 right-0 flex items-center justify-between px-4 lg:px-8 py-4 lg:py-5 mx-auto w-full z-[100] ${!isOpen ? `${transparent ? 'lg:bg-transparent lg:backdrop-blur-none lg:border-none' : ''} border-b border-white/5 bg-black/80 backdrop-blur-2xl` : 'border-b border-white/10'}`}
            >
                <div className="max-w-7xl mx-auto w-full flex items-center justify-between relative z-[110]">
                    <Link href="/">
                        <Logo />
                    </Link>

                    <div className="hidden lg:flex items-center gap-1 bg-white/5 backdrop-blur-md px-1 py-1 rounded-full border border-white/10" onMouseLeave={() => setHoveredIndex(null)}>
                        {currentLinks.map((item, i) => {
                            const isActive = pathname === item.href;
                            const showPositionsAlert = item.href === '/dashboard/positions' && positionsNeedAttention;
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    target={item.href.startsWith('http') ? '_blank' : undefined}
                                    rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                                    onMouseEnter={() => setHoveredIndex(i)}
                                    className={`relative px-4 xl:px-6 py-2 rounded-full text-sm font-medium transition-all group ${isActive ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                                >
                                    <span className="relative z-10 inline-flex items-center gap-2">
                                        <span>{item.name}</span>
                                        {showPositionsAlert ? (
                                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.75)]" />
                                        ) : null}
                                    </span>
                                    {isActive && !hoveredIndex !== null && (
                                        <motion.span
                                            layoutId="nav-glow-active"
                                            className="absolute inset-0 bg-violet-500/10 rounded-full z-0 border border-violet-500/20"
                                        />
                                    )}
                                    {(hoveredIndex === i || isActive) && (
                                        <>
                                            <motion.span
                                                layoutId="nav-underline"
                                                className="absolute bottom-1.5 left-1/2 -translate-x-1/2 w-4 h-0.5 bg-violet-400 rounded-full shadow-[0_0_8px_rgba(168,85,247,0.8)] z-20"
                                            />
                                            {hoveredIndex === i && (
                                                <motion.span
                                                    layoutId="nav-glow"
                                                    transition={{ type: "spring", bounce: 0.2, duration: 0.6 }}
                                                    className="absolute inset-0 bg-white/5 rounded-full z-0"
                                                />
                                            )}
                                        </>
                                    )}
                                </Link>
                            );
                        })}
                    </div>

                    {/* Desktop Action Button */}
                    <div className="hidden lg:flex items-center gap-3 relative">
                        {isLandingPage ? (
                            <Link href="/dashboard">
                                <button
                                    className="group relative flex items-center gap-3 px-6 py-2.5 rounded-2xl bg-white text-black font-black text-[11px] uppercase tracking-[0.2em] hover:bg-violet-300 hover:text-black transition-all hover:scale-105 active:scale-95 shadow-[0_0_30px_rgba(255,255,255,0.1)]"
                                >
                                    Enter Market
                                    <ChevronRight className="w-4 h-4" />
                                </button>
                            </Link>
                        ) : authenticated ? (
                            <div
                                className="relative"
                                onMouseEnter={() => setIsAccountOpen(true)}
                                onMouseLeave={() => setIsAccountOpen(false)}
                            >
                                <button
                                    onClick={() => setIsAccountOpen(!isAccountOpen)}
                                    className={`flex items-center gap-3 bg-white/5 border rounded-2xl px-4 py-2 transition-all hover:bg-white/10 ${isAccountOpen ? 'border-violet-500/30 bg-white/10' : 'border-white/10'}`}
                                >
                                    <div className="relative h-8 w-8 overflow-hidden rounded-full border border-violet-500/20 bg-white/[0.04]">
                                        <img
                                            src={profileAvatar || DEFAULT_PROFILE_AVATAR}
                                            alt={displayName}
                                            className="h-full w-full object-cover"
                                        />
                                    </div>
                                    <div className="flex min-w-0 flex-col items-start">
                                        <span className="max-w-[9rem] truncate text-xs font-bold tracking-tight text-white">
                                            {displayName}
                                        </span>
                                        <span className="text-[9px] font-black uppercase leading-none tracking-widest text-violet-400/60">
                                            View Profile
                                        </span>
                                    </div>
                                    <ChevronRight className={`w-3 h-3 text-white/20 transition-transform duration-300 ${isAccountOpen ? 'rotate-90' : 'rotate-0'}`} />
                                </button>

                                {/* Wallet Explorer Dropdown */}
                                <div className={`absolute top-full right-0 w-72 pt-3 transition-all duration-300 z-[120] ${isAccountOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
                                    {/* Invisible Bridge to keep hover active */}
                                    <div className="absolute top-0 left-0 w-full h-3" />

                                    <div className="w-[23rem] rounded-[28px] border border-white/10 bg-[#0a0a0c] p-5 shadow-2xl backdrop-blur-3xl">
                                        {renderAccountPanel(false)}
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <button
                                onClick={() => login()}
                                className="group relative flex items-center gap-3 px-6 py-2.5 rounded-2xl bg-violet-500 text-black font-black text-[11px] uppercase tracking-[0.2em] hover:bg-violet-400 transition-all hover:scale-105 active:scale-95 shadow-[0_0_30px_rgba(168,85,247,0.2)]"
                            >
                                <Wallet className="w-4 h-4" />
                                Connect Wallet
                                <motion.div
                                    className="absolute inset-0 rounded-2xl bg-white/20 opacity-0 group-hover:opacity-100 transition-opacity"
                                    animate={{ scale: [1, 1.05, 1] }}
                                    transition={{ duration: 2, repeat: Infinity }}
                                />
                            </button>
                        )}
                    </div>

                    {/* Mobile Identity/Action */}
                    <div className="flex lg:hidden items-center gap-2">
                        {isLandingPage ? (
                            <Link href="/dashboard">
                                <button
                                    className="w-10 h-10 rounded-xl bg-white flex items-center justify-center text-black shadow-[0_0_15px_rgba(255,255,255,0.2)] transition-transform active:scale-90"
                                >
                                    <ChevronRight className="w-5 h-5" />
                                </button>
                            </Link>
                        ) : authenticated ? (
                            <button
                                onClick={() => setIsAccountOpen(true)}
                                className={`h-10 w-10 overflow-hidden rounded-full border transition-all ${isAccountOpen ? 'border-violet-500/40 bg-violet-500/20 shadow-[0_0_20px_rgba(168,85,247,0.2)]' : 'border-violet-500/20 bg-violet-500/10'}`}
                            >
                                <img
                                    src={profileAvatar || DEFAULT_PROFILE_AVATAR}
                                    alt={displayName}
                                    className="h-full w-full object-cover"
                                />
                            </button>
                        ) : (
                            <button
                                onClick={() => login()}
                                className="w-10 h-10 rounded-xl bg-violet-500 flex items-center justify-center text-black shadow-[0_0_15px_rgba(168,85,247,0.3)] transition-transform active:scale-90"
                            >
                                <Wallet className="w-5 h-5" />
                            </button>
                        )}

                        {/* Mobile Toggle */}
                        <button
                            className="text-white p-2 transition-transform active:scale-90"
                            onClick={() => setIsOpen(!isOpen)}
                        >
                            {isOpen ? <X className="w-6 h-6" /> : <ChevronRight className="w-6 h-6 rotate-90" />}
                        </button>
                    </div>
                </div>

            </motion.nav>

            {/* Mobile Menu Overlay */}
            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ opacity: 0, y: -20 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -20 }}
                        className="fixed top-[72px] lg:top-[84px] left-0 right-0 bg-[#08080c]/98 backdrop-blur-3xl border-b border-white/10 p-6 flex flex-col gap-4 lg:hidden z-[150]"
                    >
                        {currentLinks.map((item) => {
                            const isActive = pathname === item.href;
                            const showPositionsAlert = item.href === '/dashboard/positions' && positionsNeedAttention;
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    target={item.href.startsWith('http') ? '_blank' : undefined}
                                    rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                                    className={`flex items-center justify-between text-lg font-medium px-4 py-3 rounded-xl transition-all ${isActive ? 'text-violet-300 bg-violet-500/10 border border-violet-500/20' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                                    onClick={() => setIsOpen(false)}
                                >
                                    <span className="inline-flex items-center gap-2">
                                        <span>{item.name}</span>
                                        {showPositionsAlert ? (
                                            <span className="inline-flex h-2.5 w-2.5 rounded-full bg-red-400 shadow-[0_0_10px_rgba(248,113,113,0.75)]" />
                                        ) : null}
                                    </span>
                                </Link>
                            );
                        })}
                        <div className="w-full mt-4 space-y-4">
                            {isLandingPage ? (
                                <Link href="/dashboard" onClick={() => setIsOpen(false)}>
                                    <button
                                        className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-white text-black font-black text-sm uppercase tracking-[0.2em] shadow-[0_0_30px_rgba(255,255,255,0.1)]"
                                    >
                                        Enter Market
                                        <ChevronRight className="w-5 h-5" />
                                    </button>
                                </Link>
                            ) : !authenticated && (
                                <button
                                    onClick={() => { login(); setIsOpen(false); }}
                                    className="w-full flex items-center justify-center gap-3 py-4 rounded-2xl bg-violet-500 text-black font-black text-sm uppercase tracking-[0.2em] shadow-[0_0_30px_rgba(168,85,247,0.2)]"
                                >
                                    <Wallet className="w-5 h-5" />
                                    Connect Wallet
                                </button>
                            )}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Mobile Account Modal Overlay */}
            <AnimatePresence>
                {isAccountOpen && (
                    <div className="lg:hidden fixed inset-0 z-[200] flex items-center justify-center px-4 overflow-hidden">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            onClick={() => setIsAccountOpen(false)}
                            className="fixed inset-0 bg-black/90 backdrop-blur-2xl"
                        />

                        <motion.div
                            initial={{ opacity: 0, scale: 0.95, y: 20 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.95, y: 20 }}
                            className="bg-[#0a0a0c] border border-white/10 rounded-3xl p-8 w-full max-w-sm relative z-[210] shadow-2xl shadow-violet-500/10"
                        >
                            {/* Close Button */}
                            <button
                                onClick={() => setIsAccountOpen(false)}
                                className="absolute top-6 right-6 p-2 rounded-full bg-white/5 border border-white/5 text-white/40 hover:text-white transition-colors"
                            >
                                <X className="w-4 h-4" />
                            </button>

                            {renderAccountPanel(true)}
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
};
