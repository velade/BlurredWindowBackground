// bwb-electron-ipc-setup.js
// 這個模塊應該在 Electron 的主進程中使用

const { app } = require('electron'); // 移除了 fs 和 path，因為不再讀取 package.json
// const { app, screen } = require('electron'); // 如果需要監聽 screen 事件

/**
 * 為 BlurredWindowBackground 設置必要的 IPC 監聽器、處理程序，並自動綁定窗口事件。
 * @param {import('electron').IpcMain} ipcMain - Electron 的 ipcMain 模塊。
 * @param {import('electron').BrowserWindow} mainWindow - 要應用模糊背景效果的主 BrowserWindow 實例。
 * 如果窗口在調用時可能尚未創建或已銷毀，
 * 可以傳入一個返回 BrowserWindow 實例或 null 的函數: () => BrowserWindow | null。
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


    // --- IPC 監聽器設置 ---

    // 【新增】處理渲染器進程獲取應用程序名稱的請求
    ipcMain.on('bwb:get-app-name', (event) => {
        event.returnValue = app.getName() || 'DefaultElectronApp'; // 直接使用 app.getName()
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

    ipcMain.handle('bwb:get-window-bounds', async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.getBounds();
        }
        console.warn('[BWB IPC Setup] handle "bwb:get-window-bounds": 主窗口不可用。');
        return null;
    });

    ipcMain.on('bwb:get-window-bounds-sync', (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            event.returnValue = mainWindow.getBounds();
        } else {
            console.warn('[BWB IPC Setup] on "bwb:get-window-bounds-sync": 主窗口不可用。');
            event.returnValue = null;
        }
    });

    // 【新增】處理渲染器查詢窗口是否最大化的請求
    ipcMain.handle('bwb:get-window-is-maximized', async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.isMaximized();
        }
        return false; // 默認返回 false
    });


    // --- 窗口事件綁定 ---

    const mainWindowInstance = getMainWindow();

    // 定義事件處理器以便能正確移除
    let onMoveHandler, onResizeHandler, onMaximizeHandler, onUnmaximizeHandler;


    if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
        const sendBoundsToRenderer = () => {
            const win = getMainWindow(); // 每次都獲取最新的窗口實例
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                try {
                    win.webContents.send('bwb:window-bounds-updated', win.getBounds());
                } catch (error) {
                    // 捕獲 webContents 可能已銷毀的錯誤
                    if (!error.message.includes("Render frame was V8-crashed") && !error.message.includes("webContents is_destroyed")) {
                        console.warn('[BWB IPC Setup] 發送窗口邊界到渲染器時出錯:', error.message);
                    }
                }
            }
        };

        onMoveHandler = sendBoundsToRenderer; // 引用同一個函數
        onResizeHandler = sendBoundsToRenderer;

        // 【新增】最大化/取消最大化事件處理
        onMaximizeHandler = () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('bwb:window-maximized');
            }
        };
        onUnmaximizeHandler = () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
                win.webContents.send('bwb:window-unmaximized');
            }
        };

        mainWindowInstance.on('move', onMoveHandler);
        mainWindowInstance.on('resize', onResizeHandler);
        mainWindowInstance.on('maximize', onMaximizeHandler);
        mainWindowInstance.on('unmaximize', onUnmaximizeHandler);


        // 可選：窗口完成加載後也發送一次初始邊界和最大化狀態
        // 原始代碼中已有類似邏輯，這裡整合
        const sendInitialData = () => {
            const win = getMainWindow();
            if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
                sendBoundsToRenderer(); // 發送初始bounds
                // 不再由此處主動發送初始最大化狀態，渲染器將通過 invoke 查詢
                // if (win.isMaximized()) {
                // onMaximizeHandler();
                // } else {
                // onUnmaximizeHandler();
                // }
            }
        };

        if (mainWindowInstance.webContents && !mainWindowInstance.webContents.isDestroyed()) {
            if (mainWindowInstance.webContents.isLoading()) {
                mainWindowInstance.webContents.once('did-finish-load', () => {
                    setTimeout(sendInitialData, 150); // 稍長一點延遲確保渲染器內監聽器已就緒
                });
            } else {
                setTimeout(sendInitialData, 100);
            }
        }


        mainWindowInstance.once('closed', () => {
            // 【修改】確保移除正確的處理器引用
            if (mainWindowInstance && typeof mainWindowInstance.removeListener === 'function') {
                if (onMoveHandler) mainWindowInstance.removeListener('move', onMoveHandler);
                if (onResizeHandler) mainWindowInstance.removeListener('resize', onResizeHandler);
                if (onMaximizeHandler) mainWindowInstance.removeListener('maximize', onMaximizeHandler);
                if (onUnmaximizeHandler) mainWindowInstance.removeListener('unmaximize', onUnmaximizeHandler);
                console.log('[BWB IPC Setup] 已從已關閉窗口移除 move/resize/maximize/unmaximize 監聽器。');
            }
            // 【新增】清理 handle
            ipcMain.removeHandler('bwb:get-window-is-maximized');
            // 其他 handle 和 on 監聽器通常是全局的，除非特別設計為每個窗口實例創建和銷毀
        });

        console.log('[BWB IPC Setup] BlurredWindowBackground 的 IPC 通道和窗口事件監聽器已成功設置。');

    } else if (typeof windowOrThunk !== 'function') {
        console.warn('[BWB IPC Setup] 傳入的 mainWindow 實例無效或已銷毀，無法綁定 move/resize 事件。');
    } else {
        console.log('[BWB IPC Setup] 以函數形式傳入 mainWindow。move/resize 事件將在事件觸發時嘗試獲取窗口。');
    }
}

module.exports = { setupBlurredWindowBackgroundIPC };