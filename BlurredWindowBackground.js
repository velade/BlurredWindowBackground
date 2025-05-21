// Node.js 核心模塊
const os = require('os');
const fs = require('fs');
const path = require('path');

// 外部依賴 - 確保這些在兩個環境中都可用
const getWallpaper = require('./wallpaper.js');
const ImageBlurProcessor = require('./ImageBlurProcessor.js');

/**
 * @class BlurredWindowBackground
 * @description 自動創建一個帶模糊背景和動態調整透明度遮罩的窗口背景元素。
 * 兼容 NW.js 和 Electron。
 */
class BlurredWindowBackground {
    /**
     * 創建一個 BlurredWindowBackground 實例。
     * @param {object} [options={}] - 配置選項。
     * @param {number} [options.blurRadius=90] - 背景圖像的模糊半徑。
     * @param {number} [options.titleBarHeight=0] - 窗口頂部標題欄或偏移的高度。
     * @param {number} [options.checkIntervalSuccess=1000] - 桌布檢查成功時的更新間隔 (毫秒)。
     * @param {number} [options.checkIntervalError=1000] - 桌布檢查失敗時的重試間隔 (毫秒)。
     * @param {string} [options.tempSubDir='nwjs_blur_temp_v2'] - 臨時子目錄名稱。
     * @param {string} [options.blurredImageName='blurred_wallpaper.webp'] - 模糊圖像文件名。
     * @param {number} [options.imageProcessingZipRate=0.25] - 圖像處理壓縮率。
     * @param {string} [options.elementZIndex='0'] - 背景元素的 z-index。
     * @param {object} [options.dynamicOverlay] - 動態遮罩配置。
     * @param {boolean} [options.dynamicOverlay.enable=true] - 是否啟用動態透明度遮罩。
     * @param {Array<number>} [options.dynamicOverlay.baseColorRGB=[252,252,252]] - 遮罩的基礎 RGB 顏色。
     * @param {number} [options.dynamicOverlay.minAlpha=0.5] - 最小透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.maxAlpha=0.75] - 最大透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.brightnessThresholdLow=70] - 平均亮度的低閾值。
     * @param {number} [options.dynamicOverlay.brightnessThresholdHigh=180] - 平均亮度的高閾值。
     * @param {boolean} [options.dynamicOverlay.invertAlphaBehavior=true] - 是否反轉透明度行為。
     */
    constructor(options = {}) {
        this.runtimeEnv = 'unknown';
        this.electron = null;

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

        this.options = {
            blurRadius: 90,
            titleBarHeight: 0,
            checkIntervalSuccess: 1000,
            checkIntervalError: 1000,
            tempSubDir: 'nwjs_blur_temp_v2',
            blurredImageName: 'blurred_wallpaper.webp',
            imageProcessingZipRate: 0.25,
            elementZIndex: '0',
            dynamicOverlay: {
                enable: true,
                baseColorRGB: [252, 252, 252],
                minAlpha: 0.5,
                maxAlpha: 0.75,
                brightnessThresholdLow: 70,
                brightnessThresholdHigh: 180,
                invertAlphaBehavior: true,
                ...(options.dynamicOverlay || {})
            },
            ...options
        };
        if (options.dynamicOverlay) {
            this.options.dynamicOverlay = { ...this.options.dynamicOverlay, ...options.dynamicOverlay };
        }

        this.appRootDir = this._getAppRootDir();
        this.currentWallpaperPath = null;
        this.wallpaperCheckTimeoutId = null;
        this.backgroundHostElement = null;
        this.overlayElement = null;
        this.currentWindowBounds = { x: 0, y: 0, width: 800, height: 600 };

        this._initialize();
    }

    _getAppRootDir() {
        if (this.runtimeEnv === 'nwjs') {
            return path.dirname(process.execPath);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                // IPC 通道名稱: 'bwb:get-app-path'
                const appPath = this.electron.ipcRenderer.sendSync('bwb:get-app-path');
                if (appPath) return appPath;
            } catch (e) {
                console.error("Electron: Error calling 'bwb:get-app-path' IPC:", e);
            }
            console.warn("Electron: 無法通過 IPC 獲取應用程序根目錄。將回退到 '.'。");
            return '.';
        }
        return '.';
    }

    async _initialize() {
        this._createBackgroundHostElement();
        this.tempDir = this._getTemporaryDirectory();
        if (!this.tempDir) {
            console.error("錯誤：無法確定或創建臨時目錄。");
        } else {
            this.blurredImagePath = path.join(this.tempDir, this.options.blurredImageName);
            console.log(`模糊背景將使用臨時目錄: ${this.tempDir}`);
        }

        if (this.options.dynamicOverlay.enable) {
            this._createOverlayElement();
            const initialAlpha = this.options.dynamicOverlay.invertAlphaBehavior ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${initialAlpha})`);
        }

        await this._updateCurrentWindowBounds();
        this.updateAndApplyBlurredWallpaper();

        this._boundOnMove = (x, y) => this._onWindowMove(x, y);
        this._boundRefreshOnScreenChange = () => this._refreshWallpaperOnScreenChange();

        if (this.runtimeEnv === 'nwjs') {
            this.nwWin.on('move', this._boundOnMove);
            this.nwScreen.on('displayBoundsChanged', this._boundRefreshOnScreenChange);
            this.nwScreen.on('displayAdded', this._boundRefreshOnScreenChange);
            this.nwScreen.on('displayRemoved', this._boundRefreshOnScreenChange);
        } else if (this.runtimeEnv === 'electron' && this.electron) {
            // IPC 監聽通道名稱: 'bwb:window-bounds-updated'
            this.electron.ipcRenderer.on('bwb:window-bounds-updated', (event, newBounds) => {
                if (newBounds) {
                    this.currentWindowBounds = newBounds;
                    this._onWindowMove(newBounds.x, newBounds.y); // 更新位置
                    // 如果窗口大小也影響模糊效果（例如需要重新生成圖像），則可能需要更全面的更新
                    this.updateAndApplyBlurredWallpaper(); // 重新檢查壁紙和位置
                }
            });
            if (this.electron.screen) {
                this.electron.screen.on('display-metrics-changed', this._boundRefreshOnScreenChange);
                this.electron.screen.on('display-added', this._boundRefreshOnScreenChange);
                this.electron.screen.on('display-removed', this._boundRefreshOnScreenChange);
            }
        }
        console.log(`模糊窗口背景效果已初始化 (${this.runtimeEnv})。`);
    }

    _createBackgroundHostElement() {
        this.backgroundHostElement = document.createElement('div');
        this.backgroundHostElement.id = `${this.runtimeEnv}-blurred-background-host`;
        const s = this.backgroundHostElement.style;
        s.position = 'fixed';
        s.top = '5px';
        s.left = '5px';
        s.right = '5px';
        s.bottom = '5px';
        s.borderRadius = "15px";
        s.boxShadow = "0 0 5px rgba(0, 0, 0, .5)";
        s.overflow = 'hidden';
        s.zIndex = this.options.elementZIndex;
        s.backgroundRepeat = 'no-repeat'; s.backgroundColor = '#fcfcfc';
        document.body.appendChild(this.backgroundHostElement);
    }

    _createOverlayElement() {
        if (!this.backgroundHostElement) return;
        this.overlayElement = document.createElement('div');
        this.overlayElement.id = `${this.runtimeEnv}-blurred-background-overlay`;
        const s = this.overlayElement.style;
        s.position = 'absolute'; s.top = '0'; s.left = '0'; s.width = '100%'; s.height = '100%';
        s.pointerEvents = 'none';
        this.backgroundHostElement.appendChild(this.overlayElement);
    }

    _applyOverlayColor(cssColor) {
        if (this.overlayElement) this.overlayElement.style.backgroundColor = cssColor;
    }

    _getTemporaryDirectory() {
        let tempPathBase;
        if (this.runtimeEnv === 'nwjs') {
            tempPathBase = os.tmpdir();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                // IPC 通道名稱: 'bwb:get-path'
                const electronTempPath = this.electron.ipcRenderer.sendSync('bwb:get-path', 'temp');
                tempPathBase = electronTempPath || os.tmpdir();
            } catch (e) {
                console.error("Electron: Error calling 'bwb:get-path' IPC:", e);
                tempPathBase = os.tmpdir();
            }
        } else {
            tempPathBase = os.tmpdir();
        }

        let tempPath;
        try {
            tempPath = path.join(tempPathBase, this.options.tempSubDir);
            if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
            const testFilePath = path.join(tempPath, `_test_write_${Date.now()}`);
            fs.writeFileSync(testFilePath, "test"); fs.unlinkSync(testFilePath);
            return tempPath;
        } catch (error) {
            console.warn(`創建臨時目錄 (${tempPath || tempPathBase}) 失敗: ${error.message}.`);
            try {
                const fallbackBase = this.appRootDir;
                if (!fallbackBase || fallbackBase === '.') { return null; }
                tempPath = path.join(fallbackBase, this.options.tempSubDir);
                if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
                return tempPath;
            } catch (fallbackError) {
                console.error(`創建後備臨時目錄失敗: ${fallbackError.message}`);
                return null;
            }
        }
    }

    async _updateCurrentWindowBounds() {
        if (this.runtimeEnv === 'nwjs') {
            this.currentWindowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                // IPC 通道名稱: 'bwb:get-window-bounds' (invoke)
                const bounds = await this.electron.ipcRenderer.invoke('bwb:get-window-bounds');
                if (bounds) this.currentWindowBounds = bounds;
                else console.warn("Electron: IPC 'bwb:get-window-bounds' 未返回邊界。");
            } catch (e) {
                console.error("Electron: Error invoking 'bwb:get-window-bounds':", e);
                try {
                    // IPC 通道名稱: 'bwb:get-window-bounds-sync' (fallback)
                    const boundsSync = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                    if (boundsSync) this.currentWindowBounds = boundsSync;
                    else console.warn("Electron: IPC 'bwb:get-window-bounds-sync' 未返回邊界。");
                } catch (eSync) {
                    console.error("Electron: Error calling 'bwb:get-window-bounds-sync':", eSync);
                }
            }
        }
    }

    _onWindowMove(x, y) {
        if (this.runtimeEnv === 'nwjs') {
            this.currentWindowBounds.x = x;
            this.currentWindowBounds.y = y;
        }
        if (this.backgroundHostElement && this.backgroundHostElement.style.backgroundImage && this.currentWindowBounds) {
            this.backgroundHostElement.style.backgroundPosition = `-${this.currentWindowBounds.x + 5}px -${this.currentWindowBounds.y + this.options.titleBarHeight + 5}px`;
        }
    }

    _refreshWallpaperOnScreenChange() {
        console.log(`偵測到螢幕配置變化 (${this.runtimeEnv})。`);
        this.currentWallpaperPath = null;
        this.updateAndApplyBlurredWallpaper();
    }

    async updateAndApplyBlurredWallpaper() {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        try {
            const newPath = await getWallpaper();
            if (!newPath) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }
            await this._updateCurrentWindowBounds();
            const currentWinBounds = this.currentWindowBounds;
            if (!currentWinBounds || currentWinBounds.width <= 0 || currentWinBounds.height <= 0) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            if (newPath !== this.currentWallpaperPath || !this.blurredImagePath || !fs.existsSync(this.blurredImagePath)) {
                const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
                if (!currentScreen || !currentScreen.bounds || currentScreen.bounds.width <= 0 || currentScreen.bounds.height <= 0) {
                    this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
                }
                const targetSize = [currentScreen.bounds.width, currentScreen.bounds.height];
                const processor = new ImageBlurProcessor(newPath, targetSize, this.options.imageProcessingZipRate, true);
                const blurredBlobInstance = await processor.blurImage(this.options.blurRadius, 'image/webp');

                if (blurredBlobInstance && blurredBlobInstance.blob) {
                    if (this.tempDir) {
                        try { await blurredBlobInstance.toFile(this.blurredImagePath); }
                        catch (fileError) { console.error(`保存模糊桌布失敗:`, fileError); }
                    }
                    if (this.options.dynamicOverlay.enable && this.overlayElement) {
                        try {
                            const imgSrc = (this.tempDir && fs.existsSync(this.blurredImagePath)) ? this.blurredImagePath : blurredBlobInstance.blob;
                            const avgBrightness = await this._getAverageBrightnessFromBlurredImage(imgSrc);
                            if (typeof avgBrightness === 'number') {
                                const { baseColorRGB, minAlpha, maxAlpha, brightnessThresholdLow, brightnessThresholdHigh, invertAlphaBehavior } = this.options.dynamicOverlay;
                                let alpha;
                                if (avgBrightness <= brightnessThresholdLow) alpha = invertAlphaBehavior ? maxAlpha : minAlpha;
                                else if (avgBrightness >= brightnessThresholdHigh) alpha = invertAlphaBehavior ? minAlpha : maxAlpha;
                                else {
                                    const ratio = (avgBrightness - brightnessThresholdLow) / (brightnessThresholdHigh - brightnessThresholdLow);
                                    alpha = invertAlphaBehavior ? maxAlpha - (maxAlpha - minAlpha) * ratio : minAlpha + (maxAlpha - minAlpha) * ratio;
                                }
                                alpha = Math.max(minAlpha, Math.min(maxAlpha, alpha));
                                this._applyOverlayColor(`rgba(${baseColorRGB.join(',')}, ${alpha.toFixed(3)})`);
                            }
                        } catch (brightnessError) {
                            console.warn("計算圖像平均亮度失敗:", brightnessError);
                            const fallbackAlpha = this.options.dynamicOverlay.invertAlphaBehavior ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
                            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${fallbackAlpha})`);
                        }
                    }
                    let cssPath;
                    if (this.tempDir && fs.existsSync(this.blurredImagePath)) cssPath = `file:///${this.blurredImagePath.replace(/\\/g, '/')}?t=${Date.now()}`;
                    else if (blurredBlobInstance.blob) cssPath = URL.createObjectURL(blurredBlobInstance.blob);
                    else { this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return; }

                    this.backgroundHostElement.style.backgroundImage = `url('${cssPath}')`;
                    this.backgroundHostElement.style.backgroundSize = `${targetSize[0]}px ${targetSize[1]}px`;
                    this.backgroundHostElement.style.backgroundPosition = `-${currentWinBounds.x + 5}px -${currentWinBounds.y + this.options.titleBarHeight + 5}px`;
                    this.currentWallpaperPath = newPath;
                }
            } else if (this.backgroundHostElement.style.backgroundImage) {
                const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
                if (currentScreen && currentScreen.bounds) {
                    this.backgroundHostElement.style.backgroundSize = `${currentScreen.bounds.width}px ${currentScreen.bounds.height}px`;
                    this.backgroundHostElement.style.backgroundPosition = `-${currentWinBounds.x + 5}px -${currentWinBounds.y + this.options.titleBarHeight + 5}px`;
                }
            }
            this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
        } catch (error) {
            console.error(`更新模糊桌布錯誤 (${this.runtimeEnv}):`, error);
            this.currentWallpaperPath = null;
            this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
        }
    }

    async _getAverageBrightnessFromBlurredImage(imagePathOrBlob) {
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
            if (typeof imagePathOrBlob === 'string') img.src = `file:///${imagePathOrBlob.replace(/\\/g, '/')}?t=${Date.now()}`;
            else if (imagePathOrBlob instanceof Blob) img.src = URL.createObjectURL(imagePathOrBlob);
            else reject(new Error("無效的圖像源。"));
        });
    }

    _scheduleNextWallpaperCheck(delay) {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        this.wallpaperCheckTimeoutId = setTimeout(() => this.updateAndApplyBlurredWallpaper(), delay);
    }

    _getCurrentScreenForWindow(windowBounds) {
        if (!windowBounds || typeof windowBounds.x !== 'number' || typeof windowBounds.y !== 'number') {
            if (this.runtimeEnv === 'nwjs') windowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
            else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
                try { windowBounds = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync'); }
                catch (e) { windowBounds = null; }
                if (!windowBounds) return this._getDefaultScreenInfo();
            } else return this._getDefaultScreenInfo();
        }
        const winCX = windowBounds.x + windowBounds.width / 2, winCY = windowBounds.y + windowBounds.height / 2;
        if (this.runtimeEnv === 'nwjs') {
            for (const s of this.nwScreen.screens) {
                if (s.bounds && s.bounds.width > 0 && s.bounds.height > 0 &&
                    winCX >= s.bounds.x && winCX < (s.bounds.x + s.bounds.width) &&
                    winCY >= s.bounds.y && winCY < (s.bounds.y + s.bounds.height)) return s;
            }
            return this.nwScreen.screens.find(s => s.isBuiltIn && s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens.find(s => s.bounds && s.bounds.width > 0) || this._getDefaultScreenInfo();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.screen) {
            let activeScreen = this.electron.screen.getDisplayNearestPoint({ x: Math.round(winCX), y: Math.round(winCY) });
            if (!activeScreen || !activeScreen.bounds || activeScreen.bounds.width <= 0) activeScreen = this.electron.screen.getPrimaryDisplay();
            return activeScreen || this._getDefaultScreenInfo();
        }
        return this._getDefaultScreenInfo();
    }

    _getDefaultScreenInfo() {
        return { bounds: { x: 0, y: 0, width: 1920, height: 1080, scaleFactor: 1 }, id: 'fallback-default', isBuiltIn: true, rotation: 0, touchSupport: 0 };
    }

    destroy() {
        if (this.wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        if (this.runtimeEnv === 'nwjs') {
            if (this._boundOnMove) this.nwWin.removeListener('move', this._boundOnMove);
            if (this._boundRefreshOnScreenChange) {
                this.nwScreen.removeListener('displayBoundsChanged', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayAdded', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayRemoved', this._boundRefreshOnScreenChange);
            }
        } else if (this.runtimeEnv === 'electron' && this.electron) {
            if (this.electron.ipcRenderer) this.electron.ipcRenderer.removeAllListeners('bwb:window-bounds-updated');
            if (this.electron.screen && this._boundRefreshOnScreenChange) {
                this.electron.screen.removeListener('display-metrics-changed', this._boundRefreshOnScreenChange);
                this.electron.screen.removeListener('display-added', this._boundRefreshOnScreenChange);
                this.electron.screen.removeListener('display-removed', this._boundRefreshOnScreenChange);
            }
        }
        if (this.overlayElement) this.overlayElement.remove();
        if (this.backgroundHostElement) this.backgroundHostElement.remove();
        console.log(`BlurredWindowBackground 實例已銷毀 (${this.runtimeEnv})。`);
    }
}

// module.exports = BlurredWindowBackground; // 如果您需要在 CommonJS 環境中導出

