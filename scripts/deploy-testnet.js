import {
  Address,
  BASE_FEE,
  Contract,
  hash,
  Keypair,
  nativeToScVal,
  Operation,
  rpc as StellarRpc,
  StrKey,
  TransactionBuilder,
  xdr,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

const rpc = new StellarRpc.Server(process.env.STELLAR_RPC);
const deployer = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const networkPassphrase = process.env.STELLAR_NETWORK;

const verifierWasmPath =
  './contracts/ultrahonk_verifier/target/wasm32v1-none/release/ultrahonk_verifier.wasm';
const marketWasmPath =
  './contracts/blind_market/target/wasm32v1-none/release/blind_market.wasm';

function scBytes(bytes) {
  return xdr.ScVal.scvBytes(Buffer.from(bytes));
}

function deriveContractId(address, salt) {
  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
    new xdr.ContractIdPreimageFromAddress({
      address: Address.fromString(address).toScAddress(),
      salt,
    }),
  );
  const contractIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId,
      contractIdPreimage: preimage,
    }),
  );
  return StrKey.encodeContract(hash(contractIdPreimage.toXDR()));
}

async function submit(operation, label) {
  const account = await rpc.getAccount(deployer.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();

  const prepared = await rpc.prepareTransaction(tx);
  prepared.sign(deployer);

  const sent = await rpc.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`${label} failed to submit: ${JSON.stringify(sent)}`);
  }

  for (;;) {
    const result = await rpc.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      console.log(`${label}: ${sent.hash}`);
      return result;
    }
    if (result.status === 'FAILED') {
      throw new Error(`${label} failed on-chain: ${JSON.stringify(result)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

async function uploadWasm(path, label) {
  const wasm = readFileSync(path);
  const result = await submit(
    Operation.uploadContractWasm({ wasm, source: deployer.publicKey() }),
    `upload ${label}`,
  );
  const wasmHash = result.returnValue.bytes();
  console.log(`${label} wasm hash: ${wasmHash.toString('hex')}`);
  return wasmHash;
}

async function deployContract(wasmHash, label, constructorArgs = []) {
  const salt = randomBytes(32);
  const contractId = deriveContractId(deployer.publicKey(), salt);
  await submit(
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash,
      salt,
      constructorArgs,
      source: deployer.publicKey(),
    }),
    `deploy ${label}`,
  );
  console.log(`${label} contract: ${contractId}`);
  return contractId;
}

async function initializeMarket(contractId, commitVerifierId, claimVerifierId) {
  const contract = new Contract(contractId);
  await submit(
    contract.call(
      'initialize',
      nativeToScVal(deployer.publicKey(), { type: 'address' }),
      nativeToScVal(process.env.MARKET_QUESTION || 'Will BTC be above $50,000 on July 1, 2026?', { type: 'string' }),
      nativeToScVal(BigInt(process.env.TARGET_PRICE || '500000000000'), { type: 'i128' }),
      nativeToScVal(
        BigInt(
          process.env.END_TIMESTAMP ||
            Math.floor(new Date('2026-07-01T00:00:00Z').getTime() / 1000),
        ),
        { type: 'u64' },
      ),
      nativeToScVal(1_000_000n, { type: 'i128' }),
      nativeToScVal(1_000_000_000n, { type: 'i128' }),
      nativeToScVal(200, { type: 'u32' }),
      nativeToScVal(Address.fromString(process.env.USDC_TOKEN_ID), { type: 'address' }),
      nativeToScVal(Address.fromString(process.env.REFLECTOR_ID), { type: 'address' }),
    ),
    'initialize market',
  );

  await submit(
    contract.call(
      'set_verifiers',
      nativeToScVal(deployer.publicKey(), { type: 'address' }),
      nativeToScVal(Address.fromString(commitVerifierId), { type: 'address' }),
      nativeToScVal(Address.fromString(claimVerifierId), { type: 'address' }),
    ),
    'set market verifiers',
  );
}

function updateEnv(values) {
  const envPath = '.env';
  const current = readFileSync(envPath, 'utf8');
  let next = current;
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${value}`;
    if (next.match(new RegExp(`^${key}=.*$`, 'm'))) {
      next = next.replace(new RegExp(`^${key}=.*$`, 'm'), line);
    } else {
      next += `\n${line}`;
    }
  }
  writeFileSync(envPath, next);
}

async function main() {
  console.log(`Deploying from ${deployer.publicKey()}`);

  const verifierHash = await uploadWasm(verifierWasmPath, 'ultrahonk verifier');
  const marketHash = await uploadWasm(marketWasmPath, 'blind market');

  const commitVerifierId = await deployContract(
    verifierHash,
    'commit verifier',
    [scBytes(readFileSync('./verifier/commit_vk.bin'))],
  );

  const claimVerifierId = await deployContract(
    verifierHash,
    'claim verifier',
    [scBytes(readFileSync('./verifier/claim_vk.bin'))],
  );

  const marketContractId = await deployContract(marketHash, 'blind market');
  await initializeMarket(marketContractId, commitVerifierId, claimVerifierId);

  updateEnv({
    COMMIT_VERIFIER_ID: commitVerifierId,
    CLAIM_VERIFIER_ID: claimVerifierId,
    MARKET_CONTRACT_ID: marketContractId,
  });

  console.log('Deployment complete.');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
