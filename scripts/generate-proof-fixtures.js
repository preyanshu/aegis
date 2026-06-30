import { poseidon2Permutation } from '@aztec/foundation/crypto';
import { Noir } from '@noir-lang/noir_js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createUltraHonkBackend, initBarretenberg } from './barretenberg.js';

const proofOptions = { keccak: true };
const FIELD_MASK = (1n << 248n) - 1n;
const FIELD_MODULUS = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const FIXTURE_DIR = resolve('verifier', 'fixtures');

const fixture = {
  marketId: '00000000000000000000000000000000000000000000000000000000000000a1',
  side: 'YES',
  direction: 1n,
  amount: 10_000_000n,
  minAmount: 10_000_000n,
  maxAmount: 20_000_000n,
  distributablePot: 10_000_000n,
  winningSideTotal: 10_000_000n,
  payout: 10_000_000n,
  outcome: 1n,
  previousTallyCommitment: 0n,
  salt: '0x0000000000000000000000000000000000000000000000000000000000012345',
};

const noFixture = {
  ...fixture,
  side: 'NO',
  direction: 0n,
  salt: '0x0000000000000000000000000000000000000000000000000000000000067890',
};

function padHex32(value) {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

function fieldBytes(value) {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex');
}

function publicInputsBytes(values) {
  return Buffer.concat(values.map((value) => fieldBytes(value)));
}

function modField(value) {
  const normalized = value % FIELD_MODULUS;
  return normalized >= 0n ? normalized : normalized + FIELD_MODULUS;
}

async function additiveShares(total, count, seedInputs) {
  const shares = [];
  let remaining = modField(total);
  const seedTuple = [...seedInputs].slice(0, 4);
  while (seedTuple.length < 4) {
    seedTuple.push(0n);
  }
  const [seed] = await poseidon2Permutation(seedTuple);
  let state = BigInt(seed);
  for (let index = 0; index < count - 1; index += 1) {
    const [nextShare] = await poseidon2Permutation([state, BigInt(index + 1), total, remaining]);
    const share = BigInt(nextShare);
    shares.push(share);
    remaining = modField(remaining + FIELD_MODULUS - share);
    state = share;
  }
  shares.push(remaining);
  return shares;
}

async function generate() {
  await initBarretenberg();
  mkdirSync(FIXTURE_DIR, { recursive: true });

  const marketField = BigInt(`0x${fixture.marketId}`) & FIELD_MASK;
  const [commitmentRaw] = await poseidon2Permutation([
    marketField,
    fixture.direction,
    fixture.amount,
    BigInt(fixture.salt),
  ]);
  const [nullifierRaw] = await poseidon2Permutation([
    marketField,
    BigInt(fixture.salt),
    12_345n,
    0n,
  ]);
  const commitment = BigInt(commitmentRaw);
  const nullifier = BigInt(nullifierRaw);
  const [nextTallyCommitmentRaw] = await poseidon2Permutation([
    fixture.previousTallyCommitment,
    commitment,
    fixture.amount,
    fixture.direction,
  ]);
  const nextTallyCommitment = BigInt(nextTallyCommitmentRaw);
  const yesShares = await additiveShares(fixture.amount, 5, [
    marketField,
    commitment,
    1n,
    fixture.amount,
  ]);
  const noShares = await additiveShares(0n, 5, [
    marketField,
    commitment,
    0n,
    0n,
  ]);
  const shareSalts = [
    0x1111n,
    0x2222n,
    0x3333n,
    0x4444n,
    0x5555n,
  ].map((value) => `0x${value.toString(16).padStart(64, '0')}`);
  let shareCommitmentRoot = 0n;
  for (let index = 0; index < 5; index += 1) {
    const [saltCommitment] = await poseidon2Permutation([
      marketField,
      commitment,
      BigInt(index + 1),
      BigInt(shareSalts[index]),
    ]);
    const [shareCommitment] = await poseidon2Permutation([
      saltCommitment,
      yesShares[index],
      noShares[index],
      0n,
    ]);
    const [nextShareRoot] = await poseidon2Permutation([
      shareCommitmentRoot,
      shareCommitment,
      BigInt(index + 1),
      0n,
    ]);
    shareCommitmentRoot = BigInt(nextShareRoot);
  }

  const noMarketField = BigInt(`0x${noFixture.marketId}`) & FIELD_MASK;
  const [noCommitmentRaw] = await poseidon2Permutation([
    noMarketField,
    noFixture.direction,
    noFixture.amount,
    BigInt(noFixture.salt),
  ]);
  const noCommitment = BigInt(noCommitmentRaw);
  const [noNullifierRaw] = await poseidon2Permutation([
    noMarketField,
    BigInt(noFixture.salt),
    12_345n,
    0n,
  ]);
  const noNullifier = BigInt(noNullifierRaw);
  const [noNextTallyCommitmentRaw] = await poseidon2Permutation([
    noFixture.previousTallyCommitment,
    noCommitment,
    noFixture.amount,
    noFixture.direction,
  ]);
  const noNextTallyCommitment = BigInt(noNextTallyCommitmentRaw);

  const commitCircuit = JSON.parse(readFileSync('./circuits/commit/target/commit.json', 'utf8'));
  const claimCircuit = JSON.parse(readFileSync('./circuits/claim/target/claim.json', 'utf8'));
  const tallyUpdateCircuit = JSON.parse(readFileSync('./circuits/tally_update/target/tally_update.json', 'utf8'));
  const tallyFinalizeCircuit = JSON.parse(readFileSync('./circuits/tally_finalize/target/tally_finalize.json', 'utf8'));

  const commitNoir = new Noir(commitCircuit);
  const commitBackend = createUltraHonkBackend(commitCircuit.bytecode);
  const { witness: commitWitness } = await commitNoir.execute({
    direction: fixture.direction.toString(),
    amount: fixture.amount.toString(),
    salt: fixture.salt,
    commitment: padHex32(commitment),
    market_id: marketField.toString(),
    min_amount: fixture.minAmount.toString(),
    max_amount: fixture.maxAmount.toString(),
  });
  const commitProof = await commitBackend.generateProof(commitWitness, proofOptions);
  await commitBackend.destroy?.();

  const tallyUpdateNoir = new Noir(tallyUpdateCircuit);
  const tallyUpdateBackend = createUltraHonkBackend(tallyUpdateCircuit.bytecode);
  const { witness: tallyUpdateWitness } = await tallyUpdateNoir.execute({
    direction: fixture.direction.toString(),
    amount: fixture.amount.toString(),
    salt: fixture.salt,
    commitment: padHex32(commitment),
    market_id: marketField.toString(),
    collateral_amount: fixture.amount.toString(),
    previous_tally_commitment: padHex32(fixture.previousTallyCommitment),
    next_tally_commitment: padHex32(nextTallyCommitment),
    yes_shares: yesShares.map((value) => value.toString()),
    no_shares: noShares.map((value) => value.toString()),
    share_salts: shareSalts,
    share_commitment_root: padHex32(shareCommitmentRoot),
  });
  const tallyUpdateProof = await tallyUpdateBackend.generateProof(tallyUpdateWitness, proofOptions);
  await tallyUpdateBackend.destroy?.();

  const tallyFinalizeNoir = new Noir(tallyFinalizeCircuit);
  const tallyFinalizeBackend = createUltraHonkBackend(tallyFinalizeCircuit.bytecode);
  const { witness: tallyFinalizeWitness } = await tallyFinalizeNoir.execute({
    market_id: marketField.toString(),
    final_tally_commitment: padHex32(nextTallyCommitment),
    outcome: fixture.outcome.toString(),
    winning_side_total: fixture.winningSideTotal.toString(),
    directions: [fixture.direction.toString(), ...Array(15).fill('0')],
    amounts: [fixture.amount.toString(), ...Array(15).fill('0')],
    salts: [fixture.salt, ...Array(15).fill('0x0')],
    included: ['1', ...Array(15).fill('0')],
  });
  const tallyFinalizeProof = await tallyFinalizeBackend.generateProof(tallyFinalizeWitness, proofOptions);
  await tallyFinalizeBackend.destroy?.();

  const claimNoir = new Noir(claimCircuit);
  const claimBackend = createUltraHonkBackend(claimCircuit.bytecode);
  const { witness: claimWitness } = await claimNoir.execute({
    direction: fixture.direction.toString(),
    amount: fixture.amount.toString(),
    salt: fixture.salt,
    commitment: padHex32(commitment),
    market_id: marketField.toString(),
    outcome: fixture.outcome.toString(),
    nullifier: padHex32(nullifier),
    distributable_pot: fixture.distributablePot.toString(),
    winning_side_total: fixture.winningSideTotal.toString(),
    payout: fixture.payout.toString(),
  });
  const claimProof = await claimBackend.generateProof(claimWitness, proofOptions);
  await claimBackend.destroy?.();

  writeFileSync(resolve(FIXTURE_DIR, 'commit.proof.bin'), Buffer.from(commitProof.proof));
  writeFileSync(
    resolve(FIXTURE_DIR, 'commit.pi.bin'),
    publicInputsBytes([fixture.amount, commitment, marketField, fixture.minAmount, fixture.maxAmount]),
  );
  const commitNoNoir = new Noir(commitCircuit);
  const commitNoBackend = createUltraHonkBackend(commitCircuit.bytecode);
  const { witness: commitNoWitness } = await commitNoNoir.execute({
    direction: noFixture.direction.toString(),
    amount: noFixture.amount.toString(),
    salt: noFixture.salt,
    commitment: padHex32(noCommitment),
    market_id: noMarketField.toString(),
    min_amount: noFixture.minAmount.toString(),
    max_amount: noFixture.maxAmount.toString(),
  });
  const commitNoProof = await commitNoBackend.generateProof(commitNoWitness, proofOptions);
  await commitNoBackend.destroy?.();
  writeFileSync(resolve(FIXTURE_DIR, 'commit_no.proof.bin'), Buffer.from(commitNoProof.proof));
  writeFileSync(
    resolve(FIXTURE_DIR, 'commit_no.pi.bin'),
    publicInputsBytes([noFixture.amount, noCommitment, noMarketField, noFixture.minAmount, noFixture.maxAmount]),
  );
  writeFileSync(resolve(FIXTURE_DIR, 'tally_update.proof.bin'), Buffer.from(tallyUpdateProof.proof));
  writeFileSync(
    resolve(FIXTURE_DIR, 'tally_update.pi.bin'),
    publicInputsBytes([
      commitment,
      marketField,
      fixture.amount,
      fixture.previousTallyCommitment,
      nextTallyCommitment,
      shareCommitmentRoot,
    ]),
  );
  writeFileSync(resolve(FIXTURE_DIR, 'tally_finalize.proof.bin'), Buffer.from(tallyFinalizeProof.proof));
  writeFileSync(
    resolve(FIXTURE_DIR, 'tally_finalize.pi.bin'),
    publicInputsBytes([
      marketField,
      nextTallyCommitment,
      fixture.outcome,
      fixture.winningSideTotal,
    ]),
  );
  writeFileSync(resolve(FIXTURE_DIR, 'claim.proof.bin'), Buffer.from(claimProof.proof));
  writeFileSync(
    resolve(FIXTURE_DIR, 'claim.pi.bin'),
    publicInputsBytes([
      commitment,
      marketField,
      fixture.outcome,
      nullifier,
      fixture.distributablePot,
      fixture.winningSideTotal,
      fixture.payout,
    ]),
  );
  writeFileSync(
    resolve(FIXTURE_DIR, 'market-fixture.json'),
    JSON.stringify(
      {
        ...fixture,
        direction: fixture.direction.toString(),
        amount: fixture.amount.toString(),
        minAmount: fixture.minAmount.toString(),
        maxAmount: fixture.maxAmount.toString(),
        distributablePot: fixture.distributablePot.toString(),
        winningSideTotal: fixture.winningSideTotal.toString(),
        payout: fixture.payout.toString(),
        outcome: fixture.outcome.toString(),
        marketField: marketField.toString(),
        commitment: padHex32(commitment),
        nullifier: padHex32(nullifier),
        nextTallyCommitment: padHex32(nextTallyCommitment),
        shareCommitmentRoot: padHex32(shareCommitmentRoot),
        noCommitment: padHex32(noCommitment),
        noNullifier: padHex32(noNullifier),
        noNextTallyCommitment: padHex32(noNextTallyCommitment),
      },
      (_, current) => (typeof current === 'bigint' ? current.toString() : current),
      2,
    ),
  );

  console.log(`Wrote proof fixtures to ${FIXTURE_DIR}`);
}

generate().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
