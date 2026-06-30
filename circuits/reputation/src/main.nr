use dep::std::hash::poseidon2_permutation;

fn main(
    claim_type: pub Field,
    category_code: pub Field,
    window_days: pub Field,
    threshold_or_band: pub Field,
    subject: pub Field,
    snapshot_commitment: pub Field,
    metric_value: Field,
    eligible_count: Field,
    witness_secret: Field,
    peer_scores: [Field; 16],
    peer_eligible: [Field; 16],
) {
    let snapshot_hash: [Field; 4] = poseidon2_permutation(
        [subject, category_code, window_days, witness_secret],
        4,
    );
    assert(snapshot_hash[0] == snapshot_commitment, "snapshot mismatch");

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
}
