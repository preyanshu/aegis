use dep::std::hash::poseidon2_permutation;

fn main(
    direction: pub Field,
    amount: pub Field,
    salt: Field,
    commitment: pub Field,
    outcome: pub Field,
    nullifier: pub Field,
) {
    let hash_state: [Field; 4] = poseidon2_permutation([direction, amount, salt, 0], 4);
    let computed_commitment = hash_state[0];
    assert(computed_commitment == commitment, "commitment mismatch");

    let nullifier_state: [Field; 4] = poseidon2_permutation([salt, 12345, 0, 0], 4);
    let computed_nullifier = nullifier_state[0];
    assert(computed_nullifier == nullifier, "nullifier mismatch");

    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");
    assert(direction == outcome, "only winning bets can claim");
}
