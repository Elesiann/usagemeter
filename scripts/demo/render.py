import os, subprocess, sys
from PIL import Image
sys.path.insert(0, '.')
from ansi2html import convert, BG
CHROME = os.environ.get('CHROME', 'chromium')

def bounds(txt, end_marker):
    lines = txt.split('\n')
    head = next(i for i, l in enumerate(lines) if '1: Cost' in l)
    border = lines[head].index('│')
    end = next(i for i, l in enumerate(lines) if end_marker in l and i > head)
    return head, end + 1, border + 1

def shot(name, end_marker, out):
    txt = open(f'shots/{name}.txt', encoding='utf-8').read()
    first, last, col = bounds(txt, end_marker)
    html = convert(open(f'shots/{name}.ansi', encoding='utf-8').read(), first, last, col, None)
    open(f'shots/{name}.html', 'w').write(html)
    subprocess.run([CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2',
                    f'--screenshot={out}', '--window-size=1500,1100', f'file://{__import__("os").path.abspath(f"shots/{name}.html")}'],
                   check=True, capture_output=True)
    img = Image.open(out).convert('RGB')
    bg = tuple(int(BG[i:i + 2], 16) for i in (1, 3, 5))
    px = img.load(); w, h = img.size
    xs, ys = [], []
    for y in range(0, h, 2):
        for x in range(0, w, 2):
            if px[x, y] != bg: xs.append(x); ys.append(y)
    pad = 44
    box = (max(0, min(xs) - pad), max(0, min(ys) - pad), min(w, max(xs) + pad), min(h, max(ys) + pad))
    img.crop(box).save(out, optimize=True)
    print(out, img.crop(box).size)

shot(sys.argv[1], sys.argv[2], sys.argv[3])
