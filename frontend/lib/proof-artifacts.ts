const STROOPS_PER_USDC = 10_000_000n;
const NULLIFIER_DOMAIN = 12_345n;
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

export type MarketSide = "YES" | "NO";

export function sideToField(side: MarketSide) {
  return side === "YES" ? 1n : 0n;
}

export function amountUsdcToStroops(amountUsdc: number) {
  return BigInt(amountUsdc) * STROOPS_PER_USDC;
}

export function padHex32(value: bigint) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function marketIdToField(marketId: string) {
  const normalized = marketId.replace(/^0x/i, "");
  if (!normalized) {
    return 0n;
  }

  return BigInt(`0x${normalized}`) % FIELD_MODULUS;
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
  // Keep the frontend derivation aligned with the Noir claim circuit.
  const [nullifier] = await poseidon2Permutation([marketField, salt, NULLIFIER_DOMAIN, 0n]);

  return {
    direction,
    marketField,
    commitment,
    nullifier,
    commitmentHex: padHex32(commitment),
    nullifierHex: padHex32(nullifier),
  };
}
