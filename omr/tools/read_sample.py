"""사진 한 장을 판독해 결과를 표로 출력한다 (저장하지 않음).

사용법:  python tools/read_sample.py ../IMG_6549.pdf --expect 56,43,73
config.toml에 API 키가 있으면 손글씨도 읽는다.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.checks import LAST_HW_LABEL, to_24h  # noqa: E402
from app.config import load_config  # noqa: E402
from app.vision.handwriting import HandwritingError, crop_regions, read_handwriting  # noqa: E402
from app.vision.imageio import load_image  # noqa: E402
from app.vision.markers import detect_cards  # noqa: E402
from app.vision.omr import read_bubbles  # noqa: E402

ATT = {None: "정규", "absent": "결강", "makeup": "보강"}
STAGE = {"concept": "개념", "type": "유형", "unit_review": "단원마무리", "wrong_note": "교재오답", "test": "Test", "contest": "경시"}
PROG = {"lt50": "50% 미만", "50_75": "50~75%", "75_100": "75~100%"}
CAUSE = {"calc": "계산 실수", "concept": "개념 이해 부족", "condition": "조건 놓침", "skip_steps": "풀이 과정 생략"}
COLOR = {"green": "초록", "blue": "파랑", "red": "빨강", "black": "검정", "unknown": "?"}
MARK = {"circle": "○", "triangle": "△", "none": ""}


def fmt(field, table):
    v = field["value"]
    text = ", ".join(table[x] for x in v) if isinstance(v, list) else table.get(v, str(v))
    return text + (" ⚠" if field["flags"] else "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("photo")
    ap.add_argument("--expect", help="정답 학생 번호 (쉼표로 구분, 사진 왼쪽부터)")
    args = ap.parse_args()
    cfg = load_config()
    img, taken = load_image(Path(args.photo).read_bytes())
    res = detect_cards(img)
    print(f"\n카드 {res.total}장 중 {len(res.cards)}장 인식  (촬영 시각: {taken or '정보 없음'})\n")

    expect = [int(x) for x in args.expect.split(",")] if args.expect else []
    rows = []
    for i, card in enumerate(res.cards):
        o = read_bubbles(card.image, {"filled": cfg["omr"]["filled"], "empty": cfg["omr"]["empty"]})["fields"]
        num = (o["tens"]["value"] or "?") + (o["ones"]["value"] or "?")
        ok = ""
        if i < len(expect):
            ok = "✅" if num == f"{expect[i]:02d}" else f"❌ (정답 {expect[i]})"
        hw = None
        if cfg["api"].get("anthropic_api_key"):
            try:
                hw = read_handwriting(crop_regions(card.image), cfg["api"])
            except HandwritingError as e:
                hw = {"error": str(e)}
        rows.append((i, num, ok, o, hw, card.warnings))

    print("| 항목 | " + " | ".join(f"카드 {i + 1}" for i, *_ in rows) + " |")
    print("|---|" + "---|" * len(rows))

    def line(label, fn):
        print(f"| {label} | " + " | ".join(fn(r) for r in rows) + " |")

    line("학생 번호", lambda r: f"{r[1]} {r[2]}")
    line("출결", lambda r: fmt(r[3]["attendance"], ATT))
    line("지난 과제", lambda r: fmt(r[3]["last_hw"], LAST_HW_LABEL))
    line("단계", lambda r: fmt(r[3]["stage"], STAGE))
    line("진행률", lambda r: fmt(r[3]["progress"], PROG))
    line("오답 원인", lambda r: fmt(r[3]["error_cause"], CAUSE))
    line("추가 포인트", lambda r: fmt(r[3]["points"], {k: k for k in "0369"}))
    line("카드 경고", lambda r: "; ".join(r[5]) or "-")

    if any(r[4] for r in rows):
        def t(r, k):
            hw = r[4] or {}
            if "error" in hw:
                return "판독 실패: " + hw["error"]
            f = hw.get(k) or {}
            return (f.get("text") or "-") + (" ⚠" if f.get("confidence") == "low" else "")

        def goals(r):
            hw = r[4] or {}
            items = hw.get("goal_items") or []
            return "<br>".join(f"{g['line']}줄 {COLOR[g['color']]} {g.get('book') or ''} {('[' + g['unit'] + ']') if g.get('unit') else ''} "
                               f"{g.get('page_from') or ''}{('~' + str(g['page_to'])) if g.get('page_to') not in (None, g.get('page_from')) else ''} "
                               f"{MARK[g['mark']]}{' ⚠' if g['confidence'] == 'low' else ''}".replace("  ", " ")
                               for g in items) or "-"

        line("이름", lambda r: t(r, "name"))
        line("등원", lambda r: f"{t(r, 'arrive_time')} → {to_24h((r[4] or {}).get('arrive_time', {}).get('text')) or '?'}")
        line("하원", lambda r: f"{t(r, 'leave_time')} → {to_24h((r[4] or {}).get('leave_time', {}).get('text')) or '?'}")
        line("학습 목표", goals)
        line("학습태도", lambda r: t(r, "attitude"))
        line("추가 포인트 범위", lambda r: ((r[4] or {}).get("bonus_range") or {}).get("text") or "-")
        line("오늘 과제", lambda r: t(r, "today_hw"))
    else:
        print("\n(API 키가 없어 손글씨는 읽지 않았습니다. config.toml에 키를 넣고 다시 실행하세요.)")
    print("\n⚠ = 확인 필요")


if __name__ == "__main__":
    main()
