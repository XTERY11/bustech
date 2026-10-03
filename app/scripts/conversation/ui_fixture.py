"""Explicit test-only server: never calls providers or submits a booking."""
from pathlib import Path
import sys
from http.server import ThreadingHTTPServer
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from conversation_gateway import Engine, Handler
class FixtureProviders:
    def interpret(self,payload):
        text=payload['user_text'].lower()
        if 'synergy' in text: return {'changes':{'stop_query':text},'intent':'update'}
        if 'wheelchair' in text: return {'changes':{'need':'wheelchair','add_actions':['additional_boarding_time']},'intent':'update'}
        if 'no ramp' in text: return {'changes':{'ramp':'declined'},'intent':'update'}
        if 'cannot see' in text: return {'changes':{'vision_support':True,'add_actions':['confirm_bus_arrival_identity']},'intent':'update'}
        if '01012' in text: return {'changes':{'stop_query':'01012','bus_service':'191'},'intent':'update'}
        return {'changes':{},'intent':'unclear'}
    def transcribe(self,*args): return 'I use a wheelchair and need more time'
if __name__=='__main__':
    server=ThreadingHTTPServer(('127.0.0.1',18788),Handler)
    server.engine=Engine(FixtureProviders()); server.token='ui-fixture-token'; server.config={}
    print('UI fixture on 18788',flush=True)
    server.serve_forever()
