# Aegis


<img width="1861" height="986" alt="image" src="https://github.com/user-attachments/assets/f918c056-9718-4047-85f4-41ec05bdb010" />


## Overview

**Aegis is the most private prediction market stack you can get.** Built around permanently private positions, even after market resolution, dynamic oracle settlement, 3–5 node Shamir MPC tallying, nullifier-protected claims, and portable proof-backed reputation. Private by design. Verifiable by default.

<img width="1866" height="991" alt="image" src="https://github.com/user-attachments/assets/79beeadc-2bac-43cb-b098-6cf24bdfb1d0" />


## Links

| Item | Link |
|------|------|
| **Web App** | https://aegis.preyanshu.me |
| **GitHub** | https://github.com/preyanshu/aegis |
| **Aegis Contract** | https://stellar.expert/explorer/testnet/contract/CCQYAD5J6WBTYRWPHH5VKTZNH27CHUC6DYJYWT2RUR7Y3SVUMRIHOIZ4 |


## Why Aegis?

### Protocol

| Feature                | Typical Private Prediction Markets                                             | Aegis                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Position Privacy**   | Positions are hidden only during trading or revealed after market settlement.  | Positions remain permanently private, even after market resolution.                                              |
| **Market Design**      | Single-outcome markets with fixed resolution logic.                            | Composable multi-condition oracle settlement.                                                                    |
| **Market Aggregation** | Market aggregates are revealed during settlement to compute the final outcome. | Aggregates are privately computed through a 3-of-5 Shamir MPC network and revealed only after market resolution. |
| **Trust Model**        | Settlement often depends on a trusted coordinator or single operator.          | Threshold-secured 3-of-5 Shamir MPC finalization.                                                                |
| **Reputation**         | Reputation requires exposing historical trades or wallet activity.             | Attested claims become portable proof-backed reputation credentials without revealing trading history.           |

### Other Features

| Feature                         | Aegis                                                                                                                                                                                                |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One-Click Onboarding**        | Sign in with Google and instantly create a non-custodial wallet.                                                                                                                                     |
| **Dual-Mode Vault**             | Choose between **Local Mode** for maximum privacy, where data never leaves your browser, or **Cloud Mode**, where your vault is backed up to the Aegis backend and seamlessly synced across devices. |
| **AI-Assisted Market Creation** | Create oracle-backed markets from natural language with built-in validation and structured settlement logic.                                                                                         |


## How It Works

### 1. Create a Market

Create a market with custom oracle conditions, settlement time, collateral limits, and resolution rules.

### 2. Take a Position

Buy **YES** or **NO** market positions through blind commitments. Your position is stored privately in your vault and never revealed publicly, even after the market resolves.

### 3. Private Tally

After the market expires, a private tally window (typically 48 hours) begins. During this period, participants generate tally proofs and upload encrypted tally shares without revealing their positions.

### 4. Automatic Market Resolution

At the market expiry timestamp, the oracle conditions are evaluated and the market outcome is determined. Once the tally window ends, the Aegis keeper automatically aggregates the tally shares and finalizes the market onchain.

### 5. Claim Winnings & Build Reputation

Winning traders claim their payouts and can attest successful claims to generate portable proof-backed reputation credentials without revealing their trading history.

### 6. Share Your Reputation

Generate a public reputation profile to showcase your proof-backed credentials. Anyone can verify your achievements without learning your positions, trading history, or other private market data.

## Tech Stack

| Layer | Technology |
|--------|------------|
| **Blockchain** | Stellar Soroban |
| **Zero-Knowledge** | Noir + UltraHonk |
| **Smart Contracts** | Rust |
| **Frontend** | Next.js + React |
| **Backend** | Node.js + Express |
| **Database** | MongoDB |
| **Oracle** | Reflector + Custom Oracle Conditions |
| **Authentication** | Privy + Google sign-in |


## Zero-Knowledge Architecture

Aegis uses five Noir circuits throughout the protocol lifecycle. Rather than treating zero-knowledge as an optional verification layer, proofs gate core market actions before state transitions are accepted onchain.

| Circuit | Purpose |
|----------|---------|
| **Commit** | Proves a valid market commitment without revealing the trader's position. |
| **Tally Update** | Proves valid private tally progression for a committed position. |
| **Tally Finalize** | Finalizes the aggregated market tally before settlement. |
| **Claim** | Proves payout eligibility while preventing duplicate claims. |
| **Reputation** | Generates portable proof-backed reputation credentials from attested claims. |


## Why It Fits Stellar Real-World ZK

Aegis is designed around zero-knowledge from the ground up. Every core protocol action—private commitments, tally progression, market finalization, payout claims, and reputation credentials—is backed by Noir-generated proofs verified by Soroban smart contracts.

Instead of using zero-knowledge as an add-on feature, Aegis makes it a fundamental part of private market participation while preserving transparent settlement and verifiable payouts on Stellar.



## Repo Structure

```text
circuits/
  commit/
  tally_update/
  tally_finalize/
  claim/
  reputation/

contracts/
  blind_market/
  ultrahonk_soroban_verifier/
  ultrahonk_verifier/

frontend/
  app/
  components/
  lib/

backend/
  src/server.js

scripts/
test/
```

## Setup

### Prerequisites

- Node.js 20+
- Rust toolchain
- Soroban CLI
- Noir / `nargo`
- MongoDB

### Install Dependencies

```bash
npm install
cd frontend && npm install
cd ../backend && npm install
```

### Configure Environment

Root `.env` values drive Soroban, verifier, and script workflows.

Typical root variables:

```bash
ADMIN_SECRET_KEY=...
USER_SECRET_KEY=...
USER2_SECRET_KEY=...
USER3_SECRET_KEY=...

MARKET_CONTRACT_ID=...
COMMIT_VERIFIER_ID=...
TALLY_UPDATE_VERIFIER_ID=...
TALLY_FINALIZE_VERIFIER_ID=...
CLAIM_VERIFIER_ID=...

USDC_TOKEN_ID=...
USDC_ISSUER=...
REFLECTOR_ID=...

STELLAR_RPC=https://soroban-testnet.stellar.org
STELLAR_NETWORK="Test SDF Network ; September 2015"
NEXT_PUBLIC_PROFILE_API_URL=http://localhost:4001
PROFILE_BACKEND_URL=http://localhost:4001
```

Backend example:

```bash
PORT=4001
MONGODB_URI=mongodb://127.0.0.1:27017/verdict
CORS_ORIGIN=http://localhost:3001
```

Frontend AI draft settings:

```bash
NVIDIA_API_KEY=...
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
NVIDIA_MARKET_FILL_MODEL=minimaxai/minimax-m3
```

### Compile Circuits

```bash
npm run check:circuits
```

### Build Contracts

```bash
npm run build:contract
stellar contract optimize --wasm contracts/blind_market/target/wasm32v1-none/release/blind_market.wasm
```

### Generate Verifier Artifacts

```bash
./scripts/generate-verifier.sh
```

Expected frontend circuit artifacts and compiled proof assets:

```text
frontend/public/circuits/{commit,tally_update,tally_finalize,claim,reputation}.json
```

### Run The Stack

Start MongoDB, then run the backend:

```bash
cd backend
npm run dev
```

In another terminal, run the frontend:

```bash
cd frontend
npm run dev
```

Frontend default URL:

```text
http://localhost:3001
```

## Testing

Run the main test suites:

```bash
npm test
```

Useful individual commands:

```bash
npm run test:backend
npm run test:js
npm run smoke:mpc-e2e
npm run generate:proof-fixtures
```

## Future Improvements
- more robust multi-device witness recovery
- broader oracle source support and market templates
- deeper reputation claim types and better public share tooling
