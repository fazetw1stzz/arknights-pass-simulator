// New v2 model acceptance checks plus complete JSON comparisons to the Python reference.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dispatch, MODEL_VERSION, SCHEMA_VERSION, EPS } from '../public/model.mjs';

const pythonReference = fileURLToPath(new URL('../reference_cli.py', import.meta.url));
const jsOnly = process.argv.includes('--js-only');
const items = Array.from({ length: 14 }, (_, index) => ({ id: `54-r${Math.floor(index / 2) + 1}-e${index % 2 + 1}`, role_id: `r${Math.floor(index / 2) + 1}` }));
const ids = items.map(item => item.id);
const catalog = { schema_version: 1, catalog_version: 'synthetic-54-v2-tests', box_id: '54.0', items };
const clone = value => JSON.parse(JSON.stringify(value));
const allValues = value => Object.fromEntries(ids.map(id => [id, value]));
const roleplayValues = Object.fromEntries(ids.map((id, i) => [id, [100, 100, 60, 60, 20, 0, 0][Math.floor(i / 2)]]));
const near = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= tolerance * Math.max(1, Math.abs(actual), Math.abs(expected)), `${actual} != ${expected}`);
function input(patch = {}) {
  return { session_id: 'v2-synthetic', box_id: '54.0', initial_remaining: 11, mode: 'preference', values: clone(roleplayValues),
    cost: 25, budget: null, packing_ack: true, valuation_meta: { kind: 'explicit_values', label: '中文偏好 / synthetic fixture, not empirical prices' },
    target_ids: ids.slice(0, 4), mechanism: { kind: 'random_removal' }, ...patch };
}
const requests = [];
function success(request, sourceCatalog = catalog) {
  const before = clone(request), result = dispatch(request, sourceCatalog);
  assert.deepEqual(request, before, 'Dispatch must never mutate the request or prior session.');
  requests.push({ catalog: clone(sourceCatalog), request: before, ok: true, result: clone(result) });
  return result;
}
function error(request, code, sourceCatalog = catalog) {
  const before = clone(request);
  assert.throws(() => dispatch(request, sourceCatalog), failure => failure.code === code, `expected ${code}`);
  assert.deepEqual(request, before, 'Failed dispatch must not mutate the request.');
  requests.push({ catalog: clone(sourceCatalog), request: before, ok: false, code });
}
const create = patch => success({ op: 'create', input: input(patch) });
const recommend = state => success({ op: 'recommend', state });
const record = (state, item_id, event_id = `event-${state.events.length}`) => success({ op: 'record', state, event_id, item_id });
let groups = 0;
function check(name, action) { action(); groups++; console.log(`ok ${groups} - ${name}`); }
function normalized(advice) {
  near(advice.probabilities.reduce((sum, row) => sum + row.p, 0), advice.actual_remaining > 0 ? 1 : 0);
  near(advice.probabilities.reduce((sum, row) => sum + row.presence_probability, 0), advice.actual_remaining);
  near(advice.risk.remaining_target_distribution.reduce((sum, row) => sum + row.p, 0), 1);
  near(advice.risk.outcome_distribution.reduce((sum, row) => sum + row.p, 0), 1);
  near(advice.risk.expected_additional_draws, advice.risk.outcome_distribution.reduce((sum, row) => sum + row.draws * row.p, 0));
  near(advice.risk.policy_future_hit_probability, advice.risk.outcome_distribution.filter(row => row.target_hits > 0).reduce((sum, row) => sum + row.p, 0));
  assert.ok(advice.risk.expected_additional_draws <= advice.max_future_draws + EPS);
  for (const row of advice.probabilities) assert.ok(row.p >= -EPS && row.presence_probability <= 1 + EPS);
  assert.ok(advice.risk.policy_future_hit_probability >= -EPS && advice.risk.policy_future_hit_probability <= advice.risk.fixed_all_remaining_hit_probability + EPS);
  assert.ok(advice.risk.net_utility_quantiles.p05 <= advice.risk.net_utility_quantiles.p50);
  assert.ok(advice.risk.net_utility_quantiles.p50 <= advice.risk.net_utility_quantiles.p95);
}

check('v2 preserves the two roleplay probability denominators and actual horizons', () => {
  let state = create();
  assert.equal(SCHEMA_VERSION, 2); assert.equal(state.model_version, MODEL_VERSION);
  state = record(state, ids[8], 'E1');
  const first = recommend(state); normalized(first);
  assert.equal(first.actual_remaining, 10); assert.equal(first.latent_count, 13); assert.equal(first.max_future_draws, 10);
  near(first.next_net, 335 / 13);
  state = record(state, ids[11], 'F2');
  const second = recommend(state); normalized(second);
  assert.equal(second.actual_remaining, 9); assert.equal(second.latent_count, 12); assert.equal(second.max_future_draws, 9);
  near(second.next_ev, 55); near(second.next_net, 30);
  for (const [value, expected] of [[100, 4/12], [60, 4/12], [20, 1/12], [0, 3/12]]) near(second.probabilities.filter(row => row.value === value).reduce((sum, row) => sum + row.p, 0), expected);
  assert.equal(second.comparison, null); assert.equal(second.method, 'exact_bitmask_belief_dp');
  assert.equal(second.stage1.probability_n, null); assert.equal(second.stage1.no_entry_probability, null);
});

check('synthetic screenshot values reproduce physical3 latent12 EV190/3 and future115', () => {
  // Explicit synthetic values satisfying the screenshot; not a reconstruction of the user's unknown stored valuations.
  const values = allValues(0);
  const levels = [200, 200, 120, 120, 0, 0, 120, 120, 0, 0, -60, -60, 0, 0];
  ids.forEach((id, i) => { values[id] = levels[i]; });
  let state = create({ initial_remaining: 5, values, target_ids: ids.slice(0, 2) });
  state = record(state, ids[4], 'observed-one'); state = record(state, ids[13], 'observed-two');
  const advice = recommend(state); normalized(advice);
  assert.equal(advice.actual_remaining, 3); assert.equal(advice.latent_count, 12); assert.equal(advice.unknown_removed, 9); assert.equal(advice.max_future_draws, 3);
  near(advice.spent, 50); near(advice.next_ev, 190/3); near(advice.next_net, 115/3); near(advice.optimal_value, 115);
  near(advice.risk.next_target_probability, 1/6); near(advice.risk.remaining_zero_target_probability, 6/11);
  near(advice.risk.fixed_all_remaining_hit_probability, 5/11); near(advice.risk.policy_future_hit_probability, 5/11);
  near(advice.risk.expected_additional_draws, 3); near(advice.risk.expected_additional_spend, 75);
});

check('a one-draw horizon cannot become fourteen draws or an unobservable oracle', () => {
  const values = allValues(0); values[ids[0]] = 100;
  const advice = recommend(create({ initial_remaining: 1, values, cost: 10, target_ids: [ids[0]] })); normalized(advice);
  assert.equal(advice.max_future_draws, 1); near(advice.next_ev, 50/7); near(advice.q_buy, -20/7);
  assert.equal(advice.action, 'stop'); assert.equal(advice.optimal_value, 0);
  near(advice.risk.policy_future_hit_probability, 0); near(advice.risk.policy_final_no_target_probability, 1);
  near(advice.risk.expected_additional_spend, 0); near(advice.risk.fixed_all_remaining_hit_probability, 1/14);
  assert.deepEqual(advice.risk.net_utility_quantiles, { p05: 0, p50: 0, p95: 0 });
});

check('public adaptive policy terminal risks match an independent exact two-draw example', () => {
  const values = allValues(0); values[ids[0]] = 140;
  const initial = create({ initial_remaining: 14, values, cost: 10, budget: 20, target_ids: [ids[0]] });
  const advice = recommend(initial); normalized(advice);
  near(advice.next_net, 0); near(advice.q_buy, 5/7); near(advice.optimal_value, 5/7); assert.equal(advice.action, 'buy');
  near(advice.risk.expected_additional_draws, 27/14); near(advice.risk.expected_additional_spend, 135/7);
  near(advice.risk.policy_future_hit_probability, 1/7); near(advice.risk.policy_final_no_target_probability, 6/7); near(advice.risk.policy_loss_probability, 6/7);
  assert.deepEqual(advice.risk.net_utility_quantiles, { p05: -20, p50: -20, p95: 130 });
  near(advice.risk.net_utility_min, -20); near(advice.risk.net_utility_max, 130);
  const outcomes = advice.risk.outcome_distribution;
  assert.deepEqual(outcomes.map(row => [row.draws, row.target_hits]), [[1, 1], [2, 0], [2, 1]]);
  near(outcomes[0].p, 1/14); near(outcomes[1].p, 6/7); near(outcomes[2].p, 1/14);
  const afterHit = recommend(record(initial, ids[0], 'hit')); normalized(afterHit);
  assert.equal(afterHit.risk.already_observed_target_count, 1); near(afterHit.risk.policy_future_hit_probability, 0); near(afterHit.risk.policy_final_no_target_probability, 0);
  assert.deepEqual(afterHit.risk.net_utility_quantiles, { p05: 0, p50: 0, p95: 0 }); near(afterHit.spent, 10);
  const afterMiss = recommend(record(initial, ids[1], 'miss')); near(afterMiss.q_buy, 10/13);
});

check('single predecessor target removed before stopping has zero posterior presence', () => {
  const mechanism = { kind: 'target_stop', target_ids: [ids[0]], hit_limit: 1, max_draws: 14 };
  const values = allValues(100);
  const state = create({ initial_remaining: 4, values, cost: 25, budget: 25, mechanism, target_ids: [ids[0]] });
  const advice = recommend(state); normalized(advice);
  near(advice.stage1.probability_n, 1/14); near(advice.stage1.empty_probability, 1/14); near(advice.stage1.nonempty_probability, 13/14);
  assert.equal(advice.stage1.no_entry_probability, 0); assert.equal(advice.stage1.conditional_support, 715);
  near(advice.probabilities[0].p, 0); near(advice.probabilities[0].presence_probability, 0); assert.equal(advice.possible_count, 13);
  assert.equal(advice.action, 'buy'); near(advice.risk.next_target_probability, 0); near(advice.risk.remaining_zero_target_probability, 1);
  near(advice.risk.fixed_all_remaining_hit_probability, 0); near(advice.risk.policy_final_no_target_probability, 1);
  assert.equal(advice.comparison.predictive_differs, true); assert.equal(advice.comparison.unverified_behavior, true);
  error({ op: 'create', input: input({ initial_remaining: 14, mechanism }) }, 'UNSUPPORTED_N');
  error({ op: 'record', state, event_id: 'impossible-A', item_id: ids[0] }, 'UNSUPPORTED_OBSERVATION');
  const tampered = clone(state); tampered.events.push({ event_id: 'impossible-A', item_id: ids[0], status: 'undone' });
  error({ op: 'restore', payload: tampered }, 'UNSUPPORTED_OBSERVATION');
});

check('cap-induced residual weights and Bayesian update are not uniform masks', () => {
  const mechanism = { kind: 'target_stop', target_ids: [ids[0]], hit_limit: 1, max_draws: 2 };
  let state = create({ initial_remaining: 12, mechanism, budget: 25, target_ids: [ids[0]] });
  const first = recommend(state); normalized(first);
  near(first.stage1.probability_n, 13/14); assert.equal(first.stage1.conditional_support, 91);
  near(first.probabilities[0].p, 1/13); near(first.probabilities[0].presence_probability, 12/13);
  for (const row of first.probabilities.slice(1)) near(row.p, 12/169);
  near(first.risk.remaining_zero_target_probability, 1/13);
  state = record(state, ids[1], 'non-A'); const second = recommend(state); normalized(second);
  near(second.probabilities[0].p, 1/12); assert.equal(second.stage1.conditional_support, 91);
  assert.equal(second.reason, 'budget'); near(second.risk.policy_future_hit_probability, 0);
  const n13 = recommend(create({ initial_remaining: 13, mechanism, budget: 25 }));
  near(n13.stage1.probability_n, 1/14); assert.equal(n13.stage1.conditional_support, 1); near(n13.probabilities[0].p, 0);
  error({ op: 'create', input: input({ initial_remaining: 11, mechanism }) }, 'UNSUPPORTED_N');
});

check('same-N first-target, all-target and random-removal priors differ exactly', () => {
  const targets = ids.slice(0, 2), shared = { initial_remaining: 4, target_ids: targets, budget: 25 };
  const first = recommend(create({ ...shared, mechanism: { kind: 'target_stop', target_ids: targets, hit_limit: 1, max_draws: 14 } }));
  const all = recommend(create({ ...shared, mechanism: { kind: 'target_stop', target_ids: targets, hit_limit: 2, max_draws: 14 } }));
  const baseline = recommend(create(shared));
  normalized(first); normalized(all); normalized(baseline);
  near(first.stage1.probability_n, 4/91); assert.equal(first.stage1.conditional_support, 440);
  near(first.risk.next_target_probability, 1/4); near(first.risk.remaining_zero_target_probability, 0); near(first.risk.fixed_all_remaining_hit_probability, 1);
  near(all.stage1.probability_n, 9/91); assert.equal(all.stage1.conditional_support, 495);
  near(all.risk.next_target_probability, 0); near(all.risk.remaining_zero_target_probability, 1); near(all.risk.fixed_all_remaining_hit_probability, 0);
  assert.equal(baseline.stage1.conditional_support, 1001);
  for (const [index, expected] of [495/1001, 440/1001, 66/1001].entries()) near(baseline.risk.remaining_target_distribution[index].p, expected);
  near(baseline.risk.fixed_all_remaining_hit_probability, 506/1001);
});

check('assumed predecessor behavior can reverse the actionable recommendation', () => {
  const values = allValues(0); values[ids[0]] = 1400;
  const advice = recommend(create({ initial_remaining: 4, values, target_ids: [ids[0]], budget: 25,
    mechanism: { kind: 'target_stop', target_ids: [ids[0]], hit_limit: 1, max_draws: 14 } }));
  assert.equal(advice.action, 'stop'); assert.equal(advice.comparison.baseline.action, 'buy'); assert.equal(advice.comparison.action_disagrees, true);
  assert.equal(advice.comparison.predictive_differs, true); assert.equal(advice.comparison.unverified_behavior, true);
});

check('stage-one N frequencies sum to one and impossible combinations fail after observations', () => {
  let firstMass = 0, allMass = 0;
  for (let n = 1; n <= 13; n++) {
    const advice = recommend(create({ initial_remaining: n, budget: 0, mechanism: { kind: 'target_stop', target_ids: ids.slice(0, 2), hit_limit: 1, max_draws: 14 } }));
    near(advice.stage1.probability_n, n/91); firstMass += advice.stage1.probability_n;
  }
  for (let n = 0; n <= 12; n++) {
    const advice = recommend(create({ initial_remaining: n, budget: 0, mechanism: { kind: 'target_stop', target_ids: ids.slice(0, 2), hit_limit: 2, max_draws: 14 } }));
    near(advice.stage1.probability_n, (13-n)/91); allMass += advice.stage1.probability_n;
  }
  near(firstMass, 1); near(allMass, 1);
  const mechanism = { kind: 'target_stop', target_ids: ids.slice(0, 2), hit_limit: 1, max_draws: 14 };
  const state = record(create({ initial_remaining: 13, mechanism }), ids[0], 'possible-A');
  const advice = recommend(state); near(advice.probabilities[1].p, 0); normalized(advice);
  error({ op: 'record', state, event_id: 'incompatible-B', item_id: ids[1] }, 'UNSUPPORTED_OBSERVATION');
  const undoImpossible = clone(state); undoImpossible.events.push({ event_id: 'incompatible-B', item_id: ids[1], status: 'undone' });
  error({ op: 'restore', payload: undoImpossible }, 'UNSUPPORTED_OBSERVATION');
});

check('fixed draws has a deterministic N frequency and baseline-equivalent conditional belief', () => {
  for (const draws of [0, 9, 14]) {
    const advice = recommend(create({ initial_remaining: 14 - draws, budget: 25, mechanism: { kind: 'fixed_draws', draws } })); normalized(advice);
    near(advice.stage1.probability_n, 1); near(advice.stage1.no_entry_probability, draws === 0 ? 1 : 0);
    near(advice.stage1.empty_probability, draws === 14 ? 1 : 0); near(advice.stage1.nonempty_probability, draws === 14 ? 0 : 1);
    assert.equal(advice.comparison.predictive_differs, false); assert.equal(advice.comparison.action_disagrees, false);
  }
  error({ op: 'create', input: input({ initial_remaining: 4, mechanism: { kind: 'fixed_draws', draws: 9 } }) }, 'UNSUPPORTED_N');
  const noEntry = recommend(create({ initial_remaining: 14, budget: 0, mechanism: { kind: 'target_stop', target_ids: [ids[0]], hit_limit: 1, max_draws: 0 } }));
  near(noEntry.stage1.probability_n, 1); near(noEntry.stage1.no_entry_probability, 1); near(noEntry.stage1.empty_probability, 0);
});

check('target definitions change risk only and never masquerade as predecessor targets', () => {
  const mechanism = { kind: 'target_stop', target_ids: ids.slice(0, 2), hit_limit: 2, max_draws: 14 };
  const a = recommend(create({ initial_remaining: 4, budget: 25, mechanism, target_ids: ids.slice(0, 2) }));
  const b = recommend(create({ initial_remaining: 4, budget: 25, mechanism, target_ids: [ids[13]] }));
  near(a.optimal_value, b.optimal_value); near(a.next_ev, b.next_ev); assert.equal(a.action, b.action);
  assert.notEqual(a.risk.next_target_probability, b.risk.next_target_probability);
});

check('neutral and signed utilities stop safely; zero budgets retain physical risk', () => {
  for (const value of [0, -30]) {
    const advice = recommend(create({ values: allValues(value), initial_remaining: 3 })); normalized(advice);
    assert.equal(advice.action, 'stop'); near(advice.optimal_value, 0); near(advice.risk.expected_additional_draws, 0); near(advice.risk.policy_loss_probability, 0);
  }
  for (const budget of [0, 24.99]) {
    const state = create({ values: allValues(100), budget });
    const advice = recommend(state); normalized(advice);
    assert.equal(advice.reason, 'budget'); assert.equal(advice.q_buy, null); near(advice.next_ev, 100);
    near(advice.risk.expected_additional_spend, 0); near(advice.risk.fixed_all_remaining_cost, 275);
    error({ op: 'record', state, event_id: 'unaffordable', item_id: ids[0] }, 'BUDGET');
  }
});

check('no implicit cap, safe physical exhaustion, cents, and tie convention remain', () => {
  const full = recommend(create({ initial_remaining: 14, values: allValues(100) })); normalized(full);
  assert.equal(full.max_future_draws, 14); near(full.optimal_value, 1050); near(full.risk.expected_additional_spend, 350);
  const tie = recommend(create({ values: allValues(25), budget: 25 })); assert.equal(tie.reason, 'tie'); near(tie.risk.expected_additional_draws, 0);
  let state = create({ initial_remaining: 14, values: allValues(1), cost: 0.1, budget: 0.3 });
  assert.equal(recommend(state).max_future_draws, 3);
  for (let i = 0; i < 3; i++) state = record(state, ids[i]);
  const emptyBudget = recommend(state); assert.equal(emptyBudget.reason, 'budget'); assert.equal(emptyBudget.remaining_budget, 0); near(emptyBudget.spent, 0.3);
  let last = create({ initial_remaining: 1 }); last = record(last, ids[0]);
  const empty = recommend(last); normalized(empty); assert.equal(empty.reason, 'empty'); assert.equal(empty.next_ev, null); assert.equal(empty.q_buy, null);
  error({ op: 'record', state: last, event_id: 'one-too-many', item_id: ids[1] }, 'EMPTY');
  const zero = recommend(create({ initial_remaining: 0 })); normalized(zero); assert.equal(zero.stage1.conditional_support, 1);
});

check('EPS tie-stop is consistent between continuation value, action and policy risk', () => {
  const advice = recommend(create({ initial_remaining: 2, values: allValues(1 + 6e-10), cost: 1 }));
  assert.equal(advice.action, 'stop'); assert.equal(advice.reason, 'tie'); assert.equal(advice.optimal_value, 0);
  near(advice.q_buy, 6e-10); assert.equal(advice.risk.expected_additional_draws, 0);
  assert.deepEqual(advice.risk.net_utility_quantiles, { p05: 0, p50: 0, p95: 0 });
});

check('safe-cent limits use exact canonical decimal cents, not binary multiply rounding', () => {
  const advice = recommend(create({ initial_remaining: 2, cost: 45035996273704.95, budget: 90071992547409.9, values: allValues(1e14) }));
  assert.equal(advice.max_future_draws, 2); near(advice.risk.expected_additional_draws, 2); near(advice.risk.expected_additional_spend, 90071992547409.9);
  error({ op: 'create', input: input({ cost: 90071992547410 }) }, 'INVALID_COST');
});

check('all-target strategic probabilities stay strictly within zero and one', () => {
  const values = Object.fromEntries(ids.map((id, index) => [id, 17 * index + 2]));
  const advice = recommend(create({ initial_remaining: 5, values, cost: 1, budget: 3, target_ids: ids,
    mechanism: { kind: 'target_stop', target_ids: ids.slice(0, 7), hit_limit: 3, max_draws: 14 } }));
  normalized(advice);
  const risk = advice.risk;
  for (const field of ['next_target_probability', 'remaining_zero_target_probability', 'fixed_all_remaining_hit_probability', 'policy_future_hit_probability', 'policy_final_no_target_probability', 'policy_loss_probability']) {
    assert.ok(risk[field] >= 0 && risk[field] <= 1, `${field} escaped [0,1]: ${risk[field]}`);
  }
  for (const row of [...advice.probabilities, ...risk.remaining_target_distribution, ...risk.outcome_distribution]) assert.ok(row.p >= 0 && row.p <= 1);
  near(risk.next_target_probability, 1); near(risk.policy_future_hit_probability, 1); assert.equal(risk.policy_final_no_target_probability, 0);
});

check('event retries, conflicts, undo tombstones, restore and v1 rejection are explicit', () => {
  let state = create({ initial_remaining: 3 }); state = record(state, ids[0], 'one'); state = record(state, ids[1], 'two');
  assert.deepEqual(record(state, ids[1], 'two'), state);
  error({ op: 'record', state, event_id: 'two', item_id: ids[2] }, 'EVENT_CONFLICT');
  error({ op: 'record', state, event_id: 'duplicate', item_id: ids[0] }, 'DUPLICATE_ITEM');
  const undone = success({ op: 'undo', state, event_id: 'two' });
  assert.deepEqual(success({ op: 'undo', state: undone, event_id: 'two' }), undone);
  assert.deepEqual(record(undone, ids[1], 'two'), undone);
  assert.deepEqual(success({ op: 'restore', payload: JSON.stringify(undone) }), undone);
  const corrected = record(undone, ids[1], 'corrected'); assert.equal(recommend(corrected).own_draw_count, 2);
  error({ op: 'undo', state, event_id: '' }, 'INVALID_INPUT'); error({ op: 'undo', state, event_id: 'missing' }, 'UNKNOWN_EVENT');
  const v1 = clone(state); v1.schema_version = 1; v1.model_version = 'random-removal-items-v1'; delete v1.config.target_ids; delete v1.config.mechanism;
  error({ op: 'restore', payload: v1 }, 'VERSION_MISMATCH');
  const bad = clone(state); bad.catalog_version = 'unknown'; error({ op: 'restore', payload: bad }, 'VERSION_MISMATCH');
  const extra = clone(state); extra.true_hidden_mask = 3; error({ op: 'restore', payload: extra }, 'INVALID_SESSION');
  error({ op: 'recommend', state, true_hidden_mask: 3 }, 'INVALID_INPUT');
  const zeroBudget = create({ budget: 0 }); zeroBudget.events.push({ event_id: 'not-affordable-ever', item_id: ids[0], status: 'undone' });
  error({ op: 'restore', payload: zeroBudget }, 'INVALID_SESSION');
  const duplicate = clone(state); duplicate.events.push({ event_id: 'impossible-tombstone', item_id: ids[0], status: 'undone' });
  error({ op: 'restore', payload: duplicate }, 'DUPLICATE_ITEM');
});

check('five-level immutable snapshot must agree with values; arbitrary values need explicit metadata', () => {
  const weights = [100, 60, 20, 0, -30], willingness = 200;
  const ratings = Object.fromEntries(ids.map((id, i) => [id, i % 5]));
  const values = Object.fromEntries(ids.map(id => [id, willingness * weights[ratings[id]] / weights[0]]));
  const metadata = { kind: 'five_levels', weights, willingness, ratings };
  const state = create({ values, valuation_meta: metadata, budget: 25 }); normalized(recommend(state));
  const mismatch = input({ values: clone(values), valuation_meta: metadata }); mismatch.values[ids[0]] += 1;
  error({ op: 'create', input: mismatch }, 'VALUATION_MISMATCH');
  for (const valuation_meta of [{}, { kind: 'legacy' }, { kind: 'prices' }, { ...metadata, weights: [100, 60] }, { ...metadata, willingness: -1 }]) error({ op: 'create', input: input({ values, valuation_meta }) }, 'INVALID_VALUATION_METADATA');
  const incomplete = clone(metadata); delete incomplete.ratings[ids[0]];
  error({ op: 'create', input: input({ values, valuation_meta: incomplete }) }, 'INVALID_VALUATION_METADATA');
  const extra = clone(metadata); extra.ratings.unknown = 0;
  error({ op: 'create', input: input({ values, valuation_meta: extra }) }, 'INVALID_VALUATION_METADATA');
  const inconsistentRestore = clone(state); inconsistentRestore.config.values[ids[0]] += 1;
  error({ op: 'restore', payload: inconsistentRestore }, 'VALUATION_MISMATCH');
  normalized(recommend(create({ mode: 'price', values: allValues(100), valuation_meta: { kind: 'prices' }, budget: 25 })));
  error({ op: 'create', input: input({ mode: 'price', valuation_meta: { kind: 'explicit_values' } }) }, 'INVALID_VALUATION_METADATA');
});

check('invalid price, money, mechanisms, targets, catalog and extra request fields are rejected', () => {
  for (const unknown of [null, '']) {
    const values = allValues(100); values[ids[0]] = unknown;
    error({ op: 'create', input: input({ mode: 'price', values, valuation_meta: { kind: 'prices' } }) }, 'UNKNOWN_PRICE');
  }
  const missing = allValues(100); delete missing[ids[0]];
  error({ op: 'create', input: input({ mode: 'price', values: missing, valuation_meta: { kind: 'prices' } }) }, 'UNKNOWN_PRICE');
  for (const target_ids of [[], [ids[0], ids[0]], null]) error({ op: 'create', input: input({ target_ids }) }, 'INVALID_INPUT');
  error({ op: 'create', input: input({ target_ids: ['unknown'] }) }, 'UNKNOWN_ITEM');
  for (const mechanism of [{}, { kind: 'unknown' }, { kind: 'fixed_draws', draws: -1 }, { kind: 'fixed_draws', draws: 1, extra: true }, { kind: 'target_stop', target_ids: [], hit_limit: 1, max_draws: 14 }, { kind: 'target_stop', target_ids: [ids[0]], hit_limit: 2, max_draws: 14 }]) error({ op: 'create', input: input({ mechanism }) }, 'INVALID_INPUT');
  for (const cost of [0, -1, 1.001, '25']) error({ op: 'create', input: input({ cost }) }, 'INVALID_COST');
  for (const budget of [-1, 1.001, '25']) error({ op: 'create', input: input({ budget }) }, 'INVALID_BUDGET');
  error({ op: 'create', input: input({ box_id: 'missing' }) }, 'UNKNOWN_BOX');
  error({ op: 'create', input: input({ packing_ack: false }) }, 'PACKING_ACK_REQUIRED');
  for (const initial_remaining of [-1, 15, 1.5]) error({ op: 'create', input: input({ initial_remaining }) }, 'INVALID_INPUT');
  const badCatalog = clone(catalog); badCatalog.items.pop(); error({ op: 'create', input: input() }, 'INVALID_CATALOG', badCatalog);
  error({ op: 'create', input: input(), true_hidden_mask: 1 }, 'INVALID_INPUT');
});

let seed = 982451653;
const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
check('sixteen deterministic strategic and baseline histories retain normalization and full JSON parity', () => {
  for (let index = 0; index < 16; index++) {
    const values = Object.fromEntries(ids.map(id => [id, Math.floor(random() * 181) - 60]));
    const initial = 4 + Math.floor(random() * 7), target_ids = ids.filter((_, i) => i % 3 === index % 3);
    const mechanism = index % 2 ? { kind: 'target_stop', target_ids: ids.slice(0, 3), hit_limit: 1 + index % 3, max_draws: 14 } : { kind: 'random_removal' };
    let state = create({ session_id: `varied-v2-${index}`, values, initial_remaining: initial, budget: 37.5, cost: 12.5, target_ids, mechanism });
    let advice = recommend(state); normalized(advice);
    for (let draw = 0; draw < Math.min(index % 3, initial, 2); draw++) {
      const possible = advice.probabilities.filter(row => row.p > EPS);
      state = record(state, possible[Math.floor(random() * possible.length)].item_id, `varied-${draw}`);
      advice = recommend(state); normalized(advice);
    }
  }
});

function equivalent(actual, expected, path = 'result') {
  if (typeof expected === 'number') { assert.equal(typeof actual, 'number', path); near(actual, expected); return; }
  if (expected === null || typeof expected !== 'object') { assert.equal(actual, expected, path); return; }
  if (Array.isArray(expected)) { assert.ok(Array.isArray(actual), path); assert.equal(actual.length, expected.length, path); expected.forEach((value, index) => equivalent(actual[index], value, `${path}[${index}]`)); return; }
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), `${path} keys`);
  for (const [key, value] of Object.entries(expected)) equivalent(actual[key], value, `${path}.${key}`);
}
if (!jsOnly) {
  assert.ok(existsSync(pythonReference), 'Python reference_cli.py must exist.');
  for (const [index, entry] of requests.entries()) {
    const run = spawnSync(process.env.PYTHON || 'python', ['-B', pythonReference], { input: JSON.stringify({ catalog: entry.catalog, request: entry.request }), encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 8 * 2 ** 20 });
    assert.equal(run.status, 0, `Python transport case ${index}: ${run.stderr}`);
    let reference;
    try { reference = JSON.parse(run.stdout.trim()); } catch { throw new Error(`Non-JSON Python case ${index}: ${run.stdout}`); }
    assert.equal(reference.ok, entry.ok, `Python status case ${index}: ${JSON.stringify(reference)}`);
    if (entry.ok) equivalent(entry.result, reference.result, `case ${index}`);
    else assert.equal(reference.error.code, entry.code, `Python error case ${index}: ${JSON.stringify(reference)}`);
  }
  console.log(`Python/JavaScript v2 parity passed for ${requests.length} complete JSON operations.`);
} else console.log('JS-only checks passed; Python parity has not been run in this mode.');
console.log(`${groups} new v2 JavaScript behavioral groups passed.`);
