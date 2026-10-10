"""카드 양식 PDF에서 OMR 칸·기준점·손글씨 영역 좌표를 뽑아 template.json으로 저장한다.

사용법:  python tools/build_template.py ../진도_OMR_카드_A4_4장.pdf

A4 한 장에 카드 4장이 있으므로 왼쪽 위 카드 한 장만 사용한다.
좌표 단위는 PDF 포인트(pt)이고, 원점은 왼쪽 위 기준점의 중심이다.
"""
import json
import sys
import unicodedata
from pathlib import Path

import pymupdf

OUT = Path(__file__).resolve().parent.parent / "app" / "vision" / "template.json"

# 칸 오른쪽 글자 → (항목, 값)
LABELS = {
    "결강": ("attendance", "absent"),
    "보강": ("attendance", "makeup"),
    "완료": ("last_hw", "done"),
    "미완": ("last_hw", "partial"),
    "안함": ("last_hw", "none"),
    "두고옴": ("last_hw", "forgot"),
    "과제없음": ("last_hw", "no_hw"),
    "개념": ("stage", "concept"),
    "유형": ("stage", "type"),
    "단원마무리": ("stage", "unit_review"),
    "교재오답": ("stage", "wrong_note"),
    "Test": ("stage", "test"),
    "경시": ("stage", "contest"),
    "50%미만": ("progress", "lt50"),
    "50~75%": ("progress", "50_75"),
    "75~100%": ("progress", "75_100"),
    "계산실수": ("error_cause", "calc"),
    "개념이해부족": ("error_cause", "concept"),
    "조건놓침(문제읽기)": ("error_cause", "condition"),
    "풀이과정생략": ("error_cause", "skip_steps"),
    "0": ("points", "0"),
    "3": ("points", "3"),
    "6": ("points", "6"),
    "9": ("points", "9"),
}

# 항목별 선택 규칙: single = 하나만, multi = 여러 개 가능, optional = 비어 있어도 됨
FIELDS = {
    "tens": {"mode": "single"},
    "ones": {"mode": "single"},
    "attendance": {"mode": "single", "optional": True},
    "last_hw": {"mode": "single"},
    "stage": {"mode": "multi", "optional": True},
    "progress": {"mode": "single"},
    "error_cause": {"mode": "multi", "optional": True},
    "points": {"mode": "single"},
}


def first_card(page):
    """왼쪽 위 카드 영역(페이지의 1/4)에 있는 도형과 글자."""
    w, h = page.rect.width / 2, page.rect.height / 2
    drawings = [d for d in page.get_drawings() if d["rect"].x1 < w and d["rect"].y1 < h]
    words = [wd for wd in page.get_text("words") if wd[2] < w and wd[3] < h]
    return drawings, words


def main(pdf_path):
    page = pymupdf.open(pdf_path)[0]
    drawings, words = first_card(page)

    # 기준점: 검은색으로 채운 정사각형 (8~16pt)
    markers = []
    for d in drawings:
        r = d["rect"]
        if d["type"] == "f" and d.get("fill") == (0.0, 0.0, 0.0) and 8 < r.width < 16 and abs(r.width - r.height) < 0.5:
            markers.append(r)
    assert len(markers) == 4, f"기준점 {len(markers)}개 (4개여야 함)"
    big = max(markers, key=lambda r: r.width)
    ox, oy = (big.x0 + big.x1) / 2, (big.y0 + big.y1) / 2

    def rel(x, y):
        return round(x - ox, 2), round(y - oy, 2)

    centers = {}
    for r in markers:
        cx, cy = rel((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2)
        key = ("t" if cy < 1 else "b") + ("l" if cx < 1 else "r")
        centers[key] = {"x": cx, "y": cy, "size": round(r.width, 2)}

    card_bg = max((d["rect"] for d in drawings if d["type"] == "f" and d.get("fill") == (1.0, 1.0, 1.0)),
                  key=lambda r: r.width * r.height)

    # OMR 칸: 테두리만 있는 세로로 긴 둥근 사각형
    bubbles = sorted((d["rect"] for d in drawings if d["type"] == "s" and d["rect"].height > d["rect"].width * 1.4),
                     key=lambda r: (round(r.y0), r.x0))

    digit_cols = sorted((wd for wd in words if wd[4].isdigit() and len(wd[4]) == 1 and wd[1] < 70), key=lambda wd: wd[0])
    row_labels = {unicodedata.normalize("NFC", wd[4]): wd for wd in words if wd[4] in ("십", "일")}

    out_bubbles = []
    for r in bubbles:
        cy = (r.y0 + r.y1) / 2
        field = value = None
        for name, key in (("십", "tens"), ("일", "ones")):
            lab = row_labels.get(name)
            if lab and lab[1] - 2 < cy < lab[3] + 2:
                col = min(digit_cols, key=lambda wd: abs((wd[0] + wd[2]) / 2 - (r.x0 + r.x1) / 2))
                field, value = key, col[4]
        if field is None:
            # 같은 줄에서 칸 바로 오른쪽부터 다음 칸 전까지의 글자를 이어 붙인다
            same_row = [b for b in bubbles if abs(b.y0 - r.y0) < 1 and b.x0 > r.x1]
            limit = min((b.x0 for b in same_row), default=1e9)
            parts, last_x = [], r.x1
            for wd in sorted(words, key=lambda wd: wd[0]):
                if r.x1 < wd[0] < limit and wd[1] < cy < wd[3] + 1:
                    if wd[0] - last_x > 8:  # 글자 사이가 벌어지면 라벨 끝 (예: '보강' 뒤의 '등원')
                        break
                    parts.append(wd[4])
                    last_x = wd[2]
            text = unicodedata.normalize("NFC", "".join(parts))
            if text not in LABELS:
                raise SystemExit(f"알 수 없는 칸 라벨: {text!r} at {r}")
            field, value = LABELS[text]
        x0, y0 = rel(r.x0, r.y0)
        x1, y1 = rel(r.x1, r.y1)
        out_bubbles.append({"field": field, "value": value, "x0": x0, "y0": y0, "x1": x1, "y1": y1})

    counts = {}
    for b in out_bubbles:
        counts[b["field"]] = counts.get(b["field"], 0) + 1
    expected = {"tens": 10, "ones": 10, "attendance": 2, "last_hw": 5, "stage": 6, "progress": 3, "error_cause": 4, "points": 4}
    assert counts == expected, counts

    # 손글씨 영역: 양식의 줄·라벨 위치를 기준으로 넉넉하게 잡는다 (pt, 기준점 원점)
    def box(x0, y0, x1, y1):
        a, b = rel(x0, y0)
        c, d = rel(x1, y1)
        return {"x0": a, "y0": b, "x1": c, "y1": d}

    right = card_bg.x1 + 8  # 줄 끝·카드 끝을 넘겨 쓰는 글씨까지 포함
    handwriting = {
        "name": box(100, 24, 264, 56),
        "times": box(128, 105, right, 130),
        "goals": box(58, 180, right, 248),
        "attitude": box(58, 302, right, 324),
        "bonus_range": box(58, 325, 192, 350),
        "today_hw": box(58, 350, right, 373),
    }

    template = {
        "source": Path(pdf_path).name,
        "unit": "pt",
        "markers": centers,
        "card": {k: v for k, v in zip(("x0", "y0", "x1", "y1"),
                                      (*rel(card_bg.x0, card_bg.y0), *rel(card_bg.x1, card_bg.y1)))},
        "fields": FIELDS,
        "bubbles": out_bubbles,
        "handwriting": handwriting,
    }
    OUT.write_text(json.dumps(template, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"저장: {OUT}  (칸 {len(out_bubbles)}개)")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    main(sys.argv[1])
