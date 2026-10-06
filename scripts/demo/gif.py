import os, subprocess, sys
from PIL import Image
sys.path.insert(0, '.')
from ansi2html import convert, BG
CHROME = os.environ.get('CHROME', 'chromium')
frames = [('f1', 'Updated', 2200), ('f2', 'Updated', 2000), ('f3', 'Checked', 2400), ('f4', 'Updated', 1800), ('f5', 'Updated', 1800), ('f6', 'Updated', 2000)]

spans = []
for name, marker, _ in frames:
    lines = open(f'gif/{name}.txt', encoding='utf-8').read().split('\n')
    head = next(i for i, l in enumerate(lines) if '1: Cost' in l)
    end = next(i for i, l in enumerate(lines) if marker in l and i > head)
    spans.append((head, end, lines[head].index('│') + 1))
height = max(e - h + 1 for h, e, _ in spans)
images = []
for (name, _, _), (head, end, col) in zip(frames, spans):
    html = convert(open(f'gif/{name}.ansi', encoding='utf-8').read(), head, head + height, col, None)
    path = os.path.abspath(f'gif/{name}.html'); open(path, 'w').write(html)
    out = f'gif/{name}.png'
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
                    f'--screenshot={out}', '--window-size=1500,1100', f'file://{path}'], check=True, capture_output=True)
    images.append(Image.open(out).convert('RGB'))
bg = tuple(int(BG[i:i + 2], 16) for i in (1, 3, 5))
xs, ys = [], []
for img in images:
    px = img.load(); w, h = img.size
    for y in range(h):
        for x in range(0, w, 2):
            if px[x, y] != bg: xs.append(x); ys.append(y)
pad = 22
box = (max(0, min(xs) - pad), max(0, min(ys) - pad), max(xs) + pad, max(ys) + pad)
cropped = [img.crop(box) for img in images]
pal = [c.quantize(colors=96, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE) for c in cropped]
pal[0].save('gif/demo.gif', save_all=True, append_images=pal[1:], duration=[d for *_, d in frames], loop=0, optimize=True, disposal=1)
print('demo.gif', cropped[0].size, os.path.getsize('gif/demo.gif') // 1024, 'KB')
