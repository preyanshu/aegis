import { poseidon2Permutation } from '@aztec/foundation/crypto';
import { Noir } from '@noir-lang/noir_js';
import {
  Keypair,
} from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { createUltraHonkBackend, initBarretenberg } from './barretenberg.js';

loadEnv({ preserve: ['USER_SECRET_KEY', 'MARKET_ID'] });

const claimCircuit = JSON.parse(
  readFileSync('./circuits/claim/target/claim.json', 'utf8'),
);
const proofOptions = { keccak: true };

function saltToBigInt(salt) {
  return BigInt(salt);
}

function readMarketState(marketId) {
  const output = execFileSync(
    'stellar',
    [
      'contract',
      'invoke',
      '--id',
      process.env.MARKET_CONTRACT_ID,
      '--source',
      process.env.ADMIN_SECRET_KEY,
      '--rpc-url',
      process.env.STELLAR_RPC,
      '--network-passphrase',
      process.env.STELLAR_NETWORK,
      '--send=no',
      '--',
      'get_market_state',
      '--market_id',
      marketId,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const raw = JSON.parse(output);
  return {
    total_locked_collateral: BigInt(raw.total_locked_collateral),
    resolved: raw.resolved,
    outcome: raw.outcome,
    distributable_pot: BigInt(raw.distributable_pot),
    winning_side_total: BigInt(raw.winning_side_total),
  };
}

async function claimWinnings(betDataFile, userSecretKey) {
  await initBarretenberg();

  const betData = JSON.parse(readFileSync(betDataFile, 'utf8'));
  const betSide = betData.side || betData.direction;
  const marketId = betData.marketId || betData.market_id || process.env.MARKET_ID;
  if (!marketId) {
    throw new Error('set MARKET_ID or store marketId in the bet file');
  }
  const userKeypair = Keypair.fromSecret(userSecretKey);

  const amountInStroops = BigInt(betData.amountInStroops);
  const commitmentState = await poseidon2Permutation([
    BigInt(`0x${marketId}`) & ((1n << 248n) - 1n),
    betSide === 'YES' ? 1n : 0n,
    amountInStroops,
    saltToBigInt(betData.salt),
  ]);
  const nullifierState = await poseidon2Permutation([BigInt(`0x${marketId}`) & ((1n << 248n) - 1n), saltToBigInt(betData.salt), 12345n, 0n]);
  const commitment = BigInt(commitmentState[0]);
  const nullifier = BigInt(nullifierState[0]);
  const nullifierHex = `0x${nullifier.toString(16).padStart(64, '0')}`;
  const commitmentHex = `0x${commitment.toString(16).padStart(64, '0')}`;

  if (betData.commitment && betData.commitment.toLowerCase() !== commitmentHex.toLowerCase()) {
    throw new Error('saved bet commitment does not match the circuit-derived commitment');
  }

  const marketState = readMarketState(marketId);
  if (!marketState.resolved) {
    throw new Error('market has not been resolved yet');
  }

  if (betSide !== (marketState.outcome ? 'YES' : 'NO')) {
    throw new Error('this bet lost, so it cannot be registered for payout');
  }

  const inputs = {
    direction: betSide === 'YES' ? '1' : '0',
    amount: amountInStroops.toString(),
    salt: betData.salt,
    commitment: betData.commitment ?? commitmentHex,
    market_id: (BigInt(`0x${marketId}`) & ((1n << 248n) - 1n)).toString(),
    outcome: marketState.outcome ? '1' : '0',
    nullifier: nullifierHex,
    distributable_pot: marketState.distributable_pot.toString(),
    winning_side_total: marketState.winning_side_total.toString(),
    payout: ((amountInStroops * marketState.distributable_pot) / marketState.winning_side_total).toString(),
  };

  console.log('Market state:', {
    resolved: marketState.resolved,
    outcome: marketState.outcome ? 'YES' : 'NO',
    total_locked_collateral: marketState.total_locked_collateral.toString(),
    winning_side_total: marketState.winning_side_total.toString(),
    marketId,
  });

  console.log('Generating claim proof...');
  const backend = createUltraHonkBackend(claimCircuit.bytecode);
  const noir = new Noir(claimCircuit);
  const { witness } = await noir.execute(inputs);
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  const workDir = mkdtempSync(join(tmpdir(), 'blindmarket-claim-'));
  const proofPath = join(workDir, 'proof.bin');
  writeFileSync(proofPath, Buffer.from(proof.proof));
  const output = execFileSync(
    'stellar',
    [
      'contract',
      'invoke',
      '--id',
      process.env.MARKET_CONTRACT_ID,
      '--source',
      userSecretKey,
      '--rpc-url',
      process.env.STELLAR_RPC,
      '--network-passphrase',
      process.env.STELLAR_NETWORK,
      '--',
      'claim_winnings',
      '--market_id',
      marketId,
      '--commitment',
      betData.commitment.slice(2),
      '--nullifier',
      nullifierHex.slice(2),
      '--recipient',
      userKeypair.publicKey(),
      '--proof_bytes-file-path',
      proofPath,
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  rmSync(workDir, { recursive: true, force: true });
  const txHash = output.match(/[a-f0-9]{64}/i)?.[0] ?? 'unknown';
  console.log('Win registered. Transaction:', txHash);
}

const [, , betFile] = process.argv;

if (!betFile) {
  console.error('Usage: node scripts/claim.js <bet-json-file>');
  process.exit(1);
}

const userKey = process.env.USER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
claimWinnings(betFile, userKey).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
