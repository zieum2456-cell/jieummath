"""판독 결과를 화면용 값으로 정리하고, '확인 필요' 사유를 만든다."""
import re
from datetime import datetime

LAST_HW_LABEL = {"done": "완료", "partial": "미완", "none": "안 함", "forgot": "두고 옴", "no_hw": "과제 없음"}


def to_24h(text):
    """'4:55' → '16:55'. 수업은 오후이므로 1~9시는 오후로 본다. 읽을 수 없으면 None."""
    if not text:
        return None
    m = re.search(r"(\d{1,2})\s*[:;.\s]\s*(\d{2})", text) or re.fullmatch(r"\s*(\d{1,2})(\d{2})\s*", text)
    if not m:
        return None
    h, mi = int(m.group(1)), int(m.group(2))
    if mi > 59 or h > 23:
        return None
    if 1 <= h <= 9:
        h += 12
    return f"{h:02d}:{mi:02d}"


def _low(field):
    return isinstance(field, dict) and field.get("confidence") == "low"


def build_reading(card):
    """카드 한 장의 OMR·손글씨 판독을 합쳐 (값, 판독 단계 확인 필요 사유)를 만든다."""
    omr = card["omr"]["fields"]
    ai = card.get("ai") or {}
    flags = {}

    def flag(key, msg):
        flags.setdefault(key, []).append(msg)

    for w in card.get("warnings") or []:
        flag("card", w)

    tens, ones = omr["tens"], omr["ones"]
    number = None
    if tens["value"] is not None and ones["value"] is not None:
        number = int(tens["value"]) * 10 + int(ones["value"])
    for msg in tens["flags"]:
        flag("student_number", f"십의 자리: {msg}")
    for msg in ones["flags"]:
        flag("student_number", f"일의 자리: {msg}")

    for key, src in (("attendance", "attendance"), ("last_hw", "last_hw"), ("stages", "stage"),
                     ("progress", "progress"), ("error_causes", "error_cause"), ("bonus_points", "points")):
        for msg in omr[src]["flags"]:
            flag(key, msg)

    status = card.get("ai_status")
    if status == "error":
        flag("handwriting", f"손글씨 판독 실패: {card.get('ai_error')}")
    elif status in ("waiting", "reading"):
        flag("handwriting", "손글씨 판독 중")
    elif status == "off":
        flag("handwriting", "손글씨 판독 꺼짐 (API 키 없음) — 직접 입력")

    def text_of(key):
        f = ai.get(key) or {}
        if _low(f):
            flag(key, "손글씨 확신 낮음")
        return f.get("text")

    name = text_of("name")
    arrive_raw, leave_raw = text_of("arrive_time"), text_of("leave_time")
    arrive, leave = to_24h(arrive_raw), to_24h(leave_raw)
    if arrive_raw and not arrive:
        flag("arrive_time", f"시간 형식을 읽지 못함: {arrive_raw}")
    if leave_raw and not leave:
        flag("leave_time", f"시간 형식을 읽지 못함: {leave_raw}")

    goal_items = []
    for g in ai.get("goal_items") or []:
        if _low(g):
            flag("goal_items", f"{g.get('line')}번째 줄 '{g.get('raw_text')}' 확신 낮음")
        if g.get("color") == "unknown":
            flag("goal_items", f"{g.get('line')}번째 줄 '{g.get('raw_text')}' 펜 색 불분명")
        goal_items.append({k: g.get(k) for k in ("line", "color", "book", "unit", "page_from", "page_to", "mark", "raw_text")})

    bonus = ai.get("bonus_range") or {}
    if _low(bonus):
        flag("bonus_range", "손글씨 확신 낮음")

    taken = card.get("taken_at") or card.get("uploaded_at") or datetime.now().isoformat()
    points = omr["points"]["value"]
    values = {
        "student_number": number,
        "name": name,
        "lesson_date": str(taken)[:10],
        "attendance": omr["attendance"]["value"] or "regular",
        "arrive_time": arrive,
        "leave_time": leave,
        "last_hw": omr["last_hw"]["value"],
        "stages": omr["stage"]["value"],
        "progress": omr["progress"]["value"],
        "error_causes": omr["error_cause"]["value"],
        "goal_items": goal_items,
        "attitude": text_of("attitude"),
        "bonus_range": bonus.get("text"),
        "bonus_points": int(points) if points is not None else None,
        "today_hw": text_of("today_hw"),
        "memo": ai.get("notes"),
    }
    if not card.get("taken_at"):
        flag("lesson_date", "사진에 촬영일 정보가 없어 업로드한 날짜를 넣었음")
    return values, flags


def _same_name(card_name, roster_name):
    a = re.sub(r"\s", "", card_name or "")
    b = re.sub(r"\s", "", roster_name or "")
    return bool(a) and bool(b) and (a == b or b.endswith(a) or a in b)


def check_values(values, db, card_id=None):
    """값끼리의 모순, 명단과 다른 점, 중복 기록을 찾는다."""
    flags = {}

    def flag(key, msg):
        flags.setdefault(key, []).append(msg)

    # 1) 과제 없음인데 초록 펜(지난 과제) 범위가 있음
    greens = [g for g in values.get("goal_items") or [] if g.get("color") == "green"]
    if values.get("last_hw") == "no_hw" and greens:
        ranges = ", ".join(g.get("raw_text") or "" for g in greens)
        flag("last_hw", f"'과제 없음'인데 초록 펜 범위가 있음 ({ranges})")

    # 2) 명단 확인
    number = values.get("student_number")
    student = db.student_by_number(number) if number is not None else None
    if number is None:
        flag("student_number", "학생 번호를 읽지 못함")
    elif not student:
        flag("student_number", f"{number}번 학생이 명단에 없음")
    elif not student["active"]:
        flag("student_number", f"{number}번 {student['name']}은(는) '재원 아님'으로 되어 있음")
    name = values.get("name")
    if student and name and not _same_name(name, student["name"]):
        others = [s for s in db.students() if _same_name(name, s["name"])]
        hint = f" — 이름은 {others[0]['number']}번 {others[0]['name']}과 같음" if others else ""
        flag("name", f"손글씨 이름 '{name}'이 {number}번 {student['name']}과 다름{hint}")

    # 3) 같은 학생·같은 날짜 기록
    if student and values.get("lesson_date"):
        dups = db.lessons_on(student["id"], values["lesson_date"], exclude_card=card_id)
        if dups:
            flag("lesson_date", f"{values['lesson_date']}에 {student['name']} 기록이 이미 {len(dups)}건 있음")

    # 4) 시간 순서
    a, l = values.get("arrive_time"), values.get("leave_time")
    if a and l and l <= a:
        flag("leave_time", "하원 시간이 등원 시간보다 빠름")
    return flags
