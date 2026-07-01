"use client";

import { useEffect, useMemo, useState } from "react";
import type { ChangeEvent, FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Cloud, Loader2, Lock, Upload, X } from "lucide-react";
import { usePrivy } from "@privy-io/react-auth";
import { getPrivyStellarWallet } from "@/lib/stellar";
import {
  loadExistingReputationSnapshot,
  loadLocalReputationSnapshot,
  loadReputationSnapshot,
  saveReputationSnapshot,
  type ReputationSyncMode,
} from "@/lib/reputation-vault";

type PublicProfileOnboardingModalProps = {
  isOpen: boolean;
  onOpenChange: (next: boolean) => void;
};

export function PublicProfileOnboardingModal({ isOpen, onOpenChange }: PublicProfileOnboardingModalProps) {
  const { user } = usePrivy();
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
  const defaultAvatar = googleProfile?.picture ?? "";
  const defaultBio = "Trading on Verdict with a public reputation profile.";

  const [displayName, setDisplayName] = useState(defaultName);
  const [avatarDataUrl, setAvatarDataUrl] = useState(defaultAvatar || "");
  const [bio, setBio] = useState(defaultBio);
  const [syncMode, setSyncMode] = useState<ReputationSyncMode>("server");
  const [isPrefilling, setIsPrefilling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setDisplayName(defaultName);
    setAvatarDataUrl(defaultAvatar || "");
    setBio(defaultBio);
  }, [defaultName, defaultAvatar, defaultBio]);

  useEffect(() => {
    if (!isOpen || !walletAddress) {
      return;
    }

    let mounted = true;

    const run = async () => {
      try {
        setIsPrefilling(true);
        const existing = await loadExistingReputationSnapshot(walletAddress);

        if (!mounted) {
          return;
        }

        if (!existing) {
          return;
        }

        setDisplayName(existing.profile.displayName || defaultName);
        setAvatarDataUrl(existing.profile.avatarDataUrl || defaultAvatar || "");
        setBio(existing.profile.bio || defaultBio);
        setSyncMode(existing.syncMode);
      } catch {
        // Keep the modal open if fetching fails; the user can still save a fresh profile.
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
  }, [defaultAvatar, defaultBio, defaultName, isOpen, onOpenChange, walletAddress]);

  async function handleAvatarChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith("image/")) {
      setStatus("Please choose an image file for your avatar.");
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      setAvatarDataUrl(typeof reader.result === "string" ? reader.result : "");
    };
    reader.onerror = () => {
      setStatus("Could not read the selected image.");
    };
    reader.readAsDataURL(file);
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!walletAddress) {
      setStatus("Connect your wallet first.");
      return;
    }

    if (!displayName.trim() || !bio.trim()) {
      setStatus("Name and bio are required.");
      return;
    }

    setIsSaving(true);
    setStatus("");
    try {
      const current = syncMode === "local"
        ? loadLocalReputationSnapshot(walletAddress) ?? {
            walletAddress,
            syncMode: "local",
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
          }
        : await loadReputationSnapshot(walletAddress, {
            displayName: defaultName,
            bio: defaultBio,
            avatarDataUrl: defaultAvatar || null,
          });

      await saveReputationSnapshot({
        ...current,
        walletAddress,
        syncMode,
        profile: {
          displayName: displayName.trim(),
          bio: bio.trim(),
          avatarDataUrl: avatarDataUrl || defaultAvatar || null,
        },
      });

      onOpenChange(false);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Failed to save profile");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <AnimatePresence>
      {isOpen ? (
        <div className="fixed inset-0 z-[300] flex items-center justify-center px-3 py-4 sm:px-6">
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
            className="relative w-full max-w-2xl overflow-hidden rounded-[28px] border border-white/8 bg-[#0b0b0d] shadow-[0_20px_80px_rgba(0,0,0,0.55)]"
          >
            <div className="flex items-start justify-between border-b border-white/8 px-5 py-5 sm:px-8">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.28em] text-white/30">Profile settings</p>
                <h2 className="mt-2 text-2xl font-black tracking-tight text-white">Public profile for Verdict</h2>
                <p className="mt-2 max-w-lg text-sm leading-relaxed text-white/50">
                  Edit the public name, avatar, bio, and storage mode that appear on your reputation page.
                </p>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-[10px] font-black uppercase tracking-[0.18em] text-white/55">
                  {syncMode === "server" ? <Cloud className="h-3.5 w-3.5 text-violet-300" /> : <Lock className="h-3.5 w-3.5 text-violet-300" />}
                  {syncMode === "server" ? "Cloud backed" : "Local only"}
                </div>
              </div>
              <button
                type="button"
                onClick={() => onOpenChange(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-white/10 bg-white/[0.03] text-white/60 transition hover:bg-white/[0.07] hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-5 px-5 py-5 sm:px-8">
              <div className="grid gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setSyncMode("server")}
                  className={`rounded-2xl border p-4 text-left transition ${
                    syncMode === "server"
                      ? "border-violet-400/40 bg-violet-500/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Cloud className="h-4 w-4 text-violet-300" />
                    <span className="text-sm font-black uppercase tracking-[0.18em] text-white">Server-backed</span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    Recommended. Your profile, commitments, claims, and creds sync to Mongo so any device can pick up the same reputation automatically.
                  </p>
                </button>

                <button
                  type="button"
                  onClick={() => setSyncMode("local")}
                  className={`rounded-2xl border p-4 text-left transition ${
                    syncMode === "local"
                      ? "border-violet-400/40 bg-violet-500/10"
                      : "border-white/10 bg-white/[0.03] hover:border-white/20"
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Lock className="h-4 w-4 text-violet-300" />
                    <span className="text-sm font-black uppercase tracking-[0.18em] text-white">Local only</span>
                  </div>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">
                    Keeps everything in your browser. Nothing is shared with the server, so your reputation stays private on this device.
                  </p>
                </button>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block space-y-2">
                  <span className="text-[10px] font-black uppercase tracking-[0.24em] text-white/30">Display name</span>
                  <input
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    className="h-12 w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-400/40"
                    placeholder="Your public name"
                    maxLength={80}
                  />
                </label>

                <label className="block space-y-2">
                  <span className="text-[10px] font-black uppercase tracking-[0.24em] text-white/30">Avatar</span>
                  <label className="flex h-12 w-full cursor-pointer items-center justify-between rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 text-sm text-white/55 transition hover:border-violet-400/40">
                    <span className="flex items-center gap-2">
                      <Upload className="h-4 w-4 text-violet-300" />
                      {avatarDataUrl ? "Image selected" : "Upload image"}
                    </span>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={handleAvatarChange}
                      className="hidden"
                    />
                  </label>
                </label>
              </div>

              {avatarDataUrl ? (
                <div className="flex items-center gap-3 rounded-2xl border border-white/8 bg-white/[0.03] px-3 py-3">
                  <div className="h-12 w-12 overflow-hidden rounded-full border border-white/10 bg-black">
                    <img src={avatarDataUrl} alt="Avatar preview" className="h-full w-full object-cover" />
                  </div>
                  <button
                    type="button"
                    onClick={() => setAvatarDataUrl("")}
                    className="text-xs font-black uppercase tracking-[0.16em] text-white/45 transition hover:text-white"
                  >
                    Remove avatar
                  </button>
                </div>
              ) : null}

              <label className="block space-y-2">
                <span className="text-[10px] font-black uppercase tracking-[0.24em] text-white/30">Bio</span>
                <textarea
                  value={bio}
                  onChange={(event) => setBio(event.target.value)}
                  className="min-h-28 w-full rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-white outline-none placeholder:text-white/25 focus:border-violet-400/40"
                  placeholder="A short public bio"
                  maxLength={240}
                />
              </label>

              {status ? (
                <div className="rounded-xl border border-rose-500/20 bg-rose-500/10 px-4 py-3 text-sm text-rose-100">
                  {status}
                </div>
              ) : null}

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/8 pt-4">
                <p className="text-xs text-white/45">
                  {syncMode === "server"
                    ? "Stored public fields: name, avatar, bio. Reputation data syncs to the server."
                    : "Stored only on this device. Reputation data stays local and private."}
                </p>
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={isSaving || isPrefilling || !displayName.trim() || !bio.trim()}
                    className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-white px-5 text-[11px] font-black uppercase tracking-[0.18em] text-black transition hover:bg-white/90 disabled:opacity-60"
                  >
                    {isSaving || isPrefilling ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {syncMode === "server" ? "Save & sync" : "Save locally"}
                  </button>
                </div>
              </div>
            </form>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
