"""Create a fresh local environment for Windows NVIDIA/CPU or macOS/Linux."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys
import venv

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--backend',choices=['nvidia','cpu','auto'],default='auto')
    args = parser.parse_args()
    if sys.version_info < (3,10):
        raise SystemExit('Python 3.10+ is required; Python 3.12 is recommended.')
    backend = args.backend
    if backend == 'auto':
        backend = 'nvidia' if sys.platform != 'darwin' and shutil.which('nvidia-smi') else 'cpu'
    if sys.platform == 'darwin' and backend == 'nvidia':
        raise SystemExit('NVIDIA CUDA is not supported by this launcher on macOS. Use cpu.')
    python = ROOT/'.venv'/('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
    if not python.exists():
        venv.EnvBuilder(with_pip=True).create(ROOT/'.venv')
    def execute(*arguments):
        subprocess.run([str(python),*arguments],cwd=ROOT,check=True)
    execute('-m','pip','install','--upgrade','pip')
    torch_args = ['-m','pip','install','--upgrade','torch==2.11.0','torchvision==0.26.0']
    if backend == 'nvidia':
        torch_args += ['--index-url','https://download.pytorch.org/whl/cu128']
    elif sys.platform != 'darwin':
        torch_args += ['--index-url','https://download.pytorch.org/whl/cpu']
    execute(*torch_args)
    execute('-m','pip','install','-r','requirements-portable.txt')
    execute('-m','pip','check')
    execute('check_install.py','--device','0' if backend == 'nvidia' else 'cpu')
    (ROOT/'runtime_backend.json').write_text('{"device": "'+('0' if backend == 'nvidia' else 'cpu')+'"}',encoding='utf-8')
    print('Setup complete. Use start_monitor.cmd (Windows) or bash start_monitor.sh (macOS/Linux).')


if __name__ == '__main__':
    main()
