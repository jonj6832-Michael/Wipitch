#!/bin/sh
# 啟動 WiPitch（不需要安裝，直接執行也可以）
DIR="$(cd "$(dirname "$0")" && pwd)"
exec node "$DIR/serve.mjs"
