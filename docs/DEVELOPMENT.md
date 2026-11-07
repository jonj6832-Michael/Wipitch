# 開發說明

使用方式見 [README](../README.md)，選型與實測數據見 [DESIGN.md](DESIGN.md)。

## 設計原則

**原始音訊永遠不動。** 所有編輯狀態就是三條每 16ms 一格的曲線，加上一組時間錨點。
算繪永遠是「原始音訊 + 當前曲線」，所以不管編輯幾次都不會累積劣化——
連續編輯再全部復原，會逐 sample 回到原始檔。

三條 lane 都是「加法語意 + 中性值 0」，所以一套運算就夠用：

| 功能 | 曲線運算 |
|---|---|
| 拖曳一段改音高 | `Δ[a:b] += k` |
| 壓平／放大抖動 | `Δ[t] += (α−1)·(m[t] − c[t])` |
| 音量調整 | `G[a:b] += g` |
| 調 Formant | `F[a:b] += k` |
| 畫筆 | 把一段的曲線值改寫成畫出來的形狀 |

`c[t]` 是音高的**移動中位數**中心線，而且**視窗長度跟著 α 走**：
α ≥ 1 用 200ms（放大的是抖音，不是整條旋律）；α < 1 時連續拉長到整個選取範圍，
所以 **α = 0 會把整段壓成同一個音高**，而 α = 0.5 仍然保留刻意的滑音。

音高偏移另有變化率上限（預設每秒 60 半音，`DEFAULT_PITCH_SLOPE_LIMIT`），
把原唱陡的音高變化被修平時產生的 Δ 階梯拉緩。

選取工具的編輯兩端用「邊界過渡」長度的斜坡混合（預設 100ms，`DEFAULT_RAMP_SEC`）；
畫筆固定用 20ms（`PEN_RAMP_SEC`），兩者都在 `src/model/curves.ts`。

### 五個踩過的坑

時變音高、formant 與音量有五個非做不可的細節，少一個功能就會安靜地失效
（每一個都有實測數據，詳見 [DESIGN.md](DESIGN.md)）：

1. **`PitchHighConsistency`**：用 `PitchHighQuality` 的話，4–7Hz 的音高變化會被濾掉，
   而人聲抖音正好落在那個頻段——壓平功能完全沒效果。
2. **1024 sample 的更新粒度**：Rubber Band 建議的 4096（85ms）等於把 16ms 一格的曲線
   降取樣 5.3 倍，快速變動會變成階梯狀跳動。
3. **音高自動化延遲 85ms**：輸出的音高變化比曲線早 85ms。5.5Hz 抖音的半週期是 91ms，
   不補償的話反向抵銷會變成同向疊加，壓平反而讓抖音變嚴重。
4. **Formant 的延遲是 39ms，不是 85ms**，而且 `set_formant_scale(1.0)` 不是「不動」——
   明確指定 scale 會把 `FormantPreserved` 的自動補償關掉（保留率 0.92 → 0.01，
   也就是全部變花栗鼠）。正確做法是傳 `2^((想要的位移 − Δ)/12)`。
5. **音量要乘在輸出上**：乘在 Rubber Band 的輸入上會讓音量變化晚 85ms、每 21ms 一個階梯。

`npm run spike` 可以重跑引擎比較。

測試項目、素材需求、診斷入口與建議執行順序見 [TESTING.md](TESTING.md)。

## SwiftF0 平行音高分析

大型音檔的 16kHz 單聲道分析資料會依可用 Worker 數平均切段：CPU/WASM 的主要分段數等於瀏覽器 `navigator.hardwareConcurrency` 回報的 CPU 工作槽數；WebGPU 固定最多 2 段，避免多個工作爭用同一 GPU。短檔案會以每段至少 20 秒縮減分段數，避免模型初始化成本高於平行收益。

每個理想平均切點左右最多 15 秒，以滑動 RMS 找出「連續一秒平均音壓最低」的區域，切點取該秒正中央，再對齊 SwiftF0 的 256-sample（16ms）hop。每段前後另讀 4096 samples（256ms／16 格）上下文；合併時只採用核心範圍，因此接縫不重複也不漏格。每個 Worker 只載入一次 ONNX 模型並處理一個主要分段；GPU 失敗時會終止整組 GPU 工作，使用原始 16kHz 資料重新啟動 WASM Worker 組，不混用兩種後端的局部結果。

本機 Chromium/WASM 的 360 秒合成音訊基準中，1 Worker／1 段為 16.59 秒、2 Worker／2 段為 10.79 秒、4 Worker／4 段為 9.38 秒；4 Worker／8 段在不同輪次量到 8.07～8.46 秒。合成靜音資料容易受快取、JIT 與 20 秒內部分塊排程影響，所以只能證明增加 Worker 有明顯收益，不能單靠它判定 4 段或 8 段絕對較快。保留 `spike/pitch-parallel-benchmark.mjs` 供其他設備重跑。

實際 217MB、26:18、48kHz／24-bit 單聲道 WAV 的比較：舊策略為 31 段／4 Worker，音高分析 52.30 秒；依瀏覽器回報的 10 個 CPU 工作槽改為 10 段／10 Worker 後為 34.90 秒，縮短約 33.3%。合成資料的短測試仍有快取、JIT 與分段負載差異，因此產品決策以這份大型實檔為主要依據。

## 驗收

```
npm run check           # 型別檢查
npm run build           # 型別檢查 + 打包
npm run verify          # 完整驗收（需要先 npm run dev，且根目錄有 Vocal.wav）
npm run verify:ui       # 只跑介面操作
npm run verify:flatten  # 只跑壓平抖動的數值驗證
npm run verify:formant  # 只跑音色保留的數值驗證
npm run verify:slope    # 音高變化上限與音量時間對準
npm run verify:stretch  # 錨點與 time stretch
npm run spike:formant   # 重新量 formant 的自動化延遲
```

| 測試 | 量什麼 |
|---|---|
| `tools/verify.mjs` | 聲音對不對，含「連續編輯後全部復原要逐 sample 回到原始」 |
| `tools/ui-verify.mjs` | 操作對不對：選取、畫筆、縮放捲動、跟隨播放頭 |
| `spike/flatten-truth.mjs` | 直接量算繪出來的聲音，殘餘抖音須低於 35% |
| `spike/formant-truth.mjs` | 音色保留率須高於 0.80，樂器模式須低於 0.15 |
| `spike/timemap-test.mjs`、`spike/stretch-truth.mjs` | 錨點對應與伸縮後的時間準確度 |
| `spike/slope-limit-test.mjs` | 音高變化上限：合乎限制的曲線逐位元不變、階梯拉成置中的斜坡 |
| `spike/gain-lag.mjs` | 音量變化跟曲線的時間差須在 2ms 內 |
| `spike/onset-truth.mjs` | 起音處的 f0 誤差（量測用，不是驗收門檻） |

數值驗證是刻意分開的：曲線算對了但聲音不對的 bug（坑 3、坑 4）不會有任何錯誤訊息，
只有直接量輸出才抓得到。

### 測試素材

驗收與 `spike/` 需要一個人聲乾聲放在專案根目錄，檔名 `Vocal.wav`。
它在 `.gitignore` 裡，不進版本控制（通常是有版權的錄音）——請自己準備一個。

網址參數 `?autoload=/Vocal.wav&t=45&span=6` 可以直接載入檔案並跳到指定時間與縮放。
README 的截圖由 `tools/edit-test.mjs`（`edit.png`）與 `tools/panel-test.mjs`（`flatten.png`）產生。

## 出版離線安裝包

```
npm run release   # → release/wipitch-<git 版本>.tar.gz
```

程式改完、commit 之後跑這一行，就得到可以直接給使用者的安裝包。
工作區有未 commit 的改動時會拒絕出版（避免包出去的東西跟版本號對不上）。
版本號取自 `git describe`：想要好讀的名字就先打 tag，例如
`git tag v0.1.0 && npm run release` → `wipitch-v0.1.0.tar.gz`。

## 專案檔與原始音訊

請用頁面上的「開啟音檔」選擇原始音訊。此按鈕會透過本機啟動服務取得使用者選定的絕對路徑；「存檔」會把該路徑、原始檔資訊與編輯曲線寫入 `.wipitch.json`，不會把整份音訊嵌入專案。

「讀檔」會先依專案記錄的路徑重新載入並分析原始音訊，確認取樣率與音高格數相符後，才套用曲線與其他設定。原始音訊若被搬移、改名或刪除，會顯示找不到檔案。v4 以前的舊專案沒有路徑，仍可先手動開啟對應音訊後再讀取。這項本機檔案功能必須由 `啟動WiPitch.command` 或 `npm run dev` 啟動；靜態網頁與 `file://` 無法存取絕對路徑。

流程：確認工作區乾淨 → `npm ci` → `npm run build` → 把 `dist/` 與
`tools/release/` 裡的伺服器、安裝腳本包成 tar.gz。包裡只有靜態檔和零依賴的
`serve.mjs`，所以跨 Linux / macOS 通用。安裝包本身不進版本控制。

## 顯示模組與應用層邊界

主要控制面板已拆成獨立顯示模組：`EditInspectorView` 管理選取資訊與音高、音量、共振峰參數，
`ToolLaneControlsView` 管理工具與軌道顯示，`TransportView` 管理播放控制，
`ReferenceTrackControlsView` 管理參考音軌控制。這些模組只接收畫面狀態並送出使用者操作事件。

`main.ts` 的應用層仍統一持有 `Curves`、`History`、`Renderer`、`Player` 與 `WorkState`，
負責驗證操作、更新資料、建立復原紀錄及安排算繪。顯示模組不直接修改音訊或編輯資料。

## 依賴

開發伺服器會在啟動時預先最佳化 `rubberband-wasm` 與 `onnxruntime-web/webgpu`。兩者原本只在第一次開啟音檔時由 Worker 動態載入，Vite 會因此輸出 `optimized dependencies changed. reloading` 並重載整頁，使使用者誤以為程式重新啟動。`vite.config.ts` 的 `optimizeDeps.include` 必須保留；冷啟動測試應先以 `npm run dev -- --force` 重建快取，再載入音檔並確認沒有第二次 reload。

| 套件 | 版本 | 用途 | 會進安裝包？ |
|---|---|---|---|
| `rubberband-wasm` | 3.3.0 | 變調／時間伸縮算繪（Rubber Band Library，GPL） | ✅ |
| `onnxruntime-web` | 1.29.0 | 在瀏覽器裡跑音高偵測模型 | ✅ |
| SwiftF0 模型 | `public/models/swift_f0.onnx` | 音高偵測模型本體（直接放在 repo） | ✅ |
| `vite` | 8.3.0 | 開發伺服器與打包 | ❌ |
| `typescript` | 7.0.2 | 型別檢查 | ❌ |
| `puppeteer` | 25.10.0 | `tools/` 裡的自動化驗收腳本 | ❌ |
| `signalsmith-stretch` | 1.3.2 | 只在 `spike/stretch-node.mjs` 拿來跟 Rubber Band 比較 | ❌ |

### vendor/：執行期依賴自給自足

`rubberband-wasm`、`onnxruntime-web` 以及它們底下的所有子套件，原始 tgz 都放在 `vendor/`
並進版本控制；`package.json` 用 `file:vendor/...` 與 `overrides` 指向它們。
就算 npm 上的套件消失，repo 仍然能 build 出一模一樣的程式。

開發工具（vite、typescript、puppeteer）沒有 vendor——它們含各平台的原生執行檔，
而且只影響開發，不影響使用者聽到的聲音。

依賴版本全部鎖死：`package.json` 寫精確版本、`.npmrc` 設 `save-exact`，
出版一律 `npm ci` 照 `package-lock.json` 裝。要升級時刻意做：

```
npm pack rubberband-wasm@<新版本> --pack-destination vendor   # 子套件有變的話也一起 pack
# 把 package.json 裡對應的 file:vendor/... 改成新檔名，刪掉舊 tgz
npm install
npm ls --omit=dev --all   # 確認沒有新冒出、還沒 vendor 的子套件
npm run verify            # 聲音與介面驗收都過了才 commit
```

## 發佈到公開 repo

維護者的資料夾有兩個 remote：`origin`（私有，完整開發歷史，平常 push `main`）與
`public`（公開）。公開版在獨立的 `public` 分支上，跟 `main` 沒有共同歷史。要更新公開版時：

```
sh tools/publish.sh "這次更新的說明"
```

不要把 `main` merge／rebase 進 `public`，也不要把 `main` 推到 `public` remote。
