"""tmux `capture-pane -e` output to a self-contained HTML page (for README screenshots)."""
import html, re, sys

BASE = ['#1e1e2e', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
        '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']

def c256(n):
    if n < 16: return BASE[n]
    if n < 232:
        n -= 16; v = [0, 95, 135, 175, 215, 255]
        return '#%02x%02x%02x' % (v[n // 36], v[(n // 6) % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return '#%02x%02x%02x' % (g, g, g)

FG, BG = '#d4d4d8', '#18181b'

def convert(text, first_line=0, last_line=None, first_col=0, last_col=None):
    # OSC sequences (hyperlinks, titles) carry no visible cells: drop them whole.
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    lines = text.split('\n')[first_line:last_line]
    out = []
    st = {'fg': None, 'bg': None, 'b': False, 'd': False, 'i': False, 'u': False, 'r': False}
    for line in lines:
        cells = []  # (char, style)
        pos = 0
        for m in re.finditer(r'\x1b\[([0-9;]*)m|([^\x1b]+)', line):
            if m.group(2) is not None:
                for ch in m.group(2):
                    cells.append((ch, dict(st)))
                continue
            codes = [int(c) if c else 0 for c in m.group(1).split(';')] or [0]
            i = 0
            while i < len(codes):
                c = codes[i]
                if c == 0: st.update(fg=None, bg=None, b=False, d=False, i=False, u=False, r=False)
                elif c == 1: st['b'] = True
                elif c == 2: st['d'] = True
                elif c == 22: st['b'] = st['d'] = False
                elif c == 3: st['i'] = True
                elif c == 23: st['i'] = False
                elif c == 4: st['u'] = True
                elif c == 24: st['u'] = False
                elif c == 7: st['r'] = True
                elif c == 27: st['r'] = False
                elif c == 39: st['fg'] = None
                elif c == 49: st['bg'] = None
                elif 30 <= c <= 37: st['fg'] = BASE[c - 30]
                elif 90 <= c <= 97: st['fg'] = BASE[c - 90 + 8]
                elif 40 <= c <= 47: st['bg'] = BASE[c - 40]
                elif 100 <= c <= 107: st['bg'] = BASE[c - 100 + 8]
                elif c in (38, 48) and i + 1 < len(codes):
                    key = 'fg' if c == 38 else 'bg'
                    if codes[i + 1] == 5 and i + 2 < len(codes):
                        st[key] = c256(codes[i + 2]); i += 2
                    elif codes[i + 1] == 2 and i + 4 < len(codes):
                        st[key] = '#%02x%02x%02x' % tuple(codes[i + 2:i + 5]); i += 4
                i += 1
        cells = cells[first_col:last_col]
        spans, prev, buf = [], None, ''
        def flush():
            if not buf: return
            s = prev
            fg, bg = s['fg'] or FG, s['bg']
            if s['r']: fg, bg = (bg or BG), fg
            css = 'color:%s;' % fg
            # Backgrounds are the pane's own fill; only reverse video keeps one.
            if bg and s['r']: css += 'background:%s;' % bg
            if s['b']: css += 'font-weight:700;'
            if s['d']: css += 'opacity:.55;'
            if s['i']: css += 'font-style:italic;'
            if s['u']: css += 'text-decoration:underline;'
            spans.append('<span style="%s">%s</span>' % (css, html.escape(buf)))
        for ch, s in cells:
            if s != prev:
                flush(); buf = ''; prev = s
            buf += ch
        flush()
        out.append(''.join(spans) or ' ')
    body = '\n'.join(out)
    return f'''<!doctype html><meta charset="utf-8"><style>
html,body{{margin:0;background:{BG}}}
pre{{margin:0;padding:22px 26px;font:15px/1.17 "DejaVu Sans Mono","Ubuntu Mono",monospace;color:{FG};white-space:pre}}
</style><pre>{body}</pre>'''

if __name__ == '__main__':
    args = [int(a) if a not in ('', '-') else None for a in sys.argv[2:6]] + [None] * 4
    sys.stdout.write(convert(open(sys.argv[1], encoding='utf-8', errors='replace').read(), args[0] or 0, args[1], args[2] or 0, args[3]))
