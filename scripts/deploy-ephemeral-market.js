import { execFileSync } from 'node:child_process';
import {
  Address,
  BASE_FEE,
  Contract,
  hash,
  Keypair,
  Operation,
  nativeToScVal,
  rpc as StellarRpc,
  TransactionBuilder,
  xdr,
  StrKey,
} from '@stellar/stellar-sdk';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

dotenv.config();

const rpc = new StellarRpc.Server(process.env.STELLAR_RPC);
const deployer = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const networkPassphrase = process.env.STELLAR_NETWORK;

const marketWasmPath =
  './contracts/blind_market/target/wasm32v1-none/release/blind_market.wasm';

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

async function uploadWasm(path) {
  const wasm = readFileSync(path);
  return hash(wasm);
}

async function deployContract(wasmHash) {
  const salt = randomBytes(32);
  const contractId = deriveContractId(deployer.publicKey(), salt);
  await submit(
    Operation.createCustomContract({
      address: Address.fromString(deployer.publicKey()),
      wasmHash,
      salt,
      constructorArgs: [],
      source: deployer.publicKey(),
    }),
    'deploy blind market',
  );
  return contractId;
}

async function initializeMarket(contractId) {
  const contract = new Contract(contractId);
  await submit(
    contract.call(
      'initialize',
      nativeToScVal(deployer.publicKey(), { type: 'address' }),
      nativeToScVal(Address.fromString(process.env.USDC_TOKEN_ID), { type: 'address' }),
      nativeToScVal(Address.fromString(process.env.REFLECTOR_ID), { type: 'address' }),
    ),
    'initialize market',
  );

  await submit(
    contract.call(
      'set_verifiers',
      nativeToScVal(deployer.publicKey(), { type: 'address' }),
      nativeToScVal(Address.fromString(process.env.COMMIT_VERIFIER_ID), { type: 'address' }),
      nativeToScVal(Address.fromString(process.env.CLAIM_VERIFIER_ID), { type: 'address' }),
    ),
    'set market verifiers',
  );

  execFileSync('node', ['./scripts/create-market.js', '--new'], {
    encoding: 'utf8',
    stdio: 'inherit',
    env: {
      ...process.env,
      MARKET_CONTRACT_ID: contractId,
      END_TIMESTAMP: (
        process.env.END_TIMESTAMP ||
        Math.floor(Date.now() / 1000) + Number(process.env.MARKET_DURATION_SECONDS || 180)
      ).toString(),
    },
  });
}

async function main() {
  console.log(`Deploying ephemeral market from ${deployer.publicKey()}`);
  const currentWasm = await rpc.getContractWasmByContractId(process.env.MARKET_CONTRACT_ID);
  const wasmHash = hash(Buffer.from(currentWasm));
  const contractId = await deployContract(wasmHash);
  await initializeMarket(contractId);
  console.log(contractId);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
