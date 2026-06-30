use dep::std::hash::poseidon2_permutation;

fn main(
    direction: Field,
    amount: Field,
    salt: Field,
    yes_shares: [Field; 5],
    no_shares: [Field; 5],
    share_salts: [Field; 5],
    commitment: pub Field,
    market_id: pub Field,
    collateral_amount: pub Field,
    previous_tally_commitment: pub Field,
    next_tally_commitment: pub Field,
    share_commitment_root: pub Field,
) {
    let commitment_state: [Field; 4] = poseidon2_permutation([market_id, direction, amount, salt], 4);
    let computed_commitment = commitment_state[0];
    assert(computed_commitment == commitment, "commitment mismatch");

    assert(direction * (direction - 1) == 0, "direction must be 0 or 1");
    assert(amount == collateral_amount, "collateral amount mismatch");

    let tally_state: [Field; 4] = poseidon2_permutation(
        [previous_tally_commitment, commitment, collateral_amount, direction],
        4,
    );
    assert(tally_state[0] == next_tally_commitment, "tally commitment mismatch");

    let mut yes_sum = 0;
    let mut no_sum = 0;
    let mut root = 0;
    for i in 0..5 {
        yes_sum += yes_shares[i];
        no_sum += no_shares[i];

        let salt_state: [Field; 4] = poseidon2_permutation(
            [market_id, commitment, (i + 1) as Field, share_salts[i]],
            4,
        );
        let commitment_state: [Field; 4] = poseidon2_permutation(
            [salt_state[0], yes_shares[i], no_shares[i], 0],
            4,
        );
        let root_state: [Field; 4] = poseidon2_permutation(
            [root, commitment_state[0], (i + 1) as Field, 0],
            4,
        );
        root = root_state[0];
    }

    let expected_yes = direction * amount;
    let expected_no = (1 - direction) * amount;
    assert(yes_sum == expected_yes, "yes shares mismatch");
    assert(no_sum == expected_no, "no shares mismatch");
    assert(root == share_commitment_root, "share commitment root mismatch");
}
