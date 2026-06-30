use soroban_sdk::{Bytes, Env};
use ultrahonk_verifier::UltraHonkVerifierContractClient;

const COMMIT_VK: &[u8] = include_bytes!("../../../verifier/commit_vk.bin");
const TALLY_UPDATE_VK: &[u8] = include_bytes!("../../../verifier/tally_update_vk.bin");
const TALLY_FINALIZE_VK: &[u8] = include_bytes!("../../../verifier/tally_finalize_vk.bin");
const COMMIT_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/commit.proof.bin");
const TALLY_UPDATE_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/tally_update.proof.bin");
const TALLY_FINALIZE_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/tally_finalize.proof.bin");
const COMMIT_PI: &[u8] = include_bytes!("../../../verifier/fixtures/commit.pi.bin");
const TALLY_UPDATE_PI: &[u8] = include_bytes!("../../../verifier/fixtures/tally_update.pi.bin");
const TALLY_FINALIZE_PI: &[u8] = include_bytes!("../../../verifier/fixtures/tally_finalize.pi.bin");
const CLAIM_PROOF: &[u8] = include_bytes!("../../../verifier/fixtures/claim.proof.bin");
const CLAIM_PI: &[u8] = include_bytes!("../../../verifier/fixtures/claim.pi.bin");

#[test]
fn verifier_contract_accepts_real_commit_fixture() {
    let env = Env::default();
    let contract_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, COMMIT_VK),),
    );
    let client = UltraHonkVerifierContractClient::new(&env, &contract_id);

    client.verify_proof(
        &Bytes::from_slice(&env, COMMIT_PI),
        &Bytes::from_slice(&env, COMMIT_PROOF),
    );
}

#[test]
fn verifier_contract_accepts_real_tally_update_fixture() {
    let env = Env::default();
    let contract_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, TALLY_UPDATE_VK),),
    );
    let client = UltraHonkVerifierContractClient::new(&env, &contract_id);

    client.verify_proof(
        &Bytes::from_slice(&env, TALLY_UPDATE_PI),
        &Bytes::from_slice(&env, TALLY_UPDATE_PROOF),
    );
}

#[test]
fn verifier_contract_accepts_real_tally_finalize_fixture() {
    let env = Env::default();
    let contract_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, TALLY_FINALIZE_VK),),
    );
    let client = UltraHonkVerifierContractClient::new(&env, &contract_id);

    client.verify_proof(
        &Bytes::from_slice(&env, TALLY_FINALIZE_PI),
        &Bytes::from_slice(&env, TALLY_FINALIZE_PROOF),
    );
}

#[test]
fn verifier_contract_rejects_wrong_fixture_for_vk() {
    let env = Env::default();
    let contract_id = env.register(
        ultrahonk_verifier::UltraHonkVerifierContract,
        (Bytes::from_slice(&env, COMMIT_VK),),
    );
    let client = UltraHonkVerifierContractClient::new(&env, &contract_id);

    let result = client.try_verify_proof(
        &Bytes::from_slice(&env, CLAIM_PI),
        &Bytes::from_slice(&env, CLAIM_PROOF),
    );

    assert!(result.is_err());
}
