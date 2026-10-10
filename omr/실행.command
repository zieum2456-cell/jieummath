#!/bin/bash
# 프로그램 실행. 이 창을 닫으면 프로그램도 꺼집니다.
cd "$(dirname "$0")" || exit 1
if [ ! -x .venv/bin/python ]; then
  echo "먼저 '설치.command'를 실행하세요."; read -r -p "엔터를 누르면 닫힙니다"; exit 1
fi
(sleep 2; open "http://localhost:$(.venv/bin/python -c 'from app.config import load_config; print(load_config()["server"]["port"])')") &
.venv/bin/python run.py
