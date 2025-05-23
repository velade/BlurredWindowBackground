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
     * @param {number} [options.titleBarHeight=0] - 窗口頂部標題欄或偏移的高度。
     * @param {number} [options.checkIntervalSuccess=1000] - 桌布檢查成功時的更新間隔 (毫秒)。
     * @param {number} [options.checkIntervalError=1000] - 桌布檢查失敗時的重試間隔 (毫秒)。
     * @param {number} [options.imageProcessingZipRate=0.25] - 圖像處理比例，0.01-1.00。
     * @param {string} [options.elementZIndex='0'] - 背景元素的 z-index。
     * @param {object} [options.dynamicOverlay] - 動態遮罩配置。
     * @param {boolean} [options.dynamicOverlay.enable=true] - 是否啟用動態透明度遮罩。
     * @param {Array<number>} [options.dynamicOverlay.baseColorRGB=[252,252,252]] - 遮罩的基礎 RGB 顏色。
     * @param {number} [options.dynamicOverlay.minAlpha=0.5] - 最小透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.maxAlpha=0.75] - 最大透明度 (0.0 - 1.0)。
     * @param {number} [options.dynamicOverlay.brightnessThresholdLow=70] - 亮度判定的低閾值。
     * @param {number} [options.dynamicOverlay.brightnessThresholdHigh=180] - 亮度判定的高閾值。
     * @param {boolean} [options.dynamicOverlay.lightMode=true] - 遮罩色是否為淺色。
     */
    constructor(options = {}) {
        this.runtimeEnv = 'unknown';
        this.electron = null;
        this.nwWin = null;
        this.nwScreen = null;

        if (typeof nw !== 'undefined' && nw.Window && nw.Screen) {
            this.runtimeEnv = 'nwjs';
            this.nwWin = nw.Window.get();
            this.nwScreen = nw.Screen;
        } else if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
            this.runtimeEnv = 'electron';
            try {
                this.electron = require('electron');
                if (!this.electron.ipcRenderer) throw new Error("Electron ipcRenderer not available.");
            } catch (e) {
                console.error("BlurredWindowBackground: 無法加載 Electron 模塊。", e);
                this.runtimeEnv = 'unknown_error';
                return;
            }
        } else {
            console.error("BlurredWindowBackground: 無法識別運行時環境。");
            return;
        }

        let appName = 'DefaultApp';
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            appName = (nw.App.manifest && nw.App.manifest.name) ? nw.App.manifest.name : 'NWJSApp';
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                appName = this.electron.ipcRenderer.sendSync('bwb:get-app-name');
            } catch (e) {
                appName = 'ElectronApp';
            }
        }
        const sanitizedAppName = (appName || 'DefaultApp').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'DefaultSanitizedApp';
        this.internalTempSubDir = `bwb_temp_${sanitizedAppName}`;
        this.internalBlurredImageName = 'blurred_wallpaper.webp';

        this.options = {
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
        this._isMaximized = false;
        this._currentAppliedPadding = 5;
        this._forceStyleUpdate = false;
        this._moveOverlayUpdateTimeoutId = null; // 用於窗口移動時更新遮罩的 debounce 定時器

        this._initialize();
    }

    _getAppRootDir() {
        if (this.runtimeEnv === 'nwjs') {
            return path.dirname(process.execPath);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const appPath = this.electron.ipcRenderer.sendSync('bwb:get-app-path');
                if (appPath) return appPath;
            } catch (e) { /*忽略錯誤，使用後備*/ }
            return '.';
        }
        return '.';
    }

    async _initialize() {
        this._createBackgroundHostElement();
        this.tempDir = this._getTemporaryDirectory();
        if (!this.tempDir) {
            console.error("BlurredWindowBackground: 無法確定或創建臨時目錄。");
        } else {
            this.blurredImagePath = path.join(this.tempDir, this.internalBlurredImageName);
            if (fs.existsSync(this.blurredImagePath)) {
                try {
                    const stats = fs.statSync(this.blurredImagePath);
                    const cssPath = `file://${this.blurredImagePath.replace(/\\/g, '/')}?t=${stats.mtime.getTime()}`;
                    this.backgroundHostElement.style.backgroundImage = `url('${cssPath}')`;
                    await this._updateCurrentWindowBounds(); // 確保有 bounds
                    this._updateBackgroundPositionBasedOnCurrentPadding();
                } catch (e) { /*忽略*/ }
            }
        }

        if (this.options.dynamicOverlay.enable) {
            this._createOverlayElement();
            const initialAlpha = this.options.dynamicOverlay.lightMode ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${initialAlpha})`);
        }

        await this._updateCurrentWindowBounds();
        this.updateAndApplyBlurredWallpaper(); // 初始加載

        this._boundOnMove = (x, y) => this._onWindowMove(x, y);
        this._boundRefreshOnScreenChange = () => this._refreshWallpaperOnScreenChange();
        this._boundHandleMaximize = () => this._updateMaximizedStyles(true);
        this._boundHandleUnmaximize = () => this._updateMaximizedStyles(false);
        this._boundHandleRestore = () => {
            this._forceStyleUpdate = true;
            this._updateMaximizedStyles(this.nwWin.state === 'maximized');
        };

        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.nwWin.on('maximize', this._boundHandleMaximize);
            this.nwWin.on('unmaximize', this._boundHandleUnmaximize);
            this.nwWin.on('restore', this._boundHandleRestore);
            this.nwWin.on('move', this._boundOnMove);
            if (this.nwScreen) {
                this.nwScreen.on('displayBoundsChanged', this._boundRefreshOnScreenChange);
                this.nwScreen.on('displayAdded', this._boundRefreshOnScreenChange);
                this.nwScreen.on('displayRemoved', this._boundRefreshOnScreenChange);
            }
            this._isMaximized = (this.nwWin.state === 'maximized');
            this._currentAppliedPadding = this._isMaximized ? 0 : 5;
            this._forceStyleUpdate = true;
            this._updateMaximizedStyles(this._isMaximized);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.on('bwb:window-maximized', this._boundHandleMaximize);
            this.electron.ipcRenderer.on('bwb:window-unmaximized', this._boundHandleUnmaximize);
            this.electron.ipcRenderer.invoke('bwb:get-window-is-maximized').then(isMaximized => {
                this._isMaximized = isMaximized;
                this._currentAppliedPadding = this._isMaximized ? 0 : 5;
                this._forceStyleUpdate = true;
                this._updateMaximizedStyles(isMaximized);
            }).catch(() => { /* 忽略，使用默認值 */ });

            this.electron.ipcRenderer.on('bwb:window-bounds-updated', (event, newBounds) => {
                if (newBounds) {
                    this.currentWindowBounds = newBounds; // 更新 bounds
                    this._handleWindowBoundsChange();    // 處理 bounds 變化
                }
            });
        }
    }

    _createBackgroundHostElement() {
        this.backgroundHostElement = document.createElement('div');
        this.backgroundHostElement.id = `vel-blurred-background-host`;
        const s = this.backgroundHostElement.style;
        s.position = 'fixed'; s.overflow = 'hidden';
        s.zIndex = this.options.elementZIndex;
        s.backgroundRepeat = 'no-repeat'; s.backgroundColor = '#fcfcfc';
        s.transition = 'top 0.2s ease-in-out, left 0.2s ease-in-out, right 0.2s ease-in-out, bottom 0.2s ease-in-out, border-radius 0.2s ease-in-out, box-shadow 0.2s ease-in-out';
        document.body.appendChild(this.backgroundHostElement);
    }

    _updateMaximizedStyles(isMaximized) {
        if (this._isMaximized === isMaximized && !this._forceStyleUpdate) return;
        this._isMaximized = isMaximized; this._forceStyleUpdate = false;
        if (!this.backgroundHostElement) return;
        const s = this.backgroundHostElement.style;
        const newPadding = isMaximized ? 0 : 5;
        if (this._currentAppliedPadding !== newPadding || isMaximized !== this._isMaximizedPreviousStateForStyle) {
            s.top = `${newPadding}px`; s.left = `${newPadding}px`;
            s.right = `${newPadding}px`; s.bottom = `${newPadding}px`;
            s.borderRadius = isMaximized ? '0px' : `${this.options.borderRadius}px`;
            s.boxShadow = isMaximized ? 'none' : "0 0 5px rgba(0, 0, 0, .5)";
            const oldPadding = this._currentAppliedPadding;
            this._currentAppliedPadding = newPadding;
            this._isMaximizedPreviousStateForStyle = isMaximized;
            if (oldPadding !== newPadding || isMaximized) {
                this._updateBackgroundPositionBasedOnCurrentPadding();
            }
        }
    }

    _updateBackgroundPositionBasedOnCurrentPadding() {
        if (this.backgroundHostElement && this.backgroundHostElement.style.backgroundImage && this.currentWindowBounds && typeof this.currentWindowBounds.x === 'number') {
            const padding = this._currentAppliedPadding;
            const newPosition = `-${this.currentWindowBounds.x + padding}px -${this.currentWindowBounds.y + this.options.titleBarHeight + padding}px`;
            if (this.backgroundHostElement.style.backgroundPosition !== newPosition) {
                this.backgroundHostElement.style.backgroundPosition = newPosition;
            }
        }
    }

    _createOverlayElement() {
        if (!this.backgroundHostElement || this.overlayElement) return;
        this.overlayElement = document.createElement('div');
        this.overlayElement.id = `vel-blurred-background-overlay`;
        const s = this.overlayElement.style;
        s.position = 'absolute'; s.top = '0'; s.left = '0'; s.width = '100%'; s.height = '100%';
        s.pointerEvents = 'none';
        s.transition = 'background-color 500ms ease-out';
        this.backgroundHostElement.appendChild(this.overlayElement);
    }

    _applyOverlayColor(cssColor) {
        if (this.overlayElement && this.overlayElement.style.backgroundColor !== cssColor) {
            this.overlayElement.style.backgroundColor = cssColor;
        }
    }

    _getTemporaryDirectory() {
        // ... (此方法實現與之前版本相同)
        let tempPathBase;
        if (this.runtimeEnv === 'nwjs') {
            tempPathBase = os.tmpdir();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const electronTempPath = this.electron.ipcRenderer.sendSync('bwb:get-path', 'temp');
                tempPathBase = electronTempPath || os.tmpdir();
            } catch (e) { tempPathBase = os.tmpdir(); }
        } else {
            tempPathBase = os.tmpdir();
        }
        let tempPath = path.join(tempPathBase, this.internalTempSubDir);
        try {
            if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
            fs.writeFileSync(path.join(tempPath, `_`), "t"); fs.unlinkSync(path.join(tempPath, `_`));
            return tempPath;
        } catch (error) {
            try {
                tempPath = path.join(this.appRootDir, this.internalTempSubDir);
                if (!fs.existsSync(tempPath)) fs.mkdirSync(tempPath, { recursive: true });
                fs.writeFileSync(path.join(tempPath, `_`), "t"); fs.unlinkSync(path.join(tempPath, `_`));
                return tempPath;
            } catch (fallbackError) { return null; }
        }
    }

    async _updateCurrentWindowBounds() {
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.currentWindowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                const bounds = await this.electron.ipcRenderer.invoke('bwb:get-window-bounds');
                if (bounds) this.currentWindowBounds = bounds;
            } catch (e) {
                try {
                    const boundsSync = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                    if (boundsSync) this.currentWindowBounds = boundsSync;
                } catch (eSync) { /* 忽略 */ }
            }
        }
    }

    _onWindowMove(x, y) { // NW.js specific
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.currentWindowBounds.x = x;
            this.currentWindowBounds.y = y;
            // this.currentWindowBounds.width = this.nwWin.width; // 大小通常由 resize 事件處理
            // this.currentWindowBounds.height = this.nwWin.height;
            this._handleWindowBoundsChange();
        }
    }

    _handleWindowBoundsChange() {
        // 1. 立即更新背景CSS位置 (this.currentWindowBounds 應已被調用者更新)
        this._updateBackgroundPositionBasedOnCurrentPadding();

        // 2. Debounce 遮罩更新
        if (this.options.dynamicOverlay.enable && this.overlayElement) {
            if (this._moveOverlayUpdateTimeoutId) {
                clearTimeout(this._moveOverlayUpdateTimeoutId);
            }
            this._moveOverlayUpdateTimeoutId = setTimeout(async () => {
                if (this.blurredImagePath && fs.existsSync(this.blurredImagePath)) {
                    // 在執行前再次確保 bounds 是最新的 (對於 setTimeout 中的異步調用)
                    await this._updateCurrentWindowBounds();
                    await this._updateOverlayBasedOnCurrentPosition();
                }
            }, 100); // 100ms debounce
        }
    }

    async _updateOverlayBasedOnCurrentPosition() {
        if (!this.options.dynamicOverlay.enable || !this.overlayElement || !this.blurredImagePath || !fs.existsSync(this.blurredImagePath)) {
            return;
        }
        const currentWinBounds = this.currentWindowBounds;
        if (!currentWinBounds || currentWinBounds.width <= 0 || currentWinBounds.height <= 0) return;
        const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
        if (!currentScreen || !currentScreen.bounds || currentScreen.bounds.width <= 0 || currentScreen.bounds.height <= 0) return;

        try {
            const extremeBrightness = await this._getExtremeBrightnessFromWindowRegion(
                this.blurredImagePath,
                currentWinBounds,
                currentScreen.bounds,
                this._currentAppliedPadding,
                this.options.titleBarHeight,
                this.options.dynamicOverlay.lightMode,
                this.options.imageProcessingZipRate
            );
            if (typeof extremeBrightness === 'number') {
                const { baseColorRGB, minAlpha, maxAlpha, brightnessThresholdLow, brightnessThresholdHigh, lightMode } = this.options.dynamicOverlay;
                let alpha;
                if (extremeBrightness <= brightnessThresholdLow) alpha = lightMode ? maxAlpha : minAlpha;
                else if (extremeBrightness >= brightnessThresholdHigh) alpha = lightMode ? minAlpha : maxAlpha;
                else {
                    const ratio = (extremeBrightness - brightnessThresholdLow) / (brightnessThresholdHigh - brightnessThresholdLow);
                    alpha = lightMode ? maxAlpha - (maxAlpha - minAlpha) * ratio : minAlpha + (maxAlpha - minAlpha) * ratio;
                }
                alpha = Math.max(minAlpha, Math.min(maxAlpha, alpha));
                this._applyOverlayColor(`rgba(${baseColorRGB.join(',')}, ${alpha.toFixed(3)})`);
            }
        } catch (brightnessError) {
            console.warn("BlurredWindowBackground: Error calculating extreme brightness for overlay:", brightnessError);
            const fallbackAlpha = this.options.dynamicOverlay.lightMode ? this.options.dynamicOverlay.maxAlpha : this.options.dynamicOverlay.minAlpha;
            this._applyOverlayColor(`rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, ${fallbackAlpha})`);
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

            let shouldRegenerate = newPath !== this.currentWallpaperPath || !this.blurredImagePath || !fs.existsSync(this.blurredImagePath);
            const currentScreen = this._getCurrentScreenForWindow(currentWinBounds);
            if (!currentScreen || !currentScreen.bounds || currentScreen.bounds.width <= 0 || currentScreen.bounds.height <= 0) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            if (shouldRegenerate && this.blurredImagePath) {
                const targetSize = [currentScreen.bounds.width, currentScreen.bounds.height];
                const processor = new ImageBlurProcessor(newPath, targetSize, this.options.imageProcessingZipRate, true);
                const blurredBlobInstance = await processor.blurImage(this.options.blurRadius, 'image/webp');
                if (blurredBlobInstance && blurredBlobInstance.blob) {
                    try {
                        await blurredBlobInstance.toFile(this.blurredImagePath);
                        this.currentWallpaperPath = newPath;
                    } catch (saveErr) { shouldRegenerate = false; }
                } else { shouldRegenerate = false; }
            }

            if (this.blurredImagePath && fs.existsSync(this.blurredImagePath)) {
                let mtimeTimestamp;
                try { mtimeTimestamp = fs.statSync(this.blurredImagePath).mtime.getTime(); } catch (e) { mtimeTimestamp = Date.now(); }
                const cssPath = `file://${this.blurredImagePath.replace(/\\/g, '/')}?t=${mtimeTimestamp}`;
                if (!this.backgroundHostElement.style.backgroundImage || this.backgroundHostElement.style.backgroundImage !== `url("${cssPath}")`) {
                    this.backgroundHostElement.style.backgroundImage = `url('${cssPath}')`;
                }
                const newSize = `${currentScreen.bounds.width}px ${currentScreen.bounds.height}px`;
                if (this.backgroundHostElement.style.backgroundSize !== newSize) {
                    this.backgroundHostElement.style.backgroundSize = newSize;
                }
                this._updateBackgroundPositionBasedOnCurrentPadding(); // 更新背景位置

                // 在壁紙應用或確認後，更新遮罩
                await this._updateOverlayBasedOnCurrentPosition();

            } else {
                console.warn("BlurredWindowBackground: 最終未能找到或生成模糊圖像。");
            }
            this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
        } catch (error) {
            console.error(`更新模糊桌布錯誤 (${this.runtimeEnv}):`, error);
            this.currentWallpaperPath = null;
            this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
        }
    }

    async _getExtremeBrightnessFromWindowRegion(imagePathOrBlob, windowBounds, screenBoundsOfWindow, currentPadding, titleBarHeightOption, lightMode, zipRate) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                if (canvas.width === 0 || canvas.height === 0) { reject(new Error("Image has zero dimensions.")); return; }
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) { reject(new Error("Failed to get canvas 2d context")); return; }
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                const scaledContentXRelToScreen_Initial = Math.round(((windowBounds.x + currentPadding) - screenBoundsOfWindow.x) * zipRate);
                const scaledContentYRelToScreen_Initial = Math.round(((windowBounds.y + titleBarHeightOption + currentPadding) - screenBoundsOfWindow.y) * zipRate);
                const scaledContentWidth_Initial = Math.round((windowBounds.width - (2 * currentPadding)) * zipRate);
                const scaledContentHeight_Initial = Math.round((windowBounds.height - (2 * currentPadding) - titleBarHeightOption) * zipRate);

                let sx = Math.max(0, Math.min(scaledContentXRelToScreen_Initial, canvas.width));
                let sy = Math.max(0, Math.min(scaledContentYRelToScreen_Initial, canvas.height));
                let sWidth = Math.floor(Math.max(0, Math.min(scaledContentWidth_Initial, canvas.width - sx)));
                let sHeight = Math.floor(Math.max(0, Math.min(scaledContentHeight_Initial, canvas.height - sy)));

                if (sWidth <= 0 || sHeight <= 0) {
                    // console.warn("BlurredWindowBackground: Scaled crop area for brightness is zero.", { sx, sy, sWidth, sHeight, canvasW: canvas.width, canvasH: canvas.height });
                    resolve(lightMode ? 0 : 255); return;
                }
                try {
                    const imageData = ctx.getImageData(sx, sy, sWidth, sHeight);
                    const data = imageData.data; const pixels = data.length / 4;
                    if (pixels === 0) { resolve(lightMode ? 0 : 255); return; }
                    let extremeBrightness = lightMode ? 255 : 0; let sampled = 0;
                    for (let i = 0; i < data.length; i += 4) {
                        const r_val = data[i], g_val = data[i + 1], b_val = data[i + 2];
                        const brightness = 0.299 * r_val + 0.587 * g_val + 0.114 * b_val;
                        sampled++;
                        if (lightMode) { if (brightness < extremeBrightness) extremeBrightness = brightness; }
                        else { if (brightness > extremeBrightness) extremeBrightness = brightness; }
                    }
                    if (sampled === 0) { resolve(lightMode ? 0 : 255); return; }
                    resolve(extremeBrightness);
                } catch (e) {
                    reject(new Error(`getImageData error: ${e.message}. sx=${sx},sy=${sy},sw=${sWidth},sh=${sHeight},canW=${canvas.width},canH=${canvas.height}`));
                } finally { if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); }
            };
            img.onerror = (e) => { if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); reject(new Error(`Image load error: ${e.message || e.type || 'Unknown'}`)); };
            if (typeof imagePathOrBlob === 'string') img.src = `file://${imagePathOrBlob.replace(/\\/g, '/')}?t=${Date.now()}`;
            else if (imagePathOrBlob instanceof Blob) img.src = URL.createObjectURL(imagePathOrBlob);
            else reject(new Error("Invalid image source."));
        });
    }

    async _getAverageBrightnessFromBlurredImage(imagePathOrBlob) {
        // ... (此方法保持不變)
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
                reject(new Error(`Image load error for average brightness. Source: ${typeof imagePathOrBlob === 'string' ? imagePathOrBlob : 'Blob'}`));
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
        // ... (此方法保持不變)
        if (!windowBounds || typeof windowBounds.x !== 'number' || typeof windowBounds.y !== 'number') {
            if (this.runtimeEnv === 'nwjs' && this.nwWin) {
                windowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
            } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
                try {
                    const syncBounds = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                    if (syncBounds) windowBounds = syncBounds; else { windowBounds = null; }
                } catch (e) { windowBounds = null; }
                if (!windowBounds) return this._getDefaultScreenInfo();
            } else return this._getDefaultScreenInfo();
        }
        const winCX = windowBounds.x + windowBounds.width / 2, winCY = windowBounds.y + windowBounds.height / 2;
        if (this.runtimeEnv === 'nwjs' && this.nwScreen && this.nwScreen.screens) {
            if (this.nwScreen.screens.length === 0) return this._getDefaultScreenInfo();
            for (const s of this.nwScreen.screens) {
                if (s.bounds && s.bounds.width > 0 && s.bounds.height > 0 &&
                    winCX >= s.bounds.x && winCX < (s.bounds.x + s.bounds.width) &&
                    winCY >= s.bounds.y && winCY < (s.bounds.y + s.bounds.height)) return s;
            }
            return this.nwScreen.screens.find(s => s.isBuiltIn && s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens.find(s => s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens[0] || this._getDefaultScreenInfo();
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
        if (this._moveOverlayUpdateTimeoutId) clearTimeout(this._moveOverlayUpdateTimeoutId);

        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            if (this._boundOnMove) this.nwWin.removeListener('move', this._boundOnMove);
            if (this._boundHandleMaximize) this.nwWin.removeListener('maximize', this._boundHandleMaximize);
            if (this._boundHandleUnmaximize) this.nwWin.removeListener('unmaximize', this._boundHandleUnmaximize);
            if (this._boundHandleRestore) this.nwWin.removeListener('restore', this._boundHandleRestore);
            if (this._boundRefreshOnScreenChange && this.nwScreen) {
                this.nwScreen.removeListener('displayBoundsChanged', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayAdded', this._boundRefreshOnScreenChange);
                this.nwScreen.removeListener('displayRemoved', this._boundRefreshOnScreenChange);
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.removeListener('bwb:window-maximized', this._boundHandleMaximize);
            this.electron.ipcRenderer.removeListener('bwb:window-unmaximized', this._boundHandleUnmaximize);
            this.electron.ipcRenderer.removeAllListeners('bwb:window-bounds-updated');
        }
        if (this.overlayElement) this.overlayElement.remove();
        if (this.backgroundHostElement) this.backgroundHostElement.remove();
    }
}

// module.exports = BlurredWindowBackground;