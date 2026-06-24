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

dotenv.config();

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
  return {
    oracle_contract: Address.fromString(process.env[`COND${index}_ORACLE`] || oracleContractForAsset(asset)),
    asset_symbol: asset,
    greater_or_equal: comparator !== 'lte',
    threshold: BigInt(threshold),
  };
}

function scValSymbol(value) {
  return xdr.ScVal.scvSymbol(value);
}

function scValBool(value) {
  return xdr.ScVal.scvBool(value);
}

function scValMapEntry(key, val) {
  return new xdr.ScMapEntry({
    key: scValSymbol(key),
    val,
  });
}

function scValMap(entries) {
  return xdr.ScVal.scvMap(
    entries
      .slice()
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, val]) => scValMapEntry(key, val)),
  );
}

function oracleConditionScVal(condition) {
  return scValMap([
    ['oracle_contract', condition.oracle_contract.toScVal()],
    ['asset_symbol', scValSymbol(condition.asset_symbol)],
    ['greater_or_equal', scValBool(condition.greater_or_equal)],
    ['threshold', nativeToScVal(condition.threshold, { type: 'i128' })],
  ]);
}

function oracleConditionsInputScVal(conditionCount, conditions, operators) {
  return scValMap([
    ['condition_count', nativeToScVal(conditionCount, { type: 'u32' })],
    ['condition_1', oracleConditionScVal(conditions[0])],
    ['condition_2', oracleConditionScVal(conditions[1])],
    ['condition_3', oracleConditionScVal(conditions[2])],
    ['condition_4', oracleConditionScVal(conditions[3])],
    ['condition_5', oracleConditionScVal(conditions[4])],
    ['operator_1_is_and', scValBool(operators[0])],
    ['operator_2_is_and', scValBool(operators[1])],
    ['operator_3_is_and', scValBool(operators[2])],
    ['operator_4_is_and', scValBool(operators[3])],
  ]);
}

async function submit(method, args) {
  const account = await server.getAccount(creator);
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
