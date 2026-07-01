global FOLD_MULTIPLIER: u128 = 1315423911;
global LIMB_MASK: u128 = ((1 as u128) << (62 as u8)) - 1;

fn field_to_limbs(value: Field) -> [u64; 4] {
    let bits: [u1; 248] = value.to_le_bits();
    let mut limbs = [0 as u64; 4];

    for limb_index in 0..4 {
        let mut limb = 0 as u64;
        for bit_index in 0..62 {
            let offset = limb_index * 62 + bit_index;
            limb += (bits[offset] as u64) << (bit_index as u8);
        }
        limbs[limb_index] = limb;
    }

    limbs
}

fn limbs_to_field(limbs: [u64; 4]) -> Field {
    let mut base = 1 as Field;
    for _ in 0..62 {
        base += base;
    }

    let base_squared = base * base;
    let base_cubed = base_squared * base;

    (limbs[0] as Field)
        + ((limbs[1] as Field) * base)
        + ((limbs[2] as Field) * base_squared)
        + ((limbs[3] as Field) * base_cubed)
}

fn combine_field_like(left: Field, right: Field) -> Field {
    let left_limbs = field_to_limbs(left);
    let right_limbs = field_to_limbs(right);
    let mut output = [0 as u64; 4];
    let mut carry = 0 as u128;

    for limb_index in 0..4 {
        let total = (left_limbs[limb_index] as u128 * FOLD_MULTIPLIER)
            + (right_limbs[limb_index] as u128)
            + carry;
        output[limb_index] = (total & LIMB_MASK) as u64;
        carry = total >> (62 as u8);
    }

    limbs_to_field(output)
}

fn fold_hash(values: [Field; 8]) -> Field {
    let mut acc = 0 as Field;
    for i in 0..8 {
        acc = combine_field_like(acc, values[i]);
    }
    acc
}

fn merkle_parent(left: Field, right: Field) -> Field {
    combine_field_like(left, right)
}

fn compute_metric(
    claim_type: Field,
    amounts: [Field; 16],
    payouts: [Field; 16],
    won_bits: [Field; 16],
    included: [Field; 16],
) -> Field {
    let mut participation = 0 as Field;
    let mut exposure = 0 as Field;
    let mut profit = 0 as Field;
    let mut wins = 0 as Field;

    for i in 0..16 {
        assert(included[i] * (included[i] - 1) == 0, "included must be binary");
        assert(won_bits[i] * (won_bits[i] - 1) == 0, "won bit must be binary");

        if included[i] == 1 {
            participation += 1;
            exposure += amounts[i];
            profit += payouts[i] - amounts[i];
            wins += won_bits[i];
        }
    }

    let mut metric = exposure;
    if claim_type == 0 {
        if exposure == 0 {
            metric = 0;
        } else {
            metric = (profit * 10000) / exposure;
        }
    } else if claim_type == 5 {
        if exposure == 0 {
            metric = 0;
        } else {
            metric = (profit * 10000) / exposure;
        }
    } else if claim_type == 1 {
        metric = profit;
    } else if claim_type == 2 {
        metric = 0;
        if participation != 0 {
            metric = (wins * 10000) / participation;
        }
    } else if claim_type == 3 {
        metric = participation;
    }

    metric
}

fn merkle_root_for_leaf(leaf: Field, siblings: [Field; 4], index: u32) -> Field {
    let mut current = leaf;
    let mut current_index = index;
    for depth in 0..4 {
        if current_index % 2 == 0 {
            current = merkle_parent(current, siblings[depth]);
        } else {
            current = merkle_parent(siblings[depth], current);
        }
        current_index /= 2;
    }
    current
}

fn main(
    claim_type: pub Field,
    category_code: pub Field,
    window_days: pub Field,
    threshold_or_band: pub Field,
    subject: pub Field,
    snapshot_root: pub Field,
    market_ids: [Field; 16],
    amounts: [Field; 16],
    payouts: [Field; 16],
    won_bits: [Field; 16],
    claimed_at: [Field; 16],
    record_salts: [Field; 16],
    included: [Field; 16],
    record_commitments: [Field; 16],
    merkle_siblings: [[Field; 4]; 16],
    leaf_indices: [Field; 16],
    metric_value: Field,
    eligible_count: Field,
    peer_scores: [Field; 16],
    peer_eligible: [Field; 16],
) {
    let metric = compute_metric(claim_type, amounts, payouts, won_bits, included);
    assert(metric == metric_value, "metric mismatch");

    for i in 0..16 {
        if included[i] == 1 {
            let commitment = fold_hash([
                subject,
                market_ids[i],
                category_code,
                amounts[i],
                payouts[i],
                won_bits[i],
                claimed_at[i],
                record_salts[i],
            ]);
            assert(commitment == record_commitments[i], "record commitment mismatch");
            let root = merkle_root_for_leaf(record_commitments[i], merkle_siblings[i], leaf_indices[i] as u32);
            assert(root == snapshot_root, "snapshot mismatch");
        }
    }

    if claim_type == 5 {
        assert(eligible_count as u64 > 0, "eligible set must be non-empty");

        let mut rank: u64 = 1;
        for i in 0..16 {
            assert(peer_eligible[i] * (peer_eligible[i] - 1) == 0, "peer eligibility must be binary");
            if peer_eligible[i] == 1 {
                if peer_scores[i] as u64 > metric_value as u64 {
                    rank += 1;
                }
            }
        }

        assert(rank * 100 <= (eligible_count as u64) * (threshold_or_band as u64), "percentile band failed");
    } else {
        assert(metric_value as u64 >= threshold_or_band as u64, "threshold failed");
    }

    let _ = window_days;
}
