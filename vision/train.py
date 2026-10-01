"""Train YOLOv8 on the prepared Bustech dataset."""
import argparse
from pathlib import Path
from project_paths import configure_yolo, resolve_data_yaml


def main():
    root = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', default=str(root/'yolov8n.pt'))
    parser.add_argument('--data', default=str(root / 'dataset' / 'data.yaml'))
    parser.add_argument('--epochs', type=int, default=100)
    parser.add_argument('--imgsz', type=int, default=640)
    parser.add_argument('--batch', type=int, default=8)
    parser.add_argument('--device', default='auto')
    parser.add_argument('--workers', type=int, default=0)
    parser.add_argument('--resume', type=Path)
    args = parser.parse_args()
    configure_yolo()
    import torch
    from ultralytics import YOLO
    if args.device == 'auto':
        args.device = '0' if torch.cuda.is_available() else 'cpu'
    if args.device != 'cpu' and not torch.cuda.is_available():
        raise SystemExit('CUDA is unavailable. Install a CUDA-enabled PyTorch build or explicitly use --device cpu.')
    if args.resume:
        YOLO(str(args.resume)).train(resume=True)
        return
    if not Path(args.data).is_file():
        raise SystemExit('Dataset missing. Run prepare_dataset.py --prepare first.')
    YOLO(args.model).train(
        data=resolve_data_yaml(args.data), epochs=args.epochs, imgsz=args.imgsz, batch=args.batch,
        device=args.device, workers=args.workers, project=str(root / 'runs'),
        name='bustech_yolov8n' if Path(args.model).name == 'yolov8n.pt' else 'bustech_yolov8',
        patience=20, seed=42, deterministic=True, cache=False,
        close_mosaic=10, plots=True, exist_ok=False,
    )


if __name__ == '__main__':
    from multiprocessing import freeze_support
    freeze_support()
    main()
