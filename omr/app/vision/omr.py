"""보정된 카드 이미지에서 OMR 칸의 채움 비율을 재고 항목별 값을 정한다."""
import cv2
import numpy as np

from .markers import WARP_SCALE, card_to_px
from .template import TEMPLATE

# 기본 판정 기준 (설정 파일에서 바꿀 수 있음)
DEFAULT_THRESHOLDS = {
    "filled": 0.38,  # 이 비율 이상이면 칠한 칸
    "empty": 0.18,  # 이 비율 이하이면 빈 칸, 그 사이는 '애매함'
}
SEARCH_PT = 1.6  # 칸 위치를 이 범위(pt) 안에서 미세 조정해 테두리에 맞춘다


def _dark_map(card_bgr):
    """검정 잉크만 '어두움'으로 본다 (빨강·파랑·초록 펜은 밝은 채널이 남아 제외됨)."""
    v = card_bgr.max(axis=2).astype(np.float32)  # HSV의 V
    paper = float(np.percentile(v, 90))
    return (v < paper * 0.55).astype(np.uint8)


def _align_row(dark, boxes):
    """같은 줄의 칸들을 한꺼번에 조금씩 옮겨 보며 칸 테두리가 가장 잘 겹치는 위치를 찾는다."""
    s = WARP_SCALE
    best, best_off = -1.0, (0, 0)
    rng = int(SEARCH_PT * s)
    for dy in range(-rng, rng + 1, 2):
        for dx in range(-rng, rng + 1, 2):
            score = 0.0
            for x0, y0, x1, y1 in boxes:
                a, b, c, d = int(x0 + dx), int(y0 + dy), int(x1 + dx), int(y1 + dy)
                ring = dark[b:d, a:c].sum() - dark[b + 4:d - 4, a + 4:c - 4].sum()
                score += ring
            if score > best:
                best, best_off = score, (dx, dy)
    return best_off


def read_bubbles(card_bgr, thresholds=None):
    """칸별 채움 비율과 항목별 판독 결과."""
    th = {**DEFAULT_THRESHOLDS, **(thresholds or {})}
    dark = _dark_map(card_bgr)
    s = WARP_SCALE

    rows = {}
    for b in TEMPLATE["bubbles"]:
        x0, y0 = card_to_px(b["x0"], b["y0"])
        x1, y1 = card_to_px(b["x1"], b["y1"])
        rows.setdefault(round(b["y0"]), []).append((b, (x0, y0, x1, y1)))

    ratios = {}
    for items in rows.values():
        dx, dy = _align_row(dark, [box for _, box in items])
        for b, (x0, y0, x1, y1) in items:
            # 테두리를 빼고 안쪽만 잰다 (가로 25%, 세로 18%씩 안으로)
            ix, iy = (x1 - x0) * 0.25, (y1 - y0) * 0.18
            a, c = int(x0 + dx + ix), int(x1 + dx - ix)
            t, u = int(y0 + dy + iy), int(y1 + dy - iy)
            inner = dark[t:u, a:c]
            ratios.setdefault(b["field"], {})[b["value"]] = round(float(inner.mean()) if inner.size else 0.0, 3)

    results = {}
    for name, spec in TEMPLATE["fields"].items():
        results[name] = decide(ratios[name], spec, th)
    return {"ratios": ratios, "fields": results}


def decide(ratios, spec, th):
    """채움 비율 → 값 + 확인 필요 사유."""
    filled = [k for k, r in ratios.items() if r >= th["filled"]]
    unsure = [k for k, r in ratios.items() if th["empty"] < r < th["filled"]]
    flags = []
    if spec["mode"] == "single":
        filled.sort(key=lambda k: -ratios[k])
        value = filled[0] if filled else None
        if len(filled) > 1:
            flags.append(f"두 칸 이상 칠해짐 ({', '.join(filled)})")
        if unsure:
            flags.append(f"애매한 칸 ({', '.join(unsure)})")
            if value is None and len(unsure) == 1:
                value = unsure[0]  # 후보로 제시만 하고 확인 필요로 둔다
        if value is None and not spec.get("optional"):
            flags.append("칠한 칸 없음")
    else:
        value = filled
        if unsure:
            flags.append(f"애매한 칸 ({', '.join(unsure)})")
    return {"value": value, "flags": flags}
