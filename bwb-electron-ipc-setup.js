// bwb-electron-ipc-setup.js
// 這個模塊應該在 Electron 的主進程中使用

const { app } = require('electron');

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

    // 處理渲染器進程獲取應用程序路徑的請求
    ipcMain.on('bwb:get-app-path', (event) => {
        event.returnValue = app.getAppPath();
    });

    // 處理渲染器進程獲取特定系統路徑的請求 (例如 'temp')
    ipcMain.on('bwb:get-path', (event, pathName) => {
        try {
            event.returnValue = app.getPath(pathName);
        } catch (error) {
            console.error(`[BWB IPC Setup] 無法獲取路徑 '${pathName}':`, error);
            event.returnValue = null;
        }
    });

    // 處理渲染器進程異步獲取窗口邊界的請求
    ipcMain.handle('bwb:get-window-bounds', async (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            return mainWindow.getBounds();
        }
        console.warn('[BWB IPC Setup] handle "bwb:get-window-bounds": 主窗口不可用。');
        return null;
    });

    // 處理渲染器進程同步獲取窗口邊界的請求 (作為備用)
    ipcMain.on('bwb:get-window-bounds-sync', (event) => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed()) {
            event.returnValue = mainWindow.getBounds();
        } else {
            console.warn('[BWB IPC Setup] on "bwb:get-window-bounds-sync": 主窗口不可用。');
            event.returnValue = null;
        }
    });

    // --- 窗口事件綁定 ---

    const sendBoundsToRenderer = () => {
        const mainWindow = getMainWindow();
        if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
            try {
                mainWindow.webContents.send('bwb:window-bounds-updated', mainWindow.getBounds());
            } catch (error) {
                console.warn('[BWB IPC Setup] 發送窗口邊界到渲染器時出錯:', error.message);
            }
        }
    };

    const mainWindowInstance = getMainWindow(); // 獲取一次實例用於綁定
    if (mainWindowInstance && !mainWindowInstance.isDestroyed()) {
        mainWindowInstance.on('move', sendBoundsToRenderer);
        mainWindowInstance.on('resize', sendBoundsToRenderer);

        // 可選：窗口完成加載後也發送一次初始邊界
        // 這部分最好由調用者在 webContents.on('did-finish-load', ...) 中處理，
        // 因為 setupBlurredWindowBackgroundIPC 可能在 webContents 準備好之前被調用。
        // 但如果希望更自動化，可以嘗試：
        if (mainWindowInstance.webContents && !mainWindowInstance.webContents.isDestroyed()) {
             if (mainWindowInstance.webContents.isLoading()) {
                mainWindowInstance.webContents.once('did-finish-load', () => {
                    setTimeout(sendBoundsToRenderer, 100); // 短暫延遲以確保渲染器已準備好
                });
            } else {
                // 如果已加載，可能需要發送
                setTimeout(sendBoundsToRenderer, 100);
            }
        }


        // 清理：當窗口關閉時，移除監聽器 (雖然窗口銷毀後它們通常也會失效)
        mainWindowInstance.once('closed', () => {
            // mainWindowInstance 仍然指向舊的已關閉窗口，所以 removeListener 仍然有效
            if (mainWindowInstance && typeof mainWindowInstance.removeListener === 'function') {
                 mainWindowInstance.removeListener('move', sendBoundsToRenderer);
                 mainWindowInstance.removeListener('resize', sendBoundsToRenderer);
                 console.log('[BWB IPC Setup] 已從已關閉窗口移除 move/resize 監聽器。');
            }
        });

        console.log('[BWB IPC Setup] BlurredWindowBackground 的 IPC 通道和窗口事件監聽器已成功設置。');

    } else if (typeof windowOrThunk !== 'function') {
        // 如果傳入的是一個已銷毀的窗口實例，而不是一個函數，則警告。
        console.warn('[BWB IPC Setup] 傳入的 mainWindow 實例無效或已銷毀，無法綁定 move/resize 事件。');
    } else {
        // 如果傳入的是函數，則由該函數負責提供有效的窗口。
        // move/resize 事件的綁定將依賴於該函數在事件觸發時返回有效的窗口。
        // 這種情況下，上面直接綁定的邏輯可能不會按預期工作，除非 windowOrThunk 始終返回同一個活動窗口。
        // 一個更健壯的做法是，如果傳入的是函數，則在 sendBoundsToRenderer 內部動態獲取窗口並檢查。
        // 但對於 'on' 事件綁定，我們需要在初始設置時有一個窗口實例。
        // 因此，推薦直接傳入創建好的 mainWindow 實例。
        console.log('[BWB IPC Setup] 以函數形式傳入 mainWindow。move/resize 事件將在事件觸發時嘗試獲取窗口。');
        // 注意：如果 windowOrThunk 是一個函數，則上述 mainWindowInstance.on(...) 的綁定可能只對首次調用 getMainWindow() 時的窗口有效。
        // 如果窗口會被重新創建，那麼這些綁定需要重新設置。
        // 為了簡單起見，此處假設傳入的 mainWindow 是在 setup 時有效的，或者 windowOrThunk 返回的是一個穩定的引用。
    }
}

module.exports = { setupBlurredWindowBackgroundIPC };
