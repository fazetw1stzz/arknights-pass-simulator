"""Small reproducible synthetic desktop benchmark; no network or file writes."""
from pathlib import Path
from time import perf_counter
import json
import statistics
import sys

import engine


def main():
    catalog=json.loads((Path(__file__).resolve().parent/'public/data/box54.json').read_text(encoding='utf-8'))
    ids=[i['id'] for i in catalog['items']]
    values={item['id']:[200,120,40,0,-60,30,10][j//2] for j,item in enumerate(catalog['items'])}
    cases=[('random_full',14,{'kind':'random_removal'}),
           ('fixed_four',10,{'kind':'fixed_draws','draws':4}),
           ('first_of_two',8,{'kind':'target_stop','target_ids':ids[:2],'hit_limit':1,'max_draws':14})]
    result={'synthetic':True,'python':sys.version.split()[0],
            'note':'Desktop engine only. Excludes process startup, HTTP, concurrent load and phone/browser performance.',
            'cases':[]}
    for label,n,mechanism in cases:
        engine.entry_prior.cache_clear(); engine.terminal_mass.cache_clear()
        inp={'session_id':'synthetic-profile','box_id':'54.0','initial_remaining':n,'mode':'preference',
             'values':values,'cost':25,'budget':None,'packing_ack':True,
             'valuation_meta':{'kind':'explicit_values'},'target_ids':ids[:2],'mechanism':mechanism}
        start=perf_counter()
        state=engine.dispatch({'op':'create','input':inp},catalog)
        advice=engine.dispatch({'op':'recommend','state':state},catalog)
        cold=(perf_counter()-start)*1000
        warm=[]
        for _ in range(3):
            start=perf_counter(); engine.dispatch({'op':'recommend','state':state},catalog)
            warm.append((perf_counter()-start)*1000)
        result['cases'].append({'case':label,'entry_n':n,'cold_create_recommend_ms':round(cold,3),
                                'warm_recommend_mean_ms':round(statistics.mean(warm),3),
                                'warm_recommend_max_ms':round(max(warm),3),
                                'entry_support':advice['stage1']['conditional_support'],
                                'action':advice['action'],'optimal_value':advice['optimal_value']})
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__': main()
