#!/bin/bash
# 학교 게시판이 GitHub Actions(해외 서버)를 막아서, 맥북에서 게시판 읽기만 하고 데이터를 올린다.
# 올라가면 "주간학습안내 모으기" 워크플로가 수학 부분 뽑기를 이어서 한다.
# launchd(scripts/school-weekly-mac.plist)가 금·토·일 09:10에 실행한다. 이 스크립트 전용 클론에서만 쓴다(로컬 변경을 지운다).
set -euo pipefail
cd "$(dirname "$0")/.."
BRANCH=claude/student-payment-notification-j7g4us
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi

echo "== $(date '+%Y-%m-%d %H:%M')"
git fetch -q origin "$BRANCH"
git checkout -q -B "$BRANCH" "origin/$BRANCH"
node scripts/school-weekly-fetch.js
git add school-weekly-data.json
if git diff --cached --quiet; then echo "바뀐 내용 없음"; exit 0; fi
git commit -q -m "주간학습안내 데이터 갱신 (맥북)"
git push -q origin "$BRANCH"
echo "올림"
