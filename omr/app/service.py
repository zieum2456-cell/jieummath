"""사진 처리 흐름: 저장 → 카드 분리 → OMR 판독 → (뒤에서) 손글씨 판독."""
import logging
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import cv2

from .db import DB
from .vision.handwriting import HandwritingError, crop_regions, read_handwriting
from .vision.imageio import load_image
from .vision.markers import detect_cards
from .vision.omr import read_bubbles

log = logging.getLogger("omr")


class Service:
    def __init__(self, cfg):
        self.cfg = cfg
        self.data = Path(cfg["storage"]["data_path"])
        (self.data / "photos").mkdir(parents=True, exist_ok=True)
        (self.data / "cards").mkdir(parents=True, exist_ok=True)
        self.db = DB(self.data / "jieum.db")
        self.pool = ThreadPoolExecutor(max_workers=3, thread_name_prefix="hw")
        self.thresholds = {"filled": cfg["omr"]["filled"], "empty": cfg["omr"]["empty"]}

    @property
    def ai_enabled(self):
        return bool(self.cfg["api"].get("anthropic_api_key"))

    # ---------- 업로드 ----------
    def process_photo(self, data: bytes, original_name: str):
        img, taken = load_image(data)
        result = detect_cards(img)

        month = datetime.now().strftime("%Y%m")
        ext = Path(original_name or "").suffix.lower() or ".jpg"
        rel_photo = Path("photos") / month / f"{uuid.uuid4().hex}{ext}"
        (self.data / rel_photo).parent.mkdir(parents=True, exist_ok=True)
        (self.data / rel_photo).write_bytes(data)

        photo_id = self.db.add_photo(str(rel_photo), original_name, taken.isoformat(sep=" ") if taken else None,
                                     len(result.cards), result.missed)
        card_ids = []
        for i, card in enumerate(result.cards):
            rel_card = Path("cards") / month / f"{photo_id}_{i}_{uuid.uuid4().hex[:8]}.jpg"
            (self.data / rel_card).parent.mkdir(parents=True, exist_ok=True)
            cv2.imwrite(str(self.data / rel_card), card.image, [cv2.IMWRITE_JPEG_QUALITY, 92])
            omr = read_bubbles(card.image, self.thresholds)
            cid = self.db.add_card(photo_id, i, str(rel_card), omr, card.warnings,
                                   "waiting" if self.ai_enabled else "off")
            card_ids.append(cid)
            if self.ai_enabled:
                self.pool.submit(self._read_handwriting, cid)
        return {
            "photo_id": photo_id,
            "found": len(result.cards),
            "total": result.total,
            "missed": result.missed,
            "card_ids": card_ids,
        }

    def _read_handwriting(self, card_id):
        card = self.db.card(card_id)
        if not card or not card["image_path"]:
            return
        self.db.set_card_ai(card_id, "reading")
        try:
            img = cv2.imread(str(self.data / card["image_path"]))
            result = read_handwriting(crop_regions(img), self.cfg["api"])
            self.db.set_card_ai(card_id, "done", result=result)
        except HandwritingError as e:
            self.db.set_card_ai(card_id, "error", error=str(e))
        except Exception as e:  # 예상 못 한 오류도 화면에 보이게
            log.exception("손글씨 판독 오류 (카드 %s)", card_id)
            self.db.set_card_ai(card_id, "error", error=f"예상하지 못한 오류: {e}")

    def reread(self, card_id):
        if not self.ai_enabled:
            raise HandwritingError("config.toml에 Claude API 키가 없습니다")
        self.db.set_card_ai(card_id, "waiting")
        self.pool.submit(self._read_handwriting, card_id)

    def crop(self, card_id, region):
        card = self.db.card(card_id)
        if not card or not card["image_path"]:
            return None
        img = cv2.imread(str(self.data / card["image_path"]))
        crops = crop_regions(img)
        if region not in crops:
            return None
        ok, buf = cv2.imencode(".jpg", crops[region], [cv2.IMWRITE_JPEG_QUALITY, 88])
        return buf.tobytes()

    # ---------- 보관 기간 지난 사진 지우기 ----------
    def cleanup(self):
        days = self.cfg["storage"]["photo_retention_days"]
        photos, cards = self.db.old_files(days)
        for row, key in [(p, "file_path") for p in photos] + [(c, "image_path") for c in cards]:
            try:
                (self.data / row[key]).unlink(missing_ok=True)
            except OSError:
                log.warning("파일 삭제 실패: %s", row[key])
        self.db.clear_paths([p["id"] for p in photos], [c["id"] for c in cards])
        if photos or cards:
            log.info("%d일 지난 사진 %d개, 카드 이미지 %d개 삭제", days, len(photos), len(cards))

    def start_cleanup_loop(self):
        def loop():
            while True:
                try:
                    self.cleanup()
                except Exception:
                    log.exception("사진 정리 중 오류")
                threading.Event().wait(6 * 3600)

        threading.Thread(target=loop, daemon=True, name="cleanup").start()
