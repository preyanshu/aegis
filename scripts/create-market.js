import {
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  nativeToScVal,
  rpc as StellarRpc,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import dotenv from 'dotenv';

dotenv.config();

const adminKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const rpc = new StellarRpc.Server(process.env.STELLAR_RPC);
const contract = new Contract(process.env.MARKET_CONTRACT_ID);

const marketConfig = {
  question: process.env.MARKET_QUESTION || 'Will BTC be above $50,000 on July 1, 2026?',
  target_price: BigInt(process.env.TARGET_PRICE || '500000000000'),
  end_timestamp: BigInt(
    process.env.END_TIMESTAMP ||
      Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
  ),
  min_bet: 1_000_000n,
  max_bet: 1_000_000_000n,
  fee_bps: 200,
  usdc_token: Address.fromString(process.env.USDC_TOKEN_ID),
  reflector_contract: Address.fromString(process.env.REFLECTOR_ID),
  commit_verifier: Address.fromString(process.env.COMMIT_VERIFIER_ID),
  claim_verifier: Address.fromString(process.env.CLAIM_VERIFIER_ID),
};

async function createMarket() {
  const account = await rpc.getAccount(adminKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: process.env.STELLAR_NETWORK,
  })
    .addOperation(
      contract.call(
        'initialize',
        nativeToScVal(adminKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(marketConfig.question, { type: 'string' }),
        nativeToScVal(marketConfig.target_price, { type: 'i128' }),
        nativeToScVal(marketConfig.end_timestamp, { type: 'u64' }),
        nativeToScVal(marketConfig.min_bet, { type: 'i128' }),
        nativeToScVal(marketConfig.max_bet, { type: 'i128' }),
        nativeToScVal(marketConfig.fee_bps, { type: 'u32' }),
        nativeToScVal(marketConfig.usdc_token, { type: 'address' }),
        nativeToScVal(marketConfig.reflector_contract, { type: 'address' }),
      ),
    )
    .setTimeout(30)
    .build();

  const preparedTx = await rpc.prepareTransaction(tx);
  preparedTx.sign(adminKeypair);

  const result = await rpc.sendTransaction(preparedTx);
  console.log('Market created:', result.hash);

  const verifierAccount = await rpc.getAccount(adminKeypair.publicKey());
  const setTx = new TransactionBuilder(verifierAccount, {
    fee: BASE_FEE,
    networkPassphrase: process.env.STELLAR_NETWORK,
  })
    .addOperation(
      contract.call(
        'set_verifiers',
        nativeToScVal(adminKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(marketConfig.commit_verifier, { type: 'address' }),
        nativeToScVal(marketConfig.claim_verifier, { type: 'address' }),
      ),
    )
    .setTimeout(30)
    .build();

  const preparedSetTx = await rpc.prepareTransaction(setTx);
  preparedSetTx.sign(adminKeypair);

  const setResult = await rpc.sendTransaction(preparedSetTx);
  console.log('Market verifiers set:', setResult.hash);
}

createMarket().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
