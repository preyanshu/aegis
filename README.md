# BlindMarket

Private prediction market backend on Stellar with Noir commitments, Soroban settlement, and portable offchain reputation proofs.

BlindMarket hides individual positions and pool splits while a market is open. Users commit to a side and collateral amount with a market-bound Poseidon2 commitment, markets resolve to a winner plus winner-side aggregate only, and winners claim proportional payouts with nullifier-protected proofs. Settled claimed history can also be converted into portable category/window reputation credentials such as percentile-band claims.

## Status

This repository is a hackathon baseline scaffold.

- Noir circuits are included for commit, claim, and reputation proofs.
- Soroban contract implements private market lifecycle, commitment storage, nullifier checks, winner-side aggregate finalization, and claim-based payouts.
- Frontend stores salts and commitment metadata locally for backup/recovery.
- Portable reputation claims are verified offchain from claimed settled history snapshots.

Before production, audit the finalization trust assumptions around `winning_side_total`, deploy the verifier contracts with the matching VKs, and harden the snapshot witness pipeline used for reputation proofs.

## Layout

```text
circuits/
  commit/      Noir circuit for hidden market-bound commitments
  claim/       Noir circuit for claim/nullifier/payout checks
  reputation/  Noir circuit for threshold and percentile-band credentials
contracts/
  blind_market/ Soroban contract
scripts/
  generate-verifier.sh
verifier/
test/
```

## Local Checks

```bash
npm install
npm run check:circuits
npm run build:contract
```

## Generate Verification Artifacts

```bash
chmod +x scripts/generate-verifier.sh
./scripts/generate-verifier.sh
```

The script writes verifier material for the market circuits. The frontend circuit artifacts are expected at `frontend/public/circuits/{commit,claim,reputation}.json`.

## Build Contract

```bash
cargo build --manifest-path contracts/blind_market/Cargo.toml --target wasm32-unknown-unknown --release
stellar contract optimize --wasm contracts/blind_market/target/wasm32-unknown-unknown/release/blind_market.wasm
```
