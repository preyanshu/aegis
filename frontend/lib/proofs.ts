import { bytesToHex } from "@/lib/stellar";

type ProofPackage = {
  proofHex: string;
};

type CommitCircuit = {
  bytecode: string;
};

type ClaimCircuit = {
  bytecode: string;
};

const proofOptions = { keccak: true };

let commitCircuitPromise: Promise<CommitCircuit> | null = null;
let claimCircuitPromise: Promise<ClaimCircuit> | null = null;

function randomFieldSalt() {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return `0x${bytesToHex(bytes)}`;
}

function toHex32(value: bigint) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

async function ensurePoseidon() {
  // The browser bundle ships without TypeScript declarations for this deep path.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const { BarretenbergSync, Fr: FrBarretenberg } = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  await BarretenbergSync.initSingleton();
  return {
    FrBarretenberg,
    poseidon2Permutation: async (inputs: Array<bigint | number | string>) => {
      const api = BarretenbergSync.getSingleton();
      const result = await api.poseidon2Permutation(
        inputs.map((input) => new FrBarretenberg(typeof input === "string" ? BigInt(input) : BigInt(input))),
      );
      return result.map((field: any) => BigInt(`0x${bytesToHex(field.toBuffer())}`));
    },
  };
}

async function loadCommitCircuit() {
  commitCircuitPromise ??= fetch("/circuits/commit.json").then((response) => {
    if (!response.ok) {
      throw new Error(`failed to load commit circuit: ${response.status}`);
    }
    return response.json();
  });
  return commitCircuitPromise;
}

async function loadClaimCircuit() {
  claimCircuitPromise ??= fetch("/circuits/claim.json").then((response) => {
    if (!response.ok) {
      throw new Error(`failed to load claim circuit: ${response.status}`);
    }
    return response.json();
  });
  return claimCircuitPromise;
}

function proofBytesToHex(proof: unknown) {
  if (proof instanceof Uint8Array) {
    return `0x${bytesToHex(proof)}`;
  }
  if (proof instanceof ArrayBuffer) {
    return `0x${bytesToHex(new Uint8Array(proof))}`;
  }
  if (Array.isArray(proof)) {
    return `0x${bytesToHex(Uint8Array.from(proof))}`;
  }
  throw new Error("unexpected proof payload");
}

export async function generateCommitProof(input: {
  side: "YES" | "NO";
  amountUsdc: number;
  minBet: bigint;
  maxBet: bigint;
}) {
  const commitCircuit = await loadCommitCircuit();
  const { poseidon2Permutation } = await ensurePoseidon();

  const salt = randomFieldSalt();
  const directionField = input.side === "YES" ? BigInt(1) : BigInt(0);
  const amountInStroops = BigInt(input.amountUsdc) * BigInt(10_000_000);

  const commitmentState = await poseidon2Permutation([directionField, amountInStroops, BigInt(salt), BigInt(0)]);
  const commitment = commitmentState[0];
  const nullifierState = await poseidon2Permutation([BigInt(salt), BigInt(12345), BigInt(0), BigInt(0)]);
  const nullifier = nullifierState[0];

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(commitCircuit as any);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend((commitCircuit as any).bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: directionField.toString(),
    amount: amountInStroops.toString(),
    salt,
    commitment: toHex32(commitment),
    min_amount: input.minBet.toString(),
    max_amount: input.maxBet.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    amountInStroops,
    commitment: toHex32(commitment),
    nullifier: toHex32(nullifier),
    proofHex: proofBytesToHex(proof.proof),
    salt,
  };
}

export async function generateClaimProof(input: {
  side: "YES" | "NO";
  amountInStroops: bigint;
  salt: string;
  commitment: string;
  nullifier: string;
  outcome: boolean;
}) {
  const claimCircuit = await loadClaimCircuit();
  const { poseidon2Permutation } = await ensurePoseidon();

  const directionField = input.side === "YES" ? BigInt(1) : BigInt(0);
  const commitmentState = await poseidon2Permutation([directionField, input.amountInStroops, BigInt(input.salt), BigInt(0)]);
  const computedCommitment = commitmentState[0];
  const nullifierState = await poseidon2Permutation([BigInt(input.salt), BigInt(12345), BigInt(0), BigInt(0)]);
  const computedNullifier = nullifierState[0];

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(claimCircuit as any);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend((claimCircuit as any).bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: directionField.toString(),
    amount: input.amountInStroops.toString(),
    salt: input.salt,
    commitment: toHex32(computedCommitment),
    outcome: input.outcome ? "1" : "0",
    nullifier: toHex32(computedNullifier),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitment: toHex32(computedCommitment),
    nullifier: toHex32(computedNullifier),
    proofHex: proofBytesToHex(proof.proof),
  };
}
