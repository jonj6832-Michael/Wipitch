# 載入流程基準紀錄

2026-10-01，在本機 Codex 內建瀏覽器、Vite 開發模式進行一次驗證。
素材為使用者 Downloads/test.wav 的暫存副本 load-check.wav；不將音訊加入版本控制。
原檔為單聲道、48 kHz、24-bit PCM WAV，107,656,192 個取樣，長度 2242.837333 秒。

這是加入載入計時、成功後釋放分析暫存、阻擋重複載入之後的單次紀錄。
沒有修改前對照、沒有清除瀏覽器快取，也沒有 CPU 模式對照，因此不能用來宣稱加速倍數。
計時從 load(file) 進入開始；不含檔案選擇器等待或開發用 autoload 的 fetch。
階段耗時包含等待與 Worker 訊息往返，不等於純模型 kernel 執行時間。

| 階段 | 秒 |
| --- | ---: |
| 讀取音檔 | 0.093 |
| 解碼音訊 | 0.375 |
| 複製聲道資料 | 0.051 |
| 準備分析音訊（16 kHz 重取樣） | 0.407 |
| 建立波形 | 0.116 |
| 初始化編輯引擎 | 0.212 |
| 初始化播放器 | 0.052 |
| 啟動分析 Worker 與傳輸音訊 | 0.183 |
| 載入音高模型（GPU 優先） | 0.349 |
| 分析音高（WebGPU + WASM） | 8.744 |
| 準備編輯曲線 | 0.034 |
| 總計（介面顯示，四捨五入） | 10.62 |

成功後解除來源所持有的 136.9 MiB 分析暫存引用；不是瀏覽器記憶體峰值量測，也不保證立即回收。
瀏覽器未回報 console error，主音檔選擇在處理期間停用、完成後恢復。

可重跑的邏輯驗證：

```sh
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/load-lifecycle-test.mjs
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/compute-mode-test.mjs
npm run build
```
