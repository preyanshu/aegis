#![no_std]

mod reflector_pulse;

use reflector_pulse::{Asset as ReflectorAsset, ReflectorPulseClient};
use soroban_sdk::{
    contract, contractimpl, contracttype, log, symbol_short, token, Address, Bytes, BytesN, Env,
    IntoVal, Map, String, Symbol, Val, Vec as SorobanVec,
};

const SYSTEM_KEY: Symbol = symbol_short!("SYSTEM");
const MARKET_IDS_KEY: Symbol = symbol_short!("MIDS");
const MARKET_CONFIGS_KEY: Symbol = symbol_short!("MCFGS");
const MARKET_STATES_KEY: Symbol = symbol_short!("MSTTS");
const COMMITMENTS_KEY: Symbol = symbol_short!("COMMITS");
const NULLIFIERS_KEY: Symbol = symbol_short!("NULLS");

const QUOTE_SCALE_BPS: i128 = 10_000;
const MAX_ORACLE_CONDITIONS: u32 = 5;
const CLAIMS_FINALIZED_TRUE: bool = true;
const PRIVATE_TALLY_WINDOW_SECONDS: u64 = 2 * 60;
const MARKET_LIFECYCLE_OPEN: u32 = 0;
const MARKET_LIFECYCLE_AWAITING_PRIVATE_TALLY: u32 = 1;
const MARKET_LIFECYCLE_READY_TO_FINALIZE: u32 = 2;
const MARKET_LIFECYCLE_RESOLVED: u32 = 3;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SystemConfig {
    pub admin: Address,
    pub usdc_token: Address,
    pub reflector_contract: Address,
    pub commit_verifier: Address,
    pub tally_update_verifier: Address,
    pub tally_finalize_verifier: Address,
    pub claim_verifier: Address,
    pub shard_signer_1: Address,
    pub shard_signer_2: Address,
    pub shard_signer_3: Address,
    pub shard_signer_4: Address,
    pub shard_signer_5: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleCondition {
    pub oracle_contract: Address,
    pub asset_symbol: Symbol,
    pub greater_or_equal: bool,
    pub threshold: i128,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedCondition {
    pub oracle_contract: Address,
    pub asset_symbol: Symbol,
    pub greater_or_equal: bool,
    pub threshold: i128,
    pub observed_price: i128,
    pub observed_timestamp: u64,
    pub satisfied: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketConfig {
    pub creator: Address,
    pub question: String,
    pub category: String,
    pub condition_count: u32,
    pub condition_1: OracleCondition,
    pub condition_2: OracleCondition,
    pub condition_3: OracleCondition,
    pub condition_4: OracleCondition,
    pub condition_5: OracleCondition,
    pub operator_1_is_and: bool,
    pub operator_2_is_and: bool,
    pub operator_3_is_and: bool,
    pub operator_4_is_and: bool,
    pub end_timestamp: u64,
    pub min_bet: i128,
    pub max_bet: i128,
    pub fee_bps: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OracleConditionsInput {
    pub condition_count: u32,
    pub condition_1: OracleCondition,
    pub condition_2: OracleCondition,
    pub condition_3: OracleCondition,
    pub condition_4: OracleCondition,
    pub condition_5: OracleCondition,
    pub operator_1_is_and: bool,
    pub operator_2_is_and: bool,
    pub operator_3_is_and: bool,
    pub operator_4_is_and: bool,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketState {
    pub total_locked_collateral: i128,
    pub commitment_count: u32,
    pub resolved: bool,
    pub claims_finalized: bool,
    pub tally_finalized: bool,
    pub market_lifecycle: u32,
    pub outcome: bool,
    pub outcome_price: i128,
    pub resolved_condition_count: u32,
    pub resolved_condition_1: ResolvedCondition,
    pub resolved_condition_2: ResolvedCondition,
    pub resolved_condition_3: ResolvedCondition,
    pub resolved_condition_4: ResolvedCondition,
    pub resolved_condition_5: ResolvedCondition,
    pub distributable_pot: i128,
    pub winning_side_total: i128,
    pub total_claimed_out: i128,
    pub settled_at: u64,
    pub tally_deadline: u64,
    pub tallied_count: u32,
    pub tally_commitment: BytesN<32>,
    pub aggregate_commitment: BytesN<32>,
    pub tallied_collateral_total: i128,
    pub missed_tally_collateral: i128,
    pub treasury_amount: i128,
    pub yes_total: i128,
    pub no_total: i128,
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
pub struct CommitmentRecord {
    pub owner: Address,
    pub collateral_amount: i128,
    pub claimed: bool,
    pub tallied: bool,
    pub tallied_at: u64,
    pub share_commitment_root: BytesN<32>,
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
            admin: admin.clone(),
            usdc_token,
            reflector_contract,
            commit_verifier: env.current_contract_address(),
            tally_update_verifier: env.current_contract_address(),
            tally_finalize_verifier: env.current_contract_address(),
            claim_verifier: env.current_contract_address(),
            shard_signer_1: admin.clone(),
            shard_signer_2: admin.clone(),
            shard_signer_3: admin.clone(),
            shard_signer_4: admin.clone(),
            shard_signer_5: admin.clone(),
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
            .set(&NULLIFIERS_KEY, &Map::<BytesN<32>, bool>::new(&env));
    }

    pub fn set_verifiers(
        env: Env,
        admin: Address,
        commit_verifier: Address,
        tally_update_verifier: Address,
        tally_finalize_verifier: Address,
        claim_verifier: Address,
    ) {
        admin.require_auth();
        let mut system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        assert_eq!(admin, system.admin, "only admin can set verifiers");
        system.commit_verifier = commit_verifier;
        system.tally_update_verifier = tally_update_verifier;
        system.tally_finalize_verifier = tally_finalize_verifier;
        system.claim_verifier = claim_verifier;
        env.storage().instance().set(&SYSTEM_KEY, &system);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn set_shard_signers(
        env: Env,
        admin: Address,
        shard_signer_1: Address,
        shard_signer_2: Address,
        shard_signer_3: Address,
        shard_signer_4: Address,
        shard_signer_5: Address,
    ) {
        admin.require_auth();
        let mut system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        assert_eq!(admin, system.admin, "only admin can set shard signers");
        system.shard_signer_1 = shard_signer_1;
        system.shard_signer_2 = shard_signer_2;
        system.shard_signer_3 = shard_signer_3;
        system.shard_signer_4 = shard_signer_4;
        system.shard_signer_5 = shard_signer_5;
        env.storage().instance().set(&SYSTEM_KEY, &system);
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_market(
        env: Env,
        creator: Address,
        market_id: BytesN<32>,
        question: String,
        category: String,
        conditions: OracleConditionsInput,
        end_timestamp: u64,
        min_bet: i128,
        max_bet: i128,
        fee_bps: u32,
    ) {
        creator.require_auth();

        let mut configs: Map<BytesN<32>, MarketConfig> =
            env.storage().instance().get(&MARKET_CONFIGS_KEY).unwrap();
        let mut states: Map<BytesN<32>, MarketState> =
            env.storage().instance().get(&MARKET_STATES_KEY).unwrap();
        let mut ids: SorobanVec<BytesN<32>> =
            env.storage().instance().get(&MARKET_IDS_KEY).unwrap();

        assert!(!configs.contains_key(market_id.clone()), "market already exists");
        assert!(
            end_timestamp > env.ledger().timestamp(),
            "end must be in the future",
        );
        assert!(fee_bps <= 1_000, "fee too high");
        assert!(min_bet > 0, "min_bet must be positive");
        assert!(max_bet >= min_bet, "max_bet below min_bet");
        assert!(category.len() > 0, "category is required");
        Self::validate_market_conditions(
            conditions.condition_count,
            &conditions.condition_1,
            &conditions.condition_2,
            &conditions.condition_3,
            &conditions.condition_4,
            &conditions.condition_5,
        );

        let config = MarketConfig {
            creator,
            question,
            category,
            condition_count: conditions.condition_count,
            condition_1: conditions.condition_1,
            condition_2: conditions.condition_2,
            condition_3: conditions.condition_3,
            condition_4: conditions.condition_4,
            condition_5: conditions.condition_5,
            operator_1_is_and: conditions.operator_1_is_and,
            operator_2_is_and: conditions.operator_2_is_and,
            operator_3_is_and: conditions.operator_3_is_and,
            operator_4_is_and: conditions.operator_4_is_and,
            end_timestamp,
            min_bet,
            max_bet,
            fee_bps,
        };

        let mut state = Self::empty_state(&env);
        state.tally_deadline = end_timestamp + PRIVATE_TALLY_WINDOW_SECONDS;

        configs.set(market_id.clone(), config);
        states.set(market_id.clone(), state);
        ids.push_back(market_id.clone());

        env.storage().instance().set(&MARKET_CONFIGS_KEY, &configs);
        env.storage().instance().set(&MARKET_STATES_KEY, &states);
        env.storage().instance().set(&MARKET_IDS_KEY, &ids);

        env.events()
            .publish((symbol_short!("mk_create"),), (market_id, end_timestamp));
    }

    pub fn commit_position(
        env: Env,
        market_id: BytesN<32>,
        owner: Address,
        commitment: BytesN<32>,
        collateral_amount: i128,
        proof: Bytes,
    ) {
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        owner.require_auth();

        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed",
        );
        assert!(!state.resolved, "market already resolved");
        assert!(
            collateral_amount >= config.min_bet,
            "below minimum collateral"
        );
        assert!(
            collateral_amount <= config.max_bet,
            "above maximum collateral"
        );

        let key = CommitmentKey {
            market_id: market_id.clone(),
            commitment: commitment.clone(),
        };
        let mut commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        assert!(!commitments.contains_key(key.clone()), "commitment already exists");

        Self::verify_commit_proof(
            &env,
            &system,
            &market_id,
            &commitment,
            collateral_amount,
            config.min_bet,
            config.max_bet,
            proof,
        );

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&owner, &env.current_contract_address(), &collateral_amount);

        commitments.set(
            key,
            CommitmentRecord {
                owner: owner.clone(),
                collateral_amount,
                claimed: false,
                tallied: false,
                tallied_at: 0,
                share_commitment_root: Self::blank_bytes32(&env),
            },
        );
        env.storage().instance().set(&COMMITMENTS_KEY, &commitments);

        state.total_locked_collateral += collateral_amount;
        state.commitment_count += 1;
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("commit"),),
            (market_id, commitment, collateral_amount),
        );
    }

    pub fn submit_private_tally(
        env: Env,
        market_id: BytesN<32>,
        commitment: BytesN<32>,
        next_tally_commitment: BytesN<32>,
        share_commitment_root: BytesN<32>,
        proof: Bytes,
    ) {
        log!(&env, "tally stage 1");
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);

        log!(&env, "tally stage 2");
        assert!(
            env.ledger().timestamp() >= config.end_timestamp,
            "market still open",
        );
        assert!(
            env.ledger().timestamp() < state.tally_deadline,
            "tally window closed",
        );
        assert!(!state.tally_finalized, "market already finalized");

        let key = CommitmentKey {
            market_id: market_id.clone(),
            commitment: commitment.clone(),
        };
        let mut commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        let mut record = commitments.get(key.clone()).expect("commitment not found");
        assert!(!record.tallied, "commitment already tallied");

        log!(&env, "tally stage 3");
        Self::verify_tally_update_proof(
            &env,
            &system,
            &market_id,
            &commitment,
            record.collateral_amount,
            &state.tally_commitment,
            &next_tally_commitment,
            &share_commitment_root,
            proof,
        );
        log!(&env, "tally stage 4");

        record.tallied = true;
        record.tallied_at = env.ledger().timestamp();
        record.share_commitment_root = share_commitment_root.clone();
        let tallied_collateral = record.collateral_amount;
        commitments.set(key, record);
        env.storage().instance().set(&COMMITMENTS_KEY, &commitments);

        state.tallied_count += 1;
        state.tallied_collateral_total += tallied_collateral;
        state.tally_commitment = next_tally_commitment;
        state.market_lifecycle = MARKET_LIFECYCLE_AWAITING_PRIVATE_TALLY;
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("tally"),),
            (
                market_id,
                commitment,
                state.tallied_count,
                state.tally_commitment.clone(),
                share_commitment_root,
            ),
        );
    }

    pub fn finalize_private_tally(
        env: Env,
        market_id: BytesN<32>,
        yes_total: i128,
        no_total: i128,
        tallied_count: u32,
        aggregate_commitment: BytesN<32>,
        shard_signer_1: Address,
        shard_signer_2: Address,
        shard_signer_3: Address,
    ) {
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);

        assert!(
            env.ledger().timestamp() >= state.tally_deadline,
            "tally window not finished",
        );
        assert!(!state.tally_finalized, "already finalized");
        assert!(tallied_count == state.tallied_count, "tallied count mismatch");
        assert!(aggregate_commitment == state.tally_commitment, "aggregate commitment mismatch");
        assert!(yes_total >= 0 && no_total >= 0, "negative aggregate total");
        let tallied_settlement_pot = yes_total + no_total;
        assert!(
            tallied_settlement_pot == state.tallied_collateral_total,
            "aggregate total mismatch",
        );
        assert!(
            tallied_settlement_pot <= state.total_locked_collateral,
            "aggregate total exceeds collateral",
        );

        Self::require_three_shard_signers(
            &system,
            &shard_signer_1,
            &shard_signer_2,
            &shard_signer_3,
        );

        let resolved_conditions = Self::resolve_market_conditions(&env, &config);
        let outcome = Self::combine_condition_results(&config, &resolved_conditions);
        let winning_side_total = if outcome { yes_total } else { no_total };

        let oracle_price = resolved_conditions.0.observed_price;
        let missed_tally_collateral = state.total_locked_collateral - tallied_settlement_pot;

        // If nobody bet on the winning side, the entire pot is unclaimable and
        // goes to treasury along with any missed-tally collateral and fees.
        let (distributable_pot, treasury_amount) = if winning_side_total == 0 {
            (0i128, state.total_locked_collateral)
        } else {
            assert!(
                winning_side_total <= tallied_settlement_pot,
                "winning total exceeds collateral",
            );
            let fee_amount =
                (tallied_settlement_pot * config.fee_bps as i128) / QUOTE_SCALE_BPS;
            (tallied_settlement_pot - fee_amount, missed_tally_collateral + fee_amount)
        };

        state.resolved = true;
        state.claims_finalized = CLAIMS_FINALIZED_TRUE;
        state.tally_finalized = true;
        state.market_lifecycle = MARKET_LIFECYCLE_RESOLVED;
        state.outcome = outcome;
        state.outcome_price = oracle_price;
        state.resolved_condition_count = config.condition_count;
        state.resolved_condition_1 = resolved_conditions.0;
        state.resolved_condition_2 = resolved_conditions.1;
        state.resolved_condition_3 = resolved_conditions.2;
        state.resolved_condition_4 = resolved_conditions.3;
        state.resolved_condition_5 = resolved_conditions.4;
        state.distributable_pot = distributable_pot;
        state.winning_side_total = winning_side_total;
        state.aggregate_commitment = aggregate_commitment.clone();
        state.missed_tally_collateral = missed_tally_collateral;
        state.treasury_amount = treasury_amount;
        state.yes_total = yes_total;
        state.no_total = no_total;
        state.settled_at = env.ledger().timestamp();
        Self::store_market_state(&env, &market_id, &state);

        if treasury_amount > 0 {
            let usdc = token::Client::new(&env, &system.usdc_token);
            usdc.transfer(&env.current_contract_address(), &system.admin, &treasury_amount);
        }

        env.events().publish(
            (symbol_short!("resolved"),),
            (
                market_id,
                outcome,
                oracle_price,
                distributable_pot,
                winning_side_total,
                aggregate_commitment,
                treasury_amount,
            ),
        );
    }

    pub fn claim_winnings(
        env: Env,
        market_id: BytesN<32>,
        commitment: BytesN<32>,
        nullifier: BytesN<32>,
        recipient: Address,
        proof: Bytes,
    ) -> i128 {
        recipient.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let state = Self::get_market_state_internal(&env, &market_id);
        let mut commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        let mut nullifiers: Map<BytesN<32>, bool> =
            env.storage().instance().get(&NULLIFIERS_KEY).unwrap();

        assert!(state.resolved, "market not resolved");
        assert!(state.claims_finalized, "claims not finalized");
        assert!(state.winning_side_total > 0, "winning total unavailable");
        assert!(!nullifiers.contains_key(nullifier.clone()), "nullifier already spent");

        let key = CommitmentKey {
            market_id: market_id.clone(),
            commitment: commitment.clone(),
        };
        let mut record = commitments.get(key.clone()).expect("commitment not found");
        assert_eq!(record.owner, recipient, "recipient does not own commitment");
        assert!(!record.claimed, "commitment already claimed");
        assert!(record.tallied, "missed tally window");

        let payout =
            (record.collateral_amount * state.distributable_pot) / state.winning_side_total;
        assert!(payout > 0, "nothing to claim");
        assert!(
            state.total_claimed_out + payout <= state.distributable_pot,
            "payout exceeds distributable pot",
        );

        Self::verify_claim_proof(
            &env,
            &system,
            &market_id,
            &commitment,
            &nullifier,
            state.outcome,
            state.distributable_pot,
            state.winning_side_total,
            payout,
            proof,
        );

        record.claimed = true;
        commitments.set(key, record);
        nullifiers.set(nullifier.clone(), true);
        env.storage().instance().set(&COMMITMENTS_KEY, &commitments);
        env.storage().instance().set(&NULLIFIERS_KEY, &nullifiers);

        let mut next_state = state.clone();
        next_state.total_claimed_out += payout;
        Self::store_market_state(&env, &market_id, &next_state);

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&env.current_contract_address(), &recipient, &payout);

        env.events()
            .publish((symbol_short!("claim"),), (market_id, recipient, payout));

        payout
    }

    pub fn get_system_config(env: Env) -> SystemConfig {
        env.storage().instance().get(&SYSTEM_KEY).unwrap()
    }

    pub fn get_market_state(env: Env, market_id: BytesN<32>) -> MarketState {
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        state.market_lifecycle = Self::derive_market_lifecycle(&env, &config, &state);
        state
    }

    pub fn get_market_config(env: Env, market_id: BytesN<32>) -> MarketConfig {
        Self::get_market_config_internal(&env, &market_id)
    }

    pub fn get_market_view(env: Env, market_id: BytesN<32>) -> MarketView {
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        state.market_lifecycle = Self::derive_market_lifecycle(&env, &config, &state);
        MarketView {
            config,
            state,
        }
    }

    pub fn get_commitment_record(
        env: Env,
        market_id: BytesN<32>,
        commitment: BytesN<32>,
    ) -> CommitmentRecord {
        let commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        commitments
            .get(CommitmentKey {
                market_id,
                commitment,
            })
            .expect("commitment not found")
    }

    pub fn debug_tally_update_public_inputs(
        env: Env,
        market_id: BytesN<32>,
        commitment: BytesN<32>,
        next_tally_commitment: BytesN<32>,
        share_commitment_root: BytesN<32>,
    ) -> Bytes {
        let state = Self::get_market_state_internal(&env, &market_id);
        let commitments: Map<CommitmentKey, CommitmentRecord> =
            env.storage().instance().get(&COMMITMENTS_KEY).unwrap();
        let record = commitments
            .get(CommitmentKey {
                market_id: market_id.clone(),
                commitment: commitment.clone(),
            })
            .expect("commitment not found");
        Self::build_tally_update_public_inputs(
            &env,
            &market_id,
            &commitment,
            record.collateral_amount,
            &state.tally_commitment,
            &next_tally_commitment,
            &share_commitment_root,
        )
    }

    pub fn get_market_ids(env: Env) -> Bytes {
        let ids: SorobanVec<BytesN<32>> = env.storage().instance().get(&MARKET_IDS_KEY).unwrap();
        let mut out = Bytes::new(&env);
        for id in ids.iter() {
            out.append(&Bytes::from_slice(&env, &id.to_array()));
        }
        out
    }

    fn validate_market_conditions(
        condition_count: u32,
        condition_1: &OracleCondition,
        condition_2: &OracleCondition,
        condition_3: &OracleCondition,
        condition_4: &OracleCondition,
        condition_5: &OracleCondition,
    ) {
        assert!(condition_count > 0, "at least one condition is required");
        assert!(condition_count <= MAX_ORACLE_CONDITIONS, "too many conditions");
        if condition_count >= 1 {
            assert!(condition_1.threshold > 0, "condition 1 threshold must be positive");
        }
        if condition_count >= 2 {
            assert!(condition_2.threshold > 0, "condition 2 threshold must be positive");
        }
        if condition_count >= 3 {
            assert!(condition_3.threshold > 0, "condition 3 threshold must be positive");
        }
        if condition_count >= 4 {
            assert!(condition_4.threshold > 0, "condition 4 threshold must be positive");
        }
        if condition_count >= 5 {
            assert!(condition_5.threshold > 0, "condition 5 threshold must be positive");
        }
    }

    fn verify_commit_proof(
        env: &Env,
        system: &SystemConfig,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        collateral_amount: i128,
        min_bet: i128,
        max_bet: i128,
        proof: Bytes,
    ) {
        let public_inputs = Self::build_commit_public_inputs(
            env,
            market_id,
            commitment,
            collateral_amount,
            min_bet,
            max_bet,
        );
        let args = (
            public_inputs,
            proof,
        )
            .into_val(env);
        let result: Result<(), Val> = env.invoke_contract(
            &system.commit_verifier,
            &Symbol::new(env, "verify_proof"),
            args,
        );
        assert!(result.is_ok(), "commit proof verification failed");
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_claim_proof(
        env: &Env,
        system: &SystemConfig,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        nullifier: &BytesN<32>,
        outcome: bool,
        distributable_pot: i128,
        winning_side_total: i128,
        payout: i128,
        proof: Bytes,
    ) {
        let public_inputs = Self::build_claim_public_inputs(
            env,
            market_id,
            commitment,
            outcome,
            nullifier,
            distributable_pot,
            winning_side_total,
            payout,
        );
        let args = (
            public_inputs,
            proof,
        )
            .into_val(env);
        let result: Result<(), Val> = env.invoke_contract(
            &system.claim_verifier,
            &Symbol::new(env, "verify_proof"),
            args,
        );
        assert!(result.is_ok(), "claim proof verification failed");
    }

    #[allow(clippy::too_many_arguments)]
    fn verify_tally_update_proof(
        env: &Env,
        system: &SystemConfig,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        collateral_amount: i128,
        previous_tally_commitment: &BytesN<32>,
        next_tally_commitment: &BytesN<32>,
        share_commitment_root: &BytesN<32>,
        proof: Bytes,
    ) {
        log!(env, "tally verify stage 1");
        let public_inputs = Self::build_tally_update_public_inputs(
            env,
            market_id,
            commitment,
            collateral_amount,
            previous_tally_commitment,
            next_tally_commitment,
            share_commitment_root,
        );
        log!(env, "tally verify stage 2");
        let args = (public_inputs, proof).into_val(env);
        log!(env, "tally verify stage 3");
        let result: Result<(), Val> = env.invoke_contract(
            &system.tally_update_verifier,
            &Symbol::new(env, "verify_proof"),
            args,
        );
        log!(env, "tally verify stage 4");
        assert!(result.is_ok(), "tally proof verification failed");
    }

    fn verify_tally_finalize_proof(
        env: &Env,
        system: &SystemConfig,
        market_id: &BytesN<32>,
        tally_commitment: &BytesN<32>,
        outcome: bool,
        winning_side_total: i128,
        proof: Bytes,
    ) {
        let public_inputs = Self::build_tally_finalize_public_inputs(
            env,
            market_id,
            tally_commitment,
            outcome,
            winning_side_total,
        );
        let args = (public_inputs, proof).into_val(env);
        let result: Result<(), Val> = env.invoke_contract(
            &system.tally_finalize_verifier,
            &Symbol::new(env, "verify_proof"),
            args,
        );
        assert!(result.is_ok(), "tally finalize proof verification failed");
    }

    fn build_commit_public_inputs(
        env: &Env,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        collateral_amount: i128,
        min_bet: i128,
        max_bet: i128,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Self::field_bytes_from_i128(env, collateral_amount));
        out.append(&Bytes::from_slice(env, &commitment.to_array()));
        out.append(&Self::market_id_field_bytes(env, market_id));
        out.append(&Self::field_bytes_from_i128(env, min_bet));
        out.append(&Self::field_bytes_from_i128(env, max_bet));
        out
    }

    #[allow(clippy::too_many_arguments)]
    fn build_claim_public_inputs(
        env: &Env,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        outcome: bool,
        nullifier: &BytesN<32>,
        distributable_pot: i128,
        winning_side_total: i128,
        payout: i128,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Bytes::from_slice(env, &commitment.to_array()));
        out.append(&Self::market_id_field_bytes(env, market_id));
        out.append(&Self::field_bytes_from_i128(env, if outcome { 1 } else { 0 }));
        out.append(&Bytes::from_slice(env, &nullifier.to_array()));
        out.append(&Self::field_bytes_from_i128(env, distributable_pot));
        out.append(&Self::field_bytes_from_i128(env, winning_side_total));
        out.append(&Self::field_bytes_from_i128(env, payout));
        out
    }

    fn build_tally_update_public_inputs(
        env: &Env,
        market_id: &BytesN<32>,
        commitment: &BytesN<32>,
        collateral_amount: i128,
        previous_tally_commitment: &BytesN<32>,
        next_tally_commitment: &BytesN<32>,
        share_commitment_root: &BytesN<32>,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Bytes::from_slice(env, &commitment.to_array()));
        out.append(&Self::market_id_field_bytes(env, market_id));
        out.append(&Self::field_bytes_from_i128(env, collateral_amount));
        out.append(&Bytes::from_slice(env, &previous_tally_commitment.to_array()));
        out.append(&Bytes::from_slice(env, &next_tally_commitment.to_array()));
        out.append(&Bytes::from_slice(env, &share_commitment_root.to_array()));
        out
    }

    fn require_three_shard_signers(
        system: &SystemConfig,
        signer_1: &Address,
        signer_2: &Address,
        signer_3: &Address,
    ) {
        assert!(signer_1 != signer_2, "duplicate shard signer");
        assert!(signer_1 != signer_3, "duplicate shard signer");
        assert!(signer_2 != signer_3, "duplicate shard signer");
        assert!(Self::is_configured_shard_signer(system, signer_1), "invalid shard signer");
        assert!(Self::is_configured_shard_signer(system, signer_2), "invalid shard signer");
        assert!(Self::is_configured_shard_signer(system, signer_3), "invalid shard signer");
    }

    fn is_configured_shard_signer(system: &SystemConfig, signer: &Address) -> bool {
        signer == &system.shard_signer_1
            || signer == &system.shard_signer_2
            || signer == &system.shard_signer_3
            || signer == &system.shard_signer_4
            || signer == &system.shard_signer_5
    }

    fn build_tally_finalize_public_inputs(
        env: &Env,
        market_id: &BytesN<32>,
        tally_commitment: &BytesN<32>,
        outcome: bool,
        winning_side_total: i128,
    ) -> Bytes {
        let mut out = Bytes::new(env);
        out.append(&Self::market_id_field_bytes(env, market_id));
        out.append(&Bytes::from_slice(env, &tally_commitment.to_array()));
        out.append(&Self::field_bytes_from_i128(env, if outcome { 1 } else { 0 }));
        out.append(&Self::field_bytes_from_i128(env, winning_side_total));
        out
    }

    fn market_id_field_bytes(env: &Env, market_id: &BytesN<32>) -> Bytes {
        let raw = market_id.to_array();
        let mut out = [0u8; 32];
        let mut idx = 1;
        while idx < 32 {
            out[idx] = raw[idx];
            idx += 1;
        }
        Bytes::from_slice(env, &out)
    }

    fn field_bytes_from_i128(env: &Env, value: i128) -> Bytes {
        assert!(value >= 0, "negative field values are unsupported");
        let mut out = [0u8; 32];
        let value_bytes = (value as u128).to_be_bytes();
        let mut idx = 0;
        while idx < 16 {
            out[16 + idx] = value_bytes[idx];
            idx += 1;
        }
        Bytes::from_slice(env, &out)
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

    fn empty_state(env: &Env) -> MarketState {
        MarketState {
            total_locked_collateral: 0,
            commitment_count: 0,
            resolved: false,
            claims_finalized: false,
            tally_finalized: false,
            market_lifecycle: MARKET_LIFECYCLE_OPEN,
            outcome: false,
            outcome_price: 0,
            resolved_condition_count: 0,
            resolved_condition_1: Self::blank_resolved_condition(env),
            resolved_condition_2: Self::blank_resolved_condition(env),
            resolved_condition_3: Self::blank_resolved_condition(env),
            resolved_condition_4: Self::blank_resolved_condition(env),
            resolved_condition_5: Self::blank_resolved_condition(env),
            distributable_pot: 0,
            winning_side_total: 0,
            total_claimed_out: 0,
            settled_at: 0,
            tally_deadline: 0,
            tallied_count: 0,
            tally_commitment: Self::blank_bytes32(env),
            aggregate_commitment: Self::blank_bytes32(env),
            tallied_collateral_total: 0,
            missed_tally_collateral: 0,
            treasury_amount: 0,
            yes_total: 0,
            no_total: 0,
        }
    }

    fn blank_bytes32(env: &Env) -> BytesN<32> {
        BytesN::from_array(env, &[0u8; 32])
    }

    fn derive_market_lifecycle(
        env: &Env,
        config: &MarketConfig,
        state: &MarketState,
    ) -> u32 {
        if state.resolved || state.tally_finalized {
            return MARKET_LIFECYCLE_RESOLVED;
        }

        let now = env.ledger().timestamp();
        if now < config.end_timestamp {
            return MARKET_LIFECYCLE_OPEN;
        }

        if now < state.tally_deadline {
            return MARKET_LIFECYCLE_AWAITING_PRIVATE_TALLY;
        }

        MARKET_LIFECYCLE_READY_TO_FINALIZE
    }

    fn blank_resolved_condition(env: &Env) -> ResolvedCondition {
        ResolvedCondition {
            oracle_contract: Address::from_string(&String::from_str(
                env,
                "CCYOZJCOPG34LLQQ7N24YXBM7LL62R7ONMZ3G6WZAAYPB5OYKOMJRN63",
            )),
            asset_symbol: Symbol::new(env, "NA"),
            greater_or_equal: true,
            threshold: 0,
            observed_price: 0,
            observed_timestamp: 0,
            satisfied: false,
        }
    }

    fn resolve_market_conditions(
        env: &Env,
        config: &MarketConfig,
    ) -> (
        ResolvedCondition,
        ResolvedCondition,
        ResolvedCondition,
        ResolvedCondition,
        ResolvedCondition,
    ) {
        (
            Self::resolve_single_condition(env, &config.condition_1),
            if config.condition_count >= 2 {
                Self::resolve_single_condition(env, &config.condition_2)
            } else {
                Self::blank_resolved_condition(env)
            },
            if config.condition_count >= 3 {
                Self::resolve_single_condition(env, &config.condition_3)
            } else {
                Self::blank_resolved_condition(env)
            },
            if config.condition_count >= 4 {
                Self::resolve_single_condition(env, &config.condition_4)
            } else {
                Self::blank_resolved_condition(env)
            },
            if config.condition_count >= 5 {
                Self::resolve_single_condition(env, &config.condition_5)
            } else {
                Self::blank_resolved_condition(env)
            },
        )
    }

    fn resolve_single_condition(env: &Env, condition: &OracleCondition) -> ResolvedCondition {
        let client = ReflectorPulseClient::new(env, &condition.oracle_contract);
        let price_data = client
            .lastprice(&ReflectorAsset::Other(condition.asset_symbol.clone()))
            .expect("oracle price unavailable");

        let observed_price = price_data.price;
        let satisfied = if condition.greater_or_equal {
            observed_price >= condition.threshold
        } else {
            observed_price <= condition.threshold
        };

        ResolvedCondition {
            oracle_contract: condition.oracle_contract.clone(),
            asset_symbol: condition.asset_symbol.clone(),
            greater_or_equal: condition.greater_or_equal,
            threshold: condition.threshold,
            observed_price,
            observed_timestamp: price_data.timestamp,
            satisfied,
        }
    }

    fn combine_condition_results(
        config: &MarketConfig,
        conditions: &(
            ResolvedCondition,
            ResolvedCondition,
            ResolvedCondition,
            ResolvedCondition,
            ResolvedCondition,
        ),
    ) -> bool {
        let results = [
            conditions.0.satisfied,
            conditions.1.satisfied,
            conditions.2.satisfied,
            conditions.3.satisfied,
            conditions.4.satisfied,
        ];
        let operators = [
            config.operator_1_is_and,
            config.operator_2_is_and,
            config.operator_3_is_and,
            config.operator_4_is_and,
        ];

        let mut value = results[0];
        let mut idx = 1usize;
        while idx < config.condition_count as usize {
            value = if operators[idx - 1] {
                value && results[idx]
            } else {
                value || results[idx]
            };
            idx += 1;
        }
        value
    }
}
