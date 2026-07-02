"use client";

import { useEffect, useState } from "react";
import { PrivyProvider } from '@privy-io/react-auth';
import { usePrivy } from '@privy-io/react-auth';
import { useCreateWallet } from '@privy-io/react-auth/extended-chains';
import { Buffer } from "buffer";
import { ensurePrivyStellarWallet, isPrivyStellarWalletLimitError } from "@/lib/privy-stellar-wallet";
import { getPrivyStellarWallet } from "@/lib/stellar";
import { PublicProfileOnboardingModal } from "@/components/profile/PublicProfileOnboardingModal";
import { PublicProfileSettingsModal } from "@/components/profile/PublicProfileSettingsModal";
import { loadExistingReputationSnapshot } from "@/lib/reputation-vault";

function installBigIntBufferPolyfill() {
    type BigIntBufferMethods = {
        writeBigUInt64BE?: (value: bigint, offset?: number) => number;
        readBigUInt64BE?: (offset?: number) => bigint;
        writeBigInt64BE?: (value: bigint, offset?: number) => number;
        readBigInt64BE?: (offset?: number) => bigint;
    };

    const installOnPrototype = (prototype: Uint8Array & BigIntBufferMethods) => {
        if (!prototype.writeBigUInt64BE) {
            prototype.writeBigUInt64BE = function writeBigUInt64BE(value: bigint, offset = 0) {
                let remaining = BigInt.asUintN(64, value);
                for (let index = 7; index >= 0; index -= 1) {
                    this[offset + index] = Number(remaining & 0xffn);
                    remaining >>= 8n;
                }
                return offset + 8;
            };
        }

        if (!prototype.readBigUInt64BE) {
            prototype.readBigUInt64BE = function readBigUInt64BE(offset = 0) {
                let value = 0n;
                for (let index = 0; index < 8; index += 1) {
                    value = (value << 8n) | BigInt(this[offset + index] ?? 0);
                }
                return value;
            };
        }

        if (!prototype.writeBigInt64BE) {
            prototype.writeBigInt64BE = function writeBigInt64BE(value: bigint, offset = 0) {
                return this.writeBigUInt64BE!(BigInt.asUintN(64, value), offset);
            };
        }

        if (!prototype.readBigInt64BE) {
            prototype.readBigInt64BE = function readBigInt64BE(offset = 0) {
                const value = this.readBigUInt64BE!(offset);
                return value > 0x7fffffffffffffffn ? value - 0x10000000000000000n : value;
            };
        }
    };

    const bufferPrototype = Buffer.prototype as Buffer & {
        writeBigUInt64BE?: (value: bigint, offset?: number) => number;
        readBigUInt64BE?: (offset?: number) => bigint;
        writeBigInt64BE?: (value: bigint, offset?: number) => number;
        readBigInt64BE?: (offset?: number) => bigint;
    };
    installOnPrototype(bufferPrototype);
    installOnPrototype(Uint8Array.prototype as Uint8Array & BigIntBufferMethods);
}

if (typeof globalThis !== "undefined") {
    (globalThis as typeof globalThis & { Buffer?: typeof Buffer }).Buffer = Buffer;
    installBigIntBufferPolyfill();
}

function PrivyStellarProvisioner({ children }: { children: React.ReactNode }) {
    const { authenticated, user } = usePrivy();
    const { createWallet } = useCreateWallet();
    const stellarWallet = getPrivyStellarWallet(user);

    useEffect(() => {
        if (!authenticated || stellarWallet) {
            return;
        }

        ensurePrivyStellarWallet({
            authenticated,
            hasWallet: Boolean(stellarWallet),
            createWallet,
        }).catch((error) => {
            if (isPrivyStellarWalletLimitError(error)) {
                console.warn("Privy Stellar wallet limit reached for this user.");
                return;
            }

            console.error("Failed to auto-provision Privy Stellar wallet:", error);
        });
    }, [authenticated, stellarWallet, createWallet]);

    return <>{children}</>;
}

function PublicProfileGate({ children }: { children: React.ReactNode }) {
    const { authenticated, user } = usePrivy();
    const stellarWallet = getPrivyStellarWallet(user);
    const [isOnboardingOpen, setIsOnboardingOpen] = useState(false);
    const [isSettingsOpen, setIsSettingsOpen] = useState(false);

    useEffect(() => {
        if (!authenticated || !stellarWallet?.address) {
            return;
        }

        let mounted = true;

        const run = async () => {
            try {
                const profile = await loadExistingReputationSnapshot(stellarWallet.address);
                if (mounted) {
                    setIsOnboardingOpen(!profile || !profile.profile.displayName.trim() || !profile.profile.bio.trim());
                }
            } catch {
                if (mounted) {
                    setIsOnboardingOpen(true);
                }
            }
        };

        void run();

        return () => {
            mounted = false;
        };
    }, [authenticated, stellarWallet?.address]);

    useEffect(() => {
        const openProfileSettings = () => setIsSettingsOpen(true);
        window.addEventListener("verdict-open-profile-settings", openProfileSettings as EventListener);
        window.addEventListener("aegis-open-profile-settings", openProfileSettings as EventListener);
        return () => {
            window.removeEventListener("verdict-open-profile-settings", openProfileSettings as EventListener);
            window.removeEventListener("aegis-open-profile-settings", openProfileSettings as EventListener);
        };
    }, []);

    return (
        <>
            {children}
            <PublicProfileOnboardingModal
                isOpen={authenticated && Boolean(stellarWallet?.address) && isOnboardingOpen}
                onOpenChange={setIsOnboardingOpen}
            />
            <PublicProfileSettingsModal
                isOpen={authenticated && Boolean(stellarWallet?.address) && isSettingsOpen}
                onOpenChange={setIsSettingsOpen}
            />
        </>
    );
}

export default function Providers({ children }: { children: React.ReactNode }) {
    return (
        <PrivyProvider
            appId="cmh5eorlh00njkw0b5bzymlcv"
            config={{
                loginMethods: ['wallet', 'google', 'email'],
                appearance: {
                    theme: 'dark',
                    accentColor: '#a855f7', // violet-500
                    showWalletLoginFirst: false,
                },
                embeddedWallets: {
                    showWalletUIs: true,
                },
            }}
        >
            <PrivyStellarProvisioner>
                <PublicProfileGate>{children}</PublicProfileGate>
            </PrivyStellarProvisioner>
        </PrivyProvider>
    );
}
