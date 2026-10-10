"""기준점(네 모서리 검은 사각형)을 찾아 사진 속 카드를 한 장씩 분리하고 원근을 보정한다."""
import itertools
import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from .template import TEMPLATE

DETECT_MAX_SIDE = 2400  # 기준점 찾기는 줄인 이미지에서 한다
WARP_SCALE = 5.0  # 보정된 카드 이미지: 1pt = 5px
PAD_PT = 10.0  # 카드 바깥 여백 (카드 끝을 넘겨 쓴 글씨까지 담기 위해)

_M = TEMPLATE["markers"]
CARD_W = _M["tr"]["x"] - _M["tl"]["x"]  # 기준점 사이 가로 (pt)
CARD_H = _M["bl"]["y"] - _M["tl"]["y"]  # 기준점 사이 세로 (pt)
SMALL_SIZE = (_M["tr"]["size"] + _M["bl"]["size"] + _M["br"]["size"]) / 3


@dataclass
class Marker:
    x: float
    y: float
    area: float

    @property
    def side(self):
        return math.sqrt(self.area)


@dataclass
class DetectedCard:
    corners: dict  # tl/tr/bl/br → (x, y) 원본 이미지 좌표
    image: np.ndarray  # 보정된 카드 (BGR)
    warnings: list = field(default_factory=list)


@dataclass
class DetectResult:
    cards: list
    missed: int  # 기준점이 일부만 잡힌 카드 수 (추정)

    @property
    def total(self):
        return len(self.cards) + self.missed


def _paper_level(gray):
    """그림자·조명 차이를 감안한 '종이 밝기' 지도."""
    h, w = gray.shape
    small = cv2.resize(gray, (max(1, w // 8), max(1, h // 8)), interpolation=cv2.INTER_AREA)
    k = max(3, (max(small.shape) // 25) | 1)
    bg = cv2.morphologyEx(small, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (k, k)))
    bg = cv2.GaussianBlur(bg, (k, k), 0)
    return cv2.resize(bg, (w, h), interpolation=cv2.INTER_LINEAR)


def find_marker_candidates(img_bgr):
    """꽉 찬 검은 정사각형 후보들. (후보 목록, 축소 비율)"""
    h, w = img_bgr.shape[:2]
    scale = min(1.0, DETECT_MAX_SIDE / max(h, w))
    small = cv2.resize(img_bgr, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA) if scale < 1 else img_bgr
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    bg = _paper_level(gray).astype(np.float32)
    dark = ((gray.astype(np.float32) < bg * 0.5) & (gray < 110)).astype(np.uint8) * 255
    contours, _ = cv2.findContours(dark, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    out = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < 30:
            continue
        (cx, cy), (rw, rh), _ = cv2.minAreaRect(c)
        if rw < 5 or rh < 5:
            continue
        aspect = rw / rh
        if not 0.7 < aspect < 1.43:
            continue
        if area / (rw * rh) < 0.72:  # 꽉 찬 사각형만 (원근·흐림으로 모서리가 둥글어진 것까지)
            continue
        hull = cv2.convexHull(c)
        if area / max(cv2.contourArea(hull), 1) < 0.88:
            continue
        m = cv2.moments(c)
        out.append(Marker(m["m10"] / m["m00"] / scale, m["m01"] / m["m00"] / scale, area / scale / scale))
    return out


def _quad_geometry(pts):
    """네 점이 카드 기준점 배치(가로:세로 ≈ 247:363 직사각형)에 맞는지.

    맞으면 (점수, 가능한 방향 2가지) — 점수는 작을수록 좋다. 방향은 {tl,tr,bl,br: 점 번호}.
    짧은 변이 위·아래이므로 방향은 '바로' 또는 '180도 뒤집힘' 두 가지만 남는다.
    """
    c = pts.mean(axis=0)
    order = sorted(range(4), key=lambda i: math.atan2(pts[i][1] - c[1], pts[i][0] - c[0]))  # 화면에서 시계 방향
    p = [pts[i] for i in order]
    sides = [np.linalg.norm(p[(k + 1) % 4] - p[k]) for k in range(4)]
    # 짧은 변 두 개가 마주 보는 쪽을 위·아래로 본다
    start = 0 if sides[0] + sides[2] < sides[1] + sides[3] else 1
    w = (sides[start] + sides[start + 2]) / 2
    h = (sides[start + 1] + sides[(start + 3) % 4]) / 2
    ratio = h / w
    expected = CARD_H / CARD_W
    if not expected * 0.75 < ratio < expected * 1.3:
        return None
    tl, tr, br, bl = (p[(start + k) % 4] for k in range(4))
    v1, v2 = tr - tl, bl - tl
    cosang = abs(np.dot(v1, v2)) / (np.linalg.norm(v1) * np.linalg.norm(v2))
    if cosang > 0.42:  # 직각에서 25°쯤 넘게 벗어나면 제외
        return None
    para = np.linalg.norm((tr + bl - tl) - br) / w  # 평행사변형에서 벗어난 정도
    if para > 0.3:
        return None
    score = para + cosang + abs(math.log(ratio / expected))
    names = ("tl", "tr", "br", "bl")
    a = {names[k]: order[(start + k) % 4] for k in range(4)}
    b = {names[k]: order[(start + 2 + k) % 4] for k in range(4)}
    return score, (a, b)


def _layout_score(img_bgr, corners):
    """이 방향으로 폈을 때 양식의 OMR 칸 테두리가 제자리에 보이는 정도 (바른 카드 ≈ 0.5~0.7, 아니면 ≈ 0)."""
    scale = 2.0
    w = warp_card(img_bgr, corners, scale)
    v = w.max(axis=2).astype(np.float32)
    dark = (v < np.percentile(v, 90) * 0.6).astype(np.uint8)
    dark = cv2.dilate(dark, np.ones((3, 3), np.uint8))
    vals = []
    for b in TEMPLATE["bubbles"]:
        x0, y0 = card_to_px(b["x0"], b["y0"], scale)
        x1, y1 = card_to_px(b["x1"], b["y1"], scale)
        x0, y0, x1, y1 = int(x0), int(y0), int(x1), int(y1)
        ring = dark[y0:y1 + 1, x0:x1 + 1].astype(np.float32)
        out = dark[y0 - 3:y1 + 4, x0 - 3:x1 + 4].astype(np.float32)
        if ring.size == 0 or out.size == 0:
            vals.append(0.0)
            continue
        ring_v = (ring[0].mean() + ring[-1].mean() + ring[:, 0].mean() + ring[:, -1].mean()) / 4
        out_v = (out[0].mean() + out[-1].mean()) / 2
        vals.append(ring_v - out_v)
    return float(np.mean(vals))


LAYOUT_MIN = 0.25


def group_cards(cands, img_bgr):
    """후보 기준점을 4개씩 묶어 카드로 만든다. (묶음 목록, 남은 후보)

    묶음마다 양식의 칸 배치와 맞춰 보고 방향을 정하므로, 원근 때문에 기준점 크기가 달라 보여도 괜찮다.
    """
    n = len(cands)
    pts = np.array([[m.x, m.y] for m in cands], dtype=np.float64)
    quads = []
    if n >= 4:
        # 가까운 후보끼리만 조합한다
        neigh = []
        for i in range(n):
            reach = cands[i].side * (CARD_H / SMALL_SIZE) * 2.2
            dist = np.linalg.norm(pts - pts[i], axis=1)
            neigh.append(set(np.nonzero(dist < reach)[0].tolist()))
        for i in range(n):
            pool = sorted(j for j in neigh[i] if j > i)
            for combo in itertools.combinations(pool, 3):
                idx = (i, *combo)
                if not all(idx[a] in neigh[idx[b]] for a in range(4) for b in range(4)):
                    continue
                sides = [cands[k].side for k in idx]
                if max(sides) / min(sides) > 2.0:
                    continue
                geo = _quad_geometry(pts[list(idx)])
                if not geo:
                    continue
                score, orients = geo
                w = np.mean([np.linalg.norm(pts[idx[o["tr"]]] - pts[idx[o["tl"]]]) for o in orients[:1]])
                per = w / np.median(sides)  # 기준점 크기에 비한 카드 폭 (양식에서는 ≈ 24.8~19)
                if not 12 < per < 45:
                    continue
                quads.append((score, idx, orients))
    quads.sort(key=lambda q: q[0])
    used, chosen = set(), []
    for score, idx, orients in quads:
        if not used.isdisjoint(idx):
            continue
        best = None
        for o in orients:
            order = {k: idx[v] for k, v in o.items()}
            corners = {k: (cands[i].x, cands[i].y) for k, i in order.items()}
            layout = _layout_score(img_bgr, corners)
            if best is None or layout > best[0]:
                best = (layout, order)
        if best[0] >= LAYOUT_MIN:
            used.update(idx)
            order = best[1]
            small = np.mean([cands[order[k]].area for k in ("tr", "bl", "br")])
            chosen.append((order, cands[order["tl"]].area / small, best[0]))
    leftovers = [cands[i] for i in range(n) if i not in used]
    return chosen, leftovers


def _count_missed(leftovers, cards_side, quads):
    """짝을 못 찾은 기준점으로 '놓친 카드' 수를 어림한다.

    이미 찾은 카드 안쪽의 후보(칠한 칸 등)는 빼고, 잡힌 기준점과 크기가 비슷한 후보 두 개가
    카드의 가로·세로·대각선 거리만큼 떨어져 있으면 기준점 일부만 잡힌 카드로 본다.
    """
    if not leftovers:
        return 0
    polys = [np.float32([q["tl"], q["tr"], q["br"], q["bl"]]) for q in quads]
    left = [m for m in leftovers if all(cv2.pointPolygonTest(p, (m.x, m.y), True) < -m.side for p in polys)]
    if len(left) < 2:
        return 0
    side = np.median(cards_side) if cards_side else np.median([m.side for m in left])
    left = [m for m in left if 0.7 < m.side / side < 1.6]
    spans = [CARD_W / SMALL_SIZE, CARD_H / SMALL_SIZE, math.hypot(CARD_W, CARD_H) / SMALL_SIZE]
    parent = list(range(len(left)))

    def root(i):
        while parent[i] != i:
            i = parent[i]
        return i

    linked = set()
    for i, j in itertools.combinations(range(len(left)), 2):
        a, b = left[i], left[j]
        if max(a.side, b.side) / min(a.side, b.side) > 1.6:
            continue
        rel = math.hypot(a.x - b.x, a.y - b.y) / ((a.side + b.side) / 2)
        if any(0.75 * sp < rel < 1.3 * sp for sp in spans):
            parent[root(i)] = root(j)
            linked.update((i, j))
    return len({root(i) for i in linked})


def warp_card(img_bgr, corners, scale=WARP_SCALE):
    """기준점 네 개를 템플릿 좌표로 옮겨 카드 한 장을 반듯하게 펴낸다."""
    c = TEMPLATE["card"]
    pad = PAD_PT
    ox, oy = -c["x0"] + pad, -c["y0"] + pad
    w = round((c["x1"] - c["x0"] + 2 * pad) * scale)
    h = round((c["y1"] - c["y0"] + 2 * pad) * scale)
    src = np.float32([corners[k] for k in ("tl", "tr", "bl", "br")])
    dst = np.float32([[(_M[k]["x"] + ox) * scale, (_M[k]["y"] + oy) * scale] for k in ("tl", "tr", "bl", "br")])
    H = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img_bgr, H, (w, h), flags=cv2.INTER_CUBIC, borderValue=(255, 255, 255))


def card_to_px(x, y, scale=WARP_SCALE):
    """템플릿 좌표(pt) → 보정된 카드 이미지의 픽셀 좌표."""
    c = TEMPLATE["card"]
    pad = PAD_PT
    return (x - c["x0"] + pad) * scale, (y - c["y0"] + pad) * scale


def detect_cards(img_bgr, max_cards=8):
    cands = find_marker_candidates(img_bgr)
    chosen, leftovers = group_cards(cands, img_bgr)
    cards = []
    for order, big_ratio, layout in chosen:
        corners = {k: (cands[i].x, cands[i].y) for k, i in order.items()}
        warnings = []
        if layout < 0.4:
            warnings.append("카드가 휘었거나 흐려서 칸 위치가 조금 어긋났을 수 있음")
        if big_ratio < 1.0:
            warnings.append("왼쪽 위 기준점이 다른 기준점보다 작게 찍힘 (방향 확인)")
        cards.append(DetectedCard(corners, warp_card(img_bgr, corners), warnings))
    # 사진 속 위치 순서: 위→아래 줄, 줄 안에서는 왼쪽→오른쪽
    if cards:
        heights = [abs(c.corners["bl"][1] - c.corners["tl"][1]) for c in cards]
        row_h = np.median(heights) * 0.5
        cards.sort(key=lambda c: (round(_center(c)[1] / row_h), _center(c)[0]))
    missed = _count_missed(leftovers, [math.sqrt(cands[o["tr"]].area) for o, _, _ in chosen],
                           [c.corners for c in cards])
    return DetectResult(cards[:max_cards], missed + max(0, len(cards) - max_cards))


def _center(card):
    xs = [p[0] for p in card.corners.values()]
    ys = [p[1] for p in card.corners.values()]
    return sum(xs) / 4, sum(ys) / 4
