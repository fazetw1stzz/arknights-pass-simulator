import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProbabilityGroups, hasCompleteRatings, percent, summarizeAdviceDisplay } from '../public/ui-utils.mjs';

const catalog = {
  roles: Array.from({ length: 7 }, (_, r) => ({ id: `r${r}`, name: String.fromCharCode(65 + r) })),
  items: Array.from({ length: 14 }, (_, i) => ({ id: `i${i}`, role_id: `r${Math.floor(i / 2)}` })),
};
const ratings = Object.fromEntries(catalog.items.map((item, i) => [item.id, i < 4 ? 0 : i < 8 ? 1 : i < 10 ? 2 : 3]));
const metadata = { kind: 'five_levels', ratings };
// Own E1 and F2 observed. Physical inventory and candidate identities are distinct.
const probabilities = catalog.items.map((item, i) => ({ item_id: item.id, p: i === 8 || i === 11 ? 0 : 1 / 12 }));
const sum = groups => groups.reduce((total, group) => total + group.p, 0);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} != ${b}`);

test('complete five-level metadata preserves true tier probabilities', () => {
  assert.equal(hasCompleteRatings(catalog, metadata), true);
  const result = buildProbabilityGroups(catalog, probabilities, 'preference', metadata);
  assert.equal(result.basis, 'tiers');
  assert.equal(result.note, '');
  assert.deepEqual(result.groups.map(group => group.count), [4, 4, 1, 3, 0]);
  result.groups.forEach((group, i) => close(group.p, [4 / 12, 4 / 12, 1 / 12, 3 / 12, 0][i]));
  close(sum(result.groups), 1);
});

test('missing, partial, invalid or explicit-value metadata never invents tier claims', () => {
  const partial = { ...ratings };
  delete partial.i13;
  const variants = [undefined, null, 'metadata', [], {}, { ratings },
    { kind: 'explicit_values', ratings }, { kind: 'five_levels', ratings: {} }, { kind: 'five_levels', ratings: partial },
    ...[-1, 5, 1.5, '0', null, true].map(value => ({ ...metadata, ratings: { ...ratings, i0: value } }))];
  for (const meta of variants) {
    assert.equal(hasCompleteRatings(catalog, meta), false);
    const result = buildProbabilityGroups(catalog, probabilities, 'preference', meta);
    assert.equal(result.basis, 'roles');
    assert.match(result.note, /档位信息不可用/);
    close(sum(result.groups), 1);
    assert.deepEqual(result.groups.map(group => group.count), [2, 2, 2, 2, 1, 1, 2]);
  }
});

test('strategic unequal probabilities are summed, not candidate-count ratios', () => {
  const unequal = catalog.items.map((item, i) => ({ item_id: item.id, p: i === 0 ? 0.6 : i === 4 ? 0.3 : i === 12 ? 0.1 : 0 }));
  const result = buildProbabilityGroups(catalog, unequal, 'preference', metadata);
  close(result.groups[0].p, 0.6);
  close(result.groups[1].p, 0.3);
  close(result.groups[3].p, 0.1);
  close(sum(result.groups), 1);
  assert.deepEqual(result.groups.map(group => group.count), [1, 1, 0, 1, 0]);
});

test('price mode groups by role; empty inventory stays zero and invalid probability throws', () => {
  const result = buildProbabilityGroups(catalog, probabilities, 'price', metadata);
  assert.equal(result.basis, 'roles');
  assert.equal(result.note, '');
  close(sum(result.groups), 1);
  const empty = buildProbabilityGroups(catalog, probabilities.map(row => ({ ...row, p: 0 })), 'preference', metadata);
  close(sum(empty.groups), 0);
  assert.equal(empty.groups.every(group => group.count === 0), true);
  for (const p of [NaN, Infinity, -0.1, 1.1, '0.1', null]) {
    assert.throws(() => buildProbabilityGroups(catalog, [{ item_id: 'i0', p }], 'price', {}), /概率无效/);
  }
});

test('probability formatting preserves zero and one without converting unknowns', () => {
  assert.equal(percent(0), '0.0%');
  assert.equal(percent(1), '100.0%');
  assert.equal(percent(1 / 6, 2), '16.67%');
  for (const value of [null, undefined, NaN, Infinity, -0.1, 1.1, '0.5']) assert.equal(percent(value), '—');
});

test('floating-point boundary noise clamps only within the engine EPS', () => {
  assert.equal(percent(1 + 2e-16), '100.0%');
  assert.equal(percent(-2e-16), '0.0%');
  assert.equal(percent(1 + 5e-10), '100.0%');
  assert.equal(percent(-5e-10), '0.0%');
  for (const p of [1 + 2e-9, -2e-9]) {
    assert.equal(percent(p), '—');
    assert.throws(() => buildProbabilityGroups(catalog, [{ item_id: 'i0', p }], 'preference', metadata), /概率无效/);
  }
  const certain = catalog.items.map((item, i) => ({ item_id: item.id, p: i === 0 ? 1 + 2e-16 : -2e-16 }));
  const grouped = buildProbabilityGroups(catalog, certain, 'preference', metadata);
  close(sum(grouped.groups), 1);
  assert.equal(percent(grouped.groups[0].p), '100.0%');
  const thirds = catalog.items.map((item, i) => ({ item_id: item.id, p: i < 3 ? 1 / 3 + Number.EPSILON : 0 }));
  const allTargets = buildProbabilityGroups(catalog, thirds, 'preference', metadata);
  assert.ok(allTargets.groups[0].p > 1);
  assert.equal(percent(allTargets.groups[0].p), '100.0%');
});

const advice = { action: 'buy', optimal_value: 100, risk: { next_target_probability: 0.5 }, comparison: null };

test('unverified mechanisms, prediction differences, action disagreement or zero targets stay amber', () => {
  for (const flag of ['unverified_behavior', 'predictive_differs', 'action_disagrees']) {
    const result = summarizeAdviceDisplay({ ...advice, comparison: { [flag]: true } });
    assert.equal(result.tone, 'amber');
    assert.ok(result.notes.length >= 2);
  }
  assert.equal(summarizeAdviceDisplay({ ...advice, risk: { next_target_probability: 0 } }).tone, 'amber');
  assert.equal(summarizeAdviceDisplay({ ...advice, risk: { next_target_probability: 1e-9 } }).tone, 'amber');
  assert.equal(summarizeAdviceDisplay({ ...advice, risk: {} }).tone, 'amber');
  assert.equal(summarizeAdviceDisplay(null).tone, 'amber');
});

test('economic action is preserved independently of a positive mean', () => {
  assert.equal(summarizeAdviceDisplay(advice).tone, 'positive');
  assert.equal(summarizeAdviceDisplay({ ...advice, comparison: { unverified_behavior: false, predictive_differs: false, action_disagrees: false } }).tone, 'positive');
  assert.equal(summarizeAdviceDisplay({ ...advice, action: 'stop', optimal_value: 100 }).tone, 'stop');
  assert.equal(summarizeAdviceDisplay({ ...advice, action: 'stop', comparison: { action_disagrees: true } }).tone, 'amber');
});
