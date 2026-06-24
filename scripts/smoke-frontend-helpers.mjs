import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

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
const user3 = config.wallets.find((wallet) => wallet.label === "user3");

if (!admin || !user2 || !user3) {
  throw new Error("expected admin, user2, and user3 wallets in .env");
}

function serialize(value) {
  return JSON.stringify(
    value,
    (_, current) => (typeof current === "bigint" ? current.toString() : current),
    2,
  );
}

async function refreshSnapshot(marketId) {
  const [view, user2Position, user3Position, adminPosition] = await Promise.all([
    stellar.loadMarketView(marketId, "admin"),
    stellar.loadPosition(marketId, user2.publicKey, "admin"),
    stellar.loadPosition(marketId, user3.publicKey, "admin"),
    stellar.loadPosition(marketId, admin.publicKey, "admin"),
  ]);

  return {
    view,
    positions: {
      user2: user2Position,
      user3: user3Position,
      admin: adminPosition,
    },
  };
}

async function main() {
  const marketId = randomBytes(32).toString("hex");
  const endTimestamp = BigInt(Math.floor(Date.now() / 1000) + 90);

  console.log(`marketId=${marketId}`);

  const created = await stellar.createMarket(admin, {
    marketId,
    question: "Frontend helper trading smoke test market",
    targetPrice: 1n,
    endTimestamp,
    minBet: 10_000n,
    maxBet: 50_000_000n,
    feeBps: 100,
  });
  console.log(`createMarket tx=${created.hash}`);

  const buy1 = await stellar.buyShares(user3, {
    marketId,
    side: "YES",
    amountInStroops: 1_500_000n,
  });
  console.log(`user3 buy YES tx=${buy1.hash}`);

  const buy2 = await stellar.buyShares(user3, {
    marketId,
    side: "YES",
    amountInStroops: 1_000_000n,
  });
  console.log(`user3 add YES tx=${buy2.hash}`);

  const buy3 = await stellar.buyShares(user2, {
    marketId,
    side: "NO",
    amountInStroops: 100_000n,
  });
  console.log(`user2 buy NO tx=${buy3.hash}`);

  const sell = await stellar.sellShares(user3, {
    marketId,
    side: "YES",
    shareAmount: 500_000n,
  });
  console.log(`user3 sell YES tx=${sell.hash}`);

  const stateAfterTrades = await refreshSnapshot(marketId);
  console.log("afterTrades=", serialize(stateAfterTrades));

  const waitMs = Number(endTimestamp * 1000n - BigInt(Date.now()) + 4000n);
  if (waitMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  const resolved = await stellar.resolveMarket(admin, marketId);
  console.log(`resolveMarket tx=${resolved.hash}`);

  const afterResolve = await refreshSnapshot(marketId);
  console.log("afterResolve=", serialize(afterResolve));

  if (!afterResolve.view.state.outcome) {
    throw new Error("expected YES outcome for smoke test");
  }

  const user3Collect = await stellar.collectPositionPayout(user3, marketId);
  console.log(`user3 collect tx=${user3Collect.hash}`);

  const finalSnapshot = await refreshSnapshot(marketId);
  console.log("finalSnapshot=", serialize(finalSnapshot));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
