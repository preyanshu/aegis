#![no_std]

mod reflector_pulse;

use reflector_pulse::{Asset as ReflectorAsset, ReflectorPulseClient};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env,
    IntoVal, InvokeError, Map, String, Symbol, Val, Vec as SorobanVec,
};

const SYSTEM_KEY: Symbol = symbol_short!("SYSTEM");
const MARKET_IDS_KEY: Symbol = symbol_short!("MIDS");
const MARKET_CONFIGS_KEY: Symbol = symbol_short!("MCFGS");
const MARKET_STATES_KEY: Symbol = symbol_short!("MSTTS");
const COMMITMENTS_KEY: Symbol = symbol_short!("COMMITS");
const NULLIFIERS_KEY: Symbol = symbol_short!("NULLS");
const CLAIMS_KEY: Symbol = symbol_short!("CLAIMS");
const QUOTE_FLOOR_BPS: u32 = 2_500;
const QUOTE_CAP_BPS: u32 = 7_500;
const VIRTUAL_RESERVE: i128 = 5_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemConfig {
    pub admin: Address,
    pub usdc_token: Address,
    pub reflector_contract: Address,
    pub commit_verifier: Address,
    pub claim_verifier: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub creator: Address,
    pub question: String,
    pub target_price: i128,
    pub end_timestamp: u64,
    pub min_bet: i128,
    pub max_bet: i128,
    pub fee_bps: u32,
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
pub struct MarketView {
    pub config: MarketConfig,
    pub state: MarketState,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitmentKey {
    pub market_id: BytesN<32>,
    pub commitment: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NullifierKey {
    pub market_id: BytesN<32>,
    pub nullifier: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimKey {
    pub market_id: BytesN<32>,
    pub nullifier: BytesN<32>,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitmentRecord {
    pub market_id: BytesN<32>,
    pub commitment: BytesN<32>,
    pub amount: i128,
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClaimRecord {
    pub market_id: BytesN<32>,
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
        usdc_token: Address,
        reflector_contract: Address,
    ) {
        admin.require_auth();

        assert!(
            !env.storage().instance().has(&SYSTEM_KEY),
            "already initialized",
        );

        let system = SystemConfig {
            admin,
            usdc_token,
            reflector_contract,
            commit_verifier: env.current_contract_address(),
            claim_verifier: env.current_contract_address(),
        };

        env.storage().instance().set(&SYSTEM_KEY, &system);
        env.storage()
            .instance()
            .set(&MARKET_IDS_KEY, &SorobanVec::<BytesN<32>>::new(&env));
        env.storage().instance().set(
            &MARKET_CONFIGS_KEY,
            &Map::<BytesN<32>, MarketConfig>::new(&env),
        );
        env.storage().instance().set(
            &MARKET_STATES_KEY,
            &Map::<BytesN<32>, MarketState>::new(&env),
        );
        env.storage().instance().set(
            &COMMITMENTS_KEY,
            &Map::<CommitmentKey, CommitmentRecord>::new(&env),
        );
        env.storage()
            .instance()
            .set(&NULLIFIERS_KEY, &Map::<NullifierKey, bool>::new(&env));
        env.storage()
            .instance()
            .set(&CLAIMS_KEY, &Map::<ClaimKey, ClaimRecord>::new(&env));
    }

    pub fn set_verifiers(
        env: Env,
        admin: Address,
        commit_verifier: Address,
        claim_verifier: Address,
    ) {
        admin.require_auth();
        let mut system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        assert_eq!(admin, system.admin, "only admin can set verifiers");
        system.commit_verifier = commit_verifier;
        system.claim_verifier = claim_verifier;
        env.storage().instance().set(&SYSTEM_KEY, &system);
    }

    pub fn create_market(
        env: Env,
        creator: Address,
        market_id: BytesN<32>,
        question: String,
        target_price: i128,
        end_timestamp: u64,
        min_bet: i128,
        max_bet: i128,
        fee_bps: u32,
    ) {
        creator.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let mut configs: Map<BytesN<32>, MarketConfig> =
            env.storage().instance().get(&MARKET_CONFIGS_KEY).unwrap();
        let mut states: Map<BytesN<32>, MarketState> =
            env.storage().instance().get(&MARKET_STATES_KEY).unwrap();
        let mut ids: SorobanVec<BytesN<32>> = env.storage().instance().get(&MARKET_IDS_KEY).unwrap();

        assert!(!configs.contains_key(market_id.clone()), "market already exists");
        assert!(
            end_timestamp > env.ledger().timestamp(),
            "end must be in the future",
        );
        assert!(fee_bps <= 1000, "fee too high");
        assert!(min_bet > 0, "min_bet must be positive");
        assert!(max_bet >= min_bet, "max_bet below min_bet");
        assert!(system.commit_verifier != env.current_contract_address(), "verifiers not set");

        let config = MarketConfig {
            creator,
            question,
            target_price,
            end_timestamp,
            min_bet,
            max_bet,
            fee_bps,
        };
        let state = Self::empty_state();

        configs.set(market_id.clone(), config);
        states.set(market_id.clone(), state);
        ids.push_back(market_id.clone());

        env.storage().instance().set(&MARKET_CONFIGS_KEY, &configs);
        env.storage().instance().set(&MARKET_STATES_KEY, &states);
        env.storage().instance().set(&MARKET_IDS_KEY, &ids);

        env.events()
            .publish((symbol_short!("mk_create"),), (market_id, target_price, end_timestamp));
    }

    pub fn commit(
        env: Env,
        market_id: BytesN<32>,
        user: Address,
        commitment: BytesN<32>,
        proof: Bytes,
        amount: i128,
    ) {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);

        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed",
        );
        assert!(!state.resolved, "market already resolved");
        assert!(amount >= config.min_bet, "below minimum bet");
        assert!(amount <= config.max_bet, "above maximum bet");

        let mut commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        let commitment_key = CommitmentKey {
            market_id: market_id.clone(),
            commitment: commitment.clone(),
        };
        assert!(
            !commitments.contains_key(commitment_key.clone()),
            "commitment already exists",
        );

        Self::verify_commit_proof(&env, &system, &config, &commitment, amount, &proof);

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&user, &env.current_contract_address(), &amount);

        commitments.set(
            commitment_key,
            CommitmentRecord {
                market_id: market_id.clone(),
                commitment: commitment.clone(),
                amount,
                timestamp: env.ledger().timestamp(),
            },
        );
        env.storage().instance().set(&COMMITMENTS_KEY, &commitments);

        state.total_committed += amount;
        let (yes_quote_bps, no_quote_bps) = Self::public_quote_bps(state.total_committed);
        state.public_yes_quote_bps = yes_quote_bps as i128;
        state.public_no_quote_bps = no_quote_bps as i128;
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("committed"),),
            (market_id, user, commitment, amount),
        );
    }

    pub fn resolve(env: Env, market_id: BytesN<32>) {
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);

        assert!(
            env.ledger().timestamp() >= config.end_timestamp,
            "market still open",
        );
        assert!(!state.resolved, "already resolved");

        let btc_price = Self::get_reflector_price(&env, &system.reflector_contract);
        let outcome = btc_price >= config.target_price;
        let fee_amount = (state.total_committed * config.fee_bps as i128) / 10_000;

        state.resolved = true;
        state.outcome = outcome;
        state.outcome_price = btc_price;
        state.distributable_pot = state.total_committed - fee_amount;
        Self::store_market_state(&env, &market_id, &state);

        if fee_amount > 0 {
            let usdc = token::Client::new(&env, &system.usdc_token);
            usdc.transfer(&env.current_contract_address(), &system.admin, &fee_amount);
        }

        env.events().publish(
            (symbol_short!("resolved"),),
            (market_id, outcome, btc_price, config.target_price),
        );
    }

    pub fn register_win(
        env: Env,
        market_id: BytesN<32>,
        user: Address,
        commitment: BytesN<32>,
        amount: i128,
        nullifier: BytesN<32>,
        proof: Bytes,
    ) {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        assert!(state.resolved, "market not resolved yet");
        assert!(!state.claims_finalized, "claims already finalized");

        let commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        let commitment_key = CommitmentKey {
            market_id: market_id.clone(),
            commitment: commitment.clone(),
        };
        let record = commitments
            .get(commitment_key.clone())
            .expect("commitment not found");
        assert_eq!(record.amount, amount, "amount mismatch");

        let mut nullifiers: Map<NullifierKey, bool> =
            env.storage().instance().get(&NULLIFIERS_KEY).unwrap();
        let nullifier_key = NullifierKey {
            market_id: market_id.clone(),
            nullifier: nullifier.clone(),
        };
        assert!(
            !nullifiers.contains_key(nullifier_key.clone()),
            "already claimed",
        );

        Self::verify_claim_proof(
            &env,
            &system,
            &config,
            &commitment,
            amount,
            state.outcome,
            &nullifier,
            &proof,
        );

        nullifiers.set(nullifier_key.clone(), true);
        env.storage().instance().set(&NULLIFIERS_KEY, &nullifiers);

        let mut claims: Map<ClaimKey, ClaimRecord> =
            env.storage().instance().get(&CLAIMS_KEY).unwrap();
        let claim_key = ClaimKey {
            market_id: market_id.clone(),
            nullifier: nullifier.clone(),
        };
        assert!(!claims.contains_key(claim_key.clone()), "claim already stored");
        claims.set(
            claim_key,
            ClaimRecord {
                market_id: market_id.clone(),
                claimant: user.clone(),
                commitment: commitment.clone(),
                amount,
            },
        );
        env.storage().instance().set(&CLAIMS_KEY, &claims);

        state.registered_claim_amount += amount;
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("reg_win"),),
            (market_id, user, commitment, amount, nullifier),
        );
    }

    pub fn finalize_claims(env: Env, market_id: BytesN<32>) {
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        system.admin.require_auth();

        let mut state = Self::get_market_state_internal(&env, &market_id);
        assert!(state.resolved, "market not resolved yet");
        assert!(!state.claims_finalized, "claims already finalized");

        let winning_pool = state.registered_claim_amount;
        assert!(winning_pool > 0, "no winners registered");

        state.claims_finalized = true;
        state.winning_pool = winning_pool;
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("finalized"),),
            (market_id, winning_pool, state.distributable_pot),
        );
    }

    pub fn collect(env: Env, market_id: BytesN<32>, user: Address, nullifier: BytesN<32>) {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let state = Self::get_market_state_internal(&env, &market_id);
        assert!(state.resolved, "not resolved");
        assert!(state.claims_finalized, "claims not finalized");

        let claims: Map<ClaimKey, ClaimRecord> = env.storage().instance().get(&CLAIMS_KEY).unwrap();
        let claim_key = ClaimKey {
            market_id: market_id.clone(),
            nullifier: nullifier.clone(),
        };
        let claim = claims.get(claim_key.clone()).expect("no pending payout");
        assert_eq!(claim.claimant, user, "claimant mismatch");
        assert!(state.winning_pool > 0, "winning pool not set");

        let payout = (claim.amount * state.distributable_pot) / state.winning_pool;
        let mut claims = claims;
        claims.remove(claim_key);
        env.storage().instance().set(&CLAIMS_KEY, &claims);

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&env.current_contract_address(), &user, &payout);

        env.events()
            .publish((symbol_short!("collected"),), (market_id, user, payout, nullifier));
    }

    pub fn get_system_config(env: Env) -> SystemConfig {
        env.storage().instance().get(&SYSTEM_KEY).unwrap()
    }

    pub fn get_market_state(env: Env, market_id: BytesN<32>) -> MarketState {
        Self::get_market_state_internal(&env, &market_id)
    }

    pub fn get_market_config(env: Env, market_id: BytesN<32>) -> MarketConfig {
        Self::get_market_config_internal(&env, &market_id)
    }

    pub fn get_market_view(env: Env, market_id: BytesN<32>) -> MarketView {
        MarketView {
            config: Self::get_market_config_internal(&env, &market_id),
            state: Self::get_market_state_internal(&env, &market_id),
        }
    }

    pub fn get_market_ids(env: Env) -> Bytes {
        let ids: SorobanVec<BytesN<32>> = env.storage().instance().get(&MARKET_IDS_KEY).unwrap();
        let mut out = Bytes::new(&env);
        for id in ids.iter() {
            out.append(&Bytes::from_slice(&env, &id.to_array()));
        }
        out
    }

    pub fn is_commitment_stored(env: Env, market_id: BytesN<32>, commitment: BytesN<32>) -> bool {
        let commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        commitments.contains_key(CommitmentKey {
            market_id,
            commitment,
        })
    }

    pub fn is_nullifier_spent(env: Env, market_id: BytesN<32>, nullifier: BytesN<32>) -> bool {
        let nullifiers: Map<NullifierKey, bool> =
            env.storage().instance().get(&NULLIFIERS_KEY).unwrap();
        nullifiers.contains_key(NullifierKey {
            market_id,
            nullifier,
        })
    }

    fn get_market_config_internal(env: &Env, market_id: &BytesN<32>) -> MarketConfig {
        let configs: Map<BytesN<32>, MarketConfig> =
            env.storage().instance().get(&MARKET_CONFIGS_KEY).unwrap();
        configs.get(market_id.clone()).expect("market not found")
    }

    fn get_market_state_internal(env: &Env, market_id: &BytesN<32>) -> MarketState {
        let states: Map<BytesN<32>, MarketState> =
            env.storage().instance().get(&MARKET_STATES_KEY).unwrap();
        states.get(market_id.clone()).expect("market not found")
    }

    fn store_market_state(env: &Env, market_id: &BytesN<32>, state: &MarketState) {
        let mut states: Map<BytesN<32>, MarketState> =
            env.storage().instance().get(&MARKET_STATES_KEY).unwrap();
        states.set(market_id.clone(), state.clone());
        env.storage().instance().set(&MARKET_STATES_KEY, &states);
    }

    fn empty_state() -> MarketState {
        MarketState {
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
        }
    }

    fn verify_commit_proof(
        env: &Env,
        system: &SystemConfig,
        config: &MarketConfig,
        commitment: &BytesN<32>,
        amount: i128,
        proof: &Bytes,
    ) {
        let public_inputs =
            Self::pack_commit_public_inputs(env, amount, commitment, config.min_bet, config.max_bet);
        Self::verify_with_contract(env, &system.commit_verifier, public_inputs, proof.clone());
    }

    fn verify_claim_proof(
        env: &Env,
        system: &SystemConfig,
        _config: &MarketConfig,
        commitment: &BytesN<32>,
        amount: i128,
        outcome: bool,
        nullifier: &BytesN<32>,
        proof: &Bytes,
    ) {
        let public_inputs = Self::pack_claim_public_inputs(env, amount, commitment, outcome, nullifier);
        Self::verify_with_contract(env, &system.claim_verifier, public_inputs, proof.clone());
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
