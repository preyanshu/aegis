"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Cloud, Loader2, Lock, Upload, X } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { DEFAULT_PROFILE_AVATAR } from "@/lib/profile-avatar";
import { getPrivyStellarWallet } from "@/lib/stellar";
import { useReputationSnapshotContext } from "@/components/profile/ReputationSnapshotContext";
import {
  loadExistingReputationSnapshot,
  type ReputationSyncMode,
} from "@/lib/reputation-vault";

type PublicProfileSettingsModalProps = {
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
};

export function PublicProfileSettingsModal({ isOpen, onOpenChange }: PublicProfileSettingsModalProps) {
  const { user } = usePrivy();
  const {
    snapshot: contextSnapshot,
    getSnapshot,
    saveSnapshot,
    setSyncMode: setContextSyncMode,
  } = useReputationSnapshotContext();
  const walletAddress = getPrivyStellarWallet(user)?.address ?? "";
  const googleProfile = user?.google as {
    name?: string;
    picture?: string;
    email?: string;
  } | undefined;

  const defaultName = useMemo(
    () => googleProfile?.name ?? user?.email?.address?.split("@")[0] ?? "Public trader",
    [googleProfile?.name, user?.email?.address],
  );
  const defaultAvatar = googleProfile?.picture ?? DEFAULT_PROFILE_AVATAR;
  const defaultBio = "Trading on Aegis with a public reputation profile.";

  const [displayName, setDisplayName] = useState(defaultName);
  const [avatarDataUrl, setAvatarDataUrl] = useState(defaultAvatar || "");
  const [bio, setBio] = useState(defaultBio);
  const [syncMode, setSyncMode] = useState<ReputationSyncMode>("server");
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [statusTone, setStatusTone] = useState<"success" | "error">("success");

  function applySnapshot(snapshot: NonNullable<typeof contextSnapshot>) {
    setDisplayName(snapshot.profile.displayName || defaultName);
    setAvatarDataUrl(snapshot.profile.avatarDataUrl || defaultAvatar || "");
    setBio(snapshot.profile.bio || defaultBio);
    setSyncMode(snapshot.syncMode);
  }

  function handleSyncModeChange(nextMode: ReputationSyncMode) {
    setSyncMode(nextMode);
    if (!walletAddress) {
      return;
    }

    const snapshot = setContextSyncMode(nextMode, {
      displayName: displayName.trim() || defaultName,
      bio: bio.trim() || defaultBio,
      avatarDataUrl: avatarDataUrl || defaultAvatar || null,
    });
    if (snapshot) {
      applySnapshot(snapshot);
    }
  }

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    setStatus("");
    setStatusTone("success");
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !walletAddress) {
      return;
    }

    let mounted = true;

    const run = async () => {
      try {
        setIsPrefilling(true);
        const existing = contextSnapshot ?? await loadExistingReputationSnapshot(walletAddress);
        if (!mounted) return;

        if (existing) {
          applySnapshot(existing);
        } else {
          setDisplayName(defaultName);
          setAvatarDataUrl(defaultAvatar || "");
          setBio(defaultBio);
          setSyncMode("server");
        }
      } catch {
        if (!mounted) return;
        setDisplayName(defaultName);
        setAvatarDataUrl(defaultAvatar || "");
        setBio(defaultBio);
        setSyncMode("server");
      } finally {
        if (mounted) {
          setIsPrefilling(false);
        }
      }
    };

    void run();

    return () => {
      mounted = false;
    };
  }, [contextSnapshot, defaultAvatar, defaultBio, defaultName, isOpen, walletAddress]);

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setStatusTone("error");
      setStatus("Please choose an image file for your avatar.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAvatarDataUrl(typeof reader.result === "string" ? reader.result : "");
      setStatus("");
    };
    reader.onerror = () => {
      setStatusTone("error");
      setStatus("Could not read the selected image.");
    };
    reader.readAsDataURL(file);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!walletAddress) {
      setStatusTone("error");
      setStatus("Connect your wallet first.");
      return;
    }

    if (!displayName.trim() || !bio.trim()) {
      setStatusTone("error");
      setStatus("Name and bio are required.");
      return;
    }

    setIsSaving(true);
    setStatus("");
    setStatusTone("success");

    try {
      const saveStartedAt = Date.now();
      const current = contextSnapshot ?? await getSnapshot({
        displayName: defaultName,
        bio: defaultBio,
        avatarDataUrl: defaultAvatar || null,
      });

      const saved = await saveSnapshot({
        ...current,
        walletAddress,
        syncMode,
        profile: {
          displayName: displayName.trim(),
          bio: bio.trim(),
          avatarDataUrl: avatarDataUrl || defaultAvatar || null,
        },
      });
      applySnapshot(saved);

      const elapsed = Date.now() - saveStartedAt;
      if (elapsed < 350) {
        await new Promise((resolve) => setTimeout(resolve, 350 - elapsed));
      }

      setStatusTone("success");
      setStatus(syncMode === "server" ? "Profile saved and synced." : "Profile saved locally.");
    } catch (error) {
      setStatusTone("error");
      setStatus(error instanceof Error ? error.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AnimatePresence>
      {isOpen ? (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-3 py-4 sm:px-4">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => onOpenChange(false)}
            className="absolute inset-0 bg-black/75 backdrop-blur-xl"
          />

          <motion.div
            initial={{ opacity: 0, scale: 0.98, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: 12 }}
            className="relative w-full max-w-[42rem] overflow-hidden rounded-[16px] border border-white/10 bg-[#0b0b0d] shadow-[0_20px_64px_rgba(0,0,0,0.42)]"
          >
            <div className="flex items-start justify-between border-b border-white/10 px-5 py-5 sm:px-6">
              <div>
                <p className="font-mono text-[11px] uppercase tracking-[0.14em] text-white/32">Profile settings</p>
                <h2 className="mt-2 text-[26px] font-semibold tracking-[-0.04em] text-white">Edit your public profile</h2>
                <p className="mt-2 max-w-lg text-[13px] leading-6 text-white/55">
                  Update the public identity shown on your reputation page and choose how your vault is stored.
                </p>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/55 transition hover:bg-white/[0.06] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-5 px-5 py-5 sm:px-6">
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Storage mode</p>
                  <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-white/32">
                    {syncMode === "server" ? "Server-backed" : "Local only"}
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => handleSyncModeChange("server")}
                    className={`rounded-[14px] border p-4 text-left transition ${
                      syncMode === "server"
                        ? "border-white/30 bg-white/[0.06]"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
                        <Cloud className="h-4 w-4 text-[#7928ca]" />
                      </div>
                      <div className={`h-5 w-5 rounded-full border ${syncMode === "server" ? "border-white/15 bg-white" : "border-white/12 bg-transparent"}`}>
                        {syncMode === "server" ? <Check className="mx-auto mt-1 h-3 w-3 text-black" /> : null}
                      </div>
                    </div>
                    <p className="mt-4 text-[15px] font-semibold tracking-[-0.02em] text-white">Server-backed</p>
                    <p className="mt-2 text-[13px] leading-6 text-white/58">
                      Sync your public profile and reputation vault across devices.
                    </p>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleSyncModeChange("local")}
                    className={`rounded-[14px] border p-4 text-left transition ${
                      syncMode === "local"
                        ? "border-white/30 bg-white/[0.06]"
                        : "border-white/10 bg-white/[0.02] hover:border-white/20"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
                        <Lock className="h-4 w-4 text-[#7928ca]" />
                      </div>
                      <div className={`h-5 w-5 rounded-full border ${syncMode === "local" ? "border-white/15 bg-white" : "border-white/12 bg-transparent"}`}>
                        {syncMode === "local" ? <Check className="mx-auto mt-1 h-3 w-3 text-black" /> : null}
                      </div>
                    </div>
                    <p className="mt-4 text-[15px] font-semibold tracking-[-0.02em] text-white">Local only</p>
                    <p className="mt-2 text-[13px] leading-6 text-white/58">
                      Keep commits, positions, claims, witnesses, and creds in this browser only.
                    </p>
                  </button>
                </div>
              </section>

              <section className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_220px] sm:items-stretch">
                <div className="flex h-full flex-col gap-4">
                  <label className="block space-y-2">
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Display name</span>
                    <input
                      value={displayName}
                      onChange={(event) => setDisplayName(event.target.value)}
                      className="h-11 w-full rounded-[12px] border border-white/10 bg-white/[0.03] px-4 text-[14px] text-white outline-none placeholder:text-white/25 focus:border-white/20"
                      placeholder="Your public name"
                      maxLength={80}
                    />
                  </label>

                  <label className="flex flex-1 flex-col gap-2">
                    <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Bio</span>
                    <textarea
                      value={bio}
                      onChange={(event) => setBio(event.target.value)}
                      className="h-full min-h-[148px] w-full flex-1 rounded-[12px] border border-white/10 bg-white/[0.03] px-4 py-3 text-[14px] text-white outline-none placeholder:text-white/25 focus:border-white/20"
                      placeholder="A short public bio"
                      maxLength={240}
                    />
                  </label>
                </div>

                <div className="space-y-2">
                  <p className="font-mono text-[11px] uppercase tracking-[0.12em] text-white/35">Avatar</p>
                  <div className="rounded-[14px] border border-white/10 bg-white/[0.03] p-4">
                    <div className="flex flex-col items-center gap-4 text-center">
                      <div className="h-16 w-16 overflow-hidden rounded-[16px] border border-white/10 bg-white/[0.04]">
                        <img src={avatarDataUrl || DEFAULT_PROFILE_AVATAR} alt="Avatar preview" className="h-full w-full object-cover" />
                      </div>
                      <div className="min-w-0 space-y-1">
                        <p className="text-[13px] font-medium text-white">Profile image</p>
                        <p className="text-[11px] leading-5 text-white/45">
                          Use a square image for the cleanest public card.
                        </p>
                      </div>
                    </div>

                    <label className="mt-4 flex h-10 w-full cursor-pointer items-center justify-center rounded-[12px] border border-dashed border-white/10 bg-black/20 px-3.5 text-[13px] text-white/55 transition hover:border-white/20">
                      <span className="flex items-center justify-center gap-2 text-center">
                        <Upload className="h-4 w-4 text-[#7928ca]" />
                        {avatarDataUrl && avatarDataUrl !== DEFAULT_PROFILE_AVATAR ? "Replace image" : "Upload image"}
                      </span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleAvatarChange}
                        className="hidden"
                      />
                    </label>

                    {avatarDataUrl && avatarDataUrl !== DEFAULT_PROFILE_AVATAR ? (
                      <button
                        type="button"
                        onClick={() => setAvatarDataUrl("")}
                        className="mt-3 w-full text-center font-mono text-[11px] uppercase tracking-[0.08em] text-white/40 transition hover:text-white"
                      >
                        Remove avatar
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>

              {status ? (
                <div
                  className={`rounded-[12px] px-4 py-3 text-[13px] ${
                    statusTone === "success"
                      ? "border border-emerald-400/20 bg-emerald-500/10 text-emerald-200"
                      : "border border-red-400/20 bg-red-500/10 text-red-200"
                  }`}
                >
                  {status}
                </div>
              ) : null}

              <div className="flex items-center justify-end gap-2 border-t border-white/10 pt-4">
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="inline-flex h-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] px-4 text-[11px] font-black uppercase tracking-[0.18em] text-white transition hover:bg-white/[0.06]"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={isSaving || isPrefilling || !displayName.trim() || !bio.trim()}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-full bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white/90 disabled:opacity-60"
                >
                  {isSaving || isPrefilling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Save
                </button>
              </div>
            </form>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
