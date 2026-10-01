"""Prepare data, test GPU training on a small subset, then train the full dataset."""
import json
import os
from pathlib import Path
import subprocess
import sys
import traceback
from datetime import datetime

ROOT = Path(__file__).resolve().parent


def status(stage, **extra):
    content = {'stage': stage, 'time': datetime.now().isoformat(), 'pid': os.getpid(), **extra}
    temporary = ROOT / 'pipeline_status.tmp'
    temporary.write_text(json.dumps(content, indent=2, ensure_ascii=False), encoding='utf-8')
    temporary.replace(ROOT / 'pipeline_status.json')
    print(json.dumps(content, ensure_ascii=False), flush=True)


def main():
    os.chdir(ROOT)
    (ROOT / '.yolo').mkdir(exist_ok=True)
    os.environ.setdefault('YOLO_CONFIG_DIR', str(ROOT / '.yolo'))
    try:
        import torch
        from ultralytics import YOLO
        device = 0 if torch.cuda.is_available() else 'cpu'
        from prepare_dataset import DEFAULT_SOURCE, GROUPS, NAMES
        if (ROOT/'dataset'/'data.yaml').exists() and not (DEFAULT_SOURCE/'data').exists():
            from verify_dataset import verify_dataset
            status('checking_images',note='Using packaged dataset; original source files are optional')
            verify_dataset()
            status('full_training',epochs=100,batch=8,imgsz=640)
            subprocess.run([sys.executable,'-u',str(ROOT/'train.py')],check=True)
            status('completed')
            return
        status('smoke_training', gpu=torch.cuda.get_device_name(0) if device == 0 else 'cpu')
        smoke = ROOT / 'smoke'
        smoke.mkdir(exist_ok=True)
        for group in GROUPS:
            folders = [p for p in (DEFAULT_SOURCE/'label').iterdir() if p.name.startswith(group+'--') or p.name.startswith(group+'_part_')]
            labels = {p.stem:p for folder in folders for p in folder.rglob('*.txt') if p.name != 'classes.txt'}
            images = [p for p in sorted((DEFAULT_SOURCE/'data'/group).rglob('*.jpg')) if p.stem in labels]
            for split, indices in [('train', [0, len(images)//2]), ('val', [len(images)-1])]:
                for kind in ('images', 'labels'):
                    (smoke/kind/split).mkdir(parents=True, exist_ok=True)
                for idx in indices:
                    img = images[idx]
                    stem = group+'__'+img.stem
                    (smoke/'images'/split/(stem+'.jpg')).write_bytes(img.read_bytes())
                    (smoke/'labels'/split/(stem+'.txt')).write_bytes(labels[img.stem].read_bytes())
        config = {'path': smoke.as_posix(), 'train': 'images/train', 'val': 'images/val', 'names': dict(enumerate(NAMES))}
        import yaml
        (smoke/'data.yaml').write_text(yaml.safe_dump(config), encoding='utf-8')
        YOLO('yolov8n.pt').train(data=str(smoke/'data.yaml'), epochs=1, imgsz=640,
            batch=4, device=device, workers=0, project=str(ROOT/'runs'), name='smoke',
            cache=False, plots=False, seed=42)
        status('preparing_dataset', smoke_passed=True)
        if not (ROOT / 'dataset' / 'data.yaml').exists():
            command = [sys.executable, '-u', str(ROOT / 'prepare_dataset.py'), '--prepare']
            if (ROOT / 'dataset').exists():
                command.append('--resume')
            subprocess.run(command, check=True)
        from verify_dataset import verify_dataset
        status('checking_images', smoke_passed=True)
        verify_dataset()
        status('full_training', epochs=100, batch=8, imgsz=640)
        subprocess.run([sys.executable, '-u', str(ROOT/'train.py')], check=True)
        status('completed')
    except Exception as exc:
        status('failed', error=str(exc))
        traceback.print_exc()
        raise


if __name__ == '__main__':
    from multiprocessing import freeze_support
    freeze_support()
    main()
