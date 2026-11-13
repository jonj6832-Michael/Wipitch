#!/bin/sh
# 啟動 WiPitch（不需要安裝，直接執行也可以）
DIR="$(cd "$(dirname "$0")" && pwd)"
if [ ! -x "$DIR/.venv/bin/python" ]; then
	echo "尚未安裝 Librosa 依賴，請先執行 ./install.sh。" >&2
	exit 1
fi
exec node "$DIR/serve.mjs"
