# 開發診斷與測試流程

## 模組邊界

`src/dev/diagnostics.ts` 集中原先放在 `main.ts` 的 12 個測試入口、音高統計、音訊快照、頻譜比對、進度計數，以及 `autoload`、`t`、`span` 開發網址參數。

`main.ts` 僅在 `import.meta.env.DEV` 動態載入並注入應用物件與操作介面。曲線、音軌、選取範圍等會被替換的資料使用 getter，避免載入新檔或復原後診斷仍讀到舊資料。正式建置不包含此模組；正式版不支援上述測試網址參數。熱更新移除自己的 hooks 並釋放音訊快照。

應用層仍負責工作狀態、讀檔、編輯、播放與算繪；診斷模組不接管這些流程。使用者可見的載入耗時報告仍保留。測試操作會修改目前曲線，僅應在測試工作階段使用。

| 開發入口 | 用途 |
|---|---|
| `__debug` | 編輯量、音高統計、復原深度、播放、視野、背景算繪與參考音軌狀態 |
| `__laneAtX` | 讀取畫面位置的曲線值與絕對音高 |
| `__seekForTest`、`__timeToX`、`__setView` | 固定播放頭、時間座標與視野 |
| `__waitBackground` | 等待背景精算完成 |
| `__snapRendered`、`__compareSnap` | 保存聲音片段，比較波形與頻譜 |
| `__rerenderForTest` | 不改曲線，單純重算作為對照 |
| `__stretchForTest` | 設定時間錨點並走既有復原／算繪流程 |
| `__pitchEditForTest` | 加入指定移調與抖音 |
| `__pitchCompare` | 重新偵測輸出音高，比較時間映射後的預期音高 |

## 建議執行順序

1. `npm run check`：型別與模組介面檢查。
2. `npm run verify:core`：依序執行目前 19 組測試，第一個失敗即停止。不需要真實音檔或外部 AI 服務。使用支援 `--experimental-transform-types` 的 Node；本次以 Node 22.23.2 驗證。
3. `npm run build`：正式建置。檢查產物沒有 `__debug`、`__pitchCompare`、`__stretchForTest` 等開發入口。
4. `npm run dev`：於 `http://127.0.0.1:5180/` 做下列人工操作驗收。
5. 涉及音訊引擎變動時，再執行指定聲音回歸與聆聽；核心測試通過不能取代音質驗證。

## 核心測試項目

來源：`tools/core-verify.mjs` 及各 `spike/*-test.mjs`。

| 測試檔（spike/） | 範圍 |
|---|---|
| work-state-test.mjs | 工作互斥、巢狀進度、完成／失敗釋放、過期更新、進度呈現 |
| ai-correction-flow-test.mjs | AI 流程順序、範圍限制、取消、失敗、重複啟動、復原紀錄 |
| ai-correction-test.mjs | 音符整理、修正程度、決策驗證、服務網址與模擬請求 |
| compute-mode-test.mjs | GPU 失敗回退 WASM、運算模式控制與進度 |
| load-lifecycle-test.mjs | 載入階段、工作鎖、暫存釋放、背景算繪失敗清理 |
| note-preview-test.mjs | 琴鍵試聽生命週期、載入與釋放（替代音訊依賴） |
| zoom-gesture-test.mjs | 滾輪／觸控縮放及定位 |
| detection-bar-test.mjs | 檢測範圍操作、與編輯選取分離、偏離顯示 |
| pitch-deviation-test.mjs | 最近調內音與 ±25 cents 判斷 |
| timemap-test.mjs | 時間對應、反向對應、邊界與錨點操作 |
| slope-limit-test.mjs | 音高變化率上限及範圍外不變 |
| diagnostics-test.mjs | 12 個入口、即時資料 getter、網址視野、快照比較與清理 |
| audio-segments-test.mjs | 舊分段相容性、AI／音高共用的 CPU 等量分段、一秒最低 RMS 中點與短檔縮減 |
| pitch-segments-test.mjs | 一秒最低平均音壓的中點、hop 對齊、上下文與無漏格合併 |

這些包含純數值測試與替代 DOM／Worker／服務的流程測試，不代表實際 GPU、音訊硬體或遠端模型已被驗證。

`spike/pitch-parallel-browser-test.mjs` 會以真正的瀏覽器 WASM 後端啟動 4 個持久 SwiftF0 Worker，確認多段合併長度；需先啟動開發伺服器。`spike/pitch-parallel-benchmark.mjs` 量測 360 秒合成音訊在 1、2、4 Worker 各一段，以及 4 Worker 共處理 8 段的完成時間，驗證不同硬體上的最佳分段數，不列入日常核心測試。

`spike/ai-segment-browser-test.mjs` 會以真正瀏覽器取得 CPU 工作槽數，透過與音高分析相同的分段器建立範圍，再驗證相同數量的 AI 候選 Worker 完成並合併結果。

`spike/ui-display-modules-browser-test.mjs` 會在隔離的 DOM fixture 中驗證頂部工作列、AI 工具列、Key／畫筆選項、檢測工具、底部全域控制、載入報告、選取參數 Inspector、工具／lane、播放列與參考音軌等顯示模組；測試確認它們只發出使用者意圖或呈現傳入狀態，無須建立 Curves、Player、Renderer 或工作狀態。

## 現有聲音與介面回歸

以下為既有指令，保持原本用途；部分仍使用 `--experimental-strip-types`，若 Node 無法處理 TypeScript parameter properties，單獨執行該檔時改用 `--experimental-transform-types --import ./tools/ts-resolve.mjs`。

| 指令／檔案 | 用途與需求 |
|---|---|
| `npm run verify` | 舊整合流程：瀏覽器、介面、壓平、共振峰、斜率、伸縮；不是核心測試指令 |
| `tools/verify.mjs`、`npm run verify:ui` | Puppeteer 操作及輸出驗證；需開發伺服器、Chrome、根目錄 `Vocal.wav`，部分斷言綁定既有素材 |
| `npm run verify:flatten` | 合成音的壓平聲音驗證 |
| `npm run verify:formant` | 共振峰聲音驗證；需要 `Vocal.wav` |
| `npm run verify:slope` | 斜率數值與音量自動化延遲 |
| `npm run verify:stretch` | 時間映射及伸縮後的音高、抖音 |
| `spike/onset-truth.mjs` | 起音驗證，存在 `Vocal.wav` 時額外分析真實素材 |
| `spike/note-preview-browser.html` | 琴鍵音色瀏覽器試聽；透過開發伺服器開啟 |

`tools/diag.mjs`、`measure.mjs`、`bisect.mjs`、`shot.mjs`、`edit-test.mjs`、`panel-test.mjs` 是個別瀏覽器診斷／截圖工具。`spike/` 其餘 compare、lag、probe、sweep、synth、spectrum、make-listen 等檔案是演算法實驗、量測與輔助工具，不能一律視為有通過／失敗門檻的回歸測試。工具用途以各檔開頭說明為準。

`Vocal.wav` 與下載目錄的 `test.wav` 不同；不可直接替換素材後沿用舊的固定音高、長度與時間範圍斷言。

## 大型音檔與人工操作流程

素材：`/Users/michael/Downloads/test.wav`，保留於下載目錄，不加入版本控制。

1. 開啟新測試頁，選 GPU 或 CPU，載入測試檔；记录讀取、解碼、波形與音高分析階段耗時。
2. 運算期間確認進度會變化，衝突操作被停用；完成與失敗後都應解除鎖定。
3. 完成後切換 GPU／CPU，確認閒置時可切換。GPU 回退另需在不支援 GPU 或失敗情境驗證。
4. 選調性、拖曳獨立檢測範圍，確認編輯選取不跟著改變；檢查原色、紅色、綠色顯示。
5. 使用內建修正先驗證 AI 按鈕閃爍、進度、範圍外不變，再復原；取消與錯誤情境分別檢查。
6. 若要驗證 Ollama／相容 API，需設定實際服務並另行記錄模型、請求結果；模擬請求測試不等於服務連通測試。
7. 測琴鍵發聲、播放、橫縱縮放；音訊引擎有改動時，補做輸出、重新載入及聆聽接縫與音質。
8. 記錄瀏覽器、後端、檔案大小／長度、各階段時間、錯誤與操作結果，結束後關閉測試頁釋放記憶體。

## 本次驗證紀錄（2026-10-04）

- 診斷拆分後：`npm run verify:core` 12 組通過；`npm run build` 通過。
- 正式產物檢查：沒有診斷入口及診斷模組檔案。
- 本次未重跑舊 Puppeteer、聲音回歸、實際外部 AI 或大型音檔載入；不可解讀為全部驗收通過。
- 拆分前的大型檔案操作結果（包含讀取、AI 修正及復原）見 [WORK_STATE.md](WORK_STATE.md)，不能當作拆分後重新實測的結果。
