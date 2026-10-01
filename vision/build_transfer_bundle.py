"""Build portable runtime, prepared dataset and original-material ZIP64 archives."""
import csv
import hashlib
import io
import json
from pathlib import Path
import shutil
import time
import zipfile
from project_paths import ROOT, source_root


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(8*1024*1024),b''):
            h.update(block)
    return h.hexdigest()


def archive(destination, files, manifest_name, compress=False, tolerate_source_errors=False):
    partial = destination.with_suffix('.zip.partial')
    manifest = []
    unavailable = []
    recovered = []
    total = sum(p.stat().st_size for p,_ in files)
    print(f'Packaging {destination.name}: {len(files)} files, {total/1e9:.2f} GB',flush=True)
    completed = 0
    with zipfile.ZipFile(partial,'w',compression=zipfile.ZIP_DEFLATED if compress else zipfile.ZIP_STORED,allowZip64=True,compresslevel=1 if compress else None) as z:
        for i,(path,relative) in enumerate(files,1):
            buffered = None
            if tolerate_source_errors and path.stat().st_size < 10_000_000:
                try:
                    buffered = path.read_bytes()
                except OSError as exc:
                    parts = Path(relative).parts
                    candidates = []
                    if len(parts) >= 4 and parts[1] == 'data' and path.suffix.lower() == '.jpg':
                        candidates = [ROOT/'dataset/images'/split/(parts[2]+'__'+path.name) for split in ('train','val')]
                    fallback = next((p for p in candidates if p.is_file()),None)
                    if fallback:
                        buffered = fallback.read_bytes()
                        recovered.append({'path':relative,'copied_from':fallback.relative_to(ROOT).as_posix()})
                    else:
                        unavailable.append({'path':relative,'expected_bytes':path.stat().st_size,'error':str(exc)})
                        print(f'Unavailable original (not used by packaged training set): {relative}',flush=True)
                        continue
            h = hashlib.sha256()
            length = 0
            zi = zipfile.ZipInfo.from_file(path,arcname='Bustech/'+relative)
            zi.compress_type = z.compression
            if path.suffix in ('.sh','.command'):
                zi.create_system = 3
                zi.external_attr = 0o100755 << 16
            with (io.BytesIO(buffered) if buffered is not None else path.open('rb')) as source,z.open(zi,'w',force_zip64=True) as target:
                for chunk in iter(lambda:source.read(4*1024*1024),b''):
                    target.write(chunk)
                    h.update(chunk)
                    length += len(chunk)
            if length != path.stat().st_size:
                raise RuntimeError(f'Source size changed while packaging: {path}')
            manifest.append({'path':relative,'bytes':length,'sha256':h.hexdigest()})
            completed += length
            if i%500 == 0 or length > 100_000_000 or i == len(files):
                print(f'{destination.name}: {i}/{len(files)}, {completed/1e9:.2f}/{total/1e9:.2f} GB',flush=True)
        z.writestr('Bustech/package_manifests/'+manifest_name+'.json',json.dumps(manifest,indent=2))
        if tolerate_source_errors:
            details = {'unavailable_originals':unavailable,'recovered_from_prepared_dataset':recovered}
            z.writestr('Bustech/package_manifests/original-materials-availability.json',json.dumps(details,indent=2))
            (destination.parent/'original_materials_availability.json').write_text(json.dumps(details,indent=2),encoding='utf-8')
    with zipfile.ZipFile(partial) as z:
        bad = z.testzip()
        if bad:
            raise RuntimeError(f'ZIP CRC failed: {bad}')
    partial.replace(destination)
    summary = {'archive':destination.name,'bytes':destination.stat().st_size,'files':len(manifest),
               'sha256':digest(destination),'crc_verified':True,'unavailable_originals':len(unavailable),'recovered_originals':len(recovered)}
    print(json.dumps(summary),flush=True)
    return summary


def main():
    out = ROOT/'release'
    stage = out/'Bustech'
    stage.mkdir(parents=True,exist_ok=True)
    source = source_root()
    def copy(path,relative=None):
        target = stage/(relative or path.relative_to(ROOT))
        target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(path,target)
        return target
    for pattern in ('*.py','*.cmd','*.sh','*.command','requirements*.txt'):
        for path in ROOT.glob(pattern):
            copy(path)
    for name in ('AGENT_HANDOFF.md','MONITOR_GUIDE.md','monitor_example_roi.json','monitor_demo.mp4','label_preview.jpg','yolov8n.pt'):
        copy(ROOT/name)
    copy(ROOT/'README.md','docs/history/README.original.md')
    for name in ('audit_report.json','image_validation_report.json'):
        copy(ROOT/name,'docs/history/'+name)
    (stage/'README.md').write_text('# Bustech 可迁移项目\n\n先阅读 [AGENT_HANDOFF.md](AGENT_HANDOFF.md)。\n\n- Windows NVIDIA：双击 `setup_windows_nvidia.cmd`。\n- Windows CPU：双击 `setup_windows_cpu.cmd`。\n- macOS/Linux：运行 `bash setup_unix.sh`。\n\n首次需 Python（推荐 3.12）和网络，后续用 `start_monitor.cmd` 或 `bash start_monitor.sh`。\n\n[交互操作说明](MONITOR_GUIDE.md) · [五段演示](demos/index.html) · [区域触发示例](monitor_demo.mp4)\n\n仅运行监测需要 runtime 包；重新训练叠加 training-data 包；重建原始数据或重截视频叠加 original-materials 包。三个包解压到同一个父目录。\n',encoding='utf-8')
    (stage/'AGENTS.md').write_text('# Agent entry point\n\nRead `AGENT_HANDOFF.md` first. The model is already trained. For migration validation use `check_install.py` and the bundled sample video; a fresh training run is not required. Preserve existing weights and user ROI files.\n',encoding='utf-8')
    guide = stage/'MONITOR_GUIDE.md'
    guide.write_text(guide.read_text(encoding='utf-8').replace(str(ROOT),'D:\\Projects\\Bustech'),encoding='utf-8')
    for folder in ('runs/bustech_yolov8n','weights','demos'):
        for path in (ROOT/folder).rglob('*'):
            if not path.is_file() or path.suffix in ('.log','.tmp','.partial') or path.name in ('pipeline_status.json','demo_status.json'):
                continue
            if 'logs' in path.relative_to(ROOT).parts:
                continue
            copy(path)
    # Demo metadata is portable; cached clip readers also rebase paths at runtime.
    for path in (stage/'demos').rglob('*.json'):
        content = path.read_text(encoding='utf-8')
        content = content.replace(json.dumps(str(source))[1:-1],'source')
        content = content.replace(json.dumps(str(ROOT))[1:-1],'.')
        content = content.replace('\\\\','/')
        json.loads(content)
        path.write_text(content,encoding='utf-8')
    summaries = []
    runtime_files = [(p,p.relative_to(stage).as_posix()) for p in stage.rglob('*') if p.is_file()]
    summaries.append(archive(out/'Bustech-runtime.zip',runtime_files,'runtime',True))

    metadata = out/'dataset_metadata'
    metadata.mkdir(exist_ok=True)
    (metadata/'data.yaml').write_text('path: .\ntrain: images/train\nval: images/val\nnames:\n  0: cane\n  1: stroller\n  2: wheelchair_with\n  3: wheelchair_without\n',encoding='utf-8')
    with (ROOT/'dataset/manifest.csv').open(encoding='utf-8-sig',newline='') as f:
        rows = list(csv.DictReader(f))
    for row in rows:
        for key in ('image','label'):
            row[key] = Path(row[key]).relative_to(source).as_posix()
    with (metadata/'manifest.csv').open('w',encoding='utf-8-sig',newline='') as f:
        writer = csv.DictWriter(f,fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)
    data_files = [(p,p.relative_to(ROOT).as_posix()) for kind in ('images','labels') for p in (ROOT/'dataset'/kind).rglob('*') if p.is_file() and p.suffix in ('.jpg','.txt')]
    data_files += [(metadata/'data.yaml','dataset/data.yaml'),(metadata/'manifest.csv','dataset/manifest.csv')]
    summaries.append(archive(out/'Bustech-training-data.zip',data_files,'training-data'))
    originals = [(p,'source/'+p.relative_to(source).as_posix()) for folder in ('data','label') for p in (source/folder).rglob('*') if p.is_file()]
    originals += [(p,'source/'+p.name) for p in source.glob('*.MOV')]
    summaries.append(archive(out/'Bustech-original-materials.zip',originals,'original-materials',tolerate_source_errors=True))
    (out/'package_summary.json').write_text(json.dumps(summaries,indent=2),encoding='utf-8')
    (out/'SHA256SUMS.txt').write_text(''.join(f'{r["sha256"]}  {r["archive"]}\n' for r in summaries),encoding='utf-8')
    shutil.copyfile(ROOT/'AGENT_HANDOFF.md',out/'AGENT_HANDOFF.md')
    print('All migration archives verified.',flush=True)


if __name__ == '__main__':
    main()
