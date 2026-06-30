"use client";

import Link from 'next/link';
import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronRight, Wallet, LogOut, Copy, RefreshCw, Settings2, Cloud, HardDrive } from "lucide-react";
import { Logo } from "./Logo";
import { useCreateWallet, useSignRawHash } from '@privy-io/react-auth/extended-chains';
import { usePrivy } from '@privy-io/react-auth';
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from '@/lib/privy-stellar-wallet';
import { ensureUsdcTestnetTrustlineWithPrivyWallet, fundStellarTestnetAddress, getPrivyStellarWallet, loadUsdcBalance, loadXlmBalance } from '@/lib/stellar';
import { Loader2 } from 'lucide-react';
import { loadExistingReputationSnapshot } from '@/lib/reputation-vault';

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
    const [profileAvatar, setProfileAvatar] = useState<string | null>(googleProfile?.picture ?? null);
    const [profileSyncMode, setProfileSyncMode] = useState<'server' | 'local'>('server');
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
            setProfileAvatar(googleProfile?.picture ?? null);
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
                setProfileAvatar(snapshot?.profile.avatarDataUrl || googleProfile?.picture || null);
                setProfileSyncMode(snapshot?.syncMode ?? 'server');
            } catch {
                if (!mounted) return;
                setProfileName(googleProfile?.name || 'Public trader');
                setProfileBio('No public bio yet.');
                setProfileAvatar(googleProfile?.picture || null);
                setProfileSyncMode('server');
            }
        };

        void run();
        return () => {
            mounted = false;
        };
    }, [googleProfile?.name, googleProfile?.picture, stellarWallet?.address]);

    const landingLinks = [
        { name: 'Overview', href: '#hero' },
        { name: 'How It Works', href: '#features' },
        { name: 'Signals', href: '#stats' },
        { name: 'Docs', href: 'https://github.com/preyanshu/verdict' }
    ];

    const dashboardLinks = [
        { name: 'Home', href: '/dashboard' },
        { name: 'My Positions', href: '/dashboard/positions' },
        { name: 'Reputation', href: '/dashboard/reputation' },
        { name: 'Agents', href: '/dashboard/agents' },
        { name: 'Sources', href: '/dashboard/sources' },
        { name: 'History', href: '/dashboard/history' },
        { name: 'Docs', href: 'https://github.com/preyanshu/verdict' }
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
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    target={item.href.startsWith('http') ? '_blank' : undefined}
                                    rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                                    onMouseEnter={() => setHoveredIndex(i)}
                                    className={`relative px-4 xl:px-6 py-2 rounded-full text-sm font-medium transition-all group ${isActive ? 'text-white' : 'text-gray-400 hover:text-white'}`}
                                >
                                    <span className="relative z-10">{item.name}</span>
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
                                    <div className="w-8 h-8 rounded-full bg-violet-500/20 flex items-center justify-center text-violet-400 overflow-hidden border border-violet-500/20 relative">
                                        {googleProfile?.email ? (
                                            googleProfile.picture ? (
                                                <img
                                                    src={googleProfile.picture}
                                                    alt={googleProfile.name || 'User'}
                                                    className="w-full h-full object-cover"
                                                />
                                            ) : (
                                                <div className="w-full h-full flex items-center justify-center text-[10px] font-black uppercase">
                                                    {googleProfile.email.charAt(0)}
                                                </div>
                                            )
                                        ) : (
                                            <Wallet className="w-4 h-4" />
                                        )}
                                    </div>
                                    <div className="flex flex-col items-start">
                                        <span className="text-xs font-bold text-white tracking-tight">
                                            {user?.google?.name || (stellarWallet?.address ? truncateAddress(stellarWallet.address) : 'Connected')}
                                        </span>
                                        <span className="text-[9px] text-violet-400/60 font-black uppercase tracking-widest leading-none">
                                            View Profile
                                        </span>
                                    </div>
                                    <ChevronRight className={`w-3 h-3 text-white/20 transition-transform duration-300 ${isAccountOpen ? 'rotate-90' : 'rotate-0'}`} />
                                </button>

                                {/* Wallet Explorer Dropdown */}
                                <div className={`absolute top-full right-0 w-72 pt-3 transition-all duration-300 z-[120] ${isAccountOpen ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2 pointer-events-none'}`}>
                                    {/* Invisible Bridge to keep hover active */}
                                    <div className="absolute top-0 left-0 w-full h-3" />

                                    <div className="bg-[#0a0a0c] border border-white/10 rounded-2xl p-6 shadow-2xl backdrop-blur-3xl">
                                        <div className="space-y-6">
                                            {/* Balance Section */}
                                            <div>
                                                <div className="mb-4 flex items-center justify-between gap-3">
                                                    <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Total Liquidity</p>
                                                    <button
                                                        onClick={refreshBalances}
                                                        disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                                        className="flex h-8 w-8 items-center justify-center rounded-full border border-white/8 bg-white/[0.03] text-white/45 transition-all hover:text-white hover:bg-white/[0.06] disabled:opacity-50"
                                                    >
                                                        <RefreshCw className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                                <div className="space-y-3">
                                                    <div className="flex items-end justify-between">
                                                        <span className="text-2xl font-black text-white font-mono tracking-tighter">
                                                            ${Number(usdcBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                                        </span>
                                                        <span className="text-[11px] font-black text-violet-400 uppercase tracking-widest mb-1">USDC</span>
                                                    </div>
                                                    <div className="flex items-end justify-between">
                                                        <span className="text-lg font-black text-white/85 font-mono tracking-tighter">
                                                            {Number(xlmBalance).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                                                        </span>
                                                        <span className="text-[11px] font-black text-violet-300/80 uppercase tracking-widest mb-0.5">XLM</span>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Identity Section */}
                                            <div className="pt-6 border-t border-white/5">
                                                <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em] mb-4">Connected Identity</p>
                                                <div className="p-3 bg-white/[0.02] border border-white/5 rounded-xl space-y-3">
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-[10px] text-white/40 font-bold uppercase tracking-widest">Network</span>
                                                        <span className="flex items-center gap-1.5">
                                                            <div className="w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                                                            <span className="text-[10px] text-white font-bold uppercase tracking-tight">Stellar Testnet</span>
                                                        </span>
                                                    </div>
                                                    <div className="flex items-center justify-between">
                                                        <span className="text-[10px] text-white/40 font-bold uppercase tracking-widest">Address</span>
                                                        <button
                                                            onClick={() => {
                                                                if (stellarWallet?.address) {
                                                                    navigator.clipboard.writeText(stellarWallet.address);
                                                                }
                                                            }}
                                                            className="flex items-center gap-2 hover:text-white transition-colors group/copy"
                                                        >
                                                            <span className="text-[10px] text-white/60 font-mono">
                                                                {stellarWallet?.address ? truncateAddress(stellarWallet.address) : 'Creating...'}
                                                            </span>
                                                            <Copy className="w-3 h-3 text-white/20 group-hover/copy:text-violet-500" />
                                                        </button>
                                                    </div>
                                                </div>
                                            </div>

                                            <div className="pt-6 border-t border-white/5">
                                                <div className="mb-4 flex items-center justify-between gap-3">
                                                    <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.2em]">Public Profile</p>
                                                    <button
                                                        onClick={() => window.dispatchEvent(new Event("verdict-open-profile-settings"))}
                                                        className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-violet-400/20 bg-violet-500/10 text-violet-300 transition hover:border-violet-400/40 hover:bg-violet-500/15"
                                                        aria-label="Edit profile"
                                                    >
                                                        <Settings2 className="h-3.5 w-3.5" />
                                                    </button>
                                                </div>
                                                <div className="rounded-xl border border-white/5 bg-white/[0.02] p-3">
                                                    <div className="flex items-start gap-3">
                                                        <div className="h-11 w-11 shrink-0 overflow-hidden rounded-full border border-white/10 bg-white/[0.04]">
                                                            {profileAvatar ? (
                                                                <img src={profileAvatar} alt={profileName} className="h-full w-full object-cover" />
                                                            ) : (
                                                                <div className="flex h-full w-full items-center justify-center text-[11px] font-black uppercase text-white/75">
                                                                    {profileName.slice(0, 1)}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="flex items-center gap-2">
                                                                <p className="truncate text-sm font-bold text-white">{profileName}</p>
                                                                <span className="inline-flex items-center gap-1 rounded-full border border-white/10 px-2 py-0.5 text-[9px] font-black uppercase tracking-[0.16em] text-white/45">
                                                                    {profileSyncMode === "server" ? <Cloud className="h-3 w-3 text-violet-300" /> : <HardDrive className="h-3 w-3 text-violet-300" />}
                                                                    {profileSyncMode === "server" ? "Cloud" : "Local"}
                                                                </span>
                                                            </div>
                                                            <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-white/50">
                                                                {profileBio}
                                                            </p>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* Funding Section */}
                                            <div className="pt-2 space-y-3">
                                                <div className="grid grid-cols-2 gap-3">
                                                    <button
                                                        onClick={handleClaimXlmFaucet}
                                                        disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                                        className="w-full py-3 rounded-xl bg-violet-500 text-black text-[10px] font-black uppercase tracking-[0.2em] hover:bg-violet-400 transition-all flex items-center justify-center gap-2 shadow-[0_0_20px_rgba(168,85,247,0.2)] disabled:opacity-50"
                                                    >
                                                        {claimingXlmFaucet ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Funding...</>
                                                        ) : (
                                                            "Get XLM"
                                                        )}
                                                    </button>
                                                    <button
                                                        onClick={handleClaimUsdcFaucet}
                                                        disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                                        className="w-full py-3 rounded-xl border border-violet-400/15 bg-white/[0.03] text-violet-300 text-[10px] font-black uppercase tracking-[0.2em] hover:bg-violet-500/10 transition-all flex items-center justify-center gap-2 disabled:opacity-50"
                                                    >
                                                        {claimingUsdcFaucet ? (
                                                            <><Loader2 className="w-3 h-3 animate-spin" /> Preparing...</>
                                                        ) : (
                                                            "Get USDC"
                                                        )}
                                                    </button>
                                                </div>
                                                {fundingMessage ? (
                                                    <div className="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2">
                                                        <p className="text-[11px] leading-relaxed text-white/65">{fundingMessage}</p>
                                                    </div>
                                                ) : null}
                                            </div>

                                            {/* Action Section */}
                                            <button
                                                onClick={() => logout()}
                                                className="w-full py-3 rounded-xl bg-red-400/5 border border-red-400/10 text-red-400 text-[10px] font-black uppercase tracking-[0.2em] hover:bg-red-400/10 transition-all flex items-center justify-center gap-2"
                                            >
                                                <LogOut className="w-3.5 h-3.5" />
                                                Terminate Session
                                            </button>
                                        </div>
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
                                className={`w-10 h-10 rounded-full border flex items-center justify-center overflow-hidden transition-all ${isAccountOpen ? 'bg-violet-500/20 border-violet-500/40 shadow-[0_0_20px_rgba(168,85,247,0.2)]' : 'bg-violet-500/10 border-violet-500/20'}`}
                            >
                                {googleProfile?.email ? (
                                    googleProfile.picture ? (
                                        <img
                                            src={googleProfile.picture}
                                            alt="User"
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-xs font-black uppercase text-violet-300">
                                            {googleProfile.email.charAt(0)}
                                        </div>
                                    )
                                ) : (
                                    <Wallet className="w-5 h-5 text-violet-400" />
                                )}
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
                            return (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    target={item.href.startsWith('http') ? '_blank' : undefined}
                                    rel={item.href.startsWith('http') ? 'noopener noreferrer' : undefined}
                                    className={`flex items-center justify-between text-lg font-medium px-4 py-3 rounded-xl transition-all ${isActive ? 'text-violet-300 bg-violet-500/10 border border-violet-500/20' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                                    onClick={() => setIsOpen(false)}
                                >
                                    <span>{item.name}</span>
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

                            <div className="space-y-8">
                                {/* Total Liquidity - Top Section */}
                                <div className="space-y-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.25em]">Total Liquidity</p>
                                        <button
                                            onClick={refreshBalances}
                                            disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                            className="flex h-9 w-9 items-center justify-center rounded-full border border-white/8 bg-white/[0.03] text-white/45 transition-all hover:text-white hover:bg-white/[0.06] disabled:opacity-50"
                                        >
                                            <RefreshCw className="h-4 w-4" />
                                        </button>
                                    </div>
                                    <div className="space-y-3">
                                        <div className="flex items-baseline justify-between">
                                            <span className="text-4xl font-black text-white font-mono tracking-tighter leading-none">
                                                ${Number(usdcBalance).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                                            </span>
                                            <span className="text-[11px] font-black text-violet-500 uppercase tracking-widest">USDC</span>
                                        </div>
                                        <div className="flex items-baseline justify-between">
                                            <span className="text-xl font-black text-white/85 font-mono tracking-tighter leading-none">
                                                {Number(xlmBalance).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}
                                            </span>
                                            <span className="text-[11px] font-black text-violet-300/80 uppercase tracking-widest">XLM</span>
                                        </div>
                                    </div>
                                    <div className="h-px bg-white/5 w-full mt-4" />
                                </div>

                                {/* Connected Identity Info */}
                                <div className="space-y-5">
                                    <div className="flex items-center justify-between">
                                        <p className="text-[10px] font-black text-white/20 uppercase tracking-[0.25em]">Connected Identity</p>
                                        <div className="flex items-center gap-2">
                                            <div className="w-6 h-6 rounded-full bg-violet-500/10 flex items-center justify-center border border-violet-500/20 overflow-hidden">
                                                {googleProfile?.email && googleProfile.picture ? (
                                                    <img src={googleProfile.picture} className="w-full h-full object-cover" alt="" />
                                                ) : <Wallet className="w-3 h-3 text-violet-500" />}
                                            </div>
                                        </div>
                                    </div>

                                    {/* Name & Email Block */}
                                    {(user?.google?.name || user?.google?.email) && (
                                        <div className="p-4 bg-white/[0.02] border border-white/5 rounded-xl space-y-1">
                                            {user?.google?.name && (
                                                <p className="text-sm font-bold text-white tracking-tight">{user.google.name}</p>
                                            )}
                                            {user?.google?.email && (
                                                <p className="text-[10px] text-white/40 font-medium tracking-tight truncate">{user.google.email}</p>
                                            )}
                                        </div>
                                    )}

                                    {/* Network & Address Container */}
                                    <div className="p-5 bg-black/40 border border-white/5 rounded-xl space-y-4">
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-white/30 font-bold uppercase tracking-widest">Network</span>
                                            <div className="flex items-center gap-1.5">
                                                <div className="w-1.5 h-1.5 rounded-full bg-violet-500 shadow-[0_0_8px_rgba(168,85,247,0.5)]" />
                                                <span className="text-[10px] text-white font-black uppercase tracking-tight">Stellar Testnet</span>
                                            </div>
                                        </div>
                                        <div className="flex items-center justify-between">
                                            <span className="text-[10px] text-white/30 font-bold uppercase tracking-widest">Address</span>
                                            <button
                                                onClick={() => stellarWallet?.address && navigator.clipboard.writeText(stellarWallet.address)}
                                                className="flex items-center gap-2 group/copy"
                                            >
                                                <span className="text-[10px] text-white/50 font-mono tracking-tighter">
                                                    {stellarWallet?.address ? truncateAddress(stellarWallet.address) : 'Creating...'}
                                                </span>
                                                <Copy className="w-3 h-3 text-white/20 group-hover/copy:text-violet-500 transition-colors" />
                                            </button>
                                        </div>
                                    </div>
                                </div>

                                {/* Funding Section */}
                                <div className="space-y-3">
                                    <div className="grid grid-cols-2 gap-3">
                                        <button
                                            onClick={handleClaimXlmFaucet}
                                            disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                            className="w-full py-4 rounded-xl bg-violet-500 text-black text-[11px] font-black uppercase tracking-[0.25em] hover:bg-violet-400 transition-all flex items-center justify-center gap-2 shadow-[0_0_30px_rgba(168,85,247,0.2)] active:scale-95 disabled:opacity-50"
                                        >
                                            {claimingXlmFaucet ? (
                                                <><Loader2 className="w-4 h-4 animate-spin" /> Funding...</>
                                            ) : (
                                                "Get XLM"
                                            )}
                                        </button>
                                        <button
                                            onClick={handleClaimUsdcFaucet}
                                            disabled={claimingXlmFaucet || claimingUsdcFaucet}
                                            className="w-full py-4 rounded-xl bg-white/[0.03] border border-violet-500/15 text-violet-300 text-[11px] font-black uppercase tracking-[0.25em] hover:bg-violet-500/10 transition-all flex items-center justify-center gap-2 active:scale-95 disabled:opacity-50"
                                        >
                                            {claimingUsdcFaucet ? (
                                                <><Loader2 className="w-4 h-4 animate-spin" /> Preparing...</>
                                            ) : (
                                                "Get USDC"
                                            )}
                                        </button>
                                    </div>
                                    {fundingMessage ? (
                                        <div className="rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
                                            <p className="text-[11px] leading-relaxed text-white/65">{fundingMessage}</p>
                                        </div>
                                    ) : null}
                                </div>

                                {/* Terminate Session */}
                                <button
                                    onClick={() => logout()}
                                    className="w-full py-4 rounded-xl bg-red-500/5 border border-red-500/10 text-red-500 text-[11px] font-black uppercase tracking-[0.25em] hover:bg-red-500/10 transition-all flex items-center justify-center gap-3 active:scale-95 group"
                                >
                                    <LogOut className="w-4 h-4 transition-transform group-hover:translate-x-0.5" />
                                    Terminate Session
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </>
    );
};
