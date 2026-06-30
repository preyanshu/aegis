use dep::std::hash::poseidon2_permutation;

fn main(
    market_id: pub Field,
    final_tally_commitment: pub Field,
    outcome: pub Field,
    winning_side_total: pub Field,
    directions: [Field; 16],
    amounts: [Field; 16],
    salts: [Field; 16],
    included: [Field; 16],
) {
    assert(outcome * (outcome - 1) == 0, "outcome must be binary");

    let mut tally_commitment = 0;
    let mut yes_total = 0;
    let mut no_total = 0;

    for i in 0..16 {
        assert(included[i] * (included[i] - 1) == 0, "included must be binary");

        if included[i] == 1 {
            let side = directions[i];
            let amount = amounts[i];
            let salt = salts[i];

            assert(side * (side - 1) == 0, "direction must be binary");

            let commitment_state: [Field; 4] = poseidon2_permutation([market_id, side, amount, salt], 4);
            let commitment = commitment_state[0];

            let tally_state: [Field; 4] = poseidon2_permutation([tally_commitment, commitment, amount, side], 4);
            tally_commitment = tally_state[0];

            if side == 1 {
                yes_total += amount;
            } else {
                no_total += amount;
            }
        }
    }

    assert(tally_commitment == final_tally_commitment, "final tally commitment mismatch");

    let computed_winning_total = if outcome == 1 { yes_total } else { no_total };
    assert(computed_winning_total == winning_side_total, "winning total mismatch");
    assert(winning_side_total as u64 > 0, "winning total must be positive");
}
