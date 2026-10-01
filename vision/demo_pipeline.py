"""Continue the existing extractor, then create and verify all five demos."""
from pathlib import Path
import json
import os
import subprocess
import sys
import time
import psutil

ROOT = Path(__file__).resolve().parent
os.chdir(ROOT)
OUT = ROOT/'demos'


def status(stage, **extra):
    payload = {'stage':stage,'updated':time.strftime('%Y-%m-%d %H:%M:%S'),'pid':os.getpid(),**extra}
    (OUT/'pipeline_status.json').write_text(json.dumps(payload,indent=2),encoding='utf-8')
    print(json.dumps(payload),flush=True)


try:
    # Reuse work already dispatched, without starting competing video readers.
    existing = []
    for proc in psutil.process_iter(['name','cmdline']):
        cmd = proc.info['cmdline'] or []
        if (proc.info['name'] or '').lower() == 'python.exe' and 'make_demos.py' in cmd and '--extract-only' in cmd:
            existing.append(proc)
    status('downloading_and_extracting',extractor_pids=[p.pid for p in existing])
    while existing:
        existing = [p for p in existing if p.is_running()]
        ready = len(list((OUT/'clips').glob('*.json')))
        if ready == 5:
            break
        if not existing:
            break
        time.sleep(15)
    status('generating_demos')
    subprocess.run([sys.executable,'-u',str(ROOT/'make_demos.py')],check=True)
    status('completed',page=str(OUT/'index.html'))
except Exception as exc:
    status('failed',error=str(exc))
    raise
