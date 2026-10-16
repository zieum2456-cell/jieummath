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
필요: tesseract-ocr, tesseract-ocr-kor, pip install pytesseract pillow numpy scipy
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


def ocr_cell(img, box, psm=None):
    x0, y0, x1, y1 = box
    pad = max(5, int(min(x1 - x0, y1 - y0) * 0.08))  # 칸 테두리 선이 글자로 읽히지 않게 안쪽만
    if x1 - x0 < 2 * pad + 8 or y1 - y0 < 2 * pad + 8:  # 글자가 들어갈 수 없는 좁은 칸(겹줄 사이 등)
        return ''
    crop = img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')
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
    psm = psm or ('7' if text_h * s < 80 else '6')  # 한 줄이면 7, 여러 줄이면 6
    txt = re.sub(r'\s+', ' ', pytesseract.image_to_string(canvas, lang='kor', config=f'--psm {psm}')).strip()
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

NOTICE_RE = re.compile(r'가\s*정|통\s*신')


def plan_test(img, name):
    rows, cols, cells = read_table(img)
    math = [x for x in cells if MATH_RE.search(x['text'])]
    # 가정통신: 첫 칸에 '가정 / 통신' 두 줄로 적혀 있어 한 줄 읽기(psm 7)로는 못 읽는 경우가 많다
    notice = []
    for x in cells:
        if x['c'] != 0:
            continue
        if not NOTICE_RE.search(x['text']):
            x['text2'] = ocr_cell(img, x['box'], psm='6')
            if not NOTICE_RE.search(x['text2']):
                continue
        notice.append(x)
    lines = [f'- 표 칸: 가로 {max(len(rows) - 1, 0)}줄 × 세로 {max(len(cols) - 1, 0)}칸',
             f'- "수학" 찾은 칸: {len(math)}개, "가정통신" 찾은 칸: {len(notice)}개']
    left, right = (cols[0], cols[-1]) if cols else (0, img.width)
    bands = []
    for label, found in (('수학', math), ('가정통신', notice)):
        if found:
            bands.append((min(x['box'][1] for x in found), max(x['box'][3] for x in found)))
    if math:
        r0, r1 = bands[0]
        img.crop((left, r0, right, r1)).save(os.path.join(OUT, f'{name}_수학_가로줄.png'))
        lines.append('- 수학 칸 내용: ' + ' / '.join(f'"{x["text"]}"' for x in math[:6]))
    if bands:
        # 수학 줄과 가정통신 줄을 위아래로 이어 붙인 한 장 (최종 화면에 쓸 모양)
        parts = [img.crop((left, r0, right, r1)) for r0, r1 in bands]
        out = Image.new('RGB', (right - left, sum(p.height for p in parts)), 'white')
        y = 0
        for part in parts:
            out.paste(part, (0, y)); y += part.height
        out.save(os.path.join(OUT, f'{name}_수학_가정통신.png'))
        lines.append(f'- 잘라 본 이미지: `{name}_수학_가정통신.png`' + (f', `{name}_수학_가로줄.png`' if math else ''))
    annotate(img, rows, cols, math + notice, name)
    return '\n'.join(lines) + '\n', cells_markdown(cells, rows, cols)


# ---------- 2) 학급별 시간표: 반별 수학 요일 ----------
#
# 학급별 시간표는 반마다 작은 표(블록)가 여러 개 놓인 양식이다.
#   [제목 줄: '3-1' 같은 반 이름]   (6학년은 없음: 머리줄 첫 칸에 '1반')
#   [머리줄: (반) 월 화 수 목 금]
#   [1~6교시 6줄: 교시 번호 + 과목 첫 글자]
# 그래서 페이지에서 표 블록을 하나씩 찾고, 블록마다 끝의 6줄 × 오른쪽 5칸을 요일·교시로 본다.

def table_blocks(img):
    """페이지에서 테두리로 둘러싸인 작은 표 블록들의 (x0, y0, x1, y1)"""
    from scipy import ndimage
    g = np.asarray(img.convert('L'))
    dark = g < 160
    L = max(15, int(img.width * 0.04))  # 이보다 긴 가로/세로 획만 표 선으로 본다
    h = ndimage.binary_opening(dark, structure=np.ones((1, L)))
    v = ndimage.binary_opening(dark, structure=np.ones((L, 1)))
    frame = h | v  # 붙어 있는 이웃 블록과 합쳐지지 않게 넓히지 않는다
    labels, n = ndimage.label(frame)
    blocks = []
    for sl in ndimage.find_objects(labels):
        y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
        if x1 - x0 > img.width * 0.12 and y1 - y0 > img.height * 0.06:
            blocks.append((x0, y0, x1, y1))
    return blocks, h, v


def merge_lines(idx):
    out, start = [], None
    for k, i in enumerate(idx):
        if start is None:
            start = i
        if k + 1 == len(idx) or idx[k + 1] != i + 1:
            out.append((start + i) // 2)
            start = None
    return out


def block_grid(block, h, v):
    x0, y0, x1, y1 = block
    hs = h[y0:y1, x0:x1].sum(axis=1)
    vs = v[y0:y1, x0:x1].sum(axis=0)
    rows = [y0 + i for i in merge_lines([i for i, s in enumerate(hs) if s > (x1 - x0) * 0.5])]
    cols = [x0 + i for i in merge_lines([i for i, s in enumerate(vs) if s > (y1 - y0) * 0.5])]
    return rows, cols


def class_name(img, rows, cols, n_title):
    """블록의 반 번호: 제목 줄('3-1', '4-10') 또는 머리줄 첫 칸('1반', '10반').
    돌려주는 값: (반 번호 또는 None, 읽은 글자, 반 시간표처럼 보이는지)"""
    title = ocr_box(img, (cols[0], rows[0], cols[-1], rows[n_title]), psm='7') if n_title > 0 else ''
    corner = ocr_box(img, (cols[0], rows[n_title], cols[1], rows[n_title + 1]), psm='6')
    label = ' / '.join(t for t in (title, corner) if t)
    m = (re.fullmatch(r'\s*\d\s*[-–—]\s*(\d{1,2})\s*', title)          # '3-1' (3·4학년)
         or re.fullmatch(r'\s*(\d{1,2})\s*[반받밤발]\s*', title)           # '1반' (5학년)
         or re.fullmatch(r'\s*(\d{1,2})\s*[반받밤발]\s*', corner))         # 머리줄 첫 칸 '1반' (6학년)
    if m:
        return int(m.group(1)), label, True
    # 번호만 못 읽은 경우('3-?', '4-ㅣ', '반'): 반 시간표로 보고 번호는 앞 블록 다음으로 추정
    looks = bool(re.match(r'\s*\d\s*[-–—]', title)) or bool(re.fullmatch(r'\s*\d{0,2}\s*[반받밤발]\s*', title)) or bool(re.fullmatch(r'\s*\d{0,2}\s*[반받밤발]?\s*', corner) and corner.strip())
    return None, label, looks


def ocr_box(img, box, psm):
    x0, y0, x1, y1 = box
    pad = 3
    crop = img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')
    s = max(1.0, 64 / max(crop.height, 1))
    crop = crop.resize((int(crop.width * s), int(crop.height * s)), Image.LANCZOS)
    canvas = Image.new('L', (crop.width + 40, crop.height + 40), 255)
    canvas.paste(crop, (20, 20))
    return re.sub(r'\s+', ' ', pytesseract.image_to_string(canvas, lang='kor', config=f'--psm {psm}')).strip()


def glyph(img, box):
    """칸 안 글자 모양을 24×24로 맞춘 정규화 벡터 (빈 칸이면 None)"""
    x0, y0, x1, y1 = box
    pad = max(3, int(min(x1 - x0, y1 - y0) * 0.12))
    a = np.asarray(img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')).astype(float)
    m = a < np.median(a) - 60  # 칸 바탕색보다 충분히 진한 부분 = 글자
    if m.sum() < 8:
        return None
    ys, xs = np.nonzero(m)
    m = m[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    g = np.asarray(Image.fromarray((m * 255).astype(np.uint8)).resize((24, 24), Image.BILINEAR)) / 255.0
    g = g - g.mean()
    n = np.linalg.norm(g)
    return g / n if n else None


SEED = 0.45  # 1단계: 머리줄 '수'(수요일)와 이 이상 닮은 본문 칸을 모아 기준 모양을 만든다
MATCH = 0.6  # 2단계: 기준 모양과 이 이상 닮으면 수학으로 본다


def timetable_test(img, name):
    blocks, h, v = table_blocks(img)
    found, report, marks, guesses, parsed = {}, [], [], set(), []
    all_rows, all_cols = [], []
    skipped = 0
    for b in sorted(blocks, key=lambda b: (round(b[1] / 40), b[0])):
        rows, cols = block_grid(b, h, v)
        n_r, n_c = len(rows) - 1, len(cols) - 1
        if n_c != 6 or n_r < 7:  # 반 시간표가 아닌 표(영어·음악 전담 등)는 건너뜀
            skipped += 1
            continue
        all_rows += rows; all_cols += cols
        n_title = n_r - 7
        k, label, looks = class_name(img, rows, cols, n_title)
        if k is None and not looks:  # 반 이름이 없는 표(영어·음악 전담, 강당 등)는 반 시간표가 아님
            skipped += 1
            continue
        guessed = k is None
        if guessed:
            k = (max(x[0] for x in parsed) if parsed else 0) + 1
        # 과목 글자는 OCR 대신, 같은 표 머리줄의 '수'(수요일) 글자 모양과 비교한다 (같은 글꼴이라 잘 맞는다)
        hr = n_r - 7
        tmpl = glyph(img, (cols[3], rows[hr], cols[4], rows[hr + 1]))
        cells = []
        for p in range(6):
            r = n_r - 6 + p
            for d in range(5):
                box = (cols[d + 1], rows[r], cols[d + 2], rows[r + 1])
                cells.append((p, d, box, glyph(img, box)))
        parsed.append((k, guessed, label, tmpl, cells))

    def score(g, t):
        return float((g * t).sum()) if g is not None and t is not None else None

    # 2단계: 머리줄 '수'와 꽤 닮은 본문 칸들의 평균 모양을 새 기준으로 삼는다.
    # (머리줄 글자가 본문보다 굵은 양식(5학년)에서도 본문 '수'끼리는 아주 닮았다)
    pool = [g for _, _, _, t, cells in parsed for _, _, _, g in cells if (score(g, t) or 0) >= SEED]
    ref = None
    if len(pool) >= 3:
        ref = np.mean(pool, axis=0)
        ref = ref - ref.mean()
        ref = ref / np.linalg.norm(ref)

    for k, guessed, label, tmpl, cells in parsed:
        grid = [[None] * 5 for _ in range(6)]
        days = set()
        for p, d, box, g in cells:
            sim = score(g, ref if ref is not None else tmpl)
            grid[p][d] = sim
            if sim is not None and sim >= MATCH:
                days.add(DAYS[d])
                marks.append({'box': box})
        found[k] = days
        if guessed:
            guesses.add(k)
        grid_txt = [' '.join('  · ' if x is None else f'{x:4.2f}' for x in row) for row in grid]
        report.append(f'<details><summary>{k}반{" (번호 추정)" if guessed else ""} (반 이름 인식: "{label}")</summary>\n\n```\n'
                      "'수'와 닮은 정도 (0.6 이상 = 수학)\n 월   화   수   목   금\n" + '\n'.join(grid_txt) + '\n```\n</details>')
    lines = [f'- 찾은 반 시간표 블록: {len(found)}개 (반 시간표가 아닌 표 {skipped}개 건너뜀)']
    if found:
        lines.append('\n| 반 | 수학 요일 |\n|---|---|')
        for k in sorted(found):
            lines.append(f'| {k}반{" (번호 추정)" if k in guesses else ""} | {", ".join(d for d in DAYS if d in found[k]) or "-"} |')
        lines.append('\n블록별로 읽은 과목 글자:\n\n' + '\n'.join(report))
    else:
        lines.append('- 반 시간표 블록을 찾지 못했습니다.')
    annotate(img, sorted(set(all_rows)), sorted(set(all_cols)), marks, name)
    return '\n'.join(lines) + '\n', ''


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
        try:
            p_sum, p_cells = plan_test(Image.open(plan), f'{name}_주간학습계획')
        except Exception as e:  # 한 학년이 실패해도 나머지 학년은 계속 시험한다
            p_sum, p_cells = f'- 오류: {e!r}\n', ''
        try:
            t_sum, t_cells = timetable_test(Image.open(tt), f'{name}_학급별시간표')
        except Exception as e:
            t_sum, t_cells = f'- 오류: {e!r}\n', ''
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
