BlurredWindowBackground 模糊窗口背景
==============================

簡介
--

這是一個適用於 NW.js 和 Electron 的窗口背景靜態模糊<sup>[\[1\]](#static-blur)</sup>類，它可以簡單地創建一個靜態模糊的窗口背景，就像 Windows 11 一樣，或者說它被稱為亞克力 (Acrylic) 或是毛玻璃效果。

你可以通過簡單的引入和一行代碼為當前窗口添加一個具有靜態模糊的背景。背景會同時處理圓角和陰影，因此你只需要提供一個完全透明的窗口（你需要對應 Electron 和/或 NW.js 也設定透明視窗）。腳本現在包含了**元數據持久化**以記錄上次使用的桌布和螢幕尺寸，實現**惰性圖片生成**，僅在必要時更新模糊圖片，從而顯著**優化了資源消耗和啟動速度**。同時，日誌系統也進行了優化，提供了更清晰的調試資訊。

    html,
    body {
        background: transparent;
    }

BlurredWindowBackground 提供的背景具有以下特點：

*   **圓角**：默認 15px。你當然可以自定義這個圓角來匹配你的設計風格。最大化時將會取消圓角效果。
    
*   **預留的邊距**：距離真實窗口邊框有 5px 的間距，這是因為必須保留出陰影顯示的空間，如果沒有間距，陰影將會消失。最大化時將會取消邊距。
    
*   **窗口陰影**：處理一個 5px 的陰影，這是硬編碼，目前不會開放參數去修改。最大化時將會取消陰影效果。
    
*   **模糊背景**：通過獲取當前桌布預生成模糊的背景圖片，不是即時計算模糊，因此具有較好的性能。當桌布發生變化或螢幕解析度變化時，將會自動重新捕獲並生成新的模糊背景。
    
    *   建議根據模糊程度、遮罩透明度調整 `options.imageProcessingZipRate`，當圖片被縮放到較小尺寸，如果模糊程度較低和/或遮罩透明度過高，可能會出現低分辨率的色塊等現象。
        
*   **動態遮罩**：添加了一個動態遮罩，根據窗口背景桌布的亮度，動態調整遮罩的透明度。淺色和深色的閾值，遮罩的顏色，以及透明度的範圍都可以通過參數指定。
    
    *   當更換到深色遮罩時，記得將 `dynamicOverlay.lightMode` 設為 `'system'` (如果希望跟隨系統) 或 `false` (如果希望強制深色)。
        
    *   動態遮罩並不會動態更改文字等內容的默認顏色，當你更改為深色的遮罩時，不僅需要更改 `lightMode`，同時也需要自行更改內容的顏色來避免「低可讀性」的設計失誤。
        
*   **主題適配**：動態遮罩的顏色可以根據系統的淺色/深色主題自動切換 (需將 `dynamicOverlay.lightMode` 設為 `'system'`)，也可以強制指定淺色或深色。
    

檔案說明
----

*   `BlurredWindowBackground.js`: 主要腳本，實現模糊背景的核心邏輯。
    
*   `ImageBlurProcessor.js`: 圖片模糊處理類，負責實際的圖像模糊運算。
    
*   `bwb-electron-ipc-setup.js`: (僅 Electron) 用於在主進程設置必要的 IPC 通道和窗口事件監聽，簡化 Electron 環境下的集成。
    
*   `wallpaper.js`: 跨平台獲取當前桌面背景圖片路徑的輔助腳本。
    

如何使用
----

### Electron **`推薦`**

1.  將 `BlurredWindowBackground.js`、`ImageBlurProcessor.js`、`wallpaper.js` 放在渲染進程可訪問的同一目錄下（例如 `src` 或 `assets`）。`bwb-electron-ipc-setup.js` 應放在主進程可訪問的目錄。
    
2.  在你的主進程腳本中引入 `bwb-electron-ipc-setup.js` 並在創建 `BrowserWindow` 實例後調用 `setupBlurredWindowBackgroundIPC`：
    
**`僅為示例，非完整的入口檔案，請根據自己的項目完善代碼。`**
        
        // main.js (Electron 主進程) 
        // ...其它代碼
        const { setupBlurredWindowBackgroundIPC } = require('./path/to/bwb-electron-ipc-setup.js'); // 根據你的文件結構調整路徑
        
        let mainWindow;
        
        function createWindow() {
            mainWindow = new BrowserWindow({
                width: 800,
                height: 600,
                transparent: true, // <-- 關鍵：窗口需要透明才能正確顯示圓角和窗口陰影
                frame: false,      // <-- 關鍵：通常與透明窗口一起使用，移除原生邊框
                webPreferences: {
                    nodeIntegration: true,   // 允許在渲染進程中使用 Node.js API
                    contextIsolation: false, // 為了簡化示例；生產環境建議設為 true 並使用 preload 腳本
                    // preload: path.join(__dirname, 'preload.js') // 更安全的方式
                }
            });
        
            mainWindow.loadFile('src/index.html'); // 加載你的 HTML 文件
        
            // ------------ BWB IPC 設置 (核心指令) -----------------
            setupBlurredWindowBackgroundIPC(ipcMain, mainWindow); // 或 () => mainWindow
            // ----------------------------------------------------
        }
        
        app.whenReady().then(createWindow);
        
        // ...其它代碼
        
        
        
    
3.  在你的 HTML 文件的渲染進程腳本中，以 CommonJS 的方式引入 `BlurredWindowBackground.js`：
    
        // renderer.js (Electron 渲染進程)
        // 假設你的頁面腳本和 BWB 腳本在同一目錄或可通過相對路徑訪問。
        const BlurredWindowBackground = require('./BlurredWindowBackground.js'); // 調整路徑
        
        
        
    
4.  在你頁面的腳本中使用以下代碼調用：
    
        // renderer.js
        document.addEventListener('DOMContentLoaded', () => {
            const blurInstance = new BlurredWindowBackground({
                // 在此處傳入你的自訂選項，例如：
                // borderRadius: 20,
                // blurRadius: 50,
                // dynamicOverlay: {
                //     lightMode: 'system', // 跟隨系統主題
                //     darkColorRGB: [20, 20, 20],
                //     maxAlpha: 0.6
                // }
            });
        
            // 如果需要稍後銷毀實例（例如，在組件卸載時）
            // window.addEventListener('beforeunload', () => {
            //     if (blurInstance) {
            //         blurInstance.destroy();
            //     }
            // });
        });
        
        
        
    
5.  確保你的 HTML `<body>` 背景是透明的，並添加一個用於承載實際內容的浮動容器，例如：
    
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="UTF-8">
            <title>模糊窗口應用</title>
            <link rel="stylesheet" href="style.css">
        </head>
        <body>
            <div id="app-container">
                <div id="custom-titlebar">
                    <span>我的應用</span>
                    <button id="close-btn">X</button>
                </div>
                <p>這是一些示例內容。</p>
            </div>
            <script src="renderer.js"></script>
        </body>
        </html>
        ```css
        /* style.css */
        html, body {
            background: transparent; /* 關鍵：使 HTML 和 body 背景透明 */
            margin: 0;
            padding: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden; /* 防止滾動條影響佈局 */
            color: #333; /* 示例文字顏色 */
        }
        
        #app-container {
            /* 內容容器應在模糊背景之上 */
            position: relative; /* 或 absolute, fixed 取決於你的佈局需求 */
            z-index: 1; /* 高於 BlurredWindowBackground 的 z-index (默認為 -1) */
            padding: 20px; /* 示例內邊距 */
            height: calc(100vh - 40px); /* 示例，考慮到內邊距 */
            overflow-y: auto; /* 如果內容過多，允許滾動 */
        }
        
        #custom-titlebar {
            height: 30px;
            background-color: rgba(0,0,0,0.1); /* 示例標題欄背景 */
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 0 10px;
            -webkit-app-region: drag; /* 使標題欄可拖動窗口 */
        }
        
        #custom-titlebar button {
            -webkit-app-region: no-drag; /* 按鈕不可拖動 */
        }
        
        
        
    

### NW.js

> **注意**：NW.js 在 Linux 上可能出現圖形問題，例如透明窗口異常、拖影等。根據原始文檔，0.64.1 版本可能較為穩定。較新版本引入的 nw2 可能導致這些圖形問題，這並非此庫的問題。

1.  將 `BlurredWindowBackground.js`、`ImageBlurProcessor.js`、`wallpaper.js` 放在你的項目中，確保它們在 HTML 文件中可以通過相對路徑被 `require`。
    
2.  在你的 HTML 文件的腳本中以 CommonJS 的方式引入 `BlurredWindowBackground.js`：
    
        // 假設你的頁面腳本和 BWB 腳本在同一目錄。
        const BlurredWindowBackground = require('./BlurredWindowBackground.js'); // 調整路徑
        
        
        
    
3.  在你頁面的腳本中使用以下代碼調用：
    
        document.addEventListener('DOMContentLoaded', () => {
            const blurInstance = new BlurredWindowBackground({
                // 選項配置同上 Electron 部分
            });
        });
        
        
        
    
4.  確保 HTML `<body>` 背景透明，並設置內容容器，參考 Electron 部分的第 5 條。
    
5.  （可選）在 `package.json` (NW.js) 中將窗口設定為透明和無邊框：
    
        {
          "name": "my-nw-app",
          "main": "index.html",
          "window": {
            "transparent": true,
            "frame": false
            // ... 其他窗口設置
          }
        }
        
        
        
    

參數說明
----

*   `options` (Object): 配置選項物件。
    
    *   `borderRadius` (Number, 可選, 默認: `15`): 背景在窗口化模式下的圓角半徑（單位：像素）。
        
    *   `blurRadius` (Number, 可選, 默認: `60`): 背景圖像的模糊半徑（最終質量，單位：像素）。
        
    *   `previewBlurRadius` (Number, 可選, 默認: `90`): 預覽圖像的模糊半徑（單位：像素）。
        
    *   `previewQualityFactor` (Number, 可選, 默認: `0.1`): 預覽圖像的質量/壓縮因子（範圍：0.01-1.0）。影響預覽圖生成速度和大小。
        
    *   `titleBarHeight` (Number, 可選, 默認: `0`): 窗口頂部標題欄或自定義拖拽區域的高度（單位：像素），用於調整背景的垂直偏移。
        
    *   `checkIntervalSuccess` (Number, 可選, 默認: `1000`): 壁紙路徑檢查成功時，下一次檢查的間隔時間（單位：毫秒）。
        
    *   `checkIntervalError` (Number, 可選, 默認: `5000`): 壁紙路徑檢查失敗時，下一次重試的間隔時間（單位：毫秒）。
        
    *   `imageProcessingZipRate` (Number, 可選, 默認: `0.25`): 最終質量圖像在處理前的內部縮放比例（範圍：0.01-1.00）。較小的值可以加快模糊處理速度，但可能影響細節。
        
    *   `elementZIndex` (String, 可選, 默認: `'-1'`): 背景視口元素的 CSS `z-index` 值。建議為負值以使其位於應用程式內容之下。
        
    *   `backgroundTransitionDuration` (Number, 可選, 默認: `500`): 背景圖片切換時的 CSS 過渡動畫持續時間（單位：毫秒）。
        
    *   `dynamicOverlay` (Object, 可選): 動態遮罩層的配置。
        
        *   `enable` (Boolean, 可選, 默認: `true`): 是否啟用動態透明度遮罩層。
            
        *   `baseColorRGB` (Array, 可選, 默認: `[252, 252, 252]`): 遮罩層的基礎 RGB 顏色值數組，例如 `[255, 255, 255]` 代表白色。當 `lightMode` 設置為 `'system'` 且無法確定系統主題時，或作為 `lightColorRGB` 和 `darkColorRGB` 的備用。
            
        *   `lightColorRGB` (Array, 可選, 默認: `[252, 252, 252]`): 當判定為淺色模式時，遮罩層使用的 RGB 顏色。
            
        *   `darkColorRGB` (Array, 可選, 默認: `[30, 30, 30]`): 當判定為深色模式時，遮罩層使用的 RGB 顏色。
            
        *   `minAlpha` (Number, 可選, 默認: `0.5`): 遮罩層的最小透明度（範圍：0.0 - 1.0）。
            
        *   `maxAlpha` (Number, 可選, 默認: `0.75`): 遮罩層的最大透明度（範圍：0.0 - 1.0）。
            
        *   `brightnessThresholdLow` (Number, 可選, 默認: `70`): 背景圖像區域亮度判定的低閾值（範圍：0-255）。當亮度低於此值時，遮罩透明度趨向一端。
            
        *   `brightnessThresholdHigh` (Number, 可選, 默認: `180`): 背景圖像區域亮度判定的高閾值（範圍：0-255）。當亮度高於此值時，遮罩透明度趨向另一端。
            
        *   `lightMode` (Boolean | String, 可選, 默認: `'system'`): 遮罩顏色和透明度調整的模式。
            
            *   `true`: 強制淺色模式邏輯（背景亮則遮罩透，背景暗則遮罩實）。使用 `lightColorRGB`。
                
            *   `false`: 強制深色模式邏輯（背景亮則遮罩實，背景暗則遮罩透）。使用 `darkColorRGB`。
                
            *   `'system'`: 跟隨檢測到的系統主題。系統為淺色時同 `true`，系統為深色時同 `false`。
                

補充說明
----

### Electron VS NW.js

| **特性/方面** | **Electron** | **NW.js** | | **圖形 Bug (Linux)** | 相對較少，社區活躍，更新迭代快。 | 較舊版本 (如 0.64.1 附近) 可能在特定 Linux 環境下表現更穩定，新版需注意測試。 | | **舊版 Windows 支援** | Win7/Win8/Win8.1 需要 Electron 22 或更低版本。 | Win7/Win8/Win8.1 需要 NW.js 0.72 或更低版本。 | | **進程模型與設定** | 區分主進程和渲染進程，需額外引入 IPC 相關設定 (`bwb-electron-ipc-setup.js`)。 | 單進程模型（通常），直接在頁面腳本中引入和調用。 | | **性能 (拖動/閃爍)** | 通常性能較好，快速拖動時不易產生閃爍。 | 快速拖動時可能產生閃爍，或圖形對齊延遲，取決於 NW.js 版本和系統環境。 | | **部署與使用** | 需要建構 (Build) 過程將應用打包，或依賴用戶本地 npm 環境。 | 可將源代碼與 NW.js 運行時直接打包，部署相對簡單。 |

總體而言，Electron 因其更活躍的社區和相對較少的底層圖形問題，在複雜應用中可能是更穩妥的選擇，儘管初始設定稍多。NW.js 在簡單應用和快速原型開發上可能更便捷。`BlurredWindowBackground` 已針對 Electron 的 IPC 進行了封裝，簡化了其使用。

### 兼容性

本腳本在較新版本的 Electron (Chromium 內核) 上進行了主要測試。部分 CSS 技術（如 `inset` 屬性）依賴較新的瀏覽器內核版本（通常 Chrome 87+）。如果你的 Electron 或 NW.js 使用的 Chromium 內核版本過低，可能導致樣式顯示不正確。請確保你的目標環境支持所需的現代 Web API。

### <a id="static-blur">\[1\]</a> 靜態模糊

靜態模糊是指針對靜態桌布的模糊，而不是針對窗口背後元素的即時模糊，靜態毛玻璃並不具備真正的透明度。靜態模糊通過將模糊後的桌布圖片和桌布對齊，造成半透明的視覺錯覺，但不是真正具備透明度和即時模糊計算，因此更加節省圖形計算資源。

> 事實上目前只有 macOS 具備真正完美的動態模糊，在 Windows 11 上它的模糊其實也是靜態模糊。而在 Linux 上，Gnome 本身沒有模糊效果，KDE 的內建模糊和 Gnome 的 Blur My Shell 擴展的模糊都有一個巨大的缺陷，那就是它不匹配窗口的圓角，會存在直角的模糊區域。而 NW.js 的透明窗口本身就存在嚴重 BUG（在 Linux with Gnome 上），配上 Blur My Shell 更是災難！

> **為什麼不做動態模糊？** 因為動態模糊是一個和窗口合成器深度相關的功能，它必須在窗口合成器中實現，因為只有在合成器中獲取的才是分層的，之後合成器輸出的是合併後的圖像，窗口自身無法把自己分離出來，自然無法獲取到其背後的內容，也就無法實現模糊計算了。另一方面，JavaScript 的計算效率較低，要達到 16.67ms（60fps 的幀間隔）計算一張圖片是不可能做到的。

> **靜態模糊和偽模糊的區別** 靜態模糊依然是基於內容的模糊，它基於真實的當前桌布，雖然不具備真正的透明度和即時模糊，但依然具有互動和高級感。而偽模糊是通過一個 **預設的** 高程度模糊而產生的固定背景，經常被使用的就是彩虹圖，這種背景由於採用預設的底圖，和桌面的色調、輪廓等無法匹配，會有一種想要模仿毛玻璃但又做不到，用一個假背景來湊合的廉價感。