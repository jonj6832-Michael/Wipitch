#!/bin/bash
# Finder 雙擊時，從這個檔案所在的 WiPitch 目錄啟動本機後台，並以 Chrome 開啟。
project_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
cd -- "$project_dir" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

url='http://127.0.0.1:5180/'
chrome_app='/Applications/Google Chrome.app'

fail() {
  printf '\n%s\n' "$1"
  read -r -p '按 Enter 關閉視窗…' _reply
  exit 1
}

command -v node >/dev/null 2>&1 || fail '找不到 Node.js，請先安裝 Node.js 再啟動。'
[[ "$(node -p "process.versions.node.split('.')[0]")" == '22' ]] || fail 'Node.js 版本不符，請依 .nvmrc 切換至 Node 22.23.2。'
[[ -f node_modules/vite/bin/vite.js ]] || fail '缺少開發依賴，請先在此專案執行 npm install。'
[[ -d "$chrome_app" ]] || fail "找不到 Google Chrome：$chrome_app"

open_chrome() {
  /usr/bin/open -a "$chrome_app" "$url"
}

is_wipitch() {
  curl --silent --fail --max-time 2 "$url" | grep -q '<title>WiPitch'
}

if is_wipitch; then
  printf 'WiPitch 已在執行，正在以 Google Chrome 開啟。\n'
  open_chrome
  exit $?
fi

printf 'WiPitch 目錄：%s\n' "$project_dir"
printf '正在啟動本機後台：%s\n' "$url"
printf '請保留此終端機視窗；按 Control+C 可停止後台。\n'
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
    printf '\nWiPitch 後台已啟動，正在以 Google Chrome 開啟：%s\n' "$url"
    open_chrome || printf '無法自動開啟 Google Chrome，請手動開啟上方網址。\n'
    wait "$server_pid"
    result=$?
    [[ "$result" -eq 0 ]] || fail 'WiPitch 已停止，請查看上方錯誤訊息。'
    exit 0
  fi
  sleep 0.5
done
fail '等待啟動逾時，請查看上方錯誤訊息。'
