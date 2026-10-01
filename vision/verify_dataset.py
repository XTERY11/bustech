"""Decode every prepared image and repair invalid local copies from their source."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import io
import json
from pathlib import Path
import subprocess
import sys
from PIL import Image
from project_paths import source_root, configure_yolo

ROOT = Path(__file__).resolve().parent


def verify_dataset():
    with (ROOT/'dataset'/'manifest.csv').open(encoding='utf-8-sig', newline='') as f:
        rows = [r for r in csv.DictReader(f) if r['split'] != 'gap']
    def check(row):
        recorded = Path(row['image'].replace('\\','/'))
        source = recorded if recorded.is_absolute() else source_root()/recorded
        target = ROOT/'dataset'/'images'/row['split']/(row['group']+'__'+recorded.name)
        try:
            with Image.open(target) as img:
                img.load()
            return None
        except (OSError, ValueError) as exc:
            original_error = str(exc)
        data = source.read_bytes()
        # Validate source bytes before replacing the local copy. Never edit source data.
        with Image.open(io.BytesIO(data)) as img:
            img.load()
        temporary = target.with_suffix('.repair')
        temporary.write_bytes(data)
        temporary.replace(target)
        with Image.open(target) as img:
            img.load()
        return {'image': str(target), 'original_error': original_error}
    repaired, errors = [], []
    with ThreadPoolExecutor(max_workers=6) as pool:
        futures = {pool.submit(check, row): row for row in rows}
        for i, future in enumerate(as_completed(futures), 1):
            try:
                result = future.result()
                if result:
                    repaired.append(result)
                    print('Repaired '+result['image'], flush=True)
            except Exception as exc:
                errors.append({'source': futures[future]['image'], 'error': str(exc)})
            if i % 250 == 0:
                print(f'Checked {i}/{len(rows)}', flush=True)
    report = {'checked': len(rows), 'repaired': repaired, 'errors': errors}
    (ROOT/'image_validation_report.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
    print(f'Checked {len(rows)}; repaired {len(repaired)}; errors {len(errors)}', flush=True)
    if errors:
        raise RuntimeError('Some source images could not be recovered; see image_validation_report.json')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--train', action='store_true')
    args = parser.parse_args()
    configure_yolo()
    from run_pipeline import status
    try:
        status('checking_and_repairing_images', smoke_passed=True)
        verify_dataset()
        if args.train:
            status('full_training', epochs=100, batch=8, imgsz=640)
            subprocess.run([sys.executable, '-u', str(ROOT/'train.py')], cwd=ROOT, check=True)
            status('completed')
        else:
            status('images_verified')
    except Exception as exc:
        status('failed', error=str(exc))
        raise
