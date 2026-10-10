"""SQLite 저장소. 파일 하나(data/jieum.db)에 모든 기록이 들어간다."""
import json
import sqlite3
import threading
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY,
    number INTEGER NOT NULL UNIQUE,          -- 카드의 학생 번호 (0~99)
    name TEXT NOT NULL,
    grade TEXT,                               -- 예: 초3
    didimdol_level TEXT,                      -- 기본 / 기본+유형 / 기본+응용
    send_group TEXT,                          -- 리포트 발송 조 A / B
    active INTEGER NOT NULL DEFAULT 1,
    memo TEXT
);

CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    file_path TEXT,                           -- 보관 기간이 지나면 파일 삭제 후 NULL
    original_name TEXT,
    taken_at TEXT,                            -- 사진 정보의 촬영 시각 (없으면 NULL)
    uploaded_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    cards_found INTEGER NOT NULL DEFAULT 0,
    cards_missed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    card_index INTEGER NOT NULL,              -- 사진 안 순서 (위→아래, 왼쪽→오른쪽)
    image_path TEXT,                          -- 보정된 카드 이미지
    omr_json TEXT NOT NULL,                   -- 칸별 채움 비율과 판정
    ai_json TEXT,                             -- Claude 손글씨 판독 결과
    ai_status TEXT NOT NULL DEFAULT 'waiting',-- waiting / reading / done / error / off
    ai_error TEXT,
    warnings TEXT,                            -- 카드 분리 단계 경고 (JSON 목록)
    status TEXT NOT NULL DEFAULT 'pending',   -- pending(확인 대기) / saved / discarded
    lesson_id INTEGER REFERENCES lessons(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS lessons (
    id INTEGER PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id),
    lesson_date TEXT NOT NULL,                -- YYYY-MM-DD
    card_id INTEGER REFERENCES cards(id),
    attendance TEXT NOT NULL DEFAULT 'regular', -- regular / absent / makeup
    arrive_time TEXT,                         -- HH:MM (24시간)
    leave_time TEXT,
    last_hw TEXT,                             -- done / partial / none / forgot / no_hw
    progress TEXT,                            -- lt50 / 50_75 / 75_100
    attitude TEXT,
    bonus_range TEXT,
    bonus_points INTEGER,
    today_hw TEXT,
    memo TEXT,
    saved_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS lessons_student_date ON lessons(student_id, lesson_date);
CREATE INDEX IF NOT EXISTS lessons_date ON lessons(lesson_date);

CREATE TABLE IF NOT EXISTS lesson_stages (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    stage TEXT NOT NULL,                      -- concept / type / unit_review / wrong_note / test / contest
    PRIMARY KEY (lesson_id, stage)
);

CREATE TABLE IF NOT EXISTS lesson_error_causes (
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    cause TEXT NOT NULL,                      -- calc / concept / condition / skip_steps
    PRIMARY KEY (lesson_id, cause)
);

CREATE TABLE IF NOT EXISTS goal_items (
    id INTEGER PRIMARY KEY,
    lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
    line_no INTEGER,
    color TEXT,                               -- green / blue / red / black / unknown
    purpose TEXT,                             -- last_hw / today / bonus / today_hw
    book TEXT,
    unit TEXT,
    page_from INTEGER,
    page_to INTEGER,
    mark TEXT,                                -- circle(끝냄) / triangle(덜 끝냄) / none
    raw_text TEXT
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""

COLOR_PURPOSE = {"green": "last_hw", "blue": "today", "red": "bonus", "black": "today_hw"}


class DB:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self.conn.execute("PRAGMA journal_mode = WAL")
        self.conn.executescript(SCHEMA)

    @contextmanager
    def tx(self):
        with self._lock:
            try:
                yield self.conn
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise

    def query(self, sql, args=()):
        with self._lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql, args=()):
        rows = self.query(sql, args)
        return rows[0] if rows else None

    # ---------- 학생 ----------
    def students(self, active_only=False):
        sql = "SELECT * FROM students" + (" WHERE active = 1" if active_only else "") + " ORDER BY number"
        return self.query(sql)

    def student_by_number(self, number):
        return self.one("SELECT * FROM students WHERE number = ?", (number,))

    def save_student(self, data, student_id=None):
        cols = ["number", "name", "grade", "didimdol_level", "send_group", "active", "memo"]
        vals = [data.get(c) for c in cols]
        with self.tx() as c:
            if student_id:
                c.execute(f"UPDATE students SET {', '.join(f'{k} = ?' for k in cols)} WHERE id = ?", (*vals, student_id))
                return student_id
            return c.execute(f"INSERT INTO students ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})", vals).lastrowid

    def delete_student(self, student_id):
        with self.tx() as c:
            used = c.execute("SELECT COUNT(*) FROM lessons WHERE student_id = ?", (student_id,)).fetchone()[0]
            if used:
                raise ValueError(f"수업 기록 {used}건이 있어 삭제할 수 없습니다. '재원 아님'으로 바꿔 주세요.")
            c.execute("DELETE FROM students WHERE id = ?", (student_id,))

    # ---------- 사진·카드 ----------
    def add_photo(self, file_path, original_name, taken_at, found, missed):
        with self.tx() as c:
            return c.execute(
                "INSERT INTO photos (file_path, original_name, taken_at, cards_found, cards_missed) VALUES (?, ?, ?, ?, ?)",
                (file_path, original_name, taken_at, found, missed),
            ).lastrowid

    def add_card(self, photo_id, index, image_path, omr, warnings, ai_status):
        with self.tx() as c:
            return c.execute(
                "INSERT INTO cards (photo_id, card_index, image_path, omr_json, warnings, ai_status) VALUES (?, ?, ?, ?, ?, ?)",
                (photo_id, index, image_path, json.dumps(omr, ensure_ascii=False), json.dumps(warnings, ensure_ascii=False), ai_status),
            ).lastrowid

    def set_card_ai(self, card_id, status, result=None, error=None):
        with self.tx() as c:
            c.execute(
                "UPDATE cards SET ai_status = ?, ai_json = COALESCE(?, ai_json), ai_error = ? WHERE id = ?",
                (status, json.dumps(result, ensure_ascii=False) if result is not None else None, error, card_id),
            )

    def card(self, card_id):
        row = self.one(
            """SELECT cards.*, photos.taken_at, photos.uploaded_at, photos.original_name
               FROM cards JOIN photos ON photos.id = cards.photo_id WHERE cards.id = ?""",
            (card_id,),
        )
        if row:
            row["omr"] = json.loads(row.pop("omr_json"))
            row["ai"] = json.loads(row.pop("ai_json")) if row.get("ai_json") else None
            row["warnings"] = json.loads(row["warnings"] or "[]")
        return row

    def cards(self, status="pending"):
        return self.query(
            """SELECT cards.id, cards.photo_id, cards.card_index, cards.ai_status, cards.status, cards.created_at,
                      photos.taken_at, photos.uploaded_at
               FROM cards JOIN photos ON photos.id = cards.photo_id
               WHERE cards.status = ? ORDER BY cards.id""",
            (status,),
        )

    def set_card_status(self, card_id, status, lesson_id=None):
        with self.tx() as c:
            c.execute("UPDATE cards SET status = ?, lesson_id = ? WHERE id = ?", (status, lesson_id, card_id))

    # ---------- 수업 기록 ----------
    def lessons_on(self, student_id, lesson_date, exclude_card=None):
        return self.query(
            "SELECT * FROM lessons WHERE student_id = ? AND lesson_date = ? AND (card_id IS NULL OR card_id != ?)",
            (student_id, lesson_date, exclude_card or -1),
        )

    def save_lesson(self, data, replace_ids=()):
        """수업 기록 저장. replace_ids에 있는 기존 기록은 지운다(덮어쓰기)."""
        cols = ["student_id", "lesson_date", "card_id", "attendance", "arrive_time", "leave_time", "last_hw",
                "progress", "attitude", "bonus_range", "bonus_points", "today_hw", "memo"]
        with self.tx() as c:
            for lid in replace_ids:
                c.execute("UPDATE cards SET status = 'pending', lesson_id = NULL WHERE lesson_id = ?", (lid,))
                c.execute("DELETE FROM lessons WHERE id = ?", (lid,))
            lesson_id = c.execute(
                f"INSERT INTO lessons ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                [data.get(k) for k in cols],
            ).lastrowid
            for s in data.get("stages") or []:
                c.execute("INSERT OR IGNORE INTO lesson_stages VALUES (?, ?)", (lesson_id, s))
            for e in data.get("error_causes") or []:
                c.execute("INSERT OR IGNORE INTO lesson_error_causes VALUES (?, ?)", (lesson_id, e))
            for g in data.get("goal_items") or []:
                c.execute(
                    """INSERT INTO goal_items (lesson_id, line_no, color, purpose, book, unit, page_from, page_to, mark, raw_text)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (lesson_id, g.get("line"), g.get("color"), COLOR_PURPOSE.get(g.get("color")), g.get("book"),
                     g.get("unit"), g.get("page_from"), g.get("page_to"), g.get("mark"), g.get("raw_text")),
                )
            if data.get("card_id"):
                c.execute("UPDATE cards SET status = 'saved', lesson_id = ? WHERE id = ?", (lesson_id, data["card_id"]))
            return lesson_id

    # ---------- 오래된 사진 정리 ----------
    def old_files(self, days):
        photos = self.query(
            "SELECT id, file_path FROM photos WHERE file_path IS NOT NULL AND uploaded_at < datetime('now', 'localtime', ?)",
            (f"-{int(days)} days",),
        )
        cards = self.query(
            "SELECT id, image_path FROM cards WHERE image_path IS NOT NULL AND created_at < datetime('now', 'localtime', ?)",
            (f"-{int(days)} days",),
        )
        return photos, cards

    def clear_paths(self, photo_ids, card_ids):
        with self.tx() as c:
            c.executemany("UPDATE photos SET file_path = NULL WHERE id = ?", [(i,) for i in photo_ids])
            c.executemany("UPDATE cards SET image_path = NULL WHERE id = ?", [(i,) for i in card_ids])
