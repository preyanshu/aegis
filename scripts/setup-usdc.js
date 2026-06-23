import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import dotenv from 'dotenv';

dotenv.config();

const horizon = new Horizon.Server('https://horizon-testnet.stellar.org');
const usdcIssuer =
  process.env.USDC_ISSUER || 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const usdcAsset = new Asset('USDC', usdcIssuer);
const defaultTrustLimit = '1000000000';

const wallets = [
  { label: 'admin', secret: process.env.ADMIN_SECRET_KEY },
  { label: 'user2', secret: process.env.USER2_SECRET_KEY },
  { label: 'user3', secret: process.env.USER3_SECRET_KEY },
].filter(({ secret }) => Boolean(secret));

async function fundWithFriendbot(publicKey) {
  const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`friendbot failed for ${publicKey}: ${response.status} ${text}`);
  }
}

async function ensureAccountExists(keypair, label) {
  try {
    await horizon.loadAccount(keypair.publicKey());
    console.log(`${label}: account already exists`);
    return;
  } catch {
    console.log(`${label}: funding XLM with friendbot`);
    await fundWithFriendbot(keypair.publicKey());
    console.log(`${label}: funded`);
  }
}

async function submitClassicTx(keypair, op, label) {
  const account = await horizon.loadAccount(keypair.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: 'Test SDF Network ; September 2015',
  })
    .addOperation(op)
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);
  console.log(`${label}: ${result.hash}`);
  return result;
}

async function establishTrustline(keypair, label) {
  console.log(`${label}: creating USDC trustline`);
  await submitClassicTx(
    keypair,
    Operation.changeTrust({ asset: usdcAsset, limit: defaultTrustLimit }),
    `${label} trustline`,
  );
}

function parseBalance(account) {
  const balance = account.balances.find(
    (entry) => entry.asset_type === 'credit_alphanum4' && entry.asset_code === 'USDC',
  );
  return balance ? balance.balance : '0';
}

function balanceToStroops(balance) {
  const [whole = '0', fraction = ''] = balance.split('.');
  const paddedFraction = `${fraction}0000000`.slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(paddedFraction);
}

async function transferUsdc(fromKeypair, toPublicKey, amount, label) {
  await submitClassicTx(
    fromKeypair,
    Operation.payment({
      destination: toPublicKey,
      asset: usdcAsset,
      amount,
    }),
    label,
  );
}

async function main() {
  const [admin, user2, user3] = wallets.map(({ label, secret }) => ({
    label,
    keypair: Keypair.fromSecret(secret),
  }));

  for (const wallet of [admin, user2, user3]) {
    await ensureAccountExists(wallet.keypair, wallet.label);
    await establishTrustline(wallet.keypair, wallet.label);
  }

  const adminAccount = await horizon.loadAccount(admin.keypair.publicKey());
  const adminBalance = parseBalance(adminAccount);
  console.log(`admin USDC balance: ${adminBalance}`);

  const adminStroops = balanceToStroops(adminBalance);
  if (adminStroops <= 0n) {
    console.log('No USDC balance found on admin after trustline setup; nothing to split.');
    return;
  }

  const share = adminStroops / 3n;
  const remainder = adminStroops - share * 3n;
  const adminKeep = share + remainder;
  const transferWhole = share / 10_000_000n;
  const transferFraction = (share % 10_000_000n).toString().padStart(7, '0');
  const transferAmountString =
    transferFraction === '0000000'
      ? transferWhole.toString()
      : `${transferWhole.toString()}.${transferFraction}`;

  if (share > 0n) {
    console.log(`splitting USDC equally: ${transferAmountString} USDC to each user wallet`);
    await transferUsdc(
      admin.keypair,
      user2.keypair.publicKey(),
      transferAmountString,
      'admin -> user2 payment',
    );
    await transferUsdc(
      admin.keypair,
      user3.keypair.publicKey(),
      transferAmountString,
      'admin -> user3 payment',
    );
  }

  const updatedAdmin = await horizon.loadAccount(admin.keypair.publicKey());
  const updatedUser2 = await horizon.loadAccount(user2.keypair.publicKey());
  const updatedUser3 = await horizon.loadAccount(user3.keypair.publicKey());
  console.log(`final admin USDC balance: ${parseBalance(updatedAdmin)}`);
  console.log(`final user2 USDC balance: ${parseBalance(updatedUser2)}`);
  console.log(`final user3 USDC balance: ${parseBalance(updatedUser3)}`);
  console.log(`admin kept approx: ${adminKeep.toString()} stroops`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
