import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import { loadEnv } from './env.js';

loadEnv();

const sourceAccount = process.env.ADMIN_SECRET_KEY;
const sourcePublicKey = Keypair.fromSecret(sourceAccount).publicKey();
const rpcUrl = process.env.STELLAR_RPC;
const networkPassphrase = process.env.STELLAR_NETWORK;

const verifierWasmPath =
  './contracts/ultrahonk_verifier/target/wasm32v1-none/release/ultrahonk_verifier.wasm';
const marketWasmPath =
  './contracts/blind_market/target/wasm32v1-none/release/blind_market.wasm';

function deriveSaltHex() {
  return randomBytes(32).toString('hex');
}

function runCli(args, label) {
  const output = execFileSync('stellar', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const printable = output.trim();
  if (printable) {
    console.log(`${label}: ${printable}`);
  } else {
    console.log(`${label}: ok`);
  }
  return output;
}

function uploadWasm(path, label) {
  const output = runCli(
    [
      'contract',
      'upload',
      '--wasm',
      path,
      '--source-account',
      sourceAccount,
      '--rpc-url',
      rpcUrl,
      '--network-passphrase',
      networkPassphrase,
    ],
    `upload ${label}`,
  );
  const wasmHash = output.match(/[a-f0-9]{64}/i)?.[0];
  if (!wasmHash) {
    throw new Error(`could not parse wasm hash from ${label} upload`);
  }
  return wasmHash;
}

function deployContract(wasmHash, label, constructorArgs = []) {
  const args = [
    'contract',
    'deploy',
    '--wasm-hash',
    wasmHash,
    '--source-account',
    sourceAccount,
    '--rpc-url',
    rpcUrl,
    '--network-passphrase',
    networkPassphrase,
  ];
  if (constructorArgs.length > 0) {
    args.push('--', ...constructorArgs);
  }
  const output = runCli(args, `deploy ${label}`);
  const contractId = output.match(/C[A-Z0-9]{55}/i)?.[0];
  if (!contractId) {
    throw new Error(`could not parse contract id from ${label} deployment`);
  }
  return contractId;
}

function initializeMarket(contractId, commitVerifierId, claimVerifierId) {
  const endTimestamp = BigInt(
    process.env.END_TIMESTAMP ||
      Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
  );
  runCli(
    [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source-account',
      sourceAccount,
      '--rpc-url',
      rpcUrl,
      '--network-passphrase',
      networkPassphrase,
      '--',
      'initialize',
      '--admin',
      sourcePublicKey,
      '--question',
      process.env.MARKET_QUESTION || 'Will BTC be above $50,000 on July 1, 2026?',
      '--target_price',
      process.env.TARGET_PRICE || '500000000000',
      '--end_timestamp',
      endTimestamp.toString(),
      '--min_bet',
      '1000000',
      '--max_bet',
      '1000000000',
      '--fee_bps',
      '200',
      '--usdc_token',
      process.env.USDC_TOKEN_ID,
      '--reflector_contract',
      process.env.REFLECTOR_ID,
    ],
    'initialize market',
  );

  runCli(
    [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source-account',
      sourceAccount,
      '--rpc-url',
      rpcUrl,
      '--network-passphrase',
      networkPassphrase,
      '--',
      'set_verifiers',
      '--admin',
      sourcePublicKey,
      '--commit_verifier',
      commitVerifierId,
      '--claim_verifier',
      claimVerifierId,
    ],
    'set market verifiers',
  );
}

function updateEnv(values) {
  const envPath = '.env';
  const current = readFileSync(envPath, 'utf8');
  let next = current;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    if (next.match(new RegExp(`^${key}=.*$`, 'm'))) {
      next = next.replace(new RegExp(`^${key}=.*$`, 'm'), line);
    } else {
      next += `\n${line}`;
    }
  }
  writeFileSync(envPath, next);
}

async function main() {
  console.log(`Deploying from ${sourceAccount}`);

  const verifierHash = uploadWasm(verifierWasmPath, 'ultrahonk verifier');
  const marketHash = uploadWasm(marketWasmPath, 'blind market');

  const commitVerifierId = deployContract(verifierHash, 'commit verifier', [
    '--vk_bytes-file-path',
    './verifier/commit_vk.bin',
  ]);
  const claimVerifierId = deployContract(verifierHash, 'claim verifier', [
    '--vk_bytes-file-path',
    './verifier/claim_vk.bin',
  ]);
  const marketContractId = deployContract(marketHash, 'blind market');

  initializeMarket(marketContractId, commitVerifierId, claimVerifierId);

  updateEnv({
    COMMIT_VERIFIER_ID: commitVerifierId,
    CLAIM_VERIFIER_ID: claimVerifierId,
    MARKET_CONTRACT_ID: marketContractId,
  });

  console.log('Deployment complete.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
