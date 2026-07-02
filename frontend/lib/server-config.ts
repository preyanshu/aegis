import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { resolve } from "node:path";

dotenv.config({
  path: resolve(process.cwd(), "..", ".env"),
  override: true,
});

export type WalletConfig = {
  label: string;
  secret: string;
  publicKey: string;
};

export type AppConfig = {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  reflectorId: string;
  usdcTokenId: string;
  commitVerifierId: string;
  tallyUpdateVerifierId?: string;
  tallyFinalizeVerifierId?: string;
  claimVerifierId: string;
  wallets: WalletConfig[];
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name];
}

function wallet(label: string, secret: string | undefined): WalletConfig | null {
  if (!secret) {
    return null;
  }

  const keypair = Keypair.fromSecret(secret);
  return {
    label,
    secret,
    publicKey: keypair.publicKey(),
  };
}

export function getAppConfig(): AppConfig {
  const wallets = [
    wallet("admin", process.env.ADMIN_SECRET_KEY),
    wallet("user2", process.env.USER2_SECRET_KEY),
    wallet("user3", process.env.USER3_SECRET_KEY),
  ].filter((entry): entry is WalletConfig => Boolean(entry));

  if (wallets.length === 0) {
    throw new Error("no demo wallets found in .env");
  }

  return {
    rpcUrl: requireEnv("STELLAR_RPC"),
    networkPassphrase: requireEnv("STELLAR_NETWORK"),
    contractId: requireEnv("MARKET_CONTRACT_ID"),
    reflectorId: requireEnv("REFLECTOR_ID"),
    usdcTokenId: requireEnv("USDC_TOKEN_ID"),
    commitVerifierId: requireEnv("COMMIT_VERIFIER_ID"),
    tallyUpdateVerifierId: optionalEnv("TALLY_UPDATE_VERIFIER_ID"),
    tallyFinalizeVerifierId: optionalEnv("TALLY_FINALIZE_VERIFIER_ID"),
    claimVerifierId: requireEnv("CLAIM_VERIFIER_ID"),
    wallets,
  };
}
