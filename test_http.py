"""New web API integration tests; creates a temporary loopback-only server."""
from functools import partial
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from server import Handler, create_server

ROOT = Path(__file__).resolve().parent


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


class WebHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads((ROOT / 'public/data/box54.json').read_text(encoding='utf-8'))
        cls.httpd = ThreadingHTTPServer(('127.0.0.1', 0), partial(QuietHandler, catalog=cls.catalog))
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f'http://127.0.0.1:{cls.httpd.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join(2)

    def post(self, payload):
        req = Request(self.url + '/api/dispatch', data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'}, method='POST')
        try:
            response = urlopen(req, timeout=15)
        except HTTPError as exc:
            with exc:
                return exc.code, json.loads(exc.read())
        with response:
            return response.status, json.loads(response.read())

    def call(self, payload):
        status, result = self.post(payload)
        self.assertEqual(status, 200, result)
        self.assertTrue(result['ok'])
        return result['result']

    def create_input(self, remaining=11, budget=None):
        by_role = {'r1': 100, 'r2': 100, 'r3': 60, 'r4': 60, 'r5': 20, 'r6': 0, 'r7': 0}
        return {'session_id': 'http-roleplay', 'box_id': '54.0', 'initial_remaining': remaining,
                'mode': 'preference', 'values': {i['id']: by_role[i['role_id']] for i in self.catalog['items']},
                'cost': 25, 'budget': budget, 'packing_ack': True, 'valuation_meta': {'kind': 'explicit_values'},
                'target_ids': ['54-r1-e1', '54-r1-e2'], 'mechanism': {'kind': 'random_removal'}}

    def test_roleplay_full_http_flow_and_idempotent_undo_restore(self):
        state = self.call({'op': 'create', 'input': self.create_input()})
        before = json.dumps(state, sort_keys=True)
        self.call({'op': 'recommend', 'state': state})
        self.assertEqual(json.dumps(state, sort_keys=True), before)
        one = self.call({'op': 'record', 'state': state, 'event_id': 'e', 'item_id': '54-r5-e1'})
        a = self.call({'op': 'recommend', 'state': one})
        self.assertEqual((a['actual_remaining'], a['latent_count']), (10, 13))
        self.assertAlmostEqual(a['next_net'], 335 / 13, places=9)
        two = self.call({'op': 'record', 'state': one, 'event_id': 'f', 'item_id': '54-r6-e2'})
        a = self.call({'op': 'recommend', 'state': two})
        self.assertEqual((a['actual_remaining'], a['latent_count']), (9, 12))
        self.assertEqual(a['max_future_draws'], 9)
        self.assertAlmostEqual(a['next_ev'], 55)
        self.assertAlmostEqual(a['next_net'], 30)
        grouped = {}
        for row in a['probabilities']:
            grouped[row['value']] = grouped.get(row['value'], 0) + row['p']
        for value, expected in {100: 4/12, 60: 4/12, 20: 1/12, 0: 3/12}.items():
            self.assertAlmostEqual(grouped[value], expected)
        self.assertEqual(self.call({'op': 'record', 'state': two, 'event_id': 'f', 'item_id': '54-r6-e2'}), two)
        undone = self.call({'op': 'undo', 'state': two, 'event_id': 'f'})
        self.assertEqual(self.call({'op': 'undo', 'state': undone, 'event_id': 'f'}), undone)
        self.assertEqual(self.call({'op': 'record', 'state': undone, 'event_id': 'f', 'item_id': '54-r6-e2'}), undone)
        self.assertEqual(self.call({'op': 'restore', 'payload': json.dumps(undone)}), undone)

    def test_validation_errors_are_http400_not_success(self):
        for change in ({'cost': ''}, {'packing_ack': False}, {'initial_remaining': 15}, {'box_id': '53.0'}):
            with self.subTest(change=change):
                status, result = self.post({'op': 'create', 'input': {**self.create_input(), **change}})
                self.assertEqual(status, 400)
                self.assertFalse(result['ok'])
        value = self.create_input()
        value['mode'] = 'price'
        value['values']['54-r1-e1'] = None
        status, result = self.post({'op': 'create', 'input': value})
        self.assertEqual(status, 400)
        self.assertFalse(result['ok'])
        state = self.call({'op': 'create', 'input': self.create_input()})
        state = self.call({'op': 'record', 'state': state, 'event_id': 'one', 'item_id': '54-r5-e1'})
        for event_id, item in [('two', '54-r5-e1'), ('one', '54-r6-e2')]:
            status, result = self.post({'op': 'record', 'state': state, 'event_id': event_id, 'item_id': item})
            self.assertEqual(status, 400)
            self.assertFalse(result['ok'])

    def test_physical_empty_and_optional_budget_are_distinct(self):
        state = self.call({'op': 'create', 'input': self.create_input(remaining=0)})
        result = self.call({'op': 'recommend', 'state': state})
        self.assertEqual(result['reason'], 'empty')
        self.assertIsNone(result['next_ev'])
        self.assertTrue(all(p['p'] == 0 for p in result['probabilities']))
        state = self.call({'op': 'create', 'input': self.create_input(budget=24.99)})
        result = self.call({'op': 'recommend', 'state': state})
        self.assertEqual(result['reason'], 'budget')
        self.assertEqual(result['max_future_draws'], 0)
        state = self.call({'op': 'create', 'input': self.create_input()})
        result = self.call({'op': 'recommend', 'state': state})
        self.assertIsNone(result['remaining_budget'])
        self.assertEqual(result['max_future_draws'], 11)

    def test_production_server_reserves_its_loopback_port(self):
        first = create_server(0)
        try:
            self.assertEqual(first.server_address[0], '127.0.0.1')
            with self.assertRaises(OSError):
                duplicate = create_server(first.server_port)
                duplicate.server_close()
        finally:
            first.server_close()


    def test_strategy_induced_prior_and_own_observation_http(self):
        targets = ['54-r1-e1', '54-r1-e2']
        for limit, expected_pn, expected_hit, expected_zero in [(1,4/91,1/4,0),(2,9/91,0,1)]:
            with self.subTest(limit=limit):
                inp = self.create_input(remaining=4)
                inp['mechanism'] = {'kind':'target_stop','target_ids':targets,'hit_limit':limit,'max_draws':14}
                state = self.call({'op':'create','input':inp})
                a = self.call({'op':'recommend','state':state})
                self.assertAlmostEqual(a['stage1']['probability_n'],expected_pn)
                self.assertAlmostEqual(a['risk']['next_target_probability'],expected_hit)
                self.assertAlmostEqual(a['risk']['remaining_zero_target_probability'],expected_zero)
                self.assertIsNotNone(a['comparison'])
                state = self.call({'op':'record','state':state,'event_id':'own','item_id':'54-r3-e1'})
                a = self.call({'op':'recommend','state':state})
                self.assertEqual(a['actual_remaining'],3)
                self.assertAlmostEqual(a['risk']['next_target_probability'],1/3 if limit==1 else 0)

    def test_impossible_n_observation_and_v1_import_http(self):
        inp = self.create_input(remaining=14)
        inp['mechanism'] = {'kind':'target_stop','target_ids':['54-r1-e1'],'hit_limit':1,'max_draws':14}
        status,b = self.post({'op':'create','input':inp})
        self.assertEqual((status,b['error']['code']),(400,'UNSUPPORTED_N'))
        inp['initial_remaining'] = 4
        state = self.call({'op':'create','input':inp})
        before = json.dumps(state,sort_keys=True)
        status,b = self.post({'op':'record','state':state,'event_id':'impossible','item_id':'54-r1-e1'})
        self.assertEqual((status,b['error']['code']),(400,'UNSUPPORTED_OBSERVATION'))
        self.assertEqual(json.dumps(state,sort_keys=True),before)
        state['schema_version'] = 1
        state['model_version'] = 'random-removal-items-v1'
        status,b = self.post({'op':'restore','payload':state})
        self.assertEqual((status,b['error']['code']),(400,'VERSION_MISMATCH'))

    def test_screenshot_synthetic_risk_and_valuation_consistency_http(self):
        inp = self.create_input(remaining=5)
        observed = ['54-r3-e1','54-r7-e2']
        latent = [i['id'] for i in self.catalog['items'] if i['id'] not in observed]
        vals = [200]*2+[120]*4+[0]*4+[-60]*2
        inp['values'] = {i['id']:0 for i in self.catalog['items']}
        inp['values'].update(dict(zip(latent,vals)))
        inp['target_ids'] = latent[:2]
        state = self.call({'op':'create','input':inp})
        for j,item in enumerate(observed):
            state = self.call({'op':'record','state':state,'event_id':str(j),'item_id':item})
        a = self.call({'op':'recommend','state':state})
        self.assertEqual((a['actual_remaining'],a['latent_count'],a['max_future_draws']),(3,12,3))
        self.assertAlmostEqual(a['next_ev'],190/3)
        self.assertAlmostEqual(a['optimal_value'],115)
        self.assertAlmostEqual(a['risk']['next_target_probability'],1/6)
        self.assertAlmostEqual(a['risk']['remaining_zero_target_probability'],6/11)
        self.assertAlmostEqual(a['risk']['fixed_all_remaining_hit_probability'],5/11)
        self.assertAlmostEqual(a['risk']['policy_final_no_target_probability'],6/11)
        self.assertAlmostEqual(a['risk']['expected_additional_spend'],75)
        inp['valuation_meta'] = {'kind':'five_levels','weights':[100,60,20,0,-30],'willingness':200,
                                 'ratings':{i['id']:0 for i in self.catalog['items']}}
        status,b = self.post({'op':'create','input':inp})
        self.assertEqual((status,b['error']['code']),(400,'VALUATION_MISMATCH'))

    def test_static_resources_and_runtime_provider(self):
        self.assertEqual(self.httpd.server_address[0], '127.0.0.1')
        for path in ('/', '/app.mjs', '/api.mjs', '/model.mjs', '/session-policy.mjs', '/styles.css', '/data/box54.json'):
            with self.subTest(path=path), urlopen(self.url + path, timeout=10) as response:
                self.assertEqual(response.status, 200)
                self.assertGreater(len(response.read()), 0)
        with urlopen(self.url + '/runtime-config.json') as response:
            self.assertEqual(json.loads(response.read())['compute'], 'python')


if __name__ == '__main__':
    unittest.main()
