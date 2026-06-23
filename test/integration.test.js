import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('BlindMarket scaffold', () => {
  it('documents that live integration tests need Stellar testnet credentials', () => {
    assert.equal(process.env.MARKET_CONTRACT_ID?.startsWith('C') ?? false, false);
  });
});
