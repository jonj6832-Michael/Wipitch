# 顯示面板模組邊界

## 畫面更新協調

`src/application/display-coordinator.ts` 統一管理每幀更新：播放時間與跟隨視野、主音軌與參考音軌波形、音高曲線、AI 黃框、節拍標記及導覽元件。它透過 `readState()` 讀取最新資料，呼叫 View 呈現；演算法只產生資料，不呼叫此協調器或繪圖 API。三角形的形狀與顏色仍由波形 View 決定。

`main.ts` 負責提供狀態與操作介面、組裝並啟動協調器。協調器支援停止，熱更新時會取消動畫排程；無可用曲線時清除黃框，避免留下過期顯示。音訊分析、修音決策與使用者編輯流程不屬於此模組。

WiPitch 使用原生 TypeScript 與 DOM，不使用 UI 框架。所有固定面板都各自位於 `src/ui/`，面板只負責三件事：綁定自己的 DOM、呈現由應用層傳入的狀態、以 callback 回傳使用者意圖。

面板不得直接讀寫 `Curves`、`Renderer`、`Player`、`History` 或 `WorkState`。這些物件只由 `src/main.ts` 及 `src/application/` 協調；畫布顯示則由 `src/view/` 負責。

| 畫面區域 | 模組 | 對外意圖／呈現 |
|---|---|---|
| 頂端工作列 | `header-panel.ts` | 開啟音檔、專案讀寫、匯出、人聲／樂器模式、提示與背景算繪狀態 |
| 工作區版面 | `workspace-layout.ts` | 完整工作站／專注編輯／高可讀性切換；僅管理 CSS 工作區偏好，不影響音訊或編輯資料 |
| AI 修音列 | `ai-toolbar.ts` | 設定、修正程度、AI 修正、放棄、完成工作、取消與鎖定狀態 |
| Key／畫筆選項 | `editor-options.ts` | Key 選擇、畫筆抖音設定與 lane 單位 |
| 工具與 Lane | `tool-lane-controls.ts` | 選取／畫筆工具、lane 顯示與編輯目標 |
| 選取參數 | `edit-inspector.ts` | 音高、抖動、音量、Formant 預覽與提交 |
| 檢測工具與範圍 | `detection-controls.ts`、`detection-bar.ts` | 全段／清除、範圍拖曳與狀態文字 |
| 中央畫布 | `view/pianoroll.ts`、`view/waveform.ts`、`view/rangebar.ts` | 畫布算繪、捲動與可視範圍 |
| 參考音軌 | `reference-track-controls.ts` | 載入、靜音、音量與時間位移 |
| 底部全域控制 | `global-controls.ts` | 邊界過渡、音高變化上限、歸零與取消選取 |
| 進度與載入資訊 | `progress.ts`、`compute-mode.ts`、`load-report.ts` | 工作進度、運算模式與載入耗時 |
| 黃框與訓練資料庫 | `ai-regions.ts`、`training-library.ts` | 黃框審核、人工 Formant、訓練資料檢視 |

`main.ts` 可保留畫布指標事件、讀檔、算繪、播放、專案資料與工作狀態，因為這些是跨面板的應用協調，而非單一顯示面板的責任。

新增面板時，應先在 `src/ui/` 建立對應 View，定義 `Events` 介面與 `render`／`set…` 方法，再由 `main.ts` 注入 callback。新增或修改面板後，擴充 `spike/ui-display-modules-browser-test.mjs`，驗證它不需建立音訊引擎即可運作。

## 工作區的邊界

第一版工作區將設計報告中可不改變功能語意的三種版面做成可立即切換的偏好：

- `完整工作站`：預設，顯示完整的修音、分析、參考音軌及資料庫工具。
- `專注編輯`：維持音高畫布、AI 修正、檢測與匯出，收起參考音軌、訓練資料庫入口與輔助提示，讓中央編輯區更大。
- `高可讀性`：保留所有功能，但提高字級、控制項尺寸與琴鍵欄寬。

工作區偏好存在瀏覽器的 `localStorage`；它不是專案檔內容，也不會修改音檔、曲線或 AI 黃框。後續的流程導引、AI 審核桌與自由拖曳 Dock 需要新增流程或面板編排資料，會以獨立模組處理。
