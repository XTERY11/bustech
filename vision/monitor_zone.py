"""Interactive YOLOv8 camera/video monitoring with a saved polygon region."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import time

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parent
WINDOW = 'Bustech | Region Monitor'


def valid_polygon(points):
    """Reject zero-area and self-intersecting polygons (normalized coordinates)."""
    try:
        p = np.asarray(points, dtype=np.float32)
    except (ValueError,TypeError):
        return False
    if p.ndim != 2 or p.shape[1] != 2 or len(p) < 3 or not np.isfinite(p).all():
        return False
    if (p < 0).any() or (p > 1).any() or abs(cv2.contourArea(p)) < 1e-5:
        return False
    def cross(a, b, c):
        u,v = np.asarray(b)-a,np.asarray(c)-a
        return float(u[0]*v[1]-u[1]*v[0])
    def intersects(a, b, c, d):
        v = [cross(a,b,c), cross(a,b,d), cross(c,d,a), cross(c,d,b)]
        if v[0]*v[1] < 0 and v[2]*v[3] < 0:
            return True
        for value, point, start, end in [(v[0],c,a,b),(v[1],d,a,b),(v[2],a,c,d),(v[3],b,c,d)]:
            if abs(value) < 1e-9 and all(min(start[k],end[k])-1e-9 <= point[k] <= max(start[k],end[k])+1e-9 for k in (0,1)):
                return True
        return False
    n = len(p)
    for i in range(n):
        if np.linalg.norm(p[i]-p[(i+1)%n]) < 1e-6:
            return False
        for j in range(i+1,n):
            if j == i+1 or (i == 0 and j == n-1):
                continue
            if intersects(p[i],p[(i+1)%n],p[j],p[(j+1)%n]):
                return False
    return True


def load_roi(path):
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding='utf-8'))
    points = data.get('points_normalized', [])
    if not valid_polygon(points):
        raise ValueError(f'Invalid ROI in {path}; redraw or choose another --roi file.')
    return [tuple(map(float, p)) for p in points]


def save_roi(path, points, source, anchor):
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'version':1, 'points_normalized':points, 'anchor':anchor,
               'source_hint': 'camera' if isinstance(source,int) else 'video/stream'}
    temporary = path.with_suffix(path.suffix+'.tmp')
    temporary.write_text(json.dumps(payload,indent=2),encoding='utf-8')
    temporary.replace(path)


def anchor_point(box, mode):
    x1,y1,x2,y2 = box
    return ((x1+x2)/2, y2 if mode == 'bottom-center' else (y1+y2)/2)


def is_inside(box, points, width, height, mode='bottom-center'):
    if not points:
        return False
    contour = np.asarray(points,dtype=np.float32)*np.array([width-1,height-1],dtype=np.float32)
    return cv2.pointPolygonTest(contour,anchor_point(box,mode),False) >= 0


class Trigger:
    """Occupancy state with consecutive-frame entry/exit confirmation."""
    def __init__(self, enter_frames=2, exit_frames=5):
        self.enter_frames,self.exit_frames = enter_frames,exit_frames
        self.reset()

    def reset(self):
        self.active = False
        self.hits = self.misses = 0

    def update(self, occupied):
        before = self.active
        if occupied:
            self.hits += 1
            self.misses = 0
            if self.hits >= self.enter_frames:
                self.active = True
        else:
            self.hits = 0
            self.misses += 1
            if self.misses >= self.exit_frames:
                self.active = False
        return self.active, self.active and not before


class Editor:
    def __init__(self, points):
        self.points = points
        self.draft = []
        self.editing = not bool(points)
        self.width = self.height = 1
        self.message = ''

    def mouse(self, event, x, y, flags, param):
        if not self.editing:
            return
        if event == cv2.EVENT_LBUTTONDOWN:
            self.draft.append((max(0,min(1,x/max(1,self.width-1))),max(0,min(1,y/max(1,self.height-1)))))
        elif event == cv2.EVENT_RBUTTONDOWN and self.draft:
            self.draft.pop()


def parse_args():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--source',default='0',help='Camera index, video file, RTSP or HTTP video stream')
    p.add_argument('--choose-source',action='store_true',help='Prompt for source before opening the window')
    p.add_argument('--model',type=Path,default=ROOT/'runs/bustech_yolov8n/weights/best.pt')
    p.add_argument('--roi',type=Path,default=ROOT/'monitor_roi.json')
    p.add_argument('--anchor',choices=['bottom-center','center'],default=None)
    p.add_argument('--conf',type=float,default=0.4)
    p.add_argument('--classes',type=int,nargs='+',help='Class IDs; default is all four classes')
    p.add_argument('--device',default='auto',help='auto, cpu, or GPU index such as 0')
    p.add_argument('--imgsz',type=int,default=640)
    p.add_argument('--enter-frames',type=int,default=2)
    p.add_argument('--exit-frames',type=int,default=5)
    p.add_argument('--width',type=int,default=1280,help='Maximum displayed/processed frame width')
    p.add_argument('--rotate',choices=['none','cw','ccw','180'],default='none')
    p.add_argument('--headless',action='store_true',help='No GUI; requires a saved ROI')
    p.add_argument('--max-frames',type=int,default=0,help='0 means run until stopped or source ends')
    p.add_argument('--output',type=Path,help='Optional annotated .avi (MJPG); no recording by default')
    p.add_argument('--events',type=Path,help='Optional JSONL trigger transition log')
    args = p.parse_args()
    if not 0 < args.conf <= 1 or min(args.enter_frames,args.exit_frames,args.width,args.imgsz) < 1 or args.max_frames < 0:
        p.error('Invalid confidence, frame count, or image size')
    if args.output and args.output.suffix.lower() != '.avi':
        p.error('--output must end in .avi')
    return args


def main():
    args = parse_args()
    if args.choose_source:
        print('Camera: enter 0 (or 1). Video: enter full path. Network: enter RTSP/HTTP URL.')
        args.source = input('Source [0]: ').strip().strip('"') or '0'
    source = int(args.source) if args.source.isdecimal() else args.source
    is_file = isinstance(source,str) and Path(source).is_file() if not '://' in str(source) else False
    if not args.model.is_file():
        raise FileNotFoundError(f'Model not found: {args.model}')
    editor = Editor(load_roi(args.roi))
    if args.anchor is None:
        saved = json.loads(args.roi.read_text(encoding='utf-8')) if args.roi.exists() else {}
        args.anchor = saved.get('anchor','bottom-center')
        if args.anchor not in ('bottom-center','center'):
            raise ValueError('Invalid anchor in ROI configuration')
    if args.headless and editor.editing:
        raise ValueError('--headless requires a valid saved ROI')
    os.environ.setdefault('YOLO_CONFIG_DIR',str(ROOT/'.yolo'))
    import torch
    from ultralytics import YOLO
    device = ('0' if torch.cuda.is_available() else 'cpu') if args.device == 'auto' else args.device
    model = YOLO(str(args.model))
    if args.classes and any(c not in model.names for c in args.classes):
        raise ValueError(f'Available classes: {model.names}')
    print(f'Device: {device}; classes: {model.names}; anchor: {args.anchor}',flush=True)
    print('Click polygon vertices; right-click undo; ENTER save; R redraw; ESC cancel edit; Q quit. SPACE pauses files.',flush=True)
    cap = cv2.VideoCapture(source,cv2.CAP_DSHOW) if isinstance(source,int) and os.name == 'nt' else cv2.VideoCapture(source)
    if not cap.isOpened() and isinstance(source,int) and os.name == 'nt':
        cap.release()
        cap = cv2.VideoCapture(source)
    if not cap.isOpened():
        cap.release()
        raise RuntimeError('Cannot open source. Check camera index, video path, permissions, or stream connection.')
    cap.set(cv2.CAP_PROP_BUFFERSIZE,1)
    fps = cap.get(cv2.CAP_PROP_FPS)
    fps = fps if np.isfinite(fps) and 0 < fps <= 240 else 30
    trigger = Trigger(args.enter_frames,args.exit_frames)
    writer = None
    log = None
    frame = None
    processed = entries = active_frames = 0
    paused = False
    started = time.monotonic()
    if args.events:
        args.events.parent.mkdir(parents=True,exist_ok=True)
        log = args.events.open('a',encoding='utf-8')
    try:
        if not args.headless:
            cv2.namedWindow(WINDOW,cv2.WINDOW_AUTOSIZE)
            cv2.setMouseCallback(WINDOW,editor.mouse)
        while True:
            tick = time.monotonic()
            fresh = frame is None or not ((editor.editing or paused) and is_file)
            if fresh:
                ok, frame = cap.read()
                if not ok:
                    if is_file:
                        print('Video finished.',flush=True)
                        break
                    raise RuntimeError('Camera/stream stopped delivering frames. Monitoring has stopped; reconnect and restart.')
                if args.rotate != 'none':
                    frame = cv2.rotate(frame,{'cw':cv2.ROTATE_90_CLOCKWISE,'ccw':cv2.ROTATE_90_COUNTERCLOCKWISE,'180':cv2.ROTATE_180}[args.rotate])
                if frame.shape[1] > args.width:
                    frame = cv2.resize(frame,(args.width,round(frame.shape[0]*args.width/frame.shape[1])))
            height,width = frame.shape[:2]
            editor.width,editor.height = width,height
            view = frame.copy()
            occupied = 0
            infer = not editor.editing and not paused and fresh
            if infer:
                result = model.predict(frame,imgsz=args.imgsz,conf=args.conf,classes=args.classes,device=device,verbose=False)[0]
                for box in result.boxes.data.cpu().tolist():
                    x1,y1,x2,y2,confidence,cls = box
                    inside = is_inside(box[:4],editor.points,width,height,args.anchor)
                    occupied += int(inside)
                    color = (0,100,255) if inside else (220,180,70)
                    cv2.rectangle(view,(int(x1),int(y1)),(int(x2),int(y2)),color,2)
                    cv2.putText(view,f'{model.names[int(cls)]} {confidence:.2f}',(max(0,int(x1)),max(20,int(y1)-8)),cv2.FONT_HERSHEY_SIMPLEX,.6,color,2)
                    anchor = tuple(round(v) for v in anchor_point(box[:4],args.anchor))
                    cv2.circle(view,anchor,5,color,-1)
                active, entered = trigger.update(occupied > 0)
                processed += 1
                active_frames += int(active)
                if entered:
                    entries += 1
                    event = {'event':'TRIGGER','frame':processed,'elapsed_seconds':round(time.monotonic()-started,3),'targets_in_region':occupied}
                    print(json.dumps(event),flush=True)
                    if log:
                        log.write(json.dumps(event)+'\n'); log.flush()
            points = editor.draft if editor.editing else editor.points
            contour = np.round(np.asarray(points)*[width-1,height-1]).astype(np.int32) if points else None
            if contour is not None:
                color = (0,220,255) if editor.editing else ((0,0,255) if trigger.active else (60,210,60))
                if len(contour) >= 3:
                    overlay = view.copy()
                    cv2.fillPoly(overlay,[contour],color)
                    view = cv2.addWeighted(overlay,.15,view,.85,0)
                cv2.polylines(view,[contour],not editor.editing,color,2)
                for point in contour:
                    cv2.circle(view,tuple(point),4,color,-1)
            state = 'DRAW REGION - monitoring disabled' if editor.editing else ('PAUSED' if paused else ('TRIGGER' if trigger.active else 'MONITORING'))
            cv2.rectangle(view,(0,0),(width,78),(24,24,24),-1)
            cv2.putText(view,state,(12,32),cv2.FONT_HERSHEY_SIMPLEX,.85,(0,70,255) if trigger.active and not editor.editing and not paused else (255,255,255),2)
            hint = 'Click corners | Right click: undo | ENTER: save | ESC: cancel | Q: quit' if editor.editing else f'Inside: {occupied} | R: redraw | SPACE: pause video | Q: quit | {args.anchor}'
            cv2.putText(view,hint,(12,60),cv2.FONT_HERSHEY_SIMPLEX,.48,(220,220,220),1)
            if editor.message:
                cv2.putText(view,editor.message,(12,height-16),cv2.FONT_HERSHEY_SIMPLEX,.55,(0,220,255),2)
            if infer and args.output:
                if writer is None:
                    args.output.parent.mkdir(parents=True,exist_ok=True)
                    writer = cv2.VideoWriter(str(args.output),cv2.VideoWriter_fourcc(*'MJPG'),fps,(width,height))
                    if not writer.isOpened():
                        raise RuntimeError('Cannot create output video')
                writer.write(view)
            if args.max_frames and processed >= args.max_frames:
                break
            if args.headless:
                continue
            cv2.imshow(WINDOW,view)
            delay = max(1,round(1000/fps-(time.monotonic()-tick)*1000)) if is_file and infer else 20
            key = cv2.waitKey(delay)&0xff
            if key == ord('q') or cv2.getWindowProperty(WINDOW,cv2.WND_PROP_VISIBLE) < 1:
                break
            if key == ord('r'):
                editor.editing,editor.draft,editor.message = True,[],''
                trigger.reset()
                paused = False
            elif key == 27:
                if editor.editing and editor.points:
                    editor.editing,editor.message = False,''
                else:
                    break
            elif key in (10,13) and editor.editing:
                if valid_polygon(editor.draft):
                    editor.points = editor.draft.copy()
                    save_roi(args.roi,editor.points,source,args.anchor)
                    editor.editing,editor.message = False,'Region saved'
                    trigger.reset()
                else:
                    editor.message = 'Use at least 3 corners; edges must not cross.'
            elif key == 32 and is_file and not editor.editing:
                paused = not paused
                trigger.reset()
    finally:
        cap.release()
        if writer:
            writer.release()
        if log:
            log.close()
        if not args.headless:
            cv2.destroyAllWindows()
    print(json.dumps({'processed_frames':processed,'trigger_entries':entries,'active_frames':active_frames}),flush=True)


if __name__ == '__main__':
    try:
        main()
    except (ValueError,RuntimeError,FileNotFoundError,json.JSONDecodeError) as exc:
        raise SystemExit(str(exc))
