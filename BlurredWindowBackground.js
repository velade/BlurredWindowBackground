// Node.js 核心模塊
const os = require('os');
const fs = require('fs');
const path = require('path');

// 外部依賴
let getWallpaper;
let ImageBlurProcessor;

try {
    getWallpaper = require('./wallpaper.js');
    ImageBlurProcessor = require('./ImageBlurProcessor.js');
} catch (e) {
    console.error("BlurredWindowBackground: 無法加載依賴項。請確保 wallpaper.js 和 ImageBlurProcessor.js 位於同一目錄且兼容 CommonJS。", e);
    // 如果依賴項至關重要，可能需要拋出錯誤或進入降級模式
}

/**
 * @class BlurredWindowBackground
 * @description 自動創建一個帶模糊背景和動態調整透明度遮罩的窗口背景元素。
 * 新版本特性：分步模糊加載，平滑背景切換動畫，優化窗口移動性能。
 * 兼容 NW.js 和 Electron。
 */
class BlurredWindowBackground {
    /**
     * 創建一個 BlurredWindowBackground 實例。
     * @param {object} [options={}] - 配置選項。
     * @param {number} [options.borderRadius=15] - 背景的圓角半徑 (窗口化模式)。
     * @param {number} [options.blurRadius=60] - 背景圖像的模糊半徑 (最終質量)。
     * @param {number} [options.previewBlurRadius=90] - 預覽圖像的模糊半徑。
     * @param {number} [options.previewQualityFactor=0.1] - 預覽圖像的質量/壓縮因子 (0.01-1.0)。影響預覽圖生成速度和大小。
     * @param {number} [options.titleBarHeight=0] - 窗口頂部標題欄或偏移的高度。
     * @param {number} [options.checkIntervalSuccess=1000] - 桌布檢查成功時的更新間隔 (毫秒)。
     * @param {number} [options.checkIntervalError=5000] - 桌布檢查失敗時的重試間隔 (毫秒)。
     * @param {number} [options.imageProcessingZipRate=0.25] - 最終圖像處理比例 (0.01-1.00)。
     * @param {string} [options.elementZIndex='-1'] - 背景視口元素的 z-index。建議為負值使其位於內容之下。
     * @param {number} [options.backgroundTransitionDuration=500] - 背景圖片切換動畫的持續時間 (毫秒)。
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

        this._detectEnvironment();

        let appName = 'DefaultApp';
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            appName = (nw.App.manifest && nw.App.manifest.name) ? nw.App.manifest.name : 'NWJSApp';
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                appName = this.electron.ipcRenderer.sendSync('bwb:get-app-name');
            } catch (e) {
                console.warn("BlurredWindowBackground: 無法通過 IPC 獲取應用程式名稱。使用備用名稱。", e);
                appName = 'ElectronApp';
            }
        }
        const sanitizedAppName = (appName || 'DefaultApp').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'DefaultSanitizedApp';
        this.internalTempSubDir = `bwb_temp_${sanitizedAppName}_rewrite`;
        this.internalBlurredImagePreviewName = 'blurred_wallpaper_preview.webp';
        this.internalBlurredImageFinalName = 'blurred_wallpaper_final.webp';

        this.options = {
            borderRadius: 15,
            blurRadius: 60,
            previewBlurRadius: 90,
            previewQualityFactor: 0.1,
            titleBarHeight: 0,
            checkIntervalSuccess: 1000,
            checkIntervalError: 5000,
            imageProcessingZipRate: 0.25,
            elementZIndex: '-1',
            backgroundTransitionDuration: 500,
            dynamicOverlay: {
                enable: true,
                baseColorRGB: [252, 252, 252],
                minAlpha: 0.5,
                maxAlpha: 0.75,
                brightnessThresholdLow: 70,
                brightnessThresholdHigh: 180,
                lightMode: true,
            },
            ...options
        };
        if (options.dynamicOverlay) {
            this.options.dynamicOverlay = { ...this.options.dynamicOverlay, ...options.dynamicOverlay };
        }

        this.appRootDir = this._getAppRootDir();
        this.tempDir = this._getTemporaryDirectory();

        this.blurredImagePreviewPath = this.tempDir ? path.join(this.tempDir, this.internalBlurredImagePreviewName) : null;
        this.blurredImageFinalPath = this.tempDir ? path.join(this.tempDir, this.internalBlurredImageFinalName) : null;

        this.currentOriginalWallpaperPath = null;
        this.lastAppliedImagePath = null;
        this.currentAppliedCssUrl = null;

        this.viewportElement = null;
        this.backgroundContainer = null;
        this.overlayElement = null;

        this._isMaximized = false;
        this._isFullScreen = false;
        this._currentWindowBounds = { x: 0, y: 0, width: 0, height: 0 };
        this._currentScreenBounds = { x: 0, y: 0, width: 0, height: 0 };
        this._rAFId = null;
        this._moveUpdateTimeoutId = null;
        this._wallpaperCheckTimeoutId = null;
        this._isTransitioningBackground = false;
        this._pendingImageForTransition = null;
        this._activeWallpaperFlowId = 0; // 用於標識當前激活的壁紙處理流程
        this.styleElementId = 'bwb-styles';

        this._initialize();
    }

    _detectEnvironment() {
        if (typeof nw !== 'undefined' && nw.Window && nw.Screen) {
            this.runtimeEnv = 'nwjs';
            this.nwWin = nw.Window.get();
            this.nwScreen = nw.Screen;
        } else if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
            this.runtimeEnv = 'electron';
            try {
                this.electron = require('electron');
                if (!this.electron.ipcRenderer) {
                    console.warn("BlurredWindowBackground: 檢測到 Electron 環境，但 ipcRenderer 不可用。此腳本應在渲染進程中運行。");
                    this.runtimeEnv = 'unknown_error_electron_ipc';
                    return;
                }
            } catch (e) {
                console.error("BlurredWindowBackground: 在渲染器中加載 Electron 模塊失敗。", e);
                this.runtimeEnv = 'unknown_error_electron_load';
            }
        } else {
            console.error("BlurredWindowBackground: 無法識別運行時環境 (NW.js 或 Electron)。");
        }
    }

    _getAppRootDir() {
        if (this.runtimeEnv === 'nwjs') {
            return path.dirname(process.execPath);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                return this.electron.ipcRenderer.sendSync('bwb:get-app-path');
            } catch (e) {
                console.warn("BlurredWindowBackground: 無法通過 IPC 獲取應用程式路徑。使用備用路徑 '.'。", e);
                return '.';
            }
        }
        return '.';
    }

    _getTemporaryDirectory() {
        if (!this.appRootDir) {
            console.error("BlurredWindowBackground: 在獲取臨時目錄之前 appRootDir 尚未初始化。");
            return null;
        }
        let tempPathBase;
        if (this.runtimeEnv === 'nwjs') {
            tempPathBase = os.tmpdir();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                tempPathBase = this.electron.ipcRenderer.sendSync('bwb:get-path', 'temp');
            } catch (e) {
                console.warn("BlurredWindowBackground: 無法通過 IPC 獲取臨時路徑。使用 os.tmpdir()。", e);
                tempPathBase = os.tmpdir();
            }
        } else {
            tempPathBase = os.tmpdir();
        }

        if (typeof tempPathBase !== 'string' || tempPathBase.trim() === '') {
            console.warn("BlurredWindowBackground: 無效的基礎臨時路徑。使用應用程式根目錄的子文件夾作為備用基礎路徑。");
            tempPathBase = this.appRootDir;
        }

        const tempPath = path.join(tempPathBase, this.internalTempSubDir);

        try {
            if (!fs.existsSync(tempPath)) {
                fs.mkdirSync(tempPath, { recursive: true });
            }
            const testFile = path.join(tempPath, `_bwb_write_test_${Date.now()}`);
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            return tempPath;
        } catch (error) {
            console.warn(`BlurredWindowBackground: 主要臨時目錄 "${tempPath}" 不可用 (錯誤: ${error.message})。嘗試使用應用程式根目錄中的備用目錄。`);
            try {
                const fallbackTempPath = path.join(this.appRootDir, this.internalTempSubDir);
                if (!fs.existsSync(fallbackTempPath)) {
                    fs.mkdirSync(fallbackTempPath, { recursive: true });
                }
                const testFileFallback = path.join(fallbackTempPath, `_bwb_write_test_fallback_${Date.now()}`);
                fs.writeFileSync(testFileFallback, 'test_fallback');
                fs.unlinkSync(testFileFallback);
                console.log("BlurredWindowBackground: 使用應用程式根目錄中的備用臨時目錄:", fallbackTempPath);
                return fallbackTempPath;
            } catch (fallbackError) {
                console.error(`BlurredWindowBackground: 備用臨時目錄 "${path.join(this.appRootDir, this.internalTempSubDir)}" 同樣不可用 (錯誤: ${fallbackError.message})。背景生成可能會失敗。`);
                return null;
            }
        }
    }

    async _initialize() {
        if (!this.tempDir) {
            console.error("BlurredWindowBackground: 由於沒有可用的臨時目錄，初始化中止。");
            return;
        }
        if (!getWallpaper || !ImageBlurProcessor) {
            console.error("BlurredWindowBackground: 由於缺少關鍵依賴項 (getWallpaper 或 ImageBlurProcessor)，初始化中止。");
            return;
        }

        this._injectStyles();
        this._createDOM();
        await this._updateWindowState();
        this._updateViewportStyles();
        this._setupEventListeners();
        this.updateAndApplyBlurredWallpaper(true, true); // 初始加載時強制重新生成以確保 flowId 被正確設置
    }

    _injectStyles() {
        const existingStyleElement = document.getElementById(this.styleElementId);
        if (existingStyleElement) {
            existingStyleElement.remove();
        }

        const styleElement = document.createElement('style');
        styleElement.id = this.styleElementId;
        styleElement.innerHTML = `
            #bwb-viewport {
                position: fixed;
                inset: 0px;
                overflow: hidden;
                z-index: ${this.options.elementZIndex}; 
                margin: 5px;
                box-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
                border-radius: ${this.options.borderRadius}px;
                transition: margin ${this.options.backgroundTransitionDuration / 1000}s ease-in-out,
                            box-shadow ${this.options.backgroundTransitionDuration / 1000}s ease-in-out,
                            border-radius ${this.options.backgroundTransitionDuration / 1000}s ease-in-out;
            }
            #bwb-background-container {
                position: absolute;
                top: 0px;
                left: 0px;
                width: 100vw; 
                height: 100vh; 
                will-change: transform, background-image;
                background-repeat: no-repeat;
                background-position: 0 0;
                background-size: cover;
                transition: background-image ${this.options.backgroundTransitionDuration}ms ease-in-out;
                background-color: rgba(${this.options.dynamicOverlay.baseColorRGB.join(',')}, 1); 
            }
            #bwb-overlay {
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                pointer-events: none;
                transition: background-color ${this.options.backgroundTransitionDuration}ms ease-out;
            }
        `;
        document.head.appendChild(styleElement);
    }


    _createDOM() {
        this.viewportElement = document.createElement('div');
        this.viewportElement.id = 'bwb-viewport';

        this.backgroundContainer = document.createElement('div');
        this.backgroundContainer.id = 'bwb-background-container';

        this.viewportElement.appendChild(this.backgroundContainer);

        if (this.options.dynamicOverlay.enable) {
            this.overlayElement = document.createElement('div');
            this.overlayElement.id = 'bwb-overlay';
            const { baseColorRGB, maxAlpha } = this.options.dynamicOverlay;
            this.overlayElement.style.backgroundColor = `rgba(${baseColorRGB.join(',')}, ${maxAlpha})`;
            this.viewportElement.appendChild(this.overlayElement);
        }
        document.body.appendChild(this.viewportElement);
    }

    _setupEventListeners() {
        // ... (此方法保持不變)
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.nwWin.on('maximize', this._handleWindowStateChange.bind(this));
            this.nwWin.on('unmaximize', this._handleWindowStateChange.bind(this));
            this.nwWin.on('restore', this._handleWindowStateChange.bind(this));
            this.nwWin.on('enter-fullscreen', this._handleWindowStateChange.bind(this));
            this.nwWin.on('leave-fullscreen', this._handleWindowStateChange.bind(this));
            this.nwWin.on('move', this._onWindowBoundsChange.bind(this));
            this.nwWin.on('resize', this._onWindowBoundsChange.bind(this));
            if (this.nwScreen) {
                this.nwScreen.on('displayBoundsChanged', this._onDisplayMetricsChange.bind(this));
                this.nwScreen.on('displayAdded', this._onDisplayMetricsChange.bind(this));
                this.nwScreen.on('displayRemoved', this._onDisplayMetricsChange.bind(this));
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.on('bwb:window-maximized', this._handleWindowStateChange.bind(this));
            this.electron.ipcRenderer.on('bwb:window-unmaximized', this._handleWindowStateChange.bind(this));
            this.electron.ipcRenderer.on('bwb:window-fullscreen-changed', (event, isFullScreen) => this._handleWindowStateChange());
            this.electron.ipcRenderer.on('bwb:window-bounds-updated', (event, newBounds) => {
                this._currentWindowBounds = newBounds;
                this._onWindowBoundsChange();
            });
            this.electron.ipcRenderer.on('bwb:display-metrics-changed', this._onDisplayMetricsChange.bind(this));
        }
        window.addEventListener('resize', this._onWindowBoundsChange.bind(this));
    }

    async _updateWindowState() {
        // ... (此方法保持不變)
        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this._isMaximized = this.nwWin.state === 'maximized';
            this._isFullScreen = this.nwWin.isFullscreen;
            this._currentWindowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                this._isMaximized = await this.electron.ipcRenderer.invoke('bwb:get-window-is-maximized');
                this._isFullScreen = await this.electron.ipcRenderer.invoke('bwb:get-window-is-fullscreen');
                this._currentWindowBounds = await this.electron.ipcRenderer.invoke('bwb:get-window-bounds');
            } catch (e) {
                console.error("BlurredWindowBackground: 從主進程獲取窗口狀態時出錯。", e);
            }
        }
        const screen = this._getCurrentScreenForWindow(this._currentWindowBounds);
        this._currentScreenBounds = screen ? screen.bounds : { x: 0, y: 0, width: window.screen.width, height: window.screen.height };
    }

    async _handleWindowStateChange() {
        // ... (此方法保持不變)
        await this._updateWindowState();
        this._updateViewportStyles();
        this._updateBackgroundPosition();
        await this._updateOverlayBasedOnCurrentPosition();
    }

    _updateViewportStyles() {
        // ... (此方法保持不變)
        if (!this.viewportElement) return;
        const s = this.viewportElement.style;
        const isMaxOrFs = this._isMaximized || this._isFullScreen;
        s.margin = isMaxOrFs ? '0px' : '5px';
        s.boxShadow = isMaxOrFs ? 'none' : `0 0 5px rgba(0, 0, 0, 0.5)`;
        s.borderRadius = isMaxOrFs ? '0px' : `${this.options.borderRadius}px`;
        this._updateBackgroundContainerSize();
    }

    _updateBackgroundContainerSize() {
        // ... (此方法保持不變)
        if (!this.backgroundContainer || !this._currentScreenBounds) return;
        const screenWidth = `${this._currentScreenBounds.width}px`;
        const screenHeight = `${this._currentScreenBounds.height}px`;
        if (this.backgroundContainer.style.width !== screenWidth) {
            this.backgroundContainer.style.width = screenWidth;
        }
        if (this.backgroundContainer.style.height !== screenHeight) {
            this.backgroundContainer.style.height = screenHeight;
        }
    }

    async _onWindowBoundsChange() {
        // ... (此方法保持不變)
        await this._updateWindowState();
        this._updateBackgroundPosition();
        if (this._moveUpdateTimeoutId) clearTimeout(this._moveUpdateTimeoutId);
        this._moveUpdateTimeoutId = setTimeout(async () => {
            if (this.lastAppliedImagePath && fs.existsSync(this.lastAppliedImagePath)) {
                await this._updateOverlayBasedOnCurrentPosition();
            }
        }, 150);
    }

    async _onDisplayMetricsChange() {
        console.log("BlurredWindowBackground: 顯示指標已更改。重新評估壁紙。");
        // 不再在此處遞增 _activeWallpaperFlowId，交給 updateAndApplyBlurredWallpaper 判斷是否需要新流程
        await this._updateWindowState();
        this._updateViewportStyles();
        this.updateAndApplyBlurredWallpaper(false);
    }

    _updateBackgroundPosition() {
        // ... (此方法保持不變)
        if (this._rAFId) cancelAnimationFrame(this._rAFId);
        this._rAFId = requestAnimationFrame(() => {
            if (!this.backgroundContainer || !this._currentWindowBounds || !this._currentScreenBounds) return;
            const margin = (this._isMaximized || this._isFullScreen) ? 0 : 5;
            const translateX = -(this._currentWindowBounds.x - this._currentScreenBounds.x + margin);
            const translateY = -(this._currentWindowBounds.y - this._currentScreenBounds.y + margin + this.options.titleBarHeight);
            const newTransform = `translate(${translateX}px, ${translateY}px)`;
            if (this.backgroundContainer.style.transform !== newTransform) {
                this.backgroundContainer.style.transform = newTransform;
            }
            this._rAFId = null;
        });
    }

    async updateAndApplyBlurredWallpaper(isInitialLoad = false, forceRegenerate = false) {
        if (this._wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        if (!this.tempDir) {
            console.error("BlurredWindowBackground: 無法更新壁紙，沒有臨時目錄。");
            this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
            return;
        }

        const localFlowId = this._activeWallpaperFlowId; // 捕獲當前流程 ID

        try {
            const newOriginalPath = await getWallpaper();
            if (!newOriginalPath) {
                console.warn(`[Flow ${localFlowId}] BlurredWindowBackground: 無法獲取壁紙路徑。`);
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            // 檢查此流程是否已過期 (例如，由 _onDisplayMetricsChange 觸發了新流程)
            if (localFlowId !== this._activeWallpaperFlowId && !isInitialLoad) { // 初始加載時，即使 flowId 變了也應繼續
                console.log(`[Flow ${localFlowId}] BlurredWindowBackground: 壁紙更新流程已過期 (當前激活: ${this._activeWallpaperFlowId})，中止。`);
                return;
            }

            await this._updateWindowState();
            this._updateBackgroundContainerSize();

            const screenWidth = this._currentScreenBounds.width;
            const screenHeight = this._currentScreenBounds.height;

            if (screenWidth <= 0 || screenHeight <= 0) {
                console.warn(`[Flow ${localFlowId}] BlurredWindowBackground: 無效的屏幕尺寸，無法處理壁紙。`);
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            const wallpaperChanged = newOriginalPath !== this.currentOriginalWallpaperPath;

            // 只有當壁紙路徑真正改變或被強制重新生成時，才更新 flowId 並重置 currentOriginalWallpaperPath
            if (wallpaperChanged || forceRegenerate) {
                if (!isInitialLoad || wallpaperChanged) { // 避免初始加載時不必要的 flowId 增加，除非壁紙真的變了
                    this._activeWallpaperFlowId++;
                }
                this.currentOriginalWallpaperPath = newOriginalPath;
                console.log(`[Flow ${this._activeWallpaperFlowId}] BlurredWindowBackground: 壁紙已更改或強制重新生成。新路徑: ${newOriginalPath}`);
            }
            // 使用更新後的 flowId 進行後續操作
            const currentActiveFlowId = this._activeWallpaperFlowId;


            const previewExists = this.blurredImagePreviewPath ? fs.existsSync(this.blurredImagePreviewPath) : false;
            const finalExists = this.blurredImageFinalPath ? fs.existsSync(this.blurredImageFinalPath) : false;

            if (!forceRegenerate && !wallpaperChanged && finalExists && !isInitialLoad) {
                console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 壁紙路徑未更改且最終圖像已存在。`);
                const finalCssUrl = this.blurredImageFinalPath ? this._pathToCssUrl(this.blurredImageFinalPath) : 'none';
                if (this.currentAppliedCssUrl !== finalCssUrl && this.blurredImageFinalPath) {
                    console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 當前活動的不是最終圖像，重新應用最終圖像。`);
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId);
                } else {
                    if (currentActiveFlowId === this._activeWallpaperFlowId) await this._updateOverlayBasedOnCurrentPosition();
                }
                this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
                return;
            }

            // 判斷是否真的需要生成圖像 (基於 forceRegenerate, wallpaperChanged, 或文件缺失)
            const needsProcessing = forceRegenerate || wallpaperChanged || !previewExists || !finalExists;

            if (needsProcessing) {
                console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 需要處理圖像。`);
                const trulyForceImageGen = forceRegenerate || wallpaperChanged; // 用於 _generateBlurredImage
                let previewAppliedInThisFlow = false;

                const previewTargetSize = [screenWidth, screenHeight];
                console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 開始生成預覽圖...`);
                const previewGenerated = this.blurredImagePreviewPath ? await this._generateBlurredImage(
                    newOriginalPath, this.blurredImagePreviewPath, this.options.previewBlurRadius,
                    this.options.previewQualityFactor, previewTargetSize, true,
                    trulyForceImageGen || !previewExists
                ) : false;

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                if (previewGenerated && this.blurredImagePreviewPath && fs.existsSync(this.blurredImagePreviewPath)) {
                    console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 預覽圖生成成功，嘗試應用...`);
                    await this._applyBackgroundImage(this.blurredImagePreviewPath, currentActiveFlowId);
                    previewAppliedInThisFlow = true;
                    console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 預覽圖應用流程完成。`);
                } else {
                    console.warn(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 預覽圖生成失敗或文件不存在。`);
                }

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                const finalTargetSize = [screenWidth, screenHeight];
                console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 開始生成正式圖...`);
                const finalGenerated = this.blurredImageFinalPath ? await this._generateBlurredImage(
                    newOriginalPath, this.blurredImageFinalPath, this.options.blurRadius,
                    this.options.imageProcessingZipRate, finalTargetSize, false,
                    trulyForceImageGen || !finalExists
                ) : false;

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                if (finalGenerated && this.blurredImageFinalPath && fs.existsSync(this.blurredImageFinalPath)) {
                    console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 正式圖生成成功，嘗試應用...`);
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId);
                    console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 正式圖應用流程完成。`);
                } else {
                    console.warn(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 正式圖生成失敗或文件不存在。`);
                    if (!previewAppliedInThisFlow && this.backgroundContainer) {
                        this.backgroundContainer.style.backgroundImage = 'none';
                        this.currentAppliedCssUrl = 'none';
                    }
                }
            } else if (isInitialLoad) {
                // 初始加載，但壁紙未變且預覽和最終圖都存在 (此分支邏輯上可能與上面重疊，但保留以明確處理初始狀態)
                console.log(`[Flow ${currentActiveFlowId}] BlurredWindowBackground: 初始加載，壁紙路徑未更改，但仍應用現有圖像（如果存在）。`);
                if (this.blurredImageFinalPath && fs.existsSync(this.blurredImageFinalPath)) {
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId);
                } else if (this.blurredImagePreviewPath && fs.existsSync(this.blurredImagePreviewPath)) {
                    await this._applyBackgroundImage(this.blurredImagePreviewPath, currentActiveFlowId);
                }
            }

            if (currentActiveFlowId === this._activeWallpaperFlowId) {
                await this._updateOverlayBasedOnCurrentPosition();
                this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
            }

        } catch (error) {
            console.error(`[Flow ${localFlowId}] BlurredWindowBackground: 更新壁紙時出錯 (${this.runtimeEnv}):`, error);
            if (localFlowId === this._activeWallpaperFlowId) {
                this.currentOriginalWallpaperPath = null;
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
            }
        }
    }

    async _generateBlurredImage(sourcePath, outputPath, blurRadius, qualityOrZipRate, targetSize, isPreview, forceGenerateThisImage = false) {
        // ... (此方法保持不變)
        if (!ImageBlurProcessor) {
            console.error("BlurredWindowBackground: ImageBlurProcessor 未加載。");
            return false;
        }
        if (!this.tempDir || !outputPath) {
            console.error("BlurredWindowBackground: 沒有用於模糊圖像的臨時目錄或輸出路徑。");
            return false;
        }
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            console.error(`BlurredWindowBackground: 源壁紙路徑不存在: ${sourcePath}`);
            return false;
        }

        if (!forceGenerateThisImage && fs.existsSync(outputPath)) {
            return true;
        }

        try {
            const processor = new ImageBlurProcessor(sourcePath, targetSize, qualityOrZipRate, true);
            const blurredBlobInstance = await processor.blurImage(blurRadius, 'image/webp');

            if (blurredBlobInstance && blurredBlobInstance.blob) {
                await blurredBlobInstance.toFile(outputPath);
                return true;
            } else {
                console.warn(`BlurredWindowBackground: 圖像處理未能為 ${isPreview ? '預覽' : '最終'} 返回 blob。`);
                return false;
            }
        } catch (err) {
            console.error(`BlurredWindowBackground: 生成 ${isPreview ? '預覽' : '最終'} 模糊圖像時出錯 (${outputPath}):`, err);
            return false;
        }
    }

    _pathToCssUrl(filePath) {
        // ... (此方法保持不變)
        if (!filePath) return 'none';
        let mtime = Date.now();
        try {
            if (fs.existsSync(filePath)) {
                mtime = fs.statSync(filePath).mtime.getTime();
            }
        } catch (e) { /* 忽略 */ }
        return `url('${filePath.replace(/\\/g, '/')}?t=${mtime}')`;
    }

    _applyBackgroundImage(newImagePath, flowId) {
        // ... (此方法保持不變)
        return new Promise(async (resolve) => {
            if (flowId !== undefined && flowId !== this._activeWallpaperFlowId) {
                resolve(false);
                return;
            }

            if (!this.backgroundContainer) {
                console.error(`[Flow ${flowId}] BG Apply: backgroundContainer 不存在。無法應用 ${newImagePath}。`);
                resolve(false);
                return;
            }

            if (this._isTransitioningBackground) {
                this._pendingImageForTransition = newImagePath;
                resolve(false);
                return;
            }

            if (!newImagePath || !fs.existsSync(newImagePath)) {
                console.warn(`[Flow ${flowId}] BG Apply: 圖像路徑不存在: ${newImagePath}`);
                if (this.currentAppliedCssUrl && this.currentAppliedCssUrl.includes(newImagePath.replace(/\\/g, '/'))) {
                    this.currentAppliedCssUrl = null;
                }
                resolve(false);
                return;
            }

            const newCssUrl = this._pathToCssUrl(newImagePath);

            if (this.currentAppliedCssUrl === newCssUrl) {
                this.lastAppliedImagePath = newImagePath;
                if (flowId === this._activeWallpaperFlowId) await this._updateOverlayBasedOnCurrentPosition();
                resolve(true);
                return;
            }

            this._updateBackgroundPosition(); // 在應用新背景前更新位置，確保過渡基於正確的定位

            this._isTransitioningBackground = true;
            this.lastAppliedImagePath = newImagePath;

            this.backgroundContainer.style.backgroundImage = newCssUrl;

            const transitionEndHandler = async () => {
                this.backgroundContainer.removeEventListener('transitionend', transitionEndHandler);

                // 即使 flowId 過期，如果應用的是最終圖像，我們可能仍然希望完成它
                // 但如果不是最終圖像，則中止
                if (flowId !== undefined && flowId !== this._activeWallpaperFlowId && !(this.blurredImageFinalPath && newImagePath === this.blurredImageFinalPath)) {
                    this._isTransitioningBackground = false;
                    if (this._pendingImageForTransition) {
                        const pathForNext = this._pendingImageForTransition;
                        this._pendingImageForTransition = null;
                        setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                    }
                    resolve(false);
                    return;
                }

                this.currentAppliedCssUrl = newCssUrl;
                this._isTransitioningBackground = false;

                if (this._pendingImageForTransition) {
                    const pathForNext = this._pendingImageForTransition;
                    this._pendingImageForTransition = null;
                    setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                } else {
                    if (flowId === this._activeWallpaperFlowId) await this._updateOverlayBasedOnCurrentPosition();
                }
                resolve(true);
            };

            this.backgroundContainer.addEventListener('transitionend', transitionEndHandler, { once: true });

            const timeoutId = setTimeout(() => {
                if (this._isTransitioningBackground) {
                    this.backgroundContainer.removeEventListener('transitionend', transitionEndHandler);
                    this.currentAppliedCssUrl = newCssUrl;
                    this._isTransitioningBackground = false;
                    if (this._pendingImageForTransition) {
                        const pathForNext = this._pendingImageForTransition;
                        this._pendingImageForTransition = null;
                        setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                    } else {
                        if (flowId === this._activeWallpaperFlowId) this._updateOverlayBasedOnCurrentPosition();
                    }
                    resolve(true);
                }
            }, this.options.backgroundTransitionDuration + 50);

            this.backgroundContainer.addEventListener('transitionend', () => clearTimeout(timeoutId), { once: true });
        });
    }

    async _updateOverlayBasedOnCurrentPosition() {
        // ... (此方法保持不變)
        if (!this.options.dynamicOverlay.enable || !this.overlayElement || !this.lastAppliedImagePath || !fs.existsSync(this.lastAppliedImagePath)) {
            if (this.options.dynamicOverlay.enable && this.overlayElement) {
                const { baseColorRGB, maxAlpha } = this.options.dynamicOverlay;
                this._applyOverlayColor(`rgba(${baseColorRGB.join(',')}, ${maxAlpha})`);
            }
            return;
        }

        const winBounds = this._currentWindowBounds;
        if (!winBounds || winBounds.width <= 0 || winBounds.height <= 0) return;

        const screenBounds = this._currentScreenBounds;
        if (!screenBounds || screenBounds.width <= 0 || screenBounds.height <= 0) return;

        try {
            const extremeBrightness = await this._getExtremeBrightnessFromWindowRegion(
                this.lastAppliedImagePath,
                winBounds,
                screenBounds,
                (this._isMaximized || this._isFullScreen) ? 0 : 5,
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
            console.warn("BlurredWindowBackground: 計算遮罩亮度時出錯:", brightnessError);
            const { baseColorRGB, maxAlpha } = this.options.dynamicOverlay;
            this._applyOverlayColor(`rgba(${baseColorRGB.join(',')}, ${maxAlpha})`);
        }
    }

    _applyOverlayColor(cssColor) {
        // ... (此方法保持不變)
        if (this.overlayElement && this.overlayElement.style.backgroundColor !== cssColor) {
            this.overlayElement.style.backgroundColor = cssColor;
        }
    }

    async _getExtremeBrightnessFromWindowRegion(imagePathOrBlob, windowBounds, screenBoundsOfWindow, currentPadding, titleBarHeightOption, lightMode, zipRate) {
        // ... (此方法保持不變)
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth;
                canvas.height = img.naturalHeight;

                if (canvas.width === 0 || canvas.height === 0) { reject(new Error("用於亮度檢查的圖像尺寸為零。")); return; }

                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) { reject(new Error("無法獲取用於亮度檢查的畫布 2d 上下文")); return; }
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

                const cropX_on_wallpaper = (windowBounds.x - screenBoundsOfWindow.x + currentPadding);
                const cropY_on_wallpaper = (windowBounds.y - screenBoundsOfWindow.y + currentPadding + titleBarHeightOption);
                const cropWidth_on_wallpaper = windowBounds.width - (2 * currentPadding);
                const cropHeight_on_wallpaper = windowBounds.height - (2 * currentPadding) - titleBarHeightOption;

                let sx = Math.round(cropX_on_wallpaper);
                let sy = Math.round(cropY_on_wallpaper);
                let sWidth = Math.round(cropWidth_on_wallpaper);
                let sHeight = Math.round(cropHeight_on_wallpaper);

                sx = Math.max(0, Math.min(sx, canvas.width));
                sy = Math.max(0, Math.min(sy, canvas.height));
                sWidth = Math.floor(Math.max(0, Math.min(sWidth, canvas.width - sx)));
                sHeight = Math.floor(Math.max(0, Math.min(sHeight, canvas.height - sy)));

                if (sWidth <= 0 || sHeight <= 0) {
                    console.warn("BlurredWindowBackground: 亮度計算區域大小為零或負數。", { sx, sy, sWidth, sHeight, canvasW: canvas.width, canvasH: canvas.height });
                    resolve(lightMode ? 0 : 255);
                    return;
                }
                try {
                    const imageData = ctx.getImageData(sx, sy, sWidth, sHeight);
                    const data = imageData.data;
                    const pixels = data.length / 4;
                    if (pixels === 0) { resolve(lightMode ? 0 : 255); return; }

                    let extremeBrightness = lightMode ? 255 : 0;
                    let sampledCount = 0;
                    const sampleStride = Math.max(1, Math.floor(pixels / 20000)) * 4;

                    for (let i = 0; i < data.length; i += sampleStride) {
                        const r_val = data[i], g_val = data[i + 1], b_val = data[i + 2];
                        const brightness = 0.299 * r_val + 0.587 * g_val + 0.114 * b_val;
                        sampledCount++;
                        if (lightMode) {
                            if (brightness < extremeBrightness) extremeBrightness = brightness;
                        } else {
                            if (brightness > extremeBrightness) extremeBrightness = brightness;
                        }
                    }
                    if (sampledCount === 0) { resolve(lightMode ? 0 : 255); return; }
                    resolve(extremeBrightness);
                } catch (e) {
                    reject(new Error(`用於亮度的 getImageData 錯誤: ${e.message}。區域: sx=${sx},sy=${sy},sw=${sWidth},sh=${sHeight}。畫布: ${canvas.width}x${canvas.height}`));
                } finally {
                    if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) {
                        URL.revokeObjectURL(img.src);
                    }
                }
            };
            img.onerror = (e) => {
                if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) {
                    URL.revokeObjectURL(img.src);
                }
                reject(new Error(`用於亮度檢查的圖像加載錯誤: ${e.message || e.type || '未知'}。路徑: ${imagePathOrBlob}`));
            };

            if (typeof imagePathOrBlob === 'string') {
                let mtime = Date.now();
                try { if (fs.existsSync(imagePathOrBlob)) mtime = fs.statSync(imagePathOrBlob).mtime.getTime(); } catch (err) { /* 忽略 */ }
                img.src = `${imagePathOrBlob.replace(/\\/g, '/')}?t=${mtime}`;
            } else if (imagePathOrBlob instanceof Blob) {
                img.src = URL.createObjectURL(imagePathOrBlob);
            } else {
                reject(new Error("用於亮度檢查的圖像源無效。"));
            }
        });
    }


    _scheduleNextWallpaperCheck(delay) {
        // ... (此方法保持不變)
        if (this._wallpaperCheckTimeoutId) clearTimeout(this._wallpaperCheckTimeoutId);
        this._wallpaperCheckTimeoutId = setTimeout(() => this.updateAndApplyBlurredWallpaper(), delay);
    }

    _getCurrentScreenForWindow(windowBounds) {
        // ... (此方法保持不變)
        if (!windowBounds || typeof windowBounds.x !== 'number' || typeof windowBounds.y !== 'number') {
            if (this.runtimeEnv === 'nwjs' && this.nwWin) {
                windowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
            } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
                try {
                    windowBounds = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync');
                } catch (e) { /* 忽略 */ }
            }
            if (!windowBounds || windowBounds.width <= 0) return this._getDefaultScreenInfo();
        }

        const winCX = windowBounds.x + windowBounds.width / 2;
        const winCY = windowBounds.y + windowBounds.height / 2;

        if (this.runtimeEnv === 'nwjs' && this.nwScreen && this.nwScreen.screens) {
            if (this.nwScreen.screens.length === 0) return this._getDefaultScreenInfo();
            for (const s of this.nwScreen.screens) {
                if (s.bounds && s.bounds.width > 0 && s.bounds.height > 0 &&
                    winCX >= s.bounds.x && winCX < (s.bounds.x + s.bounds.width) &&
                    winCY >= s.bounds.y && winCY < (s.bounds.y + s.bounds.height)) return s;
            }
            return this.nwScreen.screens.find(s => s.isBuiltIn && s.bounds && s.bounds.width > 0) ||
                this.nwScreen.screens.find(s => s.bounds && s.bounds.width > 0) ||
                (this.nwScreen.screens.length > 0 ? this.nwScreen.screens[0] : this._getDefaultScreenInfo());
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.screen) {
            let activeScreen = this.electron.screen.getDisplayNearestPoint({ x: Math.round(winCX), y: Math.round(winCY) });
            if (!activeScreen || !activeScreen.bounds || activeScreen.bounds.width <= 0 || activeScreen.bounds.height <= 0) {
                activeScreen = this.electron.screen.getPrimaryDisplay();
            }
            return activeScreen || this._getDefaultScreenInfo();
        }
        return this._getDefaultScreenInfo();
    }

    _getDefaultScreenInfo() {
        // ... (此方法保持不變)
        return {
            bounds: { x: 0, y: 0, width: window.screen.width || 1920, height: window.screen.height || 1080, scaleFactor: window.devicePixelRatio || 1 },
        };
    }

    destroy() {
        // ... (此方法保持不變)
        this._activeWallpaperFlowId++;
        if (this._rAFId) cancelAnimationFrame(this._rAFId);
        if (this._wallpaperCheckTimeoutId) clearTimeout(this.wallpaperCheckTimeoutId);
        if (this._moveUpdateTimeoutId) clearTimeout(this._moveUpdateTimeoutId);

        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.nwWin.removeAllListeners('maximize');
            this.nwWin.removeAllListeners('unmaximize');
            this.nwWin.removeAllListeners('restore');
            this.nwWin.removeAllListeners('enter-fullscreen');
            this.nwWin.removeAllListeners('leave-fullscreen');
            this.nwWin.removeAllListeners('move');
            this.nwWin.removeAllListeners('resize');
            if (this.nwScreen) {
                this.nwScreen.removeAllListeners('displayBoundsChanged');
                this.nwScreen.removeAllListeners('displayAdded');
                this.nwScreen.removeAllListeners('displayRemoved');
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.removeAllListeners('bwb:window-maximized');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-unmaximized');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-fullscreen-changed');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-bounds-updated');
            this.electron.ipcRenderer.removeAllListeners('bwb:display-metrics-changed');
        }
        window.removeEventListener('resize', this._onWindowBoundsChange.bind(this));

        if (this.viewportElement) {
            this.viewportElement.remove();
            this.viewportElement = null;
        }

        this.backgroundContainer = null;
        this.overlayElement = null;
        this.currentOriginalWallpaperPath = null;
        this.lastAppliedImagePath = null;
        this.currentAppliedCssUrl = null;

        const styleElement = document.getElementById(this.styleElementId);
        if (styleElement) {
            styleElement.remove();
        }

        console.log("BlurredWindowBackground: 實例已銷毀。");
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BlurredWindowBackground;
} else if (typeof window !== 'undefined') {
    window.BlurredWindowBackground = BlurredWindowBackground;
}
