import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TradeStore } from '../dashboard/store.js';

const t = (id, price = 100) => ({ tradeId: id, client: 'C1', symbol: 'TCS', side: 'BUY', quantity: 10, price, timestamp: '2026-01-01T00:00:00Z' });

test('upsert is idempotent and assigns monotonic ingestSeq', () => {
  const s = new TradeStore(null);
  const a = s.upsert([t('A'), t('B')]);
  assert.equal(a.inserted.length, 2);
  const b = s.upsert([t('A'), t('B'), t('C')]);
  assert.equal(b.inserted.length, 1);
  assert.equal(b.inserted[0].ingestSeq, 3);
  assert.equal(s.trades.size, 3);
});

test('since(seq) returns only the delta', () => {
  const s = new TradeStore(null);
  s.upsert([t('A'), t('B'), t('C'), t('D')]);
  assert.deepEqual(s.since(2).map((x) => x.tradeId), ['C', 'D']);
  assert.equal(s.since(0).length, 4);
  assert.equal(s.since(99).length, 0);
});

test('corrected trades are updated in place, not duplicated', () => {
  const s = new TradeStore(null);
  s.upsert([t('A', 100)]);
  const r = s.upsert([t('A', 101)]);
  assert.equal(r.inserted.length, 0);
  assert.equal(r.updated, 1);
  assert.equal(s.trades.get('A').price, 101);
});
