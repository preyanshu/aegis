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
if (!admin) {
  throw new Error("expected admin wallet in .env");
}

function serialize(value) {
  return JSON.stringify(
    value,
    (_, current) => (typeof current === "bigint" ? current.toString() : current),
    2,
  );
}

function randomMarketId() {
  return randomBytes(32).toString("hex");
}

async function createResolveAndCheck(label, input, expectedOutcome, expectedConditions) {
  const marketId = randomMarketId();
  const endTimestamp = BigInt(Math.floor(Date.now() / 1000) + 45);

  console.log(`${label}: marketId=${marketId}`);

  const created = await stellar.createMarket(admin, {
    marketId,
    endTimestamp,
    minBet: 10_000n,
    maxBet: 50_000_000n,
    feeBps: 100,
    ...input,
  });
  console.log(`${label}: createMarket tx=${created.hash}`);

  await new Promise((resolve) => setTimeout(resolve, Number(endTimestamp * 1000n - BigInt(Date.now()) + 4000n)));

  const resolved = await stellar.resolveMarket(admin, marketId);
  console.log(`${label}: resolveMarket tx=${resolved.hash}`);

  const view = await stellar.loadMarketView(marketId, "admin");
  console.log(`${label}: view=`, serialize(view));

  if (view.state.outcome !== expectedOutcome) {
    throw new Error(`${label}: expected outcome ${expectedOutcome}, got ${view.state.outcome}`);
  }

  if (view.state.resolved_conditions.length !== expectedConditions.length) {
    throw new Error(
      `${label}: expected ${expectedConditions.length} resolved conditions, got ${view.state.resolved_conditions.length}`,
    );
  }

  expectedConditions.forEach((expected, index) => {
    const actual = view.state.resolved_conditions[index];
    if (!actual) {
      throw new Error(`${label}: missing resolved condition ${index + 1}`);
    }
    if (actual.asset_symbol !== expected.asset_symbol || actual.satisfied !== expected.satisfied) {
      throw new Error(
        `${label}: condition ${index + 1} mismatch, expected ${expected.asset_symbol}/${expected.satisfied}, got ${actual.asset_symbol}/${actual.satisfied}`,
      );
    }
  });
}

async function main() {
  await createResolveAndCheck(
    "or_case",
    {
      question: "OR case: first false, second true",
      oracleConditions: [
        {
          oracle_contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
          asset_symbol: "BTC",
          greater_or_equal: false,
          threshold: 9_999_999_999_999n,
        },
        {
          oracle_contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
          asset_symbol: "ETH",
          greater_or_equal: true,
          threshold: 1n,
        },
      ],
      conditionOperators: [false],
    },
    true,
    [
      { asset_symbol: "BTC", satisfied: false },
      { asset_symbol: "ETH", satisfied: true },
    ],
  );

  await createResolveAndCheck(
    "three_condition_chain",
    {
      question: "3-condition chain: true OR false AND false",
      oracleConditions: [
        {
          oracle_contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
          asset_symbol: "BTC",
          greater_or_equal: true,
          threshold: 1n,
        },
      {
        oracle_contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
        asset_symbol: "ETH",
        greater_or_equal: true,
        threshold: 100_000_000_000_000_000_000n,
      },
      {
        oracle_contract: "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
        asset_symbol: "XLM",
        greater_or_equal: true,
        threshold: 100_000_000_000_000_000_000n,
      },
      ],
      conditionOperators: [false, true],
    },
    false,
    [
      { asset_symbol: "BTC", satisfied: true },
      { asset_symbol: "ETH", satisfied: false },
      { asset_symbol: "XLM", satisfied: false },
    ],
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
