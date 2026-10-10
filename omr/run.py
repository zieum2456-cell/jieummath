"""진도 카드 프로그램 실행. 터미널에서:  python run.py"""
import logging

import uvicorn

from app.config import CONFIG_PATH, load_config
from app.main import create_app
from app.netguard import local_ip


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", datefmt="%H:%M:%S")
    cfg = load_config()
    port = int(cfg["server"]["port"])
    ip = local_ip()
    print()
    print("=" * 56)
    print(" 진도 카드 프로그램이 켜졌습니다")
    print(f"   이 컴퓨터에서:   http://localhost:{port}")
    if ip:
        print(f"   휴대폰·아이패드: http://{ip}:{port}")
        print("   (같은 공부방 와이파이에 연결되어 있어야 합니다)")
    if not cfg["api"].get("anthropic_api_key"):
        print(f" ※ {CONFIG_PATH.name}에 API 키가 없어 손글씨 판독은 꺼져 있습니다")
    print(" 끝내려면 이 창에서 Control + C")
    print("=" * 56)
    print()
    # proxy_headers=False: 접속한 기기의 실제 주소로만 와이파이 안/밖을 판단한다
    uvicorn.run(create_app(cfg), host="0.0.0.0", port=port, proxy_headers=False, log_level="warning")


if __name__ == "__main__":
    main()
