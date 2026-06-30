#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$ROOT_DIR/verifier"

write_vk_bin() {
  local input_path="$1"
  local output_path="$2"
  local size
  size="$(wc -c < "$input_path" | tr -d '[:space:]')"

  if [[ "$size" == "1760" ]]; then
    cp "$input_path" "$output_path"
  elif [[ "$size" == "1764" ]]; then
    head -c -4 "$input_path" > "$output_path"
  else
    echo "Unexpected VK byte length for $input_path: $size" >&2
    exit 1
  fi
}

write_solidity_verifier() {
  local vk_path="$1"
  local output_path="$2"

  if bb write_solidity_verifier --help >/dev/null 2>&1; then
    if ! bb write_solidity_verifier -k "$vk_path/vk" -o "$output_path"; then
      echo "Warning: Solidity verifier generation failed for $vk_path; VK was still generated."
    fi
  else
    if ! bb contract -k "$vk_path" -o "$output_path"; then
      echo "Warning: Solidity verifier generation failed for $vk_path; VK was still generated."
    fi
  fi
}

echo "=== Compiling commit circuit ==="
cd "$ROOT_DIR/circuits/commit"
nargo compile
bb write_vk \
  --scheme ultra_honk \
  --oracle_hash keccak \
  --bytecode_path ./target/commit.json \
  --output_path ./target/commit_vk \
  --output_format bytes_and_fields
write_solidity_verifier ./target/commit_vk "$ROOT_DIR/verifier/commit_verifier.sol"
write_vk_bin ./target/commit_vk/vk "$ROOT_DIR/verifier/commit_vk.bin"
echo "Commit circuit done."

echo "=== Compiling claim circuit ==="
cd "$ROOT_DIR/circuits/claim"
nargo compile
bb write_vk \
  --scheme ultra_honk \
  --oracle_hash keccak \
  --bytecode_path ./target/claim.json \
  --output_path ./target/claim_vk \
  --output_format bytes_and_fields
write_solidity_verifier ./target/claim_vk "$ROOT_DIR/verifier/claim_verifier.sol"
write_vk_bin ./target/claim_vk/vk "$ROOT_DIR/verifier/claim_vk.bin"
echo "Claim circuit done."

echo "=== Compiling tally update circuit ==="
cd "$ROOT_DIR/circuits/tally_update"
nargo compile
bb write_vk \
  --scheme ultra_honk \
  --oracle_hash keccak \
  --bytecode_path ./target/tally_update.json \
  --output_path ./target/tally_update_vk \
  --output_format bytes_and_fields
write_solidity_verifier ./target/tally_update_vk "$ROOT_DIR/verifier/tally_update_verifier.sol"
write_vk_bin ./target/tally_update_vk/vk "$ROOT_DIR/verifier/tally_update_vk.bin"
echo "Tally update circuit done."

echo "=== Compiling tally finalize circuit ==="
cd "$ROOT_DIR/circuits/tally_finalize"
nargo compile
bb write_vk \
  --scheme ultra_honk \
  --oracle_hash keccak \
  --bytecode_path ./target/tally_finalize.json \
  --output_path ./target/tally_finalize_vk \
  --output_format bytes_and_fields
write_solidity_verifier ./target/tally_finalize_vk "$ROOT_DIR/verifier/tally_finalize_verifier.sol"
write_vk_bin ./target/tally_finalize_vk/vk "$ROOT_DIR/verifier/tally_finalize_vk.bin"
echo "Tally finalize circuit done."

echo "=== Verifier artifacts written to verifier/ ==="
