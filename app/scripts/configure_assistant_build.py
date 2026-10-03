#!/usr/bin/env python3
"""Embed existing gateway credentials into local distribution builds; no provider keys."""
import argparse,json,os,re
from pathlib import Path
from urllib.parse import urlsplit
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--address',required=True)
a=p.parse_args()
u=urlsplit(a.address)
if u.scheme not in ['http','https'] or not u.hostname or u.username or u.password or u.query or u.fragment or not re.fullmatch(r'[A-Za-z0-9:/._~-]+',a.address):
    p.error('Use a plain http(s) gateway address without credentials, query or fragment.')
config=json.loads((root/'.local/assistant-secrets.json').read_text())
hub=root/'.local/phone-test-hub.json'
values={'ASSISTANT_SERVICE_URL':a.address.replace('://',':/$()/'), 'ASSISTANT_ACCESS_CODE':config['ASSISTANT_TOKEN']}
if hub.exists():values['BUSTECH_BRIDGE_TOKEN']=json.loads(hub.read_text())['BRIDGE_TOKEN']
for key,value in values.items():
    if key!='ASSISTANT_SERVICE_URL' and not re.fullmatch(r'[A-Za-z0-9_-]+',value):p.error('Unsupported access-code characters')
target=root/'Config/Assistant.local.xcconfig'
fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
with os.fdopen(fd,'w') as f:f.write('// Local distribution credentials; excluded from Git.\n'+'\n'.join(f'{k} = {v}' for k,v in values.items())+'\n')
os.chmod(target,0o600)
print('Distribution connection configured. Access codes were not printed. Rebuild the app to apply.')
