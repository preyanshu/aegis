import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { Keypair } from "@stellar/stellar-sdk";
import dotenv from "dotenv";
import { initBarretenberg, poseidon2PermutationFields } from "./barretenberg.js";

dotenv.config({ override: true });

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
const marketFixture = JSON.parse(readFileSync("./verifier/fixtures/market-fixture.json", "utf8"));
const marketId = marketFixture.marketId;
const admin = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const user2 = Keypair.fromSecret(process.env.USER2_SECRET_KEY);

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

function parseHash(output) {
  return output.match(/[a-f0-9]{64}/i)?.[0] ?? null;
}

function strip0x(value) {
  return String(value).replace(/^0x/i, "");
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

function parseContractView() {
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
      "get_market_view",
      "--market_id",
      marketId,
    ]),
  );
}

async function fetchJson(path, init) {
  const response = await fetch(`${backendUrl}${path}`, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  }
  return payload;
}

function deterministicShares(total, count) {
  const shares = [];
  let remaining = total;
  for (let index = 0; index < count - 1; index += 1) {
    const next = BigInt(index + 1);
    shares.push(next);
    remaining -= next;
  }
  shares.push(remaining);
  return shares;
}

async function createMarketIfNeeded() {
  const endTimestamp = Math.floor(Date.now() / 1000) + 10;
  try {
    runNode("./scripts/create-market.js", [marketId], {
      END_TIMESTAMP: endTimestamp.toString(),
      MARKET_CONDITION_COUNT: "1",
      COND1_ASSET: "BTC",
      COND1_COMPARATOR: "gte",
      COND1_THRESHOLD: "1",
      COND1_JOIN: "AND",
      MARKET_QUESTION: "Will BTC stay above 1 on the fresh MPC smoke test?",
      MARKET_CATEGORY: "smoke",
    });
    console.log("create market: ok");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("market already exists")) {
      throw error;
    }
    console.log("create market: already exists, continuing");
  }
  return endTimestamp;
}

function submitCommit(label, secretKey, owner, commitment, amountStroops, proofPath) {
  const output = runStellar(
    [
      "contract",
      "invoke",
      "--id",
      process.env.MARKET_CONTRACT_ID,
      "--source",
      secretKey,
      "--rpc-url",
      process.env.STELLAR_RPC,
      "--network-passphrase",
      process.env.STELLAR_NETWORK,
      "--",
      "commit_position",
      "--market_id",
      marketId,
      "--owner",
      owner,
      "--commitment",
      commitment.slice(2),
      "--collateral_amount",
      amountStroops.toString(),
      "--proof",
      proofPath,
    ],
  );
  const txHash = parseHash(output);
  if (!txHash) {
    throw new Error(`could not parse ${label} commit hash`);
  }
  console.log(`${label} commit: ${txHash}`);
  return txHash;
}

function submitTally(shareRoot, nextTallyCommitment, tallyProofPath) {
  const output = runStellar(
    [
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
      "--",
      "submit_private_tally",
      "--market_id",
      marketId,
      "--commitment",
      marketFixture.commitment.slice(2),
      "--next_tally_commitment",
      nextTallyCommitment.slice(2),
      "--share_commitment_root",
      shareRoot.slice(2),
      "--proof",
      tallyProofPath,
    ],
  );
  const txHash = parseHash(output);
  if (!txHash) {
    throw new Error("could not parse tally tx hash");
  }
  console.log(`submit tally: ${txHash}`);
  return txHash;
}

async function uploadSharePackets(tallyTxHash, shareRoot) {
  const yesShares = deterministicShares(BigInt(marketFixture.amount), 5);
  const noShares = Array(5).fill(0n);
  const shareSalts = ["0x1111", "0x2222", "0x3333", "0x4444", "0x5555"].map(
    (value) => `0x${value.slice(2).padStart(64, "0")}`,
  );

  const packets = [];
  for (let index = 0; index < 5; index += 1) {
    const [saltCommitment] = await poseidon2PermutationFields([
      BigInt(marketFixture.marketField),
      BigInt(marketFixture.commitment),
      BigInt(index + 1),
      BigInt(shareSalts[index]),
    ]);
    const [shareCommitment] = await poseidon2PermutationFields([
      saltCommitment,
      yesShares[index],
      noShares[index],
      0n,
    ]);
    packets.push({
      marketId,
      commitment: marketFixture.commitment,
      shardIndex: index + 1,
      yesShare: yesShares[index].toString(),
      noShare: noShares[index].toString(),
      shareSalt: shareSalts[index],
      shareCommitment: `0x${shareCommitment.toString(16).padStart(64, "0")}`,
      shareCommitmentRoot: shareRoot,
      tallyTxHash,
    });
  }

  await fetchJson("/tally-shares", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ packets }),
  });
  console.log("share upload: ok");
}

async function main() {
  await initBarretenberg();
  console.log(`smoke marketId=${marketId}`);

  await createMarketIfNeeded();
  const initialView = parseContractView();
  const initialState = initialView.state ?? parseContractState();
  const endTimestamp = Number(initialView.config?.end_timestamp ?? initialView.config?.endTimestamp ?? 0);
  const tallyDeadline = Number(initialState.tally_deadline ?? initialState.tallyDeadline ?? 0);
  if (!endTimestamp) {
    throw new Error("missing end timestamp on market config");
  }
  if (!tallyDeadline) {
    throw new Error("missing tally deadline on market state");
  }

  const amountStroops = BigInt(marketFixture.amount);
  submitCommit(
    "YES",
    process.env.ADMIN_SECRET_KEY,
    admin.publicKey(),
    marketFixture.commitment,
    amountStroops,
    "./verifier/fixtures/commit.proof.bin",
  );
  submitCommit(
    "NO",
    process.env.USER2_SECRET_KEY,
    user2.publicKey(),
    marketFixture.noCommitment,
    amountStroops,
    "./verifier/fixtures/commit_no.proof.bin",
  );

  const waitMs = endTimestamp * 1000 - Date.now() + 5000;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  if (Date.now() >= tallyDeadline * 1000) {
    throw new Error("tally window closed before submit_private_tally");
  }

  const [nextTallyCommitment] = await poseidon2PermutationFields([
    0n,
    BigInt(marketFixture.commitment),
    amountStroops,
    1n,
  ]);
  const shareRoot = marketFixture.shareCommitmentRoot;
  const tallyTxHash = submitTally(
    shareRoot,
    `0x${nextTallyCommitment.toString(16).padStart(64, "0")}`,
    "./verifier/fixtures/tally_update.proof.bin",
  );

  await uploadSharePackets(tallyTxHash, shareRoot);

  const statusBefore = await fetchJson(`/tally-shares/${marketId}/status`);
  console.log("share status:", JSON.stringify(statusBefore));

  const finalizeWaitMs = tallyDeadline * 1000 - Date.now() + 5000;
  if (finalizeWaitMs > 0) {
    await sleep(finalizeWaitMs);
  }

  const aggregateBefore = await fetch(`${backendUrl}/tally-shares/${marketId}/aggregate`);
  if (aggregateBefore.status !== 200) {
    throw new Error(`aggregate endpoint should be open after tally deadline, got ${aggregateBefore.status}`);
  }
  const aggregate = await aggregateBefore.json();
  if (String(aggregate.yesTotal) !== amountStroops.toString()) {
    throw new Error(`unexpected aggregate yesTotal: ${aggregate.yesTotal}`);
  }
  if (String(aggregate.noTotal) !== "0") {
    throw new Error(`unexpected aggregate noTotal: ${aggregate.noTotal}`);
  }

  const finalizeJob = await fetchJson("/jobs/finalize-due-markets", {
    method: "POST",
  });
  const ourResult = Array.isArray(finalizeJob.results)
    ? finalizeJob.results.find((entry) => strip0x(entry.marketId) === marketId)
    : null;
  if (!ourResult || ourResult.status !== "finalized") {
    throw new Error(`finalization did not succeed for smoke market: ${JSON.stringify(finalizeJob)}`);
  }
  console.log("finalize job:", JSON.stringify(ourResult));

  const state = parseContractState();
  if (!state.resolved || !state.tally_finalized) {
    throw new Error("market did not resolve on-chain");
  }
  if (String(state.yes_total ?? state.yesTotal) !== amountStroops.toString()) {
    throw new Error(`unexpected yes_total: ${String(state.yes_total ?? state.yesTotal)}`);
  }
  if (String(state.no_total ?? state.noTotal) !== "0") {
    throw new Error(`unexpected no_total: ${String(state.no_total ?? state.noTotal)}`);
  }
  console.log("final market state:", JSON.stringify(state));

  const claimOutput = runNode("./scripts/claim.js", ["./verifier/fixtures/market-fixture.json"], {
    USER_SECRET_KEY: process.env.ADMIN_SECRET_KEY,
  });
  console.log(claimOutput.trim());

  const afterClaim = parseContractState();
  if (String(afterClaim.total_claimed_out ?? afterClaim.totalClaimedOut) !== String(state.distributable_pot)) {
    throw new Error("claimed amount did not match distributable pot");
  }

  console.log("smoke: success");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
