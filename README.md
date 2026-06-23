# BlindMarket

Private prediction market backend on Stellar with Noir commitments and Soroban settlement.

BlindMarket hides individual positions and pool splits while a market is open. Users commit to a side and amount with a Poseidon2 commitment, then reveal only after resolution to register winning claims and collect proportional payouts.

## Status

This repository is a hackathon baseline scaffold.

- Noir circuits are included for commit and claim proofs.
- Soroban contract implements market lifecycle, commitment storage, resolution, two-phase claim registration, and payout collection.
- On-chain UltraHonk verification is stubbed for demo flow.
- Reflector BTC/USD oracle integration is stubbed with a mock price.

Before production, replace the proof and oracle stubs in `contracts/blind_market/src/lib.rs`.

## Layout

```text
circuits/
  commit/   Noir circuit for hidden bet commitments
  claim/    Noir circuit for claim/nullifier/payout checks
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

The script writes `verifier/commit_vk.bin` and `verifier/claim_vk.bin`. With the currently installed `bb 3.0.0-nightly.20251104`, Solidity verifier generation may warn with `Assertion failed: (val.on_curve())`; this does not block VK generation. The Soroban contract currently stubs on-chain proof verification, so production work should replace that stub with a real UltraHonk verifier path.

## Build Contract

```bash
cargo build --manifest-path contracts/blind_market/Cargo.toml --target wasm32-unknown-unknown --release
stellar contract optimize --wasm contracts/blind_market/target/wasm32-unknown-unknown/release/blind_market.wasm
```
