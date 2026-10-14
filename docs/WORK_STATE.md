# 應用層工作狀態

`src/application/work-state.ts` 的 `WorkState` 是編輯工作忙碌狀態與進度的共同來源，不依賴 DOM。主程式不再維護 `busy`、`aiWorking` 或獨立的 `LoadGuard`。

| 工作 | 啟動條件 | 執行時允許編輯 | 執行時允許背景精算 |
| --- | --- | --- | --- |
| 主音檔載入／音高分析、專案載入、參考音軌載入、AI 修正 | 沒有其他工作 | 否 | 否 |
| 局部算繪 | 沒有前景工作 | 否 | 否 |
| 背景精算（含排程等待） | 沒有阻擋精算的前景工作 | 是 | 同時只執行一個 |
| WAV 匯出 | 沒有前景工作，可以等待既有背景精算 | 否 | 是，避免等待死結 |

GPU／WASM 切換只在完全閒置時開放。背景排程的計時器、待處理範圍仍屬排程資料；排程與引擎回報會登錄到同一個工作狀態，操作權限不再讀取進度條。

## 介面

- `tryBegin(kind, label)` 檢查衝突並同步取得工作 handle；不允許啟動時回傳 `null`。
- `begin(kind, label)` 用於已獲准流程的子工作，例如專案載入中的算繪，或既有背景排程回報。
- `update()` 更新工作訊息／進度；`finish()` 結束該工作。結束後的重複或過期回報不影響其他工作。
- `subscribe()` 提供不可變快照與取消訂閱函式。前景進度優先，前景結束後顯示仍在執行的背景工作。
- 各流程以 `finally` 確保結束；`finish()` 可重複呼叫而不覆蓋已保存的完成／錯誤訊息。

`ProgressView` 只有 `render()`：顯示文字、百分比、錯誤樣式和 `aria-busy` 閃爍標記。它沒有任務列表、`begin()`、`isBusy` 或忙碌狀態回呼，移除進度條不會改變應用層的鎖定規則。

## 驗證

```sh
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/work-state-test.mjs
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/ai-correction-flow-test.mjs
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/compute-mode-test.mjs
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/load-lifecycle-test.mjs
npm run build
```

測試涵蓋衝突工作拒絕、重疊工作不提早解鎖、背景／匯出共存、完成後過期回報、取消、失敗重試、GPU／WASM 控制與進度條純呈現。載入測試替換 Worker，並驗證真正 `Renderer` 的背景失敗清理；不是完整瀏覽器端到端驗證。

## 2026-10-04 大型檔案瀏覽器驗證

使用使用者指定的 `/Users/michael/Downloads/test.wav`：262,029,418 bytes（約 249.89 MiB）、48 kHz、24-bit、單聲道、30:19.591。檔案未加入專案或上傳外部服務。

- WebGPU + WASM 載入與分析總計 23.76 秒；讀取 0.350 秒、解碼 0.770 秒、音高分析 20.729 秒；解除分析暫存引用 111.1 MiB。此為單次程式內計時，不含檔案選取工具等待，不代表平均效能或效能提升。
- 讀取／分析期間，GPU／CPU 控制與 AI 設定鎖定；進度顯示曾觀察到讀取 16%、分析 37%。完成後為 100%，`aria-busy=false`，檔案選取與運算模式重新開放。實際切換 CPU 後再恢復 GPU。
- 內建調性修正（不連線）：C 大調、5/10、獨立檢測範圍 0:09.098～0:30.327；完成 9 個音符修正。算繪中介面鎖定，完成後解鎖。
- 「取消AI修改」是獨立算繪工作：還原 AI 執行前的完整曲線後清除黃色審核框，並保留更早的手動編輯歷史。完成後進度 `aria-busy=false`、運算模式與檔案選取恢復可用。
- 本次驗證的是工作流程與 UI 狀態，沒有驗證此錄音的真實調性、修音聽感、外部模型連線、匯出內容或逐取樣的復原一致性。
