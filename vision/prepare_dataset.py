"""Audit and prepare Bustech YOLO detection data without modifying the source."""
import argparse
import collections
import csv
import json
import math
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

from project_paths import source_root
DEFAULT_SOURCE = source_root()
NAMES = ['cane', 'stroller', 'wheelchair_with', 'wheelchair_without']
GROUPS = ['cane', 'stroller', 'wheelchair_with_people', 'wheelchair_without_people']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, default=DEFAULT_SOURCE)
    parser.add_argument('--output', type=Path, default=Path(__file__).parent / 'dataset')
    parser.add_argument('--prepare', action='store_true', help='Copy matched images and labels after validation')
    parser.add_argument('--resume', action='store_true', help='Resume an interrupted preparation with identical source and split settings')
    parser.add_argument('--gap-seconds', type=float, default=2.0)
    args = parser.parse_args()
    if args.gap_seconds < 0:
        parser.error('--gap-seconds must be nonnegative')
    report = {'source': str(args.source), 'classes': NAMES, 'groups': {}, 'errors': [], 'missing_labels': [], 'orphan_labels': []}
    records = []
    for group in GROUPS:
        labels = {}
        folders = [p for p in (args.source / 'label').iterdir() if p.is_dir() and (p.name.startswith(group + '--') or p.name.startswith(group + '_part_'))]
        for folder in folders:
            for p in sorted(folder.rglob('*.txt')):
                content = p.read_text(encoding='utf-8-sig').strip()
                if p.name == 'classes.txt':
                    if content.splitlines() != NAMES:
                        report['errors'].append(f'Class order mismatch: {p}')
                    continue
                if p.stem in labels:
                    report['errors'].append(f'Duplicate label: {group}/{p.stem}')
                labels[p.stem] = (p, content)
        images = sorted((args.source / 'data' / group).rglob('*.jpg'))
        if not images or not folders:
            report['errors'].append(f'Missing images or label folders: {group}')
        if len({p.stem for p in images}) != len(images):
            report['errors'].append(f'Duplicate image names: {group}')
        counts = collections.Counter()
        matched = []
        empty = 0
        for img in images:
            entry = labels.pop(img.stem, None)
            if entry is None:
                report['missing_labels'].append(str(img))
                continue
            label, content = entry
            if not content:
                empty += 1
            for line in content.splitlines():
                try:
                    tokens = line.split()
                    assert len(tokens) == 5, 'expected class x y width height'
                    cls = int(tokens[0])
                    x, y, w, h = map(float, tokens[1:])
                    assert 0 <= cls < len(NAMES), 'invalid class'
                    assert all(math.isfinite(v) for v in (x, y, w, h)), 'nonfinite coordinate'
                    assert 0 <= x <= 1 and 0 <= y <= 1 and 0 < w <= 1 and 0 < h <= 1, 'invalid normalized box'
                    assert min(x-w/2, y-h/2) >= -1e-5 and max(x+w/2, y+h/2) <= 1.00001, 'box outside image'
                    counts[NAMES[cls]] += 1
                except (ValueError, AssertionError) as exc:
                    report['errors'].append(f'{label}: {line}: {exc}')
            matched.append((img, label, content, int(img.stem.split('_')[-1])))
        report['orphan_labels'].extend(str(p) for p, _ in labels.values())
        meta = json.loads((args.source / 'data' / group / 'metadata.json').read_text(encoding='utf-8-sig'))
        # Contiguous temporal holdout avoids randomly interleaving adjacent video frames.
        matched.sort(key=lambda r: r[3])
        splits = collections.Counter()
        if matched:
            boundary = matched[min(int(len(matched)*0.8), len(matched)-1)][3]
            gap = round(meta['fps'] * args.gap_seconds)
            for img, label, content, frame in matched:
                split = 'train' if frame < boundary-gap else ('val' if frame >= boundary+gap else 'gap')
                splits[split] += 1
                records.append({'group': group, 'image': str(img), 'label': str(label), 'split': split, 'frame': frame, 'content': content})
        report['groups'][group] = {'images': len(images), 'matched': len(matched), 'empty_labels': empty, 'boxes': dict(counts), 'split': dict(splits), 'source_video': meta['video']}
    report['split_note'] = 'Per-video chronological 80/20 split with 2-sided temporal gap; same-video validation is not an independent generalization test.'
    report['gap_seconds_each_side'] = args.gap_seconds
    report_path = Path(__file__).parent / 'audit_report.json'
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k not in ('missing_labels','orphan_labels','errors')}, ensure_ascii=False, indent=2))
    print(f"Missing labels: {len(report['missing_labels'])}; orphan labels: {len(report['orphan_labels'])}; errors: {len(report['errors'])}")
    if report['errors']:
        raise SystemExit(f'Fix validation errors in {report_path}')
    if not args.prepare:
        return
    marker = args.output / 'preparation.json'
    signature = {'source': str(args.source.resolve()), 'gap_seconds': args.gap_seconds}
    if args.output.exists() and not args.resume:
        raise SystemExit(f'Refusing to overwrite existing dataset: {args.output}')
    if args.resume and marker.exists() and json.loads(marker.read_text()) != signature:
        raise SystemExit('Resume settings differ from original preparation')
    if args.resume and (args.output / 'data.yaml').exists():
        raise SystemExit('Dataset is already complete; use a new output directory')
    for split in ('train', 'val'):
        for kind in ('images', 'labels'):
            (args.output / kind / split).mkdir(parents=True, exist_ok=True)
    marker.write_text(json.dumps(signature), encoding='utf-8')
    def copy_record(row):
        stem = row['group'] + '__' + Path(row['image']).stem
        destination = args.output / 'images' / row['split'] / (stem + '.jpg')
        if not destination.exists() or destination.stat().st_size != Path(row['image']).stat().st_size:
            temporary = destination.with_suffix('.partial')
            temporary.write_bytes(Path(row['image']).read_bytes())
            temporary.replace(destination)
        (args.output / 'labels' / row['split'] / (stem + '.txt')).write_text(row['content'] + '\n', encoding='utf-8')
    usable = [r for r in records if r['split'] != 'gap']
    with ThreadPoolExecutor(max_workers=12) as pool:
        for i, _ in enumerate(pool.map(copy_record, usable), 1):
            if i % 100 == 0:
                print(f'Copied {i}/{len(usable)}', flush=True)
    config = f'path: {json.dumps(args.output.resolve().as_posix())}\ntrain: images/train\nval: images/val\nnames:\n'
    config += ''.join(f'  {i}: {name}\n' for i, name in enumerate(NAMES))
    (args.output / 'data.yaml').write_text(config, encoding='utf-8')
    with (args.output / 'manifest.csv').open('w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=['group','image','label','split','frame'])
        writer.writeheader()
        writer.writerows({k:v for k,v in r.items() if k != 'content'} for r in records)
    print(f'Prepared {args.output.resolve()}')


if __name__ == '__main__':
    main()
