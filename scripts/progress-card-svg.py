#!/usr/bin/env python3
"""
진도 카드 빈 양식(진도_OMR_카드_A4_4장.pdf)에서 카드 한 장을 SVG로 뽑아
progress-card/CardSvg.html 을 만든다. (인쇄 탭이 이 양식 위에 학생번호·이름·날짜를 얹어 찍는다)
카드 아래쪽 가운데(아래 기준점 사각형과 같은 높이)에 icons/jieum-logo-card.png 로고를 넣는다.

  python3 scripts/progress-card-svg.py [PDF 경로]

pdftocairo(poppler-utils)가 필요하다. 양식 PDF를 바꾼 뒤에만 다시 실행하면 된다.
"""
import base64
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 파일 이름이 맥에서 올린 자모 분리형(NFD)일 수 있어 이름 대신 모양으로 찾는다
PDF = Path(sys.argv[1]) if len(sys.argv) > 1 else next(ROOT.glob('*OMR*A4*.pdf'))
OUT = ROOT / 'progress-card' / 'CardSvg.html'
LOGO = ROOT / 'icons' / 'jieum-logo-card.png'
LOGO_H = 22  # pt. 아래 기준점(y 375.7~385.7) 가운데에 맞추고, 마지막 줄(y 362.9) 아래 여백 안에 들어가는 크기
SVG = '{http://www.w3.org/2000/svg}'
XLINK = '{http://www.w3.org/1999/xlink}href'

with tempfile.TemporaryDirectory() as tmp:
    svg_path = Path(tmp) / 'card.svg'
    subprocess.run(['pdftocairo', '-svg', str(PDF), str(svg_path)], check=True)
    root = ET.parse(svg_path).getroot()

by_id = {el.get('id'): el for el in root.iter() if el.get('id')}
# 페이지 왼쪽 위 카드 (페이지에서 <use xlink:href="#source-..."> 로 4번 찍혀 있음)
first_use = next(u for u in root if u.tag == SVG + 'use' and u.get(XLINK, '').startswith('#source-'))
card = by_id[first_use.get(XLINK)[1:]]
box = by_id[card.get('clip-path')[5:-1]].find(SVG + 'rect')
width, height = box.get('width'), box.get('height')

num = re.compile(r'-?\d+\.\d+')
short = lambda s: num.sub(lambda m: ('%.2f' % float(m.group())).rstrip('0').rstrip('.'), s)
color = re.compile(r'rgb\(([\d.]+)%, ([\d.]+)%, ([\d.]+)%\)')
hexcolor = lambda s: color.sub(lambda m: '#' + ''.join('%02x' % round(float(v) * 2.55) for v in m.groups()), s)

glyphs = {}


def emit(el):
    tag = el.tag.replace(SVG, '')
    attrs = []
    for k, v in el.attrib.items():
        if k == 'clip-path' or k.endswith('opacity') and v == '1' or k in ('stroke-miterlimit', 'fill-rule') or k == 'id':
            continue
        if k == XLINK:
            gid = v[1:]
            glyphs.setdefault(gid, 'g%d' % len(glyphs))
            attrs.append('href="#pc-%s"' % glyphs[gid])
            continue
        if k in ('stroke-linecap', 'stroke-linejoin') and v in ('butt', 'miter'):
            continue
        attrs.append('%s="%s"' % (k, hexcolor(short(v))))
    inner = ''.join(emit(c) for c in el)
    a = (' ' + ' '.join(attrs)) if attrs else ''
    if tag == 'g' and not attrs:
        return inner
    return '<%s%s>%s</%s>' % (tag, a, inner, tag) if inner else '<%s%s/>' % (tag, a)


body = ''.join(emit(c) for c in card)

# 로고: 기준점 사각형 세로 가운데, 카드 가로 가운데
marks = [p for p in card.iter(SVG + 'path') if p.get('fill') == 'rgb(0%, 0%, 0%)']
ys = [float(v) for v in re.findall(r'L [\d.]+ ([\d.]+)', marks[-1].get('d'))]
mid_y = (min(ys) + max(ys)) / 2
png = LOGO.read_bytes()
lw, lh = int.from_bytes(png[16:20], 'big'), int.from_bytes(png[20:24], 'big')
logo_w = LOGO_H * lw / lh
body += '<image x="%.2f" y="%.2f" width="%.2f" height="%.2f" href="data:image/png;base64,%s"/>' % (
    (float(width) - logo_w) / 2, mid_y - LOGO_H / 2, logo_w, LOGO_H, base64.b64encode(png).decode())
defs = ''.join(
    '<path id="pc-%s" d="%s"/>' % (sid, short(by_id[gid].find(SVG + 'path').get('d', '')) if by_id[gid].find(SVG + 'path') is not None else '')
    for gid, sid in glyphs.items()
)

OUT.write_text(
    '<!-- 진도 카드 빈 양식 (scripts/progress-card-svg.py 로 진도_OMR_카드_A4_4장.pdf 에서 만듦. 직접 고치지 말 것) -->\n'
    '<svg id="pc-card-defs" xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true"><defs>'
    + defs
    + '<symbol id="pc-card" viewBox="0 0 %s %s">' % (width, height)
    + body
    + '</symbol></defs></svg>\n',
    encoding='utf-8',
)
print('%s: %d bytes, %d glyphs, card %sx%s pt' % (OUT.relative_to(ROOT), OUT.stat().st_size, len(glyphs), width, height))
