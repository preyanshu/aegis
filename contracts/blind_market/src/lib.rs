#![no_std]

mod reflector_pulse;

use reflector_pulse::{Asset as ReflectorAsset, ReflectorPulseClient};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env,
    IntoVal, InvokeError, Map, String, Symbol, Val, Vec as SorobanVec,
};

const ADMIN_KEY: Symbol = symbol_short!("ADMIN");
const CONFIG_KEY: Symbol = symbol_short!("CONFIG");
const STATE_KEY: Symbol = symbol_short!("STATE");
const COMMITMENTS: Symbol = symbol_short!("COMMITS");
const NULLIFIERS: Symbol = symbol_short!("NULLS");
const CLAIMS: Symbol = symbol_short!("CLAIMS");
const QUOTE_FLOOR_BPS: u32 = 2_500;
const QUOTE_CAP_BPS: u32 = 7_500;
const VIRTUAL_RESERVE: i128 = 5_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub question: String,
    pub target_price: i128,
    pub end_timestamp: u64,
    pub min_bet: i128,
    pub max_bet: i128,
    pub fee_bps: u32,
    pub usdc_token: Address,
    pub reflector_contract: Address,
    pub commit_verifier: Address,
    pub claim_verifier: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketState {
    pub total_committed: i128,
    pub public_yes_quote_bps: i128,
    pub public_no_quote_bps: i128,
    pub resolved: bool,
    pub claims_finalized: bool,
    pub outcome: bool,
    pub outcome_price: i128,
    pub distributable_pot: i128,
    pub winning_pool: i128,
    pub registered_claim_amount: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitmentRecord {
    pub commitment: BytesN<32>,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRecord {
    pub claimant: Address,
    pub commitment: BytesN<32>,
    pub amount: i128,
}

#[contract]
pub struct BlindMarket;

#[contractimpl]
impl BlindMarket {
    pub fn initialize(
        env: Env,
        admin: Address,
        question: String,
        target_price: i128,
        end_timestamp: u64,
        min_bet: i128,
        max_bet: i128,
        fee_bps: u32,
        usdc_token: Address,
        reflector_contract: Address,
    ) {
        admin.require_auth();

        assert!(
            !env.storage().instance().has(&CONFIG_KEY),
            "already initialized",
        );
        assert!(
            end_timestamp > env.ledger().timestamp(),
            "end must be in the future",
        );
        assert!(fee_bps <= 1000, "fee too high");
        assert!(min_bet > 0, "min_bet must be positive");
        assert!(max_bet >= min_bet, "max_bet below min_bet");

        let config = MarketConfig {
            question,
            target_price,
            end_timestamp,
            min_bet,
            max_bet,
            fee_bps,
            usdc_token,
            reflector_contract,
            commit_verifier: admin.clone(),
            claim_verifier: admin.clone(),
        };

        let initial_state = MarketState {
            total_committed: 0,
            public_yes_quote_bps: 5_000,
            public_no_quote_bps: 5_000,
            resolved: false,
            claims_finalized: false,
            outcome: false,
            outcome_price: 0,
            distributable_pot: 0,
            winning_pool: 0,
            registered_claim_amount: 0,
        };

        env.storage().instance().set(&ADMIN_KEY, &admin);
        env.storage().instance().set(&CONFIG_KEY, &config);
        env.storage().instance().set(&STATE_KEY, &initial_state);
        env.storage()
            .instance()
            .set(&COMMITMENTS, &Map::<BytesN<32>, CommitmentRecord>::new(&env));
        env.storage()
            .instance()
            .set(&NULLIFIERS, &Map::<BytesN<32>, bool>::new(&env));
        env.storage()
            .instance()
            .set(&CLAIMS, &Map::<BytesN<32>, ClaimRecord>::new(&env));
    }

    pub fn set_verifiers(env: Env, admin: Address, commit_verifier: Address, claim_verifier: Address) {
        admin.require_auth();
        let mut config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let stored_admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
        assert_eq!(admin, stored_admin, "only admin can set verifiers");
        config.commit_verifier = commit_verifier;
        config.claim_verifier = claim_verifier;
        env.storage().instance().set(&CONFIG_KEY, &config);
    }

    pub fn commit(
        env: Env,
        user: Address,
        commitment: BytesN<32>,
        proof: Bytes,
        amount: i128,
    ) {
        user.require_auth();

        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();

        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed",
        );
        assert!(!state.resolved, "market already resolved");
        assert!(amount >= config.min_bet, "below minimum bet");
        assert!(amount <= config.max_bet, "above maximum bet");

        let mut commitments: Map<BytesN<32>, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS).unwrap();
        assert!(
            !commitments.contains_key(commitment.clone()),
            "commitment already exists",
        );

        Self::verify_commit_proof(&env, &config, &commitment, amount, &proof);

        let usdc = token::Client::new(&env, &config.usdc_token);
        usdc.transfer(&user, &env.current_contract_address(), &amount);

        let record = CommitmentRecord {
            commitment: commitment.clone(),
            amount,
            timestamp: env.ledger().timestamp(),
        };
        commitments.set(commitment.clone(), record);
        env.storage().instance().set(&COMMITMENTS, &commitments);

        state.total_committed += amount;
        let (yes_quote_bps, no_quote_bps) = Self::public_quote_bps(state.total_committed);
        state.public_yes_quote_bps = yes_quote_bps as i128;
        state.public_no_quote_bps = no_quote_bps as i128;
        env.storage().instance().set(&STATE_KEY, &state);

        env.events()
            .publish((symbol_short!("committed"),), (user, commitment, amount));
    }

    pub fn resolve(env: Env) {
        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();

        assert!(
            env.ledger().timestamp() >= config.end_timestamp,
            "market still open",
        );
        assert!(!state.resolved, "already resolved");

        let btc_price = Self::get_reflector_price(&env, &config.reflector_contract);
        let outcome = btc_price >= config.target_price;
        let fee_amount = (state.total_committed * config.fee_bps as i128) / 10_000;

        state.resolved = true;
        state.outcome = outcome;
        state.outcome_price = btc_price;
        state.distributable_pot = state.total_committed - fee_amount;
        env.storage().instance().set(&STATE_KEY, &state);

        if fee_amount > 0 {
            let admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
            let usdc = token::Client::new(&env, &config.usdc_token);
            usdc.transfer(&env.current_contract_address(), &admin, &fee_amount);
        }

        env.events()
            .publish((symbol_short!("resolved"),), (outcome, btc_price, config.target_price));
    }

    pub fn register_win(
        env: Env,
        user: Address,
        commitment: BytesN<32>,
        amount: i128,
        nullifier: BytesN<32>,
        proof: Bytes,
    ) {
        user.require_auth();

        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();
        assert!(state.resolved, "market not resolved yet");
        assert!(!state.claims_finalized, "claims already finalized");

        let commitments: Map<BytesN<32>, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS).unwrap();
        let record = commitments
            .get(commitment.clone())
            .expect("commitment not found");
        assert_eq!(record.amount, amount, "amount mismatch");

        let mut nullifiers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&NULLIFIERS).unwrap();
        assert!(
            !nullifiers.contains_key(nullifier.clone()),
            "already claimed",
        );

        Self::verify_claim_proof(
            &env,
            &config,
            &commitment,
            amount,
            state.outcome,
            &nullifier,
            &proof,
        );

        nullifiers.set(nullifier.clone(), true);
        env.storage().instance().set(&NULLIFIERS, &nullifiers);

        let mut claims: Map<BytesN<32>, ClaimRecord> = env.storage().instance().get(&CLAIMS).unwrap();
        assert!(!claims.contains_key(nullifier.clone()), "claim already stored");
        claims.set(
            nullifier.clone(),
            ClaimRecord {
                claimant: user.clone(),
                commitment: commitment.clone(),
                amount,
            },
        );
        env.storage().instance().set(&CLAIMS, &claims);

        state.registered_claim_amount += amount;
        env.storage().instance().set(&STATE_KEY, &state);

        env.events()
            .publish(
                (symbol_short!("reg_win"),),
                (user, commitment, amount, nullifier),
            );
    }

    pub fn finalize_claims(env: Env) {
        let admin: Address = env.storage().instance().get(&ADMIN_KEY).unwrap();
        admin.require_auth();

        let mut state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();
        assert!(state.resolved, "market not resolved yet");
        assert!(!state.claims_finalized, "claims already finalized");

        let winning_pool = state.registered_claim_amount;
        assert!(winning_pool > 0, "no winners registered");

        state.claims_finalized = true;
        state.winning_pool = winning_pool;
        env.storage().instance().set(&STATE_KEY, &state);

        env.events()
            .publish((symbol_short!("finalized"),), (winning_pool, state.distributable_pot));
    }

    pub fn collect(env: Env, user: Address, nullifier: BytesN<32>) {
        user.require_auth();

        let state: MarketState = env.storage().instance().get(&STATE_KEY).unwrap();
        assert!(state.resolved, "not resolved");
        assert!(state.claims_finalized, "claims not finalized");

        let claims: Map<BytesN<32>, ClaimRecord> = env.storage().instance().get(&CLAIMS).unwrap();
        let claim = claims
            .get(nullifier.clone())
            .expect("no pending payout");
        assert_eq!(claim.claimant, user, "claimant mismatch");
        assert!(state.winning_pool > 0, "winning pool not set");

        let payout = (claim.amount * state.distributable_pot) / state.winning_pool;
        let mut claims = claims;
        claims.remove(nullifier.clone());
        env.storage().instance().set(&CLAIMS, &claims);

        let config: MarketConfig = env.storage().instance().get(&CONFIG_KEY).unwrap();
        let usdc = token::Client::new(&env, &config.usdc_token);
        usdc.transfer(&env.current_contract_address(), &user, &payout);

        env.events()
            .publish((symbol_short!("collected"),), (user, payout, nullifier));
    }

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

    fn verify_commit_proof(
        env: &Env,
        config: &MarketConfig,
        commitment: &BytesN<32>,
        amount: i128,
        proof: &Bytes,
    ) {
        let public_inputs =
            Self::pack_commit_public_inputs(env, amount, commitment, config.min_bet, config.max_bet);
        Self::verify_with_contract(env, &config.commit_verifier, public_inputs, proof.clone());
    }

    fn verify_claim_proof(
        env: &Env,
        config: &MarketConfig,
        commitment: &BytesN<32>,
        amount: i128,
        outcome: bool,
        nullifier: &BytesN<32>,
        proof: &Bytes,
    ) {
        let public_inputs = Self::pack_claim_public_inputs(env, amount, commitment, outcome, nullifier);
        Self::verify_with_contract(env, &config.claim_verifier, public_inputs, proof.clone());
    }

    fn get_reflector_price(env: &Env, reflector_addr: &Address) -> i128 {
        let reflector = ReflectorPulseClient::new(env, reflector_addr);
        let asset = ReflectorAsset::Other(Symbol::new(env, "BTC"));
        let recent = reflector
            .lastprice(&asset)
            .expect("oracle price unavailable");
        assert!(
            recent.timestamp <= env.ledger().timestamp(),
            "oracle timestamp is in the future",
        );
        assert!(
            env.ledger().timestamp().saturating_sub(recent.timestamp) <= 86_400,
            "oracle price is stale",
        );
        recent.price
    }

    fn verify_with_contract(env: &Env, verifier: &Address, public_inputs: Bytes, proof: Bytes) {
        let mut args: SorobanVec<Val> = SorobanVec::new(env);
        args.push_back(public_inputs.into_val(env));
        args.push_back(proof.into_val(env));
        match env.try_invoke_contract::<(), InvokeError>(
            verifier,
            &Symbol::new(env, "verify_proof"),
            args,
        ) {
            Ok(Ok(())) => {}
            Ok(Err(_)) | Err(_) => panic!("verification failed"),
        }
    }

    fn pack_commit_public_inputs(
        env: &Env,
        amount: i128,
        commitment: &BytesN<32>,
        min_bet: i128,
        max_bet: i128,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Self::pack_i128(env, amount));
        out.append(&Bytes::from_slice(env, &commitment.to_array()));
        out.append(&Self::pack_i128(env, min_bet));
        out.append(&Self::pack_i128(env, max_bet));
        out
    }

    fn pack_claim_public_inputs(
        env: &Env,
        amount: i128,
        commitment: &BytesN<32>,
        outcome: bool,
        nullifier: &BytesN<32>,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Self::pack_i128(env, amount));
        out.append(&Bytes::from_slice(env, &commitment.to_array()));
        out.append(&Self::pack_bool(env, outcome));
        out.append(&Bytes::from_slice(env, &nullifier.to_array()));
        out
    }

    fn pack_bool(env: &Env, value: bool) -> Bytes {
        let mut arr = [0u8; 32];
        arr[31] = if value { 1 } else { 0 };
        Bytes::from_slice(env, &arr)
    }

    fn pack_i128(env: &Env, value: i128) -> Bytes {
        let mut arr = [0u8; 32];
        arr[16..].copy_from_slice(&value.to_be_bytes());
        Bytes::from_slice(env, &arr)
    }

    fn public_quote_bps(total_committed: i128) -> (u32, u32) {
        let total = total_committed.max(0);
        let depth = total + VIRTUAL_RESERVE;
        let swing = if depth <= 0 {
            0
        } else {
            ((total * 1_500) / depth).clamp(0, 1_500)
        };
        let yes = (5_000i128 + swing).clamp(QUOTE_FLOOR_BPS as i128, QUOTE_CAP_BPS as i128) as u32;
        let no = (10_000i128 - yes as i128).clamp(QUOTE_FLOOR_BPS as i128, QUOTE_CAP_BPS as i128) as u32;
        (yes, no)
    }
}
