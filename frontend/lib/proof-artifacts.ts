const STROOPS_PER_USDC = BigInt(10_000_000);
const NULLIFIER_DOMAIN = BigInt(12_345);
const FIELD_MASK = (BigInt(1) << BigInt(248)) - BigInt(1);

export type MarketSide = "YES" | "NO";

export function sideToField(side: MarketSide) {
  return side === "YES" ? BigInt(1) : BigInt(0);
}

export function amountUsdcToStroops(amountUsdc: number) {
  return BigInt(amountUsdc) * STROOPS_PER_USDC;
}

export function padHex32(value: bigint) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function marketIdToField(marketId: string) {
  const clean = marketId.replace(/^0x/i, "").toLowerCase();
  return BigInt(`0x${clean}`) & FIELD_MASK;
}

export function stringToField(value: string) {
  let acc = BigInt(0);
  for (let index = 0; index < value.length; index += 1) {
    acc = ((acc * BigInt(257)) + BigInt(value.charCodeAt(index))) & FIELD_MASK;
  }
  return acc;
}

export async function derivePositionArtifacts(
  poseidon2Permutation: (inputs: Array<bigint | number | string>) => Promise<bigint[]>,
  input: {
    marketId: string;
    side: MarketSide;
    amountInStroops: bigint;
    salt: string;
  },
) {
  const direction = sideToField(input.side);
  const salt = BigInt(input.salt);
  const marketField = marketIdToField(input.marketId);

  const [commitment] = await poseidon2Permutation([
    marketField,
    direction,
    input.amountInStroops,
    salt,
  ]);
  const [nullifier] = await poseidon2Permutation([marketField, salt, NULLIFIER_DOMAIN, BigInt(0)]);

  return {
    direction,
    marketField,
    commitment,
    nullifier,
    commitmentHex: padHex32(commitment),
    nullifierHex: padHex32(nullifier),
  };
}
