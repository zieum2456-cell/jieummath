#!/usr/bin/env python3
"""
주간학습안내에서 수학 부분만 뽑아 school-weekly-data.json에 더한다 (무료 OCR, tesseract).

학년마다
  1) 주간학습계획: '수학' 줄과 '가정통신' 줄을 찾아 위아래로 이어 붙인 이미지를
     school-weekly/<월요일>/<학년>.jpg 로 저장한다.
  2) 학급별 시간표: 반마다 작은 표를 찾아, 머리줄 '수'(수요일)와 글자 모양이 닮은 칸을
     수학으로 보아 반별 수학 요일을 뽑는다.
게시물 이미지는 첫 장이 주간학습계획이고, 학급별 시간표가 몇 번째인지는 게시물마다 다르다
(5학년은 전담 시간표가 앞에 오기도 뒤에 오기도 한다). 그래서 나머지 이미지를 모두 읽어
반 시간표가 가장 많이 나온 이미지를 학급별 시간표로 쓴다.
결과는 게시물마다 "extract": {"from": [게시물 이미지 전부], "plan": 자른 이미지 경로,
"timetable": 학급별 시간표 이미지 번호, "math": {"1": ["화", "수"], ...}, "guessed": [번호를 추정한 반]} 으로 적는다.
이미지가 바뀌지 않은 게시물은 다시 읽지 않는다. GitHub Actions(school-weekly.yml)에서 수집 뒤에 실행한다.

사용: python3 scripts/school-weekly-extract.py            (데이터 파일의 모든 주)
      python3 scripts/school-weekly-extract.py --files 계획.jpg 시간표.jpg ...   (게시물 이미지로 바로 시험)
필요: tesseract-ocr, tesseract-ocr-kor, pip install pytesseract pillow numpy scipy
"""
import io
import json
import os
import re
import shutil
import sys
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pytesseract
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, 'school-weekly-data.json')
CROPS = 'school-weekly'  # 자른 이미지를 두는 폴더 (저장소 기준)
DAYS = ['월', '화', '수', '목', '금']
MATH_RE = re.compile(r'수\s*학')
NOTICE_RE = re.compile(r'가\s*정|통\s*신')


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


# ---------- 1) 주간학습계획: 수학 줄 + 가정통신 줄 ----------

def plan_crop(img):
    """수학 줄과 가정통신 줄을 위아래로 이어 붙인 이미지 (수학 줄을 못 찾으면 None)"""
    rows, cols, cells = read_table(img)
    math = [x for x in cells if MATH_RE.search(x['text'])]
    if not math:
        return None
    # 가정통신: 첫 칸에 '가정 / 통신' 두 줄로 적혀 있어 한 줄 읽기(psm 7)로는 못 읽는 경우가 많다
    notice = [x for x in cells if x['c'] == 0 and (NOTICE_RE.search(x['text']) or NOTICE_RE.search(ocr_cell(img, x['box'], psm='6')))]
    left, right = cols[0], cols[-1]
    bands = [(min(x['box'][1] for x in f), max(x['box'][3] for x in f)) for f in (math, notice) if f]
    parts = [img.crop((left, r0, right, r1)) for r0, r1 in bands]
    out = Image.new('RGB', (right - left, sum(p.height for p in parts)), 'white')
    y = 0
    for part in parts:
        out.paste(part, (0, y))
        y += part.height
    return out


# ---------- 2) 학급별 시간표: 반별 수학 요일 ----------
#
# 학급별 시간표는 반마다 작은 표(블록)가 여러 개 놓인 양식이다.
#   [제목 줄: '3-1' 같은 반 이름]   (6학년은 없음: 머리줄 첫 칸에 '1반')
#   [머리줄: (반) 월 화 수 목 금]
#   [교시 줄 6~8줄: 교시 번호 + 과목 첫 글자]
# 그래서 페이지에서 표 블록을 하나씩 찾고, 블록마다 머리줄 아래 줄들 × 오른쪽 5칸을 요일·교시로 본다.
# 제목 줄은 세로 칸 선이 없는 줄(칸을 합친 줄)로 알아본다.

def table_blocks(img):
    """페이지에서 테두리로 둘러싸인 작은 표 블록들의 (x0, y0, x1, y1)"""
    from scipy import ndimage
    g = np.asarray(img.convert('L'))
    dark = g < 160
    L = max(15, int(img.width * 0.04))  # 이보다 긴 가로/세로 획만 표 선으로 본다
    h = ndimage.binary_opening(dark, structure=np.ones((1, L)))
    v = ndimage.binary_opening(dark, structure=np.ones((L, 1)))
    frame = h | v  # 붙어 있는 이웃 블록과 합쳐지지 않게 넓히지 않는다
    blocks = []

    def collect(mask, ox, oy, depth):
        labels, n = ndimage.label(mask)
        for sl in ndimage.find_objects(labels):
            y0, y1, x0, x1 = sl[0].start, sl[0].stop, sl[1].start, sl[1].stop
            if not (x1 - x0 > img.width * 0.12 and y1 - y0 > img.height * 0.06):
                continue
            blocks.append((ox + x0, oy + y0, ox + x1, oy + y1))
            if depth == 0 and x1 - x0 > img.width * 0.4 and y1 - y0 > img.height * 0.25:
                # 반 블록들을 감싼 큰 바깥 표에 블록이 붙어 하나로 이어진 경우(4학년 등):
                # 바깥 표를 끝까지 가로지르는 선을 지우고 그 안에서 다시 찾는다
                part = mask[sl].copy()
                hh, vv = h[oy + y0:oy + y1, ox + x0:ox + x1], v[oy + y0:oy + y1, ox + x0:ox + x1]
                part[[longest_run(r) > (x1 - x0) * 0.9 for r in hh], :] = False
                part[:, [longest_run(c) > (y1 - y0) * 0.9 for c in vv.T]] = False
                collect(part, ox + x0, oy + y0, 1)

    collect(frame, 0, 0, 0)
    out = []  # 다시 찾으며 겹쳐 나온 블록은 하나만 남긴다
    for b in blocks:
        if not any(all(abs(b[i] - o[i]) <= 4 for i in range(4)) for o in out):
            out.append(b)
    return out, h, v


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
    # 굵은 글자가 한 칸에 세로로 이어져 선처럼 보이는 경우(6학년)가 있어, 칸을 반쯤으로 가르는 선은 뺀다
    while len(cols) > 3:
        gaps = np.diff(cols)
        small = [i for i, gp in enumerate(gaps) if gp < np.median(gaps) * 0.6]
        if not small:
            break
        i, med = small[0], np.median(gaps)
        # 좁은 칸의 양쪽 선 중, 지웠을 때 합쳐진 칸 너비가 보통 칸 너비에 더 가까운 쪽을 지운다
        cand = [j for j in (i, i + 1) if 0 < j < len(cols) - 1]
        del cols[min(cand, key=lambda j: abs(cols[j + 1] - cols[j - 1] - med))]
    return rows, cols


def title_rows(rows, cols, v):
    """블록 위쪽의 제목 줄 수: 세로 칸 선(월~금 사이)이 지나가지 않는 줄"""
    n = 0
    for r in range(len(rows) - 1):
        y = (rows[r] + rows[r + 1]) // 2
        if any(v[y, max(0, c - 2):c + 3].any() for c in cols[2:-1]):
            break
        n += 1
    return n


def class_name(img, rows, cols, n_title, lines=None):
    """블록의 반 번호: 제목 줄('3-1', '4-10') 또는 머리줄 첫 칸('1반', '10반').
    돌려주는 값: (반 번호 또는 None, 읽은 글자, 반 시간표처럼 보이는지)"""
    title = ocr_box(img, (cols[0], rows[0], cols[-1], rows[n_title]), psm='7', lines=lines) if n_title > 0 else ''
    corner = ocr_box(img, (cols[0], rows[n_title], cols[1], rows[n_title + 1]), psm='6', lines=lines)
    label = ' / '.join(t for t in (title, corner) if t)
    # 띄어 읽은 숫자('4-1 1')와 1로 읽어야 할 획('4-ㅣ')을 고친다
    t, c = (re.sub(r'(?<=[-–—\d])[ㅣlI|!]|[ㅣlI|!](?=\d)', '1', x.replace(' ', '')) for x in (title, corner))
    m = (re.fullmatch(r'\d[-–—](\d{1,2})', t)          # '3-1' (3·4학년)
         or re.fullmatch(r'(\d{1,2})[반받밤발바]', t)      # '1반' (5학년)
         or re.fullmatch(r'(\d{1,2})[반받밤발바]', c))     # 머리줄 첫 칸 '1반', '10 / 반' (6학년)
    if m:
        return int(m.group(1)), label, True
    # 번호만 못 읽은 경우('3-?', '4-ㅣ', '반'): 반 시간표로 보고 번호는 앞 블록 다음으로 추정
    looks = bool(re.match(r'\s*\d\s*[-–—]', title)) or bool(re.fullmatch(r'\s*\d{0,2}\s*[반받밤발바]\s*', title)) or bool(re.fullmatch(r'\s*\d{0,2}\s*[반받밤발바]?\s*', corner) and corner.strip())
    return None, label, looks


def ocr_box(img, box, psm, lines=None):
    x0, y0, x1, y1 = box
    pad = 3
    crop = img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')
    if lines is not None:  # 굵은 표 선이 글자('|', '0')로 읽히지 않게 지운다
        a = np.asarray(crop).copy()
        a[lines[y0 + pad:y1 - pad, x0 + pad:x1 - pad]] = 255
        crop = Image.fromarray(a)
    s = max(1.0, 64 / max(crop.height, 1))
    crop = crop.resize((int(crop.width * s), int(crop.height * s)), Image.LANCZOS)
    canvas = Image.new('L', (crop.width + 40, crop.height + 40), 255)
    canvas.paste(crop, (20, 20))
    return re.sub(r'\s+', ' ', pytesseract.image_to_string(canvas, lang='kor', config=f'--psm {psm}')).strip()


def glyph(img, box, lines):
    """칸 안 글자 모양을 24×24로 맞춘 정규화 벡터 (빈 칸이면 None)"""
    x0, y0, x1, y1 = box
    # 테두리는 표 선 자리(lines)를 지워서 뺀다. 안쪽을 많이 잘라 내면 작은 이미지(6학년)에서 글자가 잘린다
    pad = max(2, int(min(x1 - x0, y1 - y0) * 0.06))
    a = np.asarray(img.crop((x0 + pad, y0 + pad, x1 - pad, y1 - pad)).convert('L')).astype(float)
    a[lines[y0 + pad:y1 - pad, x0 + pad:x1 - pad]] = np.median(a)
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


def math_days(img):
    """반별 수학 요일 ({반: [요일...]}, 번호를 추정한 반 목록). 반 시간표를 못 찾으면 ({}, [])"""
    blocks, h, v = table_blocks(img)
    lines = h | v
    parsed = []
    for b in sorted(blocks, key=lambda b: (round(b[1] / 40), b[0])):
        rows, cols = block_grid(b, h, v)
        n_r, n_c = len(rows) - 1, len(cols) - 1
        if n_c != 6 or n_r < 7:  # 반 시간표가 아닌 표(영어·음악 전담 등)는 건너뜀
            continue
        n_title = title_rows(rows, cols, v)
        periods = n_r - n_title - 1  # 머리줄 아래 교시 줄 (보통 6줄, 8교시까지 있는 주도 있다)
        if not 5 <= periods <= 9:
            continue
        k, _, looks = class_name(img, rows, cols, n_title, lines)
        if k is None and not looks:  # 반 이름이 없는 표(영어·음악 전담, 강당 등)는 반 시간표가 아님
            continue
        guessed = k is None
        if guessed:
            k = (max(x[0] for x in parsed) if parsed else 0) + 1
        # 과목 글자는 OCR 대신, 같은 표 머리줄의 '수'(수요일) 글자 모양과 비교한다 (같은 글꼴이라 잘 맞는다)
        tmpl = glyph(img, (cols[3], rows[n_title], cols[4], rows[n_title + 1]), lines)
        cells = []
        for r in range(n_title + 1, n_r):
            for d in range(5):
                cells.append((d, glyph(img, (cols[d + 1], rows[r], cols[d + 2], rows[r + 1]), lines)))
        parsed.append((k, guessed, tmpl, cells))

    def score(g, t):
        return float((g * t).sum()) if g is not None and t is not None else None

    # 2단계: 머리줄 '수'와 꽤 닮은 본문 칸들의 평균 모양을 새 기준으로 삼는다.
    # (머리줄 글자가 본문보다 굵은 양식(5학년)에서도 본문 '수'끼리는 아주 닮았다)
    pool = [g for _, _, t, cells in parsed for _, g in cells if (score(g, t) or 0) >= SEED]
    ref = None
    if len(pool) >= 3:
        ref = np.mean(pool, axis=0)
        ref = ref - ref.mean()
        ref = ref / np.linalg.norm(ref)

    found, guesses = {}, []
    for k, guessed, tmpl, cells in parsed:
        days = {DAYS[d] for d, g in cells if (score(g, ref if ref is not None else tmpl) or 0) >= MATCH}
        found[k] = [d for d in DAYS if d in days]
        if guessed:
            guesses.append(k)
    return found, sorted(guesses)


# ---------- 데이터 파일 갱신 ----------

def download(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return Image.open(io.BytesIO(r.read())).convert('RGB')


def extract(plan_img, tt_imgs, crop_path):
    """한 게시물의 결과. tt_imgs: 계획표 뒤의 이미지들 (번호는 1부터).
    실패한 부분은 null로 둔다 (화면에서는 원본 이미지를 보여 준다)"""
    out = {'plan': None, 'timetable': None, 'math': None, 'guessed': []}
    try:
        crop = plan_crop(plan_img)
        if crop is not None:
            os.makedirs(os.path.dirname(os.path.join(ROOT, crop_path)), exist_ok=True)
            crop.save(os.path.join(ROOT, crop_path), quality=88)
            out['plan'] = crop_path
    except Exception as e:  # 한 부분이 실패해도 나머지는 계속한다
        print(f'  계획표 자르기 실패: {e!r}')
    best = None
    for i, img in enumerate(tt_imgs, 1):
        try:
            found, guesses = math_days(img)
        except Exception as e:
            print(f'  {i + 1}번째 이미지 읽기 실패: {e!r}')
            continue
        if found and (best is None or len(found) > len(best[1])):
            best = (i, found, guesses)
    if best:
        i, found, guesses = best
        out['timetable'] = i
        out['math'] = {str(k): found[k] for k in sorted(found)}
        out['guessed'] = guesses
    return out


def main():
    args = sys.argv[1:]
    if args[:1] == ['--files']:
        imgs = [Image.open(f).convert('RGB') for f in args[1:]]
        r = extract(imgs[0], imgs[1:], 'ocr-test/계획표_수학.jpg')
        print(json.dumps(r, ensure_ascii=False, indent=1))
        return
    data = json.load(open(DATA, encoding='utf-8'))
    changed = False
    for w in data.get('weeks', []):
        for g in sorted(w['grades'], key=int):
            p = w['grades'][g]
            src = p.get('images', [])
            x = p.get('extract') or {}
            if len(src) < 2 or (x.get('from') == src and 'timetable' in x):  # timetable이 없으면 예전 방식으로 읽은 결과
                continue
            print(f'{w["monday"]} {g}학년 읽는 중…', flush=True)
            try:
                imgs = [download(u) for u in src]
            except Exception as e:  # 이미지를 못 받으면 다음 실행 때 다시 해 본다
                print(f'::warning::{w["monday"]} {g}학년 이미지 받기 실패: {e}')
                continue
            r = extract(imgs[0], imgs[1:], f'{CROPS}/{w["monday"]}/{g}.jpg')
            p['extract'] = {'from': src, **r}
            changed = True
            n = len(r['math'] or {})
            print(f'  계획표 {"잘라 냄" if r["plan"] else "못 찾음"}, 반 시간표 {n}반' + (f' ({r["timetable"] + 1}번째 이미지)' if n else '') + (f' (번호 추정: {r["guessed"]})' if r['guessed'] else ''))

    # 데이터에서 빠진 주의 자른 이미지는 지운다
    keep = {w['monday'] for w in data.get('weeks', [])}
    base = os.path.join(ROOT, CROPS)
    for d in os.listdir(base) if os.path.isdir(base) else []:
        if d not in keep:
            shutil.rmtree(os.path.join(base, d))
            changed = True
    if changed:
        data['updatedAt'] = datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
        with open(DATA, 'w', encoding='utf-8') as f:
            f.write(json.dumps(data, ensure_ascii=False, indent=1) + '\n')
        print('저장했습니다.')
    else:
        print('새로 읽을 게시물 없음')


if __name__ == '__main__':
    main()
