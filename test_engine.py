"""v0.2 exact posterior, public-policy risk and immutable-ledger regressions."""
from copy import deepcopy
from fractions import Fraction as F
from itertools import combinations
import json
import math
import unittest

from engine import ModelError, MODEL_VERSION, dispatch


def fixture_catalog():
    return {"schema_version": 1, "catalog_version": "synthetic-test-v2", "box_id": "54.0",
            "items": [{"id": f"54-r{r}-e{e}", "role_name": chr(64+r), "edition": f"ELITE{e}"}
                      for r in range(1, 8) for e in (1, 2)]}


class EngineV2Tests(unittest.TestCase):
    def setUp(self):
        self.catalog = fixture_catalog()
        self.ids = [i["id"] for i in self.catalog["items"]]

    def call(self, op, **kwargs):
        return dispatch({"op": op, **kwargs}, self.catalog)

    def state(self, n=4, values=None, mode="price", cost=25, budget=None,
              targets=None, mechanism=None, meta=None, session_id="test-v2"):
        return self.call("create", input={"session_id": session_id, "box_id": "54.0",
            "initial_remaining": n, "mode": mode, "values": dict(zip(self.ids, [50]*14 if values is None else values)),
            "cost": cost, "budget": budget, "packing_ack": True,
            "valuation_meta": meta or {"kind": "prices" if mode == "price" else "explicit_values"},
            "target_ids": self.ids[:2] if targets is None else targets,
            "mechanism": {"kind": "random_removal"} if mechanism is None else mechanism})

    def target_stop(self, hit=1, cap=14):
        return {"kind": "target_stop", "target_ids": self.ids[:2], "hit_limit": hit, "max_draws": cap}

    def advice(self, state):
        return self.call("recommend", state=state)

    def record(self, state, index, event=None):
        return self.call("record", state=state, event_id=event or f"event-{index}", item_id=self.ids[index])

    def assert_code(self, code, op, **kwargs):
        with self.assertRaises(ModelError) as raised:
            self.call(op, **kwargs)
        self.assertEqual(raised.exception.code, code)

    def histogram(self, advice):
        return [r["p"] for r in advice["risk"]["remaining_target_distribution"]]

    def test_v2_schema_and_explicit_v1_rejection(self):
        state=self.state()
        self.assertEqual((state["schema_version"],state["model_version"]),(2,"residual-items-v2"))
        old=deepcopy(state);old["schema_version"]=1;old["model_version"]="random-removal-items-v1"
        self.assert_code("VERSION_MISMATCH","restore",payload=old)

    def test_random_prior_is_normalized_and_n_exogenous(self):
        a=self.advice(self.state())
        self.assertAlmostEqual(sum(x["p"] for x in a["probabilities"]),1)
        self.assertAlmostEqual(sum(x["presence_probability"] for x in a["probabilities"]),4)
        self.assertEqual(a["stage1"]["conditional_support"],math.comb(14,4))
        self.assertIsNone(a["stage1"]["probability_n"])
        self.assertIsNone(a["comparison"])

    def test_same_n_first_target_rule_hand_reference(self):
        a=self.advice(self.state(mechanism=self.target_stop(1)))
        self.assertAlmostEqual(a["stage1"]["probability_n"],4/91)
        self.assertEqual(a["stage1"]["conditional_support"],440)
        self.assertEqual(self.histogram(a),[0,1,0])
        self.assertAlmostEqual(a["risk"]["next_target_probability"],1/4)
        self.assertEqual(a["risk"]["fixed_all_remaining_hit_probability"],1)

    def test_same_n_all_target_rule_hand_reference(self):
        a=self.advice(self.state(mechanism=self.target_stop(2)))
        self.assertAlmostEqual(a["stage1"]["probability_n"],9/91)
        self.assertEqual(a["stage1"]["conditional_support"],495)
        self.assertEqual(self.histogram(a),[1,0,0])
        self.assertEqual(a["risk"]["next_target_probability"],0)
        self.assertEqual(a["risk"]["policy_future_hit_probability"],0)

    def test_same_n_baseline_target_histogram_hand_reference(self):
        a=self.advice(self.state())
        for got,expected in zip(self.histogram(a),[F(495,1001),F(440,1001),F(66,1001)]):
            self.assertAlmostEqual(got,float(expected))
        self.assertAlmostEqual(a["risk"]["fixed_all_remaining_hit_probability"],506/1001)

    def test_non_target_own_observation_updates_strategic_belief(self):
        s=self.state(mechanism=self.target_stop(1))
        before=self.advice(s)
        self.assertAlmostEqual(before["probabilities"][2]["p"],1/16)
        s=self.record(s,2)
        a=self.advice(s)
        self.assertEqual(a["actual_remaining"],3)
        self.assertAlmostEqual(a["risk"]["next_target_probability"],1/3)
        self.assertEqual(self.histogram(a),[0,1,0])
        self.assertEqual(a["stage1"]["conditional_support"],440)

    def test_observed_target_changes_new_vs_final_success(self):
        s=self.record(self.state(mechanism=self.target_stop(1)),0)
        a=self.advice(s)
        self.assertEqual(a["risk"]["already_observed_target_count"],1)
        self.assertEqual(a["risk"]["policy_future_hit_probability"],0)
        self.assertEqual(a["risk"]["policy_final_no_target_probability"],0)
        self.assertEqual(a["risk"]["remaining_zero_target_probability"],1)

    def test_user_targets_are_independent_of_predecessor_targets(self):
        a=self.advice(self.state(mechanism=self.target_stop(2),targets=self.ids[2:4]))
        self.assertAlmostEqual(a["risk"]["next_target_probability"],2/12)
        self.assertAlmostEqual(a["risk"]["remaining_zero_target_probability"],F(14,33))

    def test_unsupported_n_rejected_not_given_fake_prior(self):
        input_={"session_id":"s",**self.state()["config"]}
        input_["mechanism"]={"kind":"fixed_draws","draws":1}
        self.assert_code("UNSUPPORTED_N","create",input=input_)

    def test_unsupported_observation_record_is_atomic(self):
        s=self.state(mechanism=self.target_stop(2));before=deepcopy(s)
        self.assert_code("UNSUPPORTED_OBSERVATION","record",state=s,event_id="impossible",item_id=self.ids[0])
        self.assertEqual(s,before)

    def test_unsupported_observation_restore_checks_undone_event_too(self):
        s=self.state(mechanism=self.target_stop(2))
        s["events"]=[{"event_id":"old","item_id":self.ids[0],"status":"undone"}]
        self.assert_code("UNSUPPORTED_OBSERVATION","restore",payload=s)

    def test_fixed_draw_mechanism_matches_uniform_conditional_baseline(self):
        a=self.advice(self.state(n=11,mechanism={"kind":"fixed_draws","draws":3}))
        self.assertAlmostEqual(a["stage1"]["probability_n"],1)
        self.assertEqual(a["stage1"]["conditional_support"],math.comb(14,11))
        self.assertFalse(a["comparison"]["predictive_differs"])
        self.assertFalse(a["comparison"]["action_disagrees"])
        self.assertTrue(a["comparison"]["unverified_behavior"])

    def test_no_entry_cap_zero_preserves_full_box(self):
        a=self.advice(self.state(n=14,mechanism=self.target_stop(1,0)))
        self.assertEqual(a["stage1"],{"probability_n":1,"no_entry_probability":1,"empty_probability":0,"nonempty_probability":1,"conditional_support":1})

    def test_empty_mechanism_mass_and_empty_risk(self):
        a=self.advice(self.state(n=0,mechanism=self.target_stop(2)))
        self.assertAlmostEqual(a["stage1"]["probability_n"],1/7)
        self.assertAlmostEqual(a["stage1"]["empty_probability"],1/7)
        self.assertEqual(a["reason"],"empty")
        self.assertEqual(a["risk"]["remaining_target_distribution"],[{"count":0,"p":1}])
        self.assertTrue(all(p["p"]==p["presence_probability"]==0 for p in a["probabilities"]))

    def test_public_dp_is_not_average_clairvoyant_optimum(self):
        a=self.advice(self.state(n=1,values=[100]*7+[0]*7,cost=60,targets=self.ids[:7]))
        self.assertEqual(a["action"],"stop")
        self.assertEqual(a["optimal_value"],0)
        self.assertEqual(a["risk"]["expected_additional_spend"],0)
        self.assertAlmostEqual(a["risk"]["fixed_all_remaining_hit_probability"],.5)
        self.assertNotEqual(a["optimal_value"],20)  # clairvoyant E[max(0,u-c)]

    def test_eps_tie_value_and_forward_policy_are_consistent(self):
        a=self.advice(self.state(n=2,values=[1+6e-10]*14,cost=1))
        self.assertLess(a["q_buy"],1e-9)
        self.assertGreater(a["q_buy"],0)
        self.assertEqual(a["action"],"stop")
        self.assertEqual(a["optimal_value"],0)
        self.assertEqual(a["risk"]["expected_additional_draws"],0)

    def test_all_fourteen_targets_keep_every_output_probability_in_range(self):
        a=self.advice(self.state(n=7,targets=self.ids))
        self.assertEqual(a["risk"]["next_target_probability"],1)
        self.assertEqual(a["risk"]["fixed_all_remaining_hit_probability"],1)
        self.assertEqual(a["risk"]["policy_final_no_target_probability"],0)
        for row in a["probabilities"]:
            for key in ("p","presence_probability"):self.assertTrue(0<=row[key]<=1)
        for key,value in a["risk"].items():
            if key.endswith("probability"):self.assertTrue(0<=value<=1,(key,value))
        for key in ("remaining_target_distribution","outcome_distribution"):
            self.assertAlmostEqual(sum(x["p"] for x in a["risk"][key]),1)
            self.assertTrue(all(0<=x["p"]<=1 for x in a["risk"][key]))

    def test_adaptive_risk_hand_reference(self):
        a=self.advice(self.state(n=14,values=[140]+[0]*13,cost=10,budget=20,targets=self.ids[:1]))
        self.assertAlmostEqual(a["next_net"],0)
        self.assertAlmostEqual(a["optimal_value"],5/7)
        r=a["risk"]
        self.assertAlmostEqual(r["expected_additional_draws"],27/14)
        self.assertAlmostEqual(r["expected_additional_spend"],135/7)
        self.assertAlmostEqual(r["policy_loss_probability"],6/7)
        self.assertEqual(r["net_utility_quantiles"],{"p05":-20,"p50":-20,"p95":130})
        expected={(1,1):1/14,(2,0):6/7,(2,1):1/14}
        self.assertEqual(len(r["outcome_distribution"]),3)
        for row in r["outcome_distribution"]:self.assertAlmostEqual(row["p"],expected[(row["draws"],row["target_hits"])])

    def synthetic_scale200(self, broad=False):
        # Explicit synthetic screenshot-shaped case, not recovered actual user values.
        ratings=[3,3,0,0,1,1,1,1,3,3,3,3,4,4]
        weights=[100,60,20,0,-30]
        values=[200*weights[r]/100 for r in ratings]
        meta={"kind":"five_levels","weights":weights,"willingness":200,
              "ratings":dict(zip(self.ids,ratings))}
        s=self.state(n=5,values=values,mode="preference",cost=25,
                     targets=self.ids[2:8] if broad else self.ids[2:4],meta=meta)
        return self.record(self.record(s,0),1)

    def test_synthetic_scale200_value115_is_future_not_hit_probability(self):
        a=self.advice(self.synthetic_scale200())
        self.assertEqual((a["latent_count"],a["actual_remaining"]),(12,3))
        self.assertAlmostEqual(a["next_ev"],190/3)
        self.assertAlmostEqual(a["next_net"],115/3)
        self.assertAlmostEqual(a["optimal_value"],115)
        self.assertAlmostEqual(a["risk"]["expected_additional_spend"],75)
        self.assertEqual(a["spent"],50)  # excluded from the future 115

    def test_synthetic_two_target_hypergeometric_risk(self):
        a=self.advice(self.synthetic_scale200())
        for got,expected in zip(self.histogram(a),[F(6,11),F(9,22),F(1,22)]):self.assertAlmostEqual(got,float(expected))
        self.assertAlmostEqual(a["risk"]["next_target_probability"],1/6)
        self.assertAlmostEqual(a["risk"]["fixed_all_remaining_hit_probability"],5/11)
        self.assertAlmostEqual(a["risk"]["policy_future_hit_probability"],5/11)

    def test_synthetic_six_target_hypergeometric_risk(self):
        a=self.advice(self.synthetic_scale200(True))
        for got,expected in zip(self.histogram(a),[F(1,11),F(9,22),F(9,22),F(1,11)]):self.assertAlmostEqual(got,float(expected))
        self.assertAlmostEqual(a["risk"]["next_target_probability"],1/2)
        self.assertAlmostEqual(a["risk"]["fixed_all_remaining_hit_probability"],10/11)

    def test_terminal_loss_and_quantiles_match_independent_fixed_three_enumeration(self):
        a=self.advice(self.synthetic_scale200())
        nets=sorted(sum([200,200,120,120,120,120,0,0,0,0,-60,-60][i] for i in c)-75
                    for c in combinations(range(12),3))
        self.assertAlmostEqual(a["risk"]["policy_loss_probability"],14/55)
        self.assertAlmostEqual(a["optimal_value"],sum(nets)/len(nets))
        for key,p in (("p05",.05),("p50",.5),("p95",.95)):
            self.assertEqual(a["risk"]["net_utility_quantiles"][key],nets[math.ceil(p*len(nets))-1])

    def test_budget_stop_does_not_change_physical_force_all_risk(self):
        a=self.advice(self.state(n=4,budget=0))
        self.assertEqual(a["reason"],"budget")
        self.assertIsNone(a["q_buy"])
        self.assertEqual(a["risk"]["expected_additional_spend"],0)
        self.assertEqual(a["risk"]["fixed_all_remaining_cost"],100)
        self.assertGreater(a["risk"]["fixed_all_remaining_hit_probability"],0)

    def test_signed_preferences_and_physical_horizon(self):
        s=self.state(n=14,values=[0]*12+[10,-6],mode="preference",cost=4,targets=self.ids[12:13])
        for i in range(12):s=self.record(s,i)
        a=self.advice(s)
        self.assertEqual(a["next_net"],-2)
        self.assertEqual(a["optimal_value"],1)
        self.assertAlmostEqual(a["risk"]["expected_additional_draws"],1.5)
        self.assertEqual(a["risk"]["policy_future_hit_probability"],1)
        self.assertEqual(a["risk"]["policy_loss_probability"],.5)

    def test_target_is_statistic_not_a_hidden_target_only_objective(self):
        a=self.advice(self.state(values=[50]*14,mechanism=self.target_stop(2)))
        self.assertEqual(a["action"],"buy")
        self.assertAlmostEqual(a["optimal_value"],100)
        self.assertEqual(a["risk"]["next_target_probability"],0)
        self.assertTrue(a["comparison"]["predictive_differs"])

    def test_metadata_missing_or_legacy_is_rejected(self):
        for meta in ({},{"kind":"legacy"},{"kind":"five_levels"}):
            input_={"session_id":"s",**self.state(mode="preference")["config"]};input_["valuation_meta"]=meta
            self.assert_code("INVALID_VALUATION_METADATA","create",input=input_)

    def test_five_level_values_must_match_fixed_snapshot(self):
        s=self.synthetic_scale200();s["config"]["values"][self.ids[2]]=100
        self.assert_code("VALUATION_MISMATCH","restore",payload=s)

    def test_price_metadata_cannot_claim_preference_levels(self):
        input_={"session_id":"s",**self.state()["config"]};input_["valuation_meta"]={"kind":"explicit_values"}
        self.assert_code("INVALID_VALUATION_METADATA","create",input=input_)

    def test_invalid_targets_and_mechanism_fields(self):
        for targets in ([],[self.ids[0],self.ids[0]]):
            input_={"session_id":"s",**self.state()["config"]};input_["target_ids"]=targets
            self.assert_code("INVALID_INPUT","create",input=input_)
        input_={"session_id":"s",**self.state()["config"]};input_["mechanism"]={"kind":"unknown"}
        self.assert_code("INVALID_INPUT","create",input=input_)

    def test_price_unknown_and_negative_not_treated_as_zero(self):
        for raw,code in ((None,"UNKNOWN_PRICE"),("","UNKNOWN_PRICE"),(-1,"INVALID_VALUE")):
            input_={"session_id":"s",**self.state()["config"]};input_["values"][self.ids[0]]=raw
            self.assert_code(code,"create",input=input_)

    def test_all_neutral_stops_with_real_target_risk(self):
        a=self.advice(self.state(values=[0]*14,mode="preference"))
        self.assertEqual(a["action"],"stop")
        self.assertEqual(a["risk"]["policy_future_hit_probability"],0)
        self.assertGreater(a["risk"]["fixed_all_remaining_hit_probability"],0)

    def test_recommend_and_failed_record_are_immutable(self):
        s=self.state();before=deepcopy(s);catalog_before=deepcopy(self.catalog)
        a=self.advice(s);a["risk"]["remaining_target_distribution"][0]["p"]=999
        self.assertEqual(s,before);self.assertEqual(self.catalog,catalog_before)

    def test_record_idempotency_conflict_and_undo_tombstone(self):
        s=self.record(self.state(),0,"old")
        self.assertEqual(self.record(s,0,"old"),s)
        self.assert_code("EVENT_CONFLICT","record",state=s,event_id="old",item_id=self.ids[1])
        u=self.call("undo",state=s,event_id="old")
        self.assertEqual(self.call("undo",state=u,event_id="old"),u)
        self.assertEqual(self.record(u,0,"old"),u)
        corrected=self.record(u,0,"new")
        self.assertEqual(self.advice(corrected)["spent"],25)

    def test_duplicate_variant_and_unknown_event_rejected(self):
        s=self.record(self.state(),0)
        self.assert_code("DUPLICATE_ITEM","record",state=s,event_id="another",item_id=self.ids[0])
        self.assert_code("UNKNOWN_EVENT","undo",state=s,event_id="missing")
        self.assert_code("INVALID_INPUT","undo",state=s)

    def test_restore_round_trip_and_unaffordable_tombstone(self):
        s=self.call("undo",state=self.record(self.state(),0),event_id="event-0")
        self.assertEqual(self.call("restore",payload=json.dumps(s)),s)
        bad=self.state(budget=0);bad["events"]=s["events"]
        self.assert_code("INVALID_SESSION","restore",payload=bad)

    def test_restore_tombstone_cannot_duplicate_earlier_active_identity(self):
        s=self.record(self.state(),0)
        s["events"].append({"event_id":"bad-old","item_id":self.ids[0],"status":"undone"})
        self.assert_code("DUPLICATE_ITEM","restore",payload=s)

    def test_inventory_budget_limits_and_final_retry(self):
        s=self.record(self.state(n=1,budget=25),0,"last")
        self.assertEqual(self.record(s,0,"last"),s)
        self.assert_code("EMPTY","record",state=s,event_id="next",item_id=self.ids[1])
        self.assert_code("BUDGET","record",state=self.state(budget=0),event_id="next",item_id=self.ids[1])

    def test_cross_session_event_id_is_not_globally_deduplicated(self):
        a=self.record(self.state(session_id="a"),0,"same")
        b=self.record(self.state(session_id="b"),1,"same")
        self.assertNotEqual(a["events"],b["events"])

    def test_decimal_cost_budget_stays_exact(self):
        s=self.state(cost=.1,budget=.3)
        for i in range(3):s=self.record(s,i)
        a=self.advice(s)
        self.assertEqual((a["spent"],a["remaining_budget"],a["reason"]),(.3,0,"budget"))


if __name__=="__main__":
    unittest.main()
