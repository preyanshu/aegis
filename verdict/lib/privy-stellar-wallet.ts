"use client";

type CreateWallet = (input: { chainType: "stellar" }) => Promise<unknown>;

type ProvisionState = "idle" | "creating" | "created" | "blocked";

const GLOBAL_KEY = "__verdictPrivyStellarProvisionState__";
const MAX_LIMIT_MESSAGE = "maximum limit of 100 stellar wallets";

function getGlobalState(): ProvisionState {
  if (typeof window === "undefined") {
    return "idle";
  }

  const value = (window as Window & { [GLOBAL_KEY]?: ProvisionState })[GLOBAL_KEY];
  return value ?? "idle";
}

function setGlobalState(state: ProvisionState) {
  if (typeof window === "undefined") {
    return;
  }

  (window as Window & { [GLOBAL_KEY]?: ProvisionState })[GLOBAL_KEY] = state;
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function isPrivyStellarWalletLimitError(error: unknown) {
  return getErrorMessage(error).toLowerCase().includes(MAX_LIMIT_MESSAGE);
}

export async function ensurePrivyStellarWallet(input: {
  authenticated: boolean;
  hasWallet: boolean;
  createWallet: CreateWallet;
}) {
  if (!input.authenticated || input.hasWallet) {
    if (input.hasWallet) {
      setGlobalState("created");
    }
    return;
  }

  const state = getGlobalState();
  if (state === "creating" || state === "created" || state === "blocked") {
    return;
  }

  setGlobalState("creating");

  try {
    await input.createWallet({ chainType: "stellar" });
    setGlobalState("created");
  } catch (error) {
    if (isPrivyStellarWalletLimitError(error)) {
      setGlobalState("blocked");
      return;
    }

    setGlobalState("idle");
    throw error;
  }
}
