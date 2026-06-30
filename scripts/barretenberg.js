import { BarretenbergSync, Fr, UltraHonkBackend } from '@aztec/bb.js';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const barretenbergWasmPath = resolve(
  rootDir,
  'node_modules/@aztec/bb.js/dest/node/barretenberg_wasm/barretenberg-threads.wasm.gz',
);

let initPromise;

export async function initBarretenberg() {
  initPromise ??= BarretenbergSync.initSingleton(barretenbergWasmPath);
  await initPromise;
}

export async function poseidon2PermutationFields(inputs) {
  await initBarretenberg();
  return BarretenbergSync.getSingleton()
    .poseidon2Permutation(inputs.map((input) => new Fr(BigInt(input))))
    .map((field) => BigInt(field.toString()));
}

export function createUltraHonkBackend(bytecode) {
  return new UltraHonkBackend(bytecode, {
    threads: 1,
    wasmPath: barretenbergWasmPath,
  });
}
