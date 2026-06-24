import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('BlindMarket scaffold', () => {
  it('detects the configured live testnet market when present', () => {
    if (!process.env.MARKET_CONTRACT_ID) {
      return;
    }

    assert.equal(process.env.MARKET_CONTRACT_ID.startsWith('C'), true);
  });
});
