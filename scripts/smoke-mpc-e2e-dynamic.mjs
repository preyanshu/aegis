import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadEnv } from "./env.js";
import { Noir } from "@noir-lang/noir_js";
import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
} from "@stellar/stellar-sdk";
import { createUltraHonkBackend, initBarretenberg, poseidon2PermutationFields } from "./barretenberg.js";

loadEnv({ preserve: ["MARKET_CONTRACT_ID", "MPC_BACKEND_URL"] });

const backendUrl = process.env.MPC_BACKEND_URL ?? "http://127.0.0.1:4002";
const childEnvKeys = [
  "ADMIN_SECRET_KEY",
  "USER_SECRET_KEY",
  "USER2_SECRET_KEY",
  "USER3_SECRET_KEY",
  "STELLAR_RPC",
  "STELLAR_NETWORK",
  "MARKET_CONTRACT_ID",
  "COMMIT_VERIFIER_ID",
  "TALLY_UPDATE_VERIFIER_ID",
  "TALLY_FINALIZE_VERIFIER_ID",
  "CLAIM_VERIFIER_ID",
  "REFLECTOR_ID",
  "USDC_TOKEN_ID",
  "PROFILE_BACKEND_URL",
  "NEXT_PUBLIC_PROFILE_API_URL",
];
const commitCircuit = JSON.parse(readFileSync("./circuits/commit/target/commit.json", "utf8"));
const tallyUpdateCircuit = JSON.parse(readFileSync("./circuits/tally_update/target/tally_update.json", "utf8"));
const claimCircuit = JSON.parse(readFileSync("./circuits/claim/target/claim.json", "utf8"));
const proofOptions = { keccak: true };
const FIELD_MASK = (1n << 248n) - 1n;
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

const marketId = randomBytes(32).toString("hex");
const admin = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const user2 = Keypair.fromSecret(process.env.USER2_SECRET_KEY);
const amountStroops = 1n;
const minBet = 1n;
const maxBet = 1_000_000_000n;
const feeBps = 200;
const yesSalt = `0x${randomBytes(31).toString("hex")}`;
const noSalt = `0x${randomBytes(31).toString("hex")}`;

function padHex32(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function randomFieldSalt() {
  return `0x${randomBytes(31).toString("hex")}`;
}

function modField(value) {
  const normalized = value % FIELD_MODULUS;
  return normalized >= 0n ? normalized : normalized + FIELD_MODULUS;
}

async function additiveShares(total, count, seedInputs) {
  const shares = [];
  let remaining = modField(total);
  const seedTuple = [...seedInputs].slice(0, 4);
  while (seedTuple.length < 4) {
    seedTuple.push(0n);
  }
  const [seed] = await poseidon2PermutationFields(seedTuple);
  let state = BigInt(seed);
  for (let index = 0; index < count - 1; index += 1) {
    const [nextShare] = await poseidon2PermutationFields([state, BigInt(index + 1), total, remaining]);
    const share = BigInt(nextShare);
    shares.push(share);
    remaining = modField(remaining + FIELD_MODULUS - share);
    state = share;
  }
  shares.push(remaining);
  return shares;
}

function runNode(script, args = [], extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  for (const key of childEnvKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ...extraEnv },
  });
}

function runStellar(args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
  };
  for (const key of childEnvKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return execFileSync("stellar", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...env, ...extraEnv },
  });
}

function strip0x(value) {
  return value.replace(/^0x/i, "");
}

function parseHash(output) {
  return output.match(/[a-f0-9]{64}/i)?.[0] ?? null;
}

function bytesScVal(hex) {
  return nativeToScVal(Buffer.from(hex.replace(/^0x/i, ""), "hex"), { type: "bytes" });
}

function fieldBytes(value) {
  return Buffer.from(BigInt(value).toString(16).padStart(64, "0"), "hex");
}

function publicInputsBytes(values) {
  return Buffer.concat(values.map((value) => fieldBytes(value)));
}

function parseReturnedHexBytes(output) {
  const trimmed = output.trim();
  const parsed = JSON.parse(trimmed);
  if (typeof parsed === "string") {
    return strip0x(parsed);
  }
  if (Array.isArray(parsed)) {
    return Buffer.from(parsed).toString("hex");
  }
  if (parsed?.data && Array.isArray(parsed.data)) {
    return Buffer.from(parsed.data).toString("hex");
  }
  throw new Error(`could not parse returned bytes: ${trimmed}`);
}

async function fetchJson(path, init) {
  const response = await fetch(`${backendUrl}${path}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function submitCall(secretKey, label, method, args = []) {
  const keypair = Keypair.fromSecret(secretKey);
  const server = new rpc.Server(process.env.STELLAR_RPC);
  const account = await server.getAccount(keypair.publicKey());
  const contract = new Contract(process.env.MARKET_CONTRACT_ID);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: process.env.STELLAR_NETWORK,
  })
    .addOperation(contract.call(method, ...args))
    .setTimeout(120)
    .build();
  const prepared = await server.prepareTransaction(tx);
  prepared.sign(keypair);
  const sent = await server.sendTransaction(prepared);
  if (sent.status === "ERROR") {
    throw new Error(`${label} failed to submit: ${JSON.stringify(sent.errorResult)}`);
  }

  for (;;) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === "SUCCESS") {
      return sent.hash;
    }
    if (result.status === "FAILED") {
      throw new Error(`${label} failed on-chain: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

function marketField() {
  return BigInt(`0x${marketId}`) & FIELD_MASK;
}

async function derivePositionArtifacts(side, salt) {
  const direction = side === "YES" ? 1n : 0n;
  const [commitment] = await poseidon2PermutationFields([
    marketField(),
    direction,
    amountStroops,
    BigInt(salt),
  ]);
  const [nullifier] = await poseidon2PermutationFields([
    marketField(),
    BigInt(salt),
    12_345n,
    0n,
  ]);
  return {
    direction,
    commitment,
    commitmentHex: padHex32(commitment),
    nullifierHex: padHex32(nullifier),
  };
}

async function generateCommitProof(side, salt) {
  const artifacts = await derivePositionArtifacts(side, salt);
  const noir = new Noir(commitCircuit);
  const backend = createUltraHonkBackend(commitCircuit.bytecode);
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: amountStroops.toString(),
    salt,
    commitment: artifacts.commitmentHex,
    market_id: marketField().toString(),
    min_amount: minBet.toString(),
    max_amount: maxBet.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();
  return {
    ...artifacts,
    proofHex: `0x${Buffer.from(proof.proof).toString("hex")}`,
    publicInputsHex: proof.publicInputs.map((value) => `0x${BigInt(value).toString(16)}`),
  };
}

async function generateTallyUpdateProof(side, salt, commitmentHex, previousTallyCommitmentHex = "0x0") {
  const artifacts = await derivePositionArtifacts(side, salt);
  if (commitmentHex.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
    throw new Error("commitment mismatch while generating tally proof");
  }

  const nextTallyCommitmentInputs = [
    BigInt(previousTallyCommitmentHex),
    BigInt(commitmentHex),
    amountStroops,
    artifacts.direction,
  ];
  const [nextTallyCommitment] = await poseidon2PermutationFields(nextTallyCommitmentInputs);

  const yesShares = await additiveShares(side === "YES" ? amountStroops : 0n, 5, [
    marketField(),
    BigInt(commitmentHex),
    side === "YES" ? 1n : 0n,
    amountStroops,
  ]);
  const noShares = await additiveShares(side === "NO" ? amountStroops : 0n, 5, [
    marketField(),
    BigInt(commitmentHex),
    side === "NO" ? 1n : 0n,
    amountStroops,
  ]);
  const shareSalts = Array.from({ length: 5 }, () => randomFieldSalt());
  let shareCommitmentRoot = 0n;
  const sharePackets = [];

  for (let index = 0; index < 5; index += 1) {
    const [saltCommitment] = await poseidon2PermutationFields([
      marketField(),
      BigInt(commitmentHex),
      BigInt(index + 1),
      BigInt(shareSalts[index]),
    ]);
    const [shareCommitment] = await poseidon2PermutationFields([
      saltCommitment,
      yesShares[index],
      noShares[index],
      0n,
    ]);
    const [nextRoot] = await poseidon2PermutationFields([
      shareCommitmentRoot,
      shareCommitment,
      BigInt(index + 1),
      0n,
    ]);
    shareCommitmentRoot = nextRoot;
    sharePackets.push({
      marketId,
      commitment: commitmentHex,
      shardIndex: index + 1,
      yesShare: yesShares[index].toString(),
      noShare: noShares[index].toString(),
      shareSalt: shareSalts[index],
      shareCommitment: padHex32(shareCommitment),
    });
  }

  const noir = new Noir(tallyUpdateCircuit);
  const backend = createUltraHonkBackend(tallyUpdateCircuit.bytecode);
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: amountStroops.toString(),
    salt,
    commitment: artifacts.commitmentHex,
    market_id: marketField().toString(),
    collateral_amount: amountStroops.toString(),
    previous_tally_commitment: previousTallyCommitmentHex,
    next_tally_commitment: padHex32(nextTallyCommitment),
    yes_shares: yesShares.map((value) => value.toString()),
    no_shares: noShares.map((value) => value.toString()),
    share_salts: shareSalts,
    share_commitment_root: padHex32(shareCommitmentRoot),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitmentHex: artifacts.commitmentHex,
    nextTallyCommitmentHex: padHex32(nextTallyCommitment),
    shareCommitmentRootHex: padHex32(shareCommitmentRoot),
    publicInputBytesHex: `0x${publicInputsBytes([
      artifacts.commitment,
      marketField(),
      amountStroops,
      BigInt(previousTallyCommitmentHex),
      nextTallyCommitment,
      shareCommitmentRoot,
    ]).toString("hex")}`,
    sharePackets,
    proofHex: `0x${Buffer.from(proof.proof).toString("hex")}`,
    publicInputsHex: proof.publicInputs.map((value) => `0x${BigInt(value).toString(16)}`),
  };
}

function verifyDynamicTallyDirectly(proof) {
  writeFileSync("/tmp/verdict-dynamic-tally.pi.bin", Buffer.from(proof.publicInputBytesHex.replace(/^0x/i, ""), "hex"));
  writeFileSync("/tmp/verdict-dynamic-tally.proof.bin", Buffer.from(proof.proofHex.replace(/^0x/i, ""), "hex"));
  const output = runStellar([
    "contract",
    "invoke",
    "--id",
    process.env.TALLY_UPDATE_VERIFIER_ID,
    "--source-account",
    process.env.ADMIN_SECRET_KEY,
    "--rpc-url",
    process.env.STELLAR_RPC,
    "--network-passphrase",
    process.env.STELLAR_NETWORK,
    "--send=no",
    "--",
    "verify_proof",
    "--public_inputs-file-path",
    "/tmp/verdict-dynamic-tally.pi.bin",
    "--proof_bytes-file-path",
    "/tmp/verdict-dynamic-tally.proof.bin",
  ]);
  console.log(`direct dynamic tally verifier: ${output.trim() || "ok"}`);
}

async function generateClaimProof(side, salt, commitmentHex, distributablePot, winningSideTotal, outcome) {
  const artifacts = await derivePositionArtifacts(side, salt);
  if (commitmentHex.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
    throw new Error("commitment mismatch while generating claim proof");
  }
  const payout = (amountStroops * distributablePot) / winningSideTotal;
  const noir = new Noir(claimCircuit);
  const backend = createUltraHonkBackend(claimCircuit.bytecode);
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: amountStroops.toString(),
    salt,
    commitment: artifacts.commitmentHex,
    market_id: marketField().toString(),
    outcome: outcome ? "1" : "0",
    nullifier: artifacts.nullifierHex,
    distributable_pot: distributablePot.toString(),
    winning_side_total: winningSideTotal.toString(),
    payout: payout.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();
  return {
    payout,
    nullifierHex: artifacts.nullifierHex,
    proofHex: `0x${Buffer.from(proof.proof).toString("hex")}`,
    publicInputsHex: proof.publicInputs.map((value) => `0x${BigInt(value).toString(16)}`),
  };
}

function parseContractState() {
  return JSON.parse(
    runStellar([
      "contract",
      "invoke",
      "--id",
      process.env.MARKET_CONTRACT_ID,
      "--source",
      process.env.ADMIN_SECRET_KEY,
      "--rpc-url",
      process.env.STELLAR_RPC,
      "--network-passphrase",
      process.env.STELLAR_NETWORK,
      "--send=no",
      "--",
      "get_market_state",
      "--market_id",
      marketId,
    ]),
  );
}

function debugTallyPublicInputs(proof, commitmentHex) {
  const output = runStellar([
    "contract",
    "invoke",
    "--id",
    process.env.MARKET_CONTRACT_ID,
    "--source",
    process.env.ADMIN_SECRET_KEY,
    "--rpc-url",
    process.env.STELLAR_RPC,
    "--network-passphrase",
    process.env.STELLAR_NETWORK,
    "--send=no",
    "--",
    "debug_tally_update_public_inputs",
    "--market_id",
    marketId,
    "--commitment",
    strip0x(commitmentHex),
    "--next_tally_commitment",
    strip0x(proof.nextTallyCommitmentHex),
    "--share_commitment_root",
    strip0x(proof.shareCommitmentRootHex),
  ]);
  const contractPublicInputsHex = parseReturnedHexBytes(output);
  const proofPublicInputsHex = strip0x(proof.publicInputBytesHex);
  console.log("contract tally public input bytes:", contractPublicInputsHex);
  console.log("proof tally public input bytes:", proofPublicInputsHex);
  if (contractPublicInputsHex !== proofPublicInputsHex) {
    throw new Error("contract tally public inputs differ from generated proof inputs");
  }
}

async function createMarket() {
  const endTimestamp = Math.floor(Date.now() / 1000) + 45;
  runNode("./scripts/create-market.js", [marketId], {
    END_TIMESTAMP: endTimestamp.toString(),
    MARKET_CONDITION_COUNT: "1",
    MIN_BET: minBet.toString(),
    MAX_BET: maxBet.toString(),
    COND1_ASSET: "BTC",
    COND1_COMPARATOR: "gte",
    COND1_THRESHOLD: "1",
    COND1_JOIN: "AND",
    MARKET_QUESTION: "Will BTC stay above 1 on the fresh MPC smoke test?",
    MARKET_CATEGORY: "smoke",
  });
  return endTimestamp;
}

async function submitCommit(label, secretKey, owner, proof, commitmentHex) {
  const txHash = await submitCall(secretKey, `${label} commit`, "commit_position", [
    bytesScVal(marketId),
    nativeToScVal(Address.fromString(owner), { type: "address" }),
    bytesScVal(commitmentHex),
    nativeToScVal(amountStroops, { type: "i128" }),
    bytesScVal(proof.proofHex),
  ]);
  console.log(`${label} commit: ${txHash}`);
  return txHash;
}

async function submitTally(proof, commitmentHex) {
  console.log("tally proof public inputs:", JSON.stringify(proof.publicInputsHex));
  const txHash = await submitCall(process.env.ADMIN_SECRET_KEY, "submit tally", "submit_private_tally", [
    bytesScVal(marketId),
    bytesScVal(commitmentHex),
    bytesScVal(proof.nextTallyCommitmentHex),
    bytesScVal(proof.shareCommitmentRootHex),
    bytesScVal(proof.proofHex),
  ]);
  console.log(`submit tally: ${txHash}`);
  return txHash;
}

async function submitClaim(proof, commitmentHex) {
  const txHash = await submitCall(process.env.ADMIN_SECRET_KEY, "claim", "claim_winnings", [
    bytesScVal(marketId),
    bytesScVal(commitmentHex),
    bytesScVal(proof.nullifierHex),
    nativeToScVal(Address.fromString(admin.publicKey()), { type: "address" }),
    bytesScVal(proof.proofHex),
  ]);
  console.log(`claim: ${txHash}`);
  return txHash;
}

async function main() {
  await initBarretenberg();
  console.log(`smoke marketId=${marketId}`);

  const yesCommitProof = await generateCommitProof("YES", yesSalt);
  const noCommitProof = await generateCommitProof("NO", noSalt);
  const tallyProof = await generateTallyUpdateProof("YES", yesSalt, yesCommitProof.commitmentHex, padHex32(0n));
  const expectedDistributablePot = amountStroops - (amountStroops * BigInt(feeBps)) / 10_000n;
  const claimProof = await generateClaimProof(
    "YES",
    yesSalt,
    yesCommitProof.commitmentHex,
    expectedDistributablePot,
    amountStroops,
    true,
  );

  const endTimestamp = await createMarket();
  const initialState = parseContractState();
  const tallyDeadline = Number(initialState.tally_deadline ?? initialState.tallyDeadline ?? 0);
  if (!tallyDeadline) {
    throw new Error("missing tally deadline on market state");
  }
  console.log("initial market state:", JSON.stringify({
    endTimestamp,
    tallyDeadline,
    tallyCommitment: initialState.tally_commitment ?? initialState.tallyCommitment,
    totalLockedCollateral: initialState.total_locked_collateral ?? initialState.totalLockedCollateral,
  }));

  await submitCommit("YES", process.env.ADMIN_SECRET_KEY, admin.publicKey(), yesCommitProof, yesCommitProof.commitmentHex);
  await submitCommit("NO", process.env.USER2_SECRET_KEY, user2.publicKey(), noCommitProof, noCommitProof.commitmentHex);

  verifyDynamicTallyDirectly(tallyProof);
  debugTallyPublicInputs(tallyProof, yesCommitProof.commitmentHex);

  const waitMs = endTimestamp * 1000 - Date.now() + 5000;
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  if (Date.now() >= tallyDeadline * 1000) {
    throw new Error("tally window closed before submit_private_tally");
  }

  const tallyTxHash = await submitTally(tallyProof, yesCommitProof.commitmentHex);
  tallyProof.sharePackets.forEach((packet) => {
    packet.tallyTxHash = tallyTxHash;
    packet.shareCommitmentRoot = tallyProof.shareCommitmentRootHex;
  });

  await fetchJson("/tally-shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packets: tallyProof.sharePackets }),
  });
  console.log("share upload: ok");

  const status = await fetchJson(`/tally-shares/${marketId}/status`);
  if (status.completeCommitmentCount !== 1) {
    throw new Error(`expected one complete commitment, got ${status.completeCommitmentCount}`);
  }

  const finalizeWaitMs = tallyDeadline * 1000 - Date.now() + 5000;
  if (finalizeWaitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, finalizeWaitMs));
  }

  const aggregate = await fetchJson(`/tally-shares/${marketId}/aggregate`);
  if (String(aggregate.yesTotal) !== amountStroops.toString()) {
    throw new Error(`unexpected yesTotal ${aggregate.yesTotal}`);
  }
  if (String(aggregate.noTotal) !== "0") {
    throw new Error(`unexpected noTotal ${aggregate.noTotal}`);
  }

  const finalizeJob = await fetchJson("/jobs/finalize-due-markets", { method: "POST" });
  const ourResult = Array.isArray(finalizeJob.results)
    ? finalizeJob.results.find((entry) => strip0x(entry.marketId) === marketId)
    : null;
  if (!ourResult || ourResult.status !== "finalized") {
    throw new Error(`finalization did not succeed: ${JSON.stringify(finalizeJob)}`);
  }
  console.log(`finalize job: ${JSON.stringify(ourResult)}`);

  const state = parseContractState();
  if (!state.resolved || !state.tally_finalized) {
    throw new Error("market did not resolve on-chain");
  }
  if (String(state.yes_total ?? state.yesTotal) !== amountStroops.toString()) {
    throw new Error(`unexpected final yes total ${String(state.yes_total ?? state.yesTotal)}`);
  }
  if (String(state.no_total ?? state.noTotal) !== "0") {
    throw new Error(`unexpected final no total ${String(state.no_total ?? state.noTotal)}`);
  }
  if (String(state.distributable_pot) !== expectedDistributablePot.toString()) {
    throw new Error(`unexpected distributable pot ${String(state.distributable_pot)}`);
  }
  console.log("final market state:", JSON.stringify(state));

  await submitClaim(claimProof, yesCommitProof.commitmentHex);
  const afterClaim = parseContractState();
  if (String(afterClaim.total_claimed_out ?? afterClaim.totalClaimedOut) !== expectedDistributablePot.toString()) {
    throw new Error("claimed amount did not match distributable pot");
  }

  console.log("smoke: success");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
