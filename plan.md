# BlindMarket — Full Backend Build Plan
### Private Prediction Market on Stellar with ZK Proofs (Noir + Soroban)

> Hand this document to any AI coding assistant. It contains every architectural decision, all contract code, all circuit code, all scripts, and a day-by-day execution plan. Build in order. Do not skip sections.

---

## Table of Contents

1. [What We Are Building](#1-what-we-are-building)
2. [Full Architecture Overview](#2-full-architecture-overview)
3. [Repository Structure](#3-repository-structure)
4. [Technology Stack & Versions](#4-technology-stack--versions)
5. [Noir ZK Circuits](#5-noir-zk-circuits)
6. [Soroban Smart Contract](#6-soroban-smart-contract)
7. [Oracle Integration (Reflector)](#7-oracle-integration-reflector)
8. [Backend Node.js Scripts](#8-backend-nodejs-scripts)
9. [Contract Deployment](#9-contract-deployment)
10. [Integration & Testing](#10-integration--testing)
11. [Day-by-Day Execution Plan](#11-day-by-day-execution-plan)
12. [Key Design Decisions Reference](#12-key-design-decisions-reference)

---

## 1. What We Are Building

**BlindMarket** is a prediction market where:

- Users bet YES or NO on a binary outcome (e.g. "Will BTC be above $200k by July 1?")
- No one — not even the smart contract — knows individual positions or the aggregate pool split until the market closes
- Positions are hidden using ZK commitments (Noir circuits running in the browser)
- Payout is calculated once at resolution from final pool totals
- Oracle resolution is trustless: Reflector price feed on Stellar reads BTC/USD directly, no human in the loop
- Users only trust their own judgment — there is no visible crowd signal to anchor to

**What makes this different from Polymarket:**
Polymarket shows live odds. BlindMarket shows nothing. Every bettor acts on pure private belief. The aggregate reveal at resolution is the product.

---

## 2. Full Architecture Overview

```
USER BROWSER
├── User enters: direction (YES/NO), amount, salt (random secret)
├── Noir WASM circuit (commit.nr) runs locally
│   └── Outputs: commitment hash + ZK proof
├── User stores: (direction, amount, salt) locally — NEVER sent anywhere
└── Submits to contract: (commitment, proof, amount in USDC)

STELLAR SOROBAN CONTRACT (blind_market.rs)
├── commit(commitment, proof, amount)
│   ├── Verifies ZK proof via UltraHonk verifier
│   ├── Pulls USDC from user wallet
│   ├── Stores commitment → nullifier map
│   ├── Increments total_committed counter (NOT split by direction)
│   └── Emits CommitmentStored event (no direction info)
│
├── resolve()  [callable by anyone after end_timestamp]
│   ├── Reads Reflector BTC/USD price on-chain
│   ├── Compares to target_price
│   ├── Locks outcome (true = YES wins, false = NO wins)
│   └── Locks final pool totals
│
└── claim(direction, amount, salt, nullifier, proof)
    ├── Verifies ZK proof via UltraHonk verifier
    ├── Checks nullifier not already spent
    ├── Marks nullifier spent
    └── Transfers payout to user

REFLECTOR ORACLE (external Stellar contract, read-only)
└── Provides BTC/USD price at resolution time

ZK PROOF SYSTEM
├── commit.nr   — proves commitment is valid, amount in range, direction is binary
├── claim.nr    — proves user knows preimage of winning commitment + correct payout
├── Barretenberg (bb) — proves and generates Solidity-compatible proofs
└── UltraHonk verifier — auto-generated Solidity/Soroban verifier from circuit
```

---

## 3. Repository Structure

```
blind-market/
├── circuits/
│   ├── commit/
│   │   ├── Nargo.toml
│   │   └── src/
│   │       └── main.nr          ← commitment circuit
│   └── claim/
│       ├── Nargo.toml
│       └── src/
│           └── main.nr          ← claim/payout circuit
│
├── contracts/
│   └── blind_market/
│       ├── Cargo.toml
│       └── src/
│           └── lib.rs           ← Soroban contract
│
├── scripts/
│   ├── generate-verifier.sh     ← compile circuits → verifier keys
│   ├── deploy.sh                ← deploy to Stellar testnet
│   ├── create-market.js         ← create a new market
│   ├── commit.js                ← generate commitment proof + submit
│   ├── resolve.js               ← trigger resolution
│   └── claim.js                 ← generate claim proof + collect winnings
│
├── verifier/
│   └── commit_vk.bin            ← generated verification key (commit circuit)
│   └── claim_vk.bin             ← generated verification key (claim circuit)
│
├── test/
│   └── integration.test.js      ← end-to-end test
│
├── .env.example
└── README.md
```

---

## 4. Technology Stack & Versions

| Component | Tool | Version |
|-----------|------|---------|
| ZK Circuit Language | Noir | 0.38.0 |
| ZK Proving Backend | Barretenberg (bb CLI) | 0.67.1 |
| Smart Contract Language | Rust (Soroban SDK) | soroban-sdk 21.x |
| Blockchain | Stellar Testnet | - |
| Oracle | Reflector (Stellar-native) | testnet: `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| ZK Verifier on Soroban | rs-soroban-ultrahonk | latest |
| Script Runtime | Node.js | 20+ |
| Stellar SDK (JS) | @stellar/stellar-sdk | 12.x |
| Hash Function in Circuit | Poseidon (bn254) | built into Noir stdlib |

---

## 5. Noir ZK Circuits

### 5.1 Install Noir Toolchain

```bash
# Install noirup
curl -L https://raw.githubusercontent.com/noir-lang/noirup/main/install | bash
source ~/.bashrc

# Install specific Noir version
noirup --version 0.38.0

# Verify
nargo --version

# Install Barretenberg proving backend
curl -L https://raw.githubusercontent.com/AztecProtocol/aztec-packages/master/barretenberg/bbup/install | bash
bbup --version 0.67.1
bb --version
```

### 5.2 Commit Circuit — `circuits/commit/src/main.nr`

This circuit runs in the user's browser when they place a bet. It proves:
1. The commitment hash is the correct Poseidon hash of (direction, amount, salt)
2. Direction is binary (0 or 1 only — NO or YES)
3. Amount is within allowed range

```rust
use dep::std::hash::poseidon;

// Constants — set these to match your market
global MIN_BET: Field = 1;       // 1 USDC (in units)
global MAX_BET: Field = 10000;   // 10,000 USDC

fn main(
    // PRIVATE inputs — these never leave the browser
    direction: Field,      // 0 = NO, 1 = YES
    amount: Field,         // bet amount in USDC units (e.g. 100 = 100 USDC)
    salt: Field,           // random 32-byte secret — user MUST save this

    // PUBLIC inputs — these go on-chain
    commitment: pub Field,       // Poseidon(direction, amount, salt)
    min_amount: pub Field,       // from contract market config
    max_amount: pub Field,       // from contract market config
) {
    // Constraint 1: commitment is Poseidon hash of private inputs
    // We use a 3-input hash: hash([direction, amount, salt])
    let computed_commitment = poseidon::bn254::hash_3([direction, amount, salt]);
    assert(computed_commitment == commitment, "commitment mismatch");

    // Constraint 2: direction is binary (0 or 1, nothing else)
    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");

    // Constraint 3: amount is within valid range
    // Noir doesn't have native >= for Field, so we cast to u64
    assert(amount as u64 >= min_amount as u64, "bet below minimum");
    assert(amount as u64 <= max_amount as u64, "bet above maximum");
}
```

**Create `circuits/commit/Nargo.toml`:**

```toml
[package]
name = "commit"
type = "bin"
authors = ["BlindMarket"]
compiler_version = ">=0.38.0"

[dependencies]
```

### 5.3 Claim Circuit — `circuits/claim/src/main.nr`

This circuit runs when the user wants to collect their winnings. It proves:
1. The user knows the secret preimage of their on-chain commitment
2. The nullifier is derived correctly from their salt (prevents double-claiming)
3. Their payout calculation is correct given outcome, amount, and pool totals

```rust
use dep::std::hash::poseidon;

fn main(
    // PRIVATE inputs — only the user knows these
    direction: Field,      // 0 or 1 — which side they bet
    amount: Field,         // how much they bet
    salt: Field,           // their secret salt

    // PUBLIC inputs — all verifiable on-chain
    commitment: pub Field,           // stored on-chain at bet time
    outcome: pub Field,              // 0 or 1, set by oracle at resolution
    nullifier: pub Field,            // prevents double-claiming
    payout: pub Field,               // what the contract will pay out
    winning_pool: pub Field,         // total amount bet on the winning side
    total_pot: pub Field,            // total pot after fee deduction
) {
    // Constraint 1: user knows the preimage of their commitment
    let computed_commitment = poseidon::bn254::hash_3([direction, amount, salt]);
    assert(computed_commitment == commitment, "commitment mismatch — wrong secret");

    // Constraint 2: nullifier is derived deterministically from salt
    // This means the nullifier is unique per bet and can't be faked
    let computed_nullifier = poseidon::bn254::hash_2([salt, 12345]); // 12345 = domain separator
    assert(computed_nullifier == nullifier, "nullifier mismatch");

    // Constraint 3: direction is binary
    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");

    // Constraint 4: payout is correct
    // If user bet on winning side: payout = (amount / winning_pool) * total_pot
    // If user bet on losing side: payout = 0
    //
    // To avoid floating point: payout * winning_pool == amount * total_pot
    if direction == outcome {
        // Winner: proportional share of total pot
        assert(
            payout * winning_pool == amount * total_pot,
            "payout calculation incorrect"
        );
    } else {
        // Loser: zero payout
        assert(payout == 0, "loser must have zero payout");
    }
}
```

**Create `circuits/claim/Nargo.toml`:**

```toml
[package]
name = "claim"
type = "bin"
authors = ["BlindMarket"]
compiler_version = ">=0.38.0"

[dependencies]
```

### 5.4 Compile Circuits and Generate Verification Keys

Create `scripts/generate-verifier.sh`:

```bash
#!/bin/bash
set -e

echo "=== Compiling commit circuit ==="
cd circuits/commit
nargo compile
bb write_vk -b ./target/commit.json -o ./target/commit_vk
bb contract -k ./target/commit_vk -o ../../verifier/commit_verifier.sol
echo "Commit circuit done. VK written to circuits/commit/target/commit_vk"

echo "=== Compiling claim circuit ==="
cd ../claim
nargo compile
bb write_vk -b ./target/claim.json -o ./target/claim_vk
bb contract -k ./target/claim_vk -o ../../verifier/claim_verifier.sol
echo "Claim circuit done. VK written to circuits/claim/target/claim_vk"

echo ""
echo "=== Done. Copy VK files to verifier/ for contract embedding ==="
cp circuits/commit/target/commit_vk verifier/commit_vk.bin
cp circuits/claim/target/claim_vk verifier/claim_vk.bin
```

```bash
chmod +x scripts/generate-verifier.sh
./scripts/generate-verifier.sh
```

---

## 6. Soroban Smart Contract

### 6.1 Setup Soroban Project

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown

# Install Soroban CLI
cargo install --locked stellar-cli --features opt

# Initialize contract
mkdir -p contracts/blind_market/src
cd contracts/blind_market
```

**Create `contracts/blind_market/Cargo.toml`:**

```toml
[package]
name = "blind-market"
version = "0.1.0"
edition = "2021"

[lib]
crate-type = ["cdylib"]

[dependencies]
soroban-sdk = { version = "21.0.0", features = ["alloc"] }

[dev-dependencies]
soroban-sdk = { version = "21.0.0", features = ["testutils"] }

[profile.release]
opt-level = "z"
overflow-checks = true
debug = 0
strip = "symbols"
debug-assertions = false
panic = "abort"
codegen-units = 1
lto = true

[profile.release-with-logs]
inherits = "release"
debug-assertions = true
```

### 6.2 Full Contract — `contracts/blind_market/src/lib.rs`

```rust
#![no_std]
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short,
    Address, BytesN, Env, Map, Symbol, Vec, token,
};

// ─── Storage Keys ────────────────────────────────────────────────────────────

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
const STATE_KEY: Symbol = symbol_short!("STATE");
const COMMITMENTS: Symbol = symbol_short!("COMMITS");
const NULLIFIERS: Symbol = symbol_short!("NULLS");

// ─── Data Structures ─────────────────────────────────────────────────────────

#[contracttype]
#[derive(Clone, Debug)]
pub struct MarketConfig {
    pub question: soroban_sdk::String,  // "Will BTC be above $200k on July 1?"
    pub target_price: i128,             // Price in cents (e.g. 20_000_000 = $200k)
    pub end_timestamp: u64,             // Unix timestamp when betting closes
    pub min_bet: i128,                  // Minimum bet in stroops (1 XLM = 10^7 stroops)
    pub max_bet: i128,                  // Maximum bet in stroops
    pub fee_bps: u32,                   // Protocol fee in basis points (200 = 2%)
    pub usdc_token: Address,            // USDC contract address on testnet
    pub reflector_contract: Address,    // Reflector oracle contract address
    pub commit_vk: BytesN<64>,          // Commit circuit verification key hash
    pub claim_vk: BytesN<64>,           // Claim circuit verification key hash
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct MarketState {
    pub total_committed: i128,          // Total USDC deposited (both sides, hidden split)
    pub total_yes: i128,                // Only revealed after resolution
    pub total_no: i128,                 // Only revealed after resolution
    pub resolved: bool,                 // True after oracle resolves
    pub outcome: bool,                  // True = YES won, False = NO won (0 until resolved)
    pub outcome_price: i128,            // BTC price at resolution time
    pub distributable_pot: i128,        // total_committed minus fees
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct CommitmentRecord {
    pub commitment: BytesN<32>,
    pub amount: i128,
    pub timestamp: u64,
}

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct BlindMarket;

#[contractimpl]
impl BlindMarket {

    // ─── Initialize ──────────────────────────────────────────────────────────

    pub fn initialize(
        env: Env,
        admin: Address,
        config: MarketConfig,
    ) {
        admin.require_auth();

        // Validate config
        assert!(config.end_timestamp > env.ledger().timestamp(), "end must be in the future");
        assert!(config.fee_bps <= 1000, "fee too high (max 10%)");
        assert!(config.min_bet > 0, "min_bet must be positive");
        assert!(config.max_bet >= config.min_bet, "max_bet must >= min_bet");

        let initial_state = MarketState {
            total_committed: 0,
            total_yes: 0,
            total_no: 0,
            resolved: false,
            outcome: false,
            outcome_price: 0,
            distributable_pot: 0,
        };

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&CONFIG_KEY, &config);
        env.storage().instance().set(&STATE_KEY, &initial_state);
        env.storage().instance().set(&COMMITMENTS, &Map::<BytesN<32>, CommitmentRecord>::new(&env));
        env.storage().instance().set(&NULLIFIERS, &Map::<BytesN<32>, bool>::new(&env));
    }

    // ─── Commit (Place a Bet) ────────────────────────────────────────────────

    /// User calls this to place a hidden bet.
    /// Arguments:
    ///   commitment  — Poseidon(direction, amount, salt), computed client-side
    ///   proof       — UltraHonk ZK proof from commit circuit
    ///   amount      — USDC amount in stroops (must match amount inside proof)
    pub fn commit(
        env: Env,
        user: Address,
        commitment: BytesN<32>,
        proof: soroban_sdk::Bytes,
        amount: i128,
    ) {
        user.require_auth();

        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();

        // 1. Market must be open
        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed"
        );
        assert!(!state.resolved, "market already resolved");

        // 2. Amount in valid range
        assert!(amount >= config.min_bet, "below minimum bet");
        assert!(amount <= config.max_bet, "above maximum bet");

        // 3. Commitment must not already exist
        let mut commitments: Map<BytesN<32>, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS).unwrap();
        assert!(!commitments.contains_key(commitment.clone()), "commitment already exists");

        // 4. Verify ZK proof
        // The public inputs to the commit circuit are:
        //   [commitment (32 bytes), min_bet (i128 as Field), max_bet (i128 as Field)]
        // NOTE: In production you call the UltraHonk verifier contract here.
        // For hackathon demo, you can stub this and verify off-chain.
        // See Section 6.3 for verifier integration.
        Self::verify_commit_proof(&env, &config, &commitment, amount, &proof);

        // 5. Pull USDC from user
        let usdc = token::Client::new(&env, &config.usdc_token);
        usdc.transfer(&user, &env.current_contract_address(), &amount);

        // 6. Store commitment record
        let record = CommitmentRecord {
            commitment: commitment.clone(),
            amount,
            timestamp: env.ledger().timestamp(),
        };
        commitments.set(commitment.clone(), record);
        env.storage().instance().set(&COMMITMENTS, &commitments);

        // 7. Update state — only total_committed, NOT broken down by direction
        state.total_committed += amount;
        env.storage().instance().set(&STATE_KEY, &state);

        // 8. Emit event (no direction info leaked)
        env.events().publish(
            (symbol_short!("committed"),),
            (user, commitment, amount),
        );
    }

    // ─── Resolve Market ──────────────────────────────────────────────────────

    /// Anyone can call this after end_timestamp.
    /// Reads BTC/USD from Reflector, compares to target_price, locks outcome.
    pub fn resolve(env: Env) {
        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();

        // 1. Market must have closed
        assert!(
            env.ledger().timestamp() >= config.end_timestamp,
            "market still open"
        );
        assert!(!state.resolved, "already resolved");

        // 2. Read price from Reflector oracle
        // Reflector interface: lastprice(asset) -> PriceData { price: i128, timestamp: u64 }
        let btc_price = Self::get_reflector_price(&env, &config.reflector_contract);

        // 3. Determine outcome
        let outcome = btc_price >= config.target_price;

        // 4. Calculate fee and distributable pot
        let fee_amount = (state.total_committed * config.fee_bps as i128) / 10_000;
        let distributable = state.total_committed - fee_amount;

        // 5. Lock state — now we reveal total_yes and total_no
        // IMPORTANT: We don't actually know these at this point because we hid them.
        // The approach: winning pool is computed at claim time from all winning claims.
        // For payout calculation we store the distributable pot.
        // Each winner proves their share = (their_amount / sum_of_winning_claims) * pot.
        // BUT sum_of_winning_claims is not known until all claims are in.
        //
        // SIMPLER APPROACH for hackathon:
        // After resolution, each winner submits their direction+amount+salt.
        // We accumulate total_yes_claimed and total_no_claimed in a first-pass.
        // Then winners collect based on their share of winning_pool.
        // We implement this with a 2-phase claim (register then collect).
        // See Section 6.4 for two-phase claim.

        state.resolved = true;
        state.outcome = outcome;
        state.outcome_price = btc_price;
        state.distributable_pot = distributable;

        env.storage().instance().set(&STATE_KEY, &state);

        // Transfer fee to admin
        if fee_amount > 0 {
            let admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
            let usdc = token::Client::new(&env, &config.usdc_token);
            usdc.transfer(&env.current_contract_address(), &admin, &fee_amount);
        }

        env.events().publish(
            (symbol_short!("resolved"),),
            (outcome, btc_price, config.target_price),
        );
    }

    // ─── Register Win (Phase 1 of 2-Phase Claim) ─────────────────────────────

    /// Winners call this immediately after resolution to register their claim.
    /// This reveals their direction+amount to the contract (but market is closed now).
    /// All winners must register within REGISTRATION_WINDOW (e.g. 7 days).
    pub fn register_win(
        env: Env,
        user: Address,
        commitment: BytesN<32>,
        direction: bool,            // now revealed — market is closed
        amount: i128,
        salt: BytesN<32>,
        nullifier: BytesN<32>,
        proof: soroban_sdk::Bytes,
    ) {
        user.require_auth();

        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();

        // 1. Market must be resolved
        assert!(state.resolved, "market not resolved yet");

        // 2. Commitment must exist in our records
        let commitments: Map<BytesN<32>, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS).unwrap();
        let record = commitments.get(commitment.clone())
            .expect("commitment not found");
        assert_eq!(record.amount, amount, "amount mismatch");

        // 3. Nullifier must not be spent
        let mut nullifiers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&NULLIFIERS).unwrap();
        assert!(!nullifiers.contains_key(nullifier.clone()), "already claimed");

        // 4. Verify ZK proof for claim phase
        Self::verify_claim_proof(
            &env, &config, &state,
            &commitment, direction, amount, &nullifier, &proof,
        );

        // 5. Mark nullifier spent
        nullifiers.set(nullifier, true);
        env.storage().instance().set(&NULLIFIERS, &nullifiers);

        // 6. Update pool totals (now safe — market is closed)
        if direction == state.outcome {
            // This person won
            if direction {
                state.total_yes += amount;
            } else {
                state.total_no += amount;
            }
        }
        env.storage().instance().set(&STATE_KEY, &state);

        // 7. Store pending payout for user (to be collected after registration window)
        let payout_key = (symbol_short!("payout"), user.clone());
        env.storage().temporary().set(&payout_key, &(direction, amount));

        env.events().publish(
            (symbol_short!("registered"),),
            (user, direction, amount),
        );
    }

    // ─── Collect Payout (Phase 2 of 2-Phase Claim) ───────────────────────────

    /// Winners call this after the registration window to collect their USDC.
    /// Payout = (their_amount / total_winning_pool) * distributable_pot
    pub fn collect(env: Env, user: Address) {
        user.require_auth();

        let state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();
        assert!(state.resolved, "not resolved");

        let payout_key = (symbol_short!("payout"), user.clone());
        let (direction, amount): (bool, i128) = env.storage().temporary()
            .get(&payout_key)
            .expect("no pending payout for this user");

        // Must be a winner
        assert_eq!(direction, state.outcome, "you bet on the losing side");

        // Calculate winning pool and payout
        let winning_pool = if state.outcome { state.total_yes } else { state.total_no };
        assert!(winning_pool > 0, "no winners registered yet");

        let payout = (amount * state.distributable_pot) / winning_pool;

        // Clear pending payout
        env.storage().temporary().remove(&payout_key);

        // Transfer USDC to winner
        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let usdc = token::Client::new(&env, &config.usdc_token);
        usdc.transfer(&env.current_contract_address(), &user, &payout);

        env.events().publish(
            (symbol_short!("collected"),),
            (user, payout),
        );
    }

    // ─── View Functions ───────────────────────────────────────────────────────

    pub fn get_state(env: Env) -> MarketState {
        env.storage().instance().get(&STATE_KEY).unwrap()
    }

    pub fn get_config(env: Env) -> MarketConfig {
        env.storage().instance().get(&CONFIG_KEY).unwrap()
    }

    pub fn is_commitment_stored(env: Env, commitment: BytesN<32>) -> bool {
        let commitments: Map<BytesN<32>, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS).unwrap();
        commitments.contains_key(commitment)
    }

    pub fn is_nullifier_spent(env: Env, nullifier: BytesN<32>) -> bool {
        let nullifiers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&NULLIFIERS).unwrap();
        nullifiers.contains_key(nullifier)
    }

    // ─── Internal Helpers ─────────────────────────────────────────────────────

    fn verify_commit_proof(
        env: &Env,
        config: &MarketConfig,
        commitment: &BytesN<32>,
        amount: i128,
        proof: &soroban_sdk::Bytes,
    ) {
        // TODO: Call UltraHonk verifier contract here.
        // The verifier contract is auto-generated by:
        //   bb write_vk + bb contract (from circuits/commit)
        // Then deployed separately on Stellar testnet.
        //
        // For hackathon demo, stub this:
        // - In tests: skip verification and test business logic
        // - In demo: verify off-chain before submitting, trust the proof on-chain
        //
        // Production integration reference:
        //   https://github.com/yugocabrio/rs-soroban-ultrahonk
        let _ = (env, config, commitment, amount, proof);
    }

    fn verify_claim_proof(
        env: &Env,
        config: &MarketConfig,
        state: &MarketState,
        commitment: &BytesN<32>,
        direction: bool,
        amount: i128,
        nullifier: &BytesN<32>,
        proof: &soroban_sdk::Bytes,
    ) {
        // Same note as verify_commit_proof above.
        let _ = (env, config, state, commitment, direction, amount, nullifier, proof);
    }

    fn get_reflector_price(env: &Env, reflector_addr: &Address) -> i128 {
        // Reflector oracle interface on Stellar testnet.
        // Contract: CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
        //
        // The Reflector contract has a lastprice(asset) function.
        // Asset for BTC is: Asset::Other(Symbol::new(env, "BTC"))
        //
        // For the hackathon, if cross-contract call setup is complex,
        // you can simplify: allow admin to submit price with signature,
        // then call resolve(price) directly.
        //
        // Full Reflector interface: https://github.com/reflector-network/reflector-contract
        //
        // Stub for now — replace with actual cross-contract call:
        let _ = (env, reflector_addr);
        // Return mock price: $105,000 in cents = 10_500_000
        10_500_000_i128
    }
}
```

### 6.3 Build the Contract

```bash
cd contracts/blind_market

# Build WASM
cargo build --target wasm32-unknown-unknown --release

# The WASM file is at:
# target/wasm32-unknown-unknown/release/blind_market.wasm

# Optimize WASM size
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/blind_market.wasm

# Optimized file:
# target/wasm32-unknown-unknown/release/blind_market.optimized.wasm
```

---

## 7. Oracle Integration (Reflector)

### 7.1 Reflector Contract Addresses

| Network | Contract ID |
|---------|-------------|
| Testnet | `CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63` |
| Mainnet | `CBKZFIX36YMFA35GXGVBKFOEENFBE7OBDDPF3KP64JBFQOIIJ56BVOF6` |

### 7.2 Reflector Cross-Contract Call (Rust)

Replace the stub in `get_reflector_price` with this:

```rust
// Add to Cargo.toml dependencies:
// reflector-oracle-interface = { git = "https://github.com/reflector-network/reflector-contract" }

// In the contract:
use soroban_sdk::{contractclient, Symbol};

// Define the Reflector interface we need
#[contractclient(name = "ReflectorClient")]
pub trait ReflectorInterface {
    fn lastprice(env: Env, asset: Asset) -> Option<PriceData>;
}

#[contracttype]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
pub struct PriceData {
    pub price: i128,       // Price * 10^decimals
    pub timestamp: u64,
}

// Replace the stub function:
fn get_reflector_price(env: &Env, reflector_addr: &Address) -> i128 {
    let client = ReflectorClient::new(env, reflector_addr);
    let btc_asset = Asset::Other(Symbol::new(env, "BTC"));

    let price_data = client.lastprice(&btc_asset)
        .expect("Reflector returned no price");

    // Reflector returns price * 10^7
    // Convert to cents: price_data.price / 10^5 gives dollars
    // We store target_price in cents, so price in cents = price_data.price / 10^5
    price_data.price / 100_000
}
```

### 7.3 Verify Reflector on Testnet (JS)

Run this before deploying to confirm Reflector is live:

```javascript
// scripts/check-reflector.js
import { Contract, SorobanRpc, TransactionBuilder, Networks, BASE_FEE } from '@stellar/stellar-sdk';

const rpc = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
const REFLECTOR_ID = 'CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63';

// Query the Reflector contract for BTC price
const response = await rpc.getContractData(REFLECTOR_ID, /* asset key */);
console.log('Reflector response:', response);
```

---

## 8. Backend Node.js Scripts

Install dependencies first:

```bash
npm init -y
npm install @stellar/stellar-sdk @noir-lang/noir_js @aztec/bb.js dotenv
```

Create `.env` (copy from `.env.example`):

```bash
ADMIN_SECRET_KEY=S...          # Admin Stellar secret key
MARKET_CONTRACT_ID=C...        # Deployed contract ID
USDC_TOKEN_ID=C...             # USDC contract on testnet
REFLECTOR_ID=CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63
STELLAR_RPC=https://soroban-testnet.stellar.org
STELLAR_NETWORK=Test SDF Network ; September 2015
```

### 8.1 Deploy Market — `scripts/deploy.sh`

```bash
#!/bin/bash
set -e

# Load env
source .env

WASM=contracts/blind_market/target/wasm32-unknown-unknown/release/blind_market.optimized.wasm

echo "=== Uploading WASM to Stellar testnet ==="
WASM_HASH=$(stellar contract upload \
  --wasm $WASM \
  --source $ADMIN_SECRET_KEY \
  --network testnet)

echo "WASM hash: $WASM_HASH"

echo "=== Deploying contract ==="
CONTRACT_ID=$(stellar contract deploy \
  --wasm-hash $WASM_HASH \
  --source $ADMIN_SECRET_KEY \
  --network testnet)

echo "Contract deployed: $CONTRACT_ID"
echo "MARKET_CONTRACT_ID=$CONTRACT_ID" >> .env
```

### 8.2 Create Market — `scripts/create-market.js`

```javascript
import { Keypair, Contract, SorobanRpc, TransactionBuilder,
         Networks, BASE_FEE, nativeToScVal, xdr } from '@stellar/stellar-sdk';
import dotenv from 'dotenv';
dotenv.config();

const adminKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC);
const contract = new Contract(process.env.MARKET_CONTRACT_ID);

// Market parameters — edit these for your specific market
const MARKET_CONFIG = {
    question: "Will BTC be above $200,000 on July 1, 2025?",
    target_price: 20_000_000,   // $200,000 in cents
    end_timestamp: Math.floor(new Date('2025-07-01').getTime() / 1000),
    min_bet: 1_000_000,         // 0.1 USDC (in stroops: 1 USDC = 10^7 stroops)
    max_bet: 1_000_000_000,     // 100 USDC
    fee_bps: 200,               // 2%
};

async function createMarket() {
    const account = await rpc.getAccount(adminKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: process.env.STELLAR_NETWORK,
    })
    .addOperation(contract.call(
        'initialize',
        nativeToScVal(adminKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(MARKET_CONFIG, { type: 'map' }),  // encode as Soroban struct
    ))
    .setTimeout(30)
    .build();

    const preparedTx = await rpc.prepareTransaction(tx);
    preparedTx.sign(adminKeypair);

    const result = await rpc.sendTransaction(preparedTx);
    console.log('Market created:', result.hash);
    return result;
}

createMarket().catch(console.error);
```

### 8.3 Place Bet (Commit) — `scripts/commit.js`

This is the most important script. It runs the Noir circuit locally to generate a proof, then submits the commitment on-chain.

```javascript
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { Keypair, Contract, SorobanRpc, TransactionBuilder,
         Networks, BASE_FEE, nativeToScVal } from '@stellar/stellar-sdk';
import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config();

// Import compiled circuit
const commitCircuit = JSON.parse(readFileSync('./circuits/commit/target/commit.json', 'utf8'));

async function placeBet(userSecretKey, direction, amountUsdc) {
    const userKeypair = Keypair.fromSecret(userSecretKey);
    const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC);
    const contract = new Contract(process.env.MARKET_CONTRACT_ID);

    // 1. Generate random salt — USER MUST SAVE THIS
    const salt = '0x' + randomBytes(32).toString('hex');
    const directionField = direction ? '1' : '0'; // YES=1, NO=0
    const amountField = amountUsdc.toString();

    console.log('=== SAVE THESE — YOU NEED THEM TO CLAIM WINNINGS ===');
    console.log('direction:', direction ? 'YES' : 'NO');
    console.log('amount:', amountUsdc, 'USDC');
    console.log('salt:', salt);
    console.log('=====================================================');

    // 2. Compute commitment = Poseidon(direction, amount, salt)
    // For now compute off-chain using noir — the circuit will verify this too
    const backend = new UltraHonkBackend(commitCircuit.bytecode);
    const noir = new Noir(commitCircuit);

    // 3. Get min/max from contract
    const minBet = 1_000_000;  // TODO: read from contract
    const maxBet = 1_000_000_000;

    // 4. Execute circuit to get witness and commitment
    const { witness, returnValue } = await noir.execute({
        direction: directionField,
        amount: amountField,
        salt: salt,
        commitment: '0',     // placeholder — we'll get real value from execution
        min_amount: minBet.toString(),
        max_amount: maxBet.toString(),
    });

    // Actually: generate commitment first using poseidon hash, then prove
    // The correct flow is:
    //   a. Hash (direction, amount, salt) with Poseidon to get commitment
    //   b. Pass commitment as public input to circuit
    //   c. Circuit verifies hash matches
    // We need a JS Poseidon implementation matching Noir's bn254 variant

    // Use @aztec/foundation for Poseidon (matches Noir's bn254 impl)
    // npm install @aztec/foundation
    const { poseidon3 } = await import('@aztec/foundation/crypto');
    const commitment = poseidon3([
        BigInt(directionField),
        BigInt(amountField),
        BigInt(salt),
    ]);
    const commitmentHex = '0x' + commitment.toString(16).padStart(64, '0');

    // 5. Generate proof
    const inputs = {
        direction: directionField,
        amount: amountField,
        salt: salt,
        commitment: commitmentHex,
        min_amount: minBet.toString(),
        max_amount: maxBet.toString(),
    };

    console.log('Generating ZK proof (this takes ~5-15 seconds)...');
    const { witness: w } = await noir.execute(inputs);
    const proof = await backend.generateProof(w);
    console.log('Proof generated. Size:', proof.proof.length, 'bytes');

    // 6. Submit to Stellar contract
    const account = await rpc.getAccount(userKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: process.env.STELLAR_NETWORK,
    })
    .addOperation(contract.call(
        'commit',
        nativeToScVal(userKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(Buffer.from(commitmentHex.slice(2), 'hex'), { type: 'bytes' }),
        nativeToScVal(Buffer.from(proof.proof), { type: 'bytes' }),
        nativeToScVal(BigInt(amountUsdc * 10_000_000), { type: 'i128' }), // convert to stroops
    ))
    .setTimeout(30)
    .build();

    const preparedTx = await rpc.prepareTransaction(tx);
    preparedTx.sign(userKeypair);

    const result = await rpc.sendTransaction(preparedTx);
    console.log('Bet placed! Transaction:', result.hash);

    // 7. Save user's private data locally for later claim
    const saveData = {
        commitment: commitmentHex,
        direction: direction ? 'YES' : 'NO',
        amount: amountUsdc,
        salt: salt,
        txHash: result.hash,
    };
    const filename = `bet-${Date.now()}.json`;
    writeFileSync(filename, JSON.stringify(saveData, null, 2));
    console.log(`Private bet data saved to ${filename} — keep this safe!`);

    return result;
}

// CLI usage: node commit.js <direction> <amount>
const [,, direction, amount] = process.argv;
const userKey = process.env.USER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
placeBet(userKey, direction === 'YES', parseInt(amount)).catch(console.error);
```

### 8.4 Resolve Market — `scripts/resolve.js`

```javascript
import { Keypair, Contract, SorobanRpc, TransactionBuilder,
         BASE_FEE, nativeToScVal } from '@stellar/stellar-sdk';
import dotenv from 'dotenv';
dotenv.config();

async function resolveMarket() {
    const callerKeypair = Keypair.fromSecret(process.env.ADMIN_SECRET_KEY);
    const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC);
    const contract = new Contract(process.env.MARKET_CONTRACT_ID);

    const account = await rpc.getAccount(callerKeypair.publicKey());

    // Anyone can call resolve() after end_timestamp
    // The contract reads Reflector price directly — no data needed from us
    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: process.env.STELLAR_NETWORK,
    })
    .addOperation(contract.call('resolve'))
    .setTimeout(30)
    .build();

    const preparedTx = await rpc.prepareTransaction(tx);
    preparedTx.sign(callerKeypair);

    const result = await rpc.sendTransaction(preparedTx);
    console.log('Market resolved! Transaction:', result.hash);

    // Read and display outcome
    const state = await contract.call('get_state');
    console.log('Outcome:', state.outcome ? 'YES' : 'NO');
    console.log('BTC price at resolution:', state.outcome_price / 100, 'USD');
    console.log('Total pot:', state.total_committed / 10_000_000, 'USDC');
}

resolveMarket().catch(console.error);
```

### 8.5 Claim Winnings — `scripts/claim.js`

```javascript
import { Noir } from '@noir-lang/noir_js';
import { UltraHonkBackend } from '@aztec/bb.js';
import { Keypair, Contract, SorobanRpc, TransactionBuilder,
         BASE_FEE, nativeToScVal } from '@stellar/stellar-sdk';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';
dotenv.config();

const claimCircuit = JSON.parse(readFileSync('./circuits/claim/target/claim.json', 'utf8'));

async function claimWinnings(betDataFile, userSecretKey) {
    // 1. Load saved bet data
    const betData = JSON.parse(readFileSync(betDataFile, 'utf8'));
    console.log('Claiming for bet:', betData);

    const userKeypair = Keypair.fromSecret(userSecretKey);
    const rpc = new SorobanRpc.Server(process.env.STELLAR_RPC);
    const contract = new Contract(process.env.MARKET_CONTRACT_ID);

    // 2. Get market state from contract
    const stateResult = await rpc.simulateTransaction(
        /* build get_state call */
    );
    const state = stateResult; // parse from result

    const outcome = state.outcome;          // true = YES won
    const distributablePot = state.distributable_pot;
    const winningPool = outcome ? state.total_yes : state.total_no;

    // 3. Compute nullifier = Poseidon(salt, 12345)
    const { poseidon2 } = await import('@aztec/foundation/crypto');
    const nullifier = poseidon2([BigInt(betData.salt), 12345n]);
    const nullifierHex = '0x' + nullifier.toString(16).padStart(64, '0');

    // 4. Compute payout
    const amountInStroops = betData.amount * 10_000_000;
    const payout = Math.floor((amountInStroops * distributablePot) / winningPool);

    console.log('Expected payout:', payout / 10_000_000, 'USDC');

    // 5. Generate claim proof
    const backend = new UltraHonkBackend(claimCircuit.bytecode);
    const noir = new Noir(claimCircuit);

    const inputs = {
        direction: betData.direction === 'YES' ? '1' : '0',
        amount: amountInStroops.toString(),
        salt: betData.salt,
        commitment: betData.commitment,
        outcome: outcome ? '1' : '0',
        nullifier: nullifierHex,
        payout: payout.toString(),
        winning_pool: winningPool.toString(),
        total_pot: distributablePot.toString(),
    };

    console.log('Generating claim proof...');
    const { witness } = await noir.execute(inputs);
    const proof = await backend.generateProof(witness);
    console.log('Claim proof generated!');

    // 6. Submit register_win to contract
    const account = await rpc.getAccount(userKeypair.publicKey());

    const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: process.env.STELLAR_NETWORK,
    })
    .addOperation(contract.call(
        'register_win',
        nativeToScVal(userKeypair.publicKey(), { type: 'address' }),
        nativeToScVal(Buffer.from(betData.commitment.slice(2), 'hex'), { type: 'bytes' }),
        nativeToScVal(betData.direction === 'YES', { type: 'bool' }),
        nativeToScVal(BigInt(amountInStroops), { type: 'i128' }),
        nativeToScVal(Buffer.from(betData.salt.slice(2), 'hex'), { type: 'bytes' }),
        nativeToScVal(Buffer.from(nullifierHex.slice(2), 'hex'), { type: 'bytes' }),
        nativeToScVal(Buffer.from(proof.proof), { type: 'bytes' }),
    ))
    .setTimeout(30)
    .build();

    const preparedTx = await rpc.prepareTransaction(tx);
    preparedTx.sign(userKeypair);

    const registerResult = await rpc.sendTransaction(preparedTx);
    console.log('Win registered! Tx:', registerResult.hash);
    console.log('Now call collect() after registration window closes');
}

const [,, betFile] = process.argv;
const userKey = process.env.USER_SECRET_KEY || process.env.ADMIN_SECRET_KEY;
claimWinnings(betFile, userKey).catch(console.error);
```

---

## 9. Contract Deployment

### Full Deploy Sequence

```bash
# 1. Get testnet funds
stellar keys generate admin --network testnet
stellar keys address admin
# Go to: https://friendbot.stellar.org?addr=<your-address>

# 2. Build contract
cd contracts/blind_market
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize \
  --wasm target/wasm32-unknown-unknown/release/blind_market.wasm

# 3. Upload WASM
stellar contract upload \
  --wasm target/wasm32-unknown-unknown/release/blind_market.optimized.wasm \
  --source admin \
  --network testnet

# 4. Deploy
stellar contract deploy \
  --wasm-hash <WASM_HASH_FROM_STEP_3> \
  --source admin \
  --network testnet

# 5. Initialize market (via create-market.js or CLI)
stellar contract invoke \
  --id <CONTRACT_ID> \
  --source admin \
  --network testnet \
  -- initialize \
  --admin <ADMIN_ADDRESS> \
  --config '{"question":"Will BTC be above $200k?","target_price":20000000,...}'
```

### USDC on Stellar Testnet

Stellar testnet uses the standard USDC contract. Get the testnet USDC contract ID:

```bash
# USDC on Stellar testnet (Circle-issued)
USDC_TESTNET=CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA

# Mint testnet USDC to your address using the testnet admin
stellar contract invoke \
  --id $USDC_TESTNET \
  --source <USDC_ADMIN_KEY> \
  --network testnet \
  -- mint --to <YOUR_ADDRESS> --amount 10000000000
```

---

## 10. Integration & Testing

### 10.1 End-to-End Test — `test/integration.test.js`

```javascript
import { describe, it, before } from 'node:test';
import assert from 'node:assert';

// Full end-to-end test scenario
describe('BlindMarket Integration', () => {

    let contractId;
    const alice = { direction: true,  amount: 100 }; // YES, 100 USDC
    const bob   = { direction: false, amount: 300 }; // NO,  300 USDC
    const carol = { direction: true,  amount: 200 }; // YES, 200 USDC

    it('should deploy and initialize market', async () => {
        // Deploy contract, initialize with end_timestamp 60 seconds in future
        contractId = await deployTestMarket({ durationSeconds: 60 });
        assert.ok(contractId.startsWith('C'));
    });

    it('should accept valid commitments', async () => {
        // All three users commit
        await commit(alice.direction, alice.amount);
        await commit(bob.direction, bob.amount);
        await commit(carol.direction, carol.amount);

        // Total committed = 600 USDC
        const state = await getState(contractId);
        assert.equal(state.total_committed, 600 * 10_000_000);

        // NO split visible during betting
        assert.equal(state.total_yes, 0);
        assert.equal(state.total_no, 0);
    });

    it('should reject duplicate commitments', async () => {
        await assert.rejects(
            () => commit(alice.direction, alice.amount, alice.salt),
            /commitment already exists/
        );
    });

    it('should reject bets after market closes', async () => {
        await sleep(65_000); // wait for market to close
        await assert.rejects(
            () => commit(true, 50),
            /market has closed/
        );
    });

    it('should resolve from oracle after close', async () => {
        await resolve(contractId);
        const state = await getState(contractId);
        assert.equal(state.resolved, true);
        // outcome depends on mock oracle price
    });

    it('should allow winners to register and collect', async () => {
        const state = await getState(contractId);
        const outcome = state.outcome; // true or false

        // Only register winners
        if (alice.direction === outcome) {
            await registerWin(alice);
        }
        if (carol.direction === outcome) {
            await registerWin(carol);
        }

        // Winners collect after registration
        const alicePayout = outcome ? await collect(alice) : 0;
        console.log('Alice payout:', alicePayout / 10_000_000, 'USDC');

        // Verify math: YES wins → alice 100, carol 200 → total 300 YES
        // distributable = 600 * 0.98 = 588
        // alice gets 100/300 * 588 = 196 USDC
        // carol gets 200/300 * 588 = 392 USDC
        if (outcome) {
            assert.equal(alicePayout, 196 * 10_000_000);
        }
    });

    it('should prevent double-claiming', async () => {
        await assert.rejects(
            () => registerWin(alice), // alice already claimed
            /already claimed/
        );
    });
});
```

### 10.2 Quick Smoke Test

```bash
# Generate circuits
./scripts/generate-verifier.sh

# Build contract
cd contracts/blind_market && cargo test

# Deploy to testnet
./scripts/deploy.sh

# Place bets
node scripts/commit.js YES 100    # Save output to bet-alice.json
node scripts/commit.js NO 300     # Save output to bet-bob.json
node scripts/commit.js YES 200    # Save output to bet-carol.json

# Check no odds visible
node -e "
const { Contract, SorobanRpc } = require('@stellar/stellar-sdk');
const rpc = new SorobanRpc.Server('https://soroban-testnet.stellar.org');
// call get_state — total_yes and total_no should both be 0
"

# Wait for market to close, then resolve
node scripts/resolve.js

# Claim winnings (if you won)
node scripts/claim.js bet-alice.json
```

---

## 11. Day-by-Day Execution Plan

### Day 1 (June 23) — Toolchain & Circuits

**Goal: Get circuits compiling and generating proofs.**

```bash
# Install tools
noirup --version 0.38.0
bbup --version 0.67.1
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup target add wasm32-unknown-unknown
cargo install --locked stellar-cli --features opt

# Create circuit files
mkdir -p circuits/commit/src circuits/claim/src
# Write main.nr files from Section 5.2 and 5.3

# Compile
cd circuits/commit && nargo compile && nargo test
cd ../claim && nargo compile && nargo test

# Generate verification keys
./scripts/generate-verifier.sh
```

**Day 1 success check:** `nargo test` passes for both circuits.

---

### Day 2 (June 24) — Soroban Contract

**Goal: Contract compiles, all functions work in Rust unit tests.**

```bash
mkdir -p contracts/blind_market/src
# Write Cargo.toml and lib.rs from Section 6

cd contracts/blind_market

# Write Rust unit tests for:
#  - initialize()
#  - commit() stores commitment, increments total_committed
#  - resolve() locks outcome, calculates distributable_pot
#  - register_win() verifies nullifier, updates pool totals
#  - collect() transfers correct USDC amount

cargo test

# Build WASM
cargo build --target wasm32-unknown-unknown --release
stellar contract optimize --wasm target/wasm32-unknown-unknown/release/blind_market.wasm
```

**Day 2 success check:** `cargo test` passes, WASM file exists.

---

### Day 3 (June 25) — Deploy & Oracle

**Goal: Contract live on testnet, oracle reading from Reflector.**

```bash
# Fund testnet account
stellar keys generate admin --network testnet
# Get XLM from friendbot

# Deploy
stellar contract upload --wasm ... --source admin --network testnet
stellar contract deploy --wasm-hash ... --source admin --network testnet

# Test Reflector cross-contract call
# Try calling resolve() — verify it reads BTC price correctly
stellar contract invoke --id $CONTRACT_ID --source admin --network testnet \
  -- resolve

# Check state shows resolved with a real BTC price
stellar contract invoke --id $CONTRACT_ID --source admin --network testnet \
  -- get_state
```

**Day 3 success check:** `resolve()` on testnet returns real BTC price from Reflector.

---

### Day 4 (June 26) — Commit Script & Proof Generation

**Goal: Full commit flow works end-to-end from browser/script.**

```bash
npm install
# Write commit.js from Section 8.3

# Test with real Noir proof generation
node scripts/commit.js YES 100

# Verify commitment appears on-chain
stellar contract invoke --id $CONTRACT_ID --source admin --network testnet \
  -- is_commitment_stored --commitment <COMMITMENT_HEX>
# Should return true
```

**Day 4 success check:** Commitment stored on testnet with valid ZK proof.

---

### Day 5 (June 27) — Claim Script & Full Flow

**Goal: Complete bet → resolve → claim cycle works.**

```bash
# Write claim.js from Section 8.5

# Run full test:
node scripts/commit.js YES 100   # Alice
node scripts/commit.js NO 300    # Bob
node scripts/commit.js YES 200   # Carol

# Wait / fast-forward (use short end_timestamp in test market)
node scripts/resolve.js

# Register wins
node scripts/claim.js bet-alice.json
node scripts/claim.js bet-carol.json

# Collect
node -e "require('./scripts/collect.js').collect(process.env.ADMIN_SECRET_KEY)"

# Verify payout math is correct
```

**Day 5 success check:** Alice receives ~196 USDC, Carol receives ~392 USDC.

---

### Day 6 (June 28-29) — Polish & Demo Video

**Goal: Clean demo, README, submission.**

- Record demo video showing:
  1. Market UI (or terminal) with NO visible odds
  2. Three users betting (proofs generating in <15 sec each)
  3. Market closes — resolve called — BTC price read from Reflector
  4. Winners claim — ZK proofs verify — payouts distributed
- Write README with architecture diagram
- Note in README: "ZK verifier on-chain is stubbed for demo; production integration via rs-soroban-ultrahonk"
- Submit to hackathon

---

## 12. Key Design Decisions Reference

| Decision | Choice | Reason |
|----------|--------|--------|
| ZK proving system | UltraHonk (Noir/Barretenberg) | Native to Noir, browser-compatible, good docs |
| Hash function | Poseidon bn254 | ZK-friendly, matches Noir stdlib |
| Oracle | Reflector (on-chain Stellar) | No backend needed, fully trustless, already on testnet |
| AMM vs blind pool | Blind pool | No visible odds = the core product innovation |
| Payout mechanism | 2-phase (register then collect) | Needed because winning pool unknown until claims come in |
| Nullifier derivation | Poseidon(salt, 12345) | Domain-separated, deterministic, ZK-provable |
| Fee | 2% of total pot | Taken at resolution, transferred to admin |
| Registration window | 7 days after resolution | Gives all winners time to submit claims |
| USDC unit | Stroops (1 USDC = 10^7 stroops) | Standard Stellar convention |
| Proof verification on-chain | Stubbed for demo | rs-soroban-ultrahonk not fully integrated yet; document upgrade path |

---

## Common Issues & Fixes

**"Circuit compilation fails"**
→ Check Noir version matches Nargo.toml (`compiler_version = ">=0.38.0"`)

**"Proof generation fails in Node.js"**
→ Use `@aztec/bb.js` version matching your `bb` CLI version exactly

**"Poseidon hash mismatch between JS and circuit"**
→ Use `@aztec/foundation`'s `poseidon3` — it matches Noir's `poseidon::bn254::hash_3`

**"Contract upload fails — WASM too large"**
→ Run `stellar contract optimize` before upload; Soroban has a WASM size limit

**"Reflector returns None for BTC"**
→ Use testnet Reflector ID, not mainnet; confirm asset symbol is exactly `"BTC"`

**"USDC transfer fails"**
→ User must call USDC `approve(contract_address, amount)` before calling `commit()`

---

*Document version: June 2025. Built for Stellar ZK Hackathon submission deadline June 29.*