import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import {
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  Address,
  xdr,
  scValToNative,
} from '@stellar/stellar-sdk';
import { loadEnv } from './env.js';

loadEnv({
  preserve: [
    'END_TIMESTAMP',
    'MARKET_CONTRACT_ID',
    'MARKET_CONDITION_COUNT',
    'MIN_BET',
    'MAX_BET',
    'MARKET_QUESTION',
    'MARKET_CATEGORY',
    'WRITE_MARKET_ID',
    'COND1_ASSET',
    'COND1_COMPARATOR',
    'COND1_THRESHOLD',
    'COND1_JOIN',
    'COND1_ORACLE',
    'COND2_ASSET',
    'COND2_COMPARATOR',
    'COND2_THRESHOLD',
    'COND2_JOIN',
    'COND2_ORACLE',
    'COND3_ASSET',
    'COND3_COMPARATOR',
    'COND3_THRESHOLD',
    'COND3_JOIN',
    'COND3_ORACLE',
    'COND4_ASSET',
    'COND4_COMPARATOR',
    'COND4_THRESHOLD',
    'COND4_JOIN',
    'COND4_ORACLE',
    'COND5_ASSET',
    'COND5_COMPARATOR',
    'COND5_THRESHOLD',
    'COND5_JOIN',
    'COND5_ORACLE',
  ],
});

const EXTERNAL_REFLECTOR_TESTNET = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63';
const FIAT_REFLECTOR_TESTNET = 'CCSSOHTBL3LEWUCBBEB5NJFC2OKFRC74OWEIJIZLRJBGAAU4VMU5NV4W';

const requestedMarketId = process.argv[2];
const marketId =
  requestedMarketId && requestedMarketId !== '--new'
    ? requestedMarketId
    : randomBytes(32).toString('hex');

const source = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const creator = source.publicKey();
const server = new rpc.Server(process.env.STELLAR_RPC);

function oracleContractForAsset(symbol) {
  if (['EUR', 'GBP', 'CHF', 'CAD', 'MXN', 'ARS', 'BRL', 'THB', 'XAU'].includes(symbol)) {
    return FIAT_REFLECTOR_TESTNET;
  }
  return EXTERNAL_REFLECTOR_TESTNET;
}

function buildCondition(index) {
  const asset = process.env[`COND${index}_ASSET`] || (index === 1 ? 'BTC' : 'ETH');
  const comparator = (process.env[`COND${index}_COMPARATOR`] || (index === 1 ? 'lte' : 'gte')).toLowerCase();
  const threshold =
    process.env[`COND${index}_THRESHOLD`] || (index === 1 ? '500000000000' : '20000000000');
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('asset_symbol'),
      val: xdr.ScVal.scvSymbol(asset),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('greater_or_equal'),
      val: xdr.ScVal.scvBool(comparator !== 'lte'),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('oracle_contract'),
      val: Address.fromString(process.env[`COND${index}_ORACLE`] || oracleContractForAsset(asset)).toScVal(),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('threshold'),
      val: xdr.ScVal.scvI128(
        new xdr.Int128Parts({
          hi: 0n,
          lo: BigInt(threshold),
        }),
      ),
    }),
  ]);
}

function oracleConditionsInputScVal(conditionCount, conditions, operators) {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_1'),
      val: conditions[0],
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_2'),
      val: conditions[1],
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_3'),
      val: conditions[2],
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_4'),
      val: conditions[3],
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_5'),
      val: conditions[4],
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('condition_count'),
      val: xdr.ScVal.scvU32(conditionCount),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('operator_1_is_and'),
      val: xdr.ScVal.scvBool(operators[0]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('operator_2_is_and'),
      val: xdr.ScVal.scvBool(operators[1]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('operator_3_is_and'),
      val: xdr.ScVal.scvBool(operators[2]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol('operator_4_is_and'),
      val: xdr.ScVal.scvBool(operators[3]),
    }),
  ]);
}

async function submit(method, args) {
  let account;
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      account = await server.getAccount(creator);
      break;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('Account not found')) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!account) {
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    const friendbotUrl = new URL('https://friendbot.stellar.org/');
    friendbotUrl.searchParams.set('addr', creator);
    const response = await fetch(friendbotUrl);
    if (!response.ok) {
      throw new Error(`friendbot funding failed after repeated lookup failures: ${message}; ${response.status} ${await response.text()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    account = await server.getAccount(creator);
  }
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: process.env.STELLAR_NETWORK,
  })
    .addOperation(new Contract(process.env.MARKET_CONTRACT_ID).call(method, ...args))
    .setTimeout(120)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(source);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`submit failed: ${JSON.stringify(sent.errorResult)}`);
  }

  for (;;) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      console.log(`market created: ${sent.hash}`);
      if (result.returnValue) {
        console.log('returnValue:', scValToNative(result.returnValue));
      }
      return sent.hash;
    }
    if (result.status === 'FAILED') {
      throw new Error(`transaction failed: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function createMarket() {
  const conditionCount = Number(process.env.MARKET_CONDITION_COUNT || 2);
  if (conditionCount < 1 || conditionCount > 5) {
    throw new Error('MARKET_CONDITION_COUNT must be between 1 and 5');
  }

  const conditions = Array.from({ length: 5 }, (_, index) => buildCondition(index + 1));
  const operators = [
    (process.env.COND1_JOIN || 'AND').toUpperCase() === 'AND',
    (process.env.COND2_JOIN || 'AND').toUpperCase() === 'AND',
    (process.env.COND3_JOIN || 'AND').toUpperCase() === 'AND',
    (process.env.COND4_JOIN || 'AND').toUpperCase() === 'AND',
  ];

  await submit('create_market', [
    nativeToScVal(creator, { type: 'address' }),
    nativeToScVal(Buffer.from(marketId, 'hex'), { type: 'bytes' }),
    nativeToScVal(
      process.env.MARKET_QUESTION || 'Will BTC stay below $50,000 and ETH stay above $2,000 at resolution?',
      { type: 'string' },
    ),
    nativeToScVal(process.env.MARKET_CATEGORY || 'macro', { type: 'string' }),
    oracleConditionsInputScVal(conditionCount, conditions, operators),
    nativeToScVal(
      BigInt(
        process.env.END_TIMESTAMP || Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
      ),
      { type: 'u64' },
    ),
    nativeToScVal(BigInt(process.env.MIN_BET || '1000000'), { type: 'i128' }),
    nativeToScVal(BigInt(process.env.MAX_BET || '1000000000'), { type: 'i128' }),
    nativeToScVal(Number(process.env.FEE_BPS || '200'), { type: 'u32' }),
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
