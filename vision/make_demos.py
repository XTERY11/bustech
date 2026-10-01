"""Extract central ten-second clips and render YOLOv8 detection demonstrations."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import html
import os
from pathlib import Path
import re
import subprocess
import time
import threading

ROOT = Path(__file__).resolve().parent
from project_paths import source_root, configure_yolo
SOURCE = source_root()
OUT = ROOT/'demos'
VIDEOS = ['cane-002.MOV', 'stroller-004.MOV', 'wheelchair 2.MOV', 'wheelchair test.MOV', 'wheelchair-003.MOV']
STATUS_LOCK = threading.Lock()
PROGRESS = {}


def progress(name, stage, **extra):
    with STATUS_LOCK:
        PROGRESS[name] = {'stage': stage, **extra}
        temporary = OUT/'demo_status.tmp'
        temporary.write_text(json.dumps({'updated':time.strftime('%Y-%m-%d %H:%M:%S'),'videos':PROGRESS}, indent=2),encoding='utf-8')
        temporary.replace(OUT/'demo_status.json')


def run(command, log):
    result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', errors='replace')
    log.write_text(result.stderr, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'FFmpeg failed: {log}')
    return result


def extract(name, ffmpeg):
    source = SOURCE/name
    stem = source.stem.replace(' ', '_')
    meta = OUT/'clips'/(stem+'.json')
    target = OUT/'clips'/(stem+'.mp4')
    if meta.exists() and target.exists() and 'orientation_correction' in json.loads(meta.read_text()):
        progress(name,'clip_ready')
        cached = json.loads(meta.read_text())
        cached.update(source=str(source),clip=str(target))
        return cached
    progress(name,'reading_onedrive_source')
    print(f'Reading video metadata: {name}', flush=True)
    probe = subprocess.run([ffmpeg, '-hide_banner', '-i', str(source)], capture_output=True, text=True, encoding='utf-8', errors='replace')
    (OUT/'logs'/(stem+'_probe.log')).write_text(probe.stderr, encoding='utf-8')
    match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', probe.stderr)
    if not match:
        raise RuntimeError(f'Could not read duration: {name}')
    h,m,s = map(float, match.groups())
    duration = h*3600+m*60+s
    start = max(0, (duration-10)/2)
    progress(name,'extracting',start_seconds=start)
    print(f'Extracting {name}: {start:.3f}–{start+10:.3f}s', flush=True)
    rotation = 'transpose=2,' if name.startswith('wheelchair') else ''
    run([ffmpeg, '-hide_banner', '-y', '-ss', str(start), '-i', str(source), '-t', '10',
         '-map', '0:v:0', '-an', '-vf', rotation+'scale=1280:720:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30',
         '-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(target)],
        OUT/'logs'/(stem+'_extract.log'))
    import cv2
    cap = cv2.VideoCapture(str(target))
    success, frame = cap.read()
    if not success:
        raise RuntimeError(f'Extracted clip unreadable: {target}')
    cv2.imwrite(str(OUT/'previews'/(stem+'_source.jpg')), frame)
    info = {'source': str(source), 'clip': str(target), 'start_seconds': start, 'source_duration': duration,
            'duration_seconds': cap.get(cv2.CAP_PROP_FRAME_COUNT)/cap.get(cv2.CAP_PROP_FPS),
            'width': frame.shape[1], 'height': frame.shape[0], 'fps': 30,
            'orientation_correction': '90 degrees counterclockwise' if rotation else 'none',
            'evaluation_note': 'Independent source video (not used in training)' if name == 'wheelchair test.MOV' else 'Source video used to construct training/validation data; demonstration only'}
    cap.release()
    meta.write_text(json.dumps(info, indent=2), encoding='utf-8')
    print(f'Clip ready: {name}', flush=True)
    progress(name,'clip_ready',start_seconds=start)
    return info


def render(info, model, ffmpeg):
    import cv2
    from collections import Counter
    stem = Path(info['clip']).stem
    target = OUT/(stem+'_yolov8_demo.mp4')
    cap = cv2.VideoCapture(info['clip'])
    w,h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    command = [ffmpeg,'-hide_banner','-y','-f','rawvideo','-pix_fmt','bgr24','-s',f'{w}x{h}','-r','30','-i','pipe:0',
               '-an','-c:v','libx264','-preset','fast','-crf','20','-pix_fmt','yuv420p','-movflags','+faststart',str(target)]
    counts = Counter()
    frames = 0
    progress(Path(info['source']).name,'inference',frames=0,total_frames=300)
    with (OUT/'logs'/(stem+'_encode.log')).open('w', encoding='utf-8') as log:
        encoder = subprocess.Popen(command, stdin=subprocess.PIPE, stderr=log)
        try:
            while True:
                ok, frame = cap.read()
                if not ok:
                    break
                import torch
                result = model.predict(frame, imgsz=640, conf=0.25, iou=0.7, device=0 if torch.cuda.is_available() else 'cpu', verbose=False)[0]
                annotated = result.plot(line_width=2, font_size=14)
                for cls in result.boxes.cls.tolist():
                    counts[model.names[int(cls)]] += 1
                banner = f'{Path(info["source"]).name} | YOLOv8n | {info["start_seconds"]+frames/30:.1f}s | conf >= 0.25'
                cv2.rectangle(annotated, (0,0), (w,32), (25,25,25), -1)
                cv2.putText(annotated, banner, (10,22), cv2.FONT_HERSHEY_SIMPLEX, 0.48, (255,255,255), 1, cv2.LINE_AA)
                if frames in (0,150,299):
                    cv2.imwrite(str(OUT/'previews'/(stem+f'_demo_{frames:03}.jpg')), annotated)
                encoder.stdin.write(annotated.tobytes())
                frames += 1
                if frames % 100 == 0:
                    print(f'{stem}: inference {frames}/300', flush=True)
                    progress(Path(info['source']).name,'inference',frames=frames,total_frames=300)
        finally:
            cap.release()
            encoder.stdin.close()
            code = encoder.wait()
        if code:
            raise RuntimeError(f'Encoding failed: {target}')
    cap = cv2.VideoCapture(str(target))
    verified = 0
    while True:
        ok, _ = cap.read()
        if not ok:
            break
        verified += 1
    cap.release()
    if frames != 300 or verified != frames:
        raise RuntimeError(f'Unexpected frame count: {target}, wrote={frames}, decoded={verified}')
    info.update(output=str(target), frames=frames, model=str(ROOT/'runs/bustech_yolov8n/weights/best.pt'),
                confidence_threshold=0.25, detections_by_class_across_frames=dict(counts))
    print(f'Demo verified: {target.name}', flush=True)
    progress(Path(info['source']).name,'complete',output=str(target),frames=frames)
    return info


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--extract-only', action='store_true')
    args = parser.parse_args()
    for folder in ('clips','previews','logs'):
        (OUT/folder).mkdir(parents=True,exist_ok=True)
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    infos = []
    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = [pool.submit(extract, name, ffmpeg) for name in VIDEOS]
        for future in as_completed(futures):
            infos.append(future.result())
    infos.sort(key=lambda info: VIDEOS.index(Path(info['source']).name))
    if args.extract_only:
        return
    configure_yolo()
    from ultralytics import YOLO
    model = YOLO(str(ROOT/'runs/bustech_yolov8n/weights/best.pt'))
    results = [render(info,model,ffmpeg) for info in infos]
    (OUT/'demo_manifest.json').write_text(json.dumps(results,indent=2),encoding='utf-8')
    cards = []
    for info in results:
        name = Path(info['source']).name
        note = '未用于本次训练的视频' if name == 'wheelchair test.MOV' else '训练/验证数据来源视频，非独立测试'
        cards.append(f'<article><h2>{html.escape(name)}</h2><p>{info["start_seconds"]:.2f}–{info["start_seconds"]+10:.2f} 秒 · {note}</p>'
                     f'<video controls preload="metadata" poster="previews/{Path(info["clip"]).stem}_demo_150.jpg" src="{Path(info["output"]).name}"></video></article>')
    page = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    page += '<title>Bustech YOLOv8 演示</title><style>body{margin:32px auto;padding:0 20px;max-width:1200px;background:#101821;color:#edf3f8;font:16px/1.6 system-ui}h1{margin-bottom:4px}h2{font-size:20px;margin:0}p{color:#adbfce}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:24px}article{background:#1c2935;padding:18px;border-radius:12px}video{width:100%;max-height:440px;background:#000}footer{margin:30px 0;color:#adbfce}</style>'
    page += '<h1>Bustech · YOLOv8 检测演示</h1><p>best.pt · 4 类目标 · 各 10 秒 · 30 FPS · 置信度阈值 0.25 · 无音频</p><main>'
    page += ''.join(cards)+'</main><footer>每段取视频中间连续 10 秒。显示模型原始预测，不做人工纠正。四段来自训练/验证源视频，不能视为独立泛化测试。类别沿用原标注，人和辅助器具可能作为整体被框选。</footer></html>'
    (OUT/'index.html').write_text(page,encoding='utf-8')
    from PIL import Image, ImageDraw
    board = Image.new('RGB',(1280,3*400),(16,24,33))
    draw = ImageDraw.Draw(board)
    for i, info in enumerate(results):
        x,y = (i%2)*640,(i//2)*400
        with Image.open(OUT/'previews'/(Path(info['clip']).stem+'_demo_150.jpg')) as frame:
            frame.thumbnail((632,350))
            board.paste(frame,(x+(640-frame.width)//2,y+40))
        draw.text((x+12,y+10),Path(info['source']).name,fill='white')
    board.save(OUT/'overview.jpg',quality=90)
    print('All five demos complete.',flush=True)


if __name__ == '__main__':
    main()
