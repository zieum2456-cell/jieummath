"""샘플 사진(IMG_6549.pdf) 판독 테스트. 실행: python -m pytest tests"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.checks import check_values, to_24h
from app.config import load_config
from app.netguard import allowed, build_networks
from app.vision.imageio import load_image
from app.vision.markers import detect_cards
from app.vision.omr import read_bubbles

SAMPLE = Path(__file__).resolve().parents[2] / "IMG_6549.pdf"

# 샘플 카드 3장의 정답 (사진 왼쪽부터)
EXPECTED = [
    {"tens": "5", "ones": "6", "attendance": "makeup", "last_hw": "no_hw", "stage": ["wrong_note"],
     "progress": "75_100", "error_cause": ["calc"], "points": "0"},
    {"tens": "4", "ones": "3", "attendance": None, "last_hw": "done", "stage": ["test", "contest"],
     "progress": "50_75", "error_cause": ["condition"], "points": "0"},
    {"tens": "7", "ones": "3", "attendance": "makeup", "last_hw": "done", "stage": ["concept", "wrong_note"],
     "progress": "75_100", "error_cause": ["concept", "condition"], "points": "9"},
]


@pytest.fixture(scope="module")
def sample_cards():
    img, _ = load_image(SAMPLE.read_bytes())
    return detect_cards(img)


def test_detects_three_cards(sample_cards):
    assert len(sample_cards.cards) == 3
    assert sample_cards.missed == 0


@pytest.mark.parametrize("i", range(3))
def test_omr_matches_answer(sample_cards, i):
    fields = read_bubbles(sample_cards.cards[i].image)["fields"]
    for name, want in EXPECTED[i].items():
        got = fields[name]["value"]
        if isinstance(want, list):
            assert sorted(got) == sorted(want), name
        else:
            assert got == want, name
        assert fields[name]["flags"] == [], (name, fields[name]["flags"])


def test_rotated_photo_still_detected():
    import cv2

    img, _ = load_image(SAMPLE.read_bytes())
    rotated = cv2.rotate(img, cv2.ROTATE_90_CLOCKWISE)
    res = detect_cards(rotated)
    assert len(res.cards) == 3
    numbers = sorted(int(read_bubbles(c.image)["fields"]["tens"]["value"]) * 10 +
                     int(read_bubbles(c.image)["fields"]["ones"]["value"]) for c in res.cards)
    assert numbers == [43, 56, 73]


def test_partly_hidden_card_counts_as_missed():
    img, _ = load_image(SAMPLE.read_bytes())
    img = img.copy()
    img[1600:1800, 2800:3000] = (90, 110, 140)  # 오른쪽 카드 왼쪽 아래 기준점을 가림
    res = detect_cards(img)
    assert len(res.cards) == 2
    assert res.total == 3


def test_to_24h():
    assert to_24h("4:55") == "16:55"
    assert to_24h("3:00") == "15:00"
    assert to_24h("10:30") == "10:30"
    assert to_24h("12:05") == "12:05"
    assert to_24h("??") is None


def test_netguard():
    nets = build_networks(["192.168.0.0/24"])
    assert allowed("192.168.0.31", nets)
    assert allowed("127.0.0.1", nets)
    assert not allowed("192.168.1.5", nets)
    assert not allowed("8.8.8.8", nets)


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    cfg = load_config(tmp_path / "none.toml")
    cfg["storage"]["data_path"] = tmp_path / "data"
    cfg["api"]["anthropic_api_key"] = ""
    from app.main import create_app

    app = create_app(cfg)
    with TestClient(app, client=("127.0.0.1", 5000)) as c:
        yield c


def test_upload_review_save_flow(client):
    for number, name in ((56, "김도윤"), (43, "이지아"), (73, "박채아")):
        assert client.post("/api/students", json={"number": number, "name": name}).status_code == 200

    r = client.post("/api/upload", files={"files": ("IMG_6549.pdf", SAMPLE.read_bytes(), "application/pdf")})
    res = r.json()[0]
    assert (res["found"], res["total"]) == (3, 3)

    cards = client.get("/api/cards").json()
    assert [c["student_number"] for c in cards] == [56, 43, 73]
    assert [c["student_name"] for c in cards] == ["김도윤", "이지아", "박채아"]

    detail = client.get(f"/api/cards/{cards[0]['id']}").json()
    assert detail["values"]["attendance"] == "makeup"
    assert "handwriting" in detail["read_flags"]  # API 키가 없어 손글씨 판독 꺼짐

    # 과제 없음 + 초록 펜 범위 → 모순
    values = dict(detail["values"], goal_items=[{"color": "green", "raw_text": "디딤돌 93~94"}])
    flags = client.post(f"/api/cards/{cards[0]['id']}/check", json={"values": values}).json()["check_flags"]
    assert "last_hw" in flags

    values["last_hw"] = "done"
    values["lesson_date"] = "2026-10-08"
    assert client.post(f"/api/cards/{cards[0]['id']}/save", json={"values": values}).status_code == 200

    # 같은 학생·같은 날짜를 다른 카드로 저장하려 하면 409, 덮어쓰기 가능
    v2 = dict(client.get(f"/api/cards/{cards[1]['id']}").json()["values"], student_number=56, lesson_date="2026-10-08")
    flags = client.post(f"/api/cards/{cards[1]['id']}/check", json={"values": v2}).json()["check_flags"]
    assert "lesson_date" in flags
    assert client.post(f"/api/cards/{cards[1]['id']}/save", json={"values": v2}).status_code == 409
    assert client.post(f"/api/cards/{cards[1]['id']}/save", json={"values": v2, "mode": "replace"}).status_code == 200
    assert len(client.get("/api/cards").json()) == 2  # 덮어쓴 첫 카드는 다시 확인 대기로

    # 명단에 없는 번호
    v3 = dict(v2, student_number=99)
    flags = client.post(f"/api/cards/{cards[2]['id']}/check", json={"values": v3}).json()["check_flags"]
    assert "명단에 없음" in flags["student_number"][0]
    assert client.post(f"/api/cards/{cards[2]['id']}/save", json={"values": v3}).status_code == 400


def test_name_mismatch(client):
    client.post("/api/students", json={"number": 56, "name": "김도윤"})
    client.post("/api/students", json={"number": 43, "name": "이지아"})
    svc = client.app.state.svc
    flags = check_values({"student_number": 56, "name": "지아", "goal_items": []}, svc.db)
    assert "43번 이지아" in flags["name"][0]
    assert "name" not in check_values({"student_number": 56, "name": "도윤", "goal_items": []}, svc.db)


def test_outside_network_blocked(tmp_path):
    cfg = load_config(tmp_path / "none.toml")
    cfg["storage"]["data_path"] = tmp_path / "data"
    cfg["server"]["allowed_networks"] = ["192.168.0.0/24"]
    from app.main import create_app

    with TestClient(create_app(cfg), client=("203.0.113.9", 5000)) as c:
        assert c.get("/").status_code == 403
