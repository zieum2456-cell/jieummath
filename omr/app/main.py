"""웹 서버. 실행: python run.py"""
import asyncio
import logging
import re
from datetime import date
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles

from .checks import build_reading, check_values
from .config import load_config
from .netguard import allowed, build_networks
from .service import Service
from .vision.handwriting import HandwritingError

STATIC = Path(__file__).parent / "static"
log = logging.getLogger("omr")

STAGES = {"concept", "type", "unit_review", "wrong_note", "test", "contest"}
CAUSES = {"calc", "concept", "condition", "skip_steps"}
TIME_RE = re.compile(r"^\d{2}:\d{2}$")


def create_app(cfg=None):
    cfg = cfg or load_config()
    svc = Service(cfg)
    networks = build_networks(cfg["server"]["allowed_networks"])
    app = FastAPI(title="진도 카드", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.svc = svc
    app.state.networks = networks

    @app.middleware("http")
    async def lan_only(request: Request, call_next):
        host = request.client.host if request.client else None
        if not allowed(host, networks):
            return PlainTextResponse("공부방 와이파이에서만 접속할 수 있습니다.", status_code=403)
        return await call_next(request)

    @app.on_event("startup")
    def _startup():
        svc.start_cleanup_loop()

    # ---------- 화면 ----------
    def page(name):
        return FileResponse(STATIC / name, headers={"Cache-Control": "no-cache"})

    @app.get("/")
    def capture_page():
        return page("capture.html")

    @app.get("/review")
    def review_page():
        return page("review.html")

    @app.get("/students")
    def students_page():
        return page("students.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")

    # ---------- 상태 ----------
    @app.get("/api/status")
    def status():
        return {"ai_enabled": svc.ai_enabled, "pending": len(svc.db.cards("pending")),
                "students": len(svc.db.students())}

    # ---------- 업로드 ----------
    @app.post("/api/upload")
    async def upload(files: list[UploadFile] = File(...)):
        results = []
        for f in files:
            data = await f.read()
            try:
                r = await asyncio.to_thread(svc.process_photo, data, f.filename)
                results.append({"name": f.filename, **r})
            except Exception as e:
                log.exception("사진 처리 실패: %s", f.filename)
                results.append({"name": f.filename, "error": f"사진을 읽지 못했습니다 ({type(e).__name__})"})
        return results

    # ---------- 카드 확인 ----------
    def get_card(card_id):
        card = svc.db.card(card_id)
        if not card:
            raise HTTPException(404, "카드를 찾을 수 없습니다")
        return card

    @app.get("/api/cards")
    def list_cards(status: str = "pending"):
        out = []
        for row in svc.db.cards(status):
            card = svc.db.card(row["id"])
            values, read_flags = build_reading(card)
            checks = check_values(values, svc.db, card["id"])
            student = svc.db.student_by_number(values["student_number"]) if values["student_number"] is not None else None
            out.append({**row, "student_number": values["student_number"], "name": values["name"],
                        "student_name": student["name"] if student else None,
                        "flag_count": len(read_flags) + len(checks)})
        return out

    @app.get("/api/cards/{card_id}")
    def card_detail(card_id: int):
        card = get_card(card_id)
        values, read_flags = build_reading(card)
        if card["status"] == "saved" and card["lesson_id"]:
            values = lesson_values(card["lesson_id"]) or values
        return {
            "id": card["id"], "status": card["status"], "ai_status": card["ai_status"], "ai_error": card["ai_error"],
            "taken_at": card["taken_at"], "uploaded_at": card["uploaded_at"], "card_index": card["card_index"],
            "photo_id": card["photo_id"], "has_image": bool(card["image_path"]),
            "values": values, "read_flags": read_flags, "check_flags": check_values(values, svc.db, card_id),
            "omr_ratios": card["omr"]["ratios"],
        }

    def lesson_values(lesson_id):
        l = svc.db.one("SELECT lessons.*, students.number FROM lessons JOIN students ON students.id = lessons.student_id WHERE lessons.id = ?", (lesson_id,))
        if not l:
            return None
        return {
            "student_number": l["number"], "name": None, "lesson_date": l["lesson_date"], "attendance": l["attendance"],
            "arrive_time": l["arrive_time"], "leave_time": l["leave_time"], "last_hw": l["last_hw"],
            "stages": [r["stage"] for r in svc.db.query("SELECT stage FROM lesson_stages WHERE lesson_id = ?", (lesson_id,))],
            "progress": l["progress"],
            "error_causes": [r["cause"] for r in svc.db.query("SELECT cause FROM lesson_error_causes WHERE lesson_id = ?", (lesson_id,))],
            "goal_items": [{"line": g["line_no"], **{k: g[k] for k in ("color", "book", "unit", "page_from", "page_to", "mark", "raw_text")}}
                           for g in svc.db.query("SELECT * FROM goal_items WHERE lesson_id = ? ORDER BY id", (lesson_id,))],
            "attitude": l["attitude"], "bonus_range": l["bonus_range"], "bonus_points": l["bonus_points"],
            "today_hw": l["today_hw"], "memo": l["memo"],
        }

    @app.get("/api/cards/{card_id}/image")
    def card_image(card_id: int):
        card = get_card(card_id)
        if not card["image_path"]:
            raise HTTPException(404, "보관 기간이 지나 이미지가 삭제되었습니다")
        return FileResponse(svc.data / card["image_path"], media_type="image/jpeg")

    @app.get("/api/cards/{card_id}/crop/{region}")
    def card_crop(card_id: int, region: str):
        data = svc.crop(card_id, region)
        if data is None:
            raise HTTPException(404, "이미지가 없습니다")
        return Response(data, media_type="image/jpeg")

    @app.post("/api/cards/{card_id}/check")
    async def card_check(card_id: int, request: Request):
        values = (await request.json()).get("values", {})
        return {"check_flags": check_values(values, svc.db, card_id)}

    @app.post("/api/cards/{card_id}/save")
    async def card_save(card_id: int, request: Request):
        body = await request.json()
        v = body.get("values", {})
        mode = body.get("mode")  # None / replace / keep_both
        get_card(card_id)

        number = v.get("student_number")
        student = svc.db.student_by_number(int(number)) if str(number).isdigit() else None
        if not student:
            raise HTTPException(400, f"{number}번 학생이 명단에 없습니다. 학생 명단에 먼저 등록해 주세요.")
        try:
            date.fromisoformat(v.get("lesson_date") or "")
        except ValueError:
            raise HTTPException(400, "수업일자를 확인해 주세요")
        for k in ("arrive_time", "leave_time"):
            if v.get(k) and not TIME_RE.match(v[k]):
                raise HTTPException(400, "시간은 16:55처럼 입력해 주세요")

        dups = svc.db.lessons_on(student["id"], v["lesson_date"], exclude_card=card_id)
        if dups and mode not in ("replace", "keep_both"):
            return JSONResponse(status_code=409, content={
                "detail": f"{v['lesson_date']}에 {student['name']} 기록이 이미 있습니다.",
                "existing": [d["id"] for d in dups]})

        # 이미 저장했던 카드를 다시 저장하면 예전 기록을 바꾼다
        replace = [l["id"] for l in svc.db.query("SELECT id FROM lessons WHERE card_id = ?", (card_id,))]
        if mode == "replace":
            replace += [d["id"] for d in dups]

        points = v.get("bonus_points")
        data = {
            "student_id": student["id"], "lesson_date": v["lesson_date"], "card_id": card_id,
            "attendance": v.get("attendance") if v.get("attendance") in ("absent", "makeup") else "regular",
            "arrive_time": v.get("arrive_time") or None, "leave_time": v.get("leave_time") or None,
            "last_hw": v.get("last_hw") or None, "progress": v.get("progress") or None,
            "attitude": v.get("attitude") or None, "bonus_range": v.get("bonus_range") or None,
            "bonus_points": int(points) if points not in (None, "") else None,
            "today_hw": v.get("today_hw") or None, "memo": v.get("memo") or None,
            "stages": [s for s in v.get("stages") or [] if s in STAGES],
            "error_causes": [c for c in v.get("error_causes") or [] if c in CAUSES],
            "goal_items": v.get("goal_items") or [],
        }
        lesson_id = svc.db.save_lesson(data, replace_ids=replace)
        return {"lesson_id": lesson_id}

    @app.post("/api/cards/{card_id}/discard")
    def card_discard(card_id: int):
        get_card(card_id)
        svc.db.set_card_status(card_id, "discarded")
        return {"ok": True}

    @app.post("/api/cards/{card_id}/restore")
    def card_restore(card_id: int):
        get_card(card_id)
        svc.db.set_card_status(card_id, "pending")
        return {"ok": True}

    @app.post("/api/cards/{card_id}/reread")
    def card_reread(card_id: int):
        get_card(card_id)
        try:
            svc.reread(card_id)
        except HandwritingError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    # ---------- 학생 명단 ----------
    @app.get("/api/students")
    def students():
        return svc.db.students()

    def clean_student(body):
        try:
            number = int(body.get("number"))
        except (TypeError, ValueError):
            raise HTTPException(400, "학생 번호는 0~99 숫자로 입력해 주세요")
        if not 0 <= number <= 99:
            raise HTTPException(400, "학생 번호는 0~99 숫자로 입력해 주세요")
        name = (body.get("name") or "").strip()
        if not name:
            raise HTTPException(400, "이름을 입력해 주세요")
        return {"number": number, "name": name, "grade": body.get("grade") or None,
                "didimdol_level": body.get("didimdol_level") or None, "send_group": body.get("send_group") or None,
                "active": 1 if body.get("active", True) else 0, "memo": body.get("memo") or None}

    @app.post("/api/students")
    async def add_student(request: Request):
        data = clean_student(await request.json())
        if svc.db.student_by_number(data["number"]):
            raise HTTPException(400, f"{data['number']}번은 이미 있습니다")
        return {"id": svc.db.save_student(data)}

    @app.put("/api/students/{student_id}")
    async def edit_student(student_id: int, request: Request):
        data = clean_student(await request.json())
        other = svc.db.student_by_number(data["number"])
        if other and other["id"] != student_id:
            raise HTTPException(400, f"{data['number']}번은 이미 {other['name']} 학생 번호입니다")
        svc.db.save_student(data, student_id)
        return {"id": student_id}

    @app.delete("/api/students/{student_id}")
    def remove_student(student_id: int):
        try:
            svc.db.delete_student(student_id)
        except ValueError as e:
            raise HTTPException(400, str(e))
        return {"ok": True}

    return app
