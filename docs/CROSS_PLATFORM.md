# 跨平台開發與執行

本專案採瀏覽器應用架構。Windows／macOS 是 Node 開發環境；iOS／Android 使用瀏覽器載入建置後的網站，不在手機安裝 Node 或執行桌面啟動腳本。以下是支援目標與驗收要求，並非四平台已全部實測通過。

## Mac 轉 Windows 開發

1. 安裝 Node 22.23.2；已安裝 nvm 的環境可依 .nvmrc 選擇版本。package.json 限制 Node 22，避免 Node 26 移除 TypeScript transform 參數造成測試中止。
2. 保留原始碼、package-lock.json、vendor 與 AI訓練。執行 npm ci，讓 npm 重建目前平台的依賴；不要搬用 macOS 的 node_modules，也不要刪除鎖定檔來處理平台差異。
3. 執行 npm run check、npm run verify:core、npm run build。
4. Windows 雙擊 start-wipitch.cmd，或兩平台都執行 npm run dev:local，於 http://127.0.0.1:5180 開啟。
5. Windows 的原始路徑選檔使用 PowerShell／系統檔案對話框；macOS 保留原 AppleScript 選檔。對話框需在真實桌面人工驗收。

原始碼開發需要 npm 網路依賴；vendor 並未包含所有 npm 套件。既有離線發行包的 shell 安裝流程仍是 macOS／Linux 用途，不是 Windows 安裝包。

專案存檔內的絕對音檔路徑不能跨電腦直接沿用。轉移時保留音檔，並在新電腦重新選取；手機／靜態網站使用瀏覽器檔案選擇。個人訓練資料留在開發電腦，不打包進網站。

## 執行目標

| 平台 | 驗收瀏覽器 | 載入方式 |
|---|---|---|
| Windows | Edge、Chrome | 本機開發服務或建置後 HTTPS 網站 |
| macOS | Safari、Chrome | 本機開發服務或建置後 HTTPS 網站 |
| iOS／iPadOS | Safari | 建置後 HTTPS 網站、系統檔案選擇 |
| Android | Chrome | 建置後 HTTPS 網站、系統檔案選擇 |

行動版目前補上窄螢幕面板捲動、觸控目標與畫布 Pointer Events 手勢設定；仍需真機確認可用性。推薦先以短單聲道人聲驗收，長音檔的記憶體與 Worker 數量需要各裝置實測。GPU 不作為必要條件，程式已有 WASM fallback；實際是否成功仍需瀏覽器測試。

npm run dev 允許區網連線，可供手機測試一般功能。正式行動驗收使用 HTTPS 部署；區網 HTTP 的功能可用性不能當成 HTTPS 的結果。本機 /__training API 只允許 localhost 同來源，因此手機連到電腦區網位址時不能管理電腦訓練資料或讀取電腦絕對路徑。靜態站也沒有此 API。

音訊必須從使用者點擊播放／琴鍵開始驗收；檔案格式解碼、下載 WAV 的保存位置與背景切換行為須逐平台記錄。外部 AI 為選用功能，須另外檢查服務連線、HTTPS 與 CORS；手機 localhost 指的是手機本身，不是開發電腦。

## 每平台驗收清單

- 選檔、音高分析完成、GPU 不可用時回退 WASM。
- 點擊播放與琴鍵發聲；停止、拖曳、選取、縮放、畫筆、復原。
- 三種工作區及偏好保存；直向與橫向視窗無關鍵控制項被遮住。
- AI 規則模式、修正接受／取消、Formant、時間伸縮、WAV 匯出與重新開啟。
- 短檔及長檔的耗時、記憶體與失敗後解除鎖定。

2026-11-06：Windows 本機音檔路徑／串流測試通過。依賴重建與完整建置狀態另記於本次檢查；macOS、iOS、Android 真機測試尚未執行。

## 2026-11-06 Windows 遷移驗證更新

已成功以 npm ci 重建 Windows 平台依賴；npm 提示 ffmpeg-static、protobufjs、puppeteer 的安裝腳本未獲目前 npm 設定允許，相關執行檔功能須另行確認。

- npm run check：通過。
- npm run build：通過（此次執行使用系統 Node 26；正式開發仍固定 Node 22）。
- Node 22.23.2 執行 tools/core-verify.mjs：19 組全部通過。沙箱暫存 rename 曾回報 EPERM，於正常 Windows 權限下重跑通過。
- npm run dev:local：成功於 127.0.0.1:5180 啟動。
- Windows 原生選檔對話框、iOS／Android／macOS 真機及實際音質尚未驗收。

系統 Node 目前仍為 26；此次以專案 npm 快取內的 Node 22 完成核心驗證，未改動系統安裝。後續請依 .nvmrc 安裝／切換 Node 22.23.2 再開發。

追加驗證：Node 22.23.2 直接執行 TypeScript 型別檢查及 Vite 正式建置均通過。既有 spike/ui-display-modules-browser-test.mjs 於正常 Windows 權限下，與隔離測試伺服器同環境執行通過（臨時使用 5181 連接埠，測試副本已移除），確認顯示模組、工作區偏好與黃框縮放手勢。此測試不等於行動裝置真機或 Windows 原生對話框驗收。
