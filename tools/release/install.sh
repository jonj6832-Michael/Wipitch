#!/bin/sh
# WiPitch 安裝：複製程式、建立 Python 虛擬環境並安裝 Librosa 分析依賴。
set -e
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/wipitch"
BIN="$HOME/.local/bin"

if ! command -v node >/dev/null 2>&1; then
	echo "找不到 Node.js。請先安裝（18 版以上）："
	echo "  macOS：brew install node，或到 https://nodejs.org 下載"
	echo "  Ubuntu/Debian：sudo apt install nodejs"
	exit 1
fi
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 18 ]; then
	echo "Node.js 版本太舊（$(node -v)），需要 18 版以上。"
	exit 1
fi

if [ "$SRC" != "$DEST" ]; then
	rm -rf "$DEST"
	mkdir -p "$DEST"
	cp -R "$SRC/." "$DEST/"
fi

PYTHON="$(command -v python3 || true)"
if [ -z "$PYTHON" ]; then
	echo "找不到 Python 3。WiPitch 的參考音軌節拍與和弦分析需要 Python 3。"
	echo "  macOS：brew install python"
	echo "  Ubuntu/Debian：sudo apt install python3 python3-venv"
	exit 1
fi

if ! "$PYTHON" -m venv "$DEST/.venv"; then
	echo "無法建立 Python 虛擬環境，請確認已安裝 python3-venv。"
	exit 1
fi
"$DEST/.venv/bin/python" -m pip install --disable-pip-version-check -r "$DEST/requirements-librosa.txt"
mkdir -p "$BIN"
cat > "$BIN/wipitch" <<EOF
#!/bin/sh
exec "$DEST/start.sh" "\$@"
EOF
chmod +x "$BIN/wipitch" "$DEST/start.sh"

echo "安裝完成：$DEST"
case ":$PATH:" in
	*":$BIN:"*) echo "執行 wipitch 就會開啟。" ;;
	*) echo "執行 $BIN/wipitch 就會開啟。"
	   echo "（想直接打 wipitch 的話，把 export PATH=\"\$HOME/.local/bin:\$PATH\" 加進 ~/.zshrc 或 ~/.bashrc）" ;;
esac
