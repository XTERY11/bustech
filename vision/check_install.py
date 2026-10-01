"""Validate the model and sample clip without opening a camera or starting training."""
import argparse
from pathlib import Path
from project_paths import configure_yolo


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device',default='cpu')
    args = parser.parse_args()
    configure_yolo()
    import cv2
    import torch
    import ultralytics
    from ultralytics import YOLO
    root = Path(__file__).resolve().parent
    model = YOLO(str(root/'runs/bustech_yolov8n/weights/best.pt'))
    assert list(model.names.values()) == ['cane','stroller','wheelchair_with','wheelchair_without']
    clip = root/'demos/clips/wheelchair_test.mp4'
    capture = cv2.VideoCapture(str(clip))
    ok,frame = capture.read()
    capture.release()
    if not ok:
        raise RuntimeError(f'Cannot decode bundled sample: {clip}')
    if args.device != 'cpu' and not torch.cuda.is_available():
        raise RuntimeError('CUDA is unavailable. Check NVIDIA driver or use the CPU installer.')
    result = model.predict(frame,device=args.device,verbose=False)[0]
    print(f'PASS: torch={torch.__version__}, ultralytics={ultralytics.__version__}, device={args.device}')
    print(f'Model classes={model.names}; sample detections={len(result.boxes)}')


if __name__ == '__main__':
    main()
