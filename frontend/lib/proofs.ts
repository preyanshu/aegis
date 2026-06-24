import { amountUsdcToStroops, derivePositionArtifacts } from "@/lib/proof-artifacts";
import { bytesToHex } from "@/lib/stellar";

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
  const amountInStroops = amountUsdcToStroops(input.amountUsdc);
  const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
    side: input.side,
    amountInStroops,
    salt,
  });

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(commitCircuit as any);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend((commitCircuit as any).bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: amountInStroops.toString(),
    salt,
    commitment: artifacts.commitmentHex,
    min_amount: input.minBet.toString(),
    max_amount: input.maxBet.toString(),
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    amountInStroops,
    commitment: artifacts.commitmentHex,
    nullifier: artifacts.nullifierHex,
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
  const artifacts = await derivePositionArtifacts(poseidon2Permutation, {
    side: input.side,
    amountInStroops: input.amountInStroops,
    salt: input.salt,
  });

  if (input.commitment.toLowerCase() !== artifacts.commitmentHex.toLowerCase()) {
    throw new Error("claim proof inputs do not reproduce the saved commitment");
  }
  if (input.nullifier.toLowerCase() !== artifacts.nullifierHex.toLowerCase()) {
    throw new Error("claim proof inputs do not reproduce the saved nullifier");
  }

  const noirModule = await import("@noir-lang/noir_js");
  const noir = new noirModule.Noir(claimCircuit as any);
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-expect-error browser bundle path is intentionally deep-imported
  const backendModule = await import("../node_modules/@aztec/bb.js/dest/browser/index.js");
  const backend = new backendModule.UltraHonkBackend((claimCircuit as any).bytecode, { threads: 1 });
  const { witness } = await noir.execute({
    direction: artifacts.direction.toString(),
    amount: input.amountInStroops.toString(),
    salt: input.salt,
    commitment: artifacts.commitmentHex,
    outcome: input.outcome ? "1" : "0",
    nullifier: artifacts.nullifierHex,
  });
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  return {
    commitment: artifacts.commitmentHex,
    nullifier: artifacts.nullifierHex,
    proofHex: proofBytesToHex(proof.proof),
  };
}
