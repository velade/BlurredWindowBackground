# BlurredWindowBackground 模糊窗口背景
## 簡介

這是一個適用於nwjs和electron的窗口背景靜態模糊\*類，它可以簡單的創建一個靜態模糊\*的窗口背景，就像Windows 11一樣。或者說它被稱為亞克力或是毛玻璃。

你可以通過簡單的引入和一行代碼為當前窗口添加一個具有靜態模糊\*的背景，背景會同時處理圓角和陰影，因此你只需要提供一個完全透明的窗口
```CSS
html,
body {
    background: transparent;
}
```
，BlurredWindowBackground 提供的背景具有以下特點：

- **圓角**：默認15px。你當然可以自定義這個圓角來匹配你的設計風格。
- **預留的邊距**：距離真實窗口邊框有5px的間距，這是因為必須保留出陰影顯示的空間，如果沒有間距，陰影將會消失。
    - 暫時沒有添加對最大化的適配，你可以通過參考以下CSS來自行處理：
    ```CSS
    vel-blurred-background-host.max {
        inset: 0 !important;
        top: 0 !important;
        left: 0 !important;
        right: 0 !important;
        bottom: 0 !important;
        border-radius: 0 !important;
    }
    ```

      這裡的原因是，經過測試nwjs在gnome48下對最大化的事件捕獲存在隨機失效的問題，因此我選擇在我找到更準確的判定窗口最大化、還原等狀態之前，不會自動處理這個問題，而是由你來處理最大化時的樣式覆蓋。
- **窗口陰影**：處理一個5px的陰影，這是硬編碼，目前不會開放參數去修改。
- **模糊背景**：通過獲取當前桌布預生成模糊的背景圖片，不是即時計算模糊，因此具有較好的性能，當桌布發生變化時，將會自動重新捕獲並生成新的模糊背景。
- **動態遮罩**：添加了一個初級的動態遮障，根據桌布的亮度，動態調整遮罩的透明度。淺色和深色的閾值，遮罩的顏色，以及透明度的範圍都可以通過參數指定。
    - 當更換到深色遮罩時，記得將lightMode設為False。
    - 動態遮罩並不會動態更改文字等內容的默認顏色，當你更改為深色的遮罩時，不僅需要更改lightMode，同時也需要自行更改內容的顏色來避免「低可讀性」的設計失誤。

＊靜態模糊：靜態模糊是指針對靜態壁紙的模糊，而不是針對窗口背後元素的即時模糊。

    事實上目前只有MacOs具備真正完美的動態模糊，在Windows 11上它的模糊其實也是靜態模糊。而在Linux上，Gnome本身沒有模糊效果，KDE的內建模糊和Gnome的Blur My Shell擴展的模糊都有一個巨大的缺陷，那就是它不匹配窗口的圓角，會存在直角的模糊區域。而nwjs的透明窗口本身就存在嚴重BUG（在Linux with gnome上），配上Blur My Shell更是災難！

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
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { setupBlurredWindowBackgroundIPC } = require('./bwb-electron-ipc-setup.js'); // 假設文件在同級目錄

let mainWindow;

app.commandLine.appendSwitch('gtk-version', '3'); //防止gnome40+報錯

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        transparent: true, // <--- 啟用透明窗口
        frame: false,      // <--- 移除窗口邊框和標題欄
        show: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false, // 為了簡化示例；生產環境建議使用 true 和 preload.js
            // preload: path.join(__dirname, 'preload.js') // 使用 preload 腳本更安全
        }
    });

    mainWindow.loadFile('src/index.html');

    // ------------ BWB IPC 設置 (一行核心指令) ------------
    setupBlurredWindowBackgroundIPC(ipcMain, mainWindow);
    // ----------------------------------------------------

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
```

3. 在你窗口的HTML檔案中以**普通腳本**的方式引入 `BlurredWindowBackground.js` 即：

```html
<script src="./BlurredWindowBackground.js"></script>
```

`注：由於某些未知原因，當使用CommonJS或ES Module方式引入時，它不會工作，必須使用傳統方式直接引入`

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
        <div id="title">模糊窗口</div>
        <div id="close" class="btl">
            <svg viewBox="0 0 16 16" version="1.1" xmlns="http://www.w3.org/2000/svg">
                <path
                    d="m4.4647 3.9648c-0.12775 0-0.2555 0.048567-0.35339 0.14649-0.19578 0.19586-0.19578 0.51116 0 0.70703l3.1816 3.1816-3.1816 3.1816c-0.19578 0.19586-0.19578 0.51116 0 0.70703 0.19578 0.19586 0.51118 0.19586 0.70704 0l3.1816-3.1816 3.1816 3.1816c0.19578 0.19586 0.51114 0.19586 0.70704 0 0.19578-0.19586 0.19578-0.51116 0-0.70703l-3.1816-3.1816 3.1816-3.1816c0.19578-0.19586 0.19578-0.51116 0-0.70703-0.19578-0.19586-0.51118-0.19586-0.70704 0l-3.1816 3.1816-3.1816-3.1816c-0.09789-0.097928-0.22564-0.14649-0.35339-0.14649z"
                    fill="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.9149"
                    style="paint-order:stroke fill markers" />
            </svg>
        </div>
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

    注意：NW.JS在Linux上可能出現問題，例如透明窗口異常，拖影等，經測試最後的完美版本是0.64.1，之後的更新引入的nw2會導致這些圖形問題，這不是這個腳本的問題。

1. 將`BlurredWindowBackground.js` `ImageBlurProcessor.js` `wallpaper.js` 放在同一目錄下

2. 在你窗口的HTML檔案中以**普通腳本**的方式引入 `BlurredWindowBackground.js` 即：

```html
<script src="./BlurredWindowBackground.js"></script>
```

`注：由於某些未知原因，當使用CommonJS或ES Module方式引入時，它不會工作，必須使用傳統方式直接引入`

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

5. 確保將窗口設定為**無邊框的透明窗口**

## 參數說明
-   `options`: `object` - 配置選項。
    -   `borderRadius`: `number` (默認：`15`) - 背景的圓角半徑。
    -   `blurRadius`: `number` (默認: `90`) - 背景圖像的模糊半徑，和CSS中的blur一致，採用px為單位，而不是sigma。
    -   `titleBarHeight`: `number` (默認: `0`) - 窗口頂部標題欄或偏移的高度，不包括系統的標準標題欄，這裡是針對你自定義的不透明標題欄的設定，**但強烈建議標題欄包含在背景範圍內，無論是否透明**。
    -   `checkIntervalSuccess`: `number` (默認: `1000`) - 桌布檢查成功時的更新間隔 (毫秒)。
    -   `checkIntervalError`: `number` (默認: `1000`) - 桌布檢查失敗時的重試間隔 (毫秒)。
    -   `tempSubDir`: `string` (默認: `'nwjs_blur_temp_v2'`) - 臨時子目錄名稱。
    -   `blurredImageName`: `string` (默認: `'blurred_wallpaper.webp'`) - 模糊圖像檔名，臨時圖像檔案的名稱，通常無須修改。
    -   `imageProcessingZipRate`: `number` (默認: `0.25`) - 圖像處理比例，範圍是0.01-1.00，越小處理速度越快，但同時畫面質量越低，建議模糊程度越高，壓縮比例越低。0.25就代表圖片將以1/4的大小參與模糊計算。
    -   `elementZIndex`: `string` (默認: `'0'`) - 背景元素的 z-index。
    -   `dynamicOverlay`: `object` - 動態遮罩配置。
        -   `enable`: `boolean` (默認: `true`) - 是否啟用動態透明度遮罩。
        -   `baseColorRGB`: `Array<number>` (默認: `[252,252,252]`) - 遮罩的基礎 RGB 顏色。
        -   `minAlpha`: `number` (默認: `0.5`) - 最小透明度 (0.0 - 1.0)。
        -   `maxAlpha`: `number` (默認: `0.75`) - 最大透明度 (0.0 - 1.0)。
        -   `brightnessThresholdLow`: `number` (默認: `70`) - 平均亮度的低閾值。
        -   `brightnessThresholdHigh`: `number` (默認: `180`) - 平均亮度的高閾值。
        -   `lightMode`: `boolean` (默認: `true`) - 遮罩色是否為淺色（即主體內容，比如文字等為深色）。
    
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