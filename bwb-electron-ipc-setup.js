// bwb-electron-ipc-setup.js
// 這個模塊應該在 Electron 的主進程中使用

const { app, screen } = require('electron'); // 引入 screen 模塊

/**
 * 為 BlurredWindowBackground 設置必要的 IPC 監聽器、處理程序，並自動綁定窗口事件。
 * @param {import('electron').IpcMain} ipcMain - Electron 的 ipcMain 模塊。
 * @param {import('electron').BrowserWindow | () => import('electron').BrowserWindow | null} windowOrThunk - 要應用模糊背景效果的主 BrowserWindow 實例，或一個返回該實例的函數。
 */
function setupBlurredWindowBackgroundIPC(ipcMain, windowOrThunk) {
    if (!ipcMain) {
        console.error('[BWB IPC Setup] ipcMain 參數是必需的。');
        return;
    }
    if (!windowOrThunk) {
        console.error('[BWB IPC Setup] mainWindow (或獲取它的函數) 參數是必需的。');
        return;
    }

    const getMainWindow = () => {
        return typeof windowOrThunk === 'function' ? windowOrThunk() : windowOrThunk;
    };

    // --- IPC Handler 函數定義 (避免重複創建匿名函數) ---
    const handleGetWindowBounds = async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.getBounds();
        }
        console.warn('[BWB IPC Setup] handle "bwb:get-window-bounds": 主窗口不可用。');
        return null;
    };

    const handleGetWindowIsMaximized = async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.isMaximized();
        }
        return false;
    };

    const handleGetWindowIsFullscreen = async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.isFullScreen();
        }
        return false;
    };

    // --- IPC 監聽器設置 ---

    ipcMain.on('bwb:get-app-name', (event) => {
        event.returnValue = app.getName() || 'DefaultElectronApp';
    });

    ipcMain.on('bwb:get-app-path', (event) => {
        event.returnValue = app.getAppPath();
    });

    ipcMain.on('bwb:get-path', (event, pathName) => {
        try {
            event.returnValue = app.getPath(pathName);
        } catch (error) {
            console.error(`[BWB IPC Setup] 無法獲取路徑 '${pathName}':`, error);
            event.returnValue = null;
        }
    });

    ipcMain.handle('bwb:get-window-bounds', handleGetWindowBounds);

    ipcMain.on('bwb:get-window-bounds-sync', (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            event.returnValue = mainWindow.getBounds();
        } else {
            console.warn('[BWB IPC Setup] on "bwb:get-window-bounds-sync": 主窗口不可用。');
            event.returnValue = null;
        }
    });

    ipcMain.handle('bwb:get-window-is-maximized', handleGetWindowIsMaximized);
    ipcMain.handle('bwb:get-window-is-fullscreen', handleGetWindowIsFullscreen);


    // --- 窗口和屏幕事件綁定 ---

    const mainWindowInstance = getMainWindow();

    // 定義事件處理器以便能正確移除
    let onMoveHandler, onResizeHandler, onMaximizeHandler, onUnmaximizeHandler,
        onEnterFullScreenHandler, onLeaveFullScreenHandler,
        onDisplayMetricsChangedHandler;

    if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
        const sendToRenderer = (channel, ...args) => {
            const win = getMainWindow();
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                try {
                    win.webContents.send(channel, ...args);
                } catch (error) {
                    if (!error.message.includes("Render frame was V8-crashed") && !error.message.includes("webContents is_destroyed")) {
                        console.warn(`[BWB IPC Setup] 發送事件到渲染器 (${channel}) 時出錯:`, error.message);
                    }
                }
            }
        };

        const sendBoundsToRenderer = () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed()) {
                sendToRenderer('bwb:window-bounds-updated', win.getBounds());
            }
        };

        onMoveHandler = sendBoundsToRenderer;
        onResizeHandler = sendBoundsToRenderer;

        onMaximizeHandler = () => sendToRenderer('bwb:window-maximized');
        onUnmaximizeHandler = () => sendToRenderer('bwb:window-unmaximized');

        onEnterFullScreenHandler = () => sendToRenderer('bwb:window-fullscreen-changed', true);
        onLeaveFullScreenHandler = () => sendToRenderer('bwb:window-fullscreen-changed', false);

        mainWindowInstance.on('move', onMoveHandler);
        mainWindowInstance.on('resize', onResizeHandler);
        mainWindowInstance.on('maximize', onMaximizeHandler);
        mainWindowInstance.on('unmaximize', onUnmaximizeHandler);
        mainWindowInstance.on('enter-full-screen', onEnterFullScreenHandler);
        mainWindowInstance.on('leave-full-screen', onLeaveFullScreenHandler);

        // 屏幕事件監聽
        onDisplayMetricsChangedHandler = () => {
            console.log('[BWB IPC Setup] Display metrics changed. Notifying renderer.');
            sendToRenderer('bwb:display-metrics-changed');
        };

        // 檢查 screen 是否可用 (例如在某些測試環境中可能沒有)
        if (screen) {
            screen.on('display-metrics-changed', onDisplayMetricsChangedHandler);
            screen.on('display-added', onDisplayMetricsChangedHandler);
            screen.on('display-removed', onDisplayMetricsChangedHandler);
        } else {
            console.warn('[BWB IPC Setup] Electron screen module not available. Display metrics changes will not be monitored.');
        }


        const sendInitialData = () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
                sendBoundsToRenderer(); // 發送初始bounds
                // 渲染器會通過 invoke 查詢初始最大化和全螢幕狀態
            }
        };

        if (mainWindowInstance.webContents && !mainWindowInstance.webContents.isDestroyed()) {
            if (mainWindowInstance.webContents.isLoading()) {
                mainWindowInstance.webContents.once('did-finish-load', () => {
                    setTimeout(sendInitialData, 200); // 稍長延遲確保渲染器內監聽器已就緒
                });
            } else {
                setTimeout(sendInitialData, 150);
            }
        }

        mainWindowInstance.once('closed', () => {
            const win = getMainWindow(); // 獲取當前 mainWindowInstance 的引用
            if (win && typeof win.removeListener === 'function') {
                if (onMoveHandler) win.removeListener('move', onMoveHandler);
                if (onResizeHandler) win.removeListener('resize', onResizeHandler);
                if (onMaximizeHandler) win.removeListener('maximize', onMaximizeHandler);
                if (onUnmaximizeHandler) win.removeListener('unmaximize', onUnmaximizeHandler);
                if (onEnterFullScreenHandler) win.removeListener('enter-full-screen', onEnterFullScreenHandler);
                if (onLeaveFullScreenHandler) win.removeListener('leave-full-screen', onLeaveFullScreenHandler);
                console.log('[BWB IPC Setup] 已從已關閉窗口移除窗口事件監聽器。');
            }

            if (screen && onDisplayMetricsChangedHandler) {
                screen.removeListener('display-metrics-changed', onDisplayMetricsChangedHandler);
                screen.removeListener('display-added', onDisplayMetricsChangedHandler);
                screen.removeListener('display-removed', onDisplayMetricsChangedHandler);
                console.log('[BWB IPC Setup] 已移除屏幕事件監聽器。');
            }

            // 清理所有 handle
            ipcMain.removeHandler('bwb:get-window-bounds');
            ipcMain.removeHandler('bwb:get-window-is-maximized');
            ipcMain.removeHandler('bwb:get-window-is-fullscreen');
            // ipcMain.on 的監聽器通常是全局的，除非設計為每個窗口實例創建和銷毀。
            // 'bwb:get-app-name', 'bwb:get-app-path', 'bwb:get-path', 'bwb:get-window-bounds-sync'
            // 在此假設它們是全局的，不需要在此處移除。如果需要，應使用 ipcMain.removeListener。
            console.log('[BWB IPC Setup] 已清理 IPC handlers。');
        });

        console.log('[BWB IPC Setup] BlurredWindowBackground 的 IPC 通道和窗口/屏幕事件監聽器已成功設置。');

    } else if (typeof windowOrThunk !== 'function') {
        console.warn('[BWB IPC Setup] 傳入的 mainWindow 實例無效或已銷毀，無法綁定事件。');
    } else {
        console.log('[BWB IPC Setup] 以函數形式傳入 mainWindow。事件將在觸發時嘗試獲取窗口。');
        // 注意：如果以函數形式傳入，窗口關閉時的清理邏輯可能需要外部協調，
        // 因為此 setup 函數本身無法知道何時該移除全局 screen 監聽器或 IPC handlers。
        // 當前 'closed' 事件的清理是基於初始獲取的 mainWindowInstance。
    }
}

module.exports = { setupBlurredWindowBackgroundIPC };
