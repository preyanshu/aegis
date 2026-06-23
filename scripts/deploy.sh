#!/usr/bin/env bash
set -euo pipefail

source .env

WASM="contracts/blind_market/target/wasm32-unknown-unknown/release/blind_market.optimized.wasm"

echo "=== Uploading WASM to Stellar testnet ==="
WASM_HASH="$(
  stellar contract upload \
    --wasm "$WASM" \
    --source "$ADMIN_SECRET_KEY" \
    --network testnet
)"

echo "WASM hash: $WASM_HASH"

echo "=== Deploying contract ==="
CONTRACT_ID="$(
  stellar contract deploy \
    --wasm-hash "$WASM_HASH" \
    --source "$ADMIN_SECRET_KEY" \
    --network testnet
)"

echo "Contract deployed: $CONTRACT_ID"
echo "MARKET_CONTRACT_ID=$CONTRACT_ID" >> .env
