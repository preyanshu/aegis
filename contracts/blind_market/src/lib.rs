#![no_std]

mod reflector_pulse;

use reflector_pulse::{Asset as ReflectorAsset, ReflectorPulseClient};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, Map,
    String, Symbol, Vec as SorobanVec,
};

const SYSTEM_KEY: Symbol = symbol_short!("SYSTEM");
const MARKET_IDS_KEY: Symbol = symbol_short!("MIDS");
const MARKET_CONFIGS_KEY: Symbol = symbol_short!("MCFGS");
const MARKET_STATES_KEY: Symbol = symbol_short!("MSTTS");
const POSITIONS_KEY: Symbol = symbol_short!("POSITNS");

const QUOTE_FLOOR_BPS: i128 = 3_500;
const QUOTE_CAP_BPS: i128 = 6_500;
const QUOTE_MID_BPS: i128 = 5_000;
const QUOTE_SCALE_BPS: i128 = 10_000;
const MAX_SWING_BPS: i128 = 1_500;
const VIRTUAL_RESERVE: i128 = 500_000_000;

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
    pub yes_shares_outstanding: i128,
    pub no_shares_outstanding: i128,
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
pub struct PositionKey {
    pub market_id: BytesN<32>,
    pub user: Address,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Position {
    pub yes_shares: i128,
    pub no_shares: i128,
    pub claimed: bool,
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
            &POSITIONS_KEY,
            &Map::<PositionKey, Position>::new(&env),
        );
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
        assert!(fee_bps <= 1_000, "fee too high");
        assert!(min_bet > 0, "min_bet must be positive");
        assert!(max_bet >= min_bet, "max_bet below min_bet");

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

    pub fn buy(
        env: Env,
        market_id: BytesN<32>,
        user: Address,
        side_yes: bool,
        usdc_amount: i128,
        min_shares_out: i128,
    ) -> i128 {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        let mut position = Self::get_position_internal(&env, &market_id, &user);

        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed",
        );
        assert!(!state.resolved, "market already resolved");
        assert!(usdc_amount >= config.min_bet, "below minimum bet");
        assert!(usdc_amount <= config.max_bet, "above maximum bet");

        let shares_out = Self::quote_buy_shares(&state, side_yes, usdc_amount);
        assert!(shares_out > 0, "trade too small");
        assert!(shares_out >= min_shares_out, "slippage exceeded");

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&user, &env.current_contract_address(), &usdc_amount);

        if side_yes {
            position.yes_shares += shares_out;
            state.yes_shares_outstanding += shares_out;
        } else {
            position.no_shares += shares_out;
            state.no_shares_outstanding += shares_out;
        }
        state.total_committed += usdc_amount;
        Self::refresh_quotes(&mut state);

        Self::store_position(&env, &market_id, &user, &position);
        Self::store_market_state(&env, &market_id, &state);

        env.events().publish(
            (symbol_short!("buy"),),
            (market_id, user, side_yes, usdc_amount, shares_out),
        );

        shares_out
    }

    pub fn sell(
        env: Env,
        market_id: BytesN<32>,
        user: Address,
        side_yes: bool,
        share_amount: i128,
        min_usdc_out: i128,
    ) -> i128 {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let config = Self::get_market_config_internal(&env, &market_id);
        let mut state = Self::get_market_state_internal(&env, &market_id);
        let mut position = Self::get_position_internal(&env, &market_id, &user);

        assert!(
            env.ledger().timestamp() < config.end_timestamp,
            "market has closed",
        );
        assert!(!state.resolved, "market already resolved");
        assert!(share_amount > 0, "share_amount must be positive");

        if side_yes {
            assert!(position.yes_shares >= share_amount, "insufficient YES shares");
        } else {
            assert!(position.no_shares >= share_amount, "insufficient NO shares");
        }

        let usdc_out = Self::quote_sell_value(&state, side_yes, share_amount);
        assert!(usdc_out > 0, "trade too small");
        assert!(usdc_out >= min_usdc_out, "slippage exceeded");
        assert!(state.total_committed >= usdc_out, "market undercollateralized");

        if side_yes {
            position.yes_shares -= share_amount;
            state.yes_shares_outstanding -= share_amount;
        } else {
            position.no_shares -= share_amount;
            state.no_shares_outstanding -= share_amount;
        }
        state.total_committed -= usdc_out;
        Self::refresh_quotes(&mut state);

        Self::store_position(&env, &market_id, &user, &position);
        Self::store_market_state(&env, &market_id, &state);

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&env.current_contract_address(), &user, &usdc_out);

        env.events().publish(
            (symbol_short!("sell"),),
            (market_id, user, side_yes, share_amount, usdc_out),
        );

        usdc_out
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

        let oracle_price = Self::get_reflector_price(&env, &system.reflector_contract);
        let outcome = oracle_price >= config.target_price;
        let fee_amount = (state.total_committed * config.fee_bps as i128) / QUOTE_SCALE_BPS;

        state.resolved = true;
        state.claims_finalized = true;
        state.outcome = outcome;
        state.outcome_price = oracle_price;
        state.distributable_pot = state.total_committed - fee_amount;
        state.winning_pool = if outcome {
            state.yes_shares_outstanding
        } else {
            state.no_shares_outstanding
        };
        state.registered_claim_amount = state.winning_pool;
        Self::store_market_state(&env, &market_id, &state);

        if fee_amount > 0 {
            let usdc = token::Client::new(&env, &system.usdc_token);
            usdc.transfer(&env.current_contract_address(), &system.admin, &fee_amount);
        }

        env.events().publish(
            (symbol_short!("resolved"),),
            (market_id, outcome, oracle_price, config.target_price, state.winning_pool),
        );
    }

    pub fn collect_position(env: Env, market_id: BytesN<32>, user: Address) -> i128 {
        user.require_auth();

        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        let state = Self::get_market_state_internal(&env, &market_id);
        let mut position = Self::get_position_internal(&env, &market_id, &user);

        assert!(state.resolved, "market not resolved");
        assert!(state.winning_pool > 0, "no winning shares");
        assert!(!position.claimed, "position already claimed");

        let winning_shares = if state.outcome {
            position.yes_shares
        } else {
            position.no_shares
        };
        assert!(winning_shares > 0, "no winning shares for user");

        let payout = (winning_shares * state.distributable_pot) / state.winning_pool;
        assert!(payout > 0, "nothing to collect");

        position.claimed = true;
        Self::store_position(&env, &market_id, &user, &position);

        let usdc = token::Client::new(&env, &system.usdc_token);
        usdc.transfer(&env.current_contract_address(), &user, &payout);

        env.events()
            .publish((symbol_short!("collect"),), (market_id, user, payout, winning_shares));

        payout
    }

    pub fn finalize_claims(env: Env, market_id: BytesN<32>) {
        let system: SystemConfig = env.storage().instance().get(&SYSTEM_KEY).unwrap();
        system.admin.require_auth();
        let state = Self::get_market_state_internal(&env, &market_id);
        assert!(state.resolved, "market not resolved");
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

    pub fn get_position(env: Env, market_id: BytesN<32>, user: Address) -> Position {
        Self::get_position_internal(&env, &market_id, &user)
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

    fn get_position_internal(env: &Env, market_id: &BytesN<32>, user: &Address) -> Position {
        let positions: Map<PositionKey, Position> =
            env.storage().instance().get(&POSITIONS_KEY).unwrap();
        positions
            .get(PositionKey {
                market_id: market_id.clone(),
                user: user.clone(),
            })
            .unwrap_or(Position {
                yes_shares: 0,
                no_shares: 0,
                claimed: false,
            })
    }

    fn store_position(env: &Env, market_id: &BytesN<32>, user: &Address, position: &Position) {
        let mut positions: Map<PositionKey, Position> =
            env.storage().instance().get(&POSITIONS_KEY).unwrap();
        positions.set(
            PositionKey {
                market_id: market_id.clone(),
                user: user.clone(),
            },
            position.clone(),
        );
        env.storage().instance().set(&POSITIONS_KEY, &positions);
    }

    fn empty_state() -> MarketState {
        MarketState {
            total_committed: 0,
            public_yes_quote_bps: QUOTE_MID_BPS,
            public_no_quote_bps: QUOTE_MID_BPS,
            yes_shares_outstanding: 0,
            no_shares_outstanding: 0,
            resolved: false,
            claims_finalized: false,
            outcome: false,
            outcome_price: 0,
            distributable_pot: 0,
            winning_pool: 0,
            registered_claim_amount: 0,
        }
    }

    fn refresh_quotes(state: &mut MarketState) {
        let (yes_quote, no_quote) =
            Self::public_quote_bps(state.yes_shares_outstanding, state.no_shares_outstanding);
        state.public_yes_quote_bps = yes_quote;
        state.public_no_quote_bps = no_quote;
    }

    fn quote_buy_shares(state: &MarketState, side_yes: bool, usdc_amount: i128) -> i128 {
        let current_quote = Self::quote_for_side(state, side_yes);
        assert!(current_quote > 0, "invalid quote");
        (usdc_amount * QUOTE_SCALE_BPS) / current_quote
    }

    fn quote_sell_value(state: &MarketState, side_yes: bool, share_amount: i128) -> i128 {
        let current_quote = Self::quote_for_side(state, side_yes);
        assert!(current_quote > 0, "invalid quote");
        (share_amount * current_quote) / QUOTE_SCALE_BPS
    }

    fn quote_for_side(state: &MarketState, side_yes: bool) -> i128 {
        if side_yes {
            state.public_yes_quote_bps
        } else {
            state.public_no_quote_bps
        }
    }

    fn public_quote_bps(yes_shares: i128, no_shares: i128) -> (i128, i128) {
        let depth = yes_shares + no_shares + VIRTUAL_RESERVE;
        let imbalance = yes_shares - no_shares;
        let swing = (imbalance * MAX_SWING_BPS) / depth;
        let yes_quote = Self::clamp_bps(QUOTE_MID_BPS + swing);
        let no_quote = QUOTE_SCALE_BPS - yes_quote;
        (yes_quote, no_quote)
    }

    fn clamp_bps(value: i128) -> i128 {
        if value < QUOTE_FLOOR_BPS {
            QUOTE_FLOOR_BPS
        } else if value > QUOTE_CAP_BPS {
            QUOTE_CAP_BPS
        } else {
            value
        }
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

}
