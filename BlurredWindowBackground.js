// Node.js 核心模塊
const os = require('os');
const fs = require('fs');
const path = require('path');

// 外部依賴
let getWallpaper;
let ImageBlurProcessor;

// 自訂日誌樣式常量
const BWB_LOG_STYLE_BWB = "background-color: black; color:white;padding: 0 5px; border-radius: 1000px 0 0 1000px;";
const BWB_LOG_STYLE_RESET = ""; // 用於換行、縮進或僅消耗 %c

// 錯誤日誌樣式
const BWB_ERROR_STYLE_ERROR = "background-color: red; color:white;padding: 0 5px; border-radius: 0 1000px 1000px 0;";
const BWB_ERROR_STYLE_FUNC = "background-color: red; color:white;padding: 0 5px; border-radius: 1000px;";

// 警告日誌樣式
const BWB_WARN_STYLE_WARNING = "background-color: orange; color:black;padding: 0 5px; border-radius: 0 1000px 1000px 0;";
const BWB_WARN_STYLE_FUNC = "background-color: orange; color:black;padding: 0 5px; border-radius: 1000px;";


try {
    getWallpaper = require('./wallpaper.js');
    ImageBlurProcessor = require('./ImageBlurProcessor.js');
} catch (e) {
    const intentName = "依賴載入"; // Dependency Loading
    const message = "無法加載依賴項。請確保 wallpaper.js 和 ImageBlurProcessor.js 位於同一目錄且兼容 CommonJS。";
    console.error(`%cBWB%cError%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
}

/**
 * @class BlurredWindowBackground
 * @description 自動創建一個帶模糊背景和動態調整透明度遮罩的窗口背景元素。
 */
class BlurredWindowBackground {
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
                const intentName = "獲取應用資訊"; // Get App Info
                const message = "無法通過 IPC 獲取應用程式名稱。使用備用名稱。";
                console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
                appName = 'ElectronApp';
            }
        }
        const sanitizedAppName = (appName || 'DefaultApp').replace(/[^a-zA-Z0-9_.-]/g, '_') || 'DefaultSanitizedApp';
        this.internalTempSubDir = `bwb_temp_${sanitizedAppName}_rewrite`;
        this.internalBlurredImagePreviewName = 'blurred_wallpaper_preview.webp';
        this.internalBlurredImageFinalName = 'blurred_wallpaper_final.webp';
        this.internalMetadataFileName = 'bwb_metadata.json';

        this._isSystemInDarkMode = false;
        this._realMode = true;
        this._realColorRGB = null;
        this._darkModeMatcher = null;
        this._handleSystemThemeChangeForNWJS = null;
        this._handleSystemThemeChangeForElectron = null;
        this._lastKnownScreenDimensions = { width: 0, height: 0 };

        const defaultOptions = {
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
                lightColorRGB: [252, 252, 252],
                darkColorRGB: [30, 30, 30],
                minAlpha: 0.5,
                maxAlpha: 0.75,
                brightnessThresholdLow: 70,
                brightnessThresholdHigh: 180,
                lightMode: 'system',
            },
        };

        const mergedDynamicOverlayOptions = { ...defaultOptions.dynamicOverlay };
        if (options.dynamicOverlay) {
            for (const key in options.dynamicOverlay) {
                if (options.dynamicOverlay.hasOwnProperty(key)) {
                    mergedDynamicOverlayOptions[key] = options.dynamicOverlay[key];
                }
            }
        }
        if (!Array.isArray(mergedDynamicOverlayOptions.lightColorRGB) || mergedDynamicOverlayOptions.lightColorRGB.length !== 3) {
            mergedDynamicOverlayOptions.lightColorRGB = defaultOptions.dynamicOverlay.lightColorRGB;
        }
        if (!Array.isArray(mergedDynamicOverlayOptions.darkColorRGB) || mergedDynamicOverlayOptions.darkColorRGB.length !== 3) {
            mergedDynamicOverlayOptions.darkColorRGB = defaultOptions.dynamicOverlay.darkColorRGB;
        }

        this.options = {
            ...defaultOptions,
            ...options,
            dynamicOverlay: mergedDynamicOverlayOptions
        };

        this.appRootDir = this._getAppRootDir();
        this.tempDir = this._getTemporaryDirectory();

        this.metadataFilePath = this.tempDir ? path.join(this.tempDir, this.internalMetadataFileName) : null;
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
        this._activeWallpaperFlowId = 0;
        this.styleElementId = 'bwb-styles';

        this._initialize();
    }

    _detectEnvironment() {
        const intentName = "環境檢測"; // Environment Detection
        if (typeof nw !== 'undefined' && nw.Window && nw.Screen) {
            this.runtimeEnv = 'nwjs';
            this.nwWin = nw.Window.get();
            this.nwScreen = nw.Screen;
        } else if (typeof process !== 'undefined' && process.versions && process.versions.electron) {
            this.runtimeEnv = 'electron';
            try {
                this.electron = require('electron');
                if (!this.electron.ipcRenderer) {
                    const message = "檢測到 Electron 環境，但 ipcRenderer 不可用。此腳本應在渲染進程中運行。";
                    console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                    this.runtimeEnv = 'unknown_error_electron_ipc';
                }
            } catch (e) {
                const loadModuleIntent = "載入Electron模組"; // Load Electron Module
                const message = "在渲染器中加載 Electron 模塊失敗。";
                console.error(`%cBWB%cError%c\n    %c${loadModuleIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
                this.runtimeEnv = 'unknown_error_electron_load';
            }
        } else {
            const message = "無法識別運行時環境 (NW.js 或 Electron)。";
            console.error(`%cBWB%cError%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
        }
    }

    _getAppRootDir() {
        const intentName = "獲取應用路徑"; // Get App Path
        if (this.runtimeEnv === 'nwjs') {
            return path.dirname(process.execPath);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                return this.electron.ipcRenderer.sendSync('bwb:get-app-path');
            } catch (e) {
                const message = "無法通過 IPC 獲取。使用備用路徑 '.'。";
                console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
                return '.';
            }
        }
        return '.';
    }

    _getTemporaryDirectory() {
        const generalIntent = "設定暫存目錄"; // Setup Temp Directory
        if (!this.appRootDir) {
            const message = "在獲取臨時目錄之前 appRootDir 尚未初始化。";
            console.error(`%cBWB%cError%c\n    %c${generalIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            return null;
        }
        let tempPathBase;
        if (this.runtimeEnv === 'nwjs') {
            tempPathBase = os.tmpdir();
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                tempPathBase = this.electron.ipcRenderer.sendSync('bwb:get-path', 'temp');
            } catch (e) {
                const getPathIntent = "獲取系統暫存路徑"; // Get System Temp Path
                const message = "無法通過 IPC 獲取。使用 os.tmpdir()。";
                console.warn(`%cBWB%cWarning%c\n    %c${getPathIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
                tempPathBase = os.tmpdir();
            }
        } else {
            tempPathBase = os.tmpdir();
        }

        if (typeof tempPathBase !== 'string' || tempPathBase.trim() === '') {
            const validatePathIntent = "驗證基礎暫存路徑"; // Validate Base Temp Path
            const message = "無效。使用應用程式根目錄的子文件夾作為備用。";
            console.warn(`%cBWB%cWarning%c\n    %c${validatePathIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            tempPathBase = this.appRootDir;
        }

        const tempPath = path.join(tempPathBase, this.internalTempSubDir);
        const createDirIntent = "建立暫存目錄"; // Create Temp Directory

        try {
            if (!fs.existsSync(tempPath)) {
                fs.mkdirSync(tempPath, { recursive: true });
            }
            const testFile = path.join(tempPath, `_bwb_write_test_${Date.now()}`);
            fs.writeFileSync(testFile, 'test');
            fs.unlinkSync(testFile);
            return tempPath;
        } catch (error) {
            const message = `主要路徑 "${tempPath}" 不可用 (錯誤: ${error.message})。嘗試備用路徑。`;
            console.warn(`%cBWB%cWarning%c\n    %c${createDirIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            try {
                const fallbackTempPath = path.join(this.appRootDir, this.internalTempSubDir);
                if (!fs.existsSync(fallbackTempPath)) {
                    fs.mkdirSync(fallbackTempPath, { recursive: true });
                }
                const testFileFallback = path.join(fallbackTempPath, `_bwb_write_test_fallback_${Date.now()}`);
                fs.writeFileSync(testFileFallback, 'test_fallback');
                fs.unlinkSync(testFileFallback);
                return fallbackTempPath;
            } catch (fallbackError) {
                const errMsg = `備用路徑 "${path.join(this.appRootDir, this.internalTempSubDir)}" 同樣不可用 (錯誤: ${fallbackError.message})。背景生成可能失敗。`;
                console.error(`%cBWB%cError%c\n    %c${createDirIntent}%c ${errMsg}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                return null;
            }
        }
    }

    async _initialize() {
        const intentName = "BWB初始化"; // BWB Initialization
        if (!this.tempDir) {
            const message = "由於沒有可用的臨時目錄，初始化中止。";
            console.error(`%cBWB%cError%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            return;
        }
        if (!getWallpaper || !ImageBlurProcessor) {
            const depCheckIntent = "檢查依賴"; // Check Dependencies
            const message = "由於缺少關鍵依賴項 (getWallpaper 或 ImageBlurProcessor)，初始化中止。";
            console.error(`%cBWB%cError%c\n    %c${depCheckIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            return;
        }

        await this._loadMetadata();

        await this._initializeSystemThemeAndListeners();
        this._updateRealModeAndColor();
        this._injectStyles();
        this._createDOM();
        await this._updateWindowState();
        this._updateLastKnownScreenDimensions();
        this._updateViewportStyles();
        this._setupEventListeners();

        let loadedFromCache = false;
        if (this.currentOriginalWallpaperPath && fs.existsSync(this.currentOriginalWallpaperPath)) {
            if (this.blurredImageFinalPath && fs.existsSync(this.blurredImageFinalPath)) {
                await this._applyBackgroundImage(this.blurredImageFinalPath, this._activeWallpaperFlowId, true);
                loadedFromCache = true;
            } else if (this.blurredImagePreviewPath && fs.existsSync(this.blurredImagePreviewPath)) {
                await this._applyBackgroundImage(this.blurredImagePreviewPath, this._activeWallpaperFlowId, true);
                this.updateAndApplyBlurredWallpaper(true, false);
                loadedFromCache = true;
            }
        }

        if (!loadedFromCache) {
            this.updateAndApplyBlurredWallpaper(true, true);
        } else {
            await this._updateOverlayBasedOnCurrentPosition();
            this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
        }
    }

    _updateRealModeAndColor() {
        const { lightMode, lightColorRGB, darkColorRGB } = this.options.dynamicOverlay;
        if (lightMode === 'system') {
            this._realMode = !this._isSystemInDarkMode;
            this._realColorRGB = this._isSystemInDarkMode ? darkColorRGB : lightColorRGB;
        } else if (lightMode === true) {
            this._realMode = true;
            this._realColorRGB = lightColorRGB;
        } else {
            this._realMode = false;
            this._realColorRGB = darkColorRGB;
        }
        if (this.viewportElement) {
            this._injectStyles();
            if (this.options.dynamicOverlay.enable && this.overlayElement) {
                this._updateOverlayBasedOnCurrentPosition();
            }
        }
    }

    async _initializeSystemThemeAndListeners() {
        const intentName = "獲取系統主題"; // Get System Theme
        if (this.runtimeEnv === 'nwjs') {
            if (window.matchMedia) {
                this._darkModeMatcher = window.matchMedia('(prefers-color-scheme: dark)');
                this._isSystemInDarkMode = this._darkModeMatcher.matches;
                this._handleSystemThemeChangeForNWJS = (e) => {
                    const newIsDark = e.matches;
                    if (this._isSystemInDarkMode !== newIsDark) {
                        this._isSystemInDarkMode = newIsDark;
                        if (this.options.dynamicOverlay.lightMode === 'system') {
                            this._updateRealModeAndColor();
                        }
                    }
                };
                this._darkModeMatcher.addEventListener('change', this._handleSystemThemeChangeForNWJS);
            } else {
                this._isSystemInDarkMode = false;
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            try {
                this._isSystemInDarkMode = await this.electron.ipcRenderer.invoke('bwb:get-system-theme-is-dark');
            } catch (e) {
                const message = "從主進程獲取初始狀態失敗，使用備用值 false。";
                console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
                this._isSystemInDarkMode = false;
            }
            this._handleSystemThemeChangeForElectron = (event, isDark) => {
                if (this._isSystemInDarkMode !== isDark) {
                    this._isSystemInDarkMode = isDark;
                    if (this.options.dynamicOverlay.lightMode === 'system') {
                        this._updateRealModeAndColor();
                    }
                }
            };
            this.electron.ipcRenderer.on('bwb:system-theme-changed', this._handleSystemThemeChangeForElectron);
        } else {
            this._isSystemInDarkMode = false;
        }
    }

    _injectStyles() {
        const existingStyleElement = document.getElementById(this.styleElementId);
        if (existingStyleElement) existingStyleElement.remove();
        const styleElement = document.createElement('style');
        styleElement.id = this.styleElementId;
        const containerBackgroundColor = this._realColorRGB || this.options.dynamicOverlay.baseColorRGB;
        styleElement.innerHTML = `
            #bwb-viewport {
                position: fixed; inset: 0px; overflow: hidden;
                z-index: ${this.options.elementZIndex}; margin: 5px;
                box-shadow: 0 0 5px rgba(0, 0, 0, 0.5);
                border-radius: ${this.options.borderRadius}px;
                transition: margin ${this.options.backgroundTransitionDuration / 1000}s ease-in-out,
                            box-shadow ${this.options.backgroundTransitionDuration / 1000}s ease-in-out,
                            border-radius ${this.options.backgroundTransitionDuration / 1000}s ease-in-out;
            }
            #bwb-background-container {
                position: absolute; top: 0px; left: 0px;
                width: 100vw; height: 100vh;
                will-change: transform, background-image;
                background-repeat: no-repeat; background-position: 0 0; background-size: cover;
                transition: background-image ${this.options.backgroundTransitionDuration}ms ease-in-out;
                background-color: rgba(${containerBackgroundColor.join(',')}, 1);
            }
            #bwb-overlay {
                position: absolute; top: 0; left: 0; width: 100%; height: 100%;
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
            const initialOverlayColorRGB = this._realColorRGB || this.options.dynamicOverlay.baseColorRGB;
            const { maxAlpha } = this.options.dynamicOverlay;
            this.overlayElement.style.backgroundColor = `rgba(${initialOverlayColorRGB.join(',')}, ${maxAlpha})`;
            this.viewportElement.appendChild(this.overlayElement);
        }
        document.body.appendChild(this.viewportElement);
    }

    _setupEventListeners() {
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
            this.electron.ipcRenderer.on('bwb:window-fullscreen-changed', () => this._handleWindowStateChange());
            this.electron.ipcRenderer.on('bwb:window-bounds-updated', (event, newBounds) => {
                this._currentWindowBounds = newBounds;
                this._onWindowBoundsChange();
            });
            this.electron.ipcRenderer.on('bwb:display-metrics-changed', this._onDisplayMetricsChange.bind(this));
        }
        window.addEventListener('resize', this._onWindowBoundsChange.bind(this));
    }

    async _updateWindowState() {
        const intentName = "獲取視窗狀態"; // Get Window State
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
                const message = "從主進程獲取失敗。";
                console.error(`%cBWB%cError%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET, e);
            }
        }
        const screen = this._getCurrentScreenForWindow(this._currentWindowBounds);
        this._currentScreenBounds = screen ? screen.bounds : { x: 0, y: 0, width: window.screen.width, height: window.screen.height };
    }

    async _handleWindowStateChange() {
        await this._updateWindowState();
        this._updateViewportStyles();
        this._updateBackgroundPosition();
        await this._updateOverlayBasedOnCurrentPosition();
    }

    _updateViewportStyles() {
        if (!this.viewportElement) return;
        const s = this.viewportElement.style;
        const isMaxOrFs = this._isMaximized || this._isFullScreen;
        s.margin = isMaxOrFs ? '0px' : '5px';
        s.boxShadow = isMaxOrFs ? 'none' : `0 0 5px rgba(0, 0, 0, 0.5)`;
        s.borderRadius = isMaxOrFs ? '0px' : `${this.options.borderRadius}px`;
        this._updateBackgroundContainerSize();
    }

    _updateBackgroundContainerSize() {
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
        const oldScreenW = this._lastKnownScreenDimensions.width;
        const oldScreenH = this._lastKnownScreenDimensions.height;

        await this._updateWindowState();
        this._updateLastKnownScreenDimensions();

        const newScreenW = this._currentScreenBounds.width;
        const newScreenH = this._currentScreenBounds.height;

        this._updateViewportStyles();

        const resolutionChanged = oldScreenW !== newScreenW || oldScreenH !== newScreenH;
        this.updateAndApplyBlurredWallpaper(false, resolutionChanged);
    }

    _updateBackgroundPosition() {
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
        const generalUpdateIntent = "更新桌布"; // Update Wallpaper
        if (this._wallpaperCheckTimeoutId) clearTimeout(this._wallpaperCheckTimeoutId);
        if (!this.tempDir) {
            const message = "無法更新，沒有臨時目錄。";
            console.error(`%cBWB%cError%c\n    %c${generalUpdateIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
            return;
        }

        const localFlowId = this._activeWallpaperFlowId;

        try {
            const newOriginalPath = await getWallpaper();
            if (!newOriginalPath) {
                const getIntent = "獲取桌布路徑"; // Get Wallpaper Path
                const message = `[Flow ${localFlowId}] 無法獲取。`;
                console.warn(`%cBWB%cWarning%c\n    %c${getIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            if (localFlowId !== this._activeWallpaperFlowId && !isInitialLoad) {
                return;
            }

            await this._updateWindowState();
            this._updateBackgroundContainerSize();
            this._updateLastKnownScreenDimensions();

            const screenWidth = this._currentScreenBounds.width;
            const screenHeight = this._currentScreenBounds.height;

            if (screenWidth <= 0 || screenHeight <= 0) {
                const validateScreenIntent = "驗證螢幕尺寸"; // Validate Screen Size
                const message = `[Flow ${localFlowId}] 無效 (${screenWidth}x${screenHeight})，無法處理壁紙。`;
                console.warn(`%cBWB%cWarning%c\n    %c${validateScreenIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError); return;
            }

            const wallpaperChanged = newOriginalPath !== this.currentOriginalWallpaperPath;

            if (wallpaperChanged || forceRegenerate) {
                if (!isInitialLoad || wallpaperChanged) {
                    this._activeWallpaperFlowId++;
                }
                this.currentOriginalWallpaperPath = newOriginalPath;
                await this._saveMetadata();
            }
            const currentActiveFlowId = this._activeWallpaperFlowId;

            const previewExists = this.blurredImagePreviewPath ? fs.existsSync(this.blurredImagePreviewPath) : false;
            const finalExists = this.blurredImageFinalPath ? fs.existsSync(this.blurredImageFinalPath) : false;

            if (!forceRegenerate && !wallpaperChanged && finalExists && !isInitialLoad) {
                const finalCssUrl = this.blurredImageFinalPath ? this._pathToCssUrl(this.blurredImageFinalPath) : 'none';
                if (this.currentAppliedCssUrl !== finalCssUrl && this.blurredImageFinalPath) {
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId);
                } else {
                    if (currentActiveFlowId === this._activeWallpaperFlowId) await this._updateOverlayBasedOnCurrentPosition();
                }
                this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
                return;
            }

            const needsProcessing = forceRegenerate || wallpaperChanged || !previewExists || !finalExists;

            if (needsProcessing) {
                const trulyForceImageGen = forceRegenerate || wallpaperChanged;
                let previewAppliedInThisFlow = false;

                const previewTargetSize = [screenWidth, screenHeight];
                const previewGenerated = this.blurredImagePreviewPath ? await this._generateBlurredImage(
                    newOriginalPath, this.blurredImagePreviewPath, this.options.previewBlurRadius,
                    this.options.previewQualityFactor, previewTargetSize, true,
                    trulyForceImageGen || !previewExists
                ) : false;

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                if (previewGenerated && this.blurredImagePreviewPath && fs.existsSync(this.blurredImagePreviewPath)) {
                    await this._applyBackgroundImage(this.blurredImagePreviewPath, currentActiveFlowId);
                    previewAppliedInThisFlow = true;
                } else {
                    const genPreviewIntent = "生成預覽圖"; // Generate Preview Image
                    const message = `[Flow ${currentActiveFlowId}] 生成失敗或文件不存在。`;
                    console.warn(`%cBWB%cWarning%c\n    %c${genPreviewIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                }

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                const finalTargetSize = [screenWidth, screenHeight];
                const finalGenerated = this.blurredImageFinalPath ? await this._generateBlurredImage(
                    newOriginalPath, this.blurredImageFinalPath, this.options.blurRadius,
                    this.options.imageProcessingZipRate, finalTargetSize, false,
                    trulyForceImageGen || !finalExists
                ) : false;

                if (currentActiveFlowId !== this._activeWallpaperFlowId) return;

                if (finalGenerated && this.blurredImageFinalPath && fs.existsSync(this.blurredImageFinalPath)) {
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId);
                    await this._saveMetadata();
                } else {
                    const genFinalIntent = "生成正式圖"; // Generate Final Image
                    const message = `[Flow ${currentActiveFlowId}] 生成失敗或文件不存在。`;
                    console.warn(`%cBWB%cWarning%c\n    %c${genFinalIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                    if (!previewAppliedInThisFlow && this.backgroundContainer) {
                        this.backgroundContainer.style.backgroundImage = 'none';
                        this.currentAppliedCssUrl = 'none';
                    }
                }
            } else if (isInitialLoad) {
                if (this.blurredImageFinalPath && fs.existsSync(this.blurredImageFinalPath)) {
                    await this._applyBackgroundImage(this.blurredImageFinalPath, currentActiveFlowId, true);
                } else if (this.blurredImagePreviewPath && fs.existsSync(this.blurredImagePreviewPath)) {
                    await this._applyBackgroundImage(this.blurredImagePreviewPath, currentActiveFlowId, true);
                }
            }

            if (currentActiveFlowId === this._activeWallpaperFlowId) {
                await this._updateOverlayBasedOnCurrentPosition();
                this._scheduleNextWallpaperCheck(this.options.checkIntervalSuccess);
            }

        } catch (error) {
            const message = `[Flow ${localFlowId}] 操作時出錯 (${this.runtimeEnv}):`;
            console.error(`%cBWB%cError%c\n    %c${generalUpdateIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET, error);
            if (localFlowId === this._activeWallpaperFlowId) {
                this._scheduleNextWallpaperCheck(this.options.checkIntervalError);
            }
        }
    }

    async _generateBlurredImage(sourcePath, outputPath, blurRadius, qualityOrZipRate, targetSize, isPreview, forceGenerateThisImage = false) {
        const generalProcessIntent = "圖片處理"; // Image Processing
        if (!ImageBlurProcessor) {
            const message = "ImageBlurProcessor 未加載。";
            console.error(`%cBWB%cError%c\n    %c${generalProcessIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            return false;
        }
        if (!this.tempDir || !outputPath) {
            const setupIntent = "圖片處理設定"; // Image Processing Setup
            const message = "沒有用於模糊圖像的臨時目錄或輸出路徑。";
            console.error(`%cBWB%cError%c\n    %c${setupIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
            return false;
        }
        if (!sourcePath || !fs.existsSync(sourcePath)) {
            const validateSourceIntent = "驗證來源圖片"; // Validate Source Image
            const message = `路徑不存在: ${sourcePath}`;
            console.error(`%cBWB%cError%c\n    %c${validateSourceIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET);
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
                const message = `未能為 ${isPreview ? '預覽' : '最終'} 返回 blob。`;
                console.warn(`%cBWB%cWarning%c\n    %c${generalProcessIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                return false;
            }
        } catch (err) {
            const message = `生成 ${isPreview ? '預覽' : '最終'} 模糊圖像時出錯 (${outputPath}):`;
            console.error(`%cBWB%cError%c\n    %c${generalProcessIntent}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_ERROR_STYLE_ERROR, BWB_LOG_STYLE_RESET, BWB_ERROR_STYLE_FUNC, BWB_LOG_STYLE_RESET, err);
            return false;
        }
    }

    _pathToCssUrl(filePath) {
        if (!filePath) return 'none';
        let mtime = Date.now();
        try {
            if (fs.existsSync(filePath)) {
                mtime = fs.statSync(filePath).mtime.getTime();
            }
        } catch (e) { /* 忽略 */ }
        return `url('${filePath.replace(/\\/g, '/')}?t=${mtime}')`;
    }

    _applyBackgroundImage(newImagePath, flowId, isRestoringFromCache = false) {
        return new Promise(async (resolve) => {
            if (flowId !== undefined && flowId !== this._activeWallpaperFlowId && !isRestoringFromCache) {
                resolve(false); return;
            }
            if (!this.backgroundContainer) {
                resolve(false); return;
            }
            if (this._isTransitioningBackground && !isRestoringFromCache) {
                this._pendingImageForTransition = newImagePath;
                resolve(false); return;
            }
            if (!newImagePath || !fs.existsSync(newImagePath)) {
                if (this.currentAppliedCssUrl && this.currentAppliedCssUrl.includes(newImagePath.replace(/\\/g, '/'))) {
                    this.currentAppliedCssUrl = null;
                }
                resolve(false); return;
            }

            const newCssUrl = this._pathToCssUrl(newImagePath);
            if (this.currentAppliedCssUrl === newCssUrl && !isRestoringFromCache) {
                this.lastAppliedImagePath = newImagePath;
                if (flowId === this._activeWallpaperFlowId || isRestoringFromCache) await this._updateOverlayBasedOnCurrentPosition();
                resolve(true); return;
            }

            this._updateBackgroundPosition();
            this._isTransitioningBackground = true;
            this.lastAppliedImagePath = newImagePath;
            this.backgroundContainer.style.backgroundImage = newCssUrl;

            const transitionEndHandler = async () => {
                this.backgroundContainer.removeEventListener('transitionend', transitionEndHandler);
                if (flowId !== undefined && flowId !== this._activeWallpaperFlowId && !(this.blurredImageFinalPath && newImagePath === this.blurredImageFinalPath) && !isRestoringFromCache) {
                    this._isTransitioningBackground = false;
                    if (this._pendingImageForTransition) {
                        const pathForNext = this._pendingImageForTransition; this._pendingImageForTransition = null;
                        setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                    }
                    resolve(false); return;
                }
                this.currentAppliedCssUrl = newCssUrl;
                this._isTransitioningBackground = false;
                if (this._pendingImageForTransition) {
                    const pathForNext = this._pendingImageForTransition; this._pendingImageForTransition = null;
                    setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                } else {
                    if (flowId === this._activeWallpaperFlowId || isRestoringFromCache) await this._updateOverlayBasedOnCurrentPosition();
                }
                resolve(true);
            };
            this.backgroundContainer.addEventListener('transitionend', transitionEndHandler, { once: true });

            const timeoutId = setTimeout(async () => {
                if (this._isTransitioningBackground) {
                    this.backgroundContainer.removeEventListener('transitionend', transitionEndHandler);
                    this.currentAppliedCssUrl = newCssUrl;
                    this._isTransitioningBackground = false;
                    if (this._pendingImageForTransition) {
                        const pathForNext = this._pendingImageForTransition;
                        this._pendingImageForTransition = null;
                        setTimeout(() => this._applyBackgroundImage(pathForNext, this._activeWallpaperFlowId), 0);
                    } else {
                        if (flowId === this._activeWallpaperFlowId || isRestoringFromCache) {
                            await this._updateOverlayBasedOnCurrentPosition();
                        }
                    }
                    resolve(true);
                }
            }, this.options.backgroundTransitionDuration + 50);

            this.backgroundContainer.addEventListener('transitionend', () => clearTimeout(timeoutId), { once: true });
        });
    }

    async _updateOverlayBasedOnCurrentPosition() {
        const intentName = "計算遮罩亮度"; // Calculate Overlay Brightness
        const { enable, minAlpha, maxAlpha, brightnessThresholdLow, brightnessThresholdHigh, baseColorRGB } = this.options.dynamicOverlay;
        const currentRealColorRGBToUse = this._realColorRGB || baseColorRGB;

        if (!enable || !this.overlayElement) {
            if (enable && this.overlayElement) {
                this._applyOverlayColor(`rgba(${currentRealColorRGBToUse.join(',')}, ${this._realMode ? maxAlpha : minAlpha})`);
            }
            return;
        }
        if (!this.lastAppliedImagePath || !fs.existsSync(this.lastAppliedImagePath)) {
            this._applyOverlayColor(`rgba(${currentRealColorRGBToUse.join(',')}, ${this._realMode ? maxAlpha : minAlpha})`);
            return;
        }
        const winBounds = this._currentWindowBounds;
        if (!winBounds || winBounds.width <= 0 || winBounds.height <= 0) return;
        const screenBounds = this._currentScreenBounds;
        if (!screenBounds || screenBounds.width <= 0 || screenBounds.height <= 0) return;

        try {
            const extremeBrightness = await this._getExtremeBrightnessFromWindowRegion(
                this.lastAppliedImagePath, winBounds, screenBounds,
                (this._isMaximized || this._isFullScreen) ? 0 : 5,
                this.options.titleBarHeight, this._realMode, this.options.imageProcessingZipRate
            );
            if (typeof extremeBrightness === 'number') {
                let alpha;
                if (extremeBrightness <= brightnessThresholdLow) alpha = this._realMode ? maxAlpha : minAlpha;
                else if (extremeBrightness >= brightnessThresholdHigh) alpha = this._realMode ? minAlpha : maxAlpha;
                else {
                    const ratio = (extremeBrightness - brightnessThresholdLow) / (brightnessThresholdHigh - brightnessThresholdLow);
                    alpha = this._realMode ? maxAlpha - (maxAlpha - minAlpha) * ratio : minAlpha + (maxAlpha - minAlpha) * ratio;
                }
                alpha = Math.max(minAlpha, Math.min(maxAlpha, alpha));
                this._applyOverlayColor(`rgba(${currentRealColorRGBToUse.join(',')}, ${alpha.toFixed(3)})`);
            }
        } catch (brightnessError) {
            const message = "操作時出錯:";
            console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, brightnessError);
            this._applyOverlayColor(`rgba(${currentRealColorRGBToUse.join(',')}, ${this._realMode ? maxAlpha : minAlpha})`);
        }
    }

    _applyOverlayColor(cssColor) {
        if (this.overlayElement && this.overlayElement.style.backgroundColor !== cssColor) {
            this.overlayElement.style.backgroundColor = cssColor;
        }
    }

    async _getExtremeBrightnessFromWindowRegion(imagePathOrBlob, windowBounds, screenBoundsOfWindow, currentPadding, titleBarHeightOption, lightModeForSampling, zipRate) {
        const intentName = "計算亮度區域"; // Calculate Brightness Region
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                if (canvas.width === 0 || canvas.height === 0) {
                    const message = "用於亮度檢查的圖像尺寸為零。";
                    reject(new Error(`${intentName}: ${message}`)); return;
                }
                const ctx = canvas.getContext('2d', { willReadFrequently: true });
                if (!ctx) {
                    const message = "無法獲取用於亮度檢查的畫布 2d 上下文";
                    reject(new Error(`${intentName}: ${message}`)); return;
                }
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                const win_content_x_on_screen = windowBounds.x - screenBoundsOfWindow.x + currentPadding;
                const win_content_y_on_screen = windowBounds.y - screenBoundsOfWindow.y + currentPadding + titleBarHeightOption;
                const win_content_w_on_screen = windowBounds.width - (2 * currentPadding);
                const win_content_h_on_screen = windowBounds.height - (2 * currentPadding) - titleBarHeightOption;
                let sx = Math.round(win_content_x_on_screen * zipRate);
                let sy = Math.round(win_content_y_on_screen * zipRate);
                let sWidth = Math.round(win_content_w_on_screen * zipRate);
                let sHeight = Math.round(win_content_h_on_screen * zipRate);
                sx = Math.max(0, Math.min(sx, canvas.width));
                sy = Math.max(0, Math.min(sy, canvas.height));
                sWidth = Math.floor(Math.max(0, Math.min(sWidth, canvas.width - sx)));
                sHeight = Math.floor(Math.max(0, Math.min(sHeight, canvas.height - sy)));
                if (sWidth <= 0 || sHeight <= 0) {
                    const message = `大小為零或負數 (映射後)。 sx=${sx},sy=${sy},sw=${sWidth},sh=${sHeight},canvasW=${canvas.width},canvasH=${canvas.height},zipRate=${zipRate}`;
                    console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET);
                    resolve(lightModeForSampling ? 0 : 255); return;
                }
                try {
                    const imageData = ctx.getImageData(sx, sy, sWidth, sHeight);
                    const data = imageData.data; const pixels = data.length / 4;
                    if (pixels === 0) { resolve(lightModeForSampling ? 0 : 255); return; }
                    let extremeBrightness = lightModeForSampling ? 255 : 0; let sampledCount = 0;
                    const sampleStride = Math.max(1, Math.floor(pixels / 20000)) * 4;
                    for (let i = 0; i < data.length; i += sampleStride) {
                        const brightness = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
                        sampledCount++;
                        if (lightModeForSampling) { if (brightness < extremeBrightness) extremeBrightness = brightness; }
                        else { if (brightness > extremeBrightness) extremeBrightness = brightness; }
                    }
                    if (sampledCount === 0) { resolve(lightModeForSampling ? 0 : 255); return; }
                    resolve(extremeBrightness);
                } catch (e) {
                    const message = `getImageData 錯誤: ${e.message}。區域: sx=${sx},sy=${sy},sw=${sWidth},sh=${sHeight}。畫布: ${canvas.width}x${canvas.height}`;
                    reject(new Error(`${intentName}: ${message}`));
                } finally {
                    if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                }
            };
            img.onerror = (e) => {
                if (typeof imagePathOrBlob !== 'string' && img.src.startsWith('blob:')) URL.revokeObjectURL(img.src);
                const message = `圖像加載錯誤: ${e.message || e.type || '未知'}。路徑: ${imagePathOrBlob}`;
                reject(new Error(`${intentName}: ${message}`));
            };
            if (typeof imagePathOrBlob === 'string') {
                let mtime = Date.now(); try { if (fs.existsSync(imagePathOrBlob)) mtime = fs.statSync(imagePathOrBlob).mtime.getTime(); } catch (err) { /* 忽略 */ }
                img.src = `${imagePathOrBlob.replace(/\\/g, '/')}?t=${mtime}`;
            } else if (imagePathOrBlob instanceof Blob) {
                img.src = URL.createObjectURL(imagePathOrBlob);
            } else {
                const message = "圖像源無效。";
                reject(new Error(`${intentName}: ${message}`));
            }
        });
    }

    _scheduleNextWallpaperCheck(delay) {
        if (this._wallpaperCheckTimeoutId) clearTimeout(this._wallpaperCheckTimeoutId);
        this._wallpaperCheckTimeoutId = setTimeout(() => this.updateAndApplyBlurredWallpaper(), delay);
    }

    _getCurrentScreenForWindow(windowBounds) {
        if (!windowBounds || typeof windowBounds.x !== 'number' || typeof windowBounds.y !== 'number') {
            if (this.runtimeEnv === 'nwjs' && this.nwWin) {
                windowBounds = { x: this.nwWin.x, y: this.nwWin.y, width: this.nwWin.width, height: this.nwWin.height };
            } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
                try { windowBounds = this.electron.ipcRenderer.sendSync('bwb:get-window-bounds-sync'); } catch (e) { /* 忽略 */ }
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
        return {
            bounds: { x: 0, y: 0, width: window.screen.width || 1920, height: window.screen.height || 1080, scaleFactor: window.devicePixelRatio || 1 },
        };
    }

    async _loadMetadata() {
        const intentName = "讀取元數據"; // Read Metadata
        if (!this.metadataFilePath) return;
        try {
            if (fs.existsSync(this.metadataFilePath)) {
                const data = await fs.promises.readFile(this.metadataFilePath, 'utf8');
                const metadata = JSON.parse(data);
                if (metadata.currentOriginalWallpaperPath && typeof metadata.currentOriginalWallpaperPath === 'string') {
                    this.currentOriginalWallpaperPath = metadata.currentOriginalWallpaperPath;
                }
                if (metadata.lastKnownScreenDimensions && typeof metadata.lastKnownScreenDimensions.width === 'number') {
                    this._lastKnownScreenDimensions = metadata.lastKnownScreenDimensions;
                }
            }
        } catch (error) {
            const message = "操作失敗:";
            console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, error);
            this.currentOriginalWallpaperPath = null;
            this._lastKnownScreenDimensions = { width: 0, height: 0 };
        }
    }

    async _saveMetadata() {
        const intentName = "寫入元數據"; // Write Metadata
        if (!this.metadataFilePath) return;
        try {
            const metadata = {
                currentOriginalWallpaperPath: this.currentOriginalWallpaperPath,
                lastKnownScreenDimensions: this._lastKnownScreenDimensions
            };
            await fs.promises.writeFile(this.metadataFilePath, JSON.stringify(metadata, null, 2), 'utf8');
        } catch (error) {
            const message = "操作失敗:";
            console.warn(`%cBWB%cWarning%c\n    %c${intentName}%c ${message}`, BWB_LOG_STYLE_BWB, BWB_WARN_STYLE_WARNING, BWB_LOG_STYLE_RESET, BWB_WARN_STYLE_FUNC, BWB_LOG_STYLE_RESET, error);
        }
    }

    _updateLastKnownScreenDimensions() {
        if (this._currentScreenBounds && this._currentScreenBounds.width > 0 && this._currentScreenBounds.height > 0) {
            this._lastKnownScreenDimensions = {
                width: this._currentScreenBounds.width,
                height: this._currentScreenBounds.height
            };
        }
    }

    destroy() {
        this._activeWallpaperFlowId++;
        if (this._rAFId) cancelAnimationFrame(this._rAFId);
        if (this._wallpaperCheckTimeoutId) clearTimeout(this._wallpaperCheckTimeoutId);
        if (this._moveUpdateTimeoutId) clearTimeout(this._moveUpdateTimeoutId);

        if (this.runtimeEnv === 'nwjs' && this._darkModeMatcher && this._handleSystemThemeChangeForNWJS) {
            this._darkModeMatcher.removeEventListener('change', this._handleSystemThemeChangeForNWJS);
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer && this._handleSystemThemeChangeForElectron) {
            this.electron.ipcRenderer.removeListener('bwb:system-theme-changed', this._handleSystemThemeChangeForElectron);
        }

        if (this.runtimeEnv === 'nwjs' && this.nwWin) {
            this.nwWin.removeAllListeners('maximize'); this.nwWin.removeAllListeners('unmaximize');
            this.nwWin.removeAllListeners('restore'); this.nwWin.removeAllListeners('enter-fullscreen');
            this.nwWin.removeAllListeners('leave-fullscreen'); this.nwWin.removeAllListeners('move');
            this.nwWin.removeAllListeners('resize');
            if (this.nwScreen) {
                this.nwScreen.removeAllListeners('displayBoundsChanged');
                this.nwScreen.removeAllListeners('displayAdded'); this.nwScreen.removeAllListeners('displayRemoved');
            }
        } else if (this.runtimeEnv === 'electron' && this.electron && this.electron.ipcRenderer) {
            this.electron.ipcRenderer.removeAllListeners('bwb:window-maximized');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-unmaximized');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-fullscreen-changed');
            this.electron.ipcRenderer.removeAllListeners('bwb:window-bounds-updated');
            this.electron.ipcRenderer.removeAllListeners('bwb:display-metrics-changed');
        }
        window.removeEventListener('resize', this._onWindowBoundsChange.bind(this));

        if (this.viewportElement) this.viewportElement.remove();
        this.viewportElement = null; this.backgroundContainer = null; this.overlayElement = null;
        this.currentOriginalWallpaperPath = null; this.lastAppliedImagePath = null; this.currentAppliedCssUrl = null;
        const styleElement = document.getElementById(this.styleElementId);
        if (styleElement) styleElement.remove();
        // console.log("BlurredWindowBackground: 實例已銷毀。"); // 保留此條
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BlurredWindowBackground;
} else if (typeof window !== 'undefined') {
    window.BlurredWindowBackground = BlurredWindowBackground;
}
