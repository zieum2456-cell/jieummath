#!/bin/bash
# 처음 한 번만 실행: 필요한 프로그램을 내려받습니다.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null; then
  echo "Python이 없습니다. https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행하세요."
  read -r -p "엔터를 누르면 닫힙니다"; exit 1
fi
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)' || {
  echo "Python 3.11 이상이 필요합니다. https://www.python.org/downloads/ 에서 최신 버전을 설치하세요."
  read -r -p "엔터를 누르면 닫힙니다"; exit 1; }
python3 -m venv .venv && .venv/bin/pip install --upgrade pip && .venv/bin/pip install -r requirements.txt || {
  echo "설치 중 오류가 났습니다. 위 메시지를 확인하세요."; read -r -p "엔터를 누르면 닫힙니다"; exit 1; }
[ -f config.toml ] || cp config.example.toml config.toml
echo
echo "설치가 끝났습니다. config.toml을 열어 API 키를 넣은 뒤 '실행.command'를 더블클릭하세요."
open -e config.toml 2>/dev/null
read -r -p "엔터를 누르면 닫힙니다"
