/** Exact residual-box belief model. Pure JSON functions; no I/O, RNG or hidden state. */
export const SCHEMA_VERSION = 2;
export const MODEL_VERSION = 'residual-items-v2';
export const EPS = 1e-9;
const SIZE = 1 << 14, FULL = SIZE - 1;
const COUNTS = new Uint8Array(SIZE);
for (let mask = 1; mask < SIZE; mask++) COUNTS[mask] = COUNTS[mask >> 1] + (mask & 1);
const PRIOR_CACHE = new Map();
const ASSUMPTIONS = [
  'One copy of each of 14 variants is an unverified packing assumption.',
  'Uniform draws without replacement; the supplied mechanism is an assumption, not observed behavior.',
  'Item utilities are additive and fixed; cost and utility share one scale.',
  'Budget is personal and does not recycle item utility.',
  'Policy risk follows the public-belief optimal policy; no hidden-composition oracle or Monte Carlo.',
  'Force-all risk assumes enough budget to draw the entire physical remainder.',
];

export class ModelError extends Error {
  constructor(code, message) { super(message); this.name = 'ModelError'; this.code = code; }
}
const fail = (code, message) => { throw new ModelError(code, message); };
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const exactKeys = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const SESSION_KEYS = ['schema_version', 'model_version', 'catalog_version', 'session_id', 'config', 'events'];
const CONFIG_KEYS = ['box_id', 'initial_remaining', 'mode', 'values', 'cost', 'budget', 'packing_ack', 'valuation_meta', 'target_ids', 'mechanism'];
const INPUT_KEYS = ['session_id', ...CONFIG_KEYS];

function jsonClone(value, code = 'INVALID_INPUT') {
  const seen = new Set();
  const walk = current => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') return;
    if (typeof current === 'number') { if (!Number.isFinite(current)) fail(code, 'JSON numbers must be finite.'); return; }
    if (typeof current !== 'object' || (!Array.isArray(current) && !plain(current)) || seen.has(current)) fail(code, 'Expected finite JSON data.');
    seen.add(current); for (const part of Object.values(current)) walk(part); seen.delete(current);
  };
  walk(value);
  return JSON.parse(JSON.stringify(value));
}

function catalogInfo(catalog) {
  if (!plain(catalog) || catalog.schema_version !== 1 || !nonempty(catalog.catalog_version)
      || catalog.box_id !== '54.0' || !Array.isArray(catalog.items) || catalog.items.length !== 14) {
    fail('INVALID_CATALOG', 'Expected a schema-1 versioned 54.0 catalog with fourteen variants.');
  }
  const ids = catalog.items.map(item => plain(item) ? item.id : null);
  if (ids.some(id => !nonempty(id)) || new Set(ids).size !== 14) fail('INVALID_CATALOG', 'Catalog item IDs must be unique nonempty strings.');
  return { ids, version: catalog.catalog_version, boxId: catalog.box_id };
}

function cents(value, label, positive, code) {
  const invalid = () => fail(code, `${label} must be a finite ${positive ? 'positive' : 'nonnegative'} amount with at most two decimals.`);
  if (typeof value !== 'number' || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) invalid();
  // Parse the canonical decimal JSON value, not an inexact binary value * 100.
  // Even a safe final integer may otherwise round one cent in either direction.
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/i.exec(String(value));
  if (!match) invalid();
  const fraction = match[2] || '', decimalPlaces = fraction.length - Number(match[3] || 0);
  let amount = BigInt(match[1] + fraction);
  if (decimalPlaces > 2) {
    const divisor = 10n ** BigInt(decimalPlaces - 2);
    if (amount % divisor !== 0n) invalid();
    amount /= divisor;
  } else amount *= 10n ** BigInt(2 - decimalPlaces);
  if (amount > 9007199254740991n) invalid();
  return Number(amount);
}

function probability(value) {
  if (!Number.isFinite(value) || value < -EPS || value > 1 + EPS) fail('NUMERICAL_ERROR', 'A computed probability is outside the supported numerical tolerance.');
  return Math.min(1, Math.max(0, value));
}

function targetIds(value, info) {
  if (!Array.isArray(value) || value.length === 0 || value.some(id => !nonempty(id)) || new Set(value).size !== value.length) fail('INVALID_INPUT', 'Targets must be a nonempty array of distinct item IDs.');
  if (value.some(id => !info.ids.includes(id))) fail('UNKNOWN_ITEM', 'Target contains an unknown variant.');
  return [...value];
}

function validateMechanism(value, info) {
  if (!plain(value)) fail('INVALID_INPUT', 'An explicit entry mechanism is required.');
  if (value.kind === 'random_removal' && exactKeys(value, ['kind'])) return { kind: 'random_removal' };
  if (value.kind === 'fixed_draws' && exactKeys(value, ['kind', 'draws']) && Number.isInteger(value.draws) && value.draws >= 0 && value.draws <= 14) return { kind: 'fixed_draws', draws: value.draws };
  if (value.kind === 'target_stop' && exactKeys(value, ['kind', 'target_ids', 'hit_limit', 'max_draws'])) {
    const ids = targetIds(value.target_ids, info);
    if (!Number.isInteger(value.hit_limit) || value.hit_limit < 1 || value.hit_limit > ids.length || !Number.isInteger(value.max_draws) || value.max_draws < 0 || value.max_draws > 14) fail('INVALID_INPUT', 'Predecessor hit limit or draw cap is invalid.');
    return { kind: 'target_stop', target_ids: ids, hit_limit: value.hit_limit, max_draws: value.max_draws };
  }
  fail('INVALID_INPUT', 'Unknown or invalid entry mechanism.');
}

function valuationMeta(value, mode, values, info) {
  if (!plain(value)) fail('INVALID_VALUATION_METADATA', 'Explicit valuation metadata is required.');
  const meta = jsonClone(value, 'INVALID_VALUATION_METADATA');
  if (mode === 'price' && meta.kind === 'prices') return meta;
  if (mode === 'preference' && meta.kind === 'explicit_values') return meta;
  if (mode !== 'preference' || meta.kind !== 'five_levels') fail('INVALID_VALUATION_METADATA', 'Valuation metadata does not match the selected mode.');
  if (!Array.isArray(meta.weights) || meta.weights.length !== 5 || meta.weights.some(weight => typeof weight !== 'number' || !Number.isFinite(weight)) || meta.weights[0] <= 0
      || typeof meta.willingness !== 'number' || !Number.isFinite(meta.willingness) || meta.willingness < 0 || !exactKeys(meta.ratings, info.ids)
      || info.ids.some(id => !Number.isInteger(meta.ratings[id]) || meta.ratings[id] < 0 || meta.ratings[id] > 4)) fail('INVALID_VALUATION_METADATA', 'Five-level valuations require a complete finite snapshot.');
  for (const id of info.ids) {
    const expected = meta.willingness * meta.weights[meta.ratings[id]] / meta.weights[0];
    if (!Number.isFinite(expected) || Math.abs(values[id] - expected) > 1e-8 * Math.max(1, Math.abs(expected), Math.abs(values[id]))) fail('VALUATION_MISMATCH', 'Stored item values do not match the fixed preference snapshot.');
  }
  return meta;
}

function validateConfig(raw, info, shapeCode = 'INVALID_INPUT') {
  if (!exactKeys(raw, CONFIG_KEYS)) fail(shapeCode, 'Configuration fields are missing or unknown.');
  if (raw.box_id !== info.boxId) fail('UNKNOWN_BOX', 'Unknown box number; inventory is never guessed.');
  if (!Number.isInteger(raw.initial_remaining) || raw.initial_remaining < 0 || raw.initial_remaining > 14 || !['price', 'preference'].includes(raw.mode)) fail(shapeCode, 'Invalid remaining draws or valuation mode.');
  if (raw.packing_ack !== true) fail('PACKING_ACK_REQUIRED', 'Acknowledge the unverified one-copy-per-variant packing assumption.');
  if (!plain(raw.values)) fail('INVALID_VALUE', 'Every variant requires a known value.');
  if (Object.keys(raw.values).some(id => !info.ids.includes(id))) fail('UNKNOWN_ITEM', 'Value table contains an unknown variant.');
  const values = {};
  let absoluteSum = 0;
  for (const id of info.ids) {
    const value = raw.values[id];
    if (!Object.hasOwn(raw.values, id) || value === null || value === '') fail(raw.mode === 'price' ? 'UNKNOWN_PRICE' : 'INVALID_VALUE', 'Every variant requires a known value.');
    if (typeof value !== 'number' || !Number.isFinite(value) || (raw.mode === 'price' && value < 0)) fail('INVALID_VALUE', 'Values must be finite numbers; prices cannot be negative.');
    values[id] = value; absoluteSum += Math.abs(value);
  }
  if (!Number.isFinite(absoluteSum)) fail('INVALID_VALUE', 'Value arithmetic overflows.');
  cents(raw.cost, 'Draw price', true, 'INVALID_COST');
  if (raw.budget !== null) cents(raw.budget, 'Budget', false, 'INVALID_BUDGET');
  return { box_id: raw.box_id, initial_remaining: raw.initial_remaining, mode: raw.mode, values,
    cost: raw.cost, budget: raw.budget, packing_ack: true,
    valuation_meta: valuationMeta(raw.valuation_meta, raw.mode, values, info),
    target_ids: targetIds(raw.target_ids, info), mechanism: validateMechanism(raw.mechanism, info) };
}

const idMask = (ids, info) => ids.reduce((mask, id) => mask | (1 << info.ids.indexOf(id)), 0);
function choose(n, k) { let result = 1; for (let i = 1; i <= Math.min(k, n - k); i++) result = result * (n - i + 1) / i; return Math.round(result); }

function priorFor(config, info, override = null) {
  const mechanism = override || config.mechanism, n = config.initial_remaining;
  const targets = mechanism.kind === 'target_stop' ? idMask(mechanism.target_ids, info) : 0;
  const key = `${mechanism.kind}:${mechanism.draws ?? ''}:${targets}:${mechanism.hit_limit ?? ''}:${mechanism.max_draws ?? ''}:${n}`;
  if (PRIOR_CACHE.has(key)) return PRIOR_CACHE.get(key);
  const weights = new Float64Array(SIZE);
  let stage1;
  if (mechanism.kind === 'random_removal' || mechanism.kind === 'fixed_draws') {
    if (mechanism.kind === 'fixed_draws' && n !== 14 - mechanism.draws) fail('UNSUPPORTED_N', 'The observed remaining count is impossible under the supplied predecessor rule.');
    const probability = 1 / choose(14, n);
    for (let mask = 0; mask < SIZE; mask++) if (COUNTS[mask] === n) weights[mask] = probability;
    const baseline = mechanism.kind === 'random_removal';
    stage1 = { probability_n: baseline ? null : 1, no_entry_probability: baseline ? null : Number(mechanism.draws === 0),
      empty_probability: baseline ? null : Number(n === 0), nonempty_probability: baseline ? null : Number(n > 0), conditional_support: choose(14, n) };
  } else {
    const forward = new Float64Array(SIZE), terminal = new Float64Array(SIZE);
    forward[FULL] = 1;
    const targetCount = COUNTS[targets];
    for (let mask = FULL; mask >= 0; mask--) {
      const mass = forward[mask];
      if (mass === 0) continue;
      const count = COUNTS[mask], hits = targetCount - COUNTS[mask & targets];
      if (count === 0 || 14 - count >= mechanism.max_draws || hits >= mechanism.hit_limit) terminal[mask] += mass;
      else {
        const branch = mass / count;
        for (let bits = mask; bits; bits &= bits - 1) forward[mask ^ (bits & -bits)] += branch;
      }
    }
    let probabilityN = 0, support = 0;
    for (let mask = 0; mask < SIZE; mask++) if (COUNTS[mask] === n && terminal[mask] > 0) { probabilityN += terminal[mask]; support++; }
    if (probabilityN === 0) fail('UNSUPPORTED_N', 'The observed remaining count is impossible under the supplied predecessor rule.');
    for (let mask = 0; mask < SIZE; mask++) if (COUNTS[mask] === n) weights[mask] = terminal[mask] / probabilityN;
    stage1 = { probability_n: probabilityN, no_entry_probability: terminal[FULL], empty_probability: terminal[0], nonempty_probability: 1 - terminal[0], conditional_support: support };
  }
  const z = weights.slice();
  for (let bit = 1; bit < SIZE; bit <<= 1) for (let mask = 0; mask < SIZE; mask++) if (!(mask & bit)) z[mask] += z[mask | bit];
  const result = { weights, z, stage1 };
  if (PRIOR_CACHE.size >= 16) PRIOR_CACHE.delete(PRIOR_CACHE.keys().next().value);
  PRIOR_CACHE.set(key, result);
  return result;
}

export function createSession(input, catalog) {
  const info = catalogInfo(catalog);
  if (!exactKeys(input, INPUT_KEYS) || !nonempty(input.session_id)) fail('INVALID_INPUT', 'Create input fields are missing or unknown.');
  const config = validateConfig(Object.fromEntries(CONFIG_KEYS.map(key => [key, input[key]])), info);
  priorFor(config, info);
  return { schema_version: SCHEMA_VERSION, model_version: MODEL_VERSION, catalog_version: info.version, session_id: input.session_id, config, events: [] };
}

function validateState(payload, catalog) {
  const info = catalogInfo(catalog);
  let raw = payload;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { fail('INVALID_SESSION', 'Session JSON could not be parsed.'); } }
  if (!exactKeys(raw, SESSION_KEYS)) fail('INVALID_SESSION', 'Session fields are missing or unknown.');
  if (raw.schema_version !== SCHEMA_VERSION || raw.model_version !== MODEL_VERSION || raw.catalog_version !== info.version) fail('VERSION_MISMATCH', 'Session schema, model or catalog version is unsupported; v1 sessions remain usable in the preserved v0.1 version.');
  if (!nonempty(raw.session_id)) fail('INVALID_SESSION', 'Session ID must be nonempty.');
  const config = validateConfig(raw.config, info, 'INVALID_SESSION'), prior = priorFor(config, info);
  if (!Array.isArray(raw.events)) fail('INVALID_SESSION', 'Session events must be an array.');
  const seen = new Set(), activeItems = new Set();
  let activePrefix = 0, observed = 0;
  const price = cents(config.cost, 'Draw price', true, 'INVALID_COST');
  const budget = config.budget === null ? null : cents(config.budget, 'Budget', false, 'INVALID_BUDGET');
  for (const event of raw.events) {
    if (!exactKeys(event, ['event_id', 'item_id', 'status']) || !nonempty(event.event_id) || !['active', 'undone'].includes(event.status) || seen.has(event.event_id)) fail('INVALID_SESSION', 'Invalid or duplicate event ledger entry.');
    if (!info.ids.includes(event.item_id)) fail('UNKNOWN_ITEM', 'Session contains an unknown variant.');
    seen.add(event.event_id);
    if (activePrefix + 1 > config.initial_remaining || (budget !== null && (activePrefix + 1) * price > budget)) fail('INVALID_SESSION', 'Event creation order could not fit the inventory or budget.');
    if (activeItems.has(event.item_id)) fail('DUPLICATE_ITEM', 'A one-copy variant could not have been recorded twice.');
    const nextObserved = observed | (1 << info.ids.indexOf(event.item_id));
    if (prior.z[nextObserved] <= 0) fail('UNSUPPORTED_OBSERVATION', 'This observation is impossible under the supplied predecessor rule and known results.');
    if (event.status === 'active') { activeItems.add(event.item_id); activePrefix++; observed = nextObserved; }
  }
  return { state: { schema_version: SCHEMA_VERSION, model_version: MODEL_VERSION, catalog_version: info.version, session_id: raw.session_id, config, events: jsonClone(raw.events, 'INVALID_SESSION') },
    info, activeItems, draws: activePrefix, observed, price, budget, prior };
}

export function restoreSession(payload, catalog) { return validateState(payload, catalog).state; }
export function recordResult(state, eventId, itemId, catalog) {
  const data = validateState(state, catalog), current = data.state;
  if (!nonempty(eventId)) fail('INVALID_INPUT', 'A stable event ID is required.');
  if (!data.info.ids.includes(itemId)) fail('UNKNOWN_ITEM', 'Unknown result variant.');
  const priorEvent = current.events.find(event => event.event_id === eventId);
  if (priorEvent) { if (priorEvent.item_id !== itemId) fail('EVENT_CONFLICT', 'Event ID was already used for a different variant.'); return current; }
  if (data.activeItems.has(itemId)) fail('DUPLICATE_ITEM', 'This variant has already been recorded under the one-copy assumption.');
  if (data.draws >= current.config.initial_remaining) fail('EMPTY', 'The physical box is empty.');
  if (data.budget !== null && (data.draws + 1) * data.price > data.budget) fail('BUDGET', 'The configured budget cannot afford another draw.');
  if (data.prior.z[data.observed | (1 << data.info.ids.indexOf(itemId))] <= 0) fail('UNSUPPORTED_OBSERVATION', 'This observation has zero likelihood under the supplied mechanism.');
  current.events.push({ event_id: eventId, item_id: itemId, status: 'active' });
  return current;
}

export function undoResult(state, eventId, catalog) {
  const current = validateState(state, catalog).state;
  if (!nonempty(eventId)) fail('INVALID_INPUT', 'Undo requires a stable target event ID.');
  const event = current.events.find(entry => entry.event_id === eventId);
  if (!event) fail('UNKNOWN_EVENT', 'Unknown undo target.');
  event.status = 'undone';
  // Removing information cannot make a previously possible active set impossible.
  return current;
}

function adviceFor(data, prior, mechanism) {
  const { config } = data.state, ids = data.info.ids;
  const actual = config.initial_remaining - data.draws, latent = 14 - data.draws;
  const remainingCents = data.budget === null ? null : data.budget - data.draws * data.price;
  const horizon = remainingCents === null ? actual : Math.min(actual, Math.floor(remainingCents / data.price));
  const userTargets = idMask(config.target_ids, data.info), values = ids.map(id => config.values[id]);
  const z = prior.z, n = config.initial_remaining;
  if (z[data.observed] <= 0) fail('UNSUPPORTED_OBSERVATION', 'Known results have zero likelihood under the supplied mechanism.');
  const probabilitiesAt = observed => {
    const left = n - COUNTS[observed], result = new Float64Array(14);
    if (left <= 0) return result;
    const denominator = left * z[observed];
    for (let i = 0; i < 14; i++) if (!(observed & (1 << i))) result[i] = z[observed | (1 << i)] / denominator;
    return result;
  };
  const policy = new Map();
  const qBuy = (observed, h) => {
    if (h <= 0 || n - COUNTS[observed] <= 0) return 0;
    const key = observed * 16 + h;
    if (policy.has(key)) return policy.get(key);
    let result = 0;
    const prediction = probabilitiesAt(observed);
    for (let i = 0; i < 14; i++) if (prediction[i] > 0) {
      const childQ = qBuy(observed | (1 << i), h - 1);
      result += prediction[i] * (values[i] - config.cost + (childQ > EPS ? childQ : 0));
    }
    if (!Number.isFinite(result)) fail('INVALID_VALUE', 'Configured values overflow expected-value arithmetic.');
    policy.set(key, result);
    return result;
  };
  const predictive = probabilitiesAt(data.observed);
  const probabilities = ids.map((id, i) => ({ item_id: id, p: probability(predictive[i]), value: values[i], observed: Boolean(data.observed & (1 << i)), presence_probability: probability(predictive[i] * actual) }));
  let nextEv = null;
  if (actual > 0) { nextEv = 0; for (let i = 0; i < 14; i++) nextEv += predictive[i] * values[i]; }
  if (nextEv !== null && !Number.isFinite(nextEv)) fail('INVALID_VALUE', 'Configured values overflow expected-value arithmetic.');
  const q = actual > 0 && horizon > 0 ? qBuy(data.observed, horizon) : null;
  let reason = 'empty', action = 'stop';
  if (actual > 0) {
    if (horizon === 0) reason = 'budget';
    else if (Math.abs(q) <= EPS) reason = 'tie';
    else if (q > EPS) { reason = 'positive_value'; action = 'buy'; }
    else reason = 'nonpositive_value';
  }
  const remainingTargets = COUNTS[userTargets & ~data.observed];
  const targetHistogram = new Float64Array(Math.min(actual, remainingTargets) + 1);
  for (let mask = 0; mask < SIZE; mask++) if (prior.weights[mask] > 0 && (mask & data.observed) === data.observed) targetHistogram[COUNTS[(mask & ~data.observed) & userTargets]] += prior.weights[mask] / z[data.observed];
  const histogramMass = targetHistogram.reduce((sum, mass) => sum + mass, 0);
  for (let count = 0; count < targetHistogram.length; count++) targetHistogram[count] /= histogramMass;
  const remainingTargetDistribution = Array.from(targetHistogram, (p, count) => ({ count, p: probability(p) }));

  // Terminal propagation follows a single policy on public observations, never an oracle on a real mask.
  const forward = new Float64Array(SIZE);
  forward[data.observed] = 1;
  const outcomes = new Map(), netMass = new Map();
  let expectedDraws = 0, lossProbability = 0, futureHitProbability = 0;
  for (let observed = data.observed; observed < SIZE; observed++) {
    const mass = forward[observed];
    if (mass === 0) continue;
    const newMask = observed & ~data.observed, draws = COUNTS[newMask], h = horizon - draws;
    if (h <= 0 || n - COUNTS[observed] <= 0 || qBuy(observed, h) <= EPS) {
      const hits = COUNTS[newMask & userTargets], key = draws * 16 + hits;
      outcomes.set(key, (outcomes.get(key) || 0) + mass);
      let net = 0;
      for (let i = 0; i < 14; i++) if (newMask & (1 << i)) net += values[i] - config.cost;
      if (!Number.isFinite(net)) fail('INVALID_VALUE', 'Configured values overflow outcome arithmetic.');
      netMass.set(net, (netMass.get(net) || 0) + mass);
      expectedDraws += draws * mass;
      if (net < -EPS) lossProbability += mass;
      if (hits > 0) futureHitProbability += mass;
    } else {
      const prediction = probabilitiesAt(observed);
      for (let i = 0; i < 14; i++) if (prediction[i] > 0) forward[observed | (1 << i)] += mass * prediction[i];
    }
  }
  const terminalMass = [...netMass.values()].reduce((sum, mass) => sum + mass, 0);
  for (const [net, mass] of netMass) netMass.set(net, mass / terminalMass);
  for (const [key, mass] of outcomes) outcomes.set(key, mass / terminalMass);
  expectedDraws /= terminalMass; lossProbability /= terminalMass; futureHitProbability /= terminalMass;
  const netOutcomes = [...netMass.entries()].sort((a, b) => a[0] - b[0]);
  const quantile = probability => {
    let cumulative = 0;
    for (const [net, mass] of netOutcomes) { cumulative += mass; if (cumulative + 1e-12 >= probability) return net; }
    return netOutcomes.at(-1)[0];
  };
  let nextTargetProbability = 0;
  for (let i = 0; i < 14; i++) if (userTargets & (1 << i)) nextTargetProbability += predictive[i];
  const alreadyObservedTargets = COUNTS[data.observed & userTargets];
  const risk = { next_target_probability: probability(nextTargetProbability), remaining_zero_target_probability: probability(targetHistogram[0]),
    remaining_target_distribution: remainingTargetDistribution, fixed_all_remaining_hit_probability: probability(1 - targetHistogram[0]), fixed_all_remaining_cost: actual * config.cost,
    policy_future_hit_probability: probability(futureHitProbability), policy_final_no_target_probability: probability(alreadyObservedTargets > 0 ? 0 : 1 - futureHitProbability),
    already_observed_target_count: alreadyObservedTargets, expected_additional_draws: expectedDraws, expected_additional_spend: expectedDraws * config.cost,
    policy_loss_probability: probability(lossProbability), net_utility_quantiles: { p05: quantile(0.05), p50: quantile(0.5), p95: quantile(0.95) },
    net_utility_min: netOutcomes[0][0], net_utility_max: netOutcomes.at(-1)[0],
    outcome_distribution: [...outcomes.entries()].sort((a, b) => a[0] - b[0]).map(([key, p]) => ({ draws: Math.floor(key / 16), target_hits: key % 16, p: probability(p) })) };
  const stage1 = Object.fromEntries(Object.entries(prior.stage1).map(([key, value]) => [key, value === null || key === 'conditional_support' ? value : probability(value)]));
  return { schema_version: SCHEMA_VERSION, model_version: MODEL_VERSION, catalog_version: data.info.version, box_id: config.box_id,
    actual_remaining: actual, latent_count: latent, unknown_removed: 14 - n, own_draw_count: data.draws,
    remaining_budget: remainingCents === null ? null : remainingCents / 100, spent: data.draws * data.price / 100, max_future_draws: horizon,
    next_ev: nextEv, next_net: nextEv === null ? null : nextEv - config.cost, q_buy: q, optimal_value: action === 'buy' ? q : 0, action, reason,
    probabilities, possible_count: probabilities.filter(row => row.p > EPS).length, target_ids: [...config.target_ids], mechanism: jsonClone(mechanism), assumptions: [...ASSUMPTIONS],
    method: 'exact_bitmask_belief_dp', stage1, risk, comparison: null };
}

export function recommend(state, catalog) {
  const data = validateState(state, catalog), mechanism = data.state.config.mechanism;
  const advice = adviceFor(data, data.prior, mechanism);
  if (mechanism.kind !== 'random_removal') {
    const baselineMechanism = { kind: 'random_removal' };
    const baseline = adviceFor(data, priorFor(data.state.config, data.info, baselineMechanism), baselineMechanism);
    advice.comparison = { baseline: { action: baseline.action, next_ev: baseline.next_ev, next_net: baseline.next_net, optimal_value: baseline.optimal_value, risk: baseline.risk },
      predictive_differs: advice.probabilities.some((row, i) => Math.abs(row.p - baseline.probabilities[i].p) > EPS), action_disagrees: advice.action !== baseline.action, unverified_behavior: true };
  }
  return advice;
}

export function dispatch(request, catalog) {
  catalogInfo(catalog);
  const shapes = { create: ['op', 'input'], recommend: ['op', 'state'], record: ['op', 'state', 'event_id', 'item_id'], undo: ['op', 'state', 'event_id'], restore: ['op', 'payload'] };
  if (!plain(request) || typeof request.op !== 'string' || !Object.hasOwn(shapes, request.op) || !exactKeys(request, shapes[request.op])) fail('INVALID_INPUT', 'Unknown operation or invalid request fields.');
  switch (request.op) {
    case 'create': return createSession(request.input, catalog);
    case 'recommend': return recommend(request.state, catalog);
    case 'record': return recordResult(request.state, request.event_id, request.item_id, catalog);
    case 'undo': return undoResult(request.state, request.event_id, catalog);
    case 'restore': return restoreSession(request.payload, catalog);
    default: fail('INVALID_INPUT', 'Unknown operation.');
  }
}
