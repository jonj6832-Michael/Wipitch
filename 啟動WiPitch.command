#!/bin/bash
# Finder 雙擊時，從這個檔案所在的 WiPitch 目錄啟動本機後台，並以 Chrome 開啟。
project_dir="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
cd -- "$project_dir" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

chrome_app='/Applications/Google Chrome.app'
base_port=5180
max_port=5190
port=''
url=''

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

listener_pid() {
  /usr/sbin/lsof -nP -tiTCP:"$1" -sTCP:LISTEN 2>/dev/null | head -n 1
}

listener_cwd() {
  local pid="$1"
  /usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1
}

# 先尋找是否已有「這個目錄」啟動的 WiPitch。不能只檢查頁面標題，因為電腦上
# 可能同時保留另一份 wipitch；舊版做法會因此誤開另一個目錄的服務。
for candidate in $(seq "$base_port" "$max_port"); do
  pid="$(listener_pid "$candidate")"
  [[ -n "$pid" ]] || continue
  [[ "$(listener_cwd "$pid")" == "$project_dir" ]] || continue
  port="$candidate"
  url="http://127.0.0.1:$port/"
  if curl --silent --fail --max-time 2 "$url" | grep -q '<title>WiPitch'; then
    printf '目前 GitHub 目錄的 WiPitch 已在 %s 執行，正在以 Google Chrome 開啟。\n' "$url"
    open_chrome
    exit $?
  fi
done

# 5180 若被另一份 WiPitch 占用，保留該程序與尚未儲存的瀏覽器工作，改用下一個空閒埠。
for candidate in $(seq "$base_port" "$max_port"); do
  if [[ -z "$(listener_pid "$candidate")" ]]; then
    port="$candidate"
    url="http://127.0.0.1:$port/"
    break
  fi
done
[[ -n "$port" ]] || fail "$base_port～$max_port 連接埠都在使用中，無法啟動 WiPitch。"

printf 'WiPitch 目錄：%s\n' "$project_dir"
printf '正在啟動本機後台：%s\n' "$url"
printf '請保留此終端機視窗；按 Control+C 可停止後台。\n'
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$port" --strictPort &
server_pid=$!
cleanup() {
  kill "$server_pid" 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 0' INT TERM HUP

for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$server_pid" 2>/dev/null || fail "啟動失敗，請查看上方錯誤；$port 連接埠可能正被其他程式使用。"
  if curl --silent --fail --max-time 2 "$url" | grep -q '<title>WiPitch'; then
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
