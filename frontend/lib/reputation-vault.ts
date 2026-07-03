import { fetchPublicProfile, upsertPublicProfile } from "@/lib/public-profile";
import { profileBackendUrl } from "@/lib/profile-backend";
import { loadSavedPositions } from "@/lib/blind-market";
import type { BlindPositionRecord } from "@/lib/types";
import type {
  AttestedReputationRecord,
  PrivateReputationWitness,
  SerializedReputationClaimDescriptor,
} from "@/lib/reputation";

export type ReputationSyncMode = "server" | "local";

export type StoredReputationCredential = {
  serialized: string;
  proofHex: string;
  publicInputsHex: string[];
  snapshotRoot: string;
  attestorKeyId: string;
  proofValid: boolean;
  snapshotVerified: boolean;
  displayOrder?: number;
  archivedAt?: number | null;
  publicClaim: {
    subjectId: string;
    category: string;
    windowDays: number;
    snapshotRoot: string;
    attestorKeyId: string;
    createdAt: number;
    snapshotRecordCount: number;
    statement: string;
  };
  createdAt: number;
  claim: SerializedReputationClaimDescriptor;
};

export type ReputationSnapshot = {
  walletAddress: string;
  syncMode: ReputationSyncMode;
  profile: {
    displayName: string;
    bio: string;
    avatarDataUrl: string | null;
  };
  positions: BlindPositionRecord[];
  attestedRecords: AttestedReputationRecord[];
  privateReputationWitnesses: PrivateReputationWitness[];
  achievements: StoredReputationCredential[];
  updatedAt: number;
};

export type ReputationProfileInput = {
  displayName: string;
  bio: string;
  avatarDataUrl: string | null;
};

const SYNC_MODE_KEY_PREFIX = "aegis-reputation-sync-mode-v1:";
const LOCAL_SNAPSHOT_KEY_PREFIX = "aegis-reputation-snapshot-v1:";
const LEGACY_SYNC_MODE_KEY_PREFIX = "verdict-reputation-sync-mode-v1:";
const LEGACY_LOCAL_SNAPSHOT_KEY_PREFIX = "verdict-reputation-snapshot-v1:";
function syncModeKey(walletAddress: string) {
  return `${SYNC_MODE_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function localSnapshotKey(walletAddress: string) {
  return `${LOCAL_SNAPSHOT_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function legacySyncModeKey(walletAddress: string) {
  return `${LEGACY_SYNC_MODE_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function legacyLocalSnapshotKey(walletAddress: string) {
  return `${LEGACY_LOCAL_SNAPSHOT_KEY_PREFIX}${walletAddress.toLowerCase()}`;
}

function cloneSnapshot(snapshot: ReputationSnapshot): ReputationSnapshot {
  return JSON.parse(JSON.stringify(snapshot, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  ))) as ReputationSnapshot;
}

function normalizeSnapshot(snapshot: ReputationSnapshot, syncMode: ReputationSyncMode): ReputationSnapshot {
  return {
    ...cloneSnapshot(snapshot),
    syncMode,
  };
}

function emptySnapshot(walletAddress: string, syncMode: ReputationSyncMode = "server"): ReputationSnapshot {
  return {
    walletAddress,
    syncMode,
    profile: {
      displayName: "",
      bio: "",
      avatarDataUrl: null,
    },
    positions: [],
    attestedRecords: [],
    privateReputationWitnesses: [],
    achievements: [],
    updatedAt: Date.now(),
  };
}

function mergePositionRecords(primary: BlindPositionRecord[], fallback: BlindPositionRecord[]) {
  const merged = new Map<string, BlindPositionRecord>();

  for (const entry of fallback) {
    merged.set(entry.commitment, entry);
  }

  for (const entry of primary) {
    merged.set(entry.commitment, entry);
  }

  return Array.from(merged.values());
}

function mergeCredentials(
  primary: StoredReputationCredential[],
  fallback: StoredReputationCredential[],
) {
  const merged = new Map<string, StoredReputationCredential>();

  for (const entry of fallback) {
    merged.set(entry.serialized, entry);
  }

  for (const entry of primary) {
    merged.set(entry.serialized, entry);
  }

  return Array.from(merged.values()).sort((left, right) => {
    const leftOrder = left.displayOrder;
    const rightOrder = right.displayOrder;
    if (typeof leftOrder === "number" || typeof rightOrder === "number") {
      if (typeof leftOrder !== "number") return 1;
      if (typeof rightOrder !== "number") return -1;
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
    }
    return right.createdAt - left.createdAt;
  });
}

function mergeAttestedRecords(
  primary: AttestedReputationRecord[],
  fallback: AttestedReputationRecord[],
) {
  const merged = new Map<string, AttestedReputationRecord>();

  for (const entry of fallback) {
    merged.set(entry.recordCommitment, entry);
  }

  for (const entry of primary) {
    merged.set(entry.recordCommitment, entry);
  }

  return Array.from(merged.values()).sort((left, right) => right.claimedAt - left.claimedAt);
}

function mergePrivateWitnesses(
  primary: PrivateReputationWitness[],
  fallback: PrivateReputationWitness[],
) {
  const merged = new Map<string, PrivateReputationWitness>();

  for (const entry of fallback) {
    merged.set(entry.recordCommitment, entry);
  }

  for (const entry of primary) {
    merged.set(entry.recordCommitment, entry);
  }

  return Array.from(merged.values()).sort((left, right) => right.claimedAt - left.claimedAt);
}

function mergeSnapshots(primary: ReputationSnapshot, fallback: ReputationSnapshot): ReputationSnapshot {
  return {
    walletAddress: primary.walletAddress,
    syncMode: primary.syncMode,
    profile: {
      displayName: primary.profile.displayName || fallback.profile.displayName,
      bio: primary.profile.bio || fallback.profile.bio,
      avatarDataUrl: primary.profile.avatarDataUrl ?? fallback.profile.avatarDataUrl,
    },
    positions: mergePositionRecords(primary.positions, fallback.positions),
    attestedRecords: mergeAttestedRecords(primary.attestedRecords, fallback.attestedRecords),
    privateReputationWitnesses: mergePrivateWitnesses(primary.privateReputationWitnesses, fallback.privateReputationWitnesses),
    achievements: mergeCredentials(primary.achievements, fallback.achievements),
    updatedAt: Math.max(primary.updatedAt ?? 0, fallback.updatedAt ?? 0, Date.now()),
  };
}

function readStoredSyncMode(walletAddress: string): ReputationSyncMode | null {
  if (typeof window === "undefined") {
    return null;
  }

  const raw = window.localStorage.getItem(syncModeKey(walletAddress))
    ?? window.localStorage.getItem(legacySyncModeKey(walletAddress));
  return raw === "local" || raw === "server" ? raw : null;
}

function writeStoredSyncMode(walletAddress: string, syncMode: ReputationSyncMode) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(syncModeKey(walletAddress), syncMode);
}

function readLocalSnapshot(walletAddress: string): ReputationSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(localSnapshotKey(walletAddress))
      ?? window.localStorage.getItem(legacyLocalSnapshotKey(walletAddress));
    if (!raw) {
      const legacyPositions = loadSavedPositions().filter((position) => position.owner.toLowerCase() === walletAddress.toLowerCase());
      if (legacyPositions.length === 0) {
        return null;
      }

      return {
        ...emptySnapshot(walletAddress, "local"),
        positions: legacyPositions,
        updatedAt: Date.now(),
      };
    }
    const parsed = JSON.parse(raw) as ReputationSnapshot;
    if (!parsed.walletAddress) {
      parsed.walletAddress = walletAddress;
    }
    if (!Array.isArray(parsed.positions) || parsed.positions.length === 0) {
      const legacyPositions = loadSavedPositions().filter((position) => position.owner.toLowerCase() === walletAddress.toLowerCase());
      if (legacyPositions.length > 0) {
        parsed.positions = legacyPositions;
      }
    }
    if (!Array.isArray(parsed.achievements)) {
      parsed.achievements = [];
    }
    if (!Array.isArray(parsed.attestedRecords)) {
      parsed.attestedRecords = [];
    }
    if (!Array.isArray(parsed.privateReputationWitnesses)) {
      parsed.privateReputationWitnesses = [];
    }
    if (!parsed.profile) {
      parsed.profile = emptySnapshot(walletAddress, "local").profile;
    }
    parsed.syncMode = "local";
    return parsed;
  } catch {
    const legacyPositions = loadSavedPositions().filter((position) => position.owner.toLowerCase() === walletAddress.toLowerCase());
    if (legacyPositions.length === 0) {
      return null;
    }

    return {
      ...emptySnapshot(walletAddress, "local"),
      positions: legacyPositions,
      updatedAt: Date.now(),
    };
  }
}

function writeLocalSnapshot(snapshot: ReputationSnapshot) {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.setItem(localSnapshotKey(snapshot.walletAddress), JSON.stringify(snapshot, (_key, value) => (
    typeof value === "bigint" ? value.toString() : value
  ), 2));
  writeStoredSyncMode(snapshot.walletAddress, "local");
}

async function readServerSnapshot(walletAddress: string): Promise<ReputationSnapshot | null> {
  const [profile, vault, attestedRecords] = await Promise.all([
    fetchPublicProfile(walletAddress).catch(() => null),
    fetchReputationVault(walletAddress).catch(() => null),
    fetchAttestedRecords(walletAddress).catch(() => null),
  ]);

  if (!profile && !vault && !attestedRecords) {
    return null;
  }

  return {
    walletAddress,
    syncMode: profile?.syncMode === "local" ? "local" : "server",
    profile: {
      displayName: profile?.displayName ?? "",
      bio: profile?.bio ?? "",
      avatarDataUrl: profile?.avatarDataUrl ?? null,
    },
    positions: vault?.positions ?? [],
    attestedRecords: attestedRecords ?? vault?.attestedRecords ?? [],
    privateReputationWitnesses: [],
    achievements: vault?.achievements ?? [],
    updatedAt: vault?.updatedAt ?? Date.now(),
  };
}

export async function fetchReputationVault(walletAddress: string): Promise<Omit<ReputationSnapshot, "profile"> | null> {
  const response = await fetch(profileBackendUrl(`/vault/${encodeURIComponent(walletAddress)}`), {
    method: "GET",
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to fetch reputation vault");
  }

  const data = await response.json() as {
    vault: {
      walletAddress: string;
      syncMode: ReputationSyncMode;
      positions: BlindPositionRecord[];
      attestedRecords: AttestedReputationRecord[];
      achievements: StoredReputationCredential[];
      updatedAt: number;
    } | null;
  };

  if (!data.vault) {
    return null;
  }

  return {
    walletAddress: data.vault.walletAddress,
    syncMode: data.vault.syncMode,
    positions: data.vault.positions ?? [],
    attestedRecords: data.vault.attestedRecords ?? [],
    privateReputationWitnesses: [],
    achievements: data.vault.achievements ?? [],
    updatedAt: data.vault.updatedAt ?? Date.now(),
  };
}

export async function fetchAttestedRecords(walletAddress: string): Promise<AttestedReputationRecord[]> {
  const response = await fetch(profileBackendUrl(`/reputation-records/${encodeURIComponent(walletAddress)}`), {
    method: "GET",
    cache: "no-store",
  });

  if (response.status === 404) {
    return [];
  }

  if (!response.ok) {
    throw new Error("Failed to fetch attested reputation records");
  }

  const data = await response.json() as { records?: AttestedReputationRecord[] };
  return Array.isArray(data.records) ? data.records : [];
}

export async function attestClaimRecord(input: {
  walletAddress: string;
  marketId: string;
  commitment: string;
  nullifier: string;
  claimTxHash: string;
  category: string;
  recordCommitment: string;
  witnessSalt: string;
  claimedAt: number;
}) {
  const response = await fetch(profileBackendUrl("/reputation/attest-claim"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  const data = await response.json().catch(() => null) as { error?: string; record?: AttestedReputationRecord } | null;
  if (!response.ok || !data?.record) {
    throw new Error(data?.error ?? "Failed to attest claim");
  }
  return data.record;
}

export async function upsertReputationVault(snapshot: ReputationSnapshot) {
  const response = await fetch(profileBackendUrl("/vault/upsert"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      walletAddress: snapshot.walletAddress,
      syncMode: snapshot.syncMode,
      positions: snapshot.positions,
      attestedRecords: snapshot.attestedRecords,
      achievements: snapshot.achievements,
    }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? "Failed to save reputation vault");
  }

  return response.json() as Promise<{
    vault: {
      walletAddress: string;
      syncMode: ReputationSyncMode;
      positions: BlindPositionRecord[];
      attestedRecords: AttestedReputationRecord[];
      achievements: StoredReputationCredential[];
      updatedAt: number;
    };
  }>;
}

export async function loadReputationSnapshot(walletAddress: string, defaults?: Partial<ReputationProfileInput>): Promise<ReputationSnapshot> {
  const existing = await loadExistingReputationSnapshot(walletAddress);
  if (existing) {
    return existing;
  }

  const storedMode = readStoredSyncMode(walletAddress) ?? "server";
  return {
    ...emptySnapshot(walletAddress, storedMode),
    profile: {
      displayName: defaults?.displayName ?? "",
      bio: defaults?.bio ?? "",
      avatarDataUrl: defaults?.avatarDataUrl ?? null,
    },
  };
}

export async function loadExistingReputationSnapshot(walletAddress: string): Promise<ReputationSnapshot | null> {
  const storedMode = readStoredSyncMode(walletAddress) ?? "server";

  if (storedMode === "local") {
    const localSnapshot = readLocalSnapshot(walletAddress);
    return localSnapshot ? normalizeSnapshot(localSnapshot, "local") : null;
  }

  const localSnapshot = readLocalSnapshot(walletAddress);
  const serverSnapshot = await readServerSnapshot(walletAddress).catch(() => null);

  if (serverSnapshot && localSnapshot) {
    return mergeSnapshots(serverSnapshot, localSnapshot);
  }

  if (serverSnapshot) {
    return normalizeSnapshot(serverSnapshot, "server");
  }

  if (localSnapshot) {
    return normalizeSnapshot(localSnapshot, "server");
  }

  return null;
}

export async function saveReputationSnapshot(snapshot: ReputationSnapshot) {
  const localSnapshot = readLocalSnapshot(snapshot.walletAddress);
  const nextSnapshot = cloneSnapshot({
    ...(snapshot.syncMode === "server" && localSnapshot ? mergeSnapshots(snapshot, localSnapshot) : snapshot),
    updatedAt: Date.now(),
  });

  if (nextSnapshot.syncMode === "local") {
    writeLocalSnapshot(nextSnapshot);
    return nextSnapshot;
  }

  await upsertPublicProfile({
    walletAddress: nextSnapshot.walletAddress,
    displayName: nextSnapshot.profile.displayName,
    bio: nextSnapshot.profile.bio,
    avatarDataUrl: nextSnapshot.profile.avatarDataUrl,
    syncMode: "server",
    source: "privy",
  });
  await upsertReputationVault(nextSnapshot);

  if (typeof window !== "undefined") {
    writeStoredSyncMode(nextSnapshot.walletAddress, "server");
    window.localStorage.setItem(
      localSnapshotKey(nextSnapshot.walletAddress),
      JSON.stringify({
        ...nextSnapshot,
        syncMode: "local",
      }, null, 2),
    );
  }

  return nextSnapshot;
}

export async function switchReputationSyncMode(
  walletAddress: string,
  nextMode: ReputationSyncMode,
  defaults?: Partial<ReputationProfileInput>,
) {
  if (nextMode === "local") {
    const current = readLocalSnapshot(walletAddress) ?? emptySnapshot(walletAddress, "local");
    const snapshot: ReputationSnapshot = {
      ...current,
      syncMode: "local",
      profile: {
        displayName: current.profile.displayName || defaults?.displayName || "",
        bio: current.profile.bio || defaults?.bio || "",
        avatarDataUrl: current.profile.avatarDataUrl ?? defaults?.avatarDataUrl ?? null,
      },
      updatedAt: Date.now(),
    };

    return saveReputationSnapshot(snapshot);
  }

  const current = await loadReputationSnapshot(walletAddress, defaults);
  const snapshot: ReputationSnapshot = {
    ...current,
    syncMode: "server",
    profile: {
      displayName: current.profile.displayName || defaults?.displayName || "",
      bio: current.profile.bio || defaults?.bio || "",
      avatarDataUrl: current.profile.avatarDataUrl ?? defaults?.avatarDataUrl ?? null,
    },
    updatedAt: Date.now(),
  };

  return saveReputationSnapshot(snapshot);
}

export async function updateReputationProfile(
  walletAddress: string,
  profile: ReputationProfileInput,
  syncMode?: ReputationSyncMode,
) {
  const current = await loadReputationSnapshot(walletAddress, profile);
  return saveReputationSnapshot({
    ...current,
    syncMode: syncMode ?? current.syncMode,
    profile,
    updatedAt: Date.now(),
  });
}

export async function upsertCommittedPosition(walletAddress: string, position: BlindPositionRecord) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const positions = snapshot.positions.filter((entry) => entry.commitment !== position.commitment);
  positions.unshift(position);
  return saveReputationSnapshot({
    ...snapshot,
    positions,
    updatedAt: Date.now(),
  });
}

export async function markClaimedPosition(
  walletAddress: string,
  commitment: string,
  patch: Partial<BlindPositionRecord>,
) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const positions = snapshot.positions.map((entry) => (
    entry.commitment === commitment ? { ...entry, ...patch } : entry
  ));
  return saveReputationSnapshot({
    ...snapshot,
    positions,
    updatedAt: Date.now(),
  });
}

export async function upsertAttestedRecord(walletAddress: string, attestedRecord: AttestedReputationRecord) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const attestedRecords = [
    attestedRecord,
    ...snapshot.attestedRecords.filter((entry) => entry.recordCommitment !== attestedRecord.recordCommitment),
  ];
  return saveReputationSnapshot({
    ...snapshot,
    attestedRecords,
    updatedAt: Date.now(),
  });
}

export async function upsertPrivateReputationWitness(walletAddress: string, witness: PrivateReputationWitness) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const privateReputationWitnesses = [
    witness,
    ...snapshot.privateReputationWitnesses.filter((entry) => entry.recordCommitment !== witness.recordCommitment),
  ];
  return saveReputationSnapshot({
    ...snapshot,
    privateReputationWitnesses,
    updatedAt: Date.now(),
  });
}

export async function upsertAchievement(walletAddress: string, achievement: StoredReputationCredential) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const achievements = [
    achievement,
    ...snapshot.achievements.filter((entry) => entry.serialized !== achievement.serialized),
  ];
  return saveReputationSnapshot({
    ...snapshot,
    achievements,
    updatedAt: Date.now(),
  });
}

export async function archiveAchievement(walletAddress: string, serialized: string, archived = true) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const achievements = snapshot.achievements.map((entry) => (
    entry.serialized === serialized
      ? { ...entry, archivedAt: archived ? Date.now() : null }
      : entry
  ));
  return saveReputationSnapshot({
    ...snapshot,
    achievements,
    updatedAt: Date.now(),
  });
}

export async function removeAchievement(walletAddress: string, serialized: string) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  const achievements = snapshot.achievements.filter((entry) => entry.serialized !== serialized);
  return saveReputationSnapshot({
    ...snapshot,
    achievements,
    updatedAt: Date.now(),
  });
}

export async function replaceAchievements(walletAddress: string, achievements: StoredReputationCredential[]) {
  const snapshot = await loadReputationSnapshot(walletAddress);
  return saveReputationSnapshot({
    ...snapshot,
    achievements,
  });
}

export function getReputationSyncMode(walletAddress: string) {
  return readStoredSyncMode(walletAddress) ?? "server";
}

export function loadLocalReputationSnapshot(walletAddress: string) {
  return readLocalSnapshot(walletAddress);
}
