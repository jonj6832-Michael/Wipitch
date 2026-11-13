WiPitch（Linux / macOS）

需要：Node.js 18 版以上、Python 3 與網路（安裝 Librosa/NumPy）

1. 解壓縮：tar xzf wipitch-*.tar.gz
2. 安裝：  cd wipitch-* && ./install.sh
3. 開啟：  wipitch   （會自動開瀏覽器到 http://127.0.0.1:5180/）

完成安裝後也可以直接在資料夾裡執行 ./start.sh。
連接埠被佔用時：PORT=5181 wipitch

安裝器會在 ~/.local/share/wipitch/.venv 建立獨立 Python 環境，並預先安裝
requirements-librosa.txt 內的 NumPy 與 Librosa。參考音軌的節拍和弦分析需要這個環境。

本機開檔、同目錄 .wipitch.json 自動讀寫與 WAV/WAVE 回存原檔均可使用。
MP3、M4A、FLAC 等壓縮格式可編輯及匯出 WAV，但離線版不直接覆寫壓縮原檔。
