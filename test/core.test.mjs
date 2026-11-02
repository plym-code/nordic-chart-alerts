import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDate, updateState } from '../src/core.mjs';
const now = '2026-11-02T14:00:00.000Z';
test('date parsing rejects impossible dates', () => {
  assert.equal(parseDate('1 Nov 2026'), '2026-11-01');
  assert.equal(parseDate('30 Sept 2026'), '2026-09-30');
  assert.throws(() => parseDate('31 Feb 2026'));
});
test('baseline and repeated dates stay quiet', () => {
  const state = updateState({}, [{ code: 'se', date: '2026-11-01' }], now);
  assert.equal(state.pending.length, 0);
  assert.deepEqual(updateState(state, [{ code: 'se', date: '2026-11-01' }], now), state);
});
test('new date queues one update; later polls do not duplicate it', () => {
  const state = updateState({ markets: { se: { date: '2026-10-31' } } }, [{ code: 'se', date: '2026-11-01' }], now);
  assert.equal(state.pending.length, 1);
  assert.match(state.pending[0].subject, /updated/);
  assert.equal(updateState(state, [{ code: 'se', date: '2026-11-01' }], now).pending.length, 1);
});
test('missing or backwards dates cannot become chart update alerts', () => {
  const previous = { markets: { se: { date: '2026-11-01' } } };
  for (const observation of [{ code: 'se', error: 'CHART_DATE_UNAVAILABLE' }, { code: 'se', date: '2026-10-31' }]) {
    const state = updateState(previous, [observation], now);
    assert.equal(state.markets.se.date, '2026-11-01');
    assert.match(state.pending[0].subject, /needs attention/);
    assert.equal(updateState(state, [observation], now).pending.length, 1);
  }
});
