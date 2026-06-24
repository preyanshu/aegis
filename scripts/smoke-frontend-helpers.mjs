import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { poseidon2Permutation } from "@aztec/foundation/crypto";
import { Noir } from "@noir-lang/noir_js";

import { createUltraHonkBackend, initBarretenberg } from "./barretenberg.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frontendDir = path.join(rootDir, "frontend");

process.chdir(frontendDir);

const { getAppConfig } = await import("../frontend/lib/server-config.ts");
const stellar = await import("../frontend/lib/stellar.ts");

globalThis.window = {};

const config = getAppConfig();
stellar.setBrowserConfig(config);

const admin = config.wallets.find((wallet) => wallet.label === "admin");
const user2 = config.wallets.find((wallet) => wallet.label === "user2");

if (!admin || !user2) {
  throw new Error("expected admin and user2 wallets in .env");
}

function toHex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toHex32(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function readCircuitJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(rootDir, relativePath), "utf8"));
}

async function buildCommitProof({ side, amountUsdc, minBet, maxBet }) {
  await initBarretenberg();

  const circuit = readCircuitJson("circuits/commit/target/commit.json");
  const directionField = side === "YES" ? 1n : 0n;
  const amountInStroops = BigInt(amountUsdc) * 10_000_000n;
  const salt = `0x${randomBytes(31).toString("hex")}`;

  const commitmentState = await poseidon2Permutation([
    directionField,
    amountInStroops,
    BigInt(salt),
    0n,
  ]);
  const nullifierState = await poseidon2Permutation([BigInt(salt), 12345n, 0n, 0n]);

  const commitment = BigInt(commitmentState[0]);
  const nullifier = BigInt(nullifierState[0]);

  const noir = new Noir(circuit);
  const backend = createUltraHonkBackend(circuit.bytecode);
  const { witness } = await noir.execute({
    direction: directionField.toString(),
    amount: amountInStroops.toString(),
    salt,
    commitment: toHex32(commitment),
    min_amount: minBet.toString(),
    max_amount: maxBet.toString(),
  });
  const proof = await backend.generateProof(witness, { keccak: true });
  await backend.destroy?.();

  return {
    amountInStroops,
    salt,
    commitment: toHex32(commitment),
    nullifier: toHex32(nullifier),
    proofHex: `0x${toHex(proof.proof)}`,
  };
}

async function buildClaimProof({ side, amountInStroops, salt, outcome }) {
  await initBarretenberg();

  const circuit = readCircuitJson("circuits/claim/target/claim.json");
  const directionField = side === "YES" ? 1n : 0n;

  const commitmentState = await poseidon2Permutation([
    directionField,
    amountInStroops,
    BigInt(salt),
    0n,
  ]);
  const nullifierState = await poseidon2Permutation([BigInt(salt), 12345n, 0n, 0n]);

  const commitment = BigInt(commitmentState[0]);
  const nullifier = BigInt(nullifierState[0]);

  const noir = new Noir(circuit);
  const backend = createUltraHonkBackend(circuit.bytecode);
  const { witness } = await noir.execute({
    direction: directionField.toString(),
    amount: amountInStroops.toString(),
    salt,
    commitment: toHex32(commitment),
    outcome: outcome ? "1" : "0",
    nullifier: toHex32(nullifier),
  });
  const proof = await backend.generateProof(witness, { keccak: true });
  await backend.destroy?.();

  return {
    commitment: toHex32(commitment),
    nullifier: toHex32(nullifier),
    proofHex: `0x${toHex(proof.proof)}`,
  };
}

function serialize(value) {
  return JSON.stringify(
    value,
    (_, current) => (typeof current === "bigint" ? current.toString() : current),
    2,
  );
}

async function main() {
  const marketId = randomBytes(32).toString("hex");
  const endTimestamp = BigInt(Math.floor(Date.now() / 1000) + 20);

  console.log(`marketId=${marketId}`);

  const created = await stellar.createMarket(admin, {
    marketId,
    question: "Frontend helper smoke test market",
    targetPrice: 1n,
    endTimestamp,
    minBet: 1_000_000n,
    maxBet: 100_000_000n,
    feeBps: 100,
  });
  console.log(`createMarket tx=${created.hash}`);

  const commitProof = await buildCommitProof({
    side: "YES",
    amountUsdc: 1,
    minBet: 1_000_000n,
    maxBet: 100_000_000n,
  });

  const committed = await stellar.commitPosition(user2, {
    marketId,
    commitment: commitProof.commitment,
    proofHex: commitProof.proofHex,
    amountInStroops: commitProof.amountInStroops,
  });
  console.log(`commitPosition tx=${committed.hash}`);

  const stored = await stellar.isCommitmentStored(marketId, commitProof.commitment, "admin");
  const stateAfterCommit = await stellar.loadMarketState(marketId, "admin");

  console.log(serialize({ stored, stateAfterCommit }));

  const waitMs = Number(endTimestamp * 1000n - BigInt(Date.now()) + 4000n);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const resolved = await stellar.resolveMarket(admin, marketId);
  console.log(`resolveMarket tx=${resolved.hash}`);

  const stateAfterResolve = await stellar.loadMarketState(marketId, "admin");
  const claimProof = await buildClaimProof({
    side: "YES",
    amountInStroops: commitProof.amountInStroops,
    salt: commitProof.salt,
    outcome: true,
  });

  const registered = await stellar.registerWin(user2, {
    marketId,
    commitment: claimProof.commitment,
    amountInStroops: commitProof.amountInStroops,
    nullifier: claimProof.nullifier,
    proofHex: claimProof.proofHex,
  });
  console.log(`registerWin tx=${registered.hash}`);

  const spent = await stellar.isNullifierSpent(marketId, claimProof.nullifier, "admin");

  const finalized = await stellar.finalizeClaims(admin, marketId);
  console.log(`finalizeClaims tx=${finalized.hash}`);

  const collected = await stellar.collectPayout(user2, {
    marketId,
    nullifier: claimProof.nullifier,
  });
  console.log(`collectPayout tx=${collected.hash}`);

  const finalState = await stellar.loadMarketState(marketId, "admin");

  console.log(
    serialize({
      stored,
      spent,
      stateAfterCommit,
      stateAfterResolve,
      finalState,
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
