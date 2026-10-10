"""손글씨 영역을 잘라 Claude API(비전)로 읽는다.

외부로 나가는 것은 여기서 잘라낸 손글씨 영역 이미지뿐이다 (OMR 칸·카드 전체는 보내지 않음).
"""
import base64
import json

import cv2

from .markers import card_to_px
from .template import TEMPLATE

REGION_LABELS = {
    "name": "이름 (카드 오른쪽 위 손글씨)",
    "times": "출결 줄의 등원·하원 시간",
    "goals": "학습 목표 (최대 4줄)",
    "attitude": "학습태도",
    "bonus_range": "추가 포인트 범위",
    "today_hw": "오늘 과제",
}

CONF = {"type": "string", "enum": ["high", "medium", "low"]}
NSTR = {"type": ["string", "null"]}
NINT = {"type": ["integer", "null"]}
TEXT_FIELD = {
    "type": "object",
    "properties": {"text": NSTR, "confidence": CONF},
    "required": ["text", "confidence"],
    "additionalProperties": False,
}
RANGE_ITEM = {
    "type": "object",
    "properties": {
        "line": {"type": "integer"},
        "color": {"type": "string", "enum": ["green", "blue", "red", "black", "unknown"]},
        "book": NSTR,
        "unit": NSTR,
        "page_from": NINT,
        "page_to": NINT,
        "mark": {"type": "string", "enum": ["circle", "triangle", "none"]},
        "raw_text": {"type": "string"},
        "confidence": CONF,
    },
    "required": ["line", "color", "book", "unit", "page_from", "page_to", "mark", "raw_text", "confidence"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {
        "name": TEXT_FIELD,
        "arrive_time": TEXT_FIELD,
        "leave_time": TEXT_FIELD,
        "goal_items": {"type": "array", "items": RANGE_ITEM},
        "attitude": TEXT_FIELD,
        "bonus_range": {
            "type": "object",
            "properties": {
                "text": NSTR,
                "book": NSTR,
                "unit": NSTR,
                "page_from": NINT,
                "page_to": NINT,
                "mark": {"type": "string", "enum": ["circle", "triangle", "none"]},
                "confidence": CONF,
            },
            "required": ["text", "book", "unit", "page_from", "page_to", "mark", "confidence"],
            "additionalProperties": False,
        },
        "today_hw": TEXT_FIELD,
        "notes": NSTR,
    },
    "required": ["name", "arrive_time", "leave_time", "goal_items", "attitude", "bonus_range", "today_hw", "notes"],
    "additionalProperties": False,
}

SYSTEM = """당신은 초등 수학 공부방의 '진도 카드' 손글씨를 읽어 구조화하는 도우미입니다.
카드 한 장에서 잘라낸 손글씨 영역 이미지 여러 개를 받습니다. 각 이미지 앞에 어느 영역인지 적혀 있습니다.

읽는 규칙
- 펜 색이 의미를 가집니다: 초록=지난 과제 범위, 파랑=오늘 진도 범위, 빨강=추가 포인트 범위, 검정=오늘 과제.
- 빨간 채점펜으로 범위를 둘러싼 동그라미(○)는 끝낸 범위, 세모(△)는 시작했지만 다 못 끝낸 범위입니다.
  이 표시는 mark(circle/triangle)로 적고, 표시 자체의 빨간색은 글씨 색(color)으로 보지 마세요.
  color는 글씨(교재 이름·쪽수)를 쓴 펜 색입니다.
- 교재 이름: 디딤돌, 자료집, 문장제, 교재오답, Test, 경시 등. 흘려 쓴 글씨는 이 목록에서 가장 가까운 것으로 읽되,
  확신이 없으면 confidence를 low로 하세요.
- 네모 안 숫자(예: ③)는 단원 번호입니다. unit에 숫자만 적습니다 (예: "3").
- 범위는 쪽수입니다. "95~97" → page_from 95, page_to 97. 한 쪽이면 두 값을 같게. 쪽수가 아니면(예: "~Step3") page는 null로 두고 raw_text에 그대로 적습니다.
- 학습 목표의 한 줄에 범위가 여러 개 있으면 범위마다 goal_items 항목을 따로 만듭니다.
  교재 이름이 앞에만 있고 뒤 범위에는 생략되었으면 같은 교재로 봅니다. line은 1~4번째 줄입니다.
- 등원·하원 시간은 적힌 그대로 "H:MM" 형식으로 적습니다 (예: "4:55"). 오전/오후는 판단하지 마세요.
- 추가 포인트 범위(bonus_range)와 오늘 과제(today_hw)도 같은 규칙으로 읽습니다.
- 학습태도·오늘 과제는 문장을 적힌 그대로 옮깁니다. 알아볼 수 없는 글자는 □로 표시합니다.
- 비어 있는 영역은 text를 null로, confidence는 high로 둡니다.
- confidence: high=확실, medium=대체로 확실, low=다시 확인이 필요함. 추측한 부분이 있으면 low로 하세요.
- 특이사항(가려진 글씨, 지운 흔적 등)은 notes에 짧게 적습니다."""


def crop_regions(card_bgr):
    """손글씨 영역별로 잘라낸 이미지 (BGR)."""
    h, w = card_bgr.shape[:2]
    out = {}
    for key, r in TEMPLATE["handwriting"].items():
        x0, y0 = card_to_px(r["x0"], r["y0"])
        x1, y1 = card_to_px(r["x1"], r["y1"])
        x0, y0 = max(0, int(x0)), max(0, int(y0))
        x1, y1 = min(w, int(x1)), min(h, int(y1))
        out[key] = card_bgr[y0:y1, x0:x1]
    return out


def _jpeg_b64(img):
    ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    return base64.standard_b64encode(buf.tobytes()).decode("ascii")


class HandwritingError(Exception):
    pass


def read_handwriting(crops, api_cfg):
    """잘라낸 영역들을 Claude에 보내 구조화된 판독 결과(dict)를 받는다."""
    import anthropic

    key = api_cfg.get("anthropic_api_key") or None
    if not key:
        raise HandwritingError("config.toml에 Claude API 키(anthropic_api_key)가 없습니다")
    client = anthropic.Anthropic(api_key=key, timeout=120, max_retries=2)

    content = []
    for k, label in REGION_LABELS.items():
        content.append({"type": "text", "text": f"[{k}] {label}"})
        content.append({"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": _jpeg_b64(crops[k])}})
    content.append({"type": "text", "text": "위 영역들을 규칙에 따라 읽어 JSON으로 답하세요."})

    params = dict(
        model=api_cfg.get("model", "claude-opus-5-5"),
        max_tokens=16000,
        system=SYSTEM,
        messages=[{"role": "user", "content": content}],
        output_config={"effort": api_cfg.get("effort", "medium"), "format": {"type": "json_schema", "schema": SCHEMA}},
    )
    try:
        if api_cfg.get("use_fallbacks", True):
            # 안전 분류기가 요청을 거절하면 서버에서 다른 모델로 자동 재시도
            resp = client.beta.messages.create(betas=["server-side-fallback-2026-07-01"], fallbacks="default", **params)
        else:
            resp = client.messages.create(**params)
    except anthropic.AuthenticationError as e:
        raise HandwritingError("API 키가 올바르지 않습니다") from e
    except anthropic.RateLimitError as e:
        raise HandwritingError("API 호출 한도 초과 — 잠시 뒤 다시 판독하세요") from e
    except anthropic.APIStatusError as e:
        raise HandwritingError(f"API 오류 {e.status_code}: {e.message}") from e
    except anthropic.APIConnectionError as e:
        raise HandwritingError("인터넷 연결 문제로 Claude API에 접속하지 못했습니다") from e

    if resp.stop_reason == "refusal":
        raise HandwritingError("Claude가 이 이미지 판독을 거절했습니다 — 직접 입력해 주세요")
    if resp.stop_reason == "max_tokens":
        raise HandwritingError("응답이 너무 길어 잘렸습니다 — 다시 판독해 주세요")
    text = next((b.text for b in resp.content if b.type == "text"), None)
    if not text:
        raise HandwritingError("Claude 응답에 판독 결과가 없습니다")
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        raise HandwritingError("판독 결과 형식이 올바르지 않습니다") from e
