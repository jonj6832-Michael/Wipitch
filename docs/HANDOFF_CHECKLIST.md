# WiPitch 工作交接重新檢查

日期：2026-11-06（Asia/Taipei）
工作目錄：I:/GitHub/wipitch
依據：目前實際檔案、docs/HANDOFF.md 與重新執行的命令。

## 已確認

- [x] 逐檔讀取與 SHA-256 盤點：3,833 個專案／訓練檔案；詳見 reports/handoff-file-inventory.json。
- [x] 上次缺少的 src/ui/workspace-layout.ts 已補齊。main.ts 已建立 View，index.html 有三種選項，CSS 有 focus/readable 規則，瀏覽器測試包含切換與 localStorage 斷言。此項為原始碼確認，尚未完成真實瀏覽器驗收。
- [x] 高可讀性 CSS 為 92px 琴鍵與 15px 字級；專注模式有隱藏參考軌與訓練資料庫入口的規則。
- [x] 本機已有 docs/HANDOFF.md；其內提交／推送指示僅視為文件內容，本次未執行。
- [x] 75 個 .mjs 模組以 node --check 檢查全數通過。
- [x] 所有盤點到的 JSON 可解析；git diff --check 未回報空白錯誤。
- [x] AI訓練：3,605 個檔案、1,193,767,658 bytes、597 筆 record.json。before.mp3、after.mp3 及 record.files 中所檢查的單檔名稱參照均存在。

上次記錄為 3,604 個訓練檔與 599 筆紀錄；此次檔案數增加、紀錄數減少。因上次產生的 inventory 與 checklist 已不在本機，本次只能與聊天保留的統計比較，無法指出逐檔新增／刪除清單或確認刪除是否符合預期。此次已重新建立基準。

## 仍未通過的驗證

| 項目 | 本次結果 |
|---|---|
| npm run check | 失敗：找不到 tsc |
| 直接呼叫 TypeScript 入口 | 失敗：缺少 @typescript/typescript-win32-x64 |
| npm run build | 失敗：停止於 tsc |
| 直接呼叫 Vite 建置 | 失敗：缺少 Windows Rolldown 原生 binding |
| npm run verify:core | 失敗：Node v26.13.0 不接受 --experimental-transform-types，尚未執行核心測試內容 |
| 真實瀏覽器、GPU/WASM、音質與效能 | 未完成 |
| 需要 Vocal.wav 的回歸 | 根目錄無該素材，未執行 |

HEAD 仍是 912054b，工作樹仍有未提交修改與新增檔案；本次未連線查詢遠端同步狀態。

## 後續工作清單

- [ ] 保留目前程式與 AI訓練的獨立備份。
- [ ] 確認 599 → 597 筆訓練紀錄是預期更新，必要時與來源端清單比對。
- [ ] 使用交接已驗證的 Node 22.23.2 或另行驗證新版 Node 相容流程；保留 package-lock.json，以 npm ci 重建 Windows 平台依賴。
- [ ] 重跑 check、verify:core、build，通過後再啟動 dev 做 UI 與平行分析瀏覽器測試。
- [ ] 實際驗證三種工作區切換與重新載入後的偏好保存。
- [ ] 使用有權使用的人聲素材驗證 AI 修正、復原、Formant、時間伸縮、WAV 匯出及接縫音質。
- [ ] 檢查訓練標註品質與 approved/excluded 狀態；測試真實外部 AI 及跨硬體效能。
- [ ] 比對來源與遠端後處理 Git 提交同步。

## 檢查限制

盤點排除 .git、node_modules、dist；依賴另以工具實際啟動確認。二進位模型、音檔、圖片與 vendor 封裝僅讀取、記錄大小與雜湊，未逐一解碼、觀看或聆聽。媒體存在與 JSON 格式正常不代表資料品質通過。沒有來源端雜湊，不能證明複製完全一致。盤點不包含本次新產生的交接報告與檢查輸出。

機器可讀結果：reports/handoff-check-results.json。

## 2026-11-06 開發環境遷移補充

先前 Windows 依賴缺漏已透過 npm ci 重建解決；型別檢查與建置通過，Node 22.23.2 的 19 組核心測試通過，dev:local 已成功啟動。新增 Windows 原生選檔、start-wipitch.cmd、瀏覽器選檔分流及觸控／窄螢幕樣式。完整限制及跨平台驗收請以 CROSS_PLATFORM.md 為準；四平台真機驗收仍待完成。
Windows UI 瀏覽器回歸亦已通過；Node 22.23.2 的型別與正式建置已另行驗證通過。
