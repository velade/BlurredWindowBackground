# BlurredWindowBackground 模糊窗口背景
## 簡介

這是一個適用於nwjs和electron的窗口背景靜態模糊<sup>[\[1\]](#static-blur)</sup>類，它可以簡單的創建一個靜態模糊的窗口背景，就像Windows 11一樣。或者說它被稱為亞克力或是毛玻璃。

你可以通過簡單的引入和一行代碼為當前窗口添加一個具有靜態模糊的背景，背景會同時處理圓角和陰影，因此你只需要提供一個完全透明的窗口（你需要對應Electron和/或NWJS也設定透明視窗）
```CSS
html,
body {
    background: transparent;
}
```

<a id="static-blur">[1]</a> 靜態模糊：靜態模糊是指針對靜態桌布的模糊，而不是針對窗口背後元素的即時模糊，靜態毛玻璃並不具備真正的透明度。靜態模糊通過將模糊後的桌布圖片和桌布對齊，造成半透明的視覺錯覺，但不是真正具備透明度和即時模糊計算，因此更加節省圖形計算資源。


> 事實上目前只有MacOs具備真正完美的動態模糊，在Windows 11上它的模糊其實也是靜態模糊。而在Linux上，Gnome本身沒有模糊效果，KDE的內建模糊和Gnome的Blur My Shell擴展的模糊都有一個巨大的缺陷，那就是它不匹配窗口的圓角，會存在直角的模糊區域。而nwjs的透明窗口本身就存在嚴重BUG（在Linux with gnome上），配上Blur My Shell更是災難！


> **為什麼不做動態模糊？** 因為動態模糊是一個和窗口合成器深度相關的功能，它必須在窗口合成器中實現，因為只有在合成器中獲取的才是分層的，之後合成器輸出的是合併後的圖像，窗口自身無法把自己分離出來，自然無法獲取到其背後的內容，也就無法實現模糊計算了。另一方面，javascript的計算效率較低，要達到16.67ms（60fps的幀間隔）計算一張圖片是不可能做到的。


BlurredWindowBackground 提供的背景具有以下特點：

- **圓角**：默認15px。你當然可以自定義這個圓角來匹配你的設計風格。最大化時將會取消圓角效果。
- **預留的邊距**：距離真實窗口邊框有5px的間距，這是因為必須保留出陰影顯示的空間，如果沒有間距，陰影將會消失。最大化時將會取消邊距。
- **窗口陰影**：處理一個5px的陰影，這是硬編碼，目前不會開放參數去修改。最大化時將會取消陰影效果。
- **模糊背景**：通過獲取當前桌布預生成模糊的背景圖片，不是即時計算模糊，因此具有較好的性能，當桌布發生變化時，將會自動重新捕獲並生成新的模糊背景。
    - 建議根據模糊程度、遮障透明度調整`options.imageProcessingZipRate`，當圖片被縮放到較小尺寸，如果模糊程度較低和/或遮罩透明度過高，可能會出現低分辨率的色塊等現象。
- **動態遮罩**：添加了一個動態遮障，根據窗口背景桌布的亮度，動態調整遮罩的透明度。淺色和深色的閾值，遮罩的顏色，以及透明度的範圍都可以通過參數指定。
    - 當更換到深色遮罩時，記得將lightMode設為False。
    - 動態遮罩並不會動態更改文字等內容的默認顏色，當你更改為深色的遮罩時，不僅需要更改lightMode，同時也需要自行更改內容的顏色來避免「低可讀性」的設計失誤。

## 檔案說明

- BlurredWindowBackground.js 主要腳本
- ImageBlurProcessor.js 圖片模糊的類，你可以在我的github找到它的單獨項目
- bwb-electron-ipc-setup.js 為electron配置ipc綁定的類
- wallpaper.js 獲取桌布圖片的類

## 如何使用

### Electron **`推薦`**

1. 將 `BlurredWindowBackground.js` `ImageBlurProcessor.js` `wallpaper.js` 放在同一目錄下，`bwb-electron-ipc-setup.js` 可以放在項目下任意位址

2. 在你的主腳本中引入 `bwb-electron-ipc-setup.js` 並在窗口創建後調用

```javascript
// 僅為簡化示例，請根據你的實際腳本調整
// ... 其他代碼
const { setupBlurredWindowBackgroundIPC } = require('./bwb-electron-ipc-setup.js'); // 假設文件在同級目錄

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        // ... 其他設定
        transparent: true, // <--- （可選）將窗口設定為**無邊框的透明窗口**，如果你不需要圓角，或者使用默認的窗口邊框，則可以不使用透明窗口。
        frame: false,      // <--- 移除窗口邊框和標題欄
        webPreferences: {
            nodeIntegration: true, // <--- 啟用node支援
            contextIsolation: false, // 為了簡化示例；生產環境建議使用 true 和 preload.js
            // preload: path.join(__dirname, 'preload.js') // 使用 preload 腳本更安全
        }
    });

    mainWindow.loadFile('src/index.html');

    // ------------ BWB IPC 設置 (核心指令) -----------------
    setupBlurredWindowBackgroundIPC(ipcMain, mainWindow);
    // ----------------------------------------------------

    // ... 其他代碼
}
// ... 其他代碼
```

3. 在你窗口的HTML檔案中以**CommonJS**的方式引入 `BlurredWindowBackground.js` 即：

```Javascript
// 假設你的頁面腳本和BWB腳本在同一目錄。
const BlurredWindowBackground = require('./BlurredWindowBackground.js');
```

4. 在你頁面的腳本中使用以下代碼調用：

```javascript
document.addEventListener('DOMContentLoaded', () => {
    const blurInstance = new BlurredWindowBackground();
    // 或者
    const blurInstance = new BlurredWindowBackground(options);
    // options會在下面說明
});
```
5. 添加一個浮動容器並書寫內容，例如：

```html
<body>
    <div id="contents">
        <!-- 標題列 -->
        <div id="title">模糊窗口</div>
        <!-- 關閉按鈕 -->
        <div id="close" class="btl">
            <svg viewBox="0 0 16 16" version="1.1" xmlns="http://www.w3.org/2000/svg">
                <path
                    d="m4.4647 3.9648c-0.12775 0-0.2555 0.048567-0.35339 0.14649-0.19578 0.19586-0.19578 0.51116 0 0.70703l3.1816 3.1816-3.1816 3.1816c-0.19578 0.19586-0.19578 0.51116 0 0.70703 0.19578 0.19586 0.51118 0.19586 0.70704 0l3.1816-3.1816 3.1816 3.1816c0.19578 0.19586 0.51114 0.19586 0.70704 0 0.19578-0.19586 0.19578-0.51116 0-0.70703l-3.1816-3.1816 3.1816-3.1816c0.19578-0.19586 0.19578-0.51116 0-0.70703-0.19578-0.19586-0.51118-0.19586-0.70704 0l-3.1816 3.1816-3.1816-3.1816c-0.09789-0.097928-0.22564-0.14649-0.35339-0.14649z"
                    fill="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9149"
                    style="paint-order:stroke fill markers" />
            </svg>
        </div>
        <!--其它內容-->
    </div>
</body>
```

```css
body {
    display: block;
    width: 100vw;
    height: 100vh;
    background-color: rgba(0, 0, 0, 0);
    overflow: hidden;
    padding: 0;
    margin: 0;
}

#contents {
    display: block;
    position: absolute;
    top: 5px;
    bottom: 5px;
    left: 5px;
    right: 5px;
    z-index: 2;
    overflow: auto;
    border-radius: 15px;
}

#title {
    display: block;
    width: 100%;
    height: 35px;
    line-height: 35px;
    text-align: center;
    font-weight: bold;
    margin-bottom: 15px;
    -webkit-app-region: drag;
}

#close {
    display: block;
    position: fixed;
    top: 10px;
    width: 40px;
    height: 20px;
    -webkit-app-region: no-drag;
    border-radius: 999px;
    background-color: #E74C3C;
    color: #fcfcfc;
    z-index: 99999999;
}

#close.btl {
    left: 15px;
}

#close>svg {
    display: block;
    width: 16px;
    height: 16px;
    margin: 2px auto;
    pointer-events: none;
}
```


---

### NW.JS


> 注意：NW.JS在Linux上可能出現問題，例如透明窗口異常，拖影等，經測試最後的完美版本是0.64.1，之後的更新引入的nw2會導致這些圖形問題，這不是這個庫的問題。


1. 將`BlurredWindowBackground.js` `ImageBlurProcessor.js` `wallpaper.js` 放在同一目錄下

2. 在你窗口的HTML檔案中以**CommonJS**的方式引入 `BlurredWindowBackground.js` 即：

```Javascript
// 假設你的頁面腳本和BWB腳本在同一目錄。
const BlurredWindowBackground = require('./BlurredWindowBackground.js');
```

3. 在你頁面的腳本中使用以下代碼調用：

```javascript
document.addEventListener('DOMContentLoaded', () => {
    const blurInstance = new BlurredWindowBackground();
    // 或者
    const blurInstance = new BlurredWindowBackground(options);
    // options會在下面說明
});
```

4. 同Electron部分第5條

5. （可選）將窗口設定為**無邊框的透明窗口**，如果你不需要圓角，或者使用默認的窗口邊框，則可以不使用透明窗口。

## 參數說明
- `options` (Object): 配置選項物件。
    - `borderRadius` (Number, 可選, 默認: `15`): 背景在窗口化模式下的圓角半徑（單位：像素）。
    - `blurRadius` (Number, 可選, 默認: `60`): 背景圖像的模糊半徑（最終質量，單位：像素）。
    - `previewBlurRadius` (Number, 可選, 默認: `90`): 預覽圖像的模糊半徑（單位：像素）。
    - `previewQualityFactor` (Number, 可選, 默認: `0.1`): 預覽圖像的質量/壓縮因子（範圍：0.01-1.0）。影響預覽圖生成速度和大小。
    - `titleBarHeight` (Number, 可選, 默認: `0`): 窗口頂部標題欄或自定義拖拽區域的高度（單位：像素），用於調整背景的垂直偏移。
    - `checkIntervalSuccess` (Number, 可選, 默認: `1000`): 壁紙路徑檢查成功時，下一次檢查的間隔時間（單位：毫秒）。
    - `checkIntervalError` (Number, 可選, 默認: `5000`): 壁紙路徑檢查失敗時，下一次重試的間隔時間（單位：毫秒）。
    - `imageProcessingZipRate` (Number, 可選, 默認: `0.25`): 最終質量圖像在處理前的內部縮放比例（範圍：0.01-1.00）。較小的值可以加快模糊處理速度，但可能影響細節。
    - `elementZIndex` (String, 可選, 默認: `'-1'`): 背景視口元素的 CSS `z-index` 值。建議為負值以使其位於應用程式內容之下。
    - `backgroundTransitionDuration` (Number, 可選, 默認: `500`): 背景圖片切換時的 CSS 過渡動畫持續時間（單位：毫秒）。
    - `dynamicOverlay` (Object, 可選): 動態遮罩層的配置。
        - `enable` (Boolean, 可選, 默認: `true`): 是否啟用動態透明度遮罩層。
        - `baseColorRGB` (Array<Number>, 可選, 默認: `[252, 252, 252]`): 遮罩層的基礎 RGB 顏色值數組，例如 `[255, 255, 255]` 代表白色。
        - `minAlpha` (Number, 可選, 默認: `0.5`): 遮罩層的最小透明度（範圍：0.0 - 1.0）。
        - `maxAlpha` (Number, 可選, 默認: `0.75`): 遮罩層的最大透明度（範圍：0.0 - 1.0）。
        - `brightnessThresholdLow` (Number, 可選, 默認: `70`): 背景圖像區域亮度判定的低閾值（範圍：0-255）。當亮度低於此值時，遮罩透明度趨向一端。
        - `brightnessThresholdHigh` (Number, 可選, 默認: `180`): 背景圖像區域亮度判定的高閾值（範圍：0-255）。當亮度高於此值時，遮罩透明度趨向另一端。
        - `lightMode` (Boolean, 可選, 默認: `true`): 遮罩顏色模式。如果為 `true`（淺色模式），則背景亮時遮罩更透明，背景暗時遮罩更不透明。如果為 `false`（深色模式），則相反。
    
## 補充說明

### Electron VS NW.JS
| 特性/方面         | Electron                                                                 | NW.js                                                                        |
|-------------------|--------------------------------------------------------------------------|------------------------------------------------------------------------------|
| **圖形 Bug (Linux)** | 不存在圖形 Bug，可使用更高版本。                                              | 0.64.1 之後版本在 Linux (可能部分版本或環境) 上有嚴重圖形 BUG，導致無法使用更高版本。 |
| **舊版 Windows 支援** | Win7/Win8/Win8.1 需要 Electron 22 或更低版本。                               | Win7/Win8/Win8.1 需要 NW.js 0.72 或更低版本。                                  |
| **進程模型與設定** | 區分主進程和渲染進程，需額外引入 IPC 相關設定。                                  | 無需額外設定，只需引入並調用主要庫即可。                                           |
| **性能 (拖動/閃爍)** | 性能較好，快速拖動時不會產生閃爍。                                                | 快速拖動時可能產生閃爍，或圖形對齊延遲。                                         |
| **部署與使用** | 需要建構 (Build) 才方便使用，否則用戶需自行安裝 npm 環境並使用 `npm start` 來啟動。 | 無需額外工作，可執行檔案可直接和源代碼放在一起。                                   |

推薦使用Electron，因為它雖然比較麻煩，但是沒有BUG並且具有更好的效能。不過我也將綁定IPC的額外工作打包了，實際上並不會比nwjs麻煩多少。

### 兼容性

僅在最新版本的Electron上進行了最終測試，部分技術可能不兼容過舊的版本。例如css的inset屬性在2020年的版本之後才被廣泛支援（Chrome 87開始支援），因此如果nwjs或electron使用的版本低於這個版本，則會導致背景無法顯示。
