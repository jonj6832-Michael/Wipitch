#!/bin/sh
# 產生「容易安裝版」：release/wipitch-<版本>.tar.gz
# 內容是 build 好的靜態檔 + 零依賴的 Node 伺服器，別台電腦只要有 Node 就能用。
set -e
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ] && [ -z "$ALLOW_DIRTY" ]; then
	echo "工作區有未 commit 的改動，先 commit 再出版（或設 ALLOW_DIRTY=1 強制）。"
	exit 1
fi
VERSION=$(git describe --tags --always --dirty)
NAME="wipitch-$VERSION"
OUT="release/$NAME"

# 嚴格照 package-lock.json 裝；出版不需要 puppeteer 的 Chrome
PUPPETEER_SKIP_DOWNLOAD=1 npm ci
npm run build

rm -rf "$OUT" "$OUT.tar.gz"
mkdir -p "$OUT"
cp -R dist "$OUT/app"
cp tools/release/serve.mjs tools/release/install.sh tools/release/start.sh tools/release/README.txt "$OUT/"
chmod +x "$OUT/install.sh" "$OUT/start.sh"
tar -C release -czf "$OUT.tar.gz" "$NAME"

echo
echo "完成：$OUT.tar.gz（$(du -h "$OUT.tar.gz" | cut -f1)）"
