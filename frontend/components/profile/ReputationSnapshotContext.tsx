"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { DEFAULT_PROFILE_AVATAR } from "@/lib/profile-avatar";
import { getPrivyStellarWallet } from "@/lib/stellar";
import {
  cacheReputationSyncMode,
  loadExistingReputationSnapshot,
  loadReputationSnapshot,
  saveReputationSnapshot,
  type ReputationProfileInput,
  type ReputationSnapshot,
  type ReputationSyncMode,
} from "@/lib/reputation-vault";

type ReputationSnapshotContextValue = {
  walletAddress: string;
  snapshot: ReputationSnapshot | null;
  isLoading: boolean;
  hasLoaded: boolean;
  refreshSnapshot: () => Promise<ReputationSnapshot | null>;
  getSnapshot: (defaults?: Partial<ReputationProfileInput>) => Promise<ReputationSnapshot>;
  saveSnapshot: (snapshot: ReputationSnapshot) => Promise<ReputationSnapshot>;
  setSyncMode: (
    syncMode: ReputationSyncMode,
    defaults?: Partial<ReputationProfileInput>,
  ) => ReputationSnapshot | null;
};

const ReputationSnapshotContext = createContext<ReputationSnapshotContextValue | null>(null);

export function ReputationSnapshotProvider({ children }: { children: ReactNode }) {
  const { authenticated, user } = usePrivy();
  const walletAddress = getPrivyStellarWallet(user)?.address ?? "";
  const googleProfile = user?.google as {
    name?: string;
    picture?: string;
    email?: string;
  } | undefined;
  const defaultProfile = useMemo<ReputationProfileInput>(() => ({
    displayName: googleProfile?.name ?? user?.email?.address?.split("@")[0] ?? "Public trader",
    bio: "No public market bio yet. Start participating to build a visible reputation trail.",
    avatarDataUrl: googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR,
  }), [googleProfile?.name, googleProfile?.picture, user?.email?.address]);
  const [snapshot, setSnapshot] = useState<ReputationSnapshot | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadedWalletAddress, setLoadedWalletAddress] = useState("");
  const hasLoaded = Boolean(walletAddress && loadedWalletAddress.toLowerCase() === walletAddress.toLowerCase());

  const refreshSnapshot = useCallback(async () => {
    if (!authenticated || !walletAddress) {
      setSnapshot(null);
      setLoadedWalletAddress("");
      return null;
    }

    setIsLoading(true);
    try {
      const nextSnapshot = await loadExistingReputationSnapshot(walletAddress);
      setSnapshot(nextSnapshot);
      setLoadedWalletAddress(walletAddress);
      return nextSnapshot;
    } finally {
      setIsLoading(false);
    }
  }, [authenticated, walletAddress]);

  const getSnapshot = useCallback(async (defaults?: Partial<ReputationProfileInput>) => {
    if (!walletAddress) {
      throw new Error("Connect your wallet first.");
    }

    const nextSnapshot = await loadReputationSnapshot(walletAddress, defaults ?? defaultProfile);
    setSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [defaultProfile, walletAddress]);

  const saveSnapshot = useCallback(async (nextSnapshot: ReputationSnapshot) => {
    const savedSnapshot = await saveReputationSnapshot(nextSnapshot);
    setSnapshot(savedSnapshot);
    return savedSnapshot;
  }, []);

  const setSyncMode = useCallback((syncMode: ReputationSyncMode, defaults?: Partial<ReputationProfileInput>) => {
    if (!walletAddress) {
      return null;
    }

    const nextSnapshot = cacheReputationSyncMode(walletAddress, syncMode, defaults ?? defaultProfile);
    setSnapshot(nextSnapshot);
    return nextSnapshot;
  }, [defaultProfile, walletAddress]);

  useEffect(() => {
    let mounted = true;

    if (!authenticated || !walletAddress) {
      setSnapshot(null);
      setIsLoading(false);
      setLoadedWalletAddress("");
      return;
    }

    setIsLoading(true);
    setLoadedWalletAddress("");
    loadExistingReputationSnapshot(walletAddress)
      .then((nextSnapshot) => {
        if (mounted) {
          setSnapshot(nextSnapshot);
          setLoadedWalletAddress(walletAddress);
        }
      })
      .catch(() => {
        if (mounted) {
          setSnapshot(null);
          setLoadedWalletAddress(walletAddress);
        }
      })
      .finally(() => {
        if (mounted) {
          setIsLoading(false);
        }
      });

    return () => {
      mounted = false;
    };
  }, [authenticated, walletAddress]);

  const value = useMemo<ReputationSnapshotContextValue>(() => ({
    walletAddress,
    snapshot,
    isLoading,
    hasLoaded,
    refreshSnapshot,
    getSnapshot,
    saveSnapshot,
    setSyncMode,
  }), [getSnapshot, hasLoaded, isLoading, refreshSnapshot, saveSnapshot, setSyncMode, snapshot, walletAddress]);

  return (
    <ReputationSnapshotContext.Provider value={value}>
      {children}
    </ReputationSnapshotContext.Provider>
  );
}

export function useReputationSnapshotContext() {
  const context = useContext(ReputationSnapshotContext);
  if (!context) {
    throw new Error("useReputationSnapshotContext must be used inside ReputationSnapshotProvider");
  }

  return context;
}
