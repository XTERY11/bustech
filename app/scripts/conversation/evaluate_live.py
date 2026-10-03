"""Opt-in real DeepSeek text evaluation. Synthetic journeys only; never books.
Run from the repository: python3 scripts/conversation/evaluate_live.py
Uses local gateway credentials without printing them. Results go to ignored .local/.
Search ranking and the actual text field are covered separately by Swift/UI tests.
"""
import json
from pathlib import Path
import sys
import time
import uuid
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from conversation_gateway import Engine, Providers, load_config

STOP={'stop_code':'11111','stop_name':'Bef The Synergy','road_name':'Test Road','services':['191','7']}
OTHER={'stop_code':'11112','stop_name':'Opp The Synergy','road_name':'Test Road','services':['7']}
CASES=[
 ('abbreviation','bef the synergy',False,{'query':True}),
 ('speech_homophone','B4 the Synergy',False,{'query':True}),
 ('expanded_name','before the synergy',False,{'query':True}),
 ('typo','bef the synergi',False,{'query':True}),
 ('code','11111',False,{'stop_code':'11111'}),
 ('unknown_code','99999',False,{'query':True}),
 ('unknown_place','Atlantis Space Terminal',False,{'query':True}),
 ('chinese_place','我在 Bef the Synergy 上车',False,{'query':True}),
 ('here','I am here, use the nearest stop',False,{'stop_code':None}),
 ('wheelchair','I use a wheelchair and need more time to board.',True,{'need':'wheelchair','ramp':'unspecified','action':'additional_boarding_time','question':'ramp'}),
 ('time_only','I just need more time to board.',True,{'action':'additional_boarding_time','vision_support':False,'ramp':'unspecified'}),
 ('vision','I cannot see well. Help me identify my bus.',True,{'vision_support':True,'action':'confirm_bus_arrival_identity'}),
 ('hearing','I am deaf. Please show me written boarding guidance.',True,{'vision_support':False,'action':'visual_boarding_confirmation'}),
 ('companion','My companion is blind. I use a wheelchair.',True,{'vision_support':False}),
 ('companion_paraphrase','I need a ramp, and my friend needs audio because she cannot see.',True,{'vision_support':False,'ramp':'unspecified'}),
 ('helper_not_passenger','My friend will help me board. I need more time.',True,{'action':'additional_boarding_time','vision_support':False}),
 ('negative_ramp','I do not need a ramp. I only need more time.',True,{'ramp':'declined','action':'additional_boarding_time'}),
 ('opposite_correction','Not before the Synergy, opposite the Synergy.',True,{'query':True,'stop_code':None}),
 ('multiple_passengers','Book a ramp for me and a separate request for my friend.',True,{'stop_code':'11111','no_send':True}),
 ('unknown_bus','Actually I need bus 999.',True,{'bus_service':'999','question':'bus','no_send':True}),
 ('new_stop','Actually I will board opposite the Synergy.',True,{'query':True,'stop_code':None}),
 ('chinese_help','我坐轮椅，需要坡道和更多上车时间。',True,{'need':'wheelchair','ramp':'requested','action':'additional_boarding_time'}),
]

def check(reply, expected):
    d=reply['draft']; failures=[]
    for k,v in expected.items():
        actual = bool(d.get('stop_query')) if k=='query' else (v in d['actions'] if k=='action' else (not reply['send_requested'] if k=='no_send' else reply['question'] if k=='question' else d.get(k)))
        wanted = True if k in ['action','no_send'] else v
        if actual != wanted: failures.append(f'{k}: expected {wanted!r}, got {actual!r}')
    return failures

def main():
    providers=Providers(load_config()); results=[]
    for label,text,selected,expected in CASES:
        engine=Engine(providers);sid=str(uuid.uuid4())
        ctx={'candidates':[STOP,OTHER], 'selected':{'stop_code':'11111','bus_service':'191'} if selected else None}
        start=engine.turn({'version':1,'session_id':sid,'turn_id':str(uuid.uuid4()),'revision':0,'context':ctx,'event':{'kind':'start'}})
        t=time.monotonic()
        try:
            r=engine.turn({'version':1,'session_id':sid,'turn_id':str(uuid.uuid4()),'revision':start['revision'],'context':ctx,'event':{'kind':'text','text':text}})
            failures=check(r,expected)
            results.append({'case':label,'text':text,'seconds':round(time.monotonic()-t,2),'failures':failures,'reply':r})
            print(label, 'PASS' if not failures else 'FAIL '+str(failures),flush=True)
        except Exception as e: results.append({'case':label,'failures':[type(e).__name__]}); print(label,'ERROR',type(e).__name__,flush=True)
    # Follow-ups with a single confirmed retrieval candidate, then additive and subtractive edits.
    engine=Engine(providers);sid=str(uuid.uuid4());rev=0
    ctx={'candidates':[STOP,OTHER],'selected':None}
    sequence=[
      ({'kind':'text','text':'bef the synergy'},{'query':True}),
      ({'kind':'stops'},{'stop_code':None}),
      ({'kind':'text','text':'yes'},{'stop_code':'11111','question':'bus'}),
      ({'kind':'text','text':'191. I use a wheelchair and need more time.'},{'bus_service':'191','need':'wheelchair','question':'ramp'}),
      ({'kind':'text','text':'yes'},{'ramp':'requested','action':'additional_boarding_time'}),
      ({'kind':'text','text':'No ramp, but keep the extra time.'},{'ramp':'declined','action':'additional_boarding_time'}),
      ({'kind':'text','text':'I also have difficulty seeing. Help me identify my bus.'},{'need':'wheelchair','vision_support':True,'action':'confirm_bus_arrival_identity'}),
      ({'kind':'text','text':"Don't send my request yet."},{'no_send':True}),
      ({'kind':'text','text':'send my request'},{'question':'ready'}),
    ]
    for i,(event,expected) in enumerate(sequence):
        if event['kind']=='stops':ctx['stop_matches']=['11111']
        r=engine.turn({'version':1,'session_id':sid,'turn_id':str(uuid.uuid4()),'revision':rev,'context':ctx,'event':event});rev=r['revision']
        failures=check(r,expected)
        if i==len(sequence)-1 and not r['send_requested']:failures.append('explicit send not recognized')
        results.append({'case':f'followup_{i}','event':event,'failures':failures,'reply':r})
        print(f'followup_{i}', 'PASS' if not failures else 'FAIL '+str(failures),flush=True)
    output=Path(__file__).resolve().parents[2]/'.local'/'stop-dialogue-evaluation.json'
    output.write_text(json.dumps(results,ensure_ascii=False,indent=2))
    failures=sum(bool(r['failures']) for r in results)
    print(f'{len(results)-failures}/{len(results)} passed; report: {output}')
    return bool(failures)
if __name__=='__main__':sys.exit(main())
