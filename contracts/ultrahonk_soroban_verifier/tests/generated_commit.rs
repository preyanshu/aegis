use soroban_sdk::{Bytes, Env};
use std::path::PathBuf;
use ultrahonk_soroban_verifier::UltraHonkVerifier;

fn bytes(env: &Env, path: &str) -> Bytes {
    let path = if path.starts_with('/') {
        PathBuf::from(path)
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..").join(path)
    };
    Bytes::from_slice(env, &std::fs::read(&path).unwrap_or_else(|_| panic!("{path:?}")))
}

#[test]
fn generated_commit_default_proof_is_rejected_by_keccak_vk() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/commit_vk.bin");
    let proof = bytes(&env, "verifier/fixtures/claim.proof.bin");
    let public_inputs = bytes(&env, "verifier/fixtures/claim.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    assert!(verifier.verify(&env, &proof, &public_inputs).is_err());
}

#[test]
fn generated_commit_keccak_proof() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/commit_vk.bin");
    let proof = bytes(&env, "verifier/fixtures/commit.proof.bin");
    let public_inputs = bytes(&env, "verifier/fixtures/commit.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    verifier
        .verify(&env, &proof, &public_inputs)
        .expect("keccak proof verifies");
}

#[test]
fn generated_tally_update_keccak_proof() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/tally_update_vk.bin");
    let proof = bytes(&env, "verifier/fixtures/tally_update.proof.bin");
    let public_inputs = bytes(&env, "verifier/fixtures/tally_update.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    verifier
        .verify(&env, &proof, &public_inputs)
        .expect("keccak tally update proof verifies");
}

#[test]
fn generated_tally_finalize_keccak_proof() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/tally_finalize_vk.bin");
    let proof = bytes(&env, "verifier/fixtures/tally_finalize.proof.bin");
    let public_inputs = bytes(&env, "verifier/fixtures/tally_finalize.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    verifier
        .verify(&env, &proof, &public_inputs)
        .expect("keccak tally finalize proof verifies");
}

#[test]
fn generated_claim_keccak_proof() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/claim_vk.bin");
    let proof = bytes(&env, "verifier/fixtures/claim.proof.bin");
    let public_inputs = bytes(&env, "verifier/fixtures/claim.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    verifier
        .verify(&env, &proof, &public_inputs)
        .expect("keccak claim proof verifies");
}
