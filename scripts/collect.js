import {
  Keypair,
} from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadEnv } from './env.js';

loadEnv({ preserve: ['USER_SECRET_KEY', 'BET_FILE', 'MARKET_ID'] });

export async function collect(userSecretKey) {
  const betDataFile = process.env.BET_FILE;
  if (!betDataFile) {
    throw new Error('set BET_FILE to the bet JSON created during commit');
  }
  const betData = JSON.parse(readFileSync(betDataFile, 'utf8'));
  const marketId = betData.marketId || betData.market_id || process.env.MARKET_ID;
  if (!marketId) {
    throw new Error('set MARKET_ID or store marketId in the bet file');
  }
  const userKeypair = Keypair.fromSecret(userSecretKey);
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
      'collect',
      '--market_id',
      marketId,
      '--user',
      userKeypair.publicKey(),
      '--nullifier',
      betData.nullifier.slice(2),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const txHash = output.match(/[a-f0-9]{64}/i)?.[0] ?? 'unknown';
  console.log('Collected payout. Transaction:', txHash);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const userKey = process.env.USER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
  collect(userKey).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
