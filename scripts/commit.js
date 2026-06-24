import { poseidon2Permutation } from '@aztec/foundation/crypto';
import { Noir } from '@noir-lang/noir_js';
import {
  Keypair,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnv } from './env.js';
import { createUltraHonkBackend, initBarretenberg } from './barretenberg.js';

loadEnv({ preserve: ['USER_SECRET_KEY', 'MARKET_ID'] });

const commitCircuit = JSON.parse(
  readFileSync('./circuits/commit/target/commit.json', 'utf8'),
);
const proofOptions = { keccak: true };

function randomFieldSalt() {
  return `0x${randomBytes(31).toString('hex')}`;
}

async function placeBet(userSecretKey, side, amountUsdc) {
  await initBarretenberg();

  const userKeypair = Keypair.fromSecret(userSecretKey);
  const marketId = process.env.MARKET_ID;
  if (!marketId) {
    throw new Error('set MARKET_ID to the market you want to trade');
  }

  const salt = randomFieldSalt();
  const directionField = side ? '1' : '0';
  const amountInStroops = BigInt(amountUsdc) * 10_000_000n;

  const commitmentState = await poseidon2Permutation([
    BigInt(directionField),
    amountInStroops,
    BigInt(salt),
    0n,
  ]);
  const commitment = BigInt(commitmentState[0]);
  const nullifierState = await poseidon2Permutation([BigInt(salt), 12345n, 0n, 0n]);
  const nullifier = BigInt(nullifierState[0]);
  const commitmentHex = `0x${commitment.toString(16).padStart(64, '0')}`;
  const nullifierHex = `0x${nullifier.toString(16).padStart(64, '0')}`;

  console.log('Save these values. You need them to claim winnings.');
  console.log('position:', side ? 'YES shares' : 'NO shares');
  console.log('amount:', amountUsdc, 'USDC');
  console.log('salt:', salt);
  console.log('commitment:', commitmentHex);
  console.log('nullifier:', nullifierHex);

  const minBet = 1_000_000n;
  const maxBet = 1_000_000_000n;
  const inputs = {
    direction: directionField,
    amount: amountInStroops.toString(),
    salt,
    commitment: commitmentHex,
    min_amount: minBet.toString(),
    max_amount: maxBet.toString(),
  };

  console.log('Generating ZK proof...');
  const backend = createUltraHonkBackend(commitCircuit.bytecode);
  const noir = new Noir(commitCircuit);
  const { witness } = await noir.execute(inputs);
  const proof = await backend.generateProof(witness, proofOptions);
  await backend.destroy?.();

  const workDir = mkdtempSync(join(tmpdir(), 'blindmarket-commit-'));
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
      'commit',
      '--market_id',
      marketId,
      '--user',
      userKeypair.publicKey(),
      '--commitment',
      commitmentHex.slice(2),
      '--proof-file-path',
      proofPath,
      '--amount',
      amountInStroops.toString(),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  rmSync(workDir, { recursive: true, force: true });
  const txHash = output.match(/[a-f0-9]{64}/i)?.[0] ?? 'unknown';
  console.log('Bet placed. Transaction:', txHash);

  const filename = `bet-${Date.now()}.json`;
  writeFileSync(
    filename,
    JSON.stringify(
      {
        commitment: commitmentHex,
        nullifier: nullifierHex,
        marketId,
        side: side ? 'YES' : 'NO',
        amount: amountUsdc,
        amountInStroops: amountInStroops.toString(),
        salt,
        txHash,
      },
      null,
      2,
    ),
  );
  console.log(`Private share position saved to ${filename}`);
}

const [, , directionArg, amountArg] = process.argv;

if (!directionArg || !amountArg || !['YES', 'NO'].includes(directionArg)) {
  console.error('Usage: node scripts/commit.js <YES|NO> <amountUsdc>');
  process.exit(1);
}

const userKey = process.env.USER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
placeBet(userKey, directionArg === 'YES', Number.parseInt(amountArg, 10)).catch(
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
