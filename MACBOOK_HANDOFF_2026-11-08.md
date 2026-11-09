# WiPitch：Windows → MacBook 整個目錄搬移交接清單

交接快照：2026-11-08（Asia/Taipei）  
來源目錄：`I:\GitHub\wipitch`  
搬移方式：複製**整個 `wipitch` 目錄**，包含隱藏檔與 `.git`，到 MacBook 上的新位置。Mac 接收端先保留舊目錄，不以新目錄直接覆蓋。

## 目前基準

- [x] Git 分支 `main`，HEAD `4b3c773 v1.0`；本次查看 `git status --porcelain=v1` 為空，沒有未提交修改。
- [x] 正式訓練庫 `AI訓練/`：3,605 個檔案、1,193,767,658 bytes、597 筆 `record.json`；`AI訓練/模型/內建AI.json` 存在。
- [x] `AI訓練暫存/`：目前 0 個檔案。搬移目錄時仍保留這個資料夾。
- [x] Node 版本設定 `.nvmrc` 為 `22.23.2`；`package.json` 要求 Node 22。
- [x] `vendor/`、`package-lock.json`、`啟動WiPitch.command`、`start-wipitch.cmd` 均在來源目錄。

以上是來源端檔案狀態，不代表 Mac 接收端已驗證。舊的 `docs/HANDOFF.md` 記錄的是 2026-11-05、HEAD `912054b` 的歷史快照；以本清單與 Mac 接收後實測為準。

## Windows 複製前

- [ ] 完整關閉 WiPitch 開發服務及正在使用訓練庫的瀏覽器頁面，避免複製途中資料變動。
- [ ] 將整個 `wipitch` 目錄複製到外接碟或傳輸位置；確認 `.git`、`.nvmrc`、`.gitignore` 等隱藏項目一併複製。
- [ ] 保留 Windows 原目錄作為備份，直到 Mac 驗收完成。若傳輸媒介是 FAT32，單一檔案大小限制可能影響複製；先確認傳輸媒介與檔案均可完整搬移。
- [ ] 測試音檔若位於專案外（例如 Downloads），另行確認是否需要搬移；專案內的 `Vocal.wav` 如存在也需保留，但目前不以 Git 追蹤。

`AI訓練/`、`AI訓練暫存/`、`node_modules/`、`dist/` 和 `.npm-cache/` 都被 Git 忽略，僅靠 Git 同步不會帶走。整個目錄複製會包含它們；其中訓練資料必須保存。`node_modules/` 與 `dist/` 是平台相關／可重建資料，Mac 上須以 `npm ci` 和 `npm run build` 重建，不能沿用 Windows 的可執行檔。

## MacBook 接收後

- [ ] 複製到新目錄後，先確認 `.git`、`package-lock.json`、`vendor/`、`AI訓練/`、`啟動WiPitch.command` 都存在。若 Mac 原本已有 `wipitch`，先比對兩份目錄與訓練資料，不直接覆蓋或合併。
- [ ] 核對 `AI訓練/` 為 3,605 個檔案、1,193,767,658 bytes、597 筆 `record.json`；核對模型檔存在。若有落差，先檢查複製過程或來源資料是否已在搬移期間更新。
- [ ] 在新目錄執行 `git status --short`、`git log -1 --oneline`；應看到 `4b3c773 v1.0`，且工作樹乾淨。不要用 `git reset --hard` 或 `git checkout -- .` 修復複製差異。
- [ ] 切換至 Node `22.23.2`，執行 `npm ci`，讓 npm 依 Mac 架構重新安裝平台套件；保留 `package-lock.json`，不要直接使用複製來的 Windows `node_modules`。
- [ ] 執行 `npm run check`、`npm run verify:core`、`npm run build`，記錄 Mac 上實際結果。
- [ ] 執行 `npm run dev:local` 並開啟 `http://127.0.0.1:5180/`；或檢查 `啟動WiPitch.command` 的執行權限與啟動結果。
- [ ] 用有權使用的短音檔確認載入、CPU/GPU 音高分析、播放、AI 黃框、傳統規則修正、復原及 WAV 匯出。
- [ ] 檢查「訓練資料庫管理」能讀到資料；在需要時重新掃描內建 AI 模型。訓練庫 API 只在本機 Vite 服務提供。
- [ ] 測試新加的「GPU／CPU 測速」按鈕：使用同一個音檔比較兩種模式；GPU 回退 CPU 時不能把回退耗時當作 GPU 成績。
- [ ] 舊專案存檔若記錄 Windows 或舊 Mac 絕對音檔路徑，重新指定 Mac 上的音檔位置。瀏覽器 localStorage 的偏好與外部 AI API Key 不會隨專案目錄搬移。

## 特別留意

- 程式支援 Windows／Mac 開發與手機瀏覽器使用，但本次交接的驗收對象是 MacBook。iOS／Android 真機相容與音質仍需另行驗證。
- 目前傳統規則的修正程度使用連續偏離時間門檻，1～10 級分別為 480～48 ms；相關邏輯在 `src/model/rule-selection.ts`。實際人聲聆聽尚需驗收。
- 畫面每幀更新協調位於 `src/application/display-coordinator.ts`；曲線、黃框與節拍標記由對應 View 繪製。
- Mac 的 `npm ci` 需要網路下載未封裝在 `vendor/` 的套件。若離線，先準備 npm 快取或可用的安裝來源。

交接完成標準：Mac 上檔案與訓練庫數量核對一致，Git 狀態確認，Node 22 依賴重建與三項指令通過，再以音檔完成基本操作驗收。保留 Windows 原目錄至此為止。
