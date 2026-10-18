#!/usr/bin/env python3
"""
진도 카드 빈 양식(진도_OMR_카드_A4_4장.pdf)에서 카드 한 장을 SVG로 뽑아
progress-card/CardSvg.html 을 만든다. (인쇄 탭이 이 양식 위에 학생번호·이름·날짜를 얹어 찍는다)
카드 아래쪽 가운데(아래 기준점 사각형과 같은 높이)에 icons/jieum-logo-card.png 로고를 넣는다.

PDF 양식에서 바꾸는 것 (2026-10-18 요청)
- '오답 원인' 칸 → '학습 주안점' (보기: 개념 재학습/오개념 수정, 문제 읽기(조건 찾기), 계산 실수 교정, 풀이 과정 서술)
- 학습 목표 아래 순서: 추가 포인트 → 오늘 과제 → 학습 주안점 → 지음쌤 톡
- '학습태도' 칸 이름 → '지음쌤 톡' (기록 열 이름은 그대로 학습태도)
새 글자는 Noto Sans KR(PDF 양식과 같은 글꼴 계열)에서 글자 모양을 뽑아 넣는다. 글꼴은 처음 실행할 때 내려받는다.

  pip install fonttools

  python3 scripts/progress-card-svg.py [PDF 경로]

pdftocairo(poppler-utils)가 필요하다. 양식 PDF를 바꾼 뒤에만 다시 실행하면 된다.
"""
import base64
import re
import subprocess
import urllib.request
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
FONT_DIR = Path.home() / '.cache' / 'jieummath-fonts'
FONTS = {  # Google Fonts 의 Noto Sans KR
    'R': 'https://fonts.gstatic.com/s/notosanskr/v40/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzuoyeLQ.ttf',
    'B': 'https://fonts.gstatic.com/s/notosanskr/v40/PbyxFmXiEBPT4ITbgNA5Cgms3VYcOA-vvnIzzg01eLQ.ttf',
}
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




def top_y(el):
    """카드 안에서 요소의 위쪽 y (글자는 기준선 y)"""
    if el.tag == SVG + 'g':
        u = el.find(SVG + 'use')
        return float(u.get('y')) if u is not None else None
    if el.tag == SVG + 'path':
        ys = [float(v) for v in re.findall(r'-?\d+\.?\d*', el.get('d'))][1::2]
        t = el.get('transform')
        if t:
            a, b, c, d, e, f = [float(v) for v in re.findall(r'-?[\d.]+', t)]
            ys = [d * y + f for y in ys]
        return min(ys)
    return None


# 칸 구분선(굵은 회색 가로줄): 각 칸의 아래쪽 경계
dividers = sorted(top_y(c) for c in card if c.tag == SVG + 'path' and c.get('fill', '').startswith('rgb(74.')
                  and not c.get('stroke'))
# 학습 목표 아래 네 칸: 오답 원인, 학습태도, 추가 포인트, 오늘 과제 (원래 순서)
i = next(k for k, y in enumerate(dividers) if 250 < y < 260)
edges = dividers[i:i + 5]
OLD = ['mistake', 'attitude', 'points', 'homework']
NEW = ['points', 'homework', 'mistake', 'attitude']
band = {name: (edges[k], edges[k + 1]) for k, name in enumerate(OLD)}
shift = {}
y = edges[0]
for name in NEW:
    a, b = band[name]
    shift[name] = y - a
    y += b - a


def band_of(el):
    t = top_y(el)
    if t is None:
        return None
    for name, (a, b) in band.items():
        if a + 0.1 < t <= b + 0.1:
            return name
    return None


fonts = {}


def font_of(weight):
    from fontTools.ttLib import TTFont
    if weight not in fonts:
        FONT_DIR.mkdir(parents=True, exist_ok=True)
        f = FONT_DIR / ('NotoSansKR-%s.ttf' % weight)
        if not f.exists():
            urllib.request.urlretrieve(FONTS[weight], f)
        fonts[weight] = TTFont(f)
    return fonts[weight]


def text_width(text, weight, size, space):
    font = font_of(weight)
    cmap, hmtx = font.getBestCmap(), font['hmtx']
    return sum(space if ch == ' ' else hmtx[cmap[ord(ch)]][0] * size / 1000 for ch in text)


def text_path(text, x, baseline, weight, size, space):
    """글자를 SVG 경로로 (글꼴 없이도 똑같이 찍히게)"""
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    font = font_of(weight)
    gs, cmap, hmtx = font.getGlyphSet(), font.getBestCmap(), font['hmtx']
    k = size / 1000
    pen = SVGPathPen(gs, ntos=lambda v: ('%.2f' % v).rstrip('0').rstrip('.'))
    for ch in text:
        if ch == ' ':
            x += space
            continue
        name = cmap[ord(ch)]
        gs[name].draw(TransformPen(pen, (k, 0, 0, -k, x, baseline)))
        x += hmtx[name][0] * k
    return '<path fill="#111" d="%s"/>' % pen.getCommands()


# 학습 주안점 칸: 원래 '오답 원인' 칸의 글자 자리 그대로 (보기 동그라미는 원래 것을 쓴다)
a = band['mistake'][0]
LABEL = (17.54, a + 15.67)  # 칸 이름 기준선
ROWS = [a + 14.25, a + 29.25]  # 보기 글자 기준선 (두 줄)
COLS = [68.12, 171.8]  # 보기 글자 시작 x (두 칸)
CHOICES = ['개념 재학습/오개념 수정', '문제 읽기(조건 찾기)', '계산 실수 교정', '풀이 과정 서술']
# 크기는 PDF 양식 글자와 맞춤 (칸 이름 굵게 7.0pt 간격, 보기 6.88pt 간격; Noto Sans KR 한글 폭 0.92em)
mistake_text = text_path('학습 주안점', LABEL[0], LABEL[1], 'B', 6.996 / 0.92, 1.98) + ''.join(
    text_path(t, COLS[k % 2], ROWS[k // 2], 'R', 6.882 / 0.92, 2.12) for k, t in enumerate(CHOICES))

# 지난 과제 칸: 보기 6개를 칸 너비에 고르게 다시 놓는다 (동그라미는 원래 첫 동그라미를 옮겨 쓴다)
hw = next((a, b) for a, b in zip(dividers, dividers[1:]) if 118 < a < 119)
HW_CHOICES = ['완료', '50% 이상', '50% 미만', '안 함', '두고 옴', '과제 없음']
HW_X0, HW_X1, HW_BASE = 59.22, 266.17, hw[0] + 16.39  # 첫 동그라미 왼쪽, 칸 오른쪽 끝, 보기 글자 기준선
HW_GAP = 7.8  # 동그라미 왼쪽 → 글자 시작 (원래 8.9, 보기가 6개라 조금 줄임)
HW_SPACE = 5  # 보기 사이 최소 간격
# 보기가 한 줄에 들어가도록 글자 크기를 원래(6.88pt 간격)에서 필요한 만큼만 줄인다
hw_size = 6.882 / 0.92
room = HW_X1 - HW_X0 - HW_SPACE * (len(HW_CHOICES) - 1) - HW_GAP * len(HW_CHOICES)
hw_size *= min(1, room / sum(text_width(t, 'R', hw_size, 2.12) for t in HW_CHOICES))
hw_sp = 2.12 * hw_size / (6.882 / 0.92)
widths = [HW_GAP + text_width(t, 'R', hw_size, hw_sp) for t in HW_CHOICES]
space = (HW_X1 - HW_X0 - sum(widths)) / (len(HW_CHOICES) - 1)
hw_bubble = None
hw_text = ''
hw_x = []
x = HW_X0
for t, w in zip(HW_CHOICES, widths):
    hw_x.append(x)
    hw_text += text_path(t, x + HW_GAP, HW_BASE, 'R', hw_size, hw_sp)
    x += w + space

# 출결 칸: [결강][보강] 등원 ___ 하원 ___ → 등원 __:__ 하원 __:__ … [결강][보강]
att = next((a, b) for a, b in zip(dividers, dividers[1:]) if 93 < a < 94)
ATT_X0, ATT_X1 = 59.21, 266.17  # 칸 안쪽 왼쪽(첫 동그라미 자리), 오른쪽 끝
OMR_END = 108.007 + 6.88  # 원래 '보강' 글자 끝
dx_omr = ATT_X1 - OMR_END
LABEL_GAP = 17.34  # '등원' 글자 시작 → 밑줄 시작 (원래 양식과 같음)
ATT_GAP = 10  # 등원 밑줄 끝 → '하원' 글자
line_len = (ATT_X0 + dx_omr - 12 - ATT_X0 - 2 * LABEL_GAP - ATT_GAP) / 2
in_x = ATT_X0
out_x = in_x + LABEL_GAP + line_len + ATT_GAP
att_shift = lambda x: dx_omr if x < 120 else (in_x - 129.14 if x < 180 else out_x - 187.74)
ULINE_Y, ULINE_H = 111.38, 0.71
colon_w = text_width(':', 'R', 6.882 / 0.92, 0)
att_text = ''
for x in (in_x, out_x):
    a = x + LABEL_GAP
    att_text += '<path fill="#8c8c8c" d="M%.2f %.2fh%.2fv%.2fh-%.2fZ"/>' % (a, ULINE_Y, line_len, ULINE_H, line_len)
    att_text += text_path(':', a + (line_len - colon_w) / 2, 109.96, 'R', 6.882 / 0.92, 0)

# 학습 단계 칸: 칸 이름과 'Test' 보기 글자만 바꾼다
stage = next((a, b) for a, b in zip(dividers, dividers[1:]) if 143 < a < 144)
stage_text = text_path('학습 단계', 17.54, 159.11, 'B', 6.996 / 0.92, 1.98) + text_path('평가', 222.03, 159.82, 'R', 6.882 / 0.92, 2.12)

parts = {name: [] for name in OLD}
body = ''
for c in card:
    name = band_of(c)
    t = top_y(c)
    if name is None and c.tag == SVG + 'g' and t is not None and stage[0] + 0.1 < t <= stage[1] + 0.1:
        x = float(c.find(SVG + 'use').get('x'))
        if x < 55 or 215 < x < 243:
            continue  # 옛 글자 '단계', 'Test'
        body += emit(c)
    elif name is None and t is not None and att[0] + 0.1 < t <= att[1] + 0.1:
        if c.tag == SVG + 'path' and not c.get('transform') and c.get('fill', '').startswith('rgb(54.'):
            continue  # 옛 밑줄
        if c.tag == SVG + 'path' and c.get('transform'):
            x = 0.712404 * float(re.findall(r'-?[\d.]+', c.get('d'))[0]) + 0.442753
        elif c.tag == SVG + 'g':
            x = float(c.find(SVG + 'use').get('x'))
        else:
            x = None
        if x is None or x < 55:
            body += emit(c)  # 칸 이름(출결)
        else:
            body += '<g transform="translate(%.2f,0)">%s</g>' % (att_shift(x), emit(c))
    elif name is None and t is not None and hw[0] + 0.1 < t <= hw[1] + 0.1:
        if c.tag == SVG + 'path' and c.get('transform'):
            hw_bubble = hw_bubble or emit(c)  # 보기 동그라미
            continue
        if c.tag == SVG + 'g' and float(c.find(SVG + 'use').get('x')) > 55:
            continue  # 옛 보기 글자
        body += emit(c)
    elif name is None:
        body += emit(c)
    elif name == 'mistake' and c.tag == SVG + 'g':
        continue  # 옛 글자(오답 원인, 계산 실수 …)는 버린다
    elif name == 'attitude' and c.tag == SVG + 'g' and float(c.find(SVG + 'use').get('x')) < 55:
        continue  # 옛 칸 이름 '학습태도'
    else:
        parts[name].append(emit(c))
parts['mistake'].append(mistake_text)
parts['attitude'].append(text_path('지음쌤 톡', 17.54, band['attitude'][0] + 15.67, 'B', 6.996 / 0.92, 1.98))
body += stage_text + att_text + hw_text + ''.join('<g transform="translate(%.2f,0)">%s</g>' % (x - HW_X0, hw_bubble) for x in hw_x)
for name in NEW:
    body += '<g transform="translate(0,%.2f)">%s</g>' % (shift[name], ''.join(parts[name]))

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
