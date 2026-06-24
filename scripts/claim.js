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

loadEnv({ preserve: ['USER_SECRET_KEY'] });

const claimCircuit = JSON.parse(
  readFileSync('./circuits/claim/target/claim.json', 'utf8'),
);
const proofOptions = { keccak: true };

function saltToBigInt(salt) {
  return BigInt(salt);
}

function readMarketState() {
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
      'get_state',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const raw = JSON.parse(output);
  return {
    total_committed: BigInt(raw.total_committed),
    public_yes_quote_bps: BigInt(raw.public_yes_quote_bps),
    public_no_quote_bps: BigInt(raw.public_no_quote_bps),
    registered_claim_amount: BigInt(raw.registered_claim_amount),
    resolved: raw.resolved,
    outcome: raw.outcome,
    outcome_price: BigInt(raw.outcome_price),
    distributable_pot: BigInt(raw.distributable_pot),
  };
}

async function claimWinnings(betDataFile, userSecretKey) {
  await initBarretenberg();

  const betData = JSON.parse(readFileSync(betDataFile, 'utf8'));
  const betSide = betData.side || betData.direction;
  const userKeypair = Keypair.fromSecret(userSecretKey);

  const amountInStroops = BigInt(betData.amountInStroops);
  const commitmentState = await poseidon2Permutation([
    betSide === 'YES' ? 1n : 0n,
    amountInStroops,
    saltToBigInt(betData.salt),
    0n,
  ]);
  const nullifierState = await poseidon2Permutation([saltToBigInt(betData.salt), 12345n, 0n, 0n]);
  const commitment = BigInt(commitmentState[0]);
  const nullifier = BigInt(nullifierState[0]);
  const nullifierHex = `0x${nullifier.toString(16).padStart(64, '0')}`;
  const commitmentHex = `0x${commitment.toString(16).padStart(64, '0')}`;

  if (betData.commitment && betData.commitment.toLowerCase() !== commitmentHex.toLowerCase()) {
    throw new Error('saved bet commitment does not match the circuit-derived commitment');
  }

  const marketState = readMarketState();
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
    outcome: marketState.outcome ? '1' : '0',
    nullifier: nullifierHex,
  };

  console.log('Market state:', {
    resolved: marketState.resolved,
    outcome: marketState.outcome ? 'YES' : 'NO',
    total_committed: marketState.total_committed.toString(),
    yes_share_quote_bps: marketState.public_yes_quote_bps.toString(),
    no_share_quote_bps: marketState.public_no_quote_bps.toString(),
    registered_claim_amount: marketState.registered_claim_amount.toString(),
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
      'register_win',
      '--user',
      userKeypair.publicKey(),
      '--commitment',
      betData.commitment.slice(2),
      '--amount',
      amountInStroops.toString(),
      '--nullifier',
      nullifierHex.slice(2),
      '--proof-file-path',
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
