"""Combine screenshots into one sheet for review: python3 montage.py out.png a.png b.png ... (2 columns)"""
import sys
from PIL import Image, ImageDraw
out, files = sys.argv[1], sys.argv[2:]
ims = [Image.open(f).convert('RGB') for f in files]
W = 900
ims = [im.resize((W, int(im.height * W / im.width))) for im in ims]
cols = 2
rows = [ims[i:i + cols] for i in range(0, len(ims), cols)]
H = sum(max(i.height for i in r) + 30 for r in rows)
sheet = Image.new('RGB', (W * cols + 10, H), 'white')
d = ImageDraw.Draw(sheet)
y = 0
for ri, r in enumerate(rows):
    for ci, im in enumerate(r):
        sheet.paste(im, (ci * (W + 10), y + 30))
        d.text((ci * (W + 10) + 5, y + 8), files[ri * cols + ci].split('/')[-1], fill='black')
    y += max(i.height for i in r) + 30
sheet.save(out)
