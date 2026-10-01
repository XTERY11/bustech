"""Portable paths; machine-specific settings are excluded from releases."""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def source_root():
    configured = os.environ.get('BUSTECH_SOURCE')
    local = ROOT/'project_config.local.json'
    if not configured and local.exists():
        configured = json.loads(local.read_text(encoding='utf-8')).get('source_root')
    return Path(configured).expanduser().resolve() if configured else ROOT/'source'


def configure_yolo():
    directory = ROOT/'.yolo'
    directory.mkdir(exist_ok=True)
    os.environ.setdefault('YOLO_CONFIG_DIR',str(directory))


def resolve_data_yaml(path):
    """Resolve dataset paths relative to YAML, not global Ultralytics settings."""
    import yaml
    path = Path(path).resolve()
    config = yaml.safe_load(path.read_text(encoding='utf-8'))
    data_root = Path(config.get('path','.'))
    if not data_root.is_absolute():
        data_root = (path.parent/data_root).resolve()
    if not data_root.exists():
        raise FileNotFoundError(f'Dataset path does not exist: {data_root}. Update {path}')
    config['path'] = data_root.as_posix()
    generated = path.with_name('.resolved_'+path.name)
    generated.write_text(yaml.safe_dump(config,sort_keys=False),encoding='utf-8')
    return str(generated)
