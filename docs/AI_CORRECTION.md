# AI 音高修正

1. 載入音檔，等待 SwiftF0 分析完成。
2. 選擇 Key（不能是「全部音」），在「檢測」列拖曳圈選範圍。此範圍與原有編輯選取獨立。
3. 按「AI 設定」選擇修正服務。
4. 將修正程度調整為 1～10，按「AI 修正」，完成後播放試聽。
5. 不滿意可按「回復上一步」。它與原有 Cmd/Ctrl+Z 共用復原堆疊，每次修正是一個步驟。

## 服務設定

- **內建調性修正**：不連線，以最近調內音為目標。等距或不確定的音符保留。
- **本機 Ollama**：基底網址通常為 `http://localhost:11434`，模型請填入已安裝的名稱。可先按「讀取模型／測試連線」。
- **OpenAI 相容 API**：填入服務的 API 基底網址（例如服務提供的 `/v1` 路徑）、模型與 API Key。使用 `/chat/completions` 與 JSON mode；供應商需支援這些能力。

API Key 只留在目前分頁記憶體，重新整理後須再次輸入，不寫入 localStorage、專案檔或 Git。
網址、服務類型與模型名稱會記住。切換服務類型會清空尚未提交的金鑰。
遠端服務使用 HTTPS，本機 loopback 可使用 HTTP。

直接由瀏覽器連線，服務需允許網站來源（CORS）。本機 Ollama 的來源設定請參考官方 FAQ；程式不會自動修改系統設定。
連線測試只讀模型清單；修正時每批最多傳送 24 個音符摘要，包含音高、長度及可選目標音，不包含原始 WAV、檔名、API Key 或範圍外音訊。
API Key 僅放在該服務的 Authorization 標頭。使用遠端或雲端模型時，摘要會由該服務處理。

## 修正語意與限制

- 1 級移動音符中心偏差的 10%，10 級移動 100%；保留音符原本的顫音起伏。
- 滑桿決定下一次按鈕執行的強度，不會即時反覆呼叫模型。再次執行以目前編輯後音高為基準。
- 先以 16ms 取樣、短視窗中位數與遲滯分割音符。少於約 96ms、低可信度及明顯不穩定的段落跳過。這是保守啟發式，不等同樂譜轉錄。
- AI 只能選擇音符中心附近 1.5 半音內、屬於所選 Key 的目標，或回覆不修正。格式錯誤、缺少／重複 ID、調外音或過大的移調都會拒絕整次結果。
- 修改的曲線格與內縮的淡入淡出都在檢測範圍內；有時間伸縮時會映回原始時間。音量、Formant、錨點及範圍外的曲線不變。
- 短過渡及邊界淡入淡出不會完全吸附目標音。最近調內音也不保證等於原曲旋律；AI 判斷仍需試聽。
- 修正期間暫停播放並鎖定編輯，可在模型分析階段取消。音訊算繪開始後不接受取消，完成後使用復原。
- 請求失敗或取消不套用部分批次、不產生復原步驟，也不會悄悄改用內建修正。

## 驗證

```sh
npm run build
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/ai-correction-test.mjs
node --experimental-transform-types --import ./tools/ts-resolve.mjs spike/detection-bar-test.mjs
```

本機瀏覽器實測：合成 6 秒偏高音符，C 大調、檢測範圍 1～5 秒；內建修正與本機 Ollama `qwen2.5:latest` 均完成修正與復原操作。
同一模型的 Ollama `/api/chat` 與 OpenAI 相容 `/v1/chat/completions` 都已實際通過；也確認取消後未增加復原步驟。尚未使用第三方雲端服務的真實 API Key 測試。
此為連線與流程驗證，不代表已驗證真實歌唱的音樂判斷品質。

官方介面參考：
- https://docs.ollama.com/api/chat
- https://docs.ollama.com/capabilities/structured-outputs
- https://docs.ollama.com/api/openai-compatibility
- https://docs.ollama.com/faq
