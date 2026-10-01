"""Render representative labeled frames for a visual alignment check."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
from prepare_dataset import DEFAULT_SOURCE, GROUPS, NAMES

canvas = Image.new('RGB', (1200, 1200), 'white')
for row, group in enumerate(GROUPS):
    images = sorted((DEFAULT_SOURCE / 'data' / group).rglob('*.jpg'))
    label_folders = [p for p in (DEFAULT_SOURCE / 'label').iterdir() if p.name.startswith(group+'--') or p.name.startswith(group+'_part_')]
    labels = {p.stem:p for folder in label_folders for p in folder.rglob('*.txt') if p.name != 'classes.txt'}
    matched = [p for p in images if p.stem in labels]
    for col, idx in enumerate([0, len(matched)//2, len(matched)-1]):
        path = matched[idx]
        with Image.open(path) as source:
            img = ImageOps.exif_transpose(source).convert('RGB')
        draw = ImageDraw.Draw(img)
        for line in labels[path.stem].read_text(encoding='utf-8-sig').splitlines():
            c, x, y, w, h = map(float, line.split())
            draw.rectangle(((x-w/2)*img.width, (y-h/2)*img.height, (x+w/2)*img.width, (y+h/2)*img.height), outline='red', width=8)
        img.thumbnail((394, 265))
        canvas.paste(img, (col*400, row*300+30))
        ImageDraw.Draw(canvas).text((col*400+4, row*300+4), f'{NAMES[row]} / {path.stem}', fill='black')
canvas.save(Path(__file__).parent/'label_preview.jpg')
