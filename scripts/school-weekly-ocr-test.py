#!/usr/bin/env python3
"""
주간학습안내 무료 OCR(tesseract) 테스트.

school-weekly-data.json의 한 주(기본: 가장 최근 주) 3~6학년 이미지를 받아
  1) 주간학습계획: '수학'이 적힌 칸을 찾아 그 줄(가로)과 그 열(세로)을 잘라 본다.
  2) 학급별 시간표: 칸마다 글자를 읽어 '몇 반 · 무슨 요일'에 수학이 있는지 뽑아 본다.
결과는 ocr-test/ 폴더(요약 summary.md, 칸별 인식 결과, 표시한 이미지, 자른 이미지)에 저장한다.
GitHub Actions에서는 요약이 실행 화면(Summary)에 바로 나온다.

사용: python3 scripts/school-weekly-ocr-test.py [월요일 날짜 YYYY-MM-DD]
      python3 scripts/school-weekly-ocr-test.py --files 계획.jpg 시간표.jpg   (내려받은 이미지로 바로 시험)
필요: tesseract-ocr, tesseract-ocr-kor, pip install pytesseract pillow numpy
"""
import json
import os
import re
import sys
import urllib.request

import numpy as np
import pytesseract
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'ocr-test')
DAYS = ['월', '화', '수', '목', '금']
MATH_RE = re.compile(r'수\s*학')
CLASS_RE = re.compile(r'(\d{1,2})\s*[반받밤발]')  # '반'을 '받' 등으로 잘못 읽는 경우가 많다


# ---------- 표 칸 나누기 ----------

def longest_run(mask_1d):
    """True가 연속으로 이어진 가장 긴 길이"""
    best = cur = 0
    for v in mask_1d:
        cur = cur + 1 if v else 0
        best = max(best, cur)
    return best


def find_lines(dark, axis, min_frac):
    """axis=0: 가로줄(행 번호 목록), axis=1: 세로줄(열 번호 목록). 이어진 줄은 하나로 합친다."""
    arr = dark if axis == 0 else dark.T
    length = arr.shape[1]
    hits = [i for i in range(arr.shape[0]) if arr[i].sum() > length * min_frac and longest_run(arr[i]) > length * min_frac]
    lines, start = [], None
    for k, i in enumerate(hits):
        if start is None:
            start = i
        if k + 1 == len(hits) or hits[k + 1] != i + 1:
            lines.append((start + i) // 2)
            start = None
    return lines


def grid(img):
    g = np.asarray(img.convert('L'))
    dark = g < 150
    rows = find_lines(dark, 0, 0.25)
    cols = find_lines(dark, 1, 0.15)
    return rows, cols


def ocr_cell(img, box):
    x0, y0, x1, y1 = box
    pad = max(5, int(min(x1 - x0, y1 - y0) * 0.08))  # 칸 테두리 선이 글자로 읽히지 않게 안쪽만
    crop = img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')
    if crop.width < 8 or crop.height < 8:
        return ''
    a = np.asarray(crop)
    ys, xs = np.nonzero(a < 150)
    if len(ys) < 15:  # 빈 칸
        return ''
    # 글자가 있는 부분만 남기고 흰 여백을 둘러 준다
    crop = crop.crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1))
    text_h = crop.height
    s = max(1.0, 48 / max(text_h, 1)) if text_h < 48 else 1.0  # 작은 글자는 키워서 읽는다
    if s > 1:
        crop = crop.resize((max(1, int(crop.width * s)), max(1, int(crop.height * s))), Image.LANCZOS)
    canvas = Image.new('L', (crop.width + 40, crop.height + 40), 255)
    canvas.paste(crop, (20, 20))
    psm = '7' if text_h * s < 80 else '6'  # 한 줄이면 7, 여러 줄이면 6
    txt = re.sub(r'\s+', ' ', pytesseract.image_to_string(canvas, lang='kor+eng', config=f'--psm {psm}')).strip()
    if crop.width < crop.height * 1.6 and not re.search(r'[가-힣0-9]', txt):
        # 한 글자 칸(요일 등)은 글자 하나로 다시 읽어 본다
        txt = pytesseract.image_to_string(canvas, lang='kor', config='--psm 10').strip()
    return txt


def read_table(img):
    rows, cols = grid(img)
    cells = []
    for r in range(len(rows) - 1):
        for c in range(len(cols) - 1):
            box = (cols[c], rows[r], cols[c + 1], rows[r + 1])
            if box[2] - box[0] < 8 or box[3] - box[1] < 8:
                continue
            cells.append({'r': r, 'c': c, 'box': box, 'text': ocr_cell(img, box)})
    return rows, cols, cells


def cells_markdown(cells, rows, cols):
    if not cells:
        return '_표 칸을 찾지 못했습니다._\n'
    n_r, n_c = len(rows) - 1, len(cols) - 1
    table = [[''] * n_c for _ in range(n_r)]
    for x in cells:
        table[x['r']][x['c']] = x['text'].replace('|', '/')
    head = '| |' + '|'.join(str(c) for c in range(n_c)) + '|\n|' + '---|' * (n_c + 1) + '\n'
    return head + ''.join(f'|{r}|' + '|'.join(table[r]) + '|\n' for r in range(n_r))


# ---------- 1) 주간학습계획: 수학 칸 자르기 ----------

def plan_test(img, name):
    rows, cols, cells = read_table(img)
    math = [x for x in cells if MATH_RE.search(x['text'])]
    lines = [f'- 표 칸: 가로 {max(len(rows) - 1, 0)}줄 × 세로 {max(len(cols) - 1, 0)}칸', f'- "수학" 찾은 칸: {len(math)}개']
    if math:
        left, right = cols[0], cols[-1]
        top, bottom = rows[0], rows[-1]
        r0 = min(x['box'][1] for x in math); r1 = max(x['box'][3] for x in math)
        c0 = min(x['box'][0] for x in math); c1 = max(x['box'][2] for x in math)
        row_crop = img.crop((left, r0, right, r1)); row_crop.save(os.path.join(OUT, f'{name}_수학_가로줄.png'))
        col_crop = img.crop((c0, top, c1, bottom)); col_crop.save(os.path.join(OUT, f'{name}_수학_세로칸.png'))
        lines.append(f'- 잘라 본 이미지: `{name}_수학_가로줄.png`(수학 칸이 있는 가로줄), `{name}_수학_세로칸.png`(수학 칸이 있는 세로칸)')
        lines.append('- 수학 칸 내용: ' + ' / '.join(f'"{x["text"]}"' for x in math[:6]))
    annotate(img, rows, cols, math, name)
    return '\n'.join(lines) + '\n', cells_markdown(cells, rows, cols)


# ---------- 2) 학급별 시간표: 반별 수학 요일 ----------

def day_of(text):
    t = text.replace(' ', '')
    for d in DAYS:
        if t == d or t.startswith(d + '(') or t.startswith(d + '요'):
            return d
    return None


def timetable_test(img, name):
    rows, cols, cells = read_table(img)
    by_rc = {(x['r'], x['c']): x for x in cells}
    headers = [x for x in cells if day_of(x['text'])]
    # 요일을 3개 이상 읽은 줄은 못 읽은 요일 칸을 열 순서로 채운다 (예: '금'을 'a'로 읽은 경우)
    for r in sorted({h['r'] for h in headers}):
        row = sorted((h for h in headers if h['r'] == r), key=lambda h: h['c'])
        if len(row) < 3:
            continue
        base = row[0]['c'] - DAYS.index(day_of(row[0]['text']))
        for i, d in enumerate(DAYS):
            x = by_rc.get((r, base + i))
            if x and not day_of(x['text']):
                x['text'] = f'{d}(추정:{x["text"]})'
                headers.append(x)
    classes = [x for x in cells if CLASS_RE.search(x['text'])]
    math = [x for x in cells if MATH_RE.search(x['text']) or x['text'].replace(' ', '') == '수학']

    def header_day(cell):
        # 같은 열에서 위쪽으로 가장 가까운 요일 머리칸
        ups = [h for h in headers if h['c'] == cell['c'] and h['r'] < cell['r']]
        return day_of(max(ups, key=lambda h: h['r'])['text']) if ups else None

    def class_of(cell):
        # 같은 줄 왼쪽의 'n반' 칸, 없으면 위쪽에서 가장 가까운 'n반' 칸
        same_row = [k for k in classes if k['r'] == cell['r'] and k['c'] < cell['c']]
        if same_row:
            return CLASS_RE.search(max(same_row, key=lambda k: k['c'])['text']).group(1)
        above = [k for k in classes if k['r'] < cell['r']]
        if above:
            k = min(above, key=lambda k: (cell['r'] - k['r'], abs(cell['c'] - k['c'])))
            return CLASS_RE.search(k['text']).group(1)
        return None

    found = {}
    unknown = []
    for m in math:
        d, k = header_day(m), class_of(m)
        if d and k:
            found.setdefault(int(k), set()).add(d)
        else:
            unknown.append(m)

    lines = [f'- 표 칸: 가로 {max(len(rows) - 1, 0)}줄 × 세로 {max(len(cols) - 1, 0)}칸',
             f'- 읽은 요일 머리칸 {len(headers)}개, "n반" 칸 {len(classes)}개, "수학" 칸 {len(math)}개']
    if found:
        lines.append('\n| 반 | 수학 요일 |\n|---|---|')
        for k in sorted(found):
            lines.append(f'| {k}반 | {", ".join(d for d in DAYS if d in found[k])} |')
    else:
        lines.append('- 반별 수학 요일을 뽑지 못했습니다.')
    if unknown:
        lines.append(f'- 반이나 요일을 못 정한 "수학" 칸 {len(unknown)}개 (줄,칸): ' + ', '.join(f'({u["r"]},{u["c"]})' for u in unknown[:20]))
    annotate(img, rows, cols, math, name)
    return '\n'.join(lines) + '\n', cells_markdown(cells, rows, cols)


# ---------- 공통 ----------

def annotate(img, rows, cols, marks, name):
    a = img.convert('RGB')
    d = ImageDraw.Draw(a)
    for y in rows:
        d.line([(0, y), (a.width, y)], fill=(255, 0, 0), width=1)
    for x in cols:
        d.line([(x, 0), (x, a.height)], fill=(0, 0, 255), width=1)
    for m in marks:
        d.rectangle(m['box'], outline=(0, 180, 0), width=4)
    a.save(os.path.join(OUT, f'{name}_표시.png'))


def download(url, path):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
        f.write(r.read())


def main():
    os.makedirs(OUT, exist_ok=True)
    args = sys.argv[1:]
    jobs = []  # (이름, 이미지 경로, 종류)
    if args[:1] == ['--files']:
        plan, tt = args[1], args[2]
        jobs = [('시험', plan, tt)]
        title = '직접 넣은 이미지'
    else:
        data = json.load(open(os.path.join(ROOT, 'school-weekly-data.json'), encoding='utf-8'))
        weeks = data.get('weeks', [])
        week = next((w for w in weeks if w['monday'] == args[0]), None) if args else (weeks[0] if weeks else None)
        if not week:
            sys.exit('해당 주 데이터가 없습니다.')
        title = f'{week["monday"]} 주'
        for g in sorted(week['grades'], key=int):
            imgs = week['grades'][g]['images']
            if len(imgs) < 2:
                print(f'{g}학년: 이미지가 2장보다 적어 건너뜀')
                continue
            paths = []
            for k, url in enumerate(imgs[:2]):
                p = os.path.join(OUT, f'{g}학년_원본_{k + 1}.jpg')
                download(url, p)
                paths.append(p)
            jobs.append((f'{g}학년', paths[0], paths[1]))

    summary = [f'# 주간학습안내 무료 OCR 테스트 ({title})\n',
               '초록 상자 = "수학"으로 읽은 칸, 빨강/파랑 선 = 찾은 표 줄. 이미지 파일은 실행 화면 아래 Artifacts의 `ocr-test`에 있습니다.\n']
    detail = []
    for name, plan, tt in jobs:
        print(f'{name} 읽는 중…', flush=True)
        p_sum, p_cells = plan_test(Image.open(plan), f'{name}_주간학습계획')
        t_sum, t_cells = timetable_test(Image.open(tt), f'{name}_학급별시간표')
        summary.append(f'## {name}\n\n### 주간학습계획\n{p_sum}\n### 학급별 시간표\n{t_sum}\n')
        detail.append(f'## {name} 주간학습계획 칸별 인식\n\n{p_cells}\n## {name} 학급별 시간표 칸별 인식\n\n{t_cells}\n')

    text = '\n'.join(summary)
    with open(os.path.join(OUT, 'summary.md'), 'w', encoding='utf-8') as f:
        f.write(text)
    with open(os.path.join(OUT, 'cells.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(detail))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as f:
            f.write(text + '\n<details><summary>칸별 인식 결과 전체</summary>\n\n' + '\n'.join(detail) + '\n</details>\n')
    print(text)


if __name__ == '__main__':
    main()
