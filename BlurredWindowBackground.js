// Node.js 核心模塊
const os = require('os');
const fs = require('fs');
const path = require('path');

// 外部依賴 - 確保這些在兩個環境中都可用
const getWallpaper = require('./wallpaper.js'); // 假設 wallpaper.js 在同級目錄
const ImageBlurProcessor = require('./ImageBlurProcessor.js'); // 假設 ImageBlurProcessor.js 在同級目錄

/**
 * @class BlurredWindowBackground
 * @description 自動創建一個帶模糊背景和動態調整透明度遮罩的窗口背景元素。
 * 兼容 NW.js 和 Electron。
 */
class BlurredWindowBackground {
    /**
     * 創建一個 BlurredWindowBackground 實例。
     * @param {object} [options={}] - 配置選項。
     * @param {number} [options.borderRadius=15] - 背景的圓角半徑。
     * @param {number} [options.blurRadius=90] - 背景圖像的模糊半徑，和CSS中的blur一致，採用px為單位，而不是sigma。
     * @param {number} [options.titleBarHeight=0] - 窗口頂部標題欄或偏移的高度，不包括系統的標準標題欄，這裡是針對你自定義的不透明標題欄的設定，但強烈建議標題欄包含在背景範圍內，無論是否透明。
     * @param {number} [options.checkIntervalSuccess=1000] - 桌布檢查成功時的更新間隔 (毫秒)。
     * @param {number} [options.checkIntervalError=1000] - 桌布檢查失敗時的重試間隔 (毫秒)。
     * @param {number} [options.imageProcessingZipRate=0.25] - 圖像處理比例，範圍是0.01-1.00，越小處理速度越快，但同時畫面質量越低，建議模糊程度越高，壓縮比例越低。0.25就代表圖片將以1/4的大小參與模糊計算。
     * @param {string} [options.elementZIndex='0'] - 背景元素的 z-index。
     * @param {object} [options.dynamicOverlay] - 動態遮罩配置。
     * @param {boolean} [options.dynamicOverlay.enable=true] - 是否啟用動態透明度遮罩。
     * @param {Array<number>} [options.dynamicOverlay.baseColorRGB=[252,252,252]] - 遮罩的基礎 RGB 顏色。
     * @param {number} [options.dynamicOverlay.minAlpha=0.5] - 最小透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.maxAlpha=0.75] - 最大透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.brightnessThresholdLow=70] - 平均亮度的低閾值。
     * @param {number} [options.dynamicOverlay.brightnessThresholdHigh=180] - 平均亮度的高閾值。
     * @param {boolean} [options.dynamicOverlay.lightMode=true] - 遮罩色是否為淺色（即主體內容，比如文字等為深色）。
     */
    constructor(options = {}) {
        this.runtimeEnv = 'unknown';
        this.electron = null;
        this.nwWin = null; // 【修改】在 constructor 早期賦值
        this.nwScreen = null; // 【修改】在 constructor 早期賦值


        if (typeof nw !== 'undefined' && nw.Window && nw.Screen) {
            this.runtimeEnv = 'nwjs';
            this.nwWin = nw.Window.get();
            this.nwScreen = nw.Screen;
            console.log("BlurredWindowBackground: 檢測到 NW.js 環境。");
        } else if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
            this.runtimeEnv = 'electron';
            try {
                this.electron = require('electron');
                if (!this.electron.ipcRenderer) {
                    throw new Error("Electron ipcRenderer not available. This script must run in a renderer process.");
                }
                console.log("BlurredWindowBackground: 檢測到 Electron 環境。");
            } catch (e) {
                console.error("BlurredWindowBackground: 無法加載 Electron 模塊。", e);
                this.runtimeEnv = 'unknown_error';
                return;
            }
        } else {
            console.error("BlurredWindowBackground: 無法識別運行時環境。");
            return;
        }

        // 【修改】獲取應用名稱並生成內部使用的臨時文件夾名和固定的圖片文件名
        let appName = 'DefaultApp';
        if (this.runtimeEnv === 'nwjs' && this.nwWin) { // 確保 nwWin 已定義
            appName = (nw.App.manifest && nw.App.manifest.name) ? nw.App.manifest.name : 'NWJSApp';
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                appName = this.electron.ipcRenderer.sendSync('bwb:get-app-name'); // 需要主進程提供此 IPC
            } catch (e) {
                console.error("BlurredWindowBackground (Electron): 通過 IPC 獲取應用名稱失敗", e);
                appName = 'ElectronApp';
            }
        }
        const sanitizedAppName = (appName || 'DefaultApp').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'DefaultSanitizedApp';
        this.internalTempSubDir = `bwb_temp_${sanitizedAppName}`; // 基於應用名的唯一臨時子目錄
        this.internalBlurredImageName = 'blurred_wallpaper.webp';  // 固定的模糊圖片文件名

        this.options = {
            // tempSubDir 和 blurredImageName 不再是可配置選項
            borderRadius: 15,
            blurRadius: 90,
            titleBarHeight: 0,
            checkIntervalSuccess: 1000,
            checkIntervalError: 1000,
            imageProcessingZipRate: 0.25,
            elementZIndex: '0',
            dynamicOverlay: {
                enable: true,
                baseColorRGB: [252, 252, 252],
                minAlpha: 0.5,
                maxAlpha: 0.75,
                brightnessThresholdLow: 70,
                brightnessThresholdHigh: 180,
                lightMode: true,
                ...(options.dynamicOverlay || {})
            },
            ...options // 用戶傳入的選項仍然可以覆蓋其他默認值
        };
        if (options.dynamicOverlay) { // 確保 dynamicOverlay 被正確深拷貝
            this.options.dynamicOverlay = { ...this.options.dynamicOverlay, ...options.dynamicOverlay };
        }


        this.appRootDir = this._getAppRootDir();
        this.currentWallpaperPath = null;
        this.wallpaperCheckTimeoutId = null;
        this.backgroundHostElement = null;
        this.overlayElement = null;
        this.currentWindowBounds = { x: 0, y: 0, width: 800, height: 600 };

        this._isMaximized = false; // 【新增】標記窗口是否最大化
        this._currentAppliedPadding = 5; // 【新增】記錄當前應用的邊距，默認為5px（非最大化狀態）
        this._forceStyleUpdate = false; // 【新增】用於強制更新樣式，特別是 NW.js 的 restore 事件

        this._initialize();
    }

    _getAppRootDir() {
        if (this.runtimeEnv === 'nwjs') {
            return path.dirname(process.execPath);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const appPath = this.electron.ipcRenderer.sendSync('bwb:get-app-path');
                if (appPath) return appPath;
            } catch (e) {
                console.error("BlurredWindowBackground (Electron): Error calling 'bwb:get-app-path' IPC:", e);
            }
            console.warn("BlurredWindowBackground (Electron): 無法通過 IPC 獲取應用程序根目錄。將回退到 '.'。");
            return '.';
        }
        return '.';
    }

    async _initialize() {
        this._createBackgroundHostElement(); // 先創建元素

        this.tempDir = this._getTemporaryDirectory(); // 使用 this.internalTempSubDir
        if (!this.tempDir) {
            console.error("BlurredWindowBackground: 錯誤：無法確定或創建臨時目錄。");
        } else {
            // 【修改】使用 this.internalBlurredImageName
            this.blurredImagePath = path.join(this.tempDir, this.internalBlurredImageName);
            console.log(`BlurredWindowBackground: 模糊背景將使用臨時目錄: ${this.tempDir}, 圖片路徑: ${this.blurredImagePath}`);

            // 【新增】啟動時嘗試加載上次緩存的背景
            if (fs.existsSync(this.blurredImagePath)) {
                console.log("BlurredWindowBackground: 正在使用先前緩存的模糊背景:", this.blurredImagePath);
                try {
                    const stats = fs.statSync(this.blurredImagePath);
                    const cssPath = `file://${this.blurredImagePath.replace(/\\/g, '/')}?t=${stats.mtime.getTime()}`;
                    this.backgroundHostElement.style.backgroundImage = `url('${cssPath}')`;
                    // 標記 currentWallpaperPath 以便 updateAndApplyBlurredWallpaper 知道預加載過
                    // 但更穩妥的方式是讓 updateAndApplyBlurredWallpaper 自己去判斷是否需要重新生成
                    // 此處僅為視覺上的快速呈現，後續 updateAndApplyBlurredWallpaper 會校驗
                } catch (statError) {
                    console.warn("BlurredWindowBackground: 獲取緩存文件狀態失敗:", statError);
                    // 如果獲取狀態失敗，則不預先加載，讓後續邏輯處理
                }
                try {
                    this._updateBackgroundPositionBasedOnCurrentPadding()
                } catch (error) {
                    console.warn("BlurredWindowBackground: 刷新位址失敗:", statError);
                    // 如果獲取狀態失敗，則不預先加載，讓後續邏輯處理
                }
            }
        }

        if (this.options.dynamicOverlay.enable) {
            this._createOverlayElement();
            const initialAlpha = this.options.dynamicOverlay.lightMode ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${initialAlpha})`);
        }

        await this._updateCurrentWindowBounds();
        this.updateAndApplyBlurredWallpaper(); // 首次更新並應用壁紙

        // 綁定窗口事件
        this._boundOnMove = (x, y) => this._onWindowMove(x, y);
        this._boundRefreshOnScreenChange = () => this._refreshWallpaperOnScreenChange();

        // 【新增】最大化/還原事件處理
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.nwWin.on('maximize', () => this._updateMaximizedStyles(true));
            this.nwWin.on('unmaximize', () => this._updateMaximizedStyles(false));
            this.nwWin.on('restore', () => {
                // NW.js 的 restore 事件可能不總是指從最大化還原，需要檢查實際狀態
                this._forceStyleUpdate = true; // 強制更新樣式
                this._updateMaximizedStyles(this.nwWin.state === 'maximized');
            });
            // 初始化時獲取一次最大化狀態
            this._isMaximized = (this.nwWin.state === 'maximized');
            this._currentAppliedPadding = this._isMaximized ? 0 : 5;
            this._forceStyleUpdate = true;
            this._updateMaximizedStyles(this._isMaximized);

            this.nwWin.on('move', this._boundOnMove);
            this.nwScreen.on('displayBoundsChanged', this._boundRefreshOnScreenChange);
            this.nwScreen.on('displayAdded', this._boundRefreshOnScreenChange);
            this.nwScreen.on('displayRemoved', this._boundRefreshOnScreenChange);

        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.on('bwb:window-maximized', () => this._updateMaximizedStyles(true));
            this.electron.ipcRenderer.on('bwb:window-unmaximized', () => this._updateMaximizedStyles(false));

            this.electron.ipcRenderer.invoke('bwb:get-window-is-maximized').then(isMaximized => {
                this._isMaximized = isMaximized;
                this._currentAppliedPadding = this._isMaximized ? 0 : 5;
                this._forceStyleUpdate = true;
                this._updateMaximizedStyles(isMaximized);
            }).catch(e => {
                console.error("BlurredWindowBackground (Electron): 獲取初始最大化狀態失敗", e);
                this._isMaximized = false; // 默認為非最大化
                this._currentAppliedPadding = 5;
                this._forceStyleUpdate = true;
                this._updateMaximizedStyles(false);
            });

            this.electron.ipcRenderer.on('bwb:window-bounds-updated', (event, newBounds) => {
                if (newBounds) {
                    this.currentWindowBounds = newBounds;
                    this._onWindowMove(newBounds.x, newBounds.y);
                    this.updateAndApplyBlurredWallpaper();
                }
            });
            // Electron 的屏幕事件監聽通常由主進程處理後通過IPC通知，如果需要的話
            // if (this.electron.screen) {
            // this.electron.screen.on('display-metrics-changed', this._boundRefreshOnScreenChange);
            // ...
            // }
        }
        console.log(`模糊窗口背景效果已初始化 (${this.runtimeEnv})。`);
    }

    _createBackgroundHostElement() {
        this.backgroundHostElement = document.createElement('div');
        this.backgroundHostElement.id = `vel-blurred-background-host`; // ID可以不唯一，如果頁面僅一個實例
        const s = this.backgroundHostElement.style;
        s.position = 'fixed';
        // s.top = '5px'; // 由 _updateMaximizedStyles 控制
        // s.left = '5px';
        // s.right = '5px';
        // s.bottom = '5px';
        // s.borderRadius = `${this.options.borderRadius}px`; // 由 _updateMaximizedStyles 控制
        // s.boxShadow = "0 0 5px rgba(0, 0, 0, .5)"; // 由 _updateMaximizedStyles 控制
        s.overflow = 'hidden';
        s.zIndex = this.options.elementZIndex;
        s.backgroundRepeat = 'no-repeat';
        s.backgroundColor = '#fcfcfc'; // 默認背景色，防止圖片未加載時透明
        // 【新增】添加CSS過渡效果
        s.transition = 'top 0.2s ease-in-out, left 0.2s ease-in-out, right 0.2s ease-in-out, bottom 0.2s ease-in-out, border-radius 0.2s ease-in-out, box-shadow 0.2s ease-in-out';
        document.body.appendChild(this.backgroundHostElement);
    }

    /**
     * @private
     * 【新增】根據窗口最大化狀態更新背景元素樣式。
     * @param {boolean} isMaximized - 窗口是否最大化。
     */
    _updateMaximizedStyles(isMaximized) {
        if (this._isMaximized === isMaximized && !this._forceStyleUpdate) {
            return; // 狀態未變且非強制更新，則不執行
        }
        this._isMaximized = isMaximized;
        this._forceStyleUpdate = false; // 重置強制更新標記

        if (!this.backgroundHostElement) return;
        const s = this.backgroundHostElement.style;
        const newPadding = isMaximized ? 0 : 5;

        if (this._currentAppliedPadding !== newPadding || isMaximized !== this._isMaximizedPreviousStateForStyle) { // 檢查 padding 或最大化狀態是否真有改變
            s.top = `${newPadding}px`;
            s.left = `${newPadding}px`;
            s.right = `${newPadding}px`;
            s.bottom = `${newPadding}px`;
            s.borderRadius = isMaximized ? '0px' : `${this.options.borderRadius}px`;
            s.boxShadow = isMaximized ? 'none' : "0 0 5px rgba(0, 0, 0, .5)";

            this._currentAppliedPadding = newPadding;
            this._isMaximizedPreviousStateForStyle = isMaximized; // 記錄本次更新時的最大化狀態

            // 當 padding 改變時，需要更新背景圖位置
            this._updateBackgroundPositionBasedOnCurrentPadding();
            console.log(`BlurredWindowBackground: 最大化狀態變為 ${isMaximized}, 樣式已更新。Padding: ${newPadding}px`);
        }
    }

    /**
     * @private
     * 【新增】基於 this._currentAppliedPadding 更新背景位置。
     */
    _updateBackgroundPositionBasedOnCurrentPadding() {
        if (this.backgroundHostElement && this.backgroundHostElement.style.backgroundImage && this.currentWindowBounds) {
            const padding = this._currentAppliedPadding;
            const newPosition = `-${this.currentWindowBounds.x + padding}px -${this.currentWindowBounds.y + this.options.titleBarHeight + padding}px`;
            if (this.backgroundHostElement.style.backgroundPosition !== newPosition) {
                this.backgroundHostElement.style.backgroundPosition = newPosition;
            }
        }
    }


    _createOverlayElement() {
        if (!this.backgroundHostElement) return;
        this.overlayElement = document.createElement('div');
        this.overlayElement.id = `vel-blurred-background-overlay`;
        const s = this.overlayElement.style;
        s.position = 'absolute'; s.top = '0'; s.left = '0'; s.width = '100%'; s.height = '100%';
        s.pointerEvents = 'none';
        this.backgroundHostElement.appendChild(this.overlayElement);
    }

    _applyOverlayColor(cssColor) {
        if (this.overlayElement) {
            if (this.overlayElement.style.backgroundColor !== cssColor) {
                this.overlayElement.style.backgroundColor = cssColor;
            }
        }
    }

    _getTemporaryDirectory() {
        let tempPathBase;
        if (this.runtimeEnv === 'nwjs') {
            tempPathBase = os.tmpdir();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const electronTempPath = this.electron.ipcRenderer.sendSync('bwb:get-path', 'temp');
                tempPathBase = electronTempPath || os.tmpdir();
            } catch (e) {
                console.error("BlurredWindowBackground (Electron): Error calling 'bwb:get-path' IPC:", e);
                tempPathBase = os.tmpdir();
            }
        } else {
            tempPathBase = os.tmpdir();
        }

        let tempPath;
        try {
            // 【修改】使用 this.internalTempSubDir
            tempPath = path.join(tempPathBase, this.internalTempSubDir);
            if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
            // 測試寫入
            const testFilePath = path.join(tempPath, `_test_write_${Date.now()}`);
            fs.writeFileSync(testFilePath, "test"); fs.unlinkSync(testFilePath);
            return tempPath;
        } catch (error) {
            console.warn(`創建臨時目錄 (${tempPath || tempPathBase}) 失敗: ${error.message}.`);
            try {
                const fallbackBase = this.appRootDir;
                if (!fallbackBase || fallbackBase === '.') {
                    console.error("BlurredWindowBackground: 後備的 appRootDir 無效，無法創建臨時文件夾。");
                    return null;
                }
                tempPath = path.join(fallbackBase, this.internalTempSubDir);
                if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
                // 再次測試寫入
                const testFilePathFallback = path.join(tempPath, `_test_write_fallback_${Date.now()}`);
                fs.writeFileSync(testFilePathFallback, "test_fallback"); fs.unlinkSync(testFilePathFallback);
                console.log("BlurredWindowBackground: 已在後備目錄創建臨時文件夾:", tempPath);
                return tempPath;
            } catch (fallbackError) {
                console.error(`創建後備臨時目錄失敗: ${fallbackError.message}`);
                return null;
            }
        }
    }

    async _updateCurrentWindowBounds() {
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.currentWindowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const bounds = await this.electron.ipcRenderer.invoke('bwb:get-window-bounds');
                if (bounds) this.currentWindowBounds = bounds;
                else console.warn("BlurredWindowBackground (Electron): IPC 'bwb:get-window-bounds' 未返回邊界。");
            } catch (e) {
                console.error("BlurredWindowBackground (Electron): Error invoking 'bwb:get-window-bounds':", e);
                try {
                    const boundsSync = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                    if (boundsSync) this.currentWindowBounds = boundsSync;
                    else console.warn("BlurredWindowBackground (Electron): IPC 'bwb:get-window-bounds-sync' 未返回邊界。");
                } catch (eSync) {
                    console.error("BlurredWindowBackground (Electron): Error calling 'bwb:get-window-bounds-sync':", eSync);
                }
            }
        }
    }

    _onWindowMove(x, y) {
        if (this.runtimeEnv === 'nwjs' && this.nwWin) { // 確保 nwWin 存在
            this.currentWindowBounds.x = x;
            this.currentWindowBounds.y = y;
            // 注意：如果窗口大小也在移動過程中改變（某些系統的拖拽到邊緣會觸發），
            // 可能需要在此處或 resize 事件中重新獲取 this.nwWin.width/height。
            // 但通常 move 事件只改變 x, y。
        }
        // Electron 的 currentWindowBounds 由 IPC 更新。
        // 【修改】調用新的基於 this._currentAppliedPadding 的位置更新方法
        if (this.backgroundHostElement && this.backgroundHostElement.style.backgroundImage) {
            this._updateBackgroundPositionBasedOnCurrentPadding();
        }
    }

    _refreshWallpaperOnScreenChange() {
        console.log(`偵測到螢幕配置變化 (${this.runtimeEnv})。`);
        this.currentWallpaperPath = null; // 強制重新獲取壁紙
        this.updateAndApplyBlurredWallpaper();
    }

    async updateAndApplyBlurredWallpaper() {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        try {
            const newPath = await getWallpaper();
            if (!newPath) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }
            await this._updateCurrentWindowBounds(); // 確保 bounds 是最新的
            const currentWinBounds = this.currentWindowBounds;
            if (!currentWinBounds || currentWinBounds.width <= 0 || currentWinBounds.height <= 0) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            // 檢查壁紙路徑是否改變，或者模糊後的圖像文件是否不存在
            // 如果 this.blurredImagePath 未定義 (tempDir 初始化失敗)，也應嘗試生成
            let shouldRegenerate = newPath !== this.currentWallpaperPath || !this.blurredImagePath || !fs.existsSync(this.blurredImagePath);

            if (shouldRegenerate && this.blurredImagePath) { // 僅在可以保存時才執行生成
                console.log(`BlurredWindowBackground: 壁紙已更改或模糊圖像不存在，準備重新生成。新路徑: ${newPath}, 當前記錄路徑: ${this.currentWallpaperPath}`);
                const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
                if (!currentScreen || !currentScreen.bounds || currentScreen.bounds.width <= 0 || currentScreen.bounds.height <= 0) {
                    this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
                }
                const targetSize = [currentScreen.bounds.width, currentScreen.bounds.height];
                const processor = new ImageBlurProcessor(newPath, targetSize, this.options.imageProcessingZipRate, true);
                const blurredBlobInstance = await processor.blurImage(this.options.blurRadius, 'image/webp');

                if (blurredBlobInstance && blurredBlobInstance.blob) {
                    try {
                        await blurredBlobInstance.toFile(this.blurredImagePath);
                        this.currentWallpaperPath = newPath; // 成功保存後才更新 currentWallpaperPath
                        console.log("BlurredWindowBackground: 模糊圖像已保存:", this.blurredImagePath);
                    } catch (saveErr) {
                        console.error("BlurredWindowBackground: 保存模糊圖像失敗:", saveErr);
                        shouldRegenerate = false; // 保存失敗，下次可能仍需嘗試，但本次不認為已“更新”
                    }

                    if (this.options.dynamicOverlay.enable && this.overlayElement) {
                        // ... (動態遮罩亮度計算邏輯，與原代碼相同)
                        try {
                            const imgSrc = fs.existsSync(this.blurredImagePath) ? this.blurredImagePath : blurredBlobInstance.blob;
                            const avgBrightness = await this._getAverageBrightnessFromBlurredImage(imgSrc);
                            if (typeof avgBrightness === 'number') {
                                const { baseColorRGB, minAlpha, maxAlpha, brightnessThresholdLow, brightnessThresholdHigh, lightMode } = this.options.dynamicOverlay;
                                let alpha;
                                if (avgBrightness <= brightnessThresholdLow) alpha = lightMode ? maxAlpha : minAlpha;
                                else if (avgBrightness >= brightnessThresholdHigh) alpha = lightMode ? minAlpha : maxAlpha;
                                else {
                                    const ratio = (avgBrightness - brightnessThresholdLow) / (brightnessThresholdHigh - brightnessThresholdLow);
                                    alpha = lightMode ? maxAlpha - (maxAlpha - minAlpha) * ratio : minAlpha + (maxAlpha - minAlpha) * ratio;
                                }
                                alpha = Math.max(minAlpha, Math.min(maxAlpha, alpha));
                                this._applyOverlayColor(`rgba(${baseColorRGB.join(',')}, ${alpha.toFixed(3)})`);
                            }
                        } catch (brightnessError) {
                            console.warn("計算圖像平均亮度失敗:", brightnessError);
                            const fallbackAlpha = this.options.dynamicOverlay.lightMode ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
                            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${fallbackAlpha})`);
                        }
                    }
                } else {
                    console.warn("BlurredWindowBackground: ImageBlurProcessor 未能返回有效的 Blob 實例。");
                    shouldRegenerate = false; // 處理失敗
                }
            } else if (!shouldRegenerate) {
                console.log("BlurredWindowBackground: 壁紙未改變且模糊圖像已存在，跳過重新生成。");
            }


            // 無論是否重新生成，只要模糊圖像存在就嘗試應用
            if (this.blurredImagePath && fs.existsSync(this.blurredImagePath)) {
                let mtimeTimestamp;
                try {
                    mtimeTimestamp = fs.statSync(this.blurredImagePath).mtime.getTime();
                } catch (e) {
                    mtimeTimestamp = Date.now(); // 獲取失敗則用當前時間
                }
                const cssPath = `file://${this.blurredImagePath.replace(/\\/g, '/')}?t=${mtimeTimestamp}`;

                // 檢查與當前應用的背景是否相同，避免不必要的DOM操作
                const currentAppliedBg = this.backgroundHostElement.style.backgroundImage;
                if (!currentAppliedBg || currentAppliedBg !== `url("${cssPath}")`) {
                    this.backgroundHostElement.style.backgroundImage = `url('${cssPath}')`;
                }

                const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
                if (currentScreen && currentScreen.bounds) {
                    const newSize = `${currentScreen.bounds.width}px ${currentScreen.bounds.height}px`;
                    if (this.backgroundHostElement.style.backgroundSize !== newSize) {
                        this.backgroundHostElement.style.backgroundSize = newSize;
                    }
                    this._updateBackgroundPositionBasedOnCurrentPadding(); // 更新位置
                }
            } else {
                // 如果模糊圖像不存在（例如初始時或生成失敗），可以考慮清除背景圖或顯示一個回退樣式
                // this.backgroundHostElement.style.backgroundImage = 'none';
                console.warn("BlurredWindowBackground: 最終未能找到或生成模糊圖像。");
            }
            this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
        } catch (error) {
            console.error(`更新模糊桌布錯誤 (${this.runtimeEnv}):`, error);
            this.currentWallpaperPath = null; // 出錯時重置，以便下次能強制重新檢查
            this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
        }
    }

    async _getAverageBrightnessFromBlurredImage(imagePathOrBlob) {
        // ... (此方法內部邏輯與原代碼基本一致，保持不變)
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                const maxCanvasDim = 4096;
                let imgWidth = img.naturalWidth, imgHeight = img.naturalHeight;
                if (imgWidth === 0 || imgHeight === 0) { reject(new Error("Image has zero dimensions.")); return; }
                if (imgWidth > maxCanvasDim || imgHeight > maxCanvasDim) {
                    const ratio = Math.min(maxCanvasDim / imgWidth, maxCanvasDim / imgHeight);
                    imgWidth = Math.max(1, Math.floor(imgWidth * ratio));
                    imgHeight = Math.max(1, Math.floor(imgHeight * ratio));
                }
                canvas.width = imgWidth; canvas.height = imgHeight;
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) { reject(new Error("Failed to get canvas 2d context")); return; }
                ctx.drawImage(img, 0, 0, imgWidth, imgHeight);
                try {
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const data = imageData.data;
                    let r = 0, g = 0, b = 0; const pixels = data.length / 4;
                    if (pixels === 0) { resolve(128); return; }
                    const stride = Math.max(1, Math.floor(pixels / 100000)) * 4;
                    let sampled = 0;
                    for (let i = 0; i < data.length; i += stride) {
                        r += data[i]; g += data[i + 1]; b += data[i + 2]; sampled++;
                    }
                    if (sampled === 0) { resolve(128); return; }
                    resolve(0.299 * (r / sampled) + 0.587 * (g / sampled) + 0.114 * (b / sampled));
                } catch (e) { reject(e); }
                finally { if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); }
            };
            img.onerror = (e) => {
                if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                reject(new Error(`Image load error. Source: ${typeof imagePathOrBlob === 'string' ? imagePathOrBlob : 'Blob'}`));
            };
            if (typeof imagePathOrBlob === 'string') img.src = `file://${imagePathOrBlob.replace(/\\/g, '/')}?t=${Date.now()}`;
            else if (imagePathOrBlob instanceof Blob) img.src = URL.createObjectURL(imagePathOrBlob);
            else reject(new Error("無效的圖像源。"));
        });
    }

    _scheduleNextWallpaperCheck(delay) {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        this.wallpaperCheckTimeoutId = setTimeout(() => this.updateAndApplyBlurredWallpaper(), delay);
    }

    _getCurrentScreenForWindow(windowBounds) {
        // ... (此方法內部邏輯與原代碼基本一致，保持不變)
        if (!windowBounds || typeof windowBounds.x !== 'number' || typeof windowBounds.y !== 'number') {
            if (this.runtimeEnv === 'nwjs' && this.nwWin) { // 確保 nwWin 已定義
                windowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
            } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
                try {
                    const syncBounds = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                    if (syncBounds) windowBounds = syncBounds;
                    else { windowBounds = null; }
                } catch (e) {
                    windowBounds = null;
                    console.warn("BlurredWindowBackground: _getCurrentScreenForWindow 同步獲取 bounds 失敗", e);
                }
                if (!windowBounds) return this._getDefaultScreenInfo();
            } else return this._getDefaultScreenInfo();
        }
        const winCX = windowBounds.x + windowBounds.width / 2, winCY = windowBounds.y + windowBounds.height / 2;
        if (this.runtimeEnv === 'nwjs' && this.nwScreen) { // 確保 nwScreen 已定義
            if (!this.nwScreen.screens || this.nwScreen.screens.length === 0) return this._getDefaultScreenInfo();
            for (const s of this.nwScreen.screens) {
                if (s.bounds && s.bounds.width > 0 && s.bounds.height > 0 &&
                    winCX >= s.bounds.x && winCX < (s.bounds.x + s.bounds.width) &&
                    winCY >= s.bounds.y && winCY < (s.bounds.y + s.bounds.height)) return s;
            }
            return this.nwScreen.screens.find(s => s.isBuiltIn && s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens.find(s => s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens[0] || // 添加一個最終回退到第一個屏幕
                this._getDefaultScreenInfo();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.screen) {
            let activeScreen = this.electron.screen.getDisplayNearestPoint({ x: Math.round(winCX), y: Math.round(winCY) });
            if (!activeScreen || !activeScreen.bounds || activeScreen.bounds.width <= 0) activeScreen = this.electron.screen.getPrimaryDisplay();
            return activeScreen || this._getDefaultScreenInfo();
        }
        return this._getDefaultScreenInfo();
    }

    _getDefaultScreenInfo() {
        return { bounds: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }, id: 'fallback-default', isBuiltIn: true, rotation: 0, touchSupport: 'unknown' };
    }

    destroy() {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        if (this.runtimeEnv === 'nwjs' && this.nwWin) { // 確保 nwWin 已定義
            if (this._boundOnMove) this.nwWin.removeListener('move', this._boundOnMove);
            // 【修改】移除最大化/還原事件監聽
            this.nwWin.removeListener('maximize', () => this._updateMaximizedStyles(true)); // 移除時需要精確的函數引用
            this.nwWin.removeListener('unmaximize', () => this._updateMaximizedStyles(false));
            this.nwWin.removeListener('restore', () => { this._forceStyleUpdate = true; this._updateMaximizedStyles(this.nwWin.state === 'maximized'); });
            // 更好的做法是將匿名函數賦給實例屬性以便移除
            // this.nwWin.removeListener('maximize', this._boundHandleMaximize); // 如果 _boundHandleMaximize 等被定義

            if (this._boundRefreshOnScreenChange && this.nwScreen) { // 確保 nwScreen 已定義
                this.nwScreen.removeListener('displayBoundsChanged', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayAdded', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayRemoved', this._boundRefreshOnScreenChange);
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.removeAllListeners('bwb:window-bounds-updated');
            // 【修改】移除最大化/還原 IPC 監聽
            this.electron.ipcRenderer.removeAllListeners('bwb:window-maximized');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-unmaximized');

            // if (this.electron.screen && this._boundRefreshOnScreenChange) {
            // this.electron.screen.removeListener('display-metrics-changed', this._boundRefreshOnScreenChange);
            // ...
            // }
        }
        if (this.overlayElement) this.overlayElement.remove();
        if (this.backgroundHostElement) this.backgroundHostElement.remove();
        console.log(`BlurredWindowBackground 實例已銷毀 (${this.runtimeEnv})。`);
        // 注意：臨時文件在此處不被刪除
    }
}

// module.exports = BlurredWindowBackground;