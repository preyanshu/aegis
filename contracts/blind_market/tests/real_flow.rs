use blind_market::{BlindMarket, BlindMarketClient, OracleCondition, OracleConditionsInput};
use soroban_sdk::{
    contract, contractimpl, contracttype, symbol_short, token, Address, Bytes, BytesN, Env, String,
    Symbol,
    testutils::{Address as _, Ledger as _, LedgerInfo},
};
use ultrahonk_verifier::UltraHonkVerifierContractClient;

const COMMIT_VK: &[u8] = include_bytes!("../../../verifier/commit_vk.bin");
const TALLY_UPDATE_VK: &[u8] = include_bytes!("../../../verifier/tally_update_vk.bin");
const CLAIM_VK: &[u8] = include_bytes!("../../../verifier/claim_vk.bin");

const COMMIT_PROOF_YES: &[u8] = include_bytes!("../../../verifier/fixtures/commit.proof.bin");
const COMMIT_PROOF_NO: &[u8] = include_bytes!("../../../verifier/fixtures/commit_no.proof.bin");
const TALLY_UPDATE_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/tally_update.proof.bin");
const CLAIM_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/claim.proof.bin");

const MARKET_ID_HEX: &str = "00000000000000000000000000000000000000000000000000000000000000a1";
const COMMITMENT_YES_HEX: &str = "2ae61645616cffd3ee2ca8a0f2e424121946a521276eae6e378cd438744749d6";
const NULLIFIER_YES_HEX: &str = "243b77e71ecfc0074ca6e0218d6fe0a05d87bd03b66197e3ea7a86395d91e01b";
const MIN_BET: i128 = 10_000_000;
const MAX_BET: i128 = 20_000_000;
const AMOUNT: i128 = 10_000_000;

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Asset {
    Stellar(Address),
    Other(Symbol),
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PriceData {
    pub price: i128,
    pub timestamp: u64,
}

#[contract]
pub struct TestOracle;

#[contractimpl]
impl TestOracle {
    pub fn decimals() -> u32 {
        7
    }

    pub fn price(env: Env, _asset: Asset, timestamp: u64) -> Option<PriceData> {
        Some(PriceData {
            price: env.storage().instance().get(&Symbol::new(&env, "price")).unwrap(),
            timestamp,
        })
    }

    pub fn lastprice(env: Env, _asset: Asset) -> Option<PriceData> {
        Some(PriceData {
            price: env.storage().instance().get(&Symbol::new(&env, "price")).unwrap(),
            timestamp: env.ledger().timestamp(),
        })
    }

    pub fn resolution() -> u32 {
        1
    }

    pub fn set_price(env: Env, price: i128) {
        env.storage()
            .instance()
            .set(&Symbol::new(&env, "price"), &price);
    }
}

fn hex_to_bytes_32(hex: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for index in 0..32 {
        out[index] = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).unwrap();
    }
    out
}

fn bytesn32(env: &Env, hex: &str) -> BytesN<32> {
    BytesN::from_array(env, &hex_to_bytes_32(hex))
}

fn fixture_hex(field: &str) -> ::std::string::String {
    let _ = field;
    let raw = include_str!("../../../verifier/fixtures/market-fixture.json");
    let needle = format!("\"{field}\": \"");
    let start = raw.find(&needle).expect("fixture contains field") + needle.len();
    let end = raw[start..].find('"').expect("fixture has closing quote") + start;
    ::std::string::String::from(raw[start..end].trim_start_matches("0x"))
}

fn fixture_next_tally_commitment(env: &Env) -> BytesN<32> {
    bytesn32(env, &fixture_hex("nextTallyCommitment"))
}

fn fixture_share_commitment_root(env: &Env) -> BytesN<32> {
    bytesn32(env, &fixture_hex("shareCommitmentRoot"))
}

fn fixture_no_commitment(env: &Env) -> BytesN<32> {
    bytesn32(env, &fixture_hex("noCommitment"))
}

fn fixture_no_nullifier(env: &Env) -> BytesN<32> {
    bytesn32(env, &fixture_hex("noNullifier"))
}

fn setup(
    oracle_price: i128,
    fee_bps: u32,
) -> (
    Env,
    BlindMarketClient<'static>,
    Address,
    Address,
    Address,
    Address,
    Address,
    Address,
    BytesN<32>,
    BytesN<32>,
    BytesN<32>,
    token::TokenClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().set(LedgerInfo {
        timestamp: 1_720_000_000,
        protocol_version: 26,
        sequence_number: 100,
        network_id: [0; 32],
        base_reserve: 10,
        min_temp_entry_ttl: 16,
        min_persistent_entry_ttl: 16,
        max_entry_ttl: 1_000,
    });

    let admin = Address::generate(&env);
    let creator = Address::generate(&env);
    let owner = Address::generate(&env);
    let shard_2 = Address::generate(&env);
    let shard_3 = Address::generate(&env);

    let stellar_asset = env.register_stellar_asset_contract_v2(admin.clone());
    let token_admin = token::StellarAssetClient::new(&env, &stellar_asset.address());
    let token_client = token::TokenClient::new(&env, &stellar_asset.address());
    token_admin.mint(&owner, &50_000_000);

    let oracle_id = env.register(TestOracle, ());
    let oracle_client = TestOracleClient::new(&env, &oracle_id);
    oracle_client.set_price(&oracle_price);

    let commit_verifier_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, COMMIT_VK),),
    );
    let tally_update_verifier_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, TALLY_UPDATE_VK),),
    );
    let claim_verifier_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, CLAIM_VK),),
    );
    let _ = UltraHonkVerifierContractClient::new(&env, &commit_verifier_id);
    let _ = UltraHonkVerifierContractClient::new(&env, &tally_update_verifier_id);
    let _ = UltraHonkVerifierContractClient::new(&env, &claim_verifier_id);

    let blind_market_id = env.register(BlindMarket, ());
    let client = BlindMarketClient::new(&env, &blind_market_id);
    client.initialize(&admin, &stellar_asset.address(), &oracle_id);
    client.set_verifiers(
        &admin,
        &commit_verifier_id,
        &tally_update_verifier_id,
        &tally_update_verifier_id,
        &claim_verifier_id,
    );
    client.set_shard_signers(&admin, &admin, &owner, &creator, &shard_2, &shard_3);

    let market_id = bytesn32(&env, MARKET_ID_HEX);
    let condition = OracleCondition {
        oracle_contract: oracle_id,
        asset_symbol: Symbol::new(&env, "BTC"),
        greater_or_equal: true,
        threshold: 100,
    };
    client.create_market(
        &creator,
        &market_id,
        &String::from_str(&env, "Will BTC be >= 100?"),
        &String::from_str(&env, "macro"),
        &OracleConditionsInput {
            condition_count: 1,
            condition_1: condition.clone(),
            condition_2: condition.clone(),
            condition_3: condition.clone(),
            condition_4: condition.clone(),
            condition_5: condition,
            operator_1_is_and: true,
            operator_2_is_and: true,
            operator_3_is_and: true,
            operator_4_is_and: true,
        },
        &(env.ledger().timestamp() + 300),
        &MIN_BET,
        &MAX_BET,
        &fee_bps,
    );

    let next_tally_commitment = fixture_next_tally_commitment(&env);
    let share_commitment_root = fixture_share_commitment_root(&env);

    (
        env,
        client,
        blind_market_id,
        owner,
        admin,
        creator,
        shard_2,
        shard_3,
        market_id,
        next_tally_commitment,
        share_commitment_root,
        token_client,
    )
}

#[test]
fn end_to_end_tally_finalize_and_claim_flow_works() {
    let (
        env,
        client,
        blind_market_id,
        owner,
        admin,
        _creator,
        shard_2,
        _shard_3,
        market_id,
        next_tally_commitment,
        share_commitment_root,
        token_client,
    ) = setup(150, 0);
    let commitment_yes = bytesn32(&env, COMMITMENT_YES_HEX);
    let commitment_no = fixture_no_commitment(&env);
    let nullifier_yes = bytesn32(&env, NULLIFIER_YES_HEX);
    let nullifier_no = fixture_no_nullifier(&env);

    client.commit_position(
        &market_id,
        &owner,
        &commitment_yes,
        &AMOUNT,
        &Bytes::from_slice(&env, COMMIT_PROOF_YES),
    );
    client.commit_position(
        &market_id,
        &owner,
        &commitment_no,
        &AMOUNT,
        &Bytes::from_slice(&env, COMMIT_PROOF_NO),
    );

    env.ledger().set_timestamp(env.ledger().timestamp() + 301);
    client.submit_private_tally(
        &market_id,
        &commitment_yes,
        &next_tally_commitment,
        &share_commitment_root,
        &Bytes::from_slice(&env, TALLY_UPDATE_PROOF),
    );

    let state = client.get_market_state(&market_id);
    assert_eq!(state.tallied_count, 1);
    assert_eq!(state.tallied_collateral_total, AMOUNT);
    assert_eq!(state.tally_commitment, next_tally_commitment);

    env.ledger().set_timestamp(env.ledger().timestamp() + 48 * 60 * 60 + 1);
    client.finalize_private_tally(
        &market_id,
        &AMOUNT,
        &0i128,
        &1u32,
        &next_tally_commitment,
        &admin,
        &owner,
        &shard_2,
    );

    let settled = client.get_market_state(&market_id);
    assert_eq!(settled.resolved, true);
    assert_eq!(settled.tally_finalized, true);
    assert_eq!(settled.distributable_pot, AMOUNT);
    assert_eq!(settled.treasury_amount, AMOUNT);
    assert_eq!(settled.missed_tally_collateral, AMOUNT);
    assert_eq!(settled.yes_total, AMOUNT);
    assert_eq!(settled.no_total, 0);
    assert_eq!(settled.winning_side_total, AMOUNT);

    let payout = client.claim_winnings(
        &market_id,
        &commitment_yes,
        &nullifier_yes,
        &owner,
        &Bytes::from_slice(&env, CLAIM_PROOF),
    );
    assert_eq!(payout, AMOUNT);

    let no_claim = client.try_claim_winnings(
        &market_id,
        &commitment_no,
        &nullifier_no,
        &owner,
        &Bytes::from_slice(&env, CLAIM_PROOF),
    );
    assert!(no_claim.is_err());

    assert_eq!(token_client.balance(&owner), 40_000_000);
    assert_eq!(token_client.balance(&admin), AMOUNT);
    assert_eq!(client.get_market_view(&market_id).state.tally_commitment, next_tally_commitment);

    env.as_contract(&blind_market_id, || {
        let commitments_key = symbol_short!("COMMITS");
        let commitments: soroban_sdk::Map<blind_market::CommitmentKey, blind_market::CommitmentRecord> =
            env.storage().instance().get(&commitments_key).unwrap();
        let yes_record = commitments
            .get(blind_market::CommitmentKey {
                market_id: market_id.clone(),
                commitment: commitment_yes.clone(),
            })
            .unwrap();
        let no_record = commitments
            .get(blind_market::CommitmentKey {
                market_id: market_id.clone(),
                commitment: commitment_no.clone(),
            })
            .unwrap();
        assert!(yes_record.tallied);
        assert!(!no_record.tallied);
    });
}

#[test]
fn finalization_rejects_before_deadline() {
    let (
        env,
        client,
        _blind_market_id,
        owner,
        admin,
        _creator,
        shard_2,
        _shard_3,
        market_id,
        next_tally_commitment,
        share_commitment_root,
        _token_client,
    ) = setup(150, 0);
    let commitment_yes = bytesn32(&env, COMMITMENT_YES_HEX);

    client.commit_position(
        &market_id,
        &owner,
        &commitment_yes,
        &AMOUNT,
        &Bytes::from_slice(&env, COMMIT_PROOF_YES),
    );

    let result = client.try_finalize_private_tally(
        &market_id,
        &AMOUNT,
        &0i128,
        &1u32,
        &next_tally_commitment,
        &admin,
        &owner,
        &shard_2,
    );
    assert!(result.is_err());

    env.ledger().set_timestamp(env.ledger().timestamp() + 301);
    client.submit_private_tally(
        &market_id,
        &commitment_yes,
        &next_tally_commitment,
        &share_commitment_root,
        &Bytes::from_slice(&env, TALLY_UPDATE_PROOF),
    );
    env.ledger().set_timestamp(env.ledger().timestamp() + 48 * 60 * 60 + 1);

    let wrong_signer = Address::generate(&env);
    let result = client.try_finalize_private_tally(
        &market_id,
        &AMOUNT,
        &0i128,
        &1u32,
        &next_tally_commitment,
        &wrong_signer,
        &owner,
        &shard_2,
    );
    assert!(result.is_err());
}

#[test]
fn submit_private_tally_rejects_tampered_share_root() {
    let (
        env,
        client,
        _blind_market_id,
        owner,
        _admin,
        _creator,
        _shard_2,
        _shard_3,
        market_id,
        next_tally_commitment,
        _share_commitment_root,
        _token_client,
    ) = setup(150, 0);
    let commitment_yes = bytesn32(&env, COMMITMENT_YES_HEX);
    let wrong_root = bytesn32(&env, "00000000000000000000000000000000000000000000000000000000000000ff");

    client.commit_position(
        &market_id,
        &owner,
        &commitment_yes,
        &AMOUNT,
        &Bytes::from_slice(&env, COMMIT_PROOF_YES),
    );
    env.ledger().set_timestamp(env.ledger().timestamp() + 301);

    let result = client.try_submit_private_tally(
        &market_id,
        &commitment_yes,
        &next_tally_commitment,
        &wrong_root,
        &Bytes::from_slice(&env, TALLY_UPDATE_PROOF),
    );
    assert!(result.is_err());
}
