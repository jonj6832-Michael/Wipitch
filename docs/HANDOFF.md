# WiPitch 專案交接說明

> 交接快照：2026-11-05（Asia/Taipei）  
> 工作目錄：`/Users/michael/Documents/Codex/wipitch`  
> Git 分支：`main`；目前最新提交：`912054b Modularize AI correction and training workflow`

這份文件的目的，是讓另一台電腦上的開發者能在不依賴目前聊天紀錄的情況下，理解 WiPitch 的架構、啟動方式、資料位置、驗證方式，以及目前尚未同步的工作。

## 交接狀態：先處理 Git

整個專案目錄（包含 `AI訓練/`）已由人工完整複製到目標電腦；**GitHub 目前尚未同步**。

來源端目前不是乾淨工作樹：有 26 個已追蹤檔案修改、22 個新增且未追蹤的檔案。這些是目前功能的一部分，尚未包含在 `912054b` 中。因此在來源端確認後，應先將變更提交並推送；目標電腦在確認複製內容後再拉取或建立相同提交，避免以 `git reset`、`git checkout -- .` 或重新 clone 覆蓋已複製的工作。

```sh
# 來源端：先看清楚將進入提交的內容
git status --short
git diff --check
git diff --stat

# 確認無誤後，才建立交接基準（不包含被 .gitignore 排除的訓練資料）
git add docs index.html public reports spike src tools vite.config.ts
git commit -m "Complete modular UI, parallel analysis, and AI workflow updates"
git push origin main

# 目標電腦：先確認複製過來的工作樹沒有被覆蓋，再取得提交
git status --short
git fetch origin
git log --oneline --decorate -5
```

若目標端已存在相同的未提交檔案，請先以 `git diff` 比對內容，再決定以來源提交或本機複製版本為準；不可直接強制重設。

## 專案定位

WiPitch 是在瀏覽器中執行的單音人聲修音工具。使用者載入音檔後，程式分析音高、以曲線表示編輯結果、由 Rubber Band WASM 算繪修正後音訊，並可匯出 WAV。原始音檔不會被程式內部改寫。

主要能力：

- SwiftF0 音高分析：分析階段降為 16 kHz 單聲道、每 16 ms 一格；原始音訊仍保留其解碼後的取樣率，供實際算繪與 WAV 匯出使用。
- 手動編輯：音高、抖動、音量、Formant、畫筆、選取範圍、時間伸縮錨點、復原／重做。
- 調性與檢測：左側鋼琴鍵、Key 篩選、獨立檢測範圍、相對最近調內音的偏差顏色。
- AI 修音：傳統規則、依本機訓練資料建立的小型內建模型，或外部 Ollama／OpenAI 相容 API。
- AI 審核：AI 修改區顯示黃框，可勾選接受／取消、在框內人工上下調整，並提供區域 Formant 控制。
- 訓練資料：記錄手動修音、取消 AI 修正與 AI 後人工調整，保存前後 MP3、精簡音高圖和結構化 JSON／CSV。
- 大型檔案：音高分析與 AI 候選處理共用低音壓切段策略，以 Worker 平行執行。

## 架構總覽

```text
index.html + src/main.ts                         應用組裝與跨模組協調
│
├─ src/application/                              工作流程與工作狀態
│  ├─ work-state.ts                              唯一的忙碌／鎖定／進度來源
│  └─ ai-correction-flow.ts                      AI 修音流程：整理→請求→算繪→提交／取消
│
├─ src/model/                                    純資料與演算法語意
│  ├─ curves.ts / edits.ts / history.ts          三條編輯曲線與復原
│  ├─ timemap.ts                                 輸出時間 ↔ 原始時間伸縮對應
│  ├─ keys.ts / pitch-deviation.ts               調性、最近調內音與 cents 偏差
│  ├─ ai-regions.ts / auto-pitch.ts              黃框區域與傳統修音候選
│  └─ project.ts                                 專案存檔格式（含原始音檔絕對路徑）
│
├─ src/analysis/                                 分析與 AI 決策
│  ├─ swiftf0*.ts                                ONNX SwiftF0、WebGPU + WASM fallback Worker
│  ├─ pitch-parallel.ts / pitch-segments.ts      平行音高分析與無聲切段
│  ├─ audio-segments.ts                          AI／音高共用的 RMS 分段規劃
│  ├─ ai-correction.ts / ai-candidate-*          固定規則、外部 API、候選平行處理
│  └─ builtin-ai.ts                              本機小型加權近鄰模型
│
├─ src/engine/                                   音訊播放與實際算繪
│  ├─ player.ts                                  Web Audio 播放
│  ├─ renderer.ts / render.worker.ts             Rubber Band WASM 修音算繪
│  └─ rbcore.ts                                  Rubber Band 參數、延遲補償與 Formant 語意
│
├─ src/view/                                     Canvas 顯示（不是控制面板）
│  ├─ pianoroll.ts / waveform.ts                 音高、波形、參考軌
│  └─ viewstate.ts / rangebar.ts                 時間、縱軸視野與捲軸
│
├─ src/ui/                                       DOM 面板；只呈現狀態與送出意圖
│  ├─ header-panel.ts / ai-toolbar.ts            頂端與 AI 控制列
│  ├─ editor-options.ts / tool-lane-controls.ts  Key、畫筆、工具與 lane
│  ├─ edit-inspector.ts / global-controls.ts     選取參數與底部控制
│  ├─ detection-*.ts / ai-regions.ts             檢測範圍與 AI 黃框
│  ├─ transport.ts / reference-track-controls.ts 播放與參考音軌
│  ├─ workspace-layout.ts                        完整／專注／高可讀性三種介面
│  └─ training-library.ts                        訓練資料庫檢視
│
├─ src/training/recorder.ts                      前端訓練紀錄封裝
├─ tools/training-server.mjs                     Vite 開發期本機儲存 API
└─ vite.config.ts                                建置時間、Vite 設定、本機訓練服務掛載
```

### 關鍵資料流

```text
原始音檔
  ├─ decode.ts → 原始取樣率 Samples → Renderer / WAV 匯出
  └─ 16 kHz mono 分析副本 → SwiftF0 Worker → PitchTrack → 曲線／Piano Roll

使用者或 AI 修改 → Curves + TimeMap → Renderer Worker → rendered Samples → Player / 匯出 WAV

手動或 AI 回饋修改 → recorder.ts → /__training → AI訓練暫存/ 或 AI訓練/
```

## 目錄、依賴與本機資料

| 路徑 | 是否在 Git | 用途／交接注意事項 |
|---|---|---|
| `src/`、`index.html`、`public/`、`tools/`、`docs/` | 是（目前有未提交修改） | 程式碼、靜態模型、UI 與文件 |
| `vendor/` | 是 | 離線 npm 相依套件封裝；`npm ci` 需要保留 |
| `package-lock.json` | 是 | 依賴鎖定檔；目標端使用 `npm ci` |
| `node_modules/` | 否 | 可刪除重建，不必跨電腦搬移 |
| `dist/` | 否 | 建置產物；以 `npm run build` 重建 |
| `AI訓練/` | 否 | 個人訓練資料，來源端約 1.1 GB；已人工複製，務必保留目錄名稱與結構 |
| `AI訓練暫存/` | 否 | 尚未匯出 WAV 的暫存資料；目前為空，通常不需交接 |
| `Vocal.wav`、Downloads 的 `test.wav` | 否 | 測試音檔，不得假定目標端存在；必要時另行安全複製 |

訓練資料僅能由以 `npm run dev` 或「啟動 WiPitch.command」啟動的本機 Vite 服務讀寫。純靜態 `dist/`、`file://` 或外部靜態主機沒有 `/__training` 本機 API，因此不能記錄或管理訓練資料，也不能使用本機原始路徑開檔流程。

## 在目標電腦啟動

建議 Node.js 22（目前核心測試以 Node 22.23.2 驗證；README 的最低要求為 Node 18）。在專案根目錄執行：

```sh
npm ci
npm run check
npm run verify:core
npm run build
npm run dev
```

macOS 可以雙擊 `啟動WiPitch.command`。它固定以 `127.0.0.1:5180` 啟動、檢查既有服務後開啟瀏覽器，且會保持本機訓練服務可用。

開發伺服器可用網址：`http://127.0.0.1:5180/`。一般 `npm run dev` 綁定 `0.0.0.0`；若只應在本機使用，採用啟動 command 或自行調整 host。

外部 AI 的服務網址、模型名稱與模式會儲存在瀏覽器 localStorage；API Key 只放在當前分頁記憶體。因此另一台電腦需自行重新輸入 API Key，並重新設定 Ollama 或 OpenAI 相容 API 的 CORS／網址。程式預設的 Ollama 位址是 `http://localhost:11434`。

## 驗證基準

本次交接前已完成：

- `npm run check`：通過。
- `npm run build`：通過。
- `npm run verify:core`：19 組核心測試全數通過。
- `spike/ui-display-modules-browser-test.mjs`：通過，包含工作區偏好保存與 UI 模組不直接依賴音訊引擎的驗證。
- 真實瀏覽器檢視：三種工作區可切換；專注編輯會隱藏參考音軌與訓練資料庫入口；高可讀性把琴鍵欄設為 92px、根字級設為 15px。

完整測試說明、需要的額外素材、開發診斷與人工大型檔案流程見 [`TESTING.md`](TESTING.md)。`npm run verify` 仍需要本機瀏覽器與根目錄的 `Vocal.wav`，不應在沒有素材時當成日常交接驗收。

## 已完成工作

以下功能已實作於目前目錄（其中多數仍待提交到 Git）：

1. 應用層工作狀態集中至 `WorkState`，進度條改為純呈現。
2. AI 按鈕流程抽成 `AICorrectionFlow`，包含鎖定、候選整理、服務請求、曲線套用、算繪、復原與播放更新。
3. AI 修音有傳統規則、內建小型模型、外部 Ollama／OpenAI 相容 API 三種模式。
4. AI 黃框已支援接受／取消、區內人工音高調整、紅色人工調整記號與區域 Formant 控制。
5. 訓練資料的手動、拒絕 AI、AI 後人工調整分類與匯出搬移流程已建立；單次修改範圍超過 5 秒不保存。
6. SwiftF0 已改為 WebGPU 優先、WASM fallback，並支援以低音壓一秒中點切分的平行音高分析。
7. AI 候選分析採相同切段策略；外部服務請求另有限制併發量。
8. 左方鋼琴鍵可使用 Tone.js 音色試聽；Key 篩選與偏差色彩已串接。
9. 顯示面板已拆為 `src/ui/` 模組，邊界文件見 [`UI_MODULES.md`](UI_MODULES.md)。
10. 介面已提供「完整工作站／專注編輯／高可讀性」工作區選擇，偏好保存在瀏覽器。
11. 內建本機說明頁 `public/help.html`、UI 設計提案 `reports/wipitch-ui-design-report.html`、macOS 啟動 command。

## 尚未完成／應由下一位處理的項目

1. **Git 提交與推送**：最優先。所有目前未提交的程式、文件、測試與 UI 模組，尚未同步至 GitHub。
2. **UI 規劃第二階段**：目前只有三個固定工作區；尚未實作報告中的流程導引工作區、完整 AI 審核桌清單／A-B 比較，以及使用者可拖曳排序的自由 Dock。
3. **實際歌曲品質驗收**：核心測試不取代真實人聲的聆聽。應以使用者有權使用的音檔重新評估 AI 起音修正、長音微調、Formant 與切段接縫。
4. **跨硬體效能基準**：平行分段策略已測試與記錄，但仍應在目標電腦以大型檔重跑 `spike/pitch-parallel-benchmark.mjs`，確認 CPU／GPU 最佳分段數。
5. **外部雲端 API 實測**：模擬與本機 Ollama 流程已有測試；未以真實第三方雲端 API Key 作端對端連線驗證。
6. **訓練資料審核**：`AI訓練/` 已搬移但不會自動保證品質。可透過「訓練資料庫管理」檢查 excluded／approved 標記與資料對應，再讓內建模型重新掃描。

## 修改時的強制邊界

- 不要讓 UI View 直接存取 `Curves`、`Renderer`、`Player`、`History` 或 `WorkState`；由 `main.ts`／`application/` 做協調。
- 不要用 16 kHz 的 SwiftF0 分析資料當作音訊輸出來源；它只提供音高判斷，算繪必須使用解碼後原始音訊取樣率。
- 不要將 `AI訓練/`、`AI訓練暫存/`、`Vocal.wav`、API Key 或使用者音檔加入 Git。
- 不要在未比對資料的情況下執行破壞性 Git 指令，尤其是 `git reset --hard`、`git checkout -- .`。
- 改動音訊／算繪引擎時，除了核心測試，還要跑對應真值測試與實際聆聽；改動 UI 面板時，擴充 `spike/ui-display-modules-browser-test.mjs`。

## 優先閱讀順序

1. [`README.md`](../README.md)：使用者功能與基本啟動。
2. [`DEVELOPMENT.md`](DEVELOPMENT.md)：原始音訊、曲線、Rubber Band 與延遲補償的技術原則。
3. [`WORK_STATE.md`](WORK_STATE.md)：工作鎖與進度規則。
4. [`AI_CORRECTION.md`](AI_CORRECTION.md)：三種 AI 修音模式、黃框審核與限制。
5. [`AI_TRAINING.md`](AI_TRAINING.md)：訓練資料保存、搬移與資料庫管理。
6. [`UI_MODULES.md`](UI_MODULES.md)：顯示模組責任與工作區邊界。
7. [`TESTING.md`](TESTING.md)：測試命令、素材依賴與診斷入口。
