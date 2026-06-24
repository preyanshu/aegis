import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Keypair } from '@stellar/stellar-sdk';
import dotenv from 'dotenv';

dotenv.config({ override: true });

const requestedMarketId = process.argv[2];
const marketId =
  requestedMarketId && requestedMarketId !== '--new'
    ? requestedMarketId
    : randomBytes(32).toString('hex');
const creator = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY).publicKey();

function run(label, args) {
  const output = execFileSync('stellar', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const txHash = output.match(/[a-f0-9]{64}/i)?.[0] ?? 'unknown';
  console.log(`${label}: ${txHash}`);
  return output;
}

async function createMarket() {
  run('market created', [
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
    '--',
    'create_market',
    '--creator',
    creator,
    '--market_id',
    marketId,
    '--question',
    process.env.MARKET_QUESTION || 'Will BTC be above $50,000 on July 1, 2026?',
    '--target_price',
    process.env.TARGET_PRICE || '500000000000',
    '--end_timestamp',
    (process.env.END_TIMESTAMP || Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000)).toString(),
    '--min_bet',
    '1000000',
    '--max_bet',
    '1000000000',
    '--fee_bps',
    '200',
  ]);

  if (process.env.WRITE_MARKET_ID === '1') {
    const envPath = '.env';
    const current = readFileSync(envPath, 'utf8');
    let next = current;
    if (next.match(/^MARKET_ID=.*$/m)) {
      next = next.replace(/^MARKET_ID=.*$/m, `MARKET_ID=${marketId}`);
    } else {
      next += `\nMARKET_ID=${marketId}`;
    }
    writeFileSync(envPath, next);
  }
  console.log(`MARKET_ID=${marketId}`);
}

createMarket().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
