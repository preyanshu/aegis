const STROOPS_PER_USDC = BigInt(10_000_000);
const NULLIFIER_DOMAIN = BigInt(12_345);

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

export async function derivePositionArtifacts(
  poseidon2Permutation: (inputs: Array<bigint | number | string>) => Promise<bigint[]>,
  input: {
    side: MarketSide;
    amountInStroops: bigint;
    salt: string;
  },
) {
  const direction = sideToField(input.side);
  const salt = BigInt(input.salt);

  const [commitment] = await poseidon2Permutation([
    direction,
    input.amountInStroops,
    salt,
    BigInt(0),
  ]);
  const [nullifier] = await poseidon2Permutation([salt, NULLIFIER_DOMAIN, BigInt(0), BigInt(0)]);

  return {
    direction,
    commitment,
    nullifier,
    commitmentHex: padHex32(commitment),
    nullifierHex: padHex32(nullifier),
  };
}
