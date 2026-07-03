import type { AttestedReputationRecord } from "@/lib/reputation";
import { profileBackendUrl } from "@/lib/profile-backend";
import type { BlindPositionRecord } from "@/lib/types";
import type { StoredReputationCredential } from "@/lib/reputation-vault";

export type ReputationShareSnapshot = {
  profile: {
    displayName: string;
    bio: string;
    avatarDataUrl: string | null;
  };
  summary: {
    totalMarkets: number;
    totalCollateralInStroops: string;
    totalCategories: number;
    categories: string[];
  };
  attestedRecords: AttestedReputationRecord[];
  achievements: StoredReputationCredential[];
  positions?: BlindPositionRecord[];
};

export type ReputationShareRecord = {
  walletAddress: string;
  slug: string;
  version: number;
  shareUrl: string;
  snapshot: ReputationShareSnapshot;
  createdAt: number;
  updatedAt: number;
};

export type ReputationShareInput = {
  walletAddress: string;
  snapshot: ReputationShareSnapshot;
};

export function reputationSharePath(slug: string) {
  return `/reputation/share/${slug}`;
}

export async function createReputationShare(input: ReputationShareInput): Promise<ReputationShareRecord> {
  const response = await fetch(profileBackendUrl("/reputation-shares"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? "Failed to create reputation share");
  }

  const data = await response.json() as { share: ReputationShareRecord };
  return data.share;
}

export async function fetchReputationShare(slug: string): Promise<ReputationShareRecord | null> {
  const response = await fetch(profileBackendUrl(`/reputation-shares/${encodeURIComponent(slug)}`), {
    method: "GET",
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to fetch reputation share");
  }

  const data = await response.json() as { share: ReputationShareRecord | null };
  return data.share;
}
