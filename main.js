const { app, BrowserWindow, ipcMain, dialog, systemPreferences, shell, Menu, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { fileURLToPath } = require('url');
const { execFile } = require('child_process');

let mainWindow = null;
let isQuitting = false;
let isHandlingQuit = false;
let pendingBundlePath = null;
let attachmentDragIcon = null;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'zotero:']);
const DEFAULT_BUNDLE_EXTENSION = '.kangaroo';
const LEGACY_BUNDLE_EXTENSION = '.textbundle';

function normalizeBundleSavePath(filePath) {
    const normalizedPath = String(filePath || '').trim();
    if (!normalizedPath) {
        return '';
    }

    const ext = path.extname(normalizedPath).toLowerCase();
    if (ext === DEFAULT_BUNDLE_EXTENSION) {
        return normalizedPath;
    }

    if (ext === LEGACY_BUNDLE_EXTENSION) {
        return normalizedPath.slice(0, -LEGACY_BUNDLE_EXTENSION.length) + DEFAULT_BUNDLE_EXTENSION;
    }

    return `${normalizedPath}${DEFAULT_BUNDLE_EXTENSION}`;
}

if (!hasSingleInstanceLock) {
    app.quit();
}

function sendMenuAction(action) {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (!win || win.isDestroyed()) return;
    win.webContents.send('menu:action', action);
}

function buildAppMenu() {
    const template = [];

    if (process.platform === 'darwin') {
        template.push({
            label: app.name,
            submenu: [
                { role: 'about', label: '关于 Kangaroo' },
                { type: 'separator' },
                { role: 'services', label: '服务' },
                { type: 'separator' },
                { role: 'hide', label: '隐藏 Kangaroo' },
                { role: 'hideOthers', label: '隐藏其他' },
                { role: 'unhide', label: '全部显示' },
                { type: 'separator' },
                { role: 'quit', label: '退出 Kangaroo' }
            ]
        });
    }

    template.push({
        label: 'File',
        submenu: [
            { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendMenuAction('new') },
            { label: '打开', accelerator: 'CmdOrCtrl+O', click: () => sendMenuAction('open') },
            { label: '打开文件夹', accelerator: 'CmdOrCtrl+Shift+O', click: () => sendMenuAction('openFolder') },
            { label: '关闭文件夹', accelerator: 'CmdOrCtrl+Shift+W', click: () => sendMenuAction('closeFolder') },
            { label: '导入 Markdown 文件夹', accelerator: 'CmdOrCtrl+Alt+I', click: () => sendMenuAction('importMarkdownFolder') },
            { type: 'separator' },
            { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendMenuAction('save') },
            { label: '另存为', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenuAction('saveAs') },
            { type: 'separator' },
            {
                label: '导出',
                submenu: [
                    { label: '导出为 HTML 单文件', accelerator: 'CmdOrCtrl+Alt+E', click: () => sendMenuAction('exportHtml') }
                ]
            },
            { type: 'separator' },
            { label: '设置', accelerator: 'CmdOrCtrl+,', click: () => sendMenuAction('settings') }
        ]
    });

    template.push({
        label: 'Edit',
        submenu: [
            { label: '撤销', accelerator: 'CmdOrCtrl+Z', click: () => sendMenuAction('undo') },
            { label: '重做', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendMenuAction('redo') },
            { type: 'separator' },
            { role: 'cut', label: '剪切' },
            { role: 'copy', label: '复制' },
            { role: 'paste', label: '粘贴' },
            { role: 'selectAll', label: '全选' }
        ]
    });

    template.push({
        label: 'Window',
        submenu: process.platform === 'darwin'
            ? [
                { role: 'minimize', label: '最小化' },
                { role: 'zoom', label: '缩放' },
                { type: 'separator' },
                { role: 'front', label: '移到最前' }
            ]
            : [
                { role: 'minimize', label: '最小化' },
                { role: 'close', label: '关闭窗口' }
            ]
    });

    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function isValidBundle(bundlePath) {
    return (
        fs.existsSync(path.join(bundlePath, 'text.markdown'))
        || fs.existsSync(path.join(bundlePath, 'text.md'))
        || (
            fs.existsSync(path.join(bundlePath, 'manifest.json'))
            && fs.existsSync(path.join(bundlePath, 'document.json'))
        )
    );
}

function normalizeOpenTarget(target) {
    if (!target) return null;

    if (typeof target === 'object' && target.type && target.value) {
        return target;
    }

    const value = String(target);

    if (/^file:/i.test(value)) {
        return {
            type: 'path',
            value: fileURLToPath(value)
        };
    }

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(value)) {
        return {
            type: 'external',
            value
        };
    }

    return {
        type: 'path',
        value
    };
}

async function openTargetWithSystem(target) {
    const normalizedTarget = normalizeOpenTarget(target);
    if (!normalizedTarget || !normalizedTarget.value) {
        return { ok: false, error: '无效的链接目标。' };
    }

    if (normalizedTarget.type === 'external') {
        let protocol = '';
        try {
            protocol = new URL(normalizedTarget.value).protocol.toLowerCase();
        } catch {
            return { ok: false, error: '无效的外部链接。' };
        }

        if (!ALLOWED_EXTERNAL_PROTOCOLS.has(protocol)) {
            return { ok: false, error: `不允许打开该类型的外部链接：${protocol || normalizedTarget.value}` };
        }

        await shell.openExternal(normalizedTarget.value);
        return { ok: true };
    }

    if (!fs.existsSync(normalizedTarget.value)) {
        return { ok: false, error: `目标不存在：${normalizedTarget.value}` };
    }

    const result = await shell.openPath(normalizedTarget.value);
    if (result) {
        return { ok: false, error: result };
    }

    return { ok: true };
}

function pathToFileUri(filePath) {
    const normalizedPath = path.resolve(String(filePath || ''));
    return `file://${normalizedPath.split(path.sep).map(encodeURIComponent).join('/')}`;
}

function getMacFileClipboardHelperTarget() {
    const appCandidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'copy-file-to-clipboard.app') : '',
        path.join(app.getAppPath(), 'build', 'copy-file-to-clipboard.app'),
        path.join(__dirname, 'build', 'copy-file-to-clipboard.app')
    ].filter(Boolean);

    const appPath = appCandidates.find((candidate) => {
        try {
            fs.accessSync(path.join(candidate, 'Contents', 'MacOS', 'copy-file-to-clipboard'), fs.constants.X_OK);
            return true;
        } catch {
            return false;
            }
        });
    if (appPath) {
        return { type: 'app', path: appPath };
    }

    const candidates = [
        process.resourcesPath ? path.join(process.resourcesPath, 'copy-file-to-clipboard') : '',
        path.join(app.getAppPath(), 'build', 'copy-file-to-clipboard'),
        path.join(__dirname, 'build', 'copy-file-to-clipboard')
    ].filter(Boolean);

    const helperPath = candidates.find((candidate) => {
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        } catch {
            return false;
        }
    });
    return helperPath ? { type: 'executable', path: helperPath } : null;
}

function copyPathsWithMacClipboardHelper(filePaths) {
    const helperTarget = getMacFileClipboardHelperTarget();
    if (!helperTarget) {
        return Promise.resolve({ ok: false, error: '未找到 macOS 文件剪贴板辅助程序。' });
    }

    return new Promise((resolve) => {
        const command = helperTarget.type === 'app' ? '/usr/bin/open' : helperTarget.path;
        const args = helperTarget.type === 'app'
            ? ['-W', '-n', helperTarget.path, '--args', ...filePaths]
            : filePaths;
        execFile(command, args, { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    error: String(stderr || stdout || error.message || 'macOS 文件剪贴板写入失败。').trim()
                });
                return;
            }
            resolve({ ok: true, method: helperTarget.type === 'app' ? 'macos-helper-app' : 'macos-helper-executable' });
        });
    });
}

function copyPathsWithMacFinder(filePaths) {
    const normalizedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths])
        .map((filePath) => path.resolve(String(filePath || '')))
        .filter(Boolean);
    if (!normalizedPaths.length) {
        return Promise.resolve({ ok: false, error: '没有可复制的文件。' });
    }

    const script = [
        'on run argv',
        '    if (count of argv) is 1 then',
        '        set the clipboard to item 1 of argv as «class furl»',
        '    else',
        '        set fileReferences to {}',
        '        repeat with filePath in argv',
        '            set end of fileReferences to (filePath as «class furl»)',
        '        end repeat',
        '        set the clipboard to fileReferences',
        '    end if',
        'end run'
    ].join('\n');

    return new Promise((resolve) => {
        execFile('/usr/bin/osascript', [
            '-e',
            script,
            ...normalizedPaths
        ], { timeout: 5000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    error: String(stderr || stdout || error.message || 'Finder 文件剪贴板写入失败。').trim()
                });
                return;
            }
            resolve({ ok: true, method: 'macos-finder-clipboard' });
        });
    });
}

function copyPathsWithMacFinderKeyboard(filePaths) {
    const normalizedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths])
        .map((filePath) => path.resolve(String(filePath || '')))
        .filter(Boolean);
    if (!normalizedPaths.length) {
        return Promise.resolve({ ok: false, error: '没有可复制的文件。' });
    }

    const script = [
        'on run argv',
        '    set fileReferences to {}',
        '    repeat with filePath in argv',
        '        set end of fileReferences to (POSIX file filePath as alias)',
        '    end repeat',
        '    tell application "Finder"',
        '        activate',
        '        set selection to fileReferences',
        '    end tell',
        '    delay 0.15',
        '    tell application "System Events"',
        '        keystroke "c" using command down',
        '    end tell',
        'end run'
    ].join('\n');

    return new Promise((resolve) => {
        execFile('/usr/bin/osascript', [
            '-e',
            script,
            ...normalizedPaths
        ], { timeout: 8000 }, (error, stdout, stderr) => {
            if (error) {
                resolve({
                    ok: false,
                    error: String(stderr || stdout || error.message || 'Finder Cmd+C 文件复制失败。请在系统设置中允许 Kangaroo 控制 Finder 和 System Events。').trim()
                });
                return;
            }
            resolve({ ok: true, method: 'macos-finder-command-c' });
        });
    });
}

function writeFileUrlClipboardFormats(filePaths) {
    const normalizedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths])
        .map((filePath) => path.resolve(String(filePath || '')))
        .filter(Boolean);
    if (!normalizedPaths.length) {
        return { ok: false, error: '没有可复制的文件。' };
    }

    const fileUrls = normalizedPaths.map(pathToFileUri);
    const primaryFileUrl = fileUrls[0];

    clipboard.clear();
    let wroteFormat = false;

    for (const [format, value] of [
        ['public.file-url', Buffer.from(primaryFileUrl, 'utf8')],
        ['public.url', Buffer.from(primaryFileUrl, 'utf8')],
        ['NSURLPboardType', Buffer.from(primaryFileUrl, 'utf8')],
        ['text/uri-list', Buffer.from(`${fileUrls.join('\n')}\n`, 'utf8')],
        ['x-special/gnome-copied-files', Buffer.from(`copy\n${fileUrls.join('\n')}`, 'utf8')],
        ['public/utf8-plain-text', Buffer.from(primaryFileUrl, 'utf8')],
        ['public/file-url', Buffer.from(primaryFileUrl, 'utf8')]
    ]) {
        try {
            clipboard.writeBuffer(format, value);
            wroteFormat = true;
        } catch {
            // Keep trying other representations.
        }
    }

    return {
        ok: wroteFormat,
        formats: typeof clipboard.availableFormats === 'function' ? clipboard.availableFormats() : []
    };
}

function writeLinuxFileClipboardFormats(filePaths) {
    const normalizedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths])
        .map((filePath) => path.resolve(String(filePath || '')))
        .filter(Boolean);
    if (!normalizedPaths.length) {
        return { ok: false, error: '没有可复制的文件。' };
    }

    const fileUrls = normalizedPaths.map(pathToFileUri);
    const uriList = `${fileUrls.join('\n')}\n`;
    const gnomeCopiedFiles = `copy\n${fileUrls.join('\n')}`;

    clipboard.clear();
    try {
        clipboard.writeText(uriList);
        clipboard.writeBuffer('text/uri-list', Buffer.from(uriList, 'utf8'));
        clipboard.writeBuffer('x-special/gnome-copied-files', Buffer.from(gnomeCopiedFiles, 'utf8'));
        return {
            ok: true,
            method: 'linux-uri-list',
            formats: typeof clipboard.availableFormats === 'function' ? clipboard.availableFormats() : []
        };
    } catch (error) {
        return { ok: false, error: error.message };
    }
}

function copyPathsWithWindowsClipboard(filePaths) {
    const normalizedPaths = (Array.isArray(filePaths) ? filePaths : [filePaths])
        .map((filePath) => path.resolve(String(filePath || '')))
        .filter(Boolean);
    if (!normalizedPaths.length) {
        return Promise.resolve({ ok: false, error: '没有可复制的文件。' });
    }

    const commands = [
        ['powershell.exe', ['-STA', '-NoProfile', '-NonInteractive', '-Command']],
        ['pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command']]
    ];
    const script = [
        'Add-Type -AssemblyName System.Windows.Forms;',
        '$files = New-Object System.Collections.Specialized.StringCollection;',
        'foreach ($path in $args) {',
        '  $resolved = (Resolve-Path -LiteralPath $path -ErrorAction Stop).ProviderPath;',
        '  [void] $files.Add($resolved);',
        '}',
        '[System.Windows.Forms.Clipboard]::SetFileDropList($files);'
    ].join(' ');

    const tryCommand = (index = 0) => {
        if (index >= commands.length) {
            return Promise.resolve({ ok: false, error: '无法调用 Windows 文件剪贴板。' });
        }

        const [command, baseArgs] = commands[index];
        return new Promise((resolve) => {
            execFile(command, [
                ...baseArgs,
                script,
                ...normalizedPaths
            ], { windowsHide: true }, (error, stdout, stderr) => {
                if (!error) {
                    resolve({ ok: true, method: 'windows-file-drop' });
                    return;
                }

                tryCommand(index + 1).then((result) => {
                    if (!result.ok && index === commands.length - 1) {
                        resolve({
                            ok: false,
                            error: String(stderr || stdout || error.message || result.error || '无法调用 Windows 文件剪贴板。').trim()
                        });
                        return;
                    }
                    resolve(result);
                });
            });
        });
    };

    return tryCommand();
}

async function copyPathToSystemClipboard(target) {
    const normalizedTarget = normalizeOpenTarget(target);
    if (!normalizedTarget || normalizedTarget.type !== 'path' || !normalizedTarget.value) {
        return { ok: false, error: '无效的文件目标。' };
    }

    const normalizedPath = path.resolve(String(normalizedTarget.value));
    if (!fs.existsSync(normalizedPath)) {
        return { ok: false, error: `目标不存在：${normalizedPath}` };
    }

    if (process.platform === 'darwin') {
        const finderResult = await copyPathsWithMacFinder([normalizedPath]);
        if (finderResult.ok) {
            return finderResult;
        }

        return finderResult;
    }

    if (process.platform === 'win32') {
        return await copyPathsWithWindowsClipboard([normalizedPath]);
    }

    return writeLinuxFileClipboardFormats([normalizedPath]);
}

function getAttachmentDragIcon() {
    if (attachmentDragIcon && !attachmentDragIcon.isEmpty()) {
        return attachmentDragIcon;
    }

    const dragIconPath = path.join(app.getAppPath(), 'build', 'icon.png');
    const icon = nativeImage.createFromPath(dragIconPath);
    attachmentDragIcon = icon.isEmpty() ? icon : icon.resize({ width: 32, height: 32 });
    return attachmentDragIcon;
}

async function confirmRendererCanClose(win) {
    try {
        const shouldClose = await win.webContents.executeJavaScript(
            'window.__codexConfirmBeforeClose ? window.__codexConfirmBeforeClose() : true',
            true
        );

        return Boolean(shouldClose);
    } catch (error) {
        console.warn('关闭前确认失败，按直接关闭处理:', error);
        return true;
    }
}

function createWindow() {
    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
        return mainWindow;
    }

    const win = new BrowserWindow({
        width: 1200,
        height: 800,
        show: false,
        titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        win.show();
        win.focus();
    });

    win.loadFile('index.html');
    win.webContents.on('did-finish-load', () => {
        flushPendingBundleOpen();
    });
    win.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
        openTargetWithSystem(targetUrl).catch((error) => {
            console.warn('打开新窗口链接失败:', error);
        });

        return { action: 'deny' };
    });

    win.webContents.on('will-navigate', (event, navigationUrl) => {
        if (navigationUrl === win.webContents.getURL()) return;

        event.preventDefault();
        openTargetWithSystem(navigationUrl).catch((error) => {
            console.warn('拦截窗口内导航失败:', error);
        });
    });

    win.on('close', async (event) => {
        if (isQuitting) return;

        event.preventDefault();

        const shouldClose = await confirmRendererCanClose(win);
        if (!shouldClose) {
            return;
        }

        win.destroy();
    });

    win.on('closed', () => {
        if (mainWindow === win) {
            mainWindow = null;
        }
    });

    // 如果需要调试，可以取消下面这行的注释
    // win.webContents.openDevTools();

    mainWindow = win;
    return win;
}

function normalizeBundlePath(bundlePath) {
    if (!bundlePath) return null;

    const resolvedPath = path.resolve(String(bundlePath));
    return isValidBundle(resolvedPath) ? resolvedPath : null;
}

function queueBundleOpen(bundlePath) {
    const normalizedPath = normalizeBundlePath(bundlePath);
    if (!normalizedPath) return false;

    pendingBundlePath = normalizedPath;
    flushPendingBundleOpen();
    return true;
}

function flushPendingBundleOpen() {
    if (!pendingBundlePath || !mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (mainWindow.webContents.isLoading()) {
        return;
    }

    if (mainWindow.isMinimized()) {
        mainWindow.restore();
    }

    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send('bundle:openExternal', pendingBundlePath);
}

function getBundlePathFromArgv(argv = []) {
    for (const arg of argv) {
        if (!arg || arg.startsWith('-')) continue;

        const bundlePath = normalizeBundlePath(arg);
        if (bundlePath) {
            return bundlePath;
        }
    }

    return null;
}

// 监听：打开 TextBundle 文件夹
ipcMain.handle('dialog:openBundle', async (_, options = {}) => {
    const properties = ['openFile', 'openDirectory', 'createDirectory'];

    if (process.platform === 'darwin') {
        properties.push('treatPackageAsDirectory');
    }

    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: options.title || '选择 Kangaroo 文件夹',
        buttonLabel: options.buttonLabel || undefined,
        defaultPath: options.defaultPath || undefined,
        properties,
        filters: [
            { name: 'Kangaroo', extensions: ['kangaroo', 'textbundle'] }
        ]
    });

    if (canceled || filePaths.length === 0) return null;

    const selectedPath = filePaths[0];

    if (isValidBundle(selectedPath)) {
        return selectedPath;
    } else {
        throw new Error('所选文件夹缺少 text.md、text.markdown 或 private format 文件，不是有效的 Kangaroo bundle。');
    }
});

ipcMain.handle('dialog:openWorkspaceFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择笔记工作空间文件夹',
        properties: ['openDirectory', 'createDirectory']
    });

    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

ipcMain.handle('dialog:selectMarkdownImportSource', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择要导入的 Markdown 文件夹',
        properties: ['openDirectory']
    });

    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

ipcMain.handle('dialog:selectMarkdownImportTarget', async (_, options = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择导入目标文件夹',
        defaultPath: options.defaultPath || undefined,
        properties: ['openDirectory', 'createDirectory']
    });

    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

ipcMain.handle('dialog:openFolder', async (_, options = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: options.title || '选择文件夹',
        buttonLabel: options.buttonLabel || undefined,
        defaultPath: options.defaultPath || undefined,
        properties: ['openDirectory', 'createDirectory']
    });

    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

// 监听：新建 TextBundle
ipcMain.handle('dialog:createBundle', async (_, options = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '新建 Kangaroo bundle',
        defaultPath: options.defaultPath || `我的文档${DEFAULT_BUNDLE_EXTENSION}`,
        buttonLabel: '创建',
        filters: [
            { name: 'Kangaroo', extensions: ['kangaroo', 'textbundle'] }
        ]
    });

    if (canceled || !filePath) return null;

    return normalizeBundleSavePath(filePath);
});

ipcMain.handle('dialog:createWorkspaceFolder', async (_, options = {}) => {
    const defaultPath = options.defaultPath || '新建文件夹';
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '新建文件夹',
        defaultPath,
        buttonLabel: '创建文件夹',
        properties: ['createDirectory', 'showOverwriteConfirmation']
    });

    if (canceled || !filePath) return null;
    return filePath;
});

ipcMain.handle('dialog:renameWorkspaceFolder', async (_, options = {}) => {
    const defaultPath = options.defaultPath || '新建文件夹';
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '重命名文件夹',
        defaultPath,
        buttonLabel: '确认命名',
        properties: ['showOverwriteConfirmation']
    });

    if (canceled || !filePath) return null;
    return filePath;
});

ipcMain.handle('dialog:renameAttachmentPath', async (event, options = {}) => {
    const defaultPath = options.defaultPath || '';
    const isDirectory = Boolean(options.isDirectory);
    const ownerWindow = BrowserWindow.fromWebContents(event.sender) || BrowserWindow.getFocusedWindow() || mainWindow || undefined;
    const { canceled, filePath } = await dialog.showSaveDialog(ownerWindow, {
        title: isDirectory ? '重命名文件夹附件' : '重命名文件附件',
        defaultPath,
        buttonLabel: '确认重命名',
        properties: ['showOverwriteConfirmation']
    });

    if (canceled || !filePath) return null;
    return filePath;
});

ipcMain.handle('dialog:saveBundleAs', async (_, options = {}) => {
    const defaultPath = options.defaultPath || `我的文档${DEFAULT_BUNDLE_EXTENSION}`;
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '另存为 Kangaroo bundle',
        defaultPath,
        buttonLabel: '保存',
        filters: [
            { name: 'Kangaroo', extensions: ['kangaroo', 'textbundle'] }
        ]
    });

    if (canceled || !filePath) return null;

    return normalizeBundleSavePath(filePath);
});

ipcMain.handle('dialog:saveHtmlExport', async (_, options = {}) => {
    const defaultPath = options.defaultPath || '未命名文档.html';
    const { canceled, filePath } = await dialog.showSaveDialog({
        title: '导出 HTML',
        defaultPath,
        buttonLabel: '导出',
        filters: [
            { name: 'HTML', extensions: ['html', 'htm'] }
        ]
    });

    if (canceled || !filePath) return null;

    const extension = path.extname(filePath).toLowerCase();
    if (extension === '.html' || extension === '.htm') {
        return filePath;
    }

    return `${filePath}.html`;
});

ipcMain.handle('dialog:confirmUnsavedChanges', async (_, options = {}) => {
    const { actionLabel = '继续当前操作', canSave = true } = options;

    const buttons = canSave
        ? ['保存', '不保存', '取消']
        : ['不保存', '取消'];

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
        title: '未保存内容',
        message: `当前内容尚未保存，确定要${actionLabel}吗？`,
        detail: canSave ? '你可以先保存更改，也可以不保存继续。' : '当前内容还没有可保存的位置，只能选择不保存或取消。',
        noLink: true
    });

    if (canSave) {
        return ['save', 'discard', 'cancel'][response] || 'cancel';
    }

    return ['discard', 'cancel'][response] || 'cancel';
});

ipcMain.handle('dialog:confirmDeleteAttachmentEntry', async (_, options = {}) => {
    const {
        entryName = '该附件',
        isDirectory = false
    } = options;

    const entryLabel = isDirectory ? '文件夹' : '文件';
    const deleteLabel = isDirectory ? '删除文件夹' : '删除文件';
    const detail = isDirectory
        ? '删除后文件夹及其中所有内容会被移到系统回收站；取消则恢复刚删除的链接。'
        : '删除后附件文件会被移到系统回收站；取消则恢复刚删除的链接。';

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: [deleteLabel, '取消'],
        defaultId: 1,
        cancelId: 1,
        title: `删除附件${entryLabel}`,
        message: `链接已删除，是否同时删除附件${entryLabel}“${entryName}”？`,
        detail,
        noLink: true
    });

    return response === 0 ? 'delete' : 'cancel';
});

ipcMain.handle('dialog:confirmDeleteUnreferencedAttachments', async (_, options = {}) => {
    const count = Math.max(0, Number(options.count) || 0);

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['删除', '取消'],
        defaultId: 1,
        cancelId: 1,
        title: '删除未引用附件',
        message: `确定要删除这 ${count} 个未引用附件吗？`,
        detail: '这些文件和文件夹会被移到系统回收站。',
        noLink: true
    });

    return response === 0 ? 'delete' : 'cancel';
});

ipcMain.handle('dialog:confirmDeleteWorkspaceEntry', async (_, options = {}) => {
    const entryName = options.entryName || '这个项目';
    const isFolder = Boolean(options.isFolder);
    const buttons = [isFolder ? '删除文件夹' : '删除文档', '取消'];

    const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons,
        defaultId: 1,
        cancelId: 1,
        message: isFolder
            ? `要删除文件夹“${entryName}”吗？`
            : `要删除文档“${entryName}”吗？`,
        detail: '删除后会进入系统回收站。',
        noLink: true
    });

    return response === 0 ? 'delete' : 'cancel';
});

ipcMain.handle('shell:openLinkTarget', async (_, target) => {
    return openTargetWithSystem(target);
});

ipcMain.handle('shell:revealLinkTarget', async (_, target) => {
    const normalizedTarget = normalizeOpenTarget(target);
    if (!normalizedTarget || normalizedTarget.type !== 'path' || !normalizedTarget.value) {
        return { ok: false, error: '无效的文件目标。' };
    }

    if (!fs.existsSync(normalizedTarget.value)) {
        return { ok: false, error: `目标不存在：${normalizedTarget.value}` };
    }

    shell.showItemInFolder(normalizedTarget.value);
    return { ok: true };
});

ipcMain.handle('shell:trashPath', async (_, target) => {
    const normalizedTarget = normalizeOpenTarget(target);
    if (!normalizedTarget || normalizedTarget.type !== 'path' || !normalizedTarget.value) {
        return { ok: false, error: '无效的文件目标。' };
    }

    if (!fs.existsSync(normalizedTarget.value)) {
        return { ok: false, error: `目标不存在：${normalizedTarget.value}` };
    }

    try {
        await shell.trashItem(normalizedTarget.value);
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('shell:copyFileTarget', async (_, target) => {
    try {
        return await copyPathToSystemClipboard(target);
    } catch (error) {
        return { ok: false, error: error.message || '复制附件失败。' };
    }
});

ipcMain.on('attachment:startDrag', (event, payload = {}) => {
    const targetPath = typeof payload === 'string' ? payload : payload.path;
    if (!targetPath) {
        event.returnValue = false;
        return;
    }

    const normalizedPath = path.resolve(String(targetPath));
    if (!fs.existsSync(normalizedPath)) {
        event.returnValue = false;
        return;
    }

    try {
        event.sender.startDrag({
            file: normalizedPath,
            icon: getAttachmentDragIcon()
        });
        event.returnValue = true;
    } catch (error) {
        console.warn('启动附件拖拽失败:', error);
        event.returnValue = false;
    }
});

ipcMain.handle('window:showAndFocus', async () => {
    const win = createWindow();
    if (!win || win.isDestroyed()) {
        return { ok: false, error: '主窗口不可用。' };
    }

    try {
        if (win.isMinimized()) {
            win.restore();
        }
        win.show();
        win.focus();
        if (process.platform === 'darwin' && app.dock?.bounce) {
            app.dock.bounce('informational');
        } else if (typeof win.flashFrame === 'function') {
            win.flashFrame(true);
            setTimeout(() => {
                try {
                    win.flashFrame(false);
                } catch {
                    // ignore
                }
            }, 1500);
        }
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error.message };
    }
});

ipcMain.handle('dialog:chooseAppForFile', async (_, target) => {
    const normalizedTarget = normalizeOpenTarget(target);
    if (!normalizedTarget || normalizedTarget.type !== 'path' || !normalizedTarget.value) {
        return { ok: false, error: '无效的文件目标。' };
    }

    if (!fs.existsSync(normalizedTarget.value)) {
        return { ok: false, error: `目标不存在：${normalizedTarget.value}` };
    }

    if (process.platform !== 'darwin') {
        return { ok: false, error: '当前仅在 macOS 上支持选择应用打开。' };
    }

    const { canceled, filePaths } = await dialog.showOpenDialog({
        title: '选择打开目标的应用',
        properties: ['openFile', 'openDirectory', 'treatPackageAsDirectory'],
        filters: [
            { name: '应用程序', extensions: ['app'] }
        ]
    });

    if (canceled || !filePaths.length) {
        return { ok: false, canceled: true };
    }

    const appPath = filePaths[0];

    return await new Promise((resolve) => {
        execFile('/usr/bin/open', ['-a', appPath, normalizedTarget.value], (error) => {
            if (error) {
                resolve({ ok: false, error: error.message });
                return;
            }

            resolve({ ok: true });
        });
    });
});

app.on('will-finish-launching', () => {
    app.on('open-file', (event, filePath) => {
        event.preventDefault();
        queueBundleOpen(filePath);
    });
});

app.on('second-instance', (_, argv) => {
    const targetBundlePath = getBundlePathFromArgv(argv.slice(1));

    if (targetBundlePath) {
        queueBundleOpen(targetBundlePath);
    } else if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
    } else {
        createWindow();
    }
});

if (hasSingleInstanceLock) {
    app.whenReady().then(() => {
    buildAppMenu();

    if (process.platform === 'darwin') {
        try {
            systemPreferences.setUserDefault('ApplePressAndHoldEnabled', 'boolean', false);
        } catch (error) {
            console.warn('无法关闭 macOS 长按弹音标行为:', error);
        }
    }

    createWindow();
    const startupBundlePath = getBundlePathFromArgv(process.argv.slice(1));
    if (startupBundlePath) {
        queueBundleOpen(startupBundlePath);
    }
    });
}

ipcMain.handle('bundle:getPendingOpen', () => {
    return pendingBundlePath;
});

ipcMain.on('bundle:clearPendingOpen', (_, filePath) => {
    if (!pendingBundlePath) return;

    if (!filePath || path.resolve(filePath) === path.resolve(pendingBundlePath)) {
        pendingBundlePath = null;
    }
});

app.on('before-quit', async (event) => {
    if (isQuitting || isHandlingQuit) return;

    const activeWindow = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows()[0];

    if (!activeWindow) {
        isQuitting = true;
        return;
    }

    event.preventDefault();
    isHandlingQuit = true;

    try {
        const shouldQuit = await confirmRendererCanClose(activeWindow);
        if (!shouldQuit) {
            return;
        }

        isQuitting = true;
        app.quit();
    } finally {
        isHandlingQuit = false;
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
        return;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.show();
        mainWindow.focus();
    }
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
