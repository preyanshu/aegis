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
    let proof = bytes(&env, "/tmp/blindmarket-proof/default.proof.bin");
    let public_inputs = bytes(&env, "/tmp/blindmarket-proof/default.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    assert!(verifier.verify(&env, &proof, &public_inputs).is_err());
}

#[test]
fn generated_commit_keccak_proof() {
    let env = Env::default();
    let vk = bytes(&env, "verifier/commit_vk.bin");
    let proof = bytes(&env, "/tmp/blindmarket-proof/keccak.proof.bin");
    let public_inputs = bytes(&env, "/tmp/blindmarket-proof/keccak.pi.bin");

    let verifier = UltraHonkVerifier::new(&env, &vk).expect("vk parses");
    verifier
        .verify(&env, &proof, &public_inputs)
        .expect("keccak proof verifies");
}
