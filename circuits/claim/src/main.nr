use dep::std::hash::poseidon2_permutation;

fn main(
    direction: Field,
    amount: Field,
    salt: Field,
    commitment: pub Field,
    market_id: pub Field,
    outcome: pub Field,
    nullifier: pub Field,
    distributable_pot: pub Field,
    winning_side_total: pub Field,
    payout: pub Field,
) {
    let hash_state: [Field; 4] = poseidon2_permutation([market_id, direction, amount, salt], 4);
    let computed_commitment = hash_state[0];
    assert(computed_commitment == commitment, "commitment mismatch");

    let nullifier_state: [Field; 4] = poseidon2_permutation([market_id, salt, 12345, 0], 4);
    let computed_nullifier = nullifier_state[0];
    assert(computed_nullifier == nullifier, "nullifier mismatch");

    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");
    assert(direction == outcome, "only winning bets can claim");
    assert(winning_side_total as u64 > 0, "winning side total must be positive");
    assert((amount * distributable_pot) / winning_side_total == payout, "payout mismatch");
}
