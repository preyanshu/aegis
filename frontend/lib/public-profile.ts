import { profileBackendUrl } from "@/lib/profile-backend";

export type PublicProfile = {
  walletAddress: string;
  displayName: string;
  avatarDataUrl: string | null;
  bio: string | null;
  syncMode: "server" | "local";
  source: string;
  onboardedAt: string | null;
  lastSeenAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type PublicProfileUpsertInput = {
  walletAddress: string;
  displayName: string;
  avatarDataUrl?: string | null;
  bio?: string | null;
  syncMode?: "server" | "local";
  source?: string;
}

export async function fetchPublicProfile(walletAddress: string): Promise<PublicProfile | null> {
  const response = await fetch(profileBackendUrl(`/profiles/${encodeURIComponent(walletAddress)}`), {
    method: "GET",
    cache: "no-store",
  });

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error("Failed to fetch public profile");
  }

  const data = await response.json() as { profile: PublicProfile | null };
  return data.profile;
}

export async function upsertPublicProfile(input: PublicProfileUpsertInput): Promise<PublicProfile> {
  const response = await fetch(profileBackendUrl("/profiles/upsert"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? "Failed to save public profile");
  }

  const data = await response.json() as { profile: PublicProfile };
  return data.profile;
}
