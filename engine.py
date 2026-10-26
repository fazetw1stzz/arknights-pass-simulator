"""Exact public-belief residual-box engine with explicit predecessor mechanisms.

Superset masses collapse the posterior, without revealing hidden inventory.
No filesystem, network, RNG, clock or purchase side effects occur in this module.
"""
from __future__ import annotations

from decimal import Decimal
from functools import lru_cache
import json
import math

SCHEMA_VERSION = 2
MODEL_VERSION = "residual-items-v2"
EPS = 1e-9
MAX_SAFE_CENTS = 9007199254740991
FULL = (1 << 14) - 1
CONFIG_KEYS = {"box_id", "initial_remaining", "mode", "values", "cost", "budget", "packing_ack", "valuation_meta", "target_ids", "mechanism"}
STATE_KEYS = {"schema_version", "model_version", "catalog_version", "session_id", "config", "events"}
ASSUMPTIONS = (
    "One copy of each of 14 variants is an unverified packing assumption.",
    "Uniform draws without replacement; the supplied mechanism is an assumption, not observed behavior.",
    "Item utilities are additive and fixed; cost and utility share one scale.",
    "Budget is personal and does not recycle item utility.",
    "Policy risk follows the public-belief optimal policy; no hidden-composition oracle or Monte Carlo.",
    "Force-all risk assumes enough budget to draw the entire physical remainder.",
)


class ModelError(ValueError):
    def __init__(self, code, message):
        self.code = code
        super().__init__(message)


def fail(code, message):
    raise ModelError(code, message)


def probability(value):
    """Only round numerical overshoot; do not erase genuinely small chances."""
    if not math.isfinite(value) or value < -EPS or value > 1 + EPS:
        fail("NUMERICAL_ERROR", "Computed probability is outside numerical tolerance")
    return min(1.0, max(0.0, value))


def clone(value, code="INVALID_INPUT"):
    try:
        return json.loads(json.dumps(value, allow_nan=False, ensure_ascii=False))
    except (TypeError, ValueError, OverflowError):
        fail(code, "Payload must contain finite JSON-compatible data")


def text_id(value, label, code="INVALID_INPUT"):
    if not isinstance(value, str) or not value.strip():
        fail(code, f"{label} must be a nonempty string")
    return value


def number(value, code, label):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        fail(code, f"{label} must be a finite number")
    try:
        result = float(value)
    except (OverflowError, ValueError):
        fail(code, f"{label} must be a finite number")
    if not math.isfinite(result):
        fail(code, f"{label} must be a finite number")
    return result


def cents(value, code, label, positive=False):
    number(value, code, label)
    d = Decimal(str(value))
    sign, digits, exponent = d.as_tuple()
    coefficient = int("".join(map(str, digits)))
    if exponent < -2:
        divisor = 10 ** (-2 - exponent)
        if coefficient % divisor:
            fail(code, f"{label} supports at most two decimal places")
        amount = coefficient // divisor
    else:
        amount = coefficient * 10 ** (exponent + 2)
    if sign:
        amount = -amount
    if amount < 0 or (positive and amount == 0) or amount > MAX_SAFE_CENTS:
        fail(code, f"{label} is outside the supported cent range")
    return amount


def catalog_info(catalog):
    if not isinstance(catalog, dict) or type(catalog.get("schema_version")) is not int or catalog.get("schema_version") != 1:
        fail("INVALID_CATALOG", "Catalog schema_version must be 1")
    if catalog.get("box_id") != "54.0":
        fail("INVALID_CATALOG", "This engine requires the explicit 54.0 catalog")
    version = text_id(catalog.get("catalog_version"), "catalog_version", "INVALID_CATALOG")
    items = catalog.get("items")
    if not isinstance(items, list) or len(items) != 14:
        fail("INVALID_CATALOG", "Catalog must contain exactly fourteen individual variants")
    ids = []
    for item in items:
        if not isinstance(item, dict):
            fail("INVALID_CATALOG", "Catalog item must be an object")
        ids.append(text_id(item.get("id"), "item id", "INVALID_CATALOG"))
    if len(set(ids)) != 14:
        fail("INVALID_CATALOG", "Catalog item identities must be unique")
    return version, tuple(ids)


def item_list(raw, ids, label):
    if not isinstance(raw, list) or not raw:
        fail("INVALID_INPUT", f"{label} must be a nonempty list")
    if any(not isinstance(x, str) or x not in ids for x in raw):
        fail("UNKNOWN_ITEM", f"{label} contains an unknown item")
    if len(set(raw)) != len(raw):
        fail("INVALID_INPUT", f"{label} must not contain duplicate IDs")
    return list(raw)


def mechanism_config(raw, ids):
    if not isinstance(raw, dict):
        fail("INVALID_INPUT", "mechanism must be an explicit object")
    kind = raw.get("kind")
    if kind == "random_removal" and set(raw) == {"kind"}:
        return {"kind": kind}
    if kind == "fixed_draws" and set(raw) == {"kind", "draws"}:
        if type(raw["draws"]) is not int or not 0 <= raw["draws"] <= 14:
            fail("INVALID_INPUT", "Predecessor draws must be an integer from zero to fourteen")
        return {"kind": kind, "draws": raw["draws"]}
    if kind == "target_stop" and set(raw) == {"kind", "target_ids", "hit_limit", "max_draws"}:
        targets = item_list(raw["target_ids"], ids, "predecessor target_ids")
        hit, cap = raw["hit_limit"], raw["max_draws"]
        if type(hit) is not int or not 1 <= hit <= len(targets) or type(cap) is not int or not 0 <= cap <= 14:
            fail("INVALID_INPUT", "Invalid predecessor hit_limit or max_draws")
        return {"kind": kind, "target_ids": targets, "hit_limit": hit, "max_draws": cap}
    fail("INVALID_INPUT", "Unknown mechanism or invalid mechanism fields")


def valuation_metadata(raw, mode, values, ids):
    code = "INVALID_VALUATION_METADATA"
    if not isinstance(raw, dict):
        fail(code, "valuation_meta must be a JSON object")
    meta = clone(raw, code)
    kind = meta.get("kind")
    if mode == "price":
        if kind != "prices":
            fail(code, "Price mode requires metadata kind=prices")
        return meta
    if kind == "explicit_values":
        return meta
    if kind != "five_levels":
        fail(code, "Preference metadata must be five_levels or explicit_values")
    weights, ratings = meta.get("weights"), meta.get("ratings")
    if not isinstance(weights, list) or len(weights) != 5:
        fail(code, "Five finite level weights are required")
    weights = [number(v, code, "level weight") for v in weights]
    willingness = number(meta.get("willingness"), code, "willingness")
    if weights[0] <= 0 or willingness < 0:
        fail(code, "Favorite weight must be positive and willingness nonnegative")
    if not isinstance(ratings, dict) or set(ratings) != set(ids) or any(type(r) is not int or not 0 <= r <= 4 for r in ratings.values()):
        fail(code, "Every variant requires a level index from zero to four")
    for item_id in ids:
        expected = willingness * weights[ratings[item_id]] / weights[0]
        if not math.isfinite(expected):
            fail(code, "Derived valuation is not finite")
        actual = values[item_id]
        if abs(actual - expected) > 1e-8 * max(1.0, abs(actual), abs(expected)):
            fail("VALUATION_MISMATCH", f"Value for {item_id} disagrees with the stored rating snapshot")
    return meta


def validate_config(config, ids, code="INVALID_INPUT"):
    if not isinstance(config, dict) or set(config) != CONFIG_KEYS:
        fail(code, "Configuration fields are missing or unknown")
    if config["box_id"] != "54.0":
        fail("UNKNOWN_BOX", "Unknown box_id; no packing is inferred")
    n = config["initial_remaining"]
    if type(n) is not int or not 0 <= n <= 14:
        fail(code, "initial_remaining must be an integer from zero to fourteen")
    mode = config["mode"]
    if mode not in ("price", "preference"):
        fail(code, "mode must be price or preference")
    if config["packing_ack"] is not True:
        fail("PACKING_ACK_REQUIRED", "Acknowledge the unverified one-each packing assumption")
    values = config["values"]
    if not isinstance(values, dict):
        fail("INVALID_VALUE", "values must specify every individual item")
    if set(values) - set(ids):
        fail("UNKNOWN_ITEM", "values contains an unknown item identity")
    clean_values = {}
    for item_id in ids:
        raw = values.get(item_id)
        if raw is None or raw == "":
            fail("UNKNOWN_PRICE" if mode == "price" else "INVALID_VALUE", f"Resolve the value for {item_id}")
        value = number(raw, "INVALID_VALUE", f"value for {item_id}")
        if mode == "price" and value < 0:
            fail("INVALID_VALUE", "Price values cannot be negative")
        clean_values[item_id] = value
    try:
        total = math.fsum(abs(v) for v in clean_values.values())
    except OverflowError:
        fail("INVALID_VALUE", "Value arithmetic overflows")
    if not math.isfinite(total):
        fail("INVALID_VALUE", "Value arithmetic overflows")
    cost = cents(config["cost"], "INVALID_COST", "cost", True)
    budget = None if config["budget"] is None else cents(config["budget"], "INVALID_BUDGET", "budget")
    meta = valuation_metadata(config["valuation_meta"], mode, clean_values, ids)
    targets = item_list(config["target_ids"], ids, "target_ids")
    mechanism = mechanism_config(config["mechanism"], ids)
    return {"box_id": "54.0", "initial_remaining": n, "mode": mode,
            "values": clean_values, "cost": cost / 100, "budget": None if budget is None else budget / 100,
            "packing_ack": True, "valuation_meta": meta, "target_ids": targets, "mechanism": mechanism}


def id_mask(item_ids, ids):
    return sum(1 << ids.index(item_id) for item_id in item_ids)


@lru_cache(maxsize=16)
def terminal_mass(kind, target_mask, hit_limit, cap):
    """Exact forward predecessor process; array index is hidden remaining mask."""
    active = {FULL: 1.0}
    terminals = [0.0] * (FULL + 1)
    target_count = target_mask.bit_count()
    for depth in range(15):
        following = {}
        for remaining, mass in active.items():
            hits = target_count - (remaining & target_mask).bit_count()
            if remaining == 0 or depth >= cap or (kind == "target_stop" and hits >= hit_limit):
                terminals[remaining] += mass
                continue
            branch = mass / remaining.bit_count()
            bits = remaining
            while bits:
                bit = bits & -bits
                child = remaining ^ bit
                following[child] = following.get(child, 0.0) + branch
                bits ^= bit
        active = following
        if not active:
            break
    total = math.fsum(terminals)
    if abs(total - 1) > 1e-10:
        fail("INVALID_INPUT", "Predecessor terminal probability mass did not normalize")
    return tuple(terminals)


@lru_cache(maxsize=16)
def entry_prior(kind, target_mask, hit_limit, cap, n):
    if kind == "random_removal":
        support = tuple(mask for mask in range(FULL + 1) if mask.bit_count() == n)
        weights = [(mask, 1 / len(support)) for mask in support]
        stage = (None, None, None, None, len(support))
    else:
        terminal = terminal_mass(kind, target_mask, hit_limit, cap)
        selected = [(mask, p) for mask, p in enumerate(terminal) if p > 0 and mask.bit_count() == n]
        probability_n = math.fsum(p for _, p in selected)
        if probability_n <= 0:
            fail("UNSUPPORTED_N", "The supplied predecessor rule cannot produce this remaining count")
        weights = [(mask, p / probability_n) for mask, p in selected]
        stage = (probability_n, terminal[FULL], terminal[0], 1 - terminal[0], len(weights))
    z = [0.0] * (FULL + 1)
    for mask, weight in weights:
        z[mask] = weight
    # Superset zeta transform: Z[O] = sum of entry mass containing O.
    for index in range(14):
        bit = 1 << index
        for observed in range(FULL + 1):
            if not observed & bit:
                z[observed] += z[observed | bit]
    return tuple(weights), tuple(z), stage


def prior_for(config, ids, baseline=False):
    mechanism = {"kind": "random_removal"} if baseline else config["mechanism"]
    kind = mechanism["kind"]
    target_mask = id_mask(mechanism.get("target_ids", []), ids)
    cap = mechanism.get("draws", mechanism.get("max_draws", 14))
    return entry_prior(kind, target_mask, mechanism.get("hit_limit", 0), cap, config["initial_remaining"])


def supported(config, ids, observed):
    if prior_for(config, ids)[1][observed] <= 0:
        fail("UNSUPPORTED_OBSERVATION", "The recorded identities have zero likelihood under the supplied mechanism")


def create(input_, version, ids):
    if not isinstance(input_, dict) or set(input_) != CONFIG_KEYS | {"session_id"}:
        fail("INVALID_INPUT", "Create input fields are missing or unknown")
    session_id = text_id(input_["session_id"], "session_id")
    config = validate_config({key: input_[key] for key in CONFIG_KEYS}, ids)
    prior_for(config, ids)  # Reject impossible N before creating any session.
    return {"schema_version": SCHEMA_VERSION, "model_version": MODEL_VERSION, "catalog_version": version,
            "session_id": session_id, "config": config, "events": []}


def restore(payload, version, ids):
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (ValueError, TypeError):
            fail("INVALID_SESSION", "Session JSON could not be parsed")
    if not isinstance(payload, dict) or set(payload) != STATE_KEYS:
        fail("INVALID_SESSION", "Session fields are missing or unknown")
    state = clone(payload, "INVALID_SESSION")
    if type(state["schema_version"]) is not int or state["schema_version"] != SCHEMA_VERSION or state["model_version"] != MODEL_VERSION or state["catalog_version"] != version:
        fail("VERSION_MISMATCH", "Session model or catalog version is not supported")
    session_id = text_id(state["session_id"], "session_id", "INVALID_SESSION")
    config = validate_config(state["config"], ids, "INVALID_SESSION")
    _, z, _ = prior_for(config, ids)
    if not isinstance(state["events"], list):
        fail("INVALID_SESSION", "events must be a list")
    seen_ids, active_items, events = set(), set(), []
    observed_mask = 0
    cost = cents(config["cost"], "INVALID_COST", "cost", True)
    budget = None if config["budget"] is None else cents(config["budget"], "INVALID_BUDGET", "budget")
    for event in state["events"]:
        if not isinstance(event, dict) or set(event) != {"event_id", "item_id", "status"}:
            fail("INVALID_SESSION", "Invalid event ledger entry")
        event_id = text_id(event["event_id"], "event_id", "INVALID_SESSION")
        if event_id in seen_ids:
            fail("INVALID_SESSION", "Event IDs must be unique, including tombstones")
        seen_ids.add(event_id)
        if event["item_id"] not in ids:
            fail("UNKNOWN_ITEM", "Event contains an unknown item")
        if event["status"] not in ("active", "undone"):
            fail("INVALID_SESSION", "Event status must be active or undone")
        # Every event had to be creatable, even if it was later corrected.
        # Earlier finally-active entries could never have been undone/revived.
        attempted_count = len(active_items) + 1
        if attempted_count > config["initial_remaining"] or (budget is not None and attempted_count * cost > budget):
            fail("INVALID_SESSION", "Event creation order exceeds physical inventory or configured budget")
        if event["item_id"] in active_items:
            fail("DUPLICATE_ITEM", "An individual item could not have been recorded twice")
        bit = 1 << ids.index(event["item_id"])
        if z[observed_mask | bit] <= 0:
            fail("UNSUPPORTED_OBSERVATION", "An event could not occur under the supplied predecessor mechanism")
        if event["status"] == "active":
            active_items.add(event["item_id"])
            observed_mask |= bit
        events.append(dict(event))
    return {"schema_version": SCHEMA_VERSION, "model_version": MODEL_VERSION, "catalog_version": version,
            "session_id": session_id, "config": config, "events": events}


def _compute(state, ids, observed, prior):
    """Public-information DP and forward risk propagation under one fixed belief."""
    config = state["config"]
    entry_weights, z, stage = prior
    initial_n = config["initial_remaining"]
    draw_count = observed.bit_count()
    actual = initial_n - draw_count
    values = tuple(config["values"][item_id] for item_id in ids)
    target_mask = id_mask(config["target_ids"], ids)
    cost_cents = cents(config["cost"], "INVALID_COST", "cost", True)
    cost = cost_cents / 100
    budget_cents = None if config["budget"] is None else cents(config["budget"], "INVALID_BUDGET", "budget")
    affordable_total = initial_n if budget_cents is None else budget_cents // cost_cents
    remaining_cents = None if budget_cents is None else budget_cents - draw_count * cost_cents

    def horizon(own):
        return max(0, min(initial_n - own.bit_count(), affordable_total - own.bit_count()))

    @lru_cache(maxsize=None)
    def predictive(own):
        remaining = initial_n - own.bit_count()
        if remaining <= 0:
            return (0.0,) * 14
        total = z[own]
        if total <= 0:
            fail("UNSUPPORTED_OBSERVATION", "Public observation has zero posterior likelihood")
        denominator = remaining * total
        return tuple(0.0 if own & (1 << i) else z[own | (1 << i)] / denominator for i in range(14))

    @lru_cache(maxsize=None)
    def value(own):
        if horizon(own) <= 0:
            return 0.0
        q = buy_value(own)
        # Numerical ties must have the same stop value used by policy risk.
        return q if q > EPS else 0.0

    @lru_cache(maxsize=None)
    def buy_value(own):
        if horizon(own) <= 0:
            return 0.0
        try:
            q = math.fsum(p * (values[i] - cost + value(own | (1 << i)))
                          for i, p in enumerate(predictive(own)) if p > 0)
        except OverflowError:
            fail("INVALID_VALUE", "Value arithmetic overflows")
        if not math.isfinite(q):
            fail("INVALID_VALUE", "Value arithmetic overflows")
        return q

    prediction = predictive(observed)
    h = horizon(observed)
    q = buy_value(observed) if h > 0 else None
    next_ev = math.fsum(p * v for p, v in zip(prediction, values)) if actual else None
    action = "buy" if q is not None and q > EPS else "stop"
    reason = ("empty" if actual == 0 else "budget" if h == 0 else
              "positive_value" if q > EPS else "tie" if abs(q) <= EPS else "nonpositive_value")

    # Target inventory histogram is posterior information, not a DP objective.
    upper = min(actual, (target_mask & ~observed).bit_count())
    histogram = [0.0] * (upper + 1)
    for entry_mask, weight in entry_weights:
        if entry_mask & observed == observed:
            count = (entry_mask & target_mask & ~observed).bit_count()
            histogram[count] += weight / z[observed]
    hist_total = math.fsum(histogram)
    histogram = [p / hist_total for p in histogram]

    # This tree sees ONLY the current observed set. Never optimize each hidden
    # entry composition separately and then average those clairvoyant values.
    active, terminals = {observed: 1.0}, {}
    while active:
        following = {}
        for own, mass in active.items():
            if horizon(own) <= 0 or buy_value(own) <= EPS:
                terminals[own] = terminals.get(own, 0.0) + mass
                continue
            for i, p in enumerate(predictive(own)):
                if p > 0:
                    after = own | (1 << i)
                    following[after] = following.get(after, 0.0) + mass * p
        active = following
    terminal_total = math.fsum(terminals.values())
    if abs(terminal_total - 1.0) > 1e-9:
        fail("INVALID_INPUT", "Policy terminal mass did not normalize")
    terminal_rows, grouped = [], {}
    for own, raw_mass in terminals.items():
        mass = raw_mass / terminal_total
        new = own ^ observed
        draws = new.bit_count()
        hits = (new & target_mask).bit_count()
        net = sum(values[i] - cost for i in range(14) if new & (1 << i))
        terminal_rows.append((net, mass, draws, hits))
        grouped[(draws, hits)] = grouped.get((draws, hits), 0.0) + mass
    ordered = sorted((net, mass) for net, mass, _, _ in terminal_rows)

    def quantile(level):
        cumulative = 0.0
        for net, mass in ordered:
            cumulative += mass
            if cumulative + 1e-12 >= level:
                return net
        return ordered[-1][0]

    expected_draws = math.fsum(mass * draws for _, mass, draws, _ in terminal_rows)
    already_hits = (observed & target_mask).bit_count()
    risk = {
        "next_target_probability": math.fsum(prediction[i] for i in range(14) if target_mask & (1 << i)),
        "remaining_zero_target_probability": histogram[0],
        "remaining_target_distribution": [{"count": count, "p": p} for count, p in enumerate(histogram)],
        "fixed_all_remaining_hit_probability": 1 - histogram[0],
        "fixed_all_remaining_cost": actual * cost_cents / 100,
        "policy_future_hit_probability": math.fsum(mass for _, mass, _, hits in terminal_rows if hits > 0),
        "policy_final_no_target_probability": 0.0 if already_hits else math.fsum(mass for _, mass, _, hits in terminal_rows if hits == 0),
        "already_observed_target_count": already_hits,
        "expected_additional_draws": expected_draws,
        "expected_additional_spend": expected_draws * cost_cents / 100,
        "policy_loss_probability": math.fsum(mass for net, mass, _, _ in terminal_rows if net < -EPS),
        "net_utility_quantiles": {"p05": quantile(.05), "p50": quantile(.5), "p95": quantile(.95)},
        "net_utility_min": ordered[0][0], "net_utility_max": ordered[-1][0],
        "outcome_distribution": [{"draws": draws, "target_hits": hits, "p": p}
                                 for (draws, hits), p in sorted(grouped.items())],
    }
    result = {"schema_version": SCHEMA_VERSION, "model_version": MODEL_VERSION,
            "catalog_version": state["catalog_version"], "box_id": config["box_id"],
            "actual_remaining": actual, "latent_count": 14 - draw_count,
            "unknown_removed": 14 - initial_n, "own_draw_count": draw_count,
            "remaining_budget": None if remaining_cents is None else remaining_cents / 100,
            "spent": draw_count * cost_cents / 100, "max_future_draws": h,
            "next_ev": next_ev, "next_net": None if next_ev is None else next_ev - cost,
            "q_buy": q, "optimal_value": value(observed), "action": action, "reason": reason,
            "probabilities": [{"item_id": item_id, "p": prediction[i], "value": values[i],
                               "observed": bool(observed & (1 << i)),
                               "presence_probability": prediction[i] * actual}
                              for i, item_id in enumerate(ids)],
            "possible_count": sum(p > EPS for p in prediction), "target_ids": list(config["target_ids"]),
            "mechanism": clone(config["mechanism"]), "assumptions": list(ASSUMPTIONS),
            "method": "exact_bitmask_belief_dp",
            "stage1": dict(zip(("probability_n", "no_entry_probability", "empty_probability", "nonempty_probability", "conditional_support"), stage)),
            "risk": risk}
    for row in result["probabilities"]:
        row["p"] = probability(row["p"])
        row["presence_probability"] = probability(row["presence_probability"])
    for key in ("probability_n", "no_entry_probability", "empty_probability", "nonempty_probability"):
        if result["stage1"][key] is not None:
            result["stage1"][key] = probability(result["stage1"][key])
    for key in ("next_target_probability", "remaining_zero_target_probability", "fixed_all_remaining_hit_probability",
                "policy_future_hit_probability", "policy_final_no_target_probability", "policy_loss_probability"):
        risk[key] = probability(risk[key])
    for key in ("remaining_target_distribution", "outcome_distribution"):
        for row in risk[key]:
            row["p"] = probability(row["p"])
    return result


def recommend(state, ids):
    observed = id_mask([e["item_id"] for e in state["events"] if e["status"] == "active"], ids)
    config = state["config"]
    result = _compute(state, ids, observed, prior_for(config, ids))
    result["comparison"] = None
    if config["mechanism"]["kind"] != "random_removal":
        baseline = _compute(state, ids, observed, prior_for(config, ids, baseline=True))
        result["comparison"] = {
            "baseline": {key: baseline[key] for key in ("action", "next_ev", "next_net", "optimal_value", "risk")},
            "predictive_differs": any(abs(a["p"] - b["p"]) > EPS for a, b in zip(result["probabilities"], baseline["probabilities"])),
            "action_disagrees": result["action"] != baseline["action"], "unverified_behavior": True}
    return result


def dispatch(request, catalog):
    version, ids = catalog_info(catalog)
    if not isinstance(request, dict):
        fail("INVALID_INPUT", "Request must be a JSON object")
    shapes = {"create": {"op", "input"}, "recommend": {"op", "state"},
              "record": {"op", "state", "event_id", "item_id"}, "undo": {"op", "state", "event_id"},
              "restore": {"op", "payload"}}
    op = request.get("op")
    if not isinstance(op, str) or op not in shapes or set(request) != shapes[op]:
        fail("INVALID_INPUT", "Unknown operation or invalid request fields")
    if op == "create":
        return create(request["input"], version, ids)
    if op == "restore":
        return restore(request["payload"], version, ids)
    state = restore(request["state"], version, ids)
    if op == "recommend":
        return recommend(state, ids)
    key = text_id(request["event_id"], "event_id")
    if op == "undo":
        event = next((e for e in state["events"] if e["event_id"] == key), None)
        if event is None:
            fail("UNKNOWN_EVENT", "Unknown undo target event_id")
        event["status"] = "undone"
        return state
    item_id = request["item_id"]
    if not isinstance(item_id, str) or item_id not in ids:
        fail("UNKNOWN_ITEM", "Unknown item_id")
    existing = next((e for e in state["events"] if e["event_id"] == key), None)
    if existing is not None:
        if existing["item_id"] != item_id:
            fail("EVENT_CONFLICT", "event_id conflicts with its original item")
        return state
    active = {e["item_id"] for e in state["events"] if e["status"] == "active"}
    if item_id in active:
        fail("DUPLICATE_ITEM", "This individual variant has already been recorded")
    if len(active) >= state["config"]["initial_remaining"]:
        fail("EMPTY", "Physical inventory is empty")
    config = state["config"]
    if config["budget"] is not None and (len(active) + 1) * cents(config["cost"], "INVALID_COST", "cost", True) > cents(config["budget"], "INVALID_BUDGET", "budget"):
        fail("BUDGET", "Insufficient configured budget")
    supported(config, ids, id_mask([*active, item_id], ids))
    state["events"].append({"event_id": key, "item_id": item_id, "status": "active"})
    return state
