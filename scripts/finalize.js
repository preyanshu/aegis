import { execFileSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ override: true });

async function finalizeClaims() {
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
      '--',
      'finalize_claims',
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const txHash = output.match(/[a-f0-9]{64}/i)?.[0] ?? 'unknown';
  console.log('Claims finalized. Transaction:', txHash);
}

finalizeClaims().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
