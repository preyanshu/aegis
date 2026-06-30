use dep::std::hash::poseidon2_permutation;

fn main(
    direction: Field,
    amount: pub Field,
    salt: Field,
    commitment: pub Field,
    market_id: pub Field,
    min_amount: pub Field,
    max_amount: pub Field,
) {
    let hash_state: [Field; 4] = poseidon2_permutation([market_id, direction, amount, salt], 4);
    let computed_commitment = hash_state[0];
    assert(computed_commitment == commitment, "commitment mismatch");

    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");

    assert(amount as u64 >= min_amount as u64, "bet below minimum");
    assert(amount as u64 <= max_amount as u64, "bet above maximum");
}
