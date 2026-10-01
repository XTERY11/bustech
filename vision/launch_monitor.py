"""Start interactive monitoring with the backend selected during setup."""
import json
from pathlib import Path
import subprocess
import sys

root = Path(__file__).resolve().parent
settings = root/'runtime_backend.json'
device = json.loads(settings.read_text()).get('device','auto') if settings.exists() else 'auto'
raise SystemExit(subprocess.call([sys.executable,str(root/'monitor_zone.py'),'--choose-source','--device',device,*sys.argv[1:]],cwd=root))
