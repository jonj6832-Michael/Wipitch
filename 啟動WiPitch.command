#!/bin/bash
# Finder 雙擊時也從專案目錄啟動。
cd -- "$(dirname -- "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

fail() {
  printf '\n%s\n' "$1"
  read -r -p '按 Enter 關閉視窗…' _reply
  exit 1
}

command -v node >/dev/null 2>&1 || fail '找不到 Node.js，請先安裝 Node.js 再啟動。'
[[ -f node_modules/vite/bin/vite.js ]] || fail '缺少開發依賴，請先在此專案執行 npm install。'

url='http://127.0.0.1:5180/'
is_wipitch() {
  curl --silent --fail --max-time 2 "$url" | grep -q '<title>WiPitch'
}

if is_wipitch; then
  printf 'WiPitch 已在執行，正在開啟瀏覽器。\n'
  open "$url"
  exit $?
fi

printf '正在啟動 WiPitch…\n請保留此終端機視窗；按 Control+C 可停止程式。\n'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5180 --strictPort &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$server_pid" 2>/dev/null || fail '啟動失敗，請查看上方錯誤；5180 連接埠可能正被其他程式使用。'
  if is_wipitch; then
    printf '\nWiPitch 已啟動：%s\n' "$url"
    open "$url" || printf '無法自動開啟瀏覽器，請手動開啟上方網址。\n'
    wait "$server_pid"
    result=$?
    [[ "$result" -eq 0 ]] || fail 'WiPitch 已停止，請查看上方錯誤訊息。'
    exit 0
  fi
  sleep 0.5
done
fail '等待啟動逾時，請查看上方錯誤訊息。'
