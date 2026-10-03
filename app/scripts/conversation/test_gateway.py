import copy
import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from conversation_gateway import Engine, Problem, apply_changes, question_for

CONTEXT = {'candidates':[{'stop_code':'01012','stop_name':'Hotel','road_name':'Road','services':['191','7']}], 'selected':{'stop_code':'01012','bus_service':'191'}}
class Stub:
    calls = 0
    result = {'changes':{},'intent':'update'}
    def interpret(self, payload):
        self.calls += 1
        self.last = payload
        return copy.deepcopy(self.result)
    def transcribe(self, audio, candidates): return 'wheelchair, more time please'

class GatewayTests(unittest.TestCase):
    def setUp(self): self.provider=Stub(); self.engine=Engine(self.provider); self.rev=0; self.sid='session-000000001'
    def turn(self,event, context=None, sid=None, tid=None, revision=None):
        body={'version':1,'session_id':sid or self.sid,'turn_id':tid or f'turn-0000000000{self.rev}',
              'revision':self.rev if revision is None else revision,'context':context or CONTEXT,'event':event}
        result=self.engine.turn(body)
        if not sid: self.rev=result['revision']
        return result
    def test_multiple_help_choices(self):
        result = self.turn({'kind':'help', 'actions':['additional_boarding_time','audio_boarding_instruction'], 'ramp':'requested'})
        self.assertEqual(result['draft']['actions'], ['additional_boarding_time','audio_boarding_instruction'])
        self.assertEqual(result['draft']['ramp'], 'requested')
        self.assertEqual(result['question'], 'ready')
        self.assertEqual(self.provider.calls, 0)

    def test_no_automatic_ramp_or_send(self):
        self.provider.result={'changes':{'need':'wheelchair','add_actions':['additional_boarding_time']},'intent':'update'}
        result=self.turn({'kind':'text','text':'wheelchair, more time'})
        self.assertEqual(result['question'],'ramp'); self.assertFalse(result['send_requested'])
        self.assertEqual(result['draft']['ramp'],'unspecified')
    def test_corrections_preserve_other_fields(self):
        self.turn({'kind':'choice','field':'add_actions','value':'additional_boarding_time'})
        self.turn({'kind':'choice','field':'ramp','value':'requested'})
        self.provider.result={'changes':{'ramp':'declined'},'intent':'update'}
        result=self.turn({'kind':'text','text':'no ramp, keep everything else'})
        self.assertEqual(result['draft']['actions'],['additional_boarding_time'])
        self.assertEqual(result['draft']['bus_service'],'191')
        self.assertEqual(result['question'],'ready')
    def test_retry_idempotency_and_conflicting_replay(self):
        body={'version':1,'session_id':self.sid,'turn_id':'fixed-turn-00000001','revision':0,'context':CONTEXT,'event':{'kind':'text','text':'help'}}
        first=self.engine.turn(body); self.assertEqual(first,self.engine.turn(body)); self.assertEqual(self.provider.calls,1)
        body['event']['text']='different'
        with self.assertRaises(Problem) as error: self.engine.turn(body)
        self.assertEqual(error.exception.code,'turn_conflict')
    def test_sessions_do_not_mix(self):
        self.turn({'kind':'choice','field':'ramp','value':'requested'})
        other=self.turn({'kind':'start'},sid='session-000000002',revision=0)
        self.assertEqual(other['draft']['ramp'],'unspecified')
    def test_unknown_action_rejected_atomically(self):
        self.provider.result={'changes':{'ramp':'requested','add_actions':['drive_bus']},'intent':'update'}
        with self.assertRaises(Problem): self.turn({'kind':'text','text':'anything'})
        self.assertEqual(self.engine.sessions[self.sid]['revision'],0)
        self.assertEqual(self.engine.sessions[self.sid]['draft']['ramp'],'unspecified')
    def test_gps_never_selects_stop(self):
        ctx=copy.deepcopy(CONTEXT); ctx['selected']=None; ctx['location_available']=True
        result=self.turn({'kind':'start'},context=ctx)
        self.assertEqual(result['question'],'stop'); self.assertIsNone(result['draft']['stop_code'])
    def test_buttons_bypass_models(self):
        self.turn({'kind':'choice','field':'ramp','value':'requested'})
        self.assertEqual(self.provider.calls,0)
    def test_vision_and_wheelchair_are_independent(self):
        self.provider.result={'changes':{'need':'wheelchair','vision_support':True,'ramp':'requested'},'intent':'update'}
        result=self.turn({'kind':'text','text':'I use a wheelchair and cannot see'})
        self.assertTrue(result['draft']['vision_support']); self.assertEqual(result['draft']['need'],'wheelchair')
    def test_short_answer_receives_question_and_draft(self):
        self.provider.result={'changes':{'need':'wheelchair'},'intent':'update'}
        self.turn({'kind':'text','text':'wheelchair'})
        self.provider.result={'changes':{'ramp':'declined'},'intent':'update'}
        self.turn({'kind':'text','text':'no'})
        self.assertEqual(self.provider.last['last_question'],'ramp')
        self.assertEqual(self.provider.last['draft']['need'],'wheelchair')
    def test_stale_turn_rejected(self):
        self.turn({'kind':'start'})
        with self.assertRaises(Problem): self.turn({'kind':'start'},revision=0)
    def test_no_unvalidated_service_can_be_sent(self):
        self.provider.result={'changes':{'bus_service':'999','ramp':'requested'},'intent':'send'}
        result=self.turn({'kind':'text','text':'send for bus 999'})
        self.assertEqual(result['question'],'bus'); self.assertFalse(result['send_requested'])
    def test_voice_send_only_after_complete(self):
        self.provider.result={'changes':{},'intent':'send'}
        self.assertFalse(self.turn({'kind':'text','text':'send'})['send_requested'])
        self.turn({'kind':'choice','field':'ramp','value':'requested'})
        self.assertTrue(self.turn({'kind':'text','text':'send'})['send_requested'])
    def test_stop_correction_clears_selected_stop(self):
        self.provider.result={'changes':{'stop_query':'another hotel'},'intent':'update'}
        result=self.turn({'kind':'text','text':'actually another hotel'})
        self.assertIsNone(result['draft']['stop_code']); self.assertEqual(result['question'],'stop')


    def test_negated_send_cannot_submit_even_if_model_misclassifies(self):
        self.turn({'kind':'choice','field':'ramp','value':'requested'})
        self.provider.result={'changes':{},'intent':'send'}
        self.assertFalse(self.turn({'kind':'text','text':"don't send my request"})['send_requested'])

    def test_explicit_feedback_correction_survives_later_buttons(self):
        self.provider.result={'changes':{'need':'visual_accessibility','vision_support':False},'intent':'update'}
        self.turn({'kind':'text','text':'turn off spoken feedback'})
        result=self.turn({'kind':'choice','field':'ramp','value':'declined'})
        self.assertFalse(result['draft']['vision_support'])

    def test_provider_requests_use_application_user_agent(self):
        from unittest.mock import patch
        from conversation_gateway import upstream
        with patch('conversation_gateway.urllib.request.urlopen') as opened:
            opened.return_value.__enter__.return_value.read.return_value = b'{"ok":true}'
            self.assertEqual(upstream('https://api.groq.com/test', 'test-only-key', b'{}'), {'ok':True})
            request = opened.call_args.args[0]
            self.assertEqual(request.get_header('User-agent'), 'BusPulseAssistant/1.0')

    def test_search_completion_describes_candidate_and_never_sends(self):
        ctx=copy.deepcopy(CONTEXT); ctx['selected']=None
        self.provider.result={'changes':{'stop_query':'B4 the Synergy'},'intent':'update'}
        self.turn({'kind':'text','text':'B4 the Synergy'},context=ctx)
        ctx['candidates']=[{'stop_code':'11111','stop_name':'Bef The Synergy','road_name':'Test Road','services':['191']}]
        ctx['stop_matches']=['11111']
        calls=self.provider.calls
        result=self.turn({'kind':'stops'},context=ctx)
        self.assertIn('Is this your stop: Bef The Synergy',result['message'])
        self.assertEqual(self.provider.calls,calls)
        self.assertIsNone(result['draft']['stop_code'])
        self.assertFalse(result['send_requested'])
        result=self.turn({'kind':'choice','field':'stop_code','value':'11111'},context=ctx)
        self.assertEqual(result['question'],'bus')

    def test_search_without_matches_explains_recovery(self):
        ctx=copy.deepcopy(CONTEXT);ctx['selected']=None
        self.provider.result={'changes':{'stop_query':'Atlantis'},'intent':'update'}
        self.turn({'kind':'text','text':'Atlantis'},context=ctx)
        ctx['stop_matches']=[]
        result=self.turn({'kind':'stops'},context=ctx)
        self.assertIn("couldn't find a stop",result['message'])
        self.assertNotIn('Where will you board',result['message'])

    def test_ambiguous_stop_names_remain_unselected(self):
        ctx=copy.deepcopy(CONTEXT);ctx['selected']=None
        self.provider.result={'changes':{'stop_query':'Hotel'},'intent':'update'}
        self.turn({'kind':'text','text':'Hotel'},context=ctx)
        ctx['candidates'].append({'stop_code':'01013','stop_name':'Hotel','road_name':'Other road','services':['7']})
        ctx['stop_matches']=['01012','01013']
        result=self.turn({'kind':'stops'},context=ctx)
        self.assertIn('Which stop do you mean',result['message'])
        self.assertIsNone(result['draft']['stop_code'])

    def test_ambiguous_yes_cannot_select_even_if_model_guesses(self):
        ctx=copy.deepcopy(CONTEXT);ctx['selected']=None
        self.provider.result={'changes':{'stop_query':'Hotel'},'intent':'update'}
        self.turn({'kind':'text','text':'Hotel'},context=ctx)
        ctx['candidates'].append({'stop_code':'01013','stop_name':'Hotel','road_name':'Other road','services':['7']})
        ctx['stop_matches']=['01012','01013']
        self.turn({'kind':'stops'},context=ctx)
        self.provider.result={'changes':{'stop_code':'01012'},'intent':'update'}
        result=self.turn({'kind':'text','text':'yes'},context=ctx)
        self.assertIsNone(result['draft']['stop_code'])
        self.assertIn('Which stop',result['message'])

class HTTPBoundaryTests(unittest.TestCase):
    def setUp(self):
        from http.server import ThreadingHTTPServer
        from conversation_gateway import Handler
        import threading
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.token='test-secret'; self.server.config={}; self.server.engine=Engine(Stub())
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True); self.thread.start()
        self.url='http://127.0.0.1:'+str(self.server.server_port)
    def tearDown(self): self.server.shutdown(); self.server.server_close(); self.thread.join()
    def test_health_requires_access_code(self):
        import urllib.request, urllib.error
        with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(self.url+'/health')
        self.assertEqual(error.exception.code,401)
        error.exception.close()
        req=urllib.request.Request(self.url+'/health',headers={'Authorization':'Bearer test-secret'})
        with urllib.request.urlopen(req) as result: self.assertEqual(json.load(result),{'ready':False})
    def test_json_contract_over_http(self):
        import urllib.request
        body={'version':1,'session_id':'session-111111111','turn_id':'turn-11111111111','revision':0,'context':CONTEXT,'event':{'kind':'choice','field':'ramp','value':'requested'}}
        req=urllib.request.Request(self.url+'/v1/turn', data=json.dumps(body).encode(),headers={'Authorization':'Bearer test-secret','Content-Type':'application/json'})
        with urllib.request.urlopen(req) as result:
            reply=json.load(result)
            self.assertEqual(reply['question'],'ready'); self.assertFalse(reply['send_requested'])
            self.assertEqual(result.headers['Cache-Control'],'no-store')

if __name__=='__main__': unittest.main()
