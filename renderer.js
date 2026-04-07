const fs = window.nodeRequire('fs');
const path = window.nodeRequire('path');
const url = window.nodeRequire('url');
const os = window.nodeRequire('os');
const processRef = window.nodeRequire('process');
const { ipcRenderer, clipboard, webUtils, nativeImage } = window.nodeRequire('electron');
const https = window.nodeRequire('https');
const http = window.nodeRequire('http');
const { DOMSerializer } = window.nodeRequire('@tiptap/pm/model');
const { createWysiwygEditor } = window.nodeRequire(path.join(__dirname, 'wysiwyg-editor.js'));
let markdownRenderer = null;
const IS_MACOS = processRef.platform === 'darwin';
const KANGAROO_INTERNAL_SLICE_MIME = 'application/x-kangaroo-slice+json';

const previewLineTokenTypes = new Set([
    'paragraph_open',
    'heading_open',
    'blockquote_open',
    'bullet_list_open',
    'ordered_list_open',
    'list_item_open',
    'table_open',
    'thead_open',
    'tbody_open',
    'tr_open'
]);

function getMarkdownRenderer() {
    if (markdownRenderer) {
        return markdownRenderer;
    }

    const MarkdownIt = window.nodeRequire('markdown-it');
    const md = new MarkdownIt({
        html: true,
        linkify: true,
        breaks: true,
        validateLink: () => true
    });

    md.core.ruler.after('inline', 'codex-task-lists', (state) => {
        const listItemStack = [];

        for (let index = 0; index < state.tokens.length; index++) {
            const token = state.tokens[index];

            if (token.type === 'list_item_open') {
                listItemStack.push(index);
                continue;
            }

            if (token.type === 'list_item_close') {
                listItemStack.pop();
                continue;
            }

            if (token.type !== 'inline' || !listItemStack.length) {
                continue;
            }

            const taskMatch = token.content.match(/^\[([ xX])\]\s+/);
            if (!taskMatch) {
                continue;
            }

            const listItemIndex = listItemStack[listItemStack.length - 1];
            const listItemToken = state.tokens[listItemIndex];
            const paragraphToken = index > 0 && state.tokens[index - 1].type === 'paragraph_open'
                ? state.tokens[index - 1]
                : null;
            const sourceMap = listItemToken.map || token.map || (paragraphToken ? paragraphToken.map : null);
            const taskMeta = {
                checked: taskMatch[1].toLowerCase() === 'x',
                sourceLine: sourceMap && typeof sourceMap[0] === 'number' ? sourceMap[0] + 1 : null
            };

            listItemToken.meta = { ...(listItemToken.meta || {}), task: taskMeta };
            if (paragraphToken) {
                paragraphToken.meta = { ...(paragraphToken.meta || {}), task: taskMeta };
            }
            token.meta = { ...(token.meta || {}), task: taskMeta };

            stripTaskMarkerFromInlineToken(token, taskMatch[0]);
            injectTaskCheckboxIntoInlineToken(state, token, taskMeta);
        }
    });

    const defaultRenderToken = md.renderer.renderToken.bind(md.renderer);
    md.renderer.renderToken = function (tokens, idx, options) {
        const token = tokens[idx];

        if (token.map && previewLineTokenTypes.has(token.type)) {
            token.attrSet('data-source-line', String(token.map[0] + 1));
            token.attrSet('data-source-line-end', String(token.map[1]));
        }

        return defaultRenderToken(tokens, idx, options);
    };

    const defaultFenceRenderer = md.renderer.rules.fence || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.fence = function (tokens, idx, options, env, self) {
        return addSourceLineAttribute(defaultFenceRenderer(tokens, idx, options, env, self), tokens[idx].map);
    };

    const defaultCodeBlockRenderer = md.renderer.rules.code_block || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.code_block = function (tokens, idx, options, env, self) {
        return addSourceLineAttribute(defaultCodeBlockRenderer(tokens, idx, options, env, self), tokens[idx].map);
    };

    const defaultHrRenderer = md.renderer.rules.hr || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.hr = function (tokens, idx, options, env, self) {
        return addSourceLineAttribute(defaultHrRenderer(tokens, idx, options, env, self), tokens[idx].map);
    };

    const defaultListItemRenderer = md.renderer.rules.list_item_open || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.list_item_open = function (tokens, idx, options, env, self) {
        const token = tokens[idx];

        if (token.meta && token.meta.task) {
            token.attrJoin('class', 'task-list-item');

            if (token.meta.task.sourceLine) {
                token.attrSet('data-task-line', String(token.meta.task.sourceLine));
            }
        }

        return defaultListItemRenderer(tokens, idx, options, env, self);
    };

    const defaultParagraphOpenRenderer = md.renderer.rules.paragraph_open || function (tokens, idx, options, env, self) {
        return self.renderToken(tokens, idx, options);
    };

    md.renderer.rules.paragraph_open = function (tokens, idx, options, env, self) {
        const token = tokens[idx];

        if (token.meta && token.meta.task) {
            token.attrJoin('class', 'task-list-paragraph');
        }

        return defaultParagraphOpenRenderer(tokens, idx, options, env, self);
    };

    markdownRenderer = md;
    return markdownRenderer;
}

// ⭐ 保存状态
let isDirty = false;
let isEditorReady = false;
let resolveEditorReady;
let rejectEditorReady;
let editorInitializationStarted = false;
let isUsingFallbackEditor = false;
let fallbackTextarea = null;
let isSyncingPreviewScroll = false;
let pendingPreviewSyncMode = 'cursor';
let previewSyncFrame = null;
let previewScrollCleanupBound = false;
let suppressPreviewScrollSyncUntil = 0;
let suppressEditorDrivenPreviewSyncUntil = 0;
let lastKnownEditorLineCount = 1;
let activeEditorHighlightLine = null;
let clearEditorHighlightTimer = null;
let monacoLineHighlightCollection = null;
let fallbackCharWidth = null;
let dragCaretIndicator = null;
let pendingDropLocation = null;
let preservedUnusedAttachmentEntries = new Set();
let fallbackHighlightLayer = null;
let fallbackHighlightFrame = null;
let fallbackUndoStack = [];
let fallbackRedoStack = [];
let fallbackPendingSnapshot = null;
let fallbackApplyingHistory = false;
let editorRenderFrame = null;
let autoSaveTimer = null;
let editorTabs = [];
let activeTabId = null;
let nextEditorTabId = 1;
let currentSidebarTab = 'workspace';
let expandedAttachmentEntries = new Set();
let attachmentContextTarget = null;
let previewImageContextTarget = null;
let tabContextTargetId = null;
let editorLinkContextTarget = null;
let selectedPreviewImageKey = null;
let activePreviewImageResize = null;
let pendingPreviewVisibleLine = null;
let currentSettingsTab = 'theme';
let currentSearchQuery = '';
let currentSearchMatches = [];
let activeSearchMatchIndex = -1;
let currentSearchScope = 'document';
let suppressDocumentStateSync = false;
let draggedEditorTabId = null;
let workspaceRootPath = null;
let expandedWorkspaceEntries = new Set();
let workspaceContextTarget = null;
let draggedWorkspaceEntry = null;
let workspaceRenameTargetPath = null;
let suppressNextWorkspaceRenameBlurCommit = false;
let workspaceWatchers = [];
let workspaceRefreshTimer = null;
let workspaceBusyMessage = '';
let workspaceRefreshSuspended = 0;
let workspaceRefreshPending = false;
let suppressWorkspaceWatcherUntil = 0;
let attachmentInlineRenameState = null;
let pendingAttachmentDeleteSnapshot = null;

const AUTO_SAVE_DELAY = 0;
const RECOVERY_DIR_NAME = '.kangaroo-recovery';
const LAYOUT_SETTINGS_KEY = 'codex.layout.settings.v1';
const SIDEBAR_VISIBILITY_SETTINGS_KEY = 'codex.sidebar.visibility.v1';
const VIEW_MODE_SETTINGS_KEY = 'codex.view.mode.v1';
const THEME_SETTINGS_KEY = 'codex.theme.settings.v1';
const TYPOGRAPHY_SETTINGS_KEY = 'codex.typography.settings.v1';
const DEFAULT_THEME_ID = 'dark-ocean';
const DEFAULT_UNTITLED_CONTENT = '';
const DEFAULT_VIEW_MODE = 'split';
const WORKSPACE_SETTINGS_KEY = 'codex.workspace.root.v1';
const TODO_PANEL_SETTINGS_KEY = 'codex.todo.panel.v1';
const DEFAULT_LAYOUT_SETTINGS = {
    sidebarWidth: 18,
    editorWidth: 36,
    previewWidth: 46
};
const DEFAULT_TODO_PANEL_SETTINGS = {
    scope: 'document',
    sort: 'position',
    hideCompleted: false
};
const FONT_FAMILY_MAP = {
    'ui-system': '"SF Pro Display", "Segoe UI", "PingFang SC", "Helvetica Neue", sans-serif',
    'ui-pingfang': '"PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif',
    'ui-rounded': '"SF Pro Rounded", "PingFang SC", "Helvetica Neue", sans-serif',
    'editor-sfmono': '"SF Mono", "Menlo", "Monaco", monospace',
    'editor-jetbrains': '"JetBrains Mono", "SF Mono", "Menlo", monospace',
    'editor-fira': '"Fira Code", "SF Mono", "Menlo", monospace',
    'preview-charter': '"Charter", "Palatino Linotype", "Songti SC", serif',
    'preview-songti': '"Songti SC", "STSong", "Palatino Linotype", serif',
    'preview-pingfang': '"PingFang SC", "Hiragino Sans GB", "Helvetica Neue", sans-serif'
};
const DEFAULT_TYPOGRAPHY_SETTINGS = {
    uiFont: 'ui-system',
    editorFont: 'editor-sfmono',
    uiFontSize: 14,
    editorFontSize: 16,
    editorLineHeight: 1.3,
    editorParagraphSpacing: 4,
    toolbarPosition: 'top'
};
const MONACO_THEME_MAP = {
    'dark-ocean': { name: 'codex-dark-ocean', base: 'vs-dark', background: '#141a26', foreground: '#d9e0ea', lineHighlight: '#1b2331', selection: '#26455f' },
    'dark-graphite': { name: 'codex-dark-graphite', base: 'vs-dark', background: '#1f2228', foreground: '#e0e5ec', lineHighlight: '#2a2f38', selection: '#425066' },
    'dark-amber': { name: 'codex-dark-amber', base: 'vs-dark', background: '#221912', foreground: '#efe6d9', lineHighlight: '#302219', selection: '#69411a' },
    'dark-terracotta': { name: 'codex-dark-terracotta', base: 'vs-dark', background: '#241611', foreground: '#f1e4d8', lineHighlight: '#321f19', selection: '#6e3717' },
    'dark-forest': { name: 'codex-dark-forest', base: 'vs-dark', background: '#13211d', foreground: '#e4efe6', lineHighlight: '#1b3028', selection: '#2c5a45' },
    'light-luoxiaohei': { name: 'codex-light-luoxiaohei', base: 'vs', background: '#f6f1e7', foreground: '#3b352e', lineHighlight: '#ece6da', selection: '#d7e8d9' },
    'light-snow': { name: 'codex-light-snow', base: 'vs', background: '#fbfdff', foreground: '#314154', lineHighlight: '#edf4fb', selection: '#cfe4fb' },
    'light-mist': { name: 'codex-light-mist', base: 'vs', background: '#f9fcfc', foreground: '#29404b', lineHighlight: '#ecf6f7', selection: '#cde8eb' },
    'light-parchment': { name: 'codex-light-parchment', base: 'vs', background: '#fffaf2', foreground: '#48392d', lineHighlight: '#f6ebd8', selection: '#eed7b6' },
    'light-apricot': { name: 'codex-light-apricot', base: 'vs', background: '#fffaf6', foreground: '#4a382d', lineHighlight: '#f8ece1', selection: '#f1d2b7' },
    'light-garden': { name: 'codex-light-garden', base: 'vs', background: '#fcfffb', foreground: '#304338', lineHighlight: '#ebf5ea', selection: '#cfe6d2' }
};

const editorReadyPromise = new Promise((resolve, reject) => {
    resolveEditorReady = resolve;
    rejectEditorReady = reject;
});

applyTheme(loadThemePreference());
applyTypographySettings(loadTypographySettings());
applyLayoutSettings(loadLayoutSettings());
applySidebarVisibility(loadSidebarVisibilityPreference());
applyViewMode(loadViewModePreference());
restoreWorkspaceRootPreference();
renderWorkspaceTree();
renderEditorTabs();
updateEditorEmptyState();
updateBundleStatus(null);


// ==============================
// ⭐ 设置保存状态
// ==============================
function setDirty(state) {
    isDirty = state;
    const activeTab = getActiveTab();
    if (activeTab) {
        activeTab.isDirty = state;
        renderEditorTabs();
    }

    updateWindowTitle();

    if (!isDirty && autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
}

function ensureEditorReady() {
    if (window.editor && isEditorReady) {
        return true;
    }

    alert("编辑器仍在初始化，请稍候再试。");
    return false;
}

function ensureEditorInitialized() {
    if (editorInitializationStarted) return;
    editorInitializationStarted = true;
    initializeEditor();
}

async function waitForEditorReady() {
    ensureEditorInitialized();
    await editorReadyPromise;
}

function createEditorTabState({ path: folderPath = null, content = DEFAULT_UNTITLED_CONTENT, isDirty: dirty = false, searchQuery = '', preservedEntries = [] } = {}) {
    return {
        id: `tab-${nextEditorTabId++}`,
        path: folderPath,
        content,
        previousContent: content,
        isDirty: dirty,
        previousIsDirty: dirty,
        searchQuery,
        preservedEntries: [...preservedEntries]
    };
}

function getTabById(tabId = activeTabId) {
    return editorTabs.find((tab) => tab.id === tabId) || null;
}

function getActiveTab() {
    return getTabById(activeTabId);
}

function getTabTitle(tab) {
    if (!tab || !tab.path) {
        return '未命名';
    }

    const baseName = path.basename(tab.path, path.extname(tab.path));
    return baseName || '未命名';
}

function isDisposableWelcomeTab(tab) {
    if (!tab) return false;
    if (tab.path) return false;
    if (tab.isDirty) return false;

    const normalized = (tab.content || '').trim();
    return normalized === DEFAULT_UNTITLED_CONTENT.trim();
}

function persistActiveTabState(markdownOverride = null) {
    if (suppressDocumentStateSync || !window.editor) return;

    const tab = getActiveTab();
    if (!tab) return;

    const liveMarkdown = typeof markdownOverride === 'string'
        ? markdownOverride
        : (typeof window.editor.getValue === 'function'
            ? window.editor.getValue()
            : (typeof window.editor.getLiveMarkdownSnapshot === 'function'
                ? window.editor.getLiveMarkdownSnapshot()
                : ''));

    tab.previousContent = tab.content;
    tab.previousIsDirty = tab.isDirty;
    tab.path = window.currentPath || null;
    tab.content = liveMarkdown;
    tab.isDirty = isDirty;
    tab.searchQuery = currentSearchQuery;
    tab.preservedEntries = Array.from(preservedUnusedAttachmentEntries);
}

window.__kangarooPersistActiveTabState = persistActiveTabState;

function capturePendingAttachmentDeleteSnapshot(deleteMeta = null) {
    const activeTab = getActiveTab();
    if (!activeTab || !window.editor) return;

    const liveMarkdown = typeof window.editor.getLiveMarkdownSnapshot === 'function'
        ? window.editor.getLiveMarkdownSnapshot()
        : window.editor.getValue();

    pendingAttachmentDeleteSnapshot = {
        tabId: activeTab.id,
        path: window.currentPath || null,
        content: liveMarkdown,
        isDirty,
        preservedEntries: Array.from(preservedUnusedAttachmentEntries),
        searchQuery: currentSearchQuery,
        selection: typeof window.editor.getSelectionSnapshot === 'function'
            ? window.editor.getSelectionSnapshot()
            : null,
        deletedAsset: deleteMeta?.info?.node
            ? {
                type: deleteMeta.type || '',
                pos: typeof deleteMeta.info?.pos === 'number' ? deleteMeta.info.pos : null,
                nodeJSON: typeof deleteMeta.info.node?.toJSON === 'function'
                    ? deleteMeta.info.node.toJSON()
                    : null
            }
            : null
    };
}

function clearPendingAttachmentDeleteSnapshot() {
    pendingAttachmentDeleteSnapshot = null;
}

function applyPendingAttachmentDeleteSnapshot() {
    const activeTab = getActiveTab();
    const deleteSnapshot = pendingAttachmentDeleteSnapshot;
    if (!activeTab || !window.editor || !deleteSnapshot || deleteSnapshot.tabId !== activeTab.id) {
        return false;
    }

    suppressDocumentStateSync = true;
    window.currentPath = deleteSnapshot.path || window.currentPath;
    if (typeof window.editor.setBundlePath === 'function') {
        window.editor.setBundlePath(window.currentPath || null);
    }
    if (typeof window.editor.setValue === 'function') {
        window.editor.setValue(deleteSnapshot.content, { emitChange: false });
    }
    suppressDocumentStateSync = false;

    activeTab.path = deleteSnapshot.path;
    activeTab.content = deleteSnapshot.content;
    activeTab.previousContent = deleteSnapshot.content;
    activeTab.isDirty = Boolean(deleteSnapshot.isDirty);
    activeTab.previousIsDirty = Boolean(deleteSnapshot.isDirty);
    activeTab.searchQuery = deleteSnapshot.searchQuery || '';
    activeTab.preservedEntries = [...(deleteSnapshot.preservedEntries || [])];
    preservedUnusedAttachmentEntries = new Set(deleteSnapshot.preservedEntries || []);
    currentSearchQuery = deleteSnapshot.searchQuery || '';

    const searchInput = document.getElementById('toolbar-search-input');
    if (searchInput) {
        searchInput.value = currentSearchQuery;
    }

    updateBundleStatus(activeTab.path || null);
    renderToolbarSearchResults(currentSearchQuery);
    updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
    updateOutline();
    if (window.editor && typeof window.editor.refreshDisplayState === 'function') {
        window.editor.refreshDisplayState();
    }
    if (window.editor && typeof window.editor.restoreSelectionSnapshot === 'function') {
        window.editor.restoreSelectionSnapshot(deleteSnapshot.selection, { scrollIntoView: false });
    }
    if (window.editor && typeof window.editor.focus === 'function') {
        window.editor.focus();
    }
    setDirty(Boolean(deleteSnapshot.isDirty));
    renderEditorTabs();
    clearPendingAttachmentDeleteSnapshot();
    return true;
}

function restorePendingAttachmentDeleteSnapshotForCancel() {
    const activeTab = getActiveTab();
    const deleteSnapshot = pendingAttachmentDeleteSnapshot;
    if (!activeTab || !window.editor || !deleteSnapshot || deleteSnapshot.tabId !== activeTab.id) {
        return false;
    }
    clearPendingAutoSave();
    suppressWorkspaceWatcherUntil = Math.max(suppressWorkspaceWatcherUntil, Date.now() + 1500);
    return applyPendingAttachmentDeleteSnapshot();
}

function clearPendingAutoSave() {
    if (!autoSaveTimer) return;
    window.clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
}

function isPreviewActive() {
    const preview = document.getElementById('preview-container');
    if (!preview) return false;
    const style = window.getComputedStyle(preview);
    return style.display !== 'none' && style.visibility !== 'hidden';
}

function clearEditorForNoTab() {
    suppressDocumentStateSync = true;
    activeTabId = null;
    window.currentPath = null;
    preservedUnusedAttachmentEntries = new Set();
    currentSearchQuery = '';
    currentSearchMatches = [];
    activeSearchMatchIndex = -1;

    if (window.editor) {
        if (typeof window.editor.setBundlePath === 'function') {
            window.editor.setBundlePath(null);
        }
        if (typeof window.editor.setEditable === 'function') {
            window.editor.setEditable(false);
        }
        if (typeof window.editor.setValue === 'function') {
            window.editor.setValue(DEFAULT_UNTITLED_CONTENT);
        }
    }

    const searchInput = document.getElementById('toolbar-search-input');
    if (searchInput) {
        searchInput.value = '';
    }

    suppressDocumentStateSync = false;
    resetEditorLineTracking();
    updateBundleStatus(null);
    renderToolbarSearchResults('');
    refreshEditorToolbarState();
    updatePreview();
    updateOutline();
    renderWorkspaceTree();
    renderEditorTabs();
    updateEditorEmptyState();
    setDirty(false);
}

function renderEditorTabs() {
    const container = document.getElementById('editor-tabs');
    if (!container) return;

    container.innerHTML = '';

    for (const tab of editorTabs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `editor-tab${tab.id === activeTabId ? ' active' : ''}`;
        button.dataset.tabId = tab.id;
        button.title = tab.path || '未保存文档';
        button.draggable = true;

        const dirtyDot = tab.isDirty ? '<span class="editor-tab-dot"></span>' : '';
        button.innerHTML = `
            <span class="editor-tab-curve editor-tab-curve-left"></span>
            <span class="editor-tab-curve editor-tab-curve-right"></span>
            <span class="editor-tab-surface"></span>
            <span class="editor-tab-label">${escapeHtml(getTabTitle(tab))}</span>
            ${dirtyDot}
            <span class="editor-tab-close" data-tab-close="${tab.id}" role="button" aria-label="关闭标签页">×</span>
        `;

        container.appendChild(button);
    }
}

async function createEmptyTab() {
    await waitForEditorReady();
    clearPendingAutoSave();
    persistActiveTabState();
    const tab = createEditorTabState({ content: DEFAULT_UNTITLED_CONTENT, isDirty: false });
    editorTabs.push(tab);
    activeTabId = tab.id;
    applyTabToEditor(tab);
    renderEditorTabs();
    return tab;
}

function syncGlobalsFromTab(tab) {
    window.currentPath = tab.path || null;
    preservedUnusedAttachmentEntries = new Set(tab.preservedEntries || []);
    currentSearchQuery = tab.searchQuery || '';
}

function applyTabToEditor(tab) {
    if (!tab || !window.editor) return;
    const targetTabId = tab.id;

    suppressDocumentStateSync = true;
    syncGlobalsFromTab(tab);
    if (typeof window.editor.setEditable === 'function') {
        window.editor.setEditable(true);
    }
    if (typeof window.editor.setBundlePath === 'function') {
        window.editor.setBundlePath(tab.path || null);
    }
    window.editor.setValue(tab.content || '');
    if (typeof window.editor.refreshDisplayState === 'function') {
        window.editor.refreshDisplayState();
        if (typeof window.editor.getLiveMarkdownSnapshot === 'function') {
            const refreshedContent = window.editor.getLiveMarkdownSnapshot();
            tab.content = refreshedContent;
            tab.previousContent = refreshedContent;
        }
    }
    suppressDocumentStateSync = false;

    window.requestAnimationFrame(() => {
        if (activeTabId !== targetTabId) return;
        if (!window.editor || typeof window.editor.refreshDisplayState !== 'function') return;

        const didRepair = window.editor.refreshDisplayState();
        if (didRepair && typeof window.editor.getLiveMarkdownSnapshot === 'function') {
            const activeTab = getTabById(targetTabId);
            if (activeTab) {
                const refreshedContent = window.editor.getLiveMarkdownSnapshot();
                activeTab.content = refreshedContent;
                activeTab.previousContent = refreshedContent;
            }
        }
    });

    const searchInput = document.getElementById('toolbar-search-input');
    if (searchInput) {
        searchInput.value = currentSearchQuery;
    }

    resetEditorLineTracking();
    updateBundleStatus(tab.path || null);
    renderToolbarSearchResults(currentSearchQuery);
    refreshEditorToolbarState();
    updatePreview();
    updateOutline();
    renderWorkspaceTree();
    setDirty(Boolean(tab.isDirty));
    updateEditorEmptyState();
    schedulePreviewSync('cursor');
}

function activateTab(tabId) {
    const nextTab = getTabById(tabId);
    if (!nextTab) return;

    if (activeTabId === tabId) {
        renderEditorTabs();
        return;
    }

    clearPendingAutoSave();
    persistActiveTabState();
    activeTabId = tabId;
    applyTabToEditor(nextTab);
    renderEditorTabs();
}

function findTabByPath(folderPath) {
    if (!folderPath) return null;
    const normalizedTarget = path.resolve(folderPath);
    return editorTabs.find((tab) => tab.path && path.resolve(tab.path) === normalizedTarget) || null;
}

function openTabWithContent(folderPath, content) {
    const normalizedPath = folderPath ? path.resolve(folderPath) : null;
    const existingTab = normalizedPath ? findTabByPath(normalizedPath) : null;

    if (existingTab) {
        existingTab.path = normalizedPath;
        if (!existingTab.isDirty) {
            existingTab.content = content;
        }
        activateTab(existingTab.id);
        return existingTab;
    }

    const activeTab = getActiveTab();
    if (
        normalizedPath &&
        activeTab &&
        editorTabs.length === 1 &&
        isDisposableWelcomeTab(activeTab)
    ) {
        activeTab.path = normalizedPath;
        activeTab.content = content;
        activeTab.previousContent = content;
        activeTab.isDirty = false;
        activeTab.previousIsDirty = false;
        activeTab.searchQuery = '';
        activeTab.preservedEntries = [];
        applyTabToEditor(activeTab);
        renderEditorTabs();
        return activeTab;
    }

    clearPendingAutoSave();
    persistActiveTabState();
    const tab = createEditorTabState({
        path: normalizedPath,
        content,
        isDirty: false
    });
    editorTabs.push(tab);
    activeTabId = tab.id;
    applyTabToEditor(tab);
    renderEditorTabs();
    return tab;
}

async function closeEditorTab(tabId) {
    const targetTab = getTabById(tabId);
    if (!targetTab) return;

    clearPendingAutoSave();

    const previousActiveId = activeTabId;
    if (tabId !== activeTabId) {
        activateTab(tabId);
    }

    const shouldClose = await confirmUnsavedChanges('关闭标签页');
    if (!shouldClose) {
        if (previousActiveId && previousActiveId !== activeTabId) {
            activateTab(previousActiveId);
        }
        return;
    }

    const closedPath = targetTab.path;
    editorTabs = editorTabs.filter((tab) => tab.id !== tabId);

    if (!editorTabs.length) {
        clearEditorForNoTab();
    } else {
        const nextTab = editorTabs[Math.max(editorTabs.findIndex((tab) => tab.id === previousActiveId), 0)] || editorTabs[Math.max(editorTabs.length - 1, 0)];
        activeTabId = nextTab.id;
        applyTabToEditor(nextTab);
    }

    if (closedPath) {
        cleanupRecoveryDir(closedPath);
    }

    if (editorTabs.length) {
        renderEditorTabs();
    }
}

async function confirmAllTabsBeforeClose() {
    persistActiveTabState();
    const tabIds = editorTabs.map((tab) => tab.id);
    const originalActiveTabId = activeTabId;

    for (const tabId of tabIds) {
        const tab = getTabById(tabId);
        if (!tab || !tab.isDirty) continue;

        activateTab(tabId);
        const shouldClose = await confirmUnsavedChanges('关闭窗口');
        if (!shouldClose) {
            if (originalActiveTabId && getTabById(originalActiveTabId)) {
                activateTab(originalActiveTabId);
            }
            return false;
        }
    }

    return true;
}

function updateWindowTitle() {
    const activeTab = getActiveTab();
    const title = activeTab ? `${getTabTitle(activeTab)} - Kangaroo` : 'Kangaroo';
    document.title = isDirty ? `* ${title}` : title;
}

function updateAddressBar(folderPath) {
    const addressBar = document.getElementById('bundle-address');
    if (!addressBar) return;

    if (!folderPath) {
        addressBar.innerText = '未打开文档';
        addressBar.title = '未打开文档';
        return;
    }

    const displayPath = path.dirname(folderPath);
    addressBar.innerText = displayPath;
    addressBar.title = displayPath;
}

function isValidTextBundlePath(folderPath) {
    if (!folderPath) return false;

    try {
        return Boolean(resolveBundleMarkdownFilePath(folderPath));
    } catch {
        return false;
    }
}

function resolveBundleMarkdownFilePath(folderPath, options = {}) {
    if (!folderPath) return '';

    const candidates = [];
    if (options.preferredName) {
        candidates.push(options.preferredName);
    }
    candidates.push('text.markdown', 'text.md');

    for (const fileName of candidates) {
        const fullPath = path.join(folderPath, fileName);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }

    if (options.createIfMissing) {
        return path.join(folderPath, options.preferredName || 'text.markdown');
    }

    return '';
}

function getBundleMarkdownFileName(folderPath, options = {}) {
    const fullPath = resolveBundleMarkdownFilePath(folderPath, options);
    return fullPath ? path.basename(fullPath) : (options.preferredName || 'text.markdown');
}

function loadWorkspaceRootPreference() {
    try {
        const stored = window.localStorage.getItem(WORKSPACE_SETTINGS_KEY);
        if (!stored) return null;

        const normalized = path.resolve(stored);
        if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
            window.localStorage.removeItem(WORKSPACE_SETTINGS_KEY);
            return null;
        }

        return normalized;
    } catch {
        return null;
    }
}

function saveWorkspaceRootPreference(folderPath) {
    try {
        if (!folderPath) {
            window.localStorage.removeItem(WORKSPACE_SETTINGS_KEY);
            return;
        }

        window.localStorage.setItem(WORKSPACE_SETTINGS_KEY, path.resolve(folderPath));
    } catch {
        // Ignore preference failures.
    }
}

function restoreWorkspaceRootPreference() {
    const rememberedRoot = loadWorkspaceRootPreference();
    if (!rememberedRoot) {
        return false;
    }

    setWorkspaceRoot(rememberedRoot);
    return true;
}

function clearWorkspaceWatchers() {
    for (const watcher of workspaceWatchers) {
        try {
            watcher.close();
        } catch {
            // ignore
        }
    }
    workspaceWatchers = [];
}

function updateWorkspaceBusyIndicator() {
    const container = document.getElementById('workspace-container');
    if (!container) return;

    let indicator = container.querySelector('.workspace-busy-indicator');
    if (!workspaceBusyMessage) {
        if (indicator) {
            indicator.remove();
        }
        return;
    }

    if (!indicator) {
        indicator = document.createElement('div');
        indicator.className = 'workspace-busy-indicator';
    }

    indicator.textContent = workspaceBusyMessage;
    const rootHeader = container.querySelector('.workspace-root');
    if (rootHeader && rootHeader.parentNode === container) {
        container.insertBefore(indicator, rootHeader.nextSibling);
    } else if (!indicator.parentNode) {
        container.appendChild(indicator);
    }
}

function setWorkspaceBusy(message = '') {
    workspaceBusyMessage = String(message || '').trim();
    document.body.classList.toggle('workspace-busy', Boolean(workspaceBusyMessage));
    updateWorkspaceBusyIndicator();
}

function clearWorkspaceBusy() {
    setWorkspaceBusy('');
}

function yieldToUiFrame() {
    return new Promise((resolve) => {
        window.requestAnimationFrame(() => {
            window.setTimeout(resolve, 0);
        });
    });
}

function suspendWorkspaceRefresh() {
    workspaceRefreshSuspended += 1;
}

function resumeWorkspaceRefresh(options = {}) {
    workspaceRefreshSuspended = Math.max(0, workspaceRefreshSuspended - 1);
    if (workspaceRefreshSuspended > 0) {
        return;
    }

    const shouldRefresh = workspaceRefreshPending || options.force;
    workspaceRefreshPending = false;
    if (shouldRefresh) {
        if (options.immediate) {
            renderWorkspaceTree();
            registerWorkspaceWatchers();
        } else {
            scheduleWorkspaceTreeRefresh();
        }
    }
}

function scheduleWorkspaceTreeRefresh() {
    if (workspaceRefreshSuspended > 0) {
        workspaceRefreshPending = true;
        return;
    }

    if (workspaceRefreshTimer) {
        window.clearTimeout(workspaceRefreshTimer);
    }

    workspaceRefreshTimer = window.setTimeout(() => {
        workspaceRefreshTimer = null;
        renderWorkspaceTree();
        registerWorkspaceWatchers();
        if (window.currentPath && window.editor && typeof window.editor.refreshDisplayState === 'function') {
            const didRepairDocument = window.editor.refreshDisplayState();
            if (didRepairDocument) {
                suppressWorkspaceWatcherUntil = Date.now() + 1500;
                void saveFile({ silent: true });
            }
        }
    }, 120);
}

function registerWorkspaceWatchers() {
    clearWorkspaceWatchers();

    if (!workspaceRootPath || !fs.existsSync(workspaceRootPath)) {
        return;
    }

    const visited = new Set();
    const rootPath = path.resolve(workspaceRootPath);
    const supportsRecursiveWatch = process.platform === 'darwin' || process.platform === 'win32';

    if (supportsRecursiveWatch) {
        try {
            const watcher = fs.watch(rootPath, { recursive: true }, () => {
                if (Date.now() < suppressWorkspaceWatcherUntil) return;
                scheduleWorkspaceTreeRefresh();
            });
            workspaceWatchers.push(watcher);
            return;
        } catch {
            // Fallback to manual recursive watchers below.
        }
    }

    const watchDirectory = (dirPath) => {
        const normalizedDir = path.resolve(dirPath);
        if (visited.has(normalizedDir)) return;
        visited.add(normalizedDir);

        try {
            const watcher = fs.watch(normalizedDir, () => {
                if (Date.now() < suppressWorkspaceWatcherUntil) return;
                scheduleWorkspaceTreeRefresh();
            });
            workspaceWatchers.push(watcher);
        } catch {
            return;
        }

        for (const entry of fs.readdirSync(normalizedDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const fullPath = path.join(normalizedDir, entry.name);
            if (isValidTextBundlePath(fullPath)) continue;
            watchDirectory(fullPath);
        }
    };

    watchDirectory(rootPath);
}

function normalizeTodoPanelSettings(settings = {}) {
    return {
        scope: settings.scope === 'workspace' ? 'workspace' : 'document',
        sort: settings.sort === 'status' ? 'status' : 'position',
        hideCompleted: Boolean(settings.hideCompleted)
    };
}

function loadTodoPanelSettings() {
    try {
        const raw = localStorage.getItem(TODO_PANEL_SETTINGS_KEY);
        return normalizeTodoPanelSettings(raw ? JSON.parse(raw) : {});
    } catch {
        return { ...DEFAULT_TODO_PANEL_SETTINGS };
    }
}

function saveTodoPanelSettings(settings = {}) {
    const normalized = normalizeTodoPanelSettings(settings);
    try {
        localStorage.setItem(TODO_PANEL_SETTINGS_KEY, JSON.stringify(normalized));
    } catch {
        // Ignore preference failures.
    }
    return normalized;
}

function setWorkspaceRoot(folderPath) {
    workspaceRootPath = folderPath ? path.resolve(folderPath) : null;
    expandedWorkspaceEntries = workspaceRootPath ? new Set([workspaceRootPath]) : new Set();
    saveWorkspaceRootPreference(workspaceRootPath);
    renderWorkspaceTree();
    registerWorkspaceWatchers();
}

function getWorkspaceChildren(folderPath) {
    if (!folderPath || !fs.existsSync(folderPath)) {
        return [];
    }

    return fs.readdirSync(folderPath, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith('.'))
        .map((entry) => {
            const absolutePath = path.join(folderPath, entry.name);
            const isBundle = entry.isDirectory() && isValidTextBundlePath(absolutePath);
            const isDirectory = entry.isDirectory() && !isBundle;

            return {
                name: entry.name,
                path: absolutePath,
                isBundle,
                isDirectory
            };
        })
        .filter((entry) => entry.isBundle || entry.isDirectory)
        .sort((a, b) => {
            if (a.isDirectory !== b.isDirectory) {
                return a.isDirectory ? -1 : 1;
            }
            return a.name.localeCompare(b.name, 'zh-Hans-CN');
        });
}

async function openWorkspaceBundle(bundlePath) {
    if (!bundlePath) return;
    await openBundleFromExternalPath(bundlePath);
}

function hideWorkspaceContextMenu() {
    const menu = document.getElementById('workspace-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    workspaceContextTarget = null;
}

function clearWorkspaceDropIndicators() {
    document.querySelectorAll('.workspace-node-row.drop-target, .workspace-root.drop-target').forEach((node) => {
        node.classList.remove('drop-target');
    });
}

function beginWorkspaceInlineRename(targetPath) {
    suspendWorkspaceRefresh();
    workspaceRenameTargetPath = targetPath ? path.resolve(targetPath) : null;
    renderWorkspaceTree();
}

function cancelWorkspaceInlineRename() {
    if (!workspaceRenameTargetPath) return;
    workspaceRenameTargetPath = null;
    renderWorkspaceTree();
    resumeWorkspaceRefresh({ immediate: true });
}

async function commitWorkspaceInlineRename(targetPath, input, options = {}) {
    if (!workspaceRenameTargetPath || !input) {
        return false;
    }

    const didRename = await renameWorkspaceEntry(targetPath, input.value, options);
    if (!didRename && workspaceRenameTargetPath) {
        window.requestAnimationFrame(() => {
            if (!workspaceRenameTargetPath) return;
            input.focus();
            input.select();
        });
    } else {
        resumeWorkspaceRefresh({ immediate: true });
    }

    return didRename;
}

function isSameOrNestedPath(candidatePath, parentPath) {
    const normalizedCandidate = path.resolve(candidatePath);
    const normalizedParent = path.resolve(parentPath);
    const relative = path.relative(normalizedParent, normalizedCandidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function updateExpandedWorkspaceEntriesAfterMove(fromPath, toPath) {
    const nextExpanded = new Set();
    const normalizedFrom = path.resolve(fromPath);
    const normalizedTo = path.resolve(toPath);

    for (const entryPath of expandedWorkspaceEntries) {
        const normalizedEntry = path.resolve(entryPath);
        if (normalizedEntry === normalizedFrom || normalizedEntry.startsWith(`${normalizedFrom}${path.sep}`)) {
            const suffix = path.relative(normalizedFrom, normalizedEntry);
            nextExpanded.add(suffix ? path.join(normalizedTo, suffix) : normalizedTo);
            continue;
        }
        nextExpanded.add(normalizedEntry);
    }

    expandedWorkspaceEntries = nextExpanded;
}

function updateWorkspaceTabPathsAfterMove(fromPath, toPath) {
    const normalizedFrom = path.resolve(fromPath);
    const normalizedTo = path.resolve(toPath);
    let activePathChanged = false;

    for (const tab of editorTabs) {
        if (!tab.path) continue;
        const normalizedTabPath = path.resolve(tab.path);
        if (normalizedTabPath === normalizedFrom || normalizedTabPath.startsWith(`${normalizedFrom}${path.sep}`)) {
            const suffix = path.relative(normalizedFrom, normalizedTabPath);
            tab.path = suffix ? path.join(normalizedTo, suffix) : normalizedTo;
            if (tab.id === activeTabId) {
                activePathChanged = true;
            }
        }
    }

    if (activePathChanged) {
        const activeTab = getActiveTab();
        updateBundleStatus(activeTab?.path || null);
    }

    renderEditorTabs();
}

async function renameWorkspaceEntry(targetPath, nextDisplayName, options = {}) {
    if (!targetPath) return false;

    const normalizedSource = path.resolve(targetPath);
    if (!fs.existsSync(normalizedSource)) {
        workspaceRenameTargetPath = null;
        renderWorkspaceTree();
        return false;
    }

    const currentName = path.basename(normalizedSource);
    const isBundle = Boolean(options.isBundle ?? isValidTextBundlePath(normalizedSource));
    const trimmedName = String(nextDisplayName || '').trim();

    if (!trimmedName) {
        alert('名称不能为空。');
        return false;
    }

    if (/[\\/]/.test(trimmedName)) {
        alert('名称不能包含斜杠。');
        return false;
    }

    const targetName = isBundle
        ? `${trimmedName.replace(/\.textbundle$/i, '')}.textbundle`
        : trimmedName;

    if (targetName === currentName) {
        workspaceRenameTargetPath = null;
        renderWorkspaceTree();
        return true;
    }

    const parentDir = path.dirname(normalizedSource);
    const normalizedTarget = path.join(parentDir, targetName);

    if (fs.existsSync(normalizedTarget)) {
        alert(`已存在同名项目：${trimmedName}`);
        return false;
    }

    try {
        if (isBundle) {
            const markdownPath = resolveBundleMarkdownFilePath(normalizedSource, { createIfMissing: true });
            if (markdownPath && fs.existsSync(markdownPath)) {
                const currentContent = fs.readFileSync(markdownPath, 'utf-8');
                const currentDefaultContent = buildDefaultBundleContent(getDefaultBundleTitleFromPath(normalizedSource));
                if (String(currentContent || '').trim() === currentDefaultContent.trim()) {
                    fs.writeFileSync(markdownPath, buildDefaultBundleContent(trimmedName), 'utf-8');
                }
            }
        }

        fs.renameSync(normalizedSource, normalizedTarget);
        updateExpandedWorkspaceEntriesAfterMove(normalizedSource, normalizedTarget);
        updateWorkspaceTabPathsAfterMove(normalizedSource, normalizedTarget);
        workspaceRenameTargetPath = null;
        renderWorkspaceTree();
        return true;
    } catch (error) {
        alert(`重命名失败: ${error.message}`);
        return false;
    }
}

async function moveWorkspaceEntry(sourcePath, targetDir) {
    const normalizedSource = path.resolve(sourcePath);
    const normalizedTargetDir = path.resolve(targetDir);

    if (normalizedSource === normalizedTargetDir) {
        return false;
    }

    if (!fs.existsSync(normalizedSource) || !fs.existsSync(normalizedTargetDir)) {
        return false;
    }

    const sourceStat = fs.statSync(normalizedSource);
    if (!sourceStat.isDirectory() && !isValidTextBundlePath(normalizedSource)) {
        return false;
    }

    if (!fs.statSync(normalizedTargetDir).isDirectory()) {
        return false;
    }

    if (sourceStat.isDirectory() && isSameOrNestedPath(normalizedTargetDir, normalizedSource)) {
        alert('不能把文件夹拖进它自己或其子文件夹中。');
        return false;
    }

    const nextPath = path.join(normalizedTargetDir, path.basename(normalizedSource));
    if (normalizedSource === nextPath) {
        return false;
    }

    if (fs.existsSync(nextPath)) {
        alert(`目标目录里已存在同名项目：${path.basename(nextPath)}`);
        return false;
    }

    try {
        fs.renameSync(normalizedSource, nextPath);
        expandedWorkspaceEntries.add(normalizedTargetDir);
        updateExpandedWorkspaceEntriesAfterMove(normalizedSource, nextPath);
        updateWorkspaceTabPathsAfterMove(normalizedSource, nextPath);
        renderWorkspaceTree();
        return true;
    } catch (error) {
        alert(`移动失败: ${error.message}`);
        return false;
    }
}

function getExternalBundlePathsFromDataTransfer(dataTransfer) {
    const bundlePaths = [];
    if (!dataTransfer) return bundlePaths;

    for (const file of Array.from(dataTransfer.files || [])) {
        const filePath = getDroppedFilePath(file);
        if (!filePath) continue;

        const normalizedPath = path.resolve(filePath);
        if (isValidTextBundlePath(normalizedPath)) {
            bundlePaths.push(normalizedPath);
        }
    }

    return Array.from(new Set(bundlePaths));
}

function isExternalFileDrag(dataTransfer) {
    return Boolean(dataTransfer && Array.from(dataTransfer.types || []).includes('Files'));
}

async function copyPathRecursiveAsync(sourcePath, targetPath) {
    if (fs.promises?.cp) {
        await fs.promises.cp(sourcePath, targetPath, { recursive: true });
        return;
    }

    const sourceStat = await fs.promises.stat(sourcePath);
    if (sourceStat.isDirectory()) {
        await fs.promises.mkdir(targetPath, { recursive: true });
        const entries = await fs.promises.readdir(sourcePath);
        for (const entryName of entries) {
            await copyPathRecursiveAsync(
                path.join(sourcePath, entryName),
                path.join(targetPath, entryName)
            );
        }
        return;
    }

    await fs.promises.copyFile(sourcePath, targetPath);
}

async function importExternalBundlesIntoWorkspace(bundlePaths, targetDir) {
    const normalizedTargetDir = path.resolve(targetDir);
    if (!bundlePaths?.length || !fs.existsSync(normalizedTargetDir)) {
        return false;
    }

    let importedCount = 0;

    setWorkspaceBusy('正在导入并整理 TextBundle…');
    suspendWorkspaceRefresh();
    await yieldToUiFrame();

    try {
        for (const sourceBundlePath of bundlePaths) {
            const normalizedSource = path.resolve(sourceBundlePath);
            if (!fs.existsSync(normalizedSource)) continue;

            const targetBundlePath = generateUniqueBundlePathInDirectory(
                normalizedTargetDir,
                path.basename(normalizedSource, path.extname(normalizedSource))
            );

            await copyPathRecursiveAsync(normalizedSource, targetBundlePath);
            await normalizeBundleToKangarooFormatAsync(targetBundlePath);
            expandedWorkspaceEntries.add(normalizedTargetDir);
            importedCount += 1;
            await yieldToUiFrame();
        }

        if (importedCount > 0) {
            workspaceRefreshPending = true;
            resumeWorkspaceRefresh({ immediate: true });
            return true;
        }

        return false;
    } finally {
        if (workspaceRefreshSuspended > 0) {
            resumeWorkspaceRefresh({ immediate: true });
        }
        clearWorkspaceBusy();
    }
}

function showWorkspaceContextMenu(event, target) {
    const menu = document.getElementById('workspace-context-menu');
    if (!menu) return;

    workspaceContextTarget = target;
    const openButton = document.getElementById('workspace-menu-open-bundle');
    const newButton = document.getElementById('workspace-menu-new-bundle');
    const newFolderButton = document.getElementById('workspace-menu-new-folder');
    const renameButton = document.getElementById('workspace-menu-rename');
    const deleteButton = document.getElementById('workspace-menu-delete');
    if (openButton) {
        openButton.style.display = target?.allowOpenBundle ? '' : 'none';
    }
    if (newButton) {
        newButton.style.display = target?.allowCreate ? '' : 'none';
        newButton.textContent = target?.createLabel || '新建文档';
    }
    if (newFolderButton) {
        newFolderButton.style.display = target?.allowCreateFolder ? '' : 'none';
        newFolderButton.textContent = target?.createFolderLabel || '新建文件夹';
    }
    if (renameButton) {
        renameButton.style.display = target?.allowRename ? '' : 'none';
    }
    if (deleteButton) {
        deleteButton.style.display = target?.allowDelete ? '' : 'none';
        deleteButton.textContent = target?.deleteLabel || '删除';
    }

    menu.classList.add('show');
    const menuWidth = menu.offsetWidth || 168;
    const menuHeight = menu.offsetHeight || 88;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;
}

async function revealWorkspaceTarget(targetPath) {
    if (!targetPath) return;

    const result = await ipcRenderer.invoke('shell:revealLinkTarget', {
        type: 'path',
        value: targetPath
    });

    if (!result || !result.ok) {
        alert(`打开所在目录失败: ${(result && result.error) || targetPath}`);
    }
}

function getWorkspaceEntryTabs(targetPath) {
    if (!targetPath) return [];

    const normalizedTarget = path.resolve(targetPath);
    const folderPrefix = `${normalizedTarget}${path.sep}`;

    return editorTabs.filter((tab) => {
        if (!tab.path) return false;
        const tabPath = path.resolve(tab.path);
        return tabPath === normalizedTarget || tabPath.startsWith(folderPrefix);
    });
}

async function closeWorkspaceEntryTabs(targetPath) {
    const relatedTabs = getWorkspaceEntryTabs(targetPath);
    if (!relatedTabs.length) {
        return true;
    }

    const relatedIds = relatedTabs.map((tab) => tab.id);
    for (const tabId of relatedIds) {
        const tabStillOpen = getTabById(tabId);
        if (!tabStillOpen) continue;
        await closeEditorTab(tabId);
        if (getTabById(tabId)) {
            return false;
        }
    }

    return true;
}

async function deleteWorkspaceEntry(target) {
    if (!target?.path) return false;

    const normalizedPath = path.resolve(target.path);
    const entryName = path.basename(normalizedPath) || normalizedPath;
    const isFolder = !target.isBundle;
    const decision = await ipcRenderer.invoke('dialog:confirmDeleteWorkspaceEntry', {
        entryName,
        isFolder
    });

    if (decision !== 'delete') {
        return false;
    }

    setWorkspaceBusy(isFolder ? '正在删除文件夹…' : '正在删除文档…');
    suspendWorkspaceRefresh();
    await yieldToUiFrame();

    const canDelete = await closeWorkspaceEntryTabs(normalizedPath);
    if (!canDelete) {
        resumeWorkspaceRefresh();
        clearWorkspaceBusy();
        return false;
    }

    const trashResult = await ipcRenderer.invoke('shell:trashPath', {
        type: 'path',
        value: normalizedPath
    });

    if (!trashResult || !trashResult.ok) {
        resumeWorkspaceRefresh();
        clearWorkspaceBusy();
        alert(`删除失败: ${(trashResult && trashResult.error) || normalizedPath}`);
        return false;
    }

    if (workspaceRootPath) {
        const currentRoot = path.resolve(workspaceRootPath);
        if (normalizedPath === currentRoot) {
            setWorkspaceRoot(null);
            setSidebarTab('outline');
            resumeWorkspaceRefresh();
            clearWorkspaceBusy();
            return true;
        }

        if (expandedWorkspaceEntries.has(normalizedPath)) {
            expandedWorkspaceEntries.delete(normalizedPath);
        }
    }

    workspaceRefreshPending = true;
    resumeWorkspaceRefresh({ immediate: true });
    clearWorkspaceBusy();
    return true;
}

function getDefaultWorkspaceNewBundlePath(parentDir) {
    return path.join(parentDir, '未命名文档.textbundle');
}

function getDefaultBundleTitleFromPath(bundlePath) {
    return path.basename(String(bundlePath || ''), '.textbundle') || '未命名文档';
}

function buildDefaultBundleContent(title) {
    const normalizedTitle = String(title || '').trim() || '未命名文档';
    return `# ${normalizedTitle}`;
}

function getWorkspaceCreateTarget(entryPath, isDirectory) {
    if (!entryPath) {
        return workspaceRootPath;
    }

    const normalizedPath = path.resolve(entryPath);
    if (isDirectory) {
        return normalizedPath;
    }

    const parentDir = path.dirname(normalizedPath);
    if (!workspaceRootPath) {
        return parentDir;
    }

    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);
    return isSameOrNestedPath(parentDir, normalizedWorkspaceRoot)
        ? parentDir
        : normalizedWorkspaceRoot;
}

async function createFolderInWorkspace(targetDir = workspaceRootPath) {
    if (!targetDir) {
        alert('请先打开工作空间文件夹。');
        return false;
    }

    const targetBaseDir = path.resolve(targetDir);
    let nextFolderName = '新建文件夹';
    let suffix = 2;
    let normalizedFolderPath = path.join(targetBaseDir, nextFolderName);
    while (fs.existsSync(normalizedFolderPath)) {
        nextFolderName = `新建文件夹 ${suffix++}`;
        normalizedFolderPath = path.join(targetBaseDir, nextFolderName);
    }

    const folderName = path.basename(normalizedFolderPath);
    if (!folderName.trim()) {
        alert('文件夹名称不能为空。');
        return false;
    }

    try {
        fs.mkdirSync(normalizedFolderPath, { recursive: true });
        if (workspaceRootPath && normalizedFolderPath.startsWith(path.resolve(workspaceRootPath))) {
            expandedWorkspaceEntries.add(path.resolve(targetDir));
        }
        beginWorkspaceInlineRename(normalizedFolderPath);
        return true;
    } catch (error) {
        alert(`创建文件夹失败: ${error.message}`);
        return false;
    }
}

async function createBundleInWorkspace(targetDir = workspaceRootPath) {
    if (!targetDir) {
        alert('请先打开工作空间文件夹。');
        return false;
    }

    try {
        const targetBaseDir = path.resolve(targetDir);
        let nextBundleName = '未命名文档.textbundle';
        let suffix = 2;
        let folderPath = path.join(targetBaseDir, nextBundleName);
        while (fs.existsSync(folderPath)) {
            nextBundleName = `未命名文档 ${suffix++}.textbundle`;
            folderPath = path.join(targetBaseDir, nextBundleName);
        }

        await waitForEditorReady();
        ensureBundleStructure(folderPath);

        const initialContent = buildDefaultBundleContent(getDefaultBundleTitleFromPath(folderPath));
        fs.writeFileSync(path.join(folderPath, 'text.markdown'), initialContent, 'utf-8');
        if (workspaceRootPath && path.resolve(folderPath).startsWith(path.resolve(workspaceRootPath))) {
            expandedWorkspaceEntries.add(path.dirname(path.resolve(folderPath)));
        }
        beginWorkspaceInlineRename(path.resolve(folderPath));
        return true;
    } catch (error) {
        alert(`创建失败: ${error.message}`);
        return false;
    }
}

function renderWorkspaceNode(entry, container, depth = 0) {
    const node = document.createElement('div');
    node.className = 'workspace-node';

    const row = document.createElement('div');
    row.className = 'workspace-node-row';
    row.classList.toggle('is-folder', Boolean(entry.isDirectory));

    const normalizedEntryPath = path.resolve(entry.path);
    const activePath = window.currentPath ? path.resolve(window.currentPath) : '';
    if (entry.isBundle && activePath && normalizedEntryPath === activePath) {
        row.classList.add('active');
    }

    const toggle = document.createElement('div');
    toggle.className = `workspace-node-toggle${entry.isDirectory ? '' : ' empty'}`;
    toggle.textContent = entry.isDirectory
        ? (expandedWorkspaceEntries.has(normalizedEntryPath) ? '▾' : '▸')
        : '•';

    const icon = document.createElement('div');
    icon.className = 'workspace-node-icon';
    icon.textContent = entry.isDirectory ? '📁' : '📝';

    const label = document.createElement('div');
    const isRenaming = workspaceRenameTargetPath && path.resolve(workspaceRenameTargetPath) === normalizedEntryPath;
    if (isRenaming) {
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'workspace-node-input';
        input.value = entry.isBundle
            ? path.basename(entry.name, path.extname(entry.name)) || entry.name
            : entry.name;
        input.title = entry.path;
        input.addEventListener('click', (event) => event.stopPropagation());
        input.addEventListener('keydown', async (event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                suppressNextWorkspaceRenameBlurCommit = true;
                await commitWorkspaceInlineRename(normalizedEntryPath, input, { isBundle: entry.isBundle });
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelWorkspaceInlineRename();
            }
        });
        input.addEventListener('blur', async () => {
            if (suppressNextWorkspaceRenameBlurCommit) {
                suppressNextWorkspaceRenameBlurCommit = false;
                return;
            }
            if (!workspaceRenameTargetPath) return;
            await commitWorkspaceInlineRename(normalizedEntryPath, input, { isBundle: entry.isBundle });
        });
        row.appendChild(toggle);
        row.appendChild(icon);
        row.appendChild(input);
        node.appendChild(row);
        container.appendChild(node);
        row.draggable = false;
        window.requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    } else {
        label.className = 'workspace-node-label';
        label.textContent = entry.isBundle
            ? path.basename(entry.name, path.extname(entry.name)) || entry.name
            : entry.name;
        label.title = entry.path;

        row.appendChild(toggle);
        row.appendChild(icon);
        row.appendChild(label);
        node.appendChild(row);
        container.appendChild(node);
        row.draggable = true;
    }

    row.addEventListener('click', async (event) => {
        event.stopPropagation();
        if (isRenaming) return;

        if (entry.isDirectory) {
            if (expandedWorkspaceEntries.has(normalizedEntryPath)) {
                expandedWorkspaceEntries.delete(normalizedEntryPath);
            } else {
                expandedWorkspaceEntries.add(normalizedEntryPath);
            }
            renderWorkspaceTree();
            return;
        }

        await openWorkspaceBundle(normalizedEntryPath);
    });

    row.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();

        showWorkspaceContextMenu(event, {
            path: normalizedEntryPath,
            openTarget: entry.isBundle ? normalizedEntryPath : null,
            allowOpenBundle: entry.isBundle,
            revealTarget: entry.isBundle ? normalizedEntryPath : normalizedEntryPath,
            createTarget: getWorkspaceCreateTarget(normalizedEntryPath, entry.isDirectory),
            allowCreate: true,
            createLabel: '新建文档',
            allowCreateFolder: true,
            createFolderLabel: '新建文件夹',
            allowRename: true,
            allowDelete: true,
            deleteLabel: entry.isDirectory ? '删除文件夹' : '删除文档',
            isBundle: entry.isBundle
        });
    });

    row.addEventListener('dragstart', (event) => {
        if (isRenaming) {
            event.preventDefault();
            return;
        }
        draggedWorkspaceEntry = {
            path: normalizedEntryPath,
            isBundle: entry.isBundle,
            isDirectory: entry.isDirectory
        };
        row.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', normalizedEntryPath);
        }
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        draggedWorkspaceEntry = null;
        clearWorkspaceDropIndicators();
    });

    if (entry.isDirectory) {
        row.addEventListener('dragover', (event) => {
            const canHandleInternalMove = draggedWorkspaceEntry && draggedWorkspaceEntry.path !== normalizedEntryPath;
            const canHandleExternalImport = isExternalFileDrag(event.dataTransfer);
            if (!canHandleInternalMove && !canHandleExternalImport) return;
            event.preventDefault();
            event.stopPropagation();
            clearWorkspaceDropIndicators();
            row.classList.add('drop-target');
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = canHandleInternalMove ? 'move' : 'copy';
            }
        });

        row.addEventListener('dragleave', (event) => {
            event.stopPropagation();
            if (event.currentTarget.contains(event.relatedTarget)) return;
            row.classList.remove('drop-target');
        });

        row.addEventListener('drop', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            row.classList.remove('drop-target');
            const externalBundlePaths = getExternalBundlePathsFromDataTransfer(event.dataTransfer);
            if (draggedWorkspaceEntry) {
                await moveWorkspaceEntry(draggedWorkspaceEntry.path, normalizedEntryPath);
            } else if (externalBundlePaths.length) {
                await importExternalBundlesIntoWorkspace(externalBundlePaths, normalizedEntryPath);
            }
            draggedWorkspaceEntry = null;
            clearWorkspaceDropIndicators();
        });
    }

    if (entry.isDirectory && expandedWorkspaceEntries.has(normalizedEntryPath)) {
        const children = getWorkspaceChildren(normalizedEntryPath);
        if (children.length) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'workspace-node-children';
            node.appendChild(childrenContainer);

            for (const child of children) {
                renderWorkspaceNode(child, childrenContainer, depth + 1);
            }
        }
    }
}

function renderWorkspaceTree() {
    const container = document.getElementById('workspace-container');
    const panel = document.getElementById('workspace-panel');
    if (!container || !panel) return;

    container.innerHTML = '';

    if (!workspaceRootPath) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '还没有打开工作空间。使用 File -> 打开文件夹 后，这里会显示文件夹目录树。';
        container.appendChild(emptyState);
        return;
    }

    const handleWorkspaceRootDrop = async (event, dropTarget) => {
        const canHandleInternalMove = draggedWorkspaceEntry && workspaceRootPath;
        const canHandleExternalImport = isExternalFileDrag(event.dataTransfer) && workspaceRootPath;
        if (!canHandleInternalMove && !canHandleExternalImport) return;

        event.preventDefault();
        if (dropTarget) {
            clearWorkspaceDropIndicators();
            dropTarget.classList.add('drop-target');
        }
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = draggedWorkspaceEntry ? 'move' : 'copy';
        }
    };

    const commitWorkspaceRootDrop = async (event, dropTarget) => {
        event.preventDefault();
        event.stopPropagation();
        if (dropTarget) {
            dropTarget.classList.remove('drop-target');
        }
        const externalBundlePaths = getExternalBundlePathsFromDataTransfer(event.dataTransfer);
        if (draggedWorkspaceEntry && workspaceRootPath) {
            await moveWorkspaceEntry(draggedWorkspaceEntry.path, workspaceRootPath);
        } else if (externalBundlePaths.length && workspaceRootPath) {
            await importExternalBundlesIntoWorkspace(externalBundlePaths, workspaceRootPath);
        }
        draggedWorkspaceEntry = null;
        clearWorkspaceDropIndicators();
    };

    const header = document.createElement('div');
    header.className = 'workspace-root';
    header.innerHTML = `
        <div class="workspace-root-title">${escapeHtml(path.basename(workspaceRootPath) || workspaceRootPath)}</div>
        <div class="workspace-root-path">${escapeHtml(workspaceRootPath)}</div>
    `;
    header.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        showWorkspaceContextMenu(event, {
            path: workspaceRootPath,
            openTarget: null,
            allowOpenBundle: false,
            revealTarget: workspaceRootPath,
            createTarget: workspaceRootPath,
            allowCreate: true,
            createLabel: '新建文档',
            allowCreateFolder: true,
            createFolderLabel: '新建文件夹',
            allowRename: false,
            allowDelete: true,
            deleteLabel: '删除文件夹',
            isBundle: false
        });
    });
    header.addEventListener('dragover', (event) => {
        handleWorkspaceRootDrop(event, header);
    });
    header.addEventListener('dragleave', (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        header.classList.remove('drop-target');
    });
    header.addEventListener('drop', async (event) => {
        await commitWorkspaceRootDrop(event, header);
    });
    container.appendChild(header);

    const tree = document.createElement('div');
    tree.className = 'workspace-tree';
    panel.ondragover = (event) => {
        handleWorkspaceRootDrop(event, tree);
    };
    panel.ondragleave = (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        tree.classList.remove('drop-target');
    };
    panel.ondrop = async (event) => {
        await commitWorkspaceRootDrop(event, tree);
    };
    tree.addEventListener('dragover', (event) => {
        handleWorkspaceRootDrop(event, tree);
    });
    tree.addEventListener('dragleave', (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        tree.classList.remove('drop-target');
    });
    tree.addEventListener('drop', async (event) => {
        await commitWorkspaceRootDrop(event, tree);
    });
    container.appendChild(tree);

    const children = getWorkspaceChildren(workspaceRootPath);
    if (!children.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '这个文件夹目前还没有可打开的 TextBundle 文档。';
        tree.appendChild(emptyState);
        return;
    }

    for (const child of children) {
        renderWorkspaceNode(child, tree);
    }

    updateWorkspaceBusyIndicator();
}

function clearTabDragIndicators() {
    for (const tabButton of document.querySelectorAll('.editor-tab.drag-over-left, .editor-tab.drag-over-right')) {
        tabButton.classList.remove('drag-over-left', 'drag-over-right');
    }
}

function reorderEditorTabs(draggedId, targetId, placeAfter = false) {
    const fromIndex = editorTabs.findIndex((tab) => tab.id === draggedId);
    const targetIndex = editorTabs.findIndex((tab) => tab.id === targetId);
    if (fromIndex === -1 || targetIndex === -1 || fromIndex === targetIndex) {
        return;
    }

    const [movedTab] = editorTabs.splice(fromIndex, 1);
    const adjustedTargetIndex = editorTabs.findIndex((tab) => tab.id === targetId);
    const insertionIndex = adjustedTargetIndex + (placeAfter ? 1 : 0);
    editorTabs.splice(insertionIndex, 0, movedTab);
    renderEditorTabs();
}

function focusToolbarSearch() {
    const input = document.getElementById('toolbar-search-input');
    if (!input) return;
    input.focus();
    input.select();
}

function refreshEditorToolbarState() {
    const toolbar = document.getElementById('editor-toolbar');
    if (!toolbar) return;
    const hasActiveTab = Boolean(getActiveTab());

    const state = window.editor && typeof window.editor.getToolbarState === 'function'
        ? window.editor.getToolbarState()
        : null;

    for (const button of toolbar.querySelectorAll('.editor-toolbar-button')) {
        const tool = button.dataset.tool || '';
        let isActive = false;

        if (state) {
            if (tool === 'heading') {
                isActive = Number(button.dataset.level || 0) === Number(state.headingLevel || 0);
            } else if (tool === 'bullet-list') {
                isActive = Boolean(state.bulletList);
            } else if (tool === 'ordered-list') {
                isActive = Boolean(state.orderedList);
            } else if (tool === 'task-list') {
                isActive = Boolean(state.taskList);
            } else if (tool === 'toggle-sidebar') {
                isActive = document.body.classList.contains('sidebar-collapsed');
            }
        } else if (tool === 'toggle-sidebar') {
            isActive = document.body.classList.contains('sidebar-collapsed');
        }

        button.classList.toggle('active', isActive);
        if (tool === 'toggle-sidebar') {
            button.disabled = false;
        } else if (tool === 'undo') {
            button.disabled = !hasActiveTab || !Boolean(state?.canUndo);
        } else if (tool === 'redo') {
            button.disabled = !hasActiveTab || !Boolean(state?.canRedo);
        } else {
            button.disabled = !hasActiveTab;
        }
    }
}

function runEditorToolbarCommand(tool, options = {}) {
    if (tool === 'toggle-sidebar') {
        toggleSidebarVisibility();
        refreshEditorToolbarState();
        return true;
    }

    if (!window.editor || !getActiveTab()) return false;

    if (tool === 'heading' && typeof window.editor.toggleHeading === 'function') {
        const didRun = window.editor.toggleHeading(Number(options.level || 1));
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'bullet-list' && typeof window.editor.toggleBulletList === 'function') {
        const didRun = window.editor.toggleBulletList();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'ordered-list' && typeof window.editor.toggleOrderedList === 'function') {
        const didRun = window.editor.toggleOrderedList();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'task-list') {
        toggleSelectedLinesAsTodo();
        refreshEditorToolbarState();
        return true;
    }

    if (tool === 'undo' && typeof window.editor.undo === 'function') {
        const didRun = window.editor.undo();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'redo' && typeof window.editor.redo === 'function') {
        const didRun = window.editor.redo();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'insert-date' && typeof window.editor.insertText === 'function') {
        window.editor.insertText(formatCurrentDateText());
        refreshEditorToolbarState();
        return true;
    }

    if (tool === 'bold' && typeof window.editor.toggleBold === 'function') {
        const didRun = window.editor.toggleBold();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'underline' && typeof window.editor.toggleUnderline === 'function') {
        const didRun = window.editor.toggleUnderline();
        refreshEditorToolbarState();
        return didRun;
    }

    if (tool === 'strike' && typeof window.editor.toggleStrike === 'function') {
        const didRun = window.editor.toggleStrike();
        refreshEditorToolbarState();
        return didRun;
    }

    return false;
}

function formatCurrentDateText() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function updateEditorEmptyState() {
    const shell = document.getElementById('editor-shell');
    const emptyState = document.getElementById('editor-empty-state');
    const searchInput = document.getElementById('toolbar-search-input');
    const searchScope = document.getElementById('toolbar-search-scope');
    const searchScopeIcon = document.getElementById('toolbar-search-scope-icon');
    const hasActiveTab = Boolean(getActiveTab());
    const canSearch = hasActiveTab || Boolean(workspaceRootPath);

    if (shell) {
        shell.classList.toggle('is-empty', !hasActiveTab);
    }

    if (emptyState) {
        emptyState.hidden = hasActiveTab;
    }

    if (searchInput) {
        searchInput.disabled = !canSearch;
        if (!canSearch) {
            searchInput.value = '';
        }
    }

    if (searchScope) {
        searchScope.disabled = !canSearch;
        if (!workspaceRootPath && currentSearchScope === 'workspace') {
            currentSearchScope = 'document';
        }
        searchScope.title = currentSearchScope === 'workspace' ? '工作空间搜索' : '当前文档搜索';
        searchScope.setAttribute('aria-label', searchScope.title);
        searchScope.classList.toggle('active', currentSearchScope === 'workspace');
        searchScope.setAttribute('data-scope', currentSearchScope);
        if (searchScopeIcon) {
            searchScopeIcon.className = currentSearchScope === 'workspace'
                ? 'fa-solid fa-folder-open'
                : 'fa-regular fa-file-lines';
        }
    }
}

function normalizeThemeId(themeId) {
    return MONACO_THEME_MAP[themeId] ? themeId : DEFAULT_THEME_ID;
}

function loadThemePreference() {
    try {
        return normalizeThemeId(window.localStorage.getItem(THEME_SETTINGS_KEY));
    } catch {
        return DEFAULT_THEME_ID;
    }
}

function ensureMonacoThemes() {
    if (typeof monaco === 'undefined') return;

    for (const config of Object.values(MONACO_THEME_MAP)) {
        monaco.editor.defineTheme(config.name, {
            base: config.base,
            inherit: true,
            rules: [],
            colors: {
                'editor.background': config.background,
                'editor.foreground': config.foreground,
                'editorLineNumber.foreground': '#7e8aa0',
                'editorLineNumber.activeForeground': '#b8c4d8',
                'editor.lineHighlightBackground': config.lineHighlight,
                'editor.selectionBackground': config.selection,
                'editor.inactiveSelectionBackground': config.selection,
                'editorCursor.foreground': config.foreground
            }
        });
    }
}

function applyTheme(themeId) {
    const normalized = normalizeThemeId(themeId);
    document.documentElement.setAttribute('data-theme', normalized);

    if (typeof monaco !== 'undefined') {
        ensureMonacoThemes();
        monaco.editor.setTheme(MONACO_THEME_MAP[normalized].name);
    }

    return normalized;
}

function saveThemePreference(themeId) {
    const normalized = applyTheme(themeId);
    window.localStorage.setItem(THEME_SETTINGS_KEY, normalized);
}

function normalizeFontChoice(id, fallbackId) {
    return FONT_FAMILY_MAP[id] ? id : fallbackId;
}

function normalizeTypographySettings(settings = {}) {
    const uiFont = normalizeFontChoice(settings.uiFont, DEFAULT_TYPOGRAPHY_SETTINGS.uiFont);
    const editorFont = normalizeFontChoice(settings.editorFont, DEFAULT_TYPOGRAPHY_SETTINGS.editorFont);
    const uiFontSize = clamp(Number(settings.uiFontSize) || DEFAULT_TYPOGRAPHY_SETTINGS.uiFontSize, 12, 18);
    const editorFontSize = clamp(Number(settings.editorFontSize) || DEFAULT_TYPOGRAPHY_SETTINGS.editorFontSize, 12, 24);
    const editorLineHeight = clamp(Number(settings.editorLineHeight) || DEFAULT_TYPOGRAPHY_SETTINGS.editorLineHeight, 1, 2);
    const editorParagraphSpacing = clamp(Number(settings.editorParagraphSpacing) || DEFAULT_TYPOGRAPHY_SETTINGS.editorParagraphSpacing, 0, 20);
    const toolbarPosition = ['top', 'bottom', 'right'].includes(settings.toolbarPosition)
        ? settings.toolbarPosition
        : DEFAULT_TYPOGRAPHY_SETTINGS.toolbarPosition;

    return {
        uiFont,
        editorFont,
        uiFontSize: Math.round(uiFontSize),
        editorFontSize: Math.round(editorFontSize),
        editorLineHeight: Math.round(editorLineHeight * 100) / 100,
        editorParagraphSpacing: Math.round(editorParagraphSpacing * 10) / 10,
        toolbarPosition
    };
}

function loadTypographySettings() {
    try {
        const raw = window.localStorage.getItem(TYPOGRAPHY_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_TYPOGRAPHY_SETTINGS };
        return normalizeTypographySettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_TYPOGRAPHY_SETTINGS };
    }
}

function applyTypographySettings(settings) {
    const normalized = normalizeTypographySettings(settings);
    const root = document.documentElement;
    root.style.setProperty('--ui-font-family', FONT_FAMILY_MAP[normalized.uiFont]);
    root.style.setProperty('--editor-font-family', FONT_FAMILY_MAP[normalized.editorFont]);
    root.style.setProperty('--ui-font-size', `${normalized.uiFontSize}px`);
    root.style.setProperty('--editor-font-size', `${normalized.editorFontSize}px`);
    root.style.setProperty('--editor-line-height', String(normalized.editorLineHeight));
    root.style.setProperty('--editor-paragraph-spacing', `${normalized.editorParagraphSpacing}px`);
    document.body.setAttribute('data-toolbar-position', normalized.toolbarPosition);

    fallbackCharWidth = null;

    if (window.editor && isEditorReady) {
        if (!isUsingFallbackEditor && typeof window.editor.updateOptions === 'function') {
            window.editor.updateOptions({
                fontFamily: FONT_FAMILY_MAP[normalized.editorFont],
                fontSize: normalized.editorFontSize
            });
        }

        if (isUsingFallbackEditor && fallbackTextarea && fallbackHighlightLayer) {
            renderFallbackHighlight(fallbackTextarea, fallbackHighlightLayer);
        }
    }

    return normalized;
}

function saveTypographySettings(settings) {
    const normalized = applyTypographySettings(settings);
    window.localStorage.setItem(TYPOGRAPHY_SETTINGS_KEY, JSON.stringify(normalized));
}

function normalizeLayoutSettings(settings = {}) {
    let sidebarWidth = Number(settings.sidebarWidth);
    if (!Number.isFinite(sidebarWidth)) sidebarWidth = DEFAULT_LAYOUT_SETTINGS.sidebarWidth;
    sidebarWidth = clamp(sidebarWidth, 10, 60);

    return {
        sidebarWidth: Math.round(sidebarWidth * 10) / 10,
        editorWidth: DEFAULT_LAYOUT_SETTINGS.editorWidth,
        previewWidth: DEFAULT_LAYOUT_SETTINGS.previewWidth
    };
}

function loadLayoutSettings() {
    try {
        const raw = window.localStorage.getItem(LAYOUT_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_LAYOUT_SETTINGS };
        return normalizeLayoutSettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_LAYOUT_SETTINGS };
    }
}

function loadSidebarVisibilityPreference() {
    return true;
}

function updateSidebarToggleButton() {
    const button = document.getElementById('sidebar-toggle-button');
    const icon = document.getElementById('sidebar-toggle-icon');
    if (!button) return;
    const isVisible = !document.body.classList.contains('sidebar-collapsed');
    button.classList.toggle('active', !isVisible);
    button.title = isVisible ? '隐藏侧边栏' : '显示侧边栏';
    button.setAttribute('aria-label', button.title);
    if (icon) icon.className = 'fa-solid fa-table-columns';
}

function applySidebarVisibility(visible) {
    const isVisible = Boolean(visible);
    document.body.classList.toggle('sidebar-collapsed', !isVisible);
    updateSidebarToggleButton();
    return isVisible;
}

function saveSidebarVisibilityPreference(visible) {
    const normalized = applySidebarVisibility(visible);
    try {
        window.localStorage.setItem(SIDEBAR_VISIBILITY_SETTINGS_KEY, normalized ? 'visible' : 'hidden');
    } catch {
        // ignore persistence failures
    }
}

function toggleSidebarVisibility() {
    const nextVisible = document.body.classList.contains('sidebar-collapsed');
    saveSidebarVisibilityPreference(nextVisible);
    return nextVisible;
}

function applyLayoutSettings(settings) {
    const normalized = normalizeLayoutSettings(settings);
    const root = document.documentElement;
    root.style.setProperty('--sidebar-width', `${normalized.sidebarWidth}%`);
    root.style.setProperty('--editor-width', `${normalized.editorWidth}%`);
    root.style.setProperty('--preview-width', `${normalized.previewWidth}%`);
}

function normalizeViewMode(mode) {
    return ['split', 'editor', 'preview'].includes(mode) ? mode : DEFAULT_VIEW_MODE;
}

function loadViewModePreference() {
    try {
        return normalizeViewMode(window.localStorage.getItem(VIEW_MODE_SETTINGS_KEY));
    } catch {
        return DEFAULT_VIEW_MODE;
    }
}

function applyViewMode(mode) {
    const normalized = normalizeViewMode(mode);
    document.body.setAttribute('data-view-mode', normalized);

    for (const button of document.querySelectorAll('[data-view-mode]')) {
        button.classList.toggle('active', button.dataset.viewMode === normalized);
    }

    return normalized;
}

function saveViewModePreference(mode) {
    const normalized = applyViewMode(mode);
    window.localStorage.setItem(VIEW_MODE_SETTINGS_KEY, normalized);
}

function saveLayoutSettings(settings) {
    const normalized = normalizeLayoutSettings(settings);
    window.localStorage.setItem(LAYOUT_SETTINGS_KEY, JSON.stringify(normalized));
    applyLayoutSettings(normalized);
}

function setupSidebarResizeHandle() {
    const handle = document.getElementById('sidebar-resizer');
    const mainContent = document.querySelector('.main-content');
    if (!handle || !mainContent) return;

    let resizeState = null;

    const applySidebarWidthFromClientX = (clientX) => {
        const rect = mainContent.getBoundingClientRect();
        if (!rect.width) return DEFAULT_LAYOUT_SETTINGS.sidebarWidth;

        const nextWidth = clamp(((clientX - rect.left) / rect.width) * 100, 10, 60);
        applyLayoutSettings({ ...loadLayoutSettings(), sidebarWidth: nextWidth });

        const settingsInput = document.getElementById('settings-sidebar-width');
        if (settingsInput) {
            settingsInput.value = Math.round(nextWidth * 10) / 10;
        }

        return nextWidth;
    };

    const handlePointerMove = (event) => {
        if (!resizeState) return;
        resizeState.sidebarWidth = applySidebarWidthFromClientX(event.clientX);
    };

    const finishResize = () => {
        if (!resizeState) return;

        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('mousemove', handlePointerMove, true);
        window.removeEventListener('mouseup', finishResize, true);

        if (typeof resizeState.sidebarWidth === 'number') {
            saveLayoutSettings({ ...loadLayoutSettings(), sidebarWidth: resizeState.sidebarWidth });
        }

        resizeState = null;
    };

    handle.addEventListener('mousedown', (event) => {
        if (event.button !== 0) return;

        event.preventDefault();
        event.stopPropagation();

        resizeState = {
            sidebarWidth: loadLayoutSettings().sidebarWidth
        };

        document.body.classList.add('sidebar-resizing');
        resizeState.sidebarWidth = applySidebarWidthFromClientX(event.clientX);
        window.addEventListener('mousemove', handlePointerMove, true);
        window.addEventListener('mouseup', finishResize, true);
    });
}

function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const theme = loadThemePreference();
    const typography = loadTypographySettings();

    document.getElementById('settings-theme').value = theme;
    document.getElementById('settings-ui-font').value = typography.uiFont;
    document.getElementById('settings-editor-font').value = typography.editorFont;
    document.getElementById('settings-ui-font-size').value = typography.uiFontSize;
    document.getElementById('settings-editor-font-size').value = typography.editorFontSize;
    document.getElementById('settings-editor-line-height').value = typography.editorLineHeight;
    document.getElementById('settings-editor-paragraph-spacing').value = typography.editorParagraphSpacing;
    document.getElementById('settings-toolbar-position').value = typography.toolbarPosition;

    setSettingsTab(currentSettingsTab);
    modal.classList.add('show');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('show');
}

function setSettingsTab(tab) {
    const nextTab = ['theme', 'font'].includes(tab) ? tab : 'theme';
    currentSettingsTab = nextTab;

    for (const button of document.querySelectorAll('.settings-tab')) {
        button.classList.toggle('active', button.dataset.tab === nextTab);
    }

    for (const panel of document.querySelectorAll('.settings-panel')) {
        panel.classList.toggle('active', panel.id === `settings-panel-${nextTab}`);
    }
}

function handleSaveSettings() {
    saveThemePreference(document.getElementById('settings-theme').value);
    saveTypographySettings({
        uiFont: document.getElementById('settings-ui-font').value,
        editorFont: document.getElementById('settings-editor-font').value,
        uiFontSize: document.getElementById('settings-ui-font-size').value,
        editorFontSize: document.getElementById('settings-editor-font-size').value,
        editorLineHeight: document.getElementById('settings-editor-line-height').value,
        editorParagraphSpacing: document.getElementById('settings-editor-paragraph-spacing').value,
        toolbarPosition: document.getElementById('settings-toolbar-position').value
    });
    closeSettingsModal();
}

function resetLayoutSettings() {
    saveThemePreference(DEFAULT_THEME_ID);
    saveTypographySettings(DEFAULT_TYPOGRAPHY_SETTINGS);
    document.getElementById('settings-theme').value = DEFAULT_THEME_ID;
    document.getElementById('settings-ui-font').value = DEFAULT_TYPOGRAPHY_SETTINGS.uiFont;
    document.getElementById('settings-editor-font').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorFont;
    document.getElementById('settings-ui-font-size').value = DEFAULT_TYPOGRAPHY_SETTINGS.uiFontSize;
    document.getElementById('settings-editor-font-size').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorFontSize;
    document.getElementById('settings-editor-line-height').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorLineHeight;
    document.getElementById('settings-editor-paragraph-spacing').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorParagraphSpacing;
    document.getElementById('settings-toolbar-position').value = DEFAULT_TYPOGRAPHY_SETTINGS.toolbarPosition;
}

function initializeEditor() {
    if (window.editor) {
        return;
    }

    setupWindowDragAndDrop();
    setupPreviewScrollSync();
    setupJumpNavigation();
    isUsingFallbackEditor = false;
    const typography = loadTypographySettings();

    window.editor = createWysiwygEditor(
        document.getElementById('editor-container'),
        DEFAULT_UNTITLED_CONTENT
    );
    window.editor.updateOptions({
        fontFamily: FONT_FAMILY_MAP[typography.editorFont],
        fontSize: typography.editorFontSize
    });
    window.editor.onDidChangeModelContent(() => {
        handleEditorContentChanged();
        refreshEditorToolbarState();
    });
    bindWysiwygEditorEvents(window.editor);
    finishEditorInitialization();
}

function bindWysiwygEditorEvents(editorInstance) {
    const root = editorInstance.getRootElement();
    if (!root) return;
    let toolbarRefreshFrame = null;
    const scheduleToolbarRefresh = () => {
        if (toolbarRefreshFrame) return;
        toolbarRefreshFrame = window.requestAnimationFrame(() => {
            toolbarRefreshFrame = null;
            refreshEditorToolbarState();
        });
    };

    const handleEditorShortcut = (event) => {
        const isPrimaryModifier = event.metaKey || event.ctrlKey;
        const key = event.key.toLowerCase();

        if (
            !event.defaultPrevented
            && pendingAttachmentDeleteSnapshot
            && isPrimaryModifier
            && !event.shiftKey
            && !event.altKey
            && key === 'z'
        ) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            applyPendingAttachmentDeleteSnapshot();
            return;
        }

        if (event.defaultPrevented) return;
        if (!isEventInsideEditorRoot(event, root)) return;

        if (event.key === 'Backspace' && editorInstance.preventImageBackspaceFromTrailingEmptyLine?.()) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            return;
        }

        if (!isPrimaryModifier) return;

        if (!event.shiftKey && !event.altKey && /^[1-6]$/.test(key)) {
            event.preventDefault();
            runEditorToolbarCommand('heading', { level: Number(key) });
            return;
        }

        if (key === 's') {
            event.preventDefault();
            saveFile();
            return;
        }

        if (key === 't') {
            event.preventDefault();
            toggleSelectedLinesAsTodo();
            return;
        }

        if (key === 'f') {
            event.preventDefault();
            focusToolbarSearch();
            return;
        }

        if (key === 'z' && !event.shiftKey && pendingAttachmentDeleteSnapshot) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            applyPendingAttachmentDeleteSnapshot();
        }
    };

    root.addEventListener('keydown', handleEditorShortcut, true);
    document.addEventListener('keydown', handleEditorShortcut, true);
    root.addEventListener('keyup', scheduleToolbarRefresh, true);
    root.addEventListener('mouseup', scheduleToolbarRefresh, true);
    root.addEventListener('focusin', scheduleToolbarRefresh, true);
    root.addEventListener('click', scheduleToolbarRefresh, true);

    root.addEventListener('mousedown', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;

        const targetElement = getEventTargetElement(event.target);
        const attachmentElement = targetElement?.closest?.('[data-kangaroo-attachment]') || null;
        if (attachmentElement) {
            const attachmentInfo = typeof editorInstance.getAttachmentInfoFromElement === 'function'
                ? editorInstance.getAttachmentInfoFromElement(attachmentElement)
                : null;
            if (attachmentInfo) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                editorInstance.selectAttachment?.(attachmentInfo);
                return;
            }
        }

        editorInstance.beginPointerInteraction?.(event.clientX, event.clientY);

        if (
            targetElement?.closest?.('[data-kangaroo-attachment]') ||
            targetElement?.closest?.('[data-resize-container][data-node="image"]') ||
            targetElement?.closest?.('a.kangaroo-link')
        ) {
            return;
        }

        editorInstance.clearCustomSelections?.();
    }, true);
    window.addEventListener('mousemove', (event) => {
        editorInstance.trackPointerInteraction?.(event.clientX, event.clientY);
    }, true);
    window.addEventListener('mouseup', () => {
        editorInstance.endPointerInteraction?.();
    }, true);

    root.addEventListener('paste', (event) => {
        const internalSlicePayload = event.clipboardData?.getData?.(KANGAROO_INTERNAL_SLICE_MIME) || '';
        const transformedInternalSlice = internalSlicePayload
            ? transformClipboardSlicePayloadForCurrentBundle(internalSlicePayload)
            : null;
        if (transformedInternalSlice && window.editor && typeof window.editor.insertSliceJson === 'function') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            window.editor.insertSliceJson(transformedInternalSlice);
            return;
        }

        const clipboardPathEntries = getClipboardPathEntries(event);
        const pastedAbsolutePath = clipboardPathEntries.length ? '' : getPastedAbsolutePath(event);
        const html = event.clipboardData?.getData('text/html') || '';
        const transformedBundleHtml = html ? transformPastedHtmlForCurrentBundle(html) : '';
        if (pastedAbsolutePath) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            insertAbsolutePathLink(pastedAbsolutePath);
            return;
        }

        if (transformedBundleHtml && window.editor && typeof window.editor.insertHtml === 'function') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            window.editor.insertHtml(transformedBundleHtml);
            return;
        }

        const items = Array.from(event.clipboardData?.items || []);
        const hasImage = items.some((item) => item.type.startsWith('image/'));
        const hasRemoteImage = /<img.*?src=["']https?:/i.test(html);
        const hasClipboardImage = !clipboard.readImage().isEmpty();
        const hasClipboardPaths = clipboardPathEntries.length > 0;

        if (!hasImage && !hasRemoteImage && !hasClipboardImage && !hasClipboardPaths) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        handleClipboardPaste(event);
    }, true);

    root.addEventListener('copy', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;

        const slicePayload = buildEditorClipboardSlicePayload(editorInstance);
        const html = buildEditorClipboardHtml(editorInstance);
        if ((!html && !slicePayload) || !event.clipboardData) return;

        event.preventDefault();
        event.stopPropagation();
        if (slicePayload) {
            event.clipboardData.setData(KANGAROO_INTERNAL_SLICE_MIME, slicePayload);
        }
        if (html) {
            event.clipboardData.setData('text/html', html);
        }
        event.clipboardData.setData('text/plain', String(window.getSelection?.() || ''));
    }, true);

    root.addEventListener('mousedown', (event) => {
    }, true);

    root.addEventListener('click', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;
        if (event.button !== 0) return;
        if (editorInstance.shouldSuppressClickSelection?.()) return;
    }, true);

    root.addEventListener('dblclick', async (event) => {
        if (event.defaultPrevented) return;
        if (!isEventInsideEditorRoot(event, root)) return;

        const targetElement = getEventTargetElement(event.target);
        const attachmentElement = targetElement?.closest?.('[data-kangaroo-attachment]') || null;
        if (!attachmentElement) return;

        const attachmentInfo = typeof editorInstance.getAttachmentInfoFromElement === 'function'
            ? editorInstance.getAttachmentInfoFromElement(attachmentElement)
            : null;
        if (!attachmentInfo) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        editorInstance.selectAttachment?.(attachmentInfo);
        await openEditorLinkTarget(attachmentInfo);
    });

    document.addEventListener('contextmenu', (event) => {
        if (event.defaultPrevented) return;
        if (!isEventInsideEditorRoot(event, root)) return;

        const targetElement = getEventTargetElement(event.target);
        const attachmentElement = targetElement?.closest?.('[data-kangaroo-attachment]') || null;
        if (!attachmentElement) return;

        const attachmentInfo = typeof editorInstance.getAttachmentInfoFromElement === 'function'
            ? editorInstance.getAttachmentInfoFromElement(attachmentElement)
            : null;
        if (!attachmentInfo) return;
        const attachmentReference = buildAttachmentContextReference(attachmentInfo);
        if (!attachmentReference) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        editorInstance.selectAttachment?.(attachmentInfo);
        hideEditorLinkContextMenu();
        hideAttachmentContextMenu();
        showAttachmentContextMenu(event, attachmentReference);
    }, true);

    if (typeof editorInstance.setAttachmentInteractionHandlers === 'function') {
        editorInstance.setAttachmentInteractionHandlers({
            onOpen: async (linkInfo) => {
                await openEditorLinkTarget(linkInfo);
            },
            onContextMenu: (event, linkInfo) => {
                const attachmentReference = buildAttachmentContextReference(linkInfo);
                if (!attachmentReference) return;
                hideEditorLinkContextMenu();
                hideAttachmentContextMenu();
                showAttachmentContextMenu(event, attachmentReference);
            }
        });
    }

    if (typeof editorInstance.setImageInteractionHandlers === 'function') {
        editorInstance.setImageInteractionHandlers({
            onSelect: () => {
                hidePreviewImageContextMenu();
            },
            onOpen: async (imageInfo) => {
                await openPreviewImageWithSystem(imageInfo.imagePath);
            },
            onContextMenu: (event, imageInfo) => {
                hideEditorLinkContextMenu();
                showPreviewImageContextMenu(event, imageInfo.imagePath);
            }
        });
    }

    if (typeof editorInstance.setLinkInteractionHandlers === 'function') {
        editorInstance.setLinkInteractionHandlers({
            onOpen: async (linkInfo) => {
                await openEditorLinkTarget(linkInfo);
            },
            onContextMenu: (event, linkInfo) => {
                hideEditorLinkContextMenu();
                showEditorLinkContextMenu(event, linkInfo);
            }
        });
    }

    if (typeof editorInstance.setDeleteInteractionHandlers === 'function') {
        editorInstance.setDeleteInteractionHandlers({
            onBeforeDelete: (deleteMeta) => {
                capturePendingAttachmentDeleteSnapshot(deleteMeta);
                persistActiveTabState();
            }
        });
    }

    scheduleToolbarRefresh();
}

function isEventInsideEditorRoot(event, root) {
    if (!root) return false;
    if (event.target && root.contains(event.target)) return true;
    if (document.activeElement && root.contains(document.activeElement)) return true;

    const selection = window.getSelection();
    const anchorNode = selection?.anchorNode;
    if (anchorNode) {
        const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE ? anchorNode : anchorNode.parentElement;
        if (anchorElement && root.contains(anchorElement)) {
            return true;
        }
    }

    return false;
}

function getEventTargetElement(target) {
    if (!target) return null;
    return target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement || null;
}

function finishEditorInitialization() {
    ensureDragCaretIndicator(document.getElementById('editor-container'));
    restoreWorkspaceRootPreference();
    clearEditorForNoTab();
    isEditorReady = true;
    resolveEditorReady();
    resetEditorLineTracking();
    schedulePreviewSync('cursor');
}

function createFallbackEditor(reason) {
    const container = document.getElementById('editor-container');
    container.innerHTML = '';

    const wrapper = document.createElement('div');
    wrapper.className = 'fallback-editor';

    const highlight = document.createElement('pre');
    highlight.className = 'fallback-highlight';

    const textarea = document.createElement('textarea');
    textarea.className = 'fallback-editor-input';
    textarea.value = DEFAULT_UNTITLED_CONTENT;
    textarea.spellcheck = false;
    fallbackTextarea = textarea;
    fallbackHighlightLayer = highlight;

    wrapper.appendChild(highlight);
    wrapper.appendChild(textarea);
    container.appendChild(wrapper);
    ensureDragCaretIndicator(container);
    resetFallbackHistory(textarea);

    textarea.addEventListener('beforeinput', () => {
        if (fallbackApplyingHistory) return;
        fallbackPendingSnapshot = createFallbackSnapshot(textarea);
    });

    textarea.addEventListener('input', () => {
        if (!fallbackApplyingHistory && fallbackPendingSnapshot) {
            pushFallbackUndoSnapshot(fallbackPendingSnapshot);
            fallbackRedoStack = [];
        }

        fallbackPendingSnapshot = null;
        scheduleFallbackHighlightRender();
        handleEditorContentChanged();
    });

    textarea.addEventListener('scroll', () => {
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
    });

    textarea.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
            event.preventDefault();
            saveFile();
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v') {
            event.preventDefault();
            handleClipboardPaste();
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();

            if (event.shiftKey) {
                performFallbackRedo(textarea, highlight);
            } else {
                performFallbackUndo(textarea, highlight);
            }

            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            performFallbackRedo(textarea, highlight);
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 't') {
            event.preventDefault();
            toggleSelectedLinesAsTodo();
            return;
        }

        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            focusToolbarSearch();
            return;
        }
    });

    textarea.addEventListener('click', (event) => {
        if (!event.metaKey) return;

        const lineNumber = getPositionAtOffset(textarea.value, textarea.selectionStart).lineNumber;
        scrollPreviewToSourceLine(lineNumber, 'center');
    });

    isUsingFallbackEditor = true;
    window.editor = createTextareaEditorAdapter(textarea, highlight);

    renderFallbackHighlight(textarea, highlight);
    finishEditorInitialization();
}

function createTextareaEditorAdapter(textarea, highlight) {
    const changeListeners = [];

    textarea.addEventListener('input', () => {
        for (const listener of changeListeners) {
            listener();
        }
    });

    return {
        getValue() {
            return textarea.value;
        },
        setEditable(editable) {
            const isEditable = Boolean(editable);
            textarea.readOnly = !isEditable;
            textarea.classList.toggle('is-readonly', !isEditable);
        },
        setValue(value) {
            textarea.value = value;
            resetFallbackHistory(textarea);
            renderFallbackHighlight(textarea, highlight);
        },
        focus() {
            textarea.focus();
        },
        addCommand() {},
        onDidChangeModelContent(listener) {
            changeListeners.push(listener);
        },
        getSelection() {
            return {
                start: textarea.selectionStart,
                end: textarea.selectionEnd
            };
        },
        executeEdits(_, edits) {
            const edit = edits[0];
            const start = edit.range.start;
            const end = edit.range.end;
            const value = textarea.value;
            pushFallbackUndoSnapshot(createFallbackSnapshot(textarea));
            fallbackRedoStack = [];
            textarea.value = value.slice(0, start) + edit.text + value.slice(end);
            const caret = start + edit.text.length;
            textarea.setSelectionRange(caret, caret);
            renderFallbackHighlight(textarea, highlight);
        },
        pushUndoStop() {},
        revealLineInCenter(lineNumber) {
            const index = getIndexFromLineAndColumn(textarea.value, lineNumber, 1);
            textarea.setSelectionRange(index, index);
            textarea.focus();
        },
        setPosition({ lineNumber, column }) {
            const index = getIndexFromLineAndColumn(textarea.value, lineNumber, column);
            textarea.setSelectionRange(index, index);
        },
        getModel() {
            return {
                getPositionAt(offset) {
                    return getPositionAtOffset(textarea.value, offset);
                }
            };
        }
    };
}

function createFallbackSnapshot(textarea) {
    return {
        value: textarea.value,
        start: textarea.selectionStart || 0,
        end: textarea.selectionEnd || 0
    };
}

function resetFallbackHistory(textarea) {
    fallbackUndoStack = [];
    fallbackRedoStack = [];
    fallbackPendingSnapshot = null;

    if (textarea) {
        fallbackUndoStack.push(createFallbackSnapshot(textarea));
    }
}

function pushFallbackUndoSnapshot(snapshot) {
    if (!snapshot) return;

    const lastSnapshot = fallbackUndoStack[fallbackUndoStack.length - 1];
    if (
        lastSnapshot &&
        lastSnapshot.value === snapshot.value &&
        lastSnapshot.start === snapshot.start &&
        lastSnapshot.end === snapshot.end
    ) {
        return;
    }

    fallbackUndoStack.push(snapshot);

    if (fallbackUndoStack.length > 200) {
        fallbackUndoStack.shift();
    }
}

function applyFallbackSnapshot(textarea, highlight, snapshot) {
    if (!snapshot) return;

    fallbackApplyingHistory = true;
    textarea.value = snapshot.value;
    textarea.setSelectionRange(snapshot.start, snapshot.end);
    renderFallbackHighlight(textarea, highlight);
    handleEditorContentChanged();
    fallbackApplyingHistory = false;
    textarea.focus();
}

function performFallbackUndo(textarea, highlight) {
    if (fallbackUndoStack.length <= 1) return;

    const currentSnapshot = createFallbackSnapshot(textarea);
    const targetSnapshot = fallbackUndoStack.pop();
    fallbackRedoStack.push(currentSnapshot);
    applyFallbackSnapshot(textarea, highlight, targetSnapshot);
}

function performFallbackRedo(textarea, highlight) {
    if (!fallbackRedoStack.length) return;

    const currentSnapshot = createFallbackSnapshot(textarea);
    const targetSnapshot = fallbackRedoStack.pop();
    fallbackUndoStack.push(currentSnapshot);
    applyFallbackSnapshot(textarea, highlight, targetSnapshot);
}

function renderFallbackHighlight(textarea, highlight) {
    const lines = textarea.value.split('\n');
    let inFence = false;

    const html = lines.map((line, index) => {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            return wrapActiveFallbackLine(index + 1, `<span class="md-syntax-fence">${escapeHtml(line)}</span>`);
        }

        if (inFence) {
            return wrapActiveFallbackLine(index + 1, `<span class="md-syntax-codeblock">${escapeHtml(line)}</span>`);
        }

        return wrapActiveFallbackLine(index + 1, highlightMarkdownLine(line));
    }).join('\n');

    highlight.innerHTML = `${html || '<span class="md-syntax-text"></span>'}\n`;
}

function scheduleFallbackHighlightRender() {
    if (!fallbackTextarea || !fallbackHighlightLayer) return;
    if (fallbackHighlightFrame) return;

    fallbackHighlightFrame = window.requestAnimationFrame(() => {
        fallbackHighlightFrame = null;
        renderFallbackHighlight(fallbackTextarea, fallbackHighlightLayer);
    });
}

function wrapActiveFallbackLine(lineNumber, html) {
    if (lineNumber !== activeEditorHighlightLine) {
        return html;
    }

    return `<span class="fallback-active-line">${html || '&nbsp;'}</span>`;
}

function highlightMarkdownLine(line) {
    if (/^\s*$/.test(line)) {
        return '';
    }

    if (/^\s{0,3}(#{1,6})\s+/.test(line)) {
        return highlightInlineMarkdown(line, 'md-syntax-heading');
    }

    if (/^\s*>\s?/.test(line)) {
        return highlightInlineMarkdown(line, 'md-syntax-quote');
    }

    if (/^\s*(?:[-+*]|\d+\.)\s+/.test(line)) {
        return highlightInlineMarkdown(line, 'md-syntax-list');
    }

    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
        return `<span class="md-syntax-hr">${escapeHtml(line)}</span>`;
    }

    return highlightInlineMarkdown(line);
}

function highlightInlineMarkdown(line, baseClass = 'md-syntax-text') {
    let html = escapeHtml(line);

    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<span class="md-syntax-image">![$1]($2)</span>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-syntax-link">[$1]($2)</span>');
    html = html.replace(/(`[^`]+`)/g, '<span class="md-syntax-code">$1</span>');
    html = html.replace(/(\*\*[^*]+\*\*|__[^_]+__)/g, '<span class="md-syntax-strong">$1</span>');
    html = html.replace(/(\*[^*\n]+\*|_[^_\n]+_)/g, '<span class="md-syntax-emphasis">$1</span>');

    return `<span class="${baseClass}">${html}</span>`;
}

function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function stripTaskMarkerFromInlineToken(token, markerText) {
    token.content = token.content.slice(markerText.length);

    if (!Array.isArray(token.children) || !token.children.length) {
        return;
    }

    let remaining = markerText.length;
    const children = [];

    for (const child of token.children) {
        if (remaining > 0 && child.type === 'text') {
            if (child.content.length <= remaining) {
                remaining -= child.content.length;
                continue;
            }

            child.content = child.content.slice(remaining);
            remaining = 0;
        }

        children.push(child);
    }

    token.children = children;
}

function injectTaskCheckboxIntoInlineToken(state, token, taskMeta) {
    if (!token || !Array.isArray(token.children)) {
        return;
    }

    const checkedAttr = taskMeta && taskMeta.checked ? ' checked' : '';
    const sourceLineAttr = taskMeta && taskMeta.sourceLine
        ? ` data-task-line="${taskMeta.sourceLine}"`
        : '';
    const checkboxToken = new state.Token('html_inline', '', 0);
    checkboxToken.content = `<input class="preview-task-checkbox" type="checkbox"${checkedAttr}${sourceLineAttr}> `;
    token.children.unshift(checkboxToken);
}

function getPositionAtOffset(text, offset) {
    const content = text.slice(0, offset);
    const lines = content.split('\n');

    return {
        lineNumber: lines.length,
        column: lines[lines.length - 1].length + 1
    };
}

function getIndexFromLineAndColumn(text, lineNumber, column) {
    const lines = text.split('\n');
    let index = 0;

    for (let i = 0; i < lineNumber - 1 && i < lines.length; i++) {
        index += lines[i].length + 1;
    }

    return index + Math.max(column - 1, 0);
}

function addSourceLineAttribute(html, map) {
    if (!map || !html) return html;

    const lineNumber = map[0] + 1;
    const lineEnd = map[1];
    return html.replace(
        /^<([a-z0-9-]+)(\s|>)/i,
        `<$1 data-source-line="${lineNumber}" data-source-line-end="${lineEnd}"$2`
    );
}

function setupWindowDragAndDrop() {
    const editorContainer = document.getElementById('editor-container');
    const getEditorInteractiveElement = () => {
        if (window.editor && typeof window.editor.getRootElement === 'function') {
            return window.editor.getRootElement();
        }
        return editorContainer;
    };

    ensureDragCaretIndicator(editorContainer);

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (!isFileDragEvent(e)) return;

        pendingDropLocation = getCurrentEditorDropLocation();
        renderDragCaretIndicator(pendingDropLocation);

        if (isPointInsideElement(getEditorInteractiveElement(), e.clientX, e.clientY)) {
            updateEditorDropLocation(e.clientX, e.clientY);
        }
    });

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
        if (!isFileDragEvent(e)) return;

        if (isPointInsideElement(getEditorInteractiveElement(), e.clientX, e.clientY)) {
            e.dataTransfer.dropEffect = 'copy';
            updateEditorDropLocation(e.clientX, e.clientY);
        } else {
            pendingDropLocation = getCurrentEditorDropLocation();
            renderDragCaretIndicator(pendingDropLocation);
        }
    });

    editorContainer.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        updateEditorDropLocation(e.clientX, e.clientY);
    });

    editorContainer.addEventListener('dragenter', (e) => {
        e.preventDefault();
        pendingDropLocation = getCurrentEditorDropLocation();
        renderDragCaretIndicator(pendingDropLocation);
        updateEditorDropLocation(e.clientX, e.clientY);
    });

    editorContainer.addEventListener('dragleave', (e) => {
        if (!isPointInsideElement(getEditorInteractiveElement(), e.clientX, e.clientY)) {
            hideDragCaretIndicator();
        }
    });

    window.addEventListener('drop', async (e) => {
        e.preventDefault();

        if (isPointInsideElement(getEditorInteractiveElement(), e.clientX, e.clientY)) {
            updateEditorDropLocation(e.clientX, e.clientY);
            applyPendingDropLocation(e.clientX, e.clientY);
        }

        hideDragCaretIndicator();

        const files = e.dataTransfer.files;
        const errors = [];

        for (let file of files) {
            try {
                const filePath = getDroppedFilePath(file);
                if (!filePath) continue;

                const stat = fs.statSync(filePath);

                if (stat.isFile() && ((file.type && file.type.startsWith('image/')) || isImageFilePath(filePath))) {
                    handleImageBuffer(fs.readFileSync(filePath));
                    continue;
                }

                handleAttachmentPath(filePath, stat);
            } catch (error) {
                errors.push(`${file.name || getDroppedFilePath(file) || '未知项目'}: ${error.message}`);
                continue;
            }
        }

        if (errors.length) {
            alert(`拖拽导入失败：\n${errors.join('\n')}`);
        }
    });
}

function isFileDragEvent(event) {
    return Boolean(event.dataTransfer && Array.from(event.dataTransfer.types || []).includes('Files'));
}

function updateEditorDropLocation(clientX, clientY) {
    if (!window.editor) return;

    if (typeof window.editor.getDropLocation === 'function') {
        pendingDropLocation = window.editor.getDropLocation(clientX, clientY) || getCurrentEditorDropLocation();
        renderDragCaretIndicator(pendingDropLocation);
        return;
    }

    pendingDropLocation = getCurrentEditorDropLocation();
    renderDragCaretIndicator(pendingDropLocation);
}

function buildMonacoDropLocation(position) {
    if (!position) return null;

    const visiblePosition = typeof window.editor.getScrolledVisiblePosition === 'function'
        ? window.editor.getScrolledVisiblePosition(position)
        : null;

    return {
        type: 'monaco',
        position,
        left: visiblePosition ? visiblePosition.left : 12,
        top: visiblePosition ? visiblePosition.top : 12,
        height: visiblePosition ? visiblePosition.height : 22
    };
}

function getApproximateMonacoDropLocation(clientX, clientY) {
    if (!window.editor || isUsingFallbackEditor) return null;

    const editorContainer = document.getElementById('editor-container');
    const rect = editorContainer.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        return null;
    }

    const model = typeof window.editor.getModel === 'function' ? window.editor.getModel() : null;
    if (!model) return null;

    const layout = typeof window.editor.getLayoutInfo === 'function'
        ? window.editor.getLayoutInfo()
        : { contentLeft: 0 };
    const scrollTop = typeof window.editor.getScrollTop === 'function' ? window.editor.getScrollTop() : 0;
    const scrollLeft = typeof window.editor.getScrollLeft === 'function' ? window.editor.getScrollLeft() : 0;
    const lineHeight = typeof window.editor.getOption === 'function' && typeof monaco !== 'undefined'
        ? window.editor.getOption(monaco.editor.EditorOption.lineHeight)
        : 22;
    const fontInfo = typeof window.editor.getOption === 'function' && typeof monaco !== 'undefined'
        ? window.editor.getOption(monaco.editor.EditorOption.fontInfo)
        : null;
    const charWidth = fontInfo && fontInfo.typicalHalfwidthCharacterWidth
        ? fontInfo.typicalHalfwidthCharacterWidth
        : 8;
    const yInEditor = scrollTop + clientY - rect.top;
    const xInEditor = Math.max(scrollLeft + clientX - rect.left - (layout.contentLeft || 0), 0);
    const lineNumber = clamp(Math.floor(yInEditor / Math.max(lineHeight, 1)) + 1, 1, model.getLineCount());
    const maxColumn = typeof model.getLineMaxColumn === 'function'
        ? model.getLineMaxColumn(lineNumber)
        : 1;
    const column = clamp(Math.round(xInEditor / Math.max(charWidth, 1)) + 1, 1, maxColumn);
    const top = (lineNumber - 1) * lineHeight - scrollTop;
    const left = 12;
    const width = Math.max(rect.width - 24, 24);

    return {
        type: 'monaco',
        position: { lineNumber, column },
        left,
        top: Math.max(top, 0),
        height: 3,
        width
    };
}

function getCurrentEditorDropLocation() {
    if (!window.editor) return null;

    if (typeof window.editor.getCurrentDropLocation === 'function') {
        return window.editor.getCurrentDropLocation();
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        const style = window.getComputedStyle(fallbackTextarea);
        const paddingLeft = parseFloat(style.paddingLeft) || 0;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const lineHeight = parseFloat(style.lineHeight) || 26;
        const charWidth = getFallbackCharWidth(style);
        const index = fallbackTextarea.selectionStart || 0;
        const position = getPositionAtOffset(fallbackTextarea.value, index);

        return {
            type: 'fallback',
            index,
            lineNumber: position.lineNumber,
            column: position.column,
            left: 12,
            top: paddingTop + (position.lineNumber - 1) * lineHeight - fallbackTextarea.scrollTop,
            height: 3,
            width: Math.max(rect.width - 24, 24)
        };
    }

    const position = typeof window.editor.getPosition === 'function' ? window.editor.getPosition() : null;
    if (!position) return null;

    const visiblePosition = typeof window.editor.getScrolledVisiblePosition === 'function'
        ? window.editor.getScrolledVisiblePosition(position)
        : null;

    return {
        type: 'monaco',
        position,
        left: 12,
        top: visiblePosition ? visiblePosition.top : 12,
        height: 3,
        width: Math.max(document.getElementById('editor-container').clientWidth - 24, 24)
    };
}

function getFallbackDropLocation(clientX, clientY) {
    if (!fallbackTextarea) return null;

    const rect = fallbackTextarea.getBoundingClientRect();
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        return null;
    }

    const style = window.getComputedStyle(fallbackTextarea);
    const paddingLeft = parseFloat(style.paddingLeft) || 0;
    const paddingTop = parseFloat(style.paddingTop) || 0;
    const lineHeight = parseFloat(style.lineHeight) || 26;
    const charWidth = getFallbackCharWidth(style);
    const text = fallbackTextarea.value;
    const lines = text.split('\n');
    const x = fallbackTextarea.scrollLeft + clientX - rect.left - paddingLeft;
    const y = fallbackTextarea.scrollTop + clientY - rect.top - paddingTop;
    const lineNumber = clamp(Math.floor(y / lineHeight) + 1, 1, Math.max(lines.length, 1));
    const lineText = lines[lineNumber - 1] || '';
    const column = clamp(Math.round(Math.max(x, 0) / Math.max(charWidth, 1)) + 1, 1, lineText.length + 1);
    const index = getIndexFromLineAndColumn(text, lineNumber, column);

    return {
        type: 'fallback',
        index,
        lineNumber,
        column,
        left: 12,
        top: paddingTop + (lineNumber - 1) * lineHeight - fallbackTextarea.scrollTop,
        height: 3,
        width: Math.max(rect.width - 24, 24)
    };
}

function getFallbackCharWidth(style) {
    if (fallbackCharWidth) return fallbackCharWidth;

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = style.font;
    fallbackCharWidth = context.measureText('M').width || 8;
    return fallbackCharWidth;
}

function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function isPointInsideElement(element, clientX, clientY) {
    if (!element) return false;

    const rect = element.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

function ensureDragCaretIndicator(editorContainer) {
    if (dragCaretIndicator && dragCaretIndicator.parentElement === editorContainer && dragCaretIndicator.isConnected) {
        return;
    }

    if (dragCaretIndicator && dragCaretIndicator.parentElement) {
        dragCaretIndicator.remove();
    }

    dragCaretIndicator = document.createElement('div');
    dragCaretIndicator.className = 'drag-caret-indicator';
    editorContainer.appendChild(dragCaretIndicator);
}

function renderDragCaretIndicator(location) {
    void location;
    hideDragCaretIndicator();
}

function hideDragCaretIndicator() {
    pendingDropLocation = null;

    if (!dragCaretIndicator) return;
    dragCaretIndicator.style.display = 'none';
}

function applyPendingDropLocation(clientX = null, clientY = null) {
    if (!window.editor) return;

    if (
        typeof clientX === 'number'
        && typeof clientY === 'number'
        && typeof window.editor.getDropLocation === 'function'
    ) {
        pendingDropLocation = window.editor.getDropLocation(clientX, clientY) || pendingDropLocation;
    }

    if (!pendingDropLocation) return;

    if (typeof window.editor.applyDropLocation === 'function') {
        window.editor.applyDropLocation(pendingDropLocation);
        return;
    }

    if (pendingDropLocation.type === 'fallback' && fallbackTextarea) {
        fallbackTextarea.focus();
        fallbackTextarea.setSelectionRange(pendingDropLocation.index, pendingDropLocation.index);
        return;
    }

    if (pendingDropLocation.type === 'monaco' && pendingDropLocation.position) {
        window.editor.setPosition(pendingDropLocation.position);
        window.editor.focus();
    }
}

function setupPreviewScrollSync() {
    if (previewScrollCleanupBound) return;

    previewScrollCleanupBound = true;
}

function setupJumpNavigation() {
    const preview = document.getElementById('preview-container');

    preview.addEventListener('pointerdown', (event) => {
        const handle = event.target.closest('.preview-image-resize-handle');
        if (!handle) return;

        const metadata = getPreviewImageMetadataFromNode(handle);
        if (!metadata) return;

        selectPreviewImageFromNode(handle);
        startPreviewImageResize(event, metadata);
    });

    preview.addEventListener('change', (event) => {
        const checkbox = event.target.closest('.preview-task-checkbox');
        if (!checkbox) return;

        event.preventDefault();
        event.stopPropagation();

        const sourceLine = Number(checkbox.getAttribute('data-task-line') || 0);
        if (!sourceLine) return;

        suppressEditorDrivenPreviewSyncUntil = Date.now() + 300;
        updateTaskLineCheckedState(sourceLine, checkbox.checked);
    });

    preview.addEventListener('dblclick', async (event) => {
        const metadata = getPreviewImageMetadataFromNode(event.target);
        if (!metadata) return;

        event.preventDefault();
        event.stopPropagation();
        await openPreviewImageWithSystem(metadata.imagePath);
    });

    preview.addEventListener('contextmenu', (event) => {
        const metadata = getPreviewImageMetadataFromNode(event.target);
        if (!metadata) return;

        event.preventDefault();
        event.stopPropagation();
        selectPreviewImageFromNode(event.target);
        showPreviewImageContextMenu(event, metadata.imagePath);
    });

    preview.addEventListener('click', async (event) => {
        hidePreviewImageContextMenu();

        const imageMetadata = getPreviewImageMetadataFromNode(event.target);
        if (imageMetadata) {
            event.preventDefault();
            event.stopPropagation();
            selectPreviewImageFromNode(event.target);
            return;
        }

        clearSelectedPreviewImage();

        if (event.target.closest('.preview-task-checkbox')) {
            event.stopPropagation();
            return;
        }

        const link = event.target.closest('a[href]');
        if (link) {
            event.preventDefault();
            event.stopPropagation();
            await openPreviewLink(link.getAttribute('href'));
            return;
        }

        if (!event.metaKey) return;

        const block = event.target.closest('[data-source-line]');
        if (!block) return;

        event.preventDefault();
        const sourceLine = Number(block.getAttribute('data-source-line') || 1);
        jumpEditorToLine(sourceLine, { preservePreviewScroll: true });
    });

    window.addEventListener('pointermove', (event) => {
        updateActivePreviewImageResize(event);
    });

    window.addEventListener('pointerup', () => {
        finishActivePreviewImageResize();
    });
}

async function openPreviewLink(href) {
    const target = resolvePreviewLinkTarget(href);
    if (!target) return;

    const result = await ipcRenderer.invoke('shell:openLinkTarget', target);
    if (!result || !result.ok) {
        alert(`打开链接失败: ${(result && result.error) || href}`);
    }
}

function resolvePreviewLinkTarget(href) {
    if (!href) return null;

    const normalizedHref = safeDecodeUri(href.trim());
    if (!normalizedHref || normalizedHref.startsWith('#')) {
        return null;
    }

    if (/^file:/i.test(normalizedHref)) {
        return {
            type: 'path',
            value: url.fileURLToPath(normalizedHref)
        };
    }

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(normalizedHref)) {
        return {
            type: 'external',
            value: normalizedHref
        };
    }

    let resolvedPath = normalizedHref;

    if (normalizedHref.startsWith('~/')) {
        resolvedPath = path.join(os.homedir(), normalizedHref.slice(2));
    } else if (!path.isAbsolute(normalizedHref)) {
        resolvedPath = path.resolve(window.currentPath || process.cwd(), normalizedHref);
    }

    return {
        type: 'path',
        value: resolvedPath
    };
}

function getPreviewEntryBadgeForFile(filePath, isDirectory = false) {
    if (isDirectory) return '文件夹';

    const ext = path.extname(filePath || '').toLowerCase();
    const badgeMap = {
        '.pdf': 'PDF',
        '.doc': 'Word',
        '.docx': 'Word',
        '.pages': 'Pages',
        '.xls': 'Excel',
        '.xlsx': 'Excel',
        '.numbers': 'Numbers',
        '.ppt': 'PPT',
        '.pptx': 'PPT',
        '.key': 'Keynote',
        '.md': 'Markdown',
        '.markdown': 'Markdown',
        '.txt': '文本',
        '.rtf': 'RTF',
        '.zip': '压缩包',
        '.rar': '压缩包',
        '.7z': '压缩包',
        '.tar': '压缩包',
        '.gz': '压缩包',
        '.png': '图片',
        '.jpg': '图片',
        '.jpeg': '图片',
        '.gif': '图片',
        '.webp': '图片',
        '.svg': '图片',
        '.heic': '图片',
        '.mp3': '音频',
        '.wav': '音频',
        '.m4a': '音频',
        '.flac': '音频',
        '.mp4': '视频',
        '.mov': '视频',
        '.mkv': '视频'
    };

    return badgeMap[ext] || '文件';
}

function decoratePreviewLinks() {
    const preview = document.getElementById('preview-container');
    if (!preview) return;

    const links = Array.from(preview.querySelectorAll('a[href]'));

    for (const link of links) {
        if (link.closest('.preview-image-resizer')) continue;

        const href = link.getAttribute('href');
        const target = resolvePreviewLinkTarget(href);
        if (!target || target.type !== 'path') continue;

        const targetPath = target.value;
        const exists = targetPath && fs.existsSync(targetPath);
        const isDirectory = exists ? fs.statSync(targetPath).isDirectory() : false;
        const badge = exists ? getPreviewEntryBadgeForFile(targetPath, isDirectory) : '缺失';
        const icon = exists ? (isDirectory ? '📁' : '📄') : '⚠';
        const entryClass = exists
            ? (isDirectory ? 'preview-entry-folder' : 'preview-entry-file')
            : 'preview-entry-missing';

        const originalNodes = Array.from(link.childNodes);
        const nameSpan = document.createElement('span');
        nameSpan.className = 'preview-entry-name';

        if (originalNodes.length) {
            for (const node of originalNodes) {
                nameSpan.appendChild(node);
            }
        } else {
            nameSpan.textContent = href;
        }

        const iconSpan = document.createElement('span');
        iconSpan.className = 'preview-entry-icon';
        iconSpan.textContent = icon;

        const badgeSpan = document.createElement('span');
        badgeSpan.className = 'preview-entry-badge';
        badgeSpan.textContent = badge;

        link.classList.add('preview-entry-link', entryClass);
        link.textContent = '';
        link.appendChild(iconSpan);
        link.appendChild(nameSpan);
        link.appendChild(badgeSpan);
    }
}

function safeDecodeUri(value) {
    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

function decodeRelativePathSegments(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => {
            try {
                return decodeURIComponent(segment);
            } catch {
                return segment;
            }
        })
        .join('/');
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizePreviewImageSourceRef(sourceRef) {
    if (!sourceRef) return '';

    let normalized = safeDecodeUri(String(sourceRef).trim()).replace(/\\/g, '/');

    if (/^file:/i.test(normalized)) {
        try {
            normalized = url.fileURLToPath(normalized).replace(/\\/g, '/');
        } catch {
            return '';
        }
    }

    if (window.currentPath && path.isAbsolute(normalized)) {
        const relative = path.relative(window.currentPath, normalized).replace(/\\/g, '/');
        if (!relative.startsWith('..')) {
            normalized = relative;
        }
    }

    return normalized.replace(/^\.?\//, '').replace(/^\/+/, '');
}

function extractHtmlAttribute(tag, attributeName) {
    const pattern = new RegExp(`\\b${attributeName}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = tag.match(pattern);
    return match ? (match[1] ?? match[2] ?? match[3] ?? '') : null;
}

function setOrReplaceHtmlAttribute(tag, attributeName, value) {
    const escapedValue = escapeHtmlAttribute(value);
    const pattern = new RegExp(`\\b${attributeName}\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)`, 'i');

    if (pattern.test(tag)) {
        return tag.replace(pattern, `${attributeName}="${escapedValue}"`);
    }

    return tag.replace(/<img\b/i, `<img ${attributeName}="${escapedValue}"`);
}

function removeHtmlAttribute(tag, attributeName) {
    const pattern = new RegExp(`\\s*${attributeName}\\s*=\\s*(?:\"[^\"]*\"|'[^']*'|[^\\s>]+)`, 'ig');
    return tag.replace(pattern, '');
}

function ensureHtmlStyleDeclarations(tag, declarations) {
    const existingStyle = extractHtmlAttribute(tag, 'style') || '';
    const declarationMap = new Map();

    existingStyle.split(';').forEach((part) => {
        const [rawKey, rawValue] = part.split(':');
        if (!rawKey || !rawValue) return;
        declarationMap.set(rawKey.trim().toLowerCase(), rawValue.trim());
    });

    for (const [key, value] of Object.entries(declarations)) {
        declarationMap.set(key.toLowerCase(), value);
    }

    const styleValue = Array.from(declarationMap.entries())
        .map(([key, value]) => `${key}: ${value}`)
        .join('; ');

    return setOrReplaceHtmlAttribute(tag, 'style', styleValue);
}

function removeHtmlStyleProperties(tag, propertyNames) {
    const existingStyle = extractHtmlAttribute(tag, 'style');
    if (!existingStyle) return tag;

    const blocked = new Set(propertyNames.map((name) => name.toLowerCase()));
    const keptParts = existingStyle
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => {
            const [name] = part.split(':');
            return name && !blocked.has(name.trim().toLowerCase());
        });

    if (!keptParts.length) {
        return removeHtmlAttribute(tag, 'style');
    }

    return setOrReplaceHtmlAttribute(tag, 'style', keptParts.join('; '));
}

function resolvePreviewImageFilePath(sourceRef) {
    if (!sourceRef) return null;

    let resolvedPath = safeDecodeUri(String(sourceRef).trim());
    if (!resolvedPath) return null;

    if (/^file:/i.test(resolvedPath)) {
        try {
            resolvedPath = url.fileURLToPath(resolvedPath);
        } catch {
            return null;
        }
    } else if (!path.isAbsolute(resolvedPath)) {
        resolvedPath = path.resolve(window.currentPath || process.cwd(), resolvedPath);
    }

    return resolvedPath;
}

function buildPreviewImageHtml({ alt = '', absolutePath, sourceRef, lineNumber, width = null }) {
    const attrs = [
        `src="${escapeHtmlAttribute(url.pathToFileURL(absolutePath).href)}"`,
        `alt="${escapeHtmlAttribute(alt)}"`,
        `data-preview-image-path="${escapeHtmlAttribute(absolutePath)}"`,
        `data-preview-image-src="${escapeHtmlAttribute(normalizePreviewImageSourceRef(sourceRef))}"`,
        `data-preview-source-line="${lineNumber}"`,
        'style="max-width: 100%; height: auto;"'
    ];

    if (width) {
        attrs.push(`width="${escapeHtmlAttribute(width)}"`);
    }

    return `<img ${attrs.join(' ')} />`;
}

function decorateHtmlImageTagForPreview(tag, lineNumber) {
    const src = extractHtmlAttribute(tag, 'src');
    if (!src) return tag;

    const absolutePath = resolvePreviewImageFilePath(src);
    if (!absolutePath || !fs.existsSync(absolutePath) || !isImageFilePath(absolutePath)) {
        return tag;
    }

    let nextTag = tag;
    nextTag = setOrReplaceHtmlAttribute(nextTag, 'src', url.pathToFileURL(absolutePath).href);
    nextTag = setOrReplaceHtmlAttribute(nextTag, 'data-preview-image-path', absolutePath);
    nextTag = setOrReplaceHtmlAttribute(nextTag, 'data-preview-image-src', normalizePreviewImageSourceRef(src));
    nextTag = setOrReplaceHtmlAttribute(nextTag, 'data-preview-source-line', String(lineNumber));
    nextTag = ensureHtmlStyleDeclarations(nextTag, {
        'max-width': '100%',
        'height': 'auto'
    });
    return nextTag;
}

function transformMarkdownForPreview(raw) {
    if (!window.currentPath) {
        return raw.replace(/<img\b[^>]*>/gi, (tag) => decorateHtmlImageTagForPreview(tag, 1));
    }

    const assetsDir = path.join(window.currentPath, 'assets');
    const lines = raw.split('\n');

    return lines.map((line, index) => {
        const lineNumber = index + 1;
        let nextLine = line.replace(
            /!\[(.*?)\]\((?:\.?\/)?assets\/(.+?)\)/g,
            (_, alt, file) => {
                const relativeFile = safeDecodeUri(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
                const absolutePath = path.join(assetsDir, relativeFile);
                if (!fs.existsSync(absolutePath)) {
                    return _;
                }

                return buildPreviewImageHtml({
                    alt,
                    absolutePath,
                    sourceRef: `assets/${relativeFile}`,
                    lineNumber
                });
            }
        );

        nextLine = nextLine.replace(/<img\b[^>]*>/gi, (tag) => decorateHtmlImageTagForPreview(tag, lineNumber));
        return nextLine;
    }).join('\n');
}

function isImageFilePath(filePath) {
    return /\.(png|jpe?g|gif|webp|bmp|svg|tiff?|ico|heic)$/i.test(filePath);
}

function isVideoFilePath(filePath) {
    return /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(filePath);
}

function isPdfFilePath(filePath) {
    return /\.pdf$/i.test(filePath);
}

function getDroppedFilePath(file) {
    if (!file) return '';

    try {
        return webUtils.getPathForFile(file) || file.path || '';
    } catch {
        return file.path || '';
    }
}

function handleClipboardPaste(event = null) {
    const clipboardPaths = getClipboardPathEntries(event);
    if (clipboardPaths.length) {
        for (const filePath of clipboardPaths) {
            const stat = fs.statSync(filePath);
            if (stat.isFile() && isImageFilePath(filePath)) {
                handleImageBuffer(fs.readFileSync(filePath));
                continue;
            }

            handleAttachmentPath(filePath, stat);
        }
        return;
    }

    const image = clipboard.readImage();
    if (!image.isEmpty()) return handleImagePaste(image);

    const html = clipboard.readHTML();
    const match = html.match(/<img.*?src="(.*?)"/);

    if (match && match[1].startsWith('http')) {
        return downloadImage(match[1]);
    }

    const text = clipboard.readText();
    if (text) insertText(text);
}


// ==============================
// ⭐ 保存函数（统一入口）
// ==============================
async function saveFile(options = {}) {
    const { silent = false } = options;

    if (!ensureEditorReady()) return false;
    if (!window.currentPath) {
        if (silent) return false;
        return await handleSaveAs();
    }

    if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }

    const markdown = window.editor.getValue();

    try {
        suppressWorkspaceWatcherUntil = Math.max(suppressWorkspaceWatcherUntil, Date.now() + 1500);
        const restoredEntries = restoreRecoveredEntries(markdown);
        cleanUnusedImages(markdown);
        const canContinueSave = await cleanUnusedAttachments(markdown);
        if (!canContinueSave) {
            return false;
        }

        fs.writeFileSync(
            resolveBundleMarkdownFilePath(window.currentPath, { createIfMissing: true }),
            markdown,
            'utf-8'
        );

        setDirty(false);
        const activeTab = getActiveTab();
        if (activeTab) {
            activeTab.path = window.currentPath;
            activeTab.content = markdown;
            activeTab.previousContent = markdown;
            activeTab.isDirty = false;
            activeTab.previousIsDirty = false;
            activeTab.preservedEntries = Array.from(preservedUnusedAttachmentEntries);
            renderEditorTabs();
        }
        if (restoredEntries) {
            if (window.editor && typeof window.editor.refreshDisplayState === 'function') {
                window.editor.refreshDisplayState();
            }
            updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
            updateOutline();
        }
        console.log("保存成功");
        return true;
    } catch (error) {
        if (!silent) {
            alert("保存失败: " + error.message);
        }
        return false;
    }
}

function scheduleAutoSave() {
    if (!window.currentPath || !isDirty) return;

    if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
    }

    autoSaveTimer = window.setTimeout(() => {
        autoSaveTimer = null;
        void saveFile({ silent: true });
    }, AUTO_SAVE_DELAY);
}

async function confirmUnsavedChanges(actionLabel) {
    if (!isDirty) return true;

    const canSave = Boolean(window.currentPath);
    const decision = await ipcRenderer.invoke('dialog:confirmUnsavedChanges', {
        actionLabel,
        canSave
    });

    if (decision === 'save') {
        return await saveFile();
    }

    if (decision === 'discard') {
        if (autoSaveTimer) {
            window.clearTimeout(autoSaveTimer);
            autoSaveTimer = null;
        }
        setDirty(false);
        return true;
    }

    return false;
}


// ==============================
// 文件命名
// ==============================
function doesEntryNameExist(kind, targetDir, entryName) {
    if (fs.existsSync(path.join(targetDir, entryName))) {
        return true;
    }

    if (!window.currentPath) {
        return false;
    }

    const recoveryPath = path.join(window.currentPath, RECOVERY_DIR_NAME, kind, entryName);
    return fs.existsSync(recoveryPath);
}

function generateFileName(assetsDir) {
    const date = new Date().toISOString().split('T')[0];

    let i = 1;
    let name;

    do {
        name = `image-${date}-${String(i).padStart(3, '0')}.png`;
        i++;
    } while (doesEntryNameExist('assets', assetsDir, name));

    return name;
}

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function ensureRecoveryDir(kind) {
    const recoveryRoot = path.join(window.currentPath, RECOVERY_DIR_NAME);
    const recoveryDir = path.join(recoveryRoot, kind);
    ensureDirectory(recoveryDir);
    return recoveryDir;
}

function moveEntryToRecovery(kind, entryName) {
    const sourceDir = path.join(window.currentPath, kind);
    const sourcePath = path.join(sourceDir, entryName);
    if (!fs.existsSync(sourcePath)) return false;

    const recoveryDir = ensureRecoveryDir(kind);
    const targetPath = path.join(recoveryDir, entryName);

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.renameSync(sourcePath, targetPath);
    return true;
}

function backupEntryToRecovery(kind, entryName) {
    const sourceDir = path.join(window.currentPath, kind);
    const sourcePath = path.join(sourceDir, entryName);
    if (!fs.existsSync(sourcePath)) return false;

    const recoveryDir = ensureRecoveryDir(kind);
    const targetPath = path.join(recoveryDir, entryName);

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    copyPathRecursive(sourcePath, targetPath);
    return true;
}

function restoreEntryFromRecovery(kind, entryName) {
    const recoveryDir = path.join(window.currentPath, RECOVERY_DIR_NAME, kind);
    const sourcePath = path.join(recoveryDir, entryName);
    if (!fs.existsSync(sourcePath)) return false;

    const targetDir = path.join(window.currentPath, kind);
    ensureDirectory(targetDir);
    const targetPath = path.join(targetDir, entryName);

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    fs.renameSync(sourcePath, targetPath);
    return true;
}

function restoreRecoveredEntries(markdown) {
    if (!window.currentPath) return false;
    const usedAttachmentEntries = getUsedAttachmentEntries(markdown, { preferEditorState: true });

    let restored = false;

    for (const entryName of getUsedImageEntries(markdown)) {
        restored = restoreEntryFromRecovery('assets', entryName) || restored;
    }

    for (const entryName of usedAttachmentEntries) {
        restored = restoreEntryFromRecovery('attachments', entryName) || restored;
    }

    return restored;
}

function cleanupRecoveryDir(bundlePath = window.currentPath) {
    if (!bundlePath) return;

    const recoveryRoot = path.join(bundlePath, RECOVERY_DIR_NAME);
    if (!fs.existsSync(recoveryRoot)) return;

    fs.rmSync(recoveryRoot, { recursive: true, force: true });
}

function restoreActiveTabFromPreviousSnapshot() {
    const activeTab = getActiveTab();
    if (!activeTab || !window.editor) return false;

    if (applyPendingAttachmentDeleteSnapshot()) {
        return true;
    }

    const previousContent = typeof activeTab.previousContent === 'string'
        ? activeTab.previousContent
        : activeTab.content;
    const previousIsDirty = Boolean(activeTab.previousIsDirty);

    suppressDocumentStateSync = true;
    if (typeof window.editor.setValue === 'function') {
        window.editor.setValue(previousContent, { emitChange: false });
    }
    suppressDocumentStateSync = false;

    activeTab.content = previousContent;
    activeTab.isDirty = previousIsDirty;
    updateBundleStatus(activeTab.path || null);
    renderToolbarSearchResults(currentSearchQuery);
    updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
    updateOutline();
    setDirty(previousIsDirty);
    renderEditorTabs();

    if (previousIsDirty) {
        scheduleAutoSave();
    }

    return true;
}

function ensureAttachmentsDir() {
    const attachmentsDir = path.join(window.currentPath, 'attachments');
    ensureDirectory(attachmentsDir);
    return attachmentsDir;
}

function generateUniqueEntryName(targetDir, baseName) {
    const parsed = path.parse(baseName);
    const base = parsed.name || baseName;
    const ext = parsed.ext || '';
    const kind = path.basename(targetDir);

    let candidate = baseName;
    let counter = 1;

    while (doesEntryNameExist(kind, targetDir, candidate)) {
        candidate = `${base}-${String(counter).padStart(2, '0')}${ext}`;
        counter++;
    }

    return candidate;
}

function removeDirectoryIfExists(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.rmSync(dirPath, { recursive: true, force: true });
    }
}

function copyPathRecursive(sourcePath, targetPath, stat = null) {
    const sourceStat = stat || fs.statSync(sourcePath);

    if (sourceStat.isDirectory()) {
        ensureDirectory(targetPath);

        for (const entryName of fs.readdirSync(sourcePath)) {
            copyPathRecursive(
                path.join(sourcePath, entryName),
                path.join(targetPath, entryName)
            );
        }

        return;
    }

    fs.copyFileSync(sourcePath, targetPath);
}

function copyNamedEntries(sourceDir, targetDir, entryNames) {
    ensureDirectory(targetDir);

    for (const entryName of entryNames) {
        const sourcePath = path.join(sourceDir, entryName);
        if (!fs.existsSync(sourcePath)) continue;

        copyPathRecursive(sourcePath, path.join(targetDir, entryName));
    }
}

function toMarkdownRelativeLink(relativePath) {
    return relativePath
        .split(path.sep)
        .join('/')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function fromMarkdownRelativeLink(relativePath) {
    return String(relativePath || '')
        .split('/')
        .map((segment) => safeDecodeUri(segment))
        .join(path.sep);
}

function parseMarkdownLinkDestinationForImport(rawDestination) {
    const trimmed = String(rawDestination || '').trim();
    if (!trimmed) return null;

    const angleMatch = trimmed.match(/^<([^>]+)>(?:\s+"([^"]*)")?$/);
    if (angleMatch) {
        return {
            href: angleMatch[1].trim(),
            title: angleMatch[2] ? angleMatch[2].trim() : ''
        };
    }

    const titleMatch = trimmed.match(/^(\S+)\s+"([^"]*)"$/);
    if (titleMatch) {
        return {
            href: titleMatch[1].trim(),
            title: titleMatch[2].trim()
        };
    }

    return {
        href: trimmed,
        title: ''
    };
}

function composeMarkdownLinkDestinationForImport(href, title = '') {
    const normalizedHref = String(href || '').trim();
    if (!normalizedHref) return '';

    const hrefPart = /\s/.test(normalizedHref) ? `<${normalizedHref}>` : normalizedHref;
    const normalizedTitle = String(title || '').trim();
    return normalizedTitle
        ? `${hrefPart} "${normalizedTitle.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
        : hrefPart;
}

function getAttachmentIdentityForAbsolutePath(absolutePath) {
    const normalizedPath = String(absolutePath || '').trim();
    if (!normalizedPath || !fs.existsSync(normalizedPath)) {
        return null;
    }

    try {
        const stat = fs.statSync(normalizedPath);
        if (typeof stat.dev === 'number' && typeof stat.ino === 'number') {
            return `${stat.dev}:${stat.ino}`;
        }
    } catch {
        return null;
    }

    return null;
}

function getAttachmentIdentityForRelativePath(relativePath) {
    if (!window.currentPath || !relativePath) {
        return null;
    }

    const absolutePath = path.resolve(window.currentPath, fromMarkdownRelativeLink(relativePath));
    return getAttachmentIdentityForAbsolutePath(absolutePath);
}

function insertAttachmentLink(relativePath) {
    const href = toMarkdownRelativeLink(relativePath);
    const identity = getAttachmentIdentityForRelativePath(relativePath);

    if (window.editor && typeof window.editor.insertAttachmentLink === 'function') {
        window.editor.insertAttachmentLink(href, { insertTrailingParagraph: true, identity });
        return;
    }

    const label = path.basename(relativePath);
    if (window.editor && typeof window.editor.insertLink === 'function') {
        window.editor.insertLink(label, href, { insertTrailingParagraph: true });
        return;
    }

    const safeLabel = escapeMarkdownLinkLabel(label);
    insertMarkdown(`[${safeLabel}](${href})\n`);
}

function insertVideoAttachment(relativePath) {
    insertAttachmentLink(relativePath);
}

function insertPdfAttachment(relativePath) {
    const href = toMarkdownRelativeLink(relativePath);
    const identity = getAttachmentIdentityForRelativePath(relativePath);

    if (window.editor && typeof window.editor.insertPdfAttachment === 'function') {
        window.editor.insertPdfAttachment(href, { insertTrailingParagraph: true, identity });
        return;
    }

    insertAttachmentLink(relativePath);
}

function handleAttachmentPath(sourcePath, stat = null) {
    if (!window.currentPath) {
        alert("请先打开项目！");
        return;
    }

    const sourceStat = stat || fs.statSync(sourcePath);
    const attachmentsDir = ensureAttachmentsDir();
    const normalizedSourcePath = path.resolve(sourcePath);
    const relativeToAttachments = path.relative(attachmentsDir, normalizedSourcePath);

    if (relativeToAttachments && !relativeToAttachments.startsWith('..') && !path.isAbsolute(relativeToAttachments)) {
        const relativePath = path.join('attachments', relativeToAttachments);
        if (!sourceStat.isDirectory() && isVideoFilePath(normalizedSourcePath)) {
            insertVideoAttachment(relativePath);
            return;
        }
        if (!sourceStat.isDirectory() && isPdfFilePath(normalizedSourcePath)) {
            insertPdfAttachment(relativePath);
            return;
        }
        insertAttachmentLink(relativePath);
        return;
    }

    const entryName = generateUniqueEntryName(attachmentsDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(attachmentsDir, entryName);

    if (sourceStat.isDirectory()) {
        copyPathRecursive(normalizedSourcePath, targetPath, sourceStat);
    } else {
        fs.copyFileSync(normalizedSourcePath, targetPath);
    }

    const insertedRelativePath = path.join('attachments', entryName);
    if (!sourceStat.isDirectory() && isVideoFilePath(normalizedSourcePath)) {
        insertVideoAttachment(insertedRelativePath);
        return;
    }
    if (!sourceStat.isDirectory() && isPdfFilePath(normalizedSourcePath)) {
        insertPdfAttachment(insertedRelativePath);
        return;
    }

    insertAttachmentLink(insertedRelativePath);
}


// ==============================
// 图片保存
// ==============================
function saveImage(buffer) {
    const assetsDir = path.join(window.currentPath, 'assets');
    ensureDirectory(assetsDir);

    const filename = generateFileName(assetsDir);
    const filePath = path.join(assetsDir, filename);

    fs.writeFileSync(filePath, buffer);
    const relativePath = `assets/${filename}`;
    if (window.editor && typeof window.editor.insertImage === 'function') {
        window.editor.insertImage(relativePath, { alt: filename });
        return;
    }

    insertMarkdown(`![image](${relativePath})\n`);
}


// ==============================
// 粘贴
// ==============================
function handleImagePaste(image) {
    if (!window.currentPath) return alert("请先打开项目！");
    saveImage(image.toPNG());
}

function handleImageBuffer(buffer) {
    if (!window.currentPath) return alert("请先打开项目！");
    saveImage(buffer);
}

function parseClipboardFileUrls(rawValue) {
    return String(rawValue || '')
        .split(/[\r\n\0]+/)
        .map((entry) => entry.trim())
        .filter(Boolean)
        .map((entry) => {
            try {
                return /^file:/i.test(entry) ? url.fileURLToPath(entry) : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function getPastedAbsolutePath(event) {
    const rawText = String(event?.clipboardData?.getData?.('text/plain') || '').trim();
    if (!rawText || /[\r\n]/.test(rawText)) {
        return '';
    }

    const candidate = resolveAbsolutePathCandidate(rawText);
    if (!candidate) {
        return '';
    }

    try {
        return fs.existsSync(candidate) ? candidate : '';
    } catch {
        return '';
    }
}

function resolveAbsolutePathCandidate(rawText) {
    const normalizedText = safeDecodeUri(String(rawText || '').trim());
    if (!normalizedText) return '';

    if (/^file:/i.test(normalizedText)) {
        try {
            return path.resolve(url.fileURLToPath(normalizedText));
        } catch {
            return '';
        }
    }

    if (normalizedText.startsWith('~/')) {
        return path.resolve(path.join(os.homedir(), normalizedText.slice(2)));
    }

    if (path.isAbsolute(normalizedText)) {
        return path.resolve(normalizedText);
    }

    return '';
}

function escapeMarkdownLinkLabel(text) {
    return String(text || '').replace(/([\\\[\]])/g, '\\$1');
}

function unescapeMarkdownLinkLabel(text) {
    return String(text || '').replace(/\\([\[\]\\])/g, '$1');
}

function insertAbsolutePathLink(absolutePath) {
    const normalizedPath = path.resolve(String(absolutePath || ''));
    if (!normalizedPath) return;

    const href = normalizedPath.replace(/>/g, '%3E');
    if (window.editor && typeof window.editor.insertAbsolutePathLink === 'function') {
        window.editor.insertAbsolutePathLink(normalizedPath, { insertTrailingParagraph: false });
        return;
    }

    if (window.editor && typeof window.editor.insertLink === 'function') {
        window.editor.insertLink(normalizedPath, href, { insertTrailingParagraph: false });
        return;
    }

    const label = escapeMarkdownLinkLabel(normalizedPath);
    insertMarkdown(`[${label}](<${href}>)`);
}

function findContainingTextBundlePath(targetPath) {
    if (!targetPath) return '';

    let currentPath = path.resolve(String(targetPath));
    try {
        if (fs.existsSync(currentPath) && !fs.statSync(currentPath).isDirectory()) {
            currentPath = path.dirname(currentPath);
        }
    } catch {
        currentPath = path.dirname(currentPath);
    }

    while (currentPath && currentPath !== path.dirname(currentPath)) {
        if (currentPath.toLowerCase().endsWith('.textbundle') && fs.existsSync(currentPath)) {
            return currentPath;
        }
        currentPath = path.dirname(currentPath);
    }

    return '';
}

function resolveClipboardLocalPath(rawValue) {
    const normalizedValue = String(rawValue || '').trim();
    if (!normalizedValue) return '';

    const unwrappedValue = normalizedValue.replace(/^<|>$/g, '');

    if (/^file:/i.test(unwrappedValue)) {
        try {
            return path.resolve(url.fileURLToPath(unwrappedValue));
        } catch {
            return '';
        }
    }

    if (path.isAbsolute(unwrappedValue)) {
        return path.resolve(safeDecodeUri(unwrappedValue));
    }

    return '';
}

function importReferencedEntryIntoCurrentBundle(absolutePath) {
    if (!window.currentPath || !absolutePath) {
        return null;
    }

    const normalizedSourcePath = path.resolve(absolutePath);
    if (!fs.existsSync(normalizedSourcePath)) {
        return null;
    }

    const currentBundlePath = path.resolve(window.currentPath);
    const sourceBundlePath = findContainingTextBundlePath(normalizedSourcePath);
    if (!sourceBundlePath) {
        return null;
    }

    const relativeInsideBundle = path.relative(sourceBundlePath, normalizedSourcePath).replace(/\\/g, '/');
    if (!relativeInsideBundle || relativeInsideBundle.startsWith('..')) {
        return null;
    }

    const topLevelDir = relativeInsideBundle.split('/')[0];
    const sourceStat = fs.statSync(normalizedSourcePath);
    const shouldTreatAsImage = (
        topLevelDir === 'assets'
        && !sourceStat.isDirectory()
        && isImageFilePath(normalizedSourcePath)
    );

    if (path.resolve(sourceBundlePath) === currentBundlePath) {
        return {
            relativePath: shouldTreatAsImage
                ? toMarkdownRelativeLink(relativeInsideBundle)
                : toMarkdownRelativeLink(relativeInsideBundle),
            kind: shouldTreatAsImage ? 'image' : 'attachment',
            absolutePath: normalizedSourcePath
        };
    }

    const targetRootDir = shouldTreatAsImage
        ? path.join(currentBundlePath, 'assets')
        : path.join(currentBundlePath, 'attachments');
    ensureDirectory(targetRootDir);

    const entryName = generateUniqueEntryName(targetRootDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(targetRootDir, entryName);

    if (sourceStat.isDirectory()) {
        copyPathRecursive(normalizedSourcePath, targetPath, sourceStat);
    } else {
        fs.copyFileSync(normalizedSourcePath, targetPath);
    }

    return {
        relativePath: toMarkdownRelativeLink(path.join(shouldTreatAsImage ? 'assets' : 'attachments', entryName)),
        kind: shouldTreatAsImage ? 'image' : 'attachment',
        absolutePath: targetPath
    };
}

function transformPastedHtmlForCurrentBundle(html) {
    if (!window.currentPath || !html || typeof DOMParser === 'undefined') {
        return '';
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(String(html), 'text/html');
    let didChange = false;

    for (const image of Array.from(doc.querySelectorAll('img[src]'))) {
        const sourcePath = resolveClipboardLocalPath(
            image.getAttribute('data-kangaroo-path') || image.getAttribute('src')
        );
        if (!sourcePath) continue;

        const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
        if (!imported || imported.kind !== 'image') continue;

        image.setAttribute('src', imported.relativePath);
        didChange = true;
    }

    for (const attachment of Array.from(doc.querySelectorAll('[data-kangaroo-attachment][data-href]'))) {
        const sourcePath = resolveClipboardLocalPath(
            attachment.getAttribute('data-kangaroo-path') || attachment.getAttribute('data-href')
        );
        if (!sourcePath) continue;

        const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
        if (!imported || imported.kind !== 'attachment') continue;

        const existingLabel = String(attachment.getAttribute('data-label') || attachment.textContent || '').trim();
        const nextLabel = existingLabel || safeDecodeUri(path.basename(imported.relativePath));
        attachment.setAttribute('data-href', imported.relativePath);
        attachment.setAttribute('data-label', nextLabel);
        attachment.setAttribute('data-kangaroo-path', resolvePreviewLinkTarget(imported.relativePath)?.value || '');
        attachment.textContent = nextLabel;
        didChange = true;
    }

    for (const video of Array.from(doc.querySelectorAll('[data-kangaroo-video][data-href]'))) {
        const sourcePath = resolveClipboardLocalPath(
            video.getAttribute('data-kangaroo-path') || video.getAttribute('data-href')
        );
        if (!sourcePath) continue;

        const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
        if (!imported || imported.kind !== 'attachment') continue;

        const existingLabel = String(video.getAttribute('data-label') || '').trim();
        const nextLabel = existingLabel || safeDecodeUri(path.basename(imported.relativePath));
        video.setAttribute('data-href', imported.relativePath);
        video.setAttribute('data-label', nextLabel);
        video.setAttribute('data-kangaroo-path', resolvePreviewLinkTarget(imported.relativePath)?.value || '');
        didChange = true;
    }

    for (const pdf of Array.from(doc.querySelectorAll('[data-kangaroo-pdf][data-href]'))) {
        const sourcePath = resolveClipboardLocalPath(
            pdf.getAttribute('data-kangaroo-path') || pdf.getAttribute('data-href')
        );
        if (!sourcePath) continue;

        const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
        if (!imported || imported.kind !== 'attachment') continue;

        const existingLabel = String(pdf.getAttribute('data-label') || '').trim();
        const nextLabel = existingLabel || safeDecodeUri(path.basename(imported.relativePath));
        pdf.setAttribute('data-href', imported.relativePath);
        pdf.setAttribute('data-label', nextLabel);
        pdf.setAttribute('data-kangaroo-path', resolvePreviewLinkTarget(imported.relativePath)?.value || '');
        didChange = true;
    }

    for (const link of Array.from(doc.querySelectorAll('a[href]'))) {
        const sourcePath = resolveClipboardLocalPath(
            link.getAttribute('data-kangaroo-path') || link.getAttribute('href')
        );
        if (!sourcePath) continue;

        const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
        if (!imported) continue;

        link.setAttribute('href', imported.relativePath);
        if (!String(link.textContent || '').trim()) {
            link.textContent = path.basename(imported.relativePath);
        }
        didChange = true;
    }

    return didChange ? doc.body.innerHTML : '';
}

function buildEditorClipboardHtml(editorInstance) {
    const state = editorInstance?.editor?.state;
    const selection = state?.selection;
    if (!state || !selection || selection.empty) {
        return '';
    }

    const slice = selection.content();
    const container = document.createElement('div');
    const serializer = DOMSerializer.fromSchema(state.schema);
    const fragment = serializer.serializeFragment(slice.content, {
        document
    });
    container.appendChild(fragment);

    let hasBundleResources = false;

    for (const image of Array.from(container.querySelectorAll('img'))) {
        let absolutePath = String(image.getAttribute('data-kangaroo-path') || '').trim();
        const src = String(image.getAttribute('src') || '').trim();

        if (!absolutePath && /^file:/i.test(src)) {
            try {
                absolutePath = url.fileURLToPath(src);
            } catch {
                absolutePath = '';
            }
        }

        if (!absolutePath) continue;
        hasBundleResources = true;
        image.setAttribute('data-kangaroo-path', absolutePath);
        image.setAttribute('src', url.pathToFileURL(absolutePath).href);
    }

    for (const attachment of Array.from(container.querySelectorAll('[data-kangaroo-attachment][data-href]'))) {
        let absolutePath = String(attachment.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(attachment.getAttribute('data-href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveAttachmentAbsolutePath === 'function') {
            absolutePath = String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim();
        }

        if (!absolutePath) continue;
        hasBundleResources = true;
        attachment.setAttribute('data-kangaroo-path', absolutePath);
    }

    for (const pdf of Array.from(container.querySelectorAll('[data-kangaroo-pdf][data-href]'))) {
        let absolutePath = String(pdf.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(pdf.getAttribute('data-href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveAttachmentAbsolutePath === 'function') {
            absolutePath = String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim();
        }

        if (!absolutePath) continue;
        hasBundleResources = true;
        pdf.setAttribute('data-kangaroo-path', absolutePath);
    }

    for (const link of Array.from(container.querySelectorAll('a.kangaroo-link'))) {
        let absolutePath = String(link.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(link.getAttribute('href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveLinkDisplayMeta === 'function') {
            absolutePath = String(editorInstance.resolveLinkDisplayMeta(href)?.absolutePath || '').trim();
        }

        if (!absolutePath) continue;
        hasBundleResources = true;
        link.setAttribute('data-kangaroo-path', absolutePath);
        link.setAttribute('href', url.pathToFileURL(absolutePath).href);
    }

    return hasBundleResources ? container.innerHTML : '';
}

function buildEditorClipboardSlicePayload(editorInstance) {
    const state = editorInstance?.editor?.state;
    const selection = state?.selection;
    if (!state || !selection || selection.empty) {
        return '';
    }

    const slice = selection.content();
    const payload = {
        slice: slice.toJSON(),
        links: {},
        images: {},
        attachments: {}
    };

    const walk = (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;

            if (node.type === 'image') {
                const src = String(node.attrs?.src || '').trim();
                const absolutePath = src && typeof editorInstance.resolveImagePath === 'function'
                    ? String(editorInstance.resolveImagePath(src) || '').trim()
                    : '';
                if (src && absolutePath) {
                    payload.images[src] = absolutePath;
                }
            }

            if (node.type === 'kangarooAttachment') {
                const href = String(node.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveAttachmentAbsolutePath === 'function'
                    ? String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim()
                    : '';
                if (href && absolutePath) {
                    payload.attachments[href] = {
                        absolutePath,
                        label: String(node.attrs?.label || '').trim(),
                        title: node.attrs?.title || null,
                        nodeType: 'kangarooAttachment'
                    };
                }
            }

            if (node.type === 'kangarooVideo') {
                const href = String(node.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveAttachmentAbsolutePath === 'function'
                    ? String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim()
                    : '';
                if (href && absolutePath) {
                    payload.attachments[href] = {
                        absolutePath,
                        label: String(node.attrs?.label || '').trim(),
                        title: node.attrs?.title || null,
                        nodeType: 'kangarooAttachment'
                    };
                }
            }

            if (node.type === 'kangarooPdf') {
                const href = String(node.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveAttachmentAbsolutePath === 'function'
                    ? String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim()
                    : '';
                if (href && absolutePath) {
                    payload.attachments[href] = {
                        absolutePath,
                        label: String(node.attrs?.label || '').trim(),
                        nodeType: 'kangarooPdf',
                        title: node.attrs?.title || null,
                        width: node.attrs?.width || null
                    };
                }
            }

            for (const mark of Array.isArray(node.marks) ? node.marks : []) {
                if (mark?.type !== 'link') continue;
                const href = String(mark.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveLinkDisplayMeta === 'function'
                    ? String(editorInstance.resolveLinkDisplayMeta(href)?.absolutePath || '').trim()
                    : '';
                if (href && absolutePath) {
                    payload.links[href] = absolutePath;
                }
            }

            if (Array.isArray(node.content)) {
                walk(node.content);
            }
        }
    };

    walk(payload.slice?.content || []);

    if (!Object.keys(payload.links).length && !Object.keys(payload.images).length && !Object.keys(payload.attachments).length) {
        return '';
    }

    return JSON.stringify(payload);
}

function transformClipboardSlicePayloadForCurrentBundle(payloadText) {
    if (!window.currentPath || !payloadText) {
        return null;
    }

    let payload;
    try {
        payload = JSON.parse(payloadText);
    } catch {
        return null;
    }

    if (!payload?.slice?.content) {
        return null;
    }

    const nextSlice = JSON.parse(JSON.stringify(payload.slice));
    let didChange = false;

    const walk = (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;

            if (node.type === 'image') {
                const src = String(node.attrs?.src || '').trim();
                const sourcePath = String(payload.images?.[src] || '').trim();
                if (sourcePath) {
                    const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
                    if (imported?.kind === 'image') {
                        node.attrs = {
                            ...node.attrs,
                            src: imported.relativePath
                        };
                        didChange = true;
                    }
                }
            }

            if (node.type === 'kangarooAttachment') {
                const href = String(node.attrs?.href || '').trim();
                const attachmentPayload = payload.attachments?.[href];
                const sourcePath = typeof attachmentPayload === 'string'
                    ? String(attachmentPayload || '').trim()
                    : String(attachmentPayload?.absolutePath || '').trim();
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                const targetNodeType = typeof attachmentPayload === 'string'
                    ? 'kangarooAttachment'
                    : String(attachmentPayload?.nodeType || 'kangarooAttachment').trim() || 'kangarooAttachment';
                if (sourcePath) {
                    const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
                    if (imported?.kind === 'attachment') {
                        const identity = getAttachmentIdentityForAbsolutePath(imported.absolutePath);
                        node.type = targetNodeType;
                        node.attrs = {
                            ...node.attrs,
                            href: imported.relativePath,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(imported.relativePath)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            identity
                        };
                        if (targetNodeType === 'kangarooPdf') {
                            node.attrs.width = typeof attachmentPayload === 'string' ? 560 : attachmentPayload?.width || node.attrs?.width || 560;
                        }
                        didChange = true;
                    }
                }
            }

            if (node.type === 'kangarooVideo') {
                const href = String(node.attrs?.href || '').trim();
                const attachmentPayload = payload.attachments?.[href];
                const sourcePath = typeof attachmentPayload === 'string'
                    ? String(attachmentPayload || '').trim()
                    : String(attachmentPayload?.absolutePath || '').trim();
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                if (sourcePath) {
                    const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
                    if (imported?.kind === 'attachment') {
                        const identity = getAttachmentIdentityForAbsolutePath(imported.absolutePath);
                        node.type = 'kangarooAttachment';
                        node.attrs = {
                            ...node.attrs,
                            href: imported.relativePath,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(imported.relativePath)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            identity
                        };
                        didChange = true;
                    }
                }
            }

            if (node.type === 'kangarooPdf') {
                const href = String(node.attrs?.href || '').trim();
                const attachmentPayload = payload.attachments?.[href];
                const sourcePath = typeof attachmentPayload === 'string'
                    ? String(attachmentPayload || '').trim()
                    : String(attachmentPayload?.absolutePath || '').trim();
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                if (sourcePath) {
                    const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
                    if (imported?.kind === 'attachment') {
                        const identity = getAttachmentIdentityForAbsolutePath(imported.absolutePath);
                        node.attrs = {
                            ...node.attrs,
                            href: imported.relativePath,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(imported.relativePath)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            width: typeof attachmentPayload === 'string' ? node.attrs?.width || 560 : attachmentPayload?.width || node.attrs?.width || 560,
                            identity
                        };
                        didChange = true;
                    }
                }
            }

            for (const mark of Array.isArray(node.marks) ? node.marks : []) {
                if (mark?.type !== 'link') continue;
                const href = String(mark.attrs?.href || '').trim();
                const sourcePath = String(payload.links?.[href] || '').trim();
                if (!sourcePath) continue;

                const imported = importReferencedEntryIntoCurrentBundle(sourcePath);
                if (!imported) continue;

                mark.attrs = {
                    ...mark.attrs,
                    href: imported.relativePath
                };
                didChange = true;
            }

            if (Array.isArray(node.content)) {
                walk(node.content);
            }
        }
    };

    walk(nextSlice.content || []);
    return didChange ? nextSlice : null;
}

function getClipboardPathEntries(event = null) {
    const paths = new Set();

    for (const file of Array.from(event?.clipboardData?.files || [])) {
        const filePath = getDroppedFilePath(file);
        if (filePath) {
            paths.add(path.resolve(filePath));
        }
    }

    const eventUriList = event?.clipboardData?.getData?.('text/uri-list') || '';
    for (const filePath of parseClipboardFileUrls(eventUriList)) {
        paths.add(path.resolve(filePath));
    }

    for (const format of ['public.file-url', 'text/uri-list']) {
        try {
            const buffer = clipboard.readBuffer(format);
            if (!buffer || !buffer.length) continue;

            for (const filePath of parseClipboardFileUrls(buffer.toString('utf8'))) {
                paths.add(path.resolve(filePath));
            }
        } catch {
            continue;
        }
    }

    return Array.from(paths).filter((filePath) => fs.existsSync(filePath));
}


// ==============================
// 下载图片
// ==============================
function downloadImage(imageUrl) {
    const assetsDir = path.join(window.currentPath, 'assets');
    ensureDirectory(assetsDir);

    const filename = generateFileName(assetsDir);
    const filePath = path.join(assetsDir, filename);

    const client = imageUrl.startsWith('https') ? https : http;

    client.get(imageUrl, (res) => {
        const stream = fs.createWriteStream(filePath);
        res.pipe(stream);

        stream.on('finish', () => {
            stream.close();
            const relativePath = `assets/${filename}`;
            if (window.editor && typeof window.editor.insertImage === 'function') {
                window.editor.insertImage(relativePath, { alt: filename });
                return;
            }

            insertMarkdown(`![image](${relativePath})\n`);
        });
    });
}


// ==============================
// 插入文本
// ==============================
function insertText(text) {
    if (!window.editor) return;

    if (typeof window.editor.insertText === 'function') {
        window.editor.insertText(text);
        return;
    }

    const selection = window.editor.getSelection();

    window.editor.executeEdits("insert", [{
        range: selection,
        text: text
    }]);

    window.editor.pushUndoStop();
}

function insertMarkdown(text) {
    if (!window.editor) return;

    if (typeof window.editor.insertMarkdown === 'function') {
        window.editor.insertMarkdown(text);
        return;
    }

    insertText(text);
}

function getUsedImageEntries(markdown) {
    const used = new Set();
    const markdownRegex = /!\[.*?\]\((?:\.?\/)?assets\/([^)]+)\)/g;
    const htmlRegex = /<img\b[^>]*\bsrc\s*=\s*(?:"((?:\.?\/)?assets\/[^"]+)"|'((?:\.?\/)?assets\/[^']+)'|((?:\.?\/)?assets\/[^\s>]+))[^>]*>/gi;

    let match;
    while ((match = markdownRegex.exec(markdown))) {
        const decodedPath = decodeRelativePathSegments(match[1] || '');
        const normalized = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const topLevelEntry = normalized.split('/')[0];

        if (topLevelEntry) {
            used.add(topLevelEntry);
        }
    }

    while ((match = htmlRegex.exec(markdown))) {
        const src = match[1] || match[2] || match[3] || '';
        const decodedPath = decodeRelativePathSegments(normalizePreviewImageSourceRef(src).replace(/^assets\//, ''));
        const normalized = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const topLevelEntry = normalized.split('/')[0];

        if (topLevelEntry) {
            used.add(topLevelEntry);
        }
    }

    return used;
}

function getEditorSelectedLineRange() {
    if (!window.editor) {
        return { startLine: 1, endLine: 1 };
    }

    if (typeof window.editor.getSelectionLineRange === 'function') {
        return window.editor.getSelectionLineRange();
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        const start = fallbackTextarea.selectionStart || 0;
        const end = fallbackTextarea.selectionEnd || 0;
        const effectiveEnd = end > start && fallbackTextarea.value[end - 1] === '\n' ? end - 1 : end;

        return {
            startLine: getPositionAtOffset(fallbackTextarea.value, start).lineNumber,
            endLine: getPositionAtOffset(fallbackTextarea.value, Math.max(effectiveEnd, start)).lineNumber
        };
    }

    const selection = typeof window.editor.getSelection === 'function' ? window.editor.getSelection() : null;
    if (!selection) {
        const position = typeof window.editor.getPosition === 'function' ? window.editor.getPosition() : null;
        const lineNumber = position ? position.lineNumber : 1;
        return { startLine: lineNumber, endLine: lineNumber };
    }

    const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
        ? selection.endLineNumber - 1
        : selection.endLineNumber;

    return {
        startLine: selection.startLineNumber,
        endLine: Math.max(selection.startLineNumber, endLine)
    };
}

function getEditorLineText(lineNumber) {
    if (!window.editor) return '';

    if (typeof window.editor.getLineText === 'function') {
        return window.editor.getLineText(lineNumber);
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        return fallbackTextarea.value.split('\n')[lineNumber - 1] || '';
    }

    const model = typeof window.editor.getModel === 'function' ? window.editor.getModel() : null;
    if (!model || typeof model.getLineContent !== 'function') return '';
    return model.getLineContent(lineNumber);
}

function replaceEditorLine(lineNumber, newLineText) {
    replaceEditorLines(lineNumber, lineNumber, [newLineText]);
}

function replaceEditorLines(startLine, endLine, newLines) {
    if (!window.editor) return;

    if (typeof window.editor.replaceLines === 'function') {
        window.editor.replaceLines(startLine, endLine, newLines);
        return;
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        const value = fallbackTextarea.value;
        const lines = value.split('\n');
        const startIndex = getIndexFromLineAndColumn(value, startLine, 1);
        const endIndex = endLine < lines.length
            ? getIndexFromLineAndColumn(value, endLine + 1, 1)
            : value.length;
        const replacementText = newLines.join('\n') + (endLine < lines.length ? '\n' : '');

        pushFallbackUndoSnapshot(createFallbackSnapshot(fallbackTextarea));
        fallbackRedoStack = [];
        fallbackTextarea.value = value.slice(0, startIndex) + replacementText + value.slice(endIndex);

        const selectionStart = getIndexFromLineAndColumn(fallbackTextarea.value, startLine, 1);
        const selectionEndLine = startLine + Math.max(newLines.length - 1, 0);
        const selectionEnd = getIndexFromLineAndColumn(
            fallbackTextarea.value,
            selectionEndLine,
            (newLines[newLines.length - 1] || '').length + 1
        );

        fallbackTextarea.setSelectionRange(selectionStart, selectionEnd);
        renderFallbackHighlight(fallbackTextarea, fallbackHighlightLayer);
        handleEditorContentChanged();
        return;
    }

    const model = typeof window.editor.getModel === 'function' ? window.editor.getModel() : null;
    if (!model || typeof monaco === 'undefined') return;

    const range = new monaco.Range(
        startLine,
        1,
        endLine,
        model.getLineMaxColumn(endLine)
    );

    window.editor.pushUndoStop();
    window.editor.executeEdits('todo-lines', [{
        range,
        text: newLines.join('\n')
    }]);

    const selectionEndLine = startLine + Math.max(newLines.length - 1, 0);
    const selectionEndColumn = (newLines[newLines.length - 1] || '').length + 1;

    if (typeof window.editor.setSelection === 'function') {
        window.editor.setSelection(new monaco.Range(startLine, 1, selectionEndLine, selectionEndColumn));
    }

    window.editor.pushUndoStop();
}

function normalizeLineAsTodo(line, checked = false) {
    const taskMatch = line.match(/^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
        return `${taskMatch[1]}${taskMatch[3] || ''}`;
    }

    const bulletMatch = line.match(/^(\s*)(?:[-+*]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
        return `${bulletMatch[1]}- [${checked ? 'x' : ' '}] ${bulletMatch[2] || ''}`;
    }

    const indentMatch = line.match(/^(\s*)(.*)$/);
    const indent = indentMatch ? indentMatch[1] : '';
    const content = indentMatch ? indentMatch[2] : line;

    if (!content.trim()) {
        return `${indent}- [${checked ? 'x' : ' '}] `;
    }

    return `${indent}- [${checked ? 'x' : ' '}] ${content.trimStart()}`;
}

function updateBundleStatus(folderPath) {
    window.currentPath = folderPath || null;
    if (window.editor && typeof window.editor.setBundlePath === 'function') {
        window.editor.setBundlePath(window.currentPath);
    }
    updateAddressBar(window.currentPath);
    updateWindowTitle();
}

function loadBundleContent(folderPath, content) {
    openTabWithContent(folderPath, content);
}

function ensureBundleStructure(folderPath) {
    if (fs.existsSync(folderPath) && !fs.statSync(folderPath).isDirectory()) {
        throw new Error("目标路径已存在同名文件，请换一个名称或先删除该文件。");
    }

    ensureDirectory(folderPath);
    ensureDirectory(path.join(folderPath, 'assets'));
    ensureDirectory(path.join(folderPath, 'attachments'));
}

function saveBundleSnapshotToPath(folderPath, markdown, sourceBundlePath = window.currentPath) {
    ensureBundleStructure(folderPath);

    const assetsDir = path.join(folderPath, 'assets');
    const attachmentsDir = path.join(folderPath, 'attachments');

    removeDirectoryIfExists(assetsDir);
    removeDirectoryIfExists(attachmentsDir);
    ensureDirectory(assetsDir);
    ensureDirectory(attachmentsDir);

    if (sourceBundlePath && fs.existsSync(sourceBundlePath)) {
        copyNamedEntries(
            path.join(sourceBundlePath, 'assets'),
            assetsDir,
            getUsedImageEntries(markdown)
        );
        copyNamedEntries(
            path.join(sourceBundlePath, 'attachments'),
            attachmentsDir,
            getUsedAttachmentEntries(markdown, {
                preferEditorState: Boolean(
                    sourceBundlePath
                    && window.currentPath
                    && path.resolve(sourceBundlePath) === path.resolve(window.currentPath)
                )
            })
        );
    }

    const preferredFileName = sourceBundlePath ? getBundleMarkdownFileName(sourceBundlePath) : 'text.markdown';
    const markdownFilePath = resolveBundleMarkdownFilePath(folderPath, {
        preferredName: preferredFileName,
        createIfMissing: true
    });
    fs.writeFileSync(markdownFilePath, markdown, 'utf-8');
}

function getDefaultSaveAsPath() {
    if (window.currentPath) {
        return path.basename(window.currentPath);
    }

    return '我的文档.textbundle';
}

function isMarkdownFilePath(filePath) {
    return /\.(md|markdown|mdown|mkd)$/i.test(String(filePath || ''));
}

function listMarkdownFilesRecursively(folderPath, results = []) {
    if (!fs.existsSync(folderPath)) return results;

    for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
        if (entry.name.startsWith('.')) continue;

        const fullPath = path.join(folderPath, entry.name);
        if (entry.isDirectory()) {
            listMarkdownFilesRecursively(fullPath, results);
            continue;
        }

        if (entry.isFile() && isMarkdownFilePath(entry.name)) {
            results.push(fullPath);
        }
    }

    return results;
}

function generateUniqueBundlePathInDirectory(targetDir, baseName, reservedPaths = null) {
    const sanitizedBaseName = (baseName || '未命名文档').replace(/\.textbundle$/i, '');
    let candidateName = `${sanitizedBaseName}.textbundle`;
    let counter = 2;
    let candidatePath = path.join(targetDir, candidateName);

    while (fs.existsSync(candidatePath) || (reservedPaths && reservedPaths.has(path.resolve(candidatePath)))) {
        candidateName = `${sanitizedBaseName} ${counter}.textbundle`;
        candidatePath = path.join(targetDir, candidateName);
        counter++;
    }

    return candidatePath;
}

function isExternalHref(href) {
    return /^(?:[a-zA-Z][a-zA-Z\d+.-]*:|#|\/\/)/.test(String(href || '').trim());
}

function stripMarkdownAngleBrackets(href) {
    const value = String(href || '').trim();
    if (value.startsWith('<') && value.endsWith('>')) {
        return value.slice(1, -1).trim();
    }
    return value;
}

function normalizeImportSourceRef(href) {
    const parsed = parseMarkdownLinkDestinationForImport(href);
    const rawHref = stripMarkdownAngleBrackets(parsed?.href || href);
    if (!rawHref || isExternalHref(rawHref)) {
        return null;
    }

    const decoded = safeDecodeUri(rawHref);
    if (!decoded || path.isAbsolute(decoded)) {
        return null;
    }

    return decoded.replace(/\\/g, '/');
}

function ensureImportedEntryCopy(sourcePath, targetRootDir, relativeSubPath, copiedEntries, options = {}) {
    const normalizedSourcePath = path.resolve(sourcePath);
    const normalizedRelativeSubPath = relativeSubPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const { flatten = false } = options;

    if (!copiedEntries.has(normalizedSourcePath)) {
        const targetRelativePath = flatten
            ? generateUniqueEntryName(targetRootDir, path.basename(normalizedRelativeSubPath))
            : normalizedRelativeSubPath;
        const targetPath = path.join(targetRootDir, targetRelativePath);
        ensureDirectory(path.dirname(targetPath));
        copyPathRecursive(normalizedSourcePath, targetPath);
        copiedEntries.set(normalizedSourcePath, targetRelativePath);
    }

    return copiedEntries.get(normalizedSourcePath);
}

function transformImportedMarkdown(content, context) {
    const {
        sourceFilePath,
        sourceRootPath,
        bundlePath,
        bundlePathMap,
        copiedAssets,
        copiedAttachments
    } = context;

    const sourceDir = path.dirname(sourceFilePath);
    const bundleAssetsDir = path.join(bundlePath, 'assets');
    const bundleAttachmentsDir = path.join(bundlePath, 'attachments');

    const rewriteLocalHref = (href, options = {}) => {
        const normalizedRef = normalizeImportSourceRef(href);
        if (!normalizedRef) {
            return href;
        }

        const resolvedSourcePath = path.resolve(sourceDir, normalizedRef);
        if (!resolvedSourcePath.startsWith(path.resolve(sourceRootPath)) || !fs.existsSync(resolvedSourcePath)) {
            return href;
        }

        const stat = fs.statSync(resolvedSourcePath);
        if (!stat.isDirectory() && isMarkdownFilePath(resolvedSourcePath)) {
            const linkedBundlePath = bundlePathMap.get(path.resolve(resolvedSourcePath));
            if (!linkedBundlePath) {
                return href;
            }

            return toMarkdownRelativeLink(path.relative(bundlePath, linkedBundlePath));
        }

        const normalizedRefPath = normalizedRef.replace(/^\.?\//, '').replace(/^\/+/, '');
        if (!stat.isDirectory() && isImageFilePath(resolvedSourcePath)) {
            const targetRelativePath = ensureImportedEntryCopy(
                resolvedSourcePath,
                bundleAssetsDir,
                normalizedRefPath,
                copiedAssets,
                { flatten: true }
            );
            return toMarkdownRelativeLink(path.join('assets', targetRelativePath));
        }

        const targetRelativePath = ensureImportedEntryCopy(
            resolvedSourcePath,
            bundleAttachmentsDir,
            normalizedRefPath,
            copiedAttachments,
            { flatten: true }
        );
        return toMarkdownRelativeLink(path.join('attachments', targetRelativePath));
    };

    let nextContent = String(content || '');
    const markdownImageRegex = /!\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;
    const markdownLinkRegex = /(^|[^!])\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;

    nextContent = nextContent.replace(markdownImageRegex, (match, alt, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = rewriteLocalHref(parsed?.href || destination, { image: true });
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `![${alt}](${nextDestination})`;
    });

    nextContent = nextContent.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi, (match, before, quote, src, after) => {
        const nextSrc = rewriteLocalHref(src, { image: true });
        return `<img${before}src=${quote}${nextSrc}${quote}${after}>`;
    });

    nextContent = nextContent.replace(markdownLinkRegex, (match, prefix, label, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = rewriteLocalHref(parsed?.href || destination);
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `${prefix}[${label}](${nextDestination})`;
    });

    return nextContent;
}

function ensureNormalizedBundleEntry(sourcePath, targetDir, copiedEntries) {
    const normalizedSourcePath = path.resolve(sourcePath);
    const relativeToTargetDir = path.relative(targetDir, normalizedSourcePath);
    const isAlreadyInTargetRoot = (
        relativeToTargetDir
        && !relativeToTargetDir.startsWith('..')
        && !path.isAbsolute(relativeToTargetDir)
        && !relativeToTargetDir.includes(path.sep)
    );

    if (copiedEntries.has(normalizedSourcePath)) {
        return copiedEntries.get(normalizedSourcePath);
    }

    if (isAlreadyInTargetRoot) {
        copiedEntries.set(normalizedSourcePath, relativeToTargetDir.replace(/\\/g, '/'));
        return copiedEntries.get(normalizedSourcePath);
    }

    const targetEntryName = generateUniqueEntryName(targetDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(targetDir, targetEntryName);
    ensureDirectory(path.dirname(targetPath));

    if (normalizedSourcePath !== targetPath) {
        fs.renameSync(normalizedSourcePath, targetPath);
    }

    copiedEntries.set(normalizedSourcePath, targetEntryName);
    return targetEntryName;
}

async function ensureNormalizedBundleEntryAsync(sourcePath, targetDir, copiedEntries) {
    const normalizedSourcePath = path.resolve(sourcePath);
    const relativeToTargetDir = path.relative(targetDir, normalizedSourcePath);
    const isAlreadyInTargetRoot = (
        relativeToTargetDir
        && !relativeToTargetDir.startsWith('..')
        && !path.isAbsolute(relativeToTargetDir)
        && !relativeToTargetDir.includes(path.sep)
    );

    if (copiedEntries.has(normalizedSourcePath)) {
        return copiedEntries.get(normalizedSourcePath);
    }

    if (isAlreadyInTargetRoot) {
        copiedEntries.set(normalizedSourcePath, relativeToTargetDir.replace(/\\/g, '/'));
        return copiedEntries.get(normalizedSourcePath);
    }

    const targetEntryName = generateUniqueEntryName(targetDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(targetDir, targetEntryName);
    ensureDirectory(path.dirname(targetPath));

    if (normalizedSourcePath !== targetPath) {
        await fs.promises.rename(normalizedSourcePath, targetPath);
    }

    copiedEntries.set(normalizedSourcePath, targetEntryName);
    await yieldToUiFrame();
    return targetEntryName;
}

async function replaceWithAsync(input, regex, replacer) {
    const globalRegex = regex.global ? regex : new RegExp(regex.source, `${regex.flags}g`);
    let lastIndex = 0;
    let result = '';
    let match;

    while ((match = globalRegex.exec(input)) !== null) {
        result += input.slice(lastIndex, match.index);
        result += await replacer(...match);
        lastIndex = globalRegex.lastIndex;
    }

    result += input.slice(lastIndex);
    return result;
}

function normalizeBundleToKangarooFormat(bundlePath) {
    const normalizedBundlePath = path.resolve(bundlePath);
    ensureBundleStructure(normalizedBundlePath);

    const resolvedMarkdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath);
    if (!resolvedMarkdownPath) {
        throw new Error('所选文件夹缺少 text.markdown 或 text.md，不是有效的 TextBundle。');
    }

    const standardMarkdownPath = path.join(normalizedBundlePath, 'text.markdown');
    if (path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        fs.renameSync(resolvedMarkdownPath, standardMarkdownPath);
    }

    const assetsDir = path.join(normalizedBundlePath, 'assets');
    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const movedAssets = new Map();
    const movedAttachments = new Map();
    const sourceDir = path.dirname(standardMarkdownPath);
    const rawContent = fs.readFileSync(standardMarkdownPath, 'utf-8');

    const rewriteLocalHref = (href) => {
        const normalizedRef = normalizeImportSourceRef(href);
        if (!normalizedRef) {
            return href;
        }

        const resolvedSourcePath = path.resolve(sourceDir, normalizedRef);
        if (!resolvedSourcePath.startsWith(normalizedBundlePath) || !fs.existsSync(resolvedSourcePath)) {
            return href;
        }

        const stat = fs.statSync(resolvedSourcePath);
        if (!stat.isDirectory() && isImageFilePath(resolvedSourcePath)) {
            const targetEntryName = ensureNormalizedBundleEntry(resolvedSourcePath, assetsDir, movedAssets);
            return toMarkdownRelativeLink(path.join('assets', targetEntryName));
        }

        const targetEntryName = ensureNormalizedBundleEntry(resolvedSourcePath, attachmentsDir, movedAttachments);
        return toMarkdownRelativeLink(path.join('attachments', targetEntryName));
    };

    let nextContent = String(rawContent || '');
    const markdownImageRegex = /!\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;
    const markdownLinkRegex = /(^|[^!])\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;

    nextContent = nextContent.replace(markdownImageRegex, (match, alt, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = rewriteLocalHref(parsed?.href || destination);
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `![${alt}](${nextDestination})`;
    });

    nextContent = nextContent.replace(/<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi, (match, before, quote, src, after) => {
        const nextSrc = rewriteLocalHref(src);
        return `<img${before}src=${quote}${nextSrc}${quote}${after}>`;
    });

    nextContent = nextContent.replace(markdownLinkRegex, (match, prefix, label, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = rewriteLocalHref(parsed?.href || destination);
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `${prefix}[${label}](${nextDestination})`;
    });

    if (nextContent !== rawContent || path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        fs.writeFileSync(standardMarkdownPath, nextContent, 'utf-8');
    }

    return {
        markdownPath: standardMarkdownPath,
        content: nextContent
    };
}

async function normalizeBundleToKangarooFormatAsync(bundlePath) {
    const normalizedBundlePath = path.resolve(bundlePath);
    ensureBundleStructure(normalizedBundlePath);
    await yieldToUiFrame();

    const resolvedMarkdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath);
    if (!resolvedMarkdownPath) {
        throw new Error('所选文件夹缺少 text.markdown 或 text.md，不是有效的 TextBundle。');
    }

    const standardMarkdownPath = path.join(normalizedBundlePath, 'text.markdown');
    if (path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        await fs.promises.rename(resolvedMarkdownPath, standardMarkdownPath);
    }

    const assetsDir = path.join(normalizedBundlePath, 'assets');
    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const movedAssets = new Map();
    const movedAttachments = new Map();
    const sourceDir = path.dirname(standardMarkdownPath);
    const rawContent = await fs.promises.readFile(standardMarkdownPath, 'utf-8');

    const rewriteLocalHref = async (href) => {
        const normalizedRef = normalizeImportSourceRef(href);
        if (!normalizedRef) {
            return href;
        }

        const resolvedSourcePath = path.resolve(sourceDir, normalizedRef);
        if (!resolvedSourcePath.startsWith(normalizedBundlePath) || !fs.existsSync(resolvedSourcePath)) {
            return href;
        }

        const stat = await fs.promises.stat(resolvedSourcePath);
        if (!stat.isDirectory() && isImageFilePath(resolvedSourcePath)) {
            const targetEntryName = await ensureNormalizedBundleEntryAsync(resolvedSourcePath, assetsDir, movedAssets);
            return toMarkdownRelativeLink(path.join('assets', targetEntryName));
        }

        const targetEntryName = await ensureNormalizedBundleEntryAsync(resolvedSourcePath, attachmentsDir, movedAttachments);
        return toMarkdownRelativeLink(path.join('attachments', targetEntryName));
    };

    let nextContent = String(rawContent || '');

    const markdownImageRegexAsync = /!\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;
    const markdownLinkRegexAsync = /(^|[^!])\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;

    nextContent = await replaceWithAsync(nextContent, markdownImageRegexAsync, async (match, alt, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = await rewriteLocalHref(parsed?.href || destination);
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `![${alt}](${nextDestination})`;
    });
    await yieldToUiFrame();

    nextContent = await replaceWithAsync(nextContent, /<img\b([^>]*?)\bsrc\s*=\s*(["'])(.*?)\2([^>]*)>/gi, async (match, before, quote, src, after) => {
        const nextSrc = await rewriteLocalHref(src);
        return `<img${before}src=${quote}${nextSrc}${quote}${after}>`;
    });
    await yieldToUiFrame();

    nextContent = await replaceWithAsync(nextContent, markdownLinkRegexAsync, async (match, prefix, label, destination) => {
        const parsed = parseMarkdownLinkDestinationForImport(destination);
        const nextHref = await rewriteLocalHref(parsed?.href || destination);
        const nextDestination = composeMarkdownLinkDestinationForImport(nextHref, parsed?.title || '');
        return `${prefix}[${label}](${nextDestination})`;
    });

    if (nextContent !== rawContent || path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        await fs.promises.writeFile(standardMarkdownPath, nextContent, 'utf-8');
    }

    return {
        markdownPath: standardMarkdownPath,
        content: nextContent
    };
}

async function importMarkdownFolderToTarget(sourceRootPath, targetRootPath) {
    const normalizedSourceRoot = path.resolve(sourceRootPath);
    const normalizedTargetRoot = path.resolve(targetRootPath);
    const markdownFiles = listMarkdownFilesRecursively(normalizedSourceRoot);

    if (!markdownFiles.length) {
        throw new Error('所选文件夹中没有找到 Markdown 文件。');
    }

    ensureDirectory(normalizedTargetRoot);

    const bundlePathMap = new Map();
    const reservedBundlePaths = new Set();
    for (const markdownFilePath of markdownFiles) {
        const relativeDir = path.relative(normalizedSourceRoot, path.dirname(markdownFilePath));
        const targetDir = path.join(normalizedTargetRoot, relativeDir);
        ensureDirectory(targetDir);

        const bundlePath = generateUniqueBundlePathInDirectory(
            targetDir,
            path.basename(markdownFilePath, path.extname(markdownFilePath)),
            reservedBundlePaths
        );
        bundlePathMap.set(path.resolve(markdownFilePath), bundlePath);
        reservedBundlePaths.add(path.resolve(bundlePath));
    }

    const importedBundlePaths = [];

    for (const markdownFilePath of markdownFiles) {
        const bundlePath = bundlePathMap.get(path.resolve(markdownFilePath));
        const rawContent = fs.readFileSync(markdownFilePath, 'utf-8');
        const transformedContent = transformImportedMarkdown(rawContent, {
            sourceFilePath: markdownFilePath,
            sourceRootPath: normalizedSourceRoot,
            bundlePath,
            bundlePathMap,
            copiedAssets: new Map(),
            copiedAttachments: new Map()
        });

        ensureBundleStructure(bundlePath);
        fs.writeFileSync(path.join(bundlePath, 'text.markdown'), transformedContent, 'utf-8');
        importedBundlePaths.push(bundlePath);
    }

    return importedBundlePaths;
}

async function handleOpenBundle() {
    try {
        const folderPath = await ipcRenderer.invoke('dialog:openBundle');

        if (folderPath) {
            await waitForEditorReady();
            const normalized = await normalizeBundleToKangarooFormatAsync(folderPath);
            loadBundleContent(folderPath, normalized.content);
        }
    } catch (err) {
        alert("打开失败: " + err.message);
    }
}

async function handleOpenWorkspaceFolder() {
    try {
        const folderPath = await ipcRenderer.invoke('dialog:openWorkspaceFolder');
        if (!folderPath) return;

        setWorkspaceRoot(folderPath);
        setSidebarTab('workspace');
    } catch (error) {
        alert(`打开文件夹失败: ${error.message}`);
    }
}

function handleCloseWorkspaceFolder() {
    setWorkspaceRoot(null);
    setSidebarTab('workspace');
}

async function handleImportMarkdownFolder() {
    try {
        const sourceFolderPath = await ipcRenderer.invoke('dialog:selectMarkdownImportSource');
        if (!sourceFolderPath) return;

        const targetFolderPath = await ipcRenderer.invoke('dialog:selectMarkdownImportTarget', {
            defaultPath: workspaceRootPath || sourceFolderPath
        });
        if (!targetFolderPath) return;

        const importedBundlePaths = await importMarkdownFolderToTarget(sourceFolderPath, targetFolderPath);

        if (workspaceRootPath && path.resolve(targetFolderPath).startsWith(path.resolve(workspaceRootPath))) {
            renderWorkspaceTree();
            setSidebarTab('workspace');
        }

        if (importedBundlePaths.length === 1) {
            const importedContent = fs.readFileSync(resolveBundleMarkdownFilePath(importedBundlePaths[0]), 'utf-8');
            loadBundleContent(importedBundlePaths[0], importedContent);
            alert(`导入完成：已导入 1 个 Markdown 文档。`);
            return;
        }

        alert(`导入完成：已导入 ${importedBundlePaths.length} 个 Markdown 文档。`);
    } catch (error) {
        alert(`导入 Markdown 文件夹失败: ${error.message}`);
    }
}

async function handleNewBundleInWorkspace() {
    await createBundleInWorkspace(workspaceRootPath);
}

async function openBundleFromExternalPath(folderPath, options = {}) {
    try {
        const normalizedPath = path.resolve(folderPath);
        await waitForEditorReady();
        const normalized = await normalizeBundleToKangarooFormatAsync(normalizedPath);
        loadBundleContent(normalizedPath, normalized.content);
        ipcRenderer.send('bundle:clearPendingOpen', normalizedPath);
    } catch (err) {
        alert(`打开失败: ${err.message}`);
    }
}

async function handleNewBundle() {
    try {
        const folderPath = await ipcRenderer.invoke('dialog:createBundle');

        if (folderPath) {
            await waitForEditorReady();
            ensureBundleStructure(folderPath);

            const initialContent = "# 新建文档\n\n在此开始编写内容...";
            fs.writeFileSync(path.join(folderPath, 'text.markdown'), initialContent, 'utf-8');
            loadBundleContent(folderPath, initialContent);
        }
    } catch (err) {
        alert("创建失败: " + err.message);
    }
}

async function handleSaveAs() {
    try {
        if (!ensureEditorReady()) return false;

        const targetPath = await ipcRenderer.invoke('dialog:saveBundleAs', {
            defaultPath: getDefaultSaveAsPath()
        });

        if (!targetPath) return false;

        const normalizedTargetPath = path.resolve(targetPath);
        const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
        if (currentBundlePath && normalizedTargetPath === currentBundlePath) {
            return await saveFile();
        }

        const markdown = window.editor.getValue();
        saveBundleSnapshotToPath(normalizedTargetPath, markdown, window.currentPath);
        window.currentPath = normalizedTargetPath;
        preservedUnusedAttachmentEntries.clear();
        updateBundleStatus(normalizedTargetPath);
        setDirty(false);
        updatePreview();
        updateOutline();
        const activeTab = getActiveTab();
        if (activeTab) {
            activeTab.path = normalizedTargetPath;
            activeTab.content = markdown;
            activeTab.isDirty = false;
            activeTab.preservedEntries = [];
            renderEditorTabs();
        }
        return true;
    } catch (error) {
        alert(`另存为失败: ${error.message}`);
        return false;
    }
}

function getDefaultExportHtmlPath(tab) {
    const exportTitle = getTabTitle(tab) || '未命名文档';

    if (tab?.path) {
        return path.join(path.dirname(tab.path), `${exportTitle}.html`);
    }

    return `${exportTitle}.html`;
}

function getTabMarkdownContent(tabId = activeTabId) {
    if (!window.editor) {
        return '';
    }

    if (tabId === activeTabId) {
        persistActiveTabState();
    }

    return getTabById(tabId)?.content || '';
}

function getBundleResourceType(href) {
    const normalizedHref = safeDecodeUri(String(href || '').trim())
        .replace(/^<|>$/g, '')
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/^\/+/, '');

    if (!normalizedHref) return '';
    if (normalizedHref.startsWith('attachments/')) return 'attachment';
    if (normalizedHref.startsWith('assets/')) return 'asset';
    return '';
}

function getEmbeddedImageMimeType(filePath) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    const mimeMap = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.bmp': 'image/bmp',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.tif': 'image/tiff',
        '.tiff': 'image/tiff',
        '.heic': 'image/heic'
    };

    return mimeMap[ext] || 'application/octet-stream';
}

function resolveExportAssetPath(sourceRef, bundlePath) {
    const normalizedSource = safeDecodeUri(String(sourceRef || '').trim()).replace(/^<|>$/g, '');
    if (!normalizedSource) return '';

    if (/^file:/i.test(normalizedSource)) {
        try {
            return url.fileURLToPath(normalizedSource);
        } catch {
            return '';
        }
    }

    if (path.isAbsolute(normalizedSource)) {
        return normalizedSource;
    }

    if (!bundlePath) {
        return '';
    }

    return path.resolve(bundlePath, normalizedSource);
}

function buildEmbeddedImageDataUrl(sourceRef, bundlePath) {
    const assetPath = resolveExportAssetPath(sourceRef, bundlePath);
    if (!assetPath || !fs.existsSync(assetPath) || !isImageFilePath(assetPath)) {
        return '';
    }

    const mimeType = getEmbeddedImageMimeType(assetPath);
    const encoded = fs.readFileSync(assetPath).toString('base64');
    return `data:${mimeType};base64,${encoded}`;
}

function buildExportOmittedImageHtml(tag, resourcePath) {
    const alt = extractHtmlAttribute(tag, 'alt') || path.basename(resourcePath || '') || '图片';
    const label = escapeHtml(alt);
    const detail = resourcePath ? `<div class="export-omitted-path">${escapeHtml(resourcePath)}</div>` : '';

    return `
        <figure class="export-omitted export-omitted-image">
            <div class="export-omitted-badge">图片未导出</div>
            <figcaption>${label}${detail}</figcaption>
        </figure>
    `;
}

function stripPreviewOnlyExportArtifacts(html) {
    return String(html || '')
        .replace(/\sdata-source-line(?:-end)?="[^"]*"/g, '')
        .replace(/\sdata-task-line="[^"]*"/g, '')
        .replace(/\sdata-preview-image-(?:path|src)="[^"]*"/g, '')
        .replace(/\sdata-preview-source-line="[^"]*"/g, '');
}

function transformRenderedHtmlForExport(renderedHtml, options = {}) {
    const bundlePath = options.bundlePath || '';
    let nextHtml = stripPreviewOnlyExportArtifacts(renderedHtml);

    nextHtml = nextHtml.replace(/<img\b[^>]*>/gi, (tag) => {
        const src = extractHtmlAttribute(tag, 'src') || '';
        const resourceType = getBundleResourceType(src);
        if (resourceType !== 'asset') {
            return tag;
        }

        const embeddedSrc = buildEmbeddedImageDataUrl(src, bundlePath);
        if (!embeddedSrc) {
            return buildExportOmittedImageHtml(tag, safeDecodeUri(src));
        }

        return setOrReplaceHtmlAttribute(tag, 'src', embeddedSrc);
    });

    nextHtml = nextHtml.replace(/<a\b([^>]*?)href=(?:"([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi, (match, beforeHref, hrefA, hrefB, hrefC, afterHref, innerHtml) => {
        const href = hrefA || hrefB || hrefC || '';
        const resourceType = getBundleResourceType(href);
        if (!resourceType) {
            return match;
        }

        if (resourceType === 'asset') {
            return match;
        }

        const badge = '附件未导出';
        return `
            <span class="export-inline-resource export-inline-resource-${resourceType}" title="${escapeHtmlAttribute(safeDecodeUri(href))}">
                <span class="export-inline-resource-label">${innerHtml || escapeHtml(safeDecodeUri(href))}</span>
                <span class="export-inline-resource-badge">${badge}</span>
            </span>
        `;
    });

    return nextHtml;
}

function buildSingleFileHtmlExport(markdown, options = {}) {
    const title = options.title || '未命名文档';
    const renderedHtml = getMarkdownRenderer().render(markdown || '');
    const bodyHtml = transformRenderedHtmlForExport(renderedHtml, {
        bundlePath: options.bundlePath || ''
    });

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <style>
        :root {
            color-scheme: light;
            --page-bg: #f4efe7;
            --paper-bg: #fffdf8;
            --paper-border: rgba(120, 92, 56, 0.14);
            --text: #2f261d;
            --text-soft: #6d5f51;
            --heading: #1f1914;
            --link: #b15d1a;
            --link-hover: #8e470f;
            --divider: rgba(47, 38, 29, 0.12);
            --code-bg: rgba(55, 41, 27, 0.07);
            --pre-bg: #2a221c;
            --pre-text: #f7efe5;
            --blockquote-border: rgba(177, 93, 26, 0.35);
            --blockquote-bg: rgba(177, 93, 26, 0.06);
            --tag-bg: rgba(177, 93, 26, 0.08);
            --tag-border: rgba(177, 93, 26, 0.16);
        }

        * { box-sizing: border-box; }
        html, body { margin: 0; padding: 0; }
        body {
            background:
                radial-gradient(circle at top left, rgba(255, 205, 142, 0.14), transparent 32%),
                radial-gradient(circle at top right, rgba(197, 226, 190, 0.12), transparent 30%),
                linear-gradient(180deg, #f7f2ea 0%, var(--page-bg) 100%);
            color: var(--text);
            font: 17px/1.72 "Charter", "Palatino Linotype", "Songti SC", serif;
            padding: 40px 24px 56px;
        }

        .export-page {
            max-width: 860px;
            margin: 0 auto;
            background: var(--paper-bg);
            border: 1px solid var(--paper-border);
            border-radius: 24px;
            box-shadow: 0 22px 64px rgba(53, 39, 26, 0.12);
            padding: 42px 52px 56px;
        }

        .export-header {
            margin-bottom: 30px;
            padding-bottom: 18px;
            border-bottom: 1px solid var(--divider);
        }

        .export-title {
            margin: 0;
            font-size: 34px;
            line-height: 1.18;
            color: var(--heading);
        }

        .export-meta {
            margin-top: 10px;
            color: var(--text-soft);
            font-size: 13px;
            font-family: "SF Pro Display", "PingFang SC", sans-serif;
        }

        .export-content > *:first-child { margin-top: 0; }
        .export-content h1,
        .export-content h2,
        .export-content h3,
        .export-content h4,
        .export-content h5,
        .export-content h6 {
            color: var(--heading);
            margin: 1.4em 0 0.55em;
            line-height: 1.22;
        }

        .export-content h1 { font-size: 2.1em; }
        .export-content h2 { font-size: 1.62em; }
        .export-content h3 { font-size: 1.3em; }
        .export-content p,
        .export-content ul,
        .export-content ol,
        .export-content blockquote,
        .export-content pre,
        .export-content table {
            margin: 0 0 1.05em;
        }

        .export-content a {
            color: var(--link);
            text-decoration: none;
            border-bottom: 1px solid rgba(177, 93, 26, 0.28);
        }

        .export-content a:hover {
            color: var(--link-hover);
            border-bottom-color: rgba(142, 71, 15, 0.42);
        }

        .export-content hr {
            border: none;
            border-top: 1px solid var(--divider);
            margin: 1.8em 0;
        }

        .export-content blockquote {
            padding: 0.9em 1.1em;
            border-left: 4px solid var(--blockquote-border);
            background: var(--blockquote-bg);
            border-radius: 0 14px 14px 0;
            color: var(--text-soft);
        }

        .export-content code {
            background: var(--code-bg);
            padding: 0.16em 0.42em;
            border-radius: 7px;
            font-size: 0.92em;
            font-family: "SF Mono", "JetBrains Mono", monospace;
        }

        .export-content pre {
            background: var(--pre-bg);
            color: var(--pre-text);
            padding: 1em 1.08em;
            border-radius: 16px;
            overflow: auto;
        }

        .export-content pre code {
            background: transparent;
            padding: 0;
            color: inherit;
        }

        .export-content img {
            max-width: 100%;
            height: auto;
            border-radius: 14px;
            box-shadow: 0 14px 34px rgba(43, 32, 22, 0.12);
        }

        .export-content table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
            border-radius: 14px;
            border: 1px solid var(--divider);
        }

        .export-content th,
        .export-content td {
            border-bottom: 1px solid var(--divider);
            padding: 10px 12px;
            text-align: left;
        }

        .export-inline-resource,
        .export-omitted {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            padding: 0.28em 0.72em;
            border-radius: 999px;
            background: var(--tag-bg);
            border: 1px solid var(--tag-border);
            color: var(--text-soft);
            font-family: "SF Pro Display", "PingFang SC", sans-serif;
            font-size: 0.92em;
        }

        .export-omitted {
            display: block;
            margin: 1em 0;
            border-radius: 18px;
            padding: 1em 1.05em;
        }

        .export-omitted-badge,
        .export-inline-resource-badge {
            background: rgba(177, 93, 26, 0.12);
            color: var(--link);
            border-radius: 999px;
            padding: 0.18em 0.56em;
            font-size: 0.84em;
            white-space: nowrap;
        }

        .export-omitted figcaption {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .export-omitted-path {
            font-size: 0.85em;
            color: var(--text-soft);
            word-break: break-all;
        }
    </style>
</head>
<body>
    <main class="export-page">
        <header class="export-header">
            <h1 class="export-title">${escapeHtml(title)}</h1>
            <div class="export-meta">由 Kangaroo 导出为单个 HTML 文件</div>
        </header>
        <article class="export-content">
            ${bodyHtml}
        </article>
    </main>
</body>
</html>`;
}

async function handleExportHtml(tabId = activeTabId) {
    try {
        if (!ensureEditorReady()) return false;

        const tab = getTabById(tabId);
        if (!tab) return false;

        const markdown = getTabMarkdownContent(tabId);
        const targetPath = await ipcRenderer.invoke('dialog:saveHtmlExport', {
            defaultPath: getDefaultExportHtmlPath(tab)
        });

        if (!targetPath) return false;

        const html = buildSingleFileHtmlExport(markdown, {
            title: getTabTitle(tab),
            bundlePath: tab.path || ''
        });

        fs.writeFileSync(targetPath, html, 'utf-8');
        return true;
    } catch (error) {
        alert(`导出 HTML 失败: ${error.message}`);
        return false;
    }
}

function toggleSelectedLinesAsTodo() {
    if (window.editor && typeof window.editor.toggleTodoSelection === 'function') {
        const didToggle = window.editor.toggleTodoSelection();
        if (didToggle) {
            return;
        }
    }

    const { startLine, endLine } = getEditorSelectedLineRange();
    const nextLines = [];

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        nextLines.push(normalizeLineAsTodo(getEditorLineText(lineNumber), false));
    }

    replaceEditorLines(startLine, endLine, nextLines);
}

function updateTaskLineCheckedState(lineNumber, checked) {
    const currentLine = getEditorLineText(lineNumber);
    const taskMatch = currentLine.match(/^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/);
    if (!taskMatch) return;

    replaceEditorLine(
        lineNumber,
        `${taskMatch[1]}${taskMatch[2]} [${checked ? 'x' : ' '}] ${taskMatch[4] || ''}`
    );
}

function setSidebarTab(tab) {
    currentSidebarTab = ['workspace', 'outline', 'todo', 'attachment'].includes(tab) ? tab : 'workspace';

    const workspaceTab = document.getElementById('sidebar-tab-workspace');
    const outlineTab = document.getElementById('sidebar-tab-outline');
    const todoTab = document.getElementById('sidebar-tab-todo');
    const attachmentTab = document.getElementById('sidebar-tab-attachment');
    const workspacePanel = document.getElementById('workspace-panel');
    const outlinePanel = document.getElementById('outline-panel');
    const todoPanel = document.getElementById('todo-panel');
    const attachmentPanel = document.getElementById('attachment-panel');

    if (workspaceTab) {
        workspaceTab.classList.toggle('active', currentSidebarTab === 'workspace');
    }

    if (outlineTab) {
        outlineTab.classList.toggle('active', currentSidebarTab === 'outline');
    }

    if (todoTab) {
        todoTab.classList.toggle('active', currentSidebarTab === 'todo');
    }

    if (attachmentTab) {
        attachmentTab.classList.toggle('active', currentSidebarTab === 'attachment');
    }

    if (workspacePanel) {
        workspacePanel.classList.toggle('active', currentSidebarTab === 'workspace');
    }

    if (outlinePanel) {
        outlinePanel.classList.toggle('active', currentSidebarTab === 'outline');
    }

    if (todoPanel) {
        todoPanel.classList.toggle('active', currentSidebarTab === 'todo');
    }

    if (attachmentPanel) {
        attachmentPanel.classList.toggle('active', currentSidebarTab === 'attachment');
    }
}

function getLineNumberAtOffset(content, offset) {
    if (isUsingFallbackEditor || !window.editor || typeof window.editor.getModel !== 'function') {
        return getPositionAtOffset(content, offset).lineNumber;
    }

    const model = window.editor.getModel();
    if (!model || typeof model.getPositionAt !== 'function') {
        return getPositionAtOffset(content, offset).lineNumber;
    }

    return model.getPositionAt(offset).lineNumber;
}

function getTodoItemsFromContent(content) {
    const todos = [];
    const lines = content.split('\n');

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/);
        if (!match) continue;

        todos.push({
            lineNumber: index + 1,
            checked: match[2].toLowerCase() === 'x',
            text: match[3] || '',
            rawLine: lines[index],
            kindIndex: todos.length
        });
    }

    return todos;
}

function getRelativeWorkspaceFolder(bundlePath) {
    if (!workspaceRootPath || !bundlePath) {
        return '';
    }

    const relativeDir = path.relative(path.resolve(workspaceRootPath), path.dirname(path.resolve(bundlePath)));
    if (!relativeDir || relativeDir === '.') {
        return '';
    }

    return relativeDir.replace(/\\/g, '/');
}

function getDocumentTitleFromBundlePath(bundlePath) {
    if (!bundlePath) return '未命名';
    return path.basename(bundlePath, path.extname(bundlePath)) || '未命名';
}

function getOpenTabByBundlePath(bundlePath) {
    if (!bundlePath) return null;
    const normalizedTarget = path.resolve(bundlePath);
    return editorTabs.find((tab) => tab.path && path.resolve(tab.path) === normalizedTarget) || null;
}

function getMarkdownContentForBundlePath(bundlePath) {
    if (!bundlePath) return '';

    const normalizedTarget = path.resolve(bundlePath);
    if (window.currentPath && path.resolve(window.currentPath) === normalizedTarget && window.editor) {
        persistActiveTabState();
        return window.editor.getValue();
    }

    const openTab = getOpenTabByBundlePath(normalizedTarget);
    if (openTab) {
        return openTab.content || '';
    }

    const markdownPath = resolveBundleMarkdownFilePath(normalizedTarget);
    if (!fs.existsSync(markdownPath)) {
        return '';
    }

    return fs.readFileSync(markdownPath, 'utf-8');
}

function collectWorkspaceBundlePaths(folderPath = workspaceRootPath, result = []) {
    if (!folderPath || !fs.existsSync(folderPath)) {
        return result;
    }

    for (const entry of getWorkspaceChildren(folderPath)) {
        if (entry.isBundle) {
            result.push(entry.path);
            continue;
        }

        if (entry.isDirectory) {
            collectWorkspaceBundlePaths(entry.path, result);
        }
    }

    return result;
}

function buildTodoEntry(todo, bundlePath, documentOrder = 0) {
    const relativeFolder = getRelativeWorkspaceFolder(bundlePath);
    const documentTitle = getDocumentTitleFromBundlePath(bundlePath);
    return {
        ...todo,
        bundlePath,
        documentTitle,
        relativeFolder,
        documentOrder,
        folderSortKey: relativeFolder || '',
        documentSortKey: `${relativeFolder || ''}/${documentTitle}`.toLowerCase()
    };
}

function sortTodoEntries(entries, sortMode = 'position') {
    const items = [...entries];
    if (sortMode === 'status') {
        items.sort((left, right) => {
            if (left.checked !== right.checked) {
                return left.checked ? 1 : -1;
            }
            if (left.documentOrder !== right.documentOrder) {
                return left.documentOrder - right.documentOrder;
            }
            return left.kindIndex - right.kindIndex;
        });
        return items;
    }

    items.sort((left, right) => {
        if (left.documentOrder !== right.documentOrder) {
            return left.documentOrder - right.documentOrder;
        }
        return left.kindIndex - right.kindIndex;
    });
    return items;
}

function getCurrentDocumentTodoEntries(content) {
    const activeTab = getActiveTab();
    const bundlePath = activeTab?.path || window.currentPath || null;
    const todos = window.editor && typeof window.editor.getTodoItems === 'function'
        ? window.editor.getTodoItems()
        : getTodoItemsFromContent(content);

    return todos.map((todo, index) => buildTodoEntry({
        ...todo,
        kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : index
    }, bundlePath, 0));
}

function getWorkspaceTodoEntries() {
    persistActiveTabState();

    const bundlePaths = collectWorkspaceBundlePaths();
    return bundlePaths.flatMap((bundlePath, documentOrder) => {
        const content = getMarkdownContentForBundlePath(bundlePath);
        const todos = getTodoItemsFromContent(content);
        return todos.map((todo, index) => buildTodoEntry({
            ...todo,
            kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : index
        }, bundlePath, documentOrder));
    });
}

function applyTodoPanelFilters(entries) {
    const settings = loadTodoPanelSettings();
    let nextEntries = entries;

    if (settings.hideCompleted) {
        nextEntries = nextEntries.filter((entry) => !entry.checked);
    }

    return sortTodoEntries(nextEntries, settings.sort);
}

function createTodoItemElement(todo, options = {}) {
    const {
        showDocumentMeta = false,
        onOpen = null
    } = options;

    const item = document.createElement('div');
    item.className = `todo-item${todo.checked ? ' done' : ''}`;
    item.dataset.lineNumber = String(todo.lineNumber);
    if (todo.bundlePath) {
        item.dataset.bundlePath = todo.bundlePath;
    }

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'todo-item-checkbox preview-task-checkbox';
    checkbox.checked = todo.checked;
    checkbox.dataset.taskLine = String(todo.lineNumber);
    checkbox.addEventListener('click', async (event) => {
        event.stopPropagation();
        await updateTodoCheckedState(todo, checkbox.checked);
    });

    const body = document.createElement('div');
    body.className = 'todo-item-body';

    const title = document.createElement('div');
    title.className = 'todo-item-title';
    title.innerText = todo.text || '(空的待办)';

    const meta = document.createElement('div');
    meta.className = 'todo-item-meta';
    meta.innerText = showDocumentMeta
        ? `${todo.documentTitle} · 第 ${todo.lineNumber} 行 · ${todo.checked ? '已完成' : '待办'}`
        : `第 ${todo.lineNumber} 行 · ${todo.checked ? '已完成' : '待办'}`;

    body.appendChild(title);
    body.appendChild(meta);
    item.appendChild(checkbox);
    item.appendChild(body);

    item.addEventListener('click', async () => {
        await jumpToTodoEntry(todo);
        if (typeof onOpen === 'function') {
            onOpen(todo);
        }
    });

    return item;
}

async function jumpToTodoEntry(todo) {
    if (!todo) return;

    if (todo.bundlePath) {
        const normalizedTarget = path.resolve(todo.bundlePath);
        const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
        if (currentBundlePath !== normalizedTarget) {
            await openBundleFromExternalPath(normalizedTarget, { skipConfirm: false });
        }
    }

    jumpEditorToAnchor('task', todo.kindIndex, {
        lineNumber: todo.lineNumber,
        preservePreviewScroll: true,
        preferredText: todo.text || '',
        preferredKind: 'task'
    });
}

function updateTodoMarkdownByKindIndex(content, kindIndex, checked) {
    const lines = String(content || '').split('\n');
    let currentTaskIndex = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const match = lines[lineIndex].match(/^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/);
        if (!match) continue;

        if (currentTaskIndex === kindIndex) {
            lines[lineIndex] = `${match[1]}${match[2]} [${checked ? 'x' : ' '}] ${match[4] || ''}`;
            return lines.join('\n');
        }

        currentTaskIndex += 1;
    }

    return content;
}

function saveMarkdownToBundlePath(bundlePath, content) {
    if (!bundlePath) return;
    fs.writeFileSync(resolveBundleMarkdownFilePath(bundlePath, { createIfMissing: true }), content, 'utf-8');
}

async function updateTodoCheckedState(todo, checked) {
    const targetBundlePath = todo?.bundlePath || window.currentPath || null;
    if (!targetBundlePath) return;

    const normalizedTarget = path.resolve(targetBundlePath);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;

    if (currentBundlePath === normalizedTarget && window.editor && typeof window.editor.setTaskCheckedByKindIndex === 'function') {
        const didUpdate = window.editor.setTaskCheckedByKindIndex(todo.kindIndex, checked);
        if (didUpdate) {
            return;
        }
    }

    const openTab = getOpenTabByBundlePath(normalizedTarget);
    if (openTab) {
        const nextContent = updateTodoMarkdownByKindIndex(openTab.content || '', todo.kindIndex, checked);
        openTab.content = nextContent;
        openTab.previousContent = nextContent;
        openTab.isDirty = false;
        openTab.previousIsDirty = false;
        saveMarkdownToBundlePath(normalizedTarget, nextContent);
        if (activeTabId === openTab.id && window.editor) {
            window.editor.setValue(nextContent, { emitChange: true });
        } else {
            renderTodoList(getTabMarkdownContent());
        }
        return;
    }

    const content = getMarkdownContentForBundlePath(normalizedTarget);
    const nextContent = updateTodoMarkdownByKindIndex(content, todo.kindIndex, checked);
    saveMarkdownToBundlePath(normalizedTarget, nextContent);
    renderTodoList(getTabMarkdownContent());
}

function renderTodoList(content) {
    const todoContainer = document.getElementById('todo-container');
    if (!todoContainer) return;

    todoContainer.innerHTML = '';

    const settings = loadTodoPanelSettings();
    const todos = settings.scope === 'workspace'
        ? getWorkspaceTodoEntries()
        : applyTodoPanelFilters(getCurrentDocumentTodoEntries(content));

    if (!todos.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = settings.scope === 'workspace'
            ? '当前工作空间还没有符合条件的待办。'
            : '当前文档还没有待办。按 Cmd+T 就能把当前行变成待办。';
        todoContainer.appendChild(emptyState);
        return;
    }

    if (settings.scope !== 'workspace') {
        for (const todo of todos) {
            todoContainer.appendChild(createTodoItemElement(todo));
        }
        return;
    }

    const filteredWorkspaceTodos = settings.hideCompleted
        ? todos.filter((entry) => !entry.checked)
        : todos;

    const groupedByFolder = new Map();
    for (const todo of filteredWorkspaceTodos) {
        const folderKey = todo.relativeFolder || '';
        if (!groupedByFolder.has(folderKey)) {
            groupedByFolder.set(folderKey, new Map());
        }
        const folderGroup = groupedByFolder.get(folderKey);
        const documentKey = todo.bundlePath || todo.documentTitle;
        if (!folderGroup.has(documentKey)) {
            folderGroup.set(documentKey, {
                documentTitle: todo.documentTitle,
                bundlePath: todo.bundlePath,
                items: []
            });
        }
        folderGroup.get(documentKey).items.push(todo);
    }

    for (const [folderKey, documents] of groupedByFolder.entries()) {
        const group = document.createElement('div');
        group.className = 'todo-group';

        const title = document.createElement('div');
        title.className = 'todo-group-title';
        title.innerText = folderKey || '根目录';
        group.appendChild(title);

        for (const docGroup of documents.values()) {
            const documentGroup = document.createElement('div');
            documentGroup.className = 'todo-document-group';

            const docTitle = document.createElement('div');
            docTitle.className = 'todo-document-title';
            docTitle.innerText = docGroup.documentTitle;
            documentGroup.appendChild(docTitle);

            const docMeta = document.createElement('div');
            docMeta.className = 'todo-document-meta';
            docMeta.innerText = path.basename(docGroup.bundlePath || '');
            documentGroup.appendChild(docMeta);

            const documentItems = sortTodoEntries(docGroup.items, settings.sort);
            for (const todo of documentItems) {
                documentGroup.appendChild(createTodoItemElement(todo, { showDocumentMeta: false }));
            }

            group.appendChild(documentGroup);
        }

        todoContainer.appendChild(group);
    }
}

function syncTodoPanelControls() {
    const settings = loadTodoPanelSettings();
    const scopeSelect = document.getElementById('todo-scope-select');
    const sortSelect = document.getElementById('todo-sort-select');
    const hideCompletedToggle = document.getElementById('todo-hide-completed');

    if (scopeSelect) scopeSelect.value = settings.scope;
    if (sortSelect) sortSelect.value = settings.sort;
    if (hideCompletedToggle) hideCompletedToggle.checked = settings.hideCompleted;
}

function updateTodoPanelSettings(patch = {}) {
    const nextSettings = saveTodoPanelSettings({
        ...loadTodoPanelSettings(),
        ...patch
    });
    syncTodoPanelControls();
    renderTodoList(getTabMarkdownContent());
    return nextSettings;
}

function collectAttachmentMarkdownRefs(content) {
    const references = [];
    const source = String(content || '');
    const patterns = [
        {
            regex: /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?attachments\/(<[^>]+>|[^)\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\)/g,
            read(match) {
                const rawRelativePath = String(match[2] || '').replace(/^<|>$/g, '');
                return {
                    label: unescapeMarkdownLinkLabel(match[1] || ''),
                    relativePath: rawRelativePath
                };
            }
        },
        {
            regex: /<((?:\.?\/)?attachments\/[^>\s]+)>/g,
            read(match) {
                return {
                    label: '',
                    relativePath: String(match[1] || '').replace(/^(?:\.?\/)?attachments\//, '')
                };
            }
        }
    ];

    for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        let match;
        while ((match = pattern.regex.exec(source)) !== null) {
            const parsed = pattern.read(match);
            const relativePath = decodeRelativePathSegments(parsed.relativePath || '').replace(/^\/+/, '');
            if (!relativePath) continue;

            references.push({
                label: parsed.label || '',
                relativePath,
                offset: match.index
            });
        }
    }

    references.sort((a, b) => a.offset - b.offset);
    return references;
}

function getAttachmentReferences(content) {
    const references = [];
    for (const ref of collectAttachmentMarkdownRefs(content)) {
        const label = ref.label || '';
        const relativePath = ref.relativePath;
        const fullRelativePath = path.join('attachments', relativePath);
        const absolutePath = window.currentPath
            ? path.resolve(window.currentPath, fullRelativePath)
            : path.resolve(fullRelativePath);
        const lineNumber = getLineNumberAtOffset(content, ref.offset);

        let stat = null;
        try {
            stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
        } catch {
            stat = null;
        }

        references.push({
            label: label || path.basename(relativePath),
            relativePath: fullRelativePath,
            absolutePath,
            lineNumber,
            exists: Boolean(stat),
            isDirectory: Boolean(stat && stat.isDirectory())
        });
    }

    return references;
}

function getAttachmentTreeChildren(targetPath, depth = 0) {
    if (depth > 4 || !fs.existsSync(targetPath)) {
        return [];
    }

    const entries = fs.readdirSync(targetPath, { withFileTypes: true })
        .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name, 'zh-Hans-CN');
        });

    return entries.map((entry) => {
        const absolutePath = path.join(targetPath, entry.name);
        return {
            name: entry.name,
            absolutePath,
            isDirectory: entry.isDirectory(),
            children: entry.isDirectory() ? getAttachmentTreeChildren(absolutePath, depth + 1) : []
        };
    });
}

function renderAttachmentChildTree(children, container, referenceLineNumber, referenceIndex, referenceLabel = '') {
    for (const child of children) {
        const item = document.createElement('div');
        item.className = `attachment-child${child.isDirectory ? ' folder' : ''}`;
        item.innerText = `${child.isDirectory ? '▸ ' : ''}${child.name}`;
        item.addEventListener('click', () => {
            jumpEditorToAnchor('attachment', referenceIndex, {
                lineNumber: referenceLineNumber,
                preservePreviewScroll: true,
                preferredText: referenceLabel || child.name,
                preferredKind: 'attachment'
            });
        });
        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showAttachmentContextMenu(event, {
                absolutePath: child.absolutePath,
                relativePath: child.absolutePath,
                lineNumber: referenceLineNumber
            });
        });
        container.appendChild(item);

        if (child.isDirectory && child.children.length) {
            const nested = document.createElement('div');
            nested.className = 'attachment-children';
            renderAttachmentChildTree(child.children, nested, referenceLineNumber, referenceIndex, referenceLabel);
            container.appendChild(nested);
        }
    }
}

function hideAttachmentContextMenu() {
    const menu = document.getElementById('attachment-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    attachmentContextTarget = null;
}

function hidePreviewImageContextMenu() {
    const menu = document.getElementById('preview-image-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    previewImageContextTarget = null;
}

function hideTabContextMenu() {
    const menu = document.getElementById('tab-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    tabContextTargetId = null;
}

function showAttachmentContextMenu(event, reference) {
    const menu = document.getElementById('attachment-context-menu');
    if (!menu) return;

    attachmentContextTarget = reference;
    menu.classList.add('show');
    const menuWidth = menu.offsetWidth || 160;
    const menuHeight = menu.offsetHeight || 90;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;
}

function buildAttachmentContextReference(reference) {
    if (!reference) return null;

    const absolutePath = String(
        reference.absolutePath
        || reference.pdfPath
        || reference.videoPath
        || reference.displayMeta?.absolutePath
        || reference.element?.getAttribute?.('data-kangaroo-path')
        || ''
    ).trim();

    if (!absolutePath) {
        return null;
    }

    let isDirectory = false;
    try {
        isDirectory = fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory();
    } catch {
        isDirectory = false;
    }

    return {
        ...reference,
        absolutePath,
        isDirectory
    };
}

async function renameAttachmentTarget(reference) {
    if (!reference?.absolutePath) return;
    await renameBundleAttachmentAbsolutePath(reference.absolutePath);
}

async function renameBundleAttachmentAbsolutePath(absolutePath) {
    const sourcePath = path.resolve(String(absolutePath || ''));
    if (!sourcePath) return false;
    if (!fs.existsSync(sourcePath)) {
        alert(`重命名失败: 找不到附件 ${sourcePath}`);
        return false;
    }

    let stat = null;
    try {
        stat = fs.statSync(sourcePath);
    } catch (error) {
        alert(`重命名失败: ${error.message}`);
        return false;
    }

    const targetPath = await ipcRenderer.invoke('dialog:renameAttachmentPath', {
        defaultPath: sourcePath,
        isDirectory: Boolean(stat?.isDirectory?.())
    });

    if (!targetPath) return false;

    const normalizedTargetPath = path.resolve(String(targetPath));
    if (normalizedTargetPath === sourcePath) return false;

    if (path.dirname(normalizedTargetPath) !== path.dirname(sourcePath)) {
        alert('这里只支持重命名附件，不支持移动到别的目录。');
        return false;
    }

    if (fs.existsSync(normalizedTargetPath)) {
        alert(`已存在同名项目：${path.basename(normalizedTargetPath)}`);
        return false;
    }

    try {
        fs.renameSync(sourcePath, normalizedTargetPath);

        let didRepairDocument = false;
        if (window.editor && typeof window.editor.updateAttachmentReferencesAfterRename === 'function') {
            didRepairDocument = Boolean(window.editor.updateAttachmentReferencesAfterRename(sourcePath, normalizedTargetPath));
        } else if (window.editor && typeof window.editor.refreshDisplayState === 'function') {
            didRepairDocument = Boolean(window.editor.refreshDisplayState());
        }

        updateOutline();
        if (workspaceRootPath) {
            scheduleWorkspaceTreeRefresh();
        }

        if (didRepairDocument) {
            suppressWorkspaceWatcherUntil = Date.now() + 1500;
            await saveFile({ silent: true });
            updateOutline();
        }

        return true;
    } catch (error) {
        alert(`重命名失败: ${error.message}`);
        return false;
    }
}

async function renameBundleAttachmentAbsolutePathToName(absolutePath, nextName) {
    const sourcePath = path.resolve(String(absolutePath || ''));
    const trimmedName = String(nextName || '').trim();

    if (!sourcePath || !trimmedName) {
        return false;
    }

    if (!fs.existsSync(sourcePath)) {
        alert(`重命名失败: 找不到附件 ${sourcePath}`);
        return false;
    }

    if (/[\\/]/.test(trimmedName)) {
        alert('名称不能包含斜杠。');
        return false;
    }

    const normalizedTargetPath = path.join(path.dirname(sourcePath), trimmedName);
    if (normalizedTargetPath === sourcePath) {
        return true;
    }

    if (fs.existsSync(normalizedTargetPath)) {
        alert(`已存在同名项目：${trimmedName}`);
        return false;
    }

    try {
        fs.renameSync(sourcePath, normalizedTargetPath);

        let didRepairDocument = false;
        if (window.editor && typeof window.editor.updateAttachmentReferencesAfterRename === 'function') {
            didRepairDocument = Boolean(window.editor.updateAttachmentReferencesAfterRename(sourcePath, normalizedTargetPath));
        } else if (window.editor && typeof window.editor.refreshDisplayState === 'function') {
            didRepairDocument = Boolean(window.editor.refreshDisplayState());
        }

        updateOutline();
        if (workspaceRootPath) {
            scheduleWorkspaceTreeRefresh();
        }

        if (didRepairDocument) {
            suppressWorkspaceWatcherUntil = Date.now() + 1500;
            await saveFile({ silent: true });
            updateOutline();
        }

        return true;
    } catch (error) {
        alert(`重命名失败: ${error.message}`);
        return false;
    }
}

function getAttachmentInlineRenameLabelElement(element) {
    return element?.querySelector?.('.kangaroo-attachment-label, .kangaroo-video-label, .kangaroo-pdf-label') || null;
}

function clearAttachmentInlineRenameState() {
    attachmentInlineRenameState = null;
}

function cancelAttachmentInlineRename() {
    const state = attachmentInlineRenameState;
    if (!state) return;
    if (state.input?.parentNode) {
        state.input.parentNode.removeChild(state.input);
    }
    if (state.labelElement) {
        state.labelElement.style.display = '';
    }
    clearAttachmentInlineRenameState();
    resumeWorkspaceRefresh({ immediate: true });
}

async function commitAttachmentInlineRename() {
    const state = attachmentInlineRenameState;
    if (!state) return false;

    const nextName = String(state.input?.value || '').trim();
    if (!nextName) {
        alert('名称不能为空。');
        state.input?.focus();
        state.input?.select();
        return false;
    }

    const didRename = await renameBundleAttachmentAbsolutePathToName(state.absolutePath, nextName);
    if (!didRename) {
        state.input?.focus();
        state.input?.select();
        return false;
    }

    if (state.input?.parentNode) {
        state.input.parentNode.removeChild(state.input);
    }
    if (state.labelElement) {
        state.labelElement.style.display = '';
    }
    clearAttachmentInlineRenameState();
    resumeWorkspaceRefresh({ immediate: true });
    return true;
}

function beginAttachmentInlineRename(linkInfo) {
    const context = resolveEditorLinkContext(linkInfo);
    if (!context?.isPath || !context.exists) return;
    const normalizedHref = String(context.href || '').replace(/^\.?\//, '');
    if (!/^attachments\//i.test(normalizedHref)) return;

    cancelAttachmentInlineRename();

    const hostElement = context.element?.closest?.('[data-kangaroo-attachment], [data-kangaroo-video], [data-kangaroo-pdf]') || null;
    const labelElement = getAttachmentInlineRenameLabelElement(hostElement);
    if (!hostElement || !labelElement) return;

    suspendWorkspaceRefresh();

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'attachment-inline-rename-input';
    input.value = path.basename(context.target.value || context.href || '');
    input.setAttribute('aria-label', '重命名附件');

    input.addEventListener('mousedown', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('dblclick', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('contextmenu', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('keydown', async (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            await commitAttachmentInlineRename();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelAttachmentInlineRename();
        }
    });
    input.addEventListener('beforeinput', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('input', (event) => {
        event.stopPropagation();
    });
    input.addEventListener('blur', () => {
        if (attachmentInlineRenameState?.input !== input) return;
        cancelAttachmentInlineRename();
    });

    labelElement.style.display = 'none';
    labelElement.parentNode?.insertBefore(input, labelElement.nextSibling);

    attachmentInlineRenameState = {
        absolutePath: context.target.value,
        hostElement,
        labelElement,
        input
    };

    window.requestAnimationFrame(() => {
        input.focus();
        input.select();
    });
}

function showPreviewImageContextMenu(event, imagePath) {
    const menu = document.getElementById('preview-image-context-menu');
    if (!menu) return;

    previewImageContextTarget = imagePath;
    const openWithButton = document.getElementById('preview-image-menu-open-with');
    if (openWithButton) {
        openWithButton.style.display = IS_MACOS ? '' : 'none';
    }
    menu.classList.add('show');
    const menuWidth = menu.offsetWidth || 180;
    const menuHeight = menu.offsetHeight || 120;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;
}

function showTabContextMenu(event, tabId) {
    const menu = document.getElementById('tab-context-menu');
    if (!menu) return;

    tabContextTargetId = tabId;
    menu.classList.add('show');
    const menuWidth = menu.offsetWidth || 168;
    const menuHeight = menu.offsetHeight || 56;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;
}

function hideEditorLinkContextMenu() {
    const menu = document.getElementById('editor-link-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    editorLinkContextTarget = null;
}

function resolveEditorLinkContext(linkInfo) {
    if (!linkInfo?.href) return null;

    const target = resolvePreviewLinkTarget(linkInfo.href);
    const isPath = target?.type === 'path' && Boolean(target.value);
    const exists = Boolean(isPath && fs.existsSync(target.value));
    const isDirectory = Boolean(exists && fs.statSync(target.value).isDirectory());

    return {
        ...linkInfo,
        target,
        isPath,
        exists,
        isDirectory
    };
}

function showEditorLinkContextMenu(event, linkInfo) {
    const menu = document.getElementById('editor-link-context-menu');
    if (!menu) return;

    const context = resolveEditorLinkContext(linkInfo);
    if (!context) return;

    const contextElement = linkInfo?.element
        || linkInfo?.nodeView?.getDom?.()
        || getEventTargetElement(event.target)?.closest?.('[data-kangaroo-attachment], [data-kangaroo-video], [data-kangaroo-pdf], a.kangaroo-link')
        || null;
    const cardElement = contextElement?.closest?.('[data-kangaroo-attachment], [data-kangaroo-video], [data-kangaroo-pdf]') || null;
    const cardKind = String(linkInfo?.cardKind || '').trim() || (
        cardElement?.matches?.('[data-kangaroo-pdf]')
            ? 'pdf'
            : cardElement?.matches?.('[data-kangaroo-video]')
                ? 'video'
                : cardElement?.matches?.('[data-kangaroo-attachment]')
                    ? 'attachment'
                    : 'link'
    );
    const absolutePath = String(
        linkInfo?.absolutePath
        || cardElement?.getAttribute?.('data-kangaroo-path')
        || contextElement?.getAttribute?.('data-kangaroo-path')
        || linkInfo?.displayMeta?.absolutePath
        || (context.target?.type === 'path' ? context.target.value : '')
        || ''
    ).trim();
    editorLinkContextTarget = {
        ...context,
        element: contextElement,
        cardElement,
        cardKind,
        absolutePath
    };

    const openWithButton = document.getElementById('editor-link-menu-open-with');
    const revealButton = document.getElementById('editor-link-menu-reveal');
    const renameButton = document.getElementById('editor-link-menu-rename');
    const isAttachmentTarget = /^attachments\//i.test(String(context.href || '').replace(/^\.?\//, ''));
    const canRenameTarget = ['attachment', 'pdf', 'video'].includes(cardKind) && Boolean(absolutePath) && fs.existsSync(absolutePath);

    if (openWithButton) {
        openWithButton.style.display = IS_MACOS && context.isPath && context.exists ? '' : 'none';
    }

    if (revealButton) {
        revealButton.style.display = context.isPath && context.exists ? '' : 'none';
    }

    if (renameButton) {
        renameButton.style.display = (isAttachmentTarget && canRenameTarget) ? '' : 'none';
    }

    menu.classList.add('show');
    const menuWidth = menu.offsetWidth || 190;
    const menuHeight = menu.offsetHeight || 160;
    const left = Math.min(event.clientX, window.innerWidth - menuWidth - 8);
    const top = Math.min(event.clientY, window.innerHeight - menuHeight - 8);
    menu.style.left = `${Math.max(left, 8)}px`;
    menu.style.top = `${Math.max(top, 8)}px`;
}

async function openTabFolder(tabId) {
    const tab = getTabById(tabId);
    if (!tab || !tab.path) return;

    const parentDir = path.dirname(tab.path);
    const result = await ipcRenderer.invoke('shell:openLinkTarget', {
        type: 'path',
        value: parentDir
    });

    if (!result || !result.ok) {
        alert(`打开目录失败: ${(result && result.error) || parentDir}`);
    }
}

async function openAttachmentTarget(reference) {
    if (!reference) return;

    const result = await ipcRenderer.invoke('shell:openLinkTarget', {
        type: 'path',
        value: reference.absolutePath
    });

    if (!result || !result.ok) {
        alert(`打开附件失败: ${(result && result.error) || reference.absolutePath}`);
    }
}

async function renameEditorLinkTarget(linkInfo) {
    const context = resolveEditorLinkContext(linkInfo);
    const absolutePath = String(
        linkInfo?.absolutePath
        || linkInfo?.cardElement?.getAttribute?.('data-kangaroo-path')
        || linkInfo?.element?.getAttribute?.('data-kangaroo-path')
        || (context?.target?.type === 'path' ? context.target.value : '')
        || ''
    ).trim();
    if (!absolutePath) {
        return;
    }

    await renameAttachmentAbsolutePath(absolutePath);
}

async function openEditorLinkTarget(linkInfo) {
    const context = resolveEditorLinkContext(linkInfo);
    if (!context?.target) return;

    const result = await ipcRenderer.invoke('shell:openLinkTarget', context.target);
    if (!result || !result.ok) {
        alert(`打开链接失败: ${(result && result.error) || context.href}`);
    }
}

async function revealEditorLinkTarget(linkInfo) {
    const context = resolveEditorLinkContext(linkInfo);
    if (!context?.isPath || !context.exists) return;

    const result = await ipcRenderer.invoke('shell:revealLinkTarget', context.target);
    if (!result || !result.ok) {
        alert(`打开所在目录失败: ${(result && result.error) || context.target.value}`);
    }
}

async function openEditorLinkWithChosenApp(linkInfo) {
    if (!IS_MACOS) return;
    const context = resolveEditorLinkContext(linkInfo);
    if (!context?.isPath || !context.exists) return;

    const result = await ipcRenderer.invoke('dialog:chooseAppForFile', context.target);
    if (!result || result.canceled) {
        return;
    }

    if (!result.ok) {
        alert(`选择应用打开失败: ${result.error || context.target.value}`);
    }
}

function deleteSelectedEditorLink() {
    if (!window.editor || typeof window.editor.deleteSelectedLink !== 'function') {
        return;
    }

    capturePendingAttachmentDeleteSnapshot();
    persistActiveTabState();
    const didDelete = window.editor.deleteSelectedLink();
    if (didDelete) {
        hideEditorLinkContextMenu();
    }
}

async function revealAttachmentTarget(reference) {
    if (!reference) return;

    const result = await ipcRenderer.invoke('shell:revealLinkTarget', {
        type: 'path',
        value: reference.absolutePath
    });

    if (!result || !result.ok) {
        alert(`打开所在目录失败: ${(result && result.error) || reference.absolutePath}`);
    }
}

async function openPreviewImageWithSystem(imagePath) {
    if (!imagePath) return;

    const result = await ipcRenderer.invoke('shell:openLinkTarget', {
        type: 'path',
        value: imagePath
    });

    if (!result || !result.ok) {
        alert(`打开图片失败: ${(result && result.error) || imagePath}`);
    }
}

async function revealPreviewImageInFolder(imagePath) {
    if (!imagePath) return;

    const result = await ipcRenderer.invoke('shell:revealLinkTarget', {
        type: 'path',
        value: imagePath
    });

    if (!result || !result.ok) {
        alert(`打开图片所在目录失败: ${(result && result.error) || imagePath}`);
    }
}

async function openPreviewImageWithChosenApp(imagePath) {
    if (!IS_MACOS) return;
    if (!imagePath) return;

    const result = await ipcRenderer.invoke('dialog:chooseAppForFile', {
        type: 'path',
        value: imagePath
    });

    if (!result || result.canceled) {
        return;
    }

    if (!result.ok) {
        alert(`选择应用打开失败: ${result.error || imagePath}`);
    }
}

function copyPreviewImage(imagePath) {
    if (!imagePath || !fs.existsSync(imagePath)) {
        alert(`图片不存在：${imagePath || '未知路径'}`);
        return;
    }

    const image = nativeImage.createFromPath(imagePath);
    if (image.isEmpty()) {
        alert('复制图片失败：无法读取该图片。');
        return;
    }

    clipboard.writeImage(image);
}

function applyPlatformSpecificUi() {
    document.body.classList.toggle('is-macos', IS_MACOS);
    document.body.classList.toggle('is-non-macos', !IS_MACOS);

    const editorLinkOpenWith = document.getElementById('editor-link-menu-open-with');
    const previewImageOpenWith = document.getElementById('preview-image-menu-open-with');

    if (editorLinkOpenWith) {
        editorLinkOpenWith.style.display = IS_MACOS ? '' : 'none';
    }

    if (previewImageOpenWith) {
        previewImageOpenWith.style.display = IS_MACOS ? '' : 'none';
    }
}

function getPreviewImageKey(imagePath, sourceLine, sourceRef) {
    return [imagePath || '', sourceLine || '', normalizePreviewImageSourceRef(sourceRef)].join('::');
}

function getPreviewImageWrapperFromNode(node) {
    return node ? node.closest('.preview-image-resizer') : null;
}

function getPreviewImageMetadataFromNode(node) {
    const wrapper = getPreviewImageWrapperFromNode(node) || node?.closest?.('img[data-preview-image-path]')?.parentElement;
    if (!wrapper) return null;

    const image = wrapper.querySelector('img[data-preview-image-path]');
    if (!image) return null;

    const imagePath = image.getAttribute('data-preview-image-path') || '';
    const sourceLine = Number(image.getAttribute('data-preview-source-line') || wrapper.getAttribute('data-preview-source-line') || 0);
    const sourceRef = image.getAttribute('data-preview-image-src') || '';

    return {
        wrapper,
        image,
        imagePath,
        sourceLine,
        sourceRef,
        key: getPreviewImageKey(imagePath, sourceLine, sourceRef)
    };
}

function clearSelectedPreviewImage() {
    const selected = document.querySelector('.preview-image-resizer.is-selected');
    if (selected) {
        selected.classList.remove('is-selected');
    }
    selectedPreviewImageKey = null;
}

function selectPreviewImageFromNode(node) {
    const metadata = getPreviewImageMetadataFromNode(node);
    if (!metadata) return null;

    clearSelectedPreviewImage();
    metadata.wrapper.classList.add('is-selected');
    selectedPreviewImageKey = metadata.key;
    return metadata;
}

function decoratePreviewImages() {
    const preview = document.getElementById('preview-container');
    if (!preview) return;

    const images = Array.from(preview.querySelectorAll('img[data-preview-image-path]'));

    for (const image of images) {
        if (image.parentElement && image.parentElement.classList.contains('preview-image-resizer')) {
            continue;
        }

        const wrapper = document.createElement('span');
        wrapper.className = 'preview-image-resizer';
        wrapper.setAttribute('data-preview-image-path', image.getAttribute('data-preview-image-path') || '');
        wrapper.setAttribute('data-preview-source-line', image.getAttribute('data-preview-source-line') || '');
        wrapper.setAttribute('data-preview-image-src', image.getAttribute('data-preview-image-src') || '');

        image.parentNode.insertBefore(wrapper, image);
        wrapper.appendChild(image);

        const handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'preview-image-resize-handle';
        handle.title = '拖拽调整图片宽度';
        wrapper.appendChild(handle);
    }

    if (selectedPreviewImageKey) {
        const selected = Array.from(preview.querySelectorAll('.preview-image-resizer')).find((wrapper) => {
            const image = wrapper.querySelector('img[data-preview-image-path]');
            return image && getPreviewImageKey(
                image.getAttribute('data-preview-image-path'),
                Number(image.getAttribute('data-preview-source-line') || 0),
                image.getAttribute('data-preview-image-src')
            ) === selectedPreviewImageKey;
        });

        if (selected) {
            selected.classList.add('is-selected');
        } else {
            selectedPreviewImageKey = null;
        }
    }
}

function lineContainsMatchingImageReference(line, sourceRef) {
    const normalizedTarget = normalizePreviewImageSourceRef(sourceRef);
    if (!normalizedTarget) return false;

    const markdownRegex = /!\[(.*?)\]\(([^)]+)\)/g;
    const htmlRegex = /<img\b[^>]*>/gi;
    let match;

    while ((match = markdownRegex.exec(line))) {
        if (normalizePreviewImageSourceRef(match[2]) === normalizedTarget) {
            return true;
        }
    }

    while ((match = htmlRegex.exec(line))) {
        if (normalizePreviewImageSourceRef(extractHtmlAttribute(match[0], 'src')) === normalizedTarget) {
            return true;
        }
    }

    return false;
}

function setSourceImageWidthOnLine(line, sourceRef, width) {
    const normalizedTarget = normalizePreviewImageSourceRef(sourceRef);
    let replaced = false;

    const nextLine = line.replace(/<img\b[^>]*>|!\[(.*?)\]\(([^)]+)\)/gi, (match, alt, markdownSrc) => {
        if (replaced) return match;

        if (match.toLowerCase().startsWith('<img')) {
            const existingSrc = extractHtmlAttribute(match, 'src');
            if (normalizePreviewImageSourceRef(existingSrc) !== normalizedTarget) {
                return match;
            }

            replaced = true;
            let updatedTag = removeHtmlAttribute(match, 'data-preview-image-path');
            updatedTag = removeHtmlAttribute(updatedTag, 'data-preview-image-src');
            updatedTag = removeHtmlAttribute(updatedTag, 'data-preview-source-line');
            updatedTag = removeHtmlAttribute(updatedTag, 'height');
            updatedTag = removeHtmlStyleProperties(updatedTag, ['width', 'height']);
            updatedTag = setOrReplaceHtmlAttribute(updatedTag, 'width', String(width));
            return updatedTag;
        }

        if (normalizePreviewImageSourceRef(markdownSrc) !== normalizedTarget) {
            return match;
        }

        replaced = true;
        const safeAlt = alt || '';
        return `<img src="${escapeHtmlAttribute(normalizePreviewImageSourceRef(markdownSrc))}" alt="${escapeHtmlAttribute(safeAlt)}" width="${width}" />`;
    });

    return replaced ? nextLine : line;
}

function updateImageWidthInEditor(sourceLine, sourceRef, width) {
    if (!window.editor) return false;

    const roundedWidth = Math.max(80, Math.round(width));
    const content = window.editor.getValue();
    const lines = content.split('\n');
    const preferredIndex = Math.max(sourceLine - 1, 0);
    const candidateIndexes = [];

    if (preferredIndex < lines.length) {
        candidateIndexes.push(preferredIndex);
    }

    for (let distance = 1; distance <= 3; distance++) {
        if (preferredIndex - distance >= 0) {
            candidateIndexes.push(preferredIndex - distance);
        }
        if (preferredIndex + distance < lines.length) {
            candidateIndexes.push(preferredIndex + distance);
        }
    }

    for (const lineIndex of candidateIndexes) {
        if (!lineContainsMatchingImageReference(lines[lineIndex], sourceRef)) {
            continue;
        }

        const updatedLine = setSourceImageWidthOnLine(lines[lineIndex], sourceRef, roundedWidth);
        if (updatedLine !== lines[lineIndex]) {
            suppressEditorDrivenPreviewSyncUntil = Date.now() + 400;
            replaceEditorLine(lineIndex + 1, updatedLine);
            return true;
        }
    }

    return false;
}

function startPreviewImageResize(event, metadata) {
    if (!metadata || !metadata.image) return;

    event.preventDefault();
    event.stopPropagation();

    const preview = document.getElementById('preview-container');
    const previewStyle = window.getComputedStyle(preview);
    const paddingLeft = parseFloat(previewStyle.paddingLeft) || 0;
    const paddingRight = parseFloat(previewStyle.paddingRight) || 0;
    const maxWidth = Math.max(preview.clientWidth - paddingLeft - paddingRight, 120);
    const rect = metadata.image.getBoundingClientRect();

    activePreviewImageResize = {
        key: metadata.key,
        wrapper: metadata.wrapper,
        image: metadata.image,
        sourceLine: metadata.sourceLine,
        sourceRef: metadata.sourceRef,
        startX: event.clientX,
        startWidth: rect.width,
        maxWidth
    };

    metadata.wrapper.classList.add('is-resizing');
}

function updateActivePreviewImageResize(event) {
    if (!activePreviewImageResize) return;

    event.preventDefault();
    const deltaX = event.clientX - activePreviewImageResize.startX;
    const nextWidth = clamp(activePreviewImageResize.startWidth + deltaX, 80, activePreviewImageResize.maxWidth);
    activePreviewImageResize.image.style.width = `${Math.round(nextWidth)}px`;
    activePreviewImageResize.image.style.maxWidth = '100%';
    activePreviewImageResize.image.style.height = 'auto';
}

function finishActivePreviewImageResize() {
    if (!activePreviewImageResize) return;

    const resizeState = activePreviewImageResize;
    activePreviewImageResize = null;
    resizeState.wrapper.classList.remove('is-resizing');

    const appliedWidth = Math.round(resizeState.image.getBoundingClientRect().width);
    const didUpdate = updateImageWidthInEditor(resizeState.sourceLine, resizeState.sourceRef, appliedWidth);

    if (!didUpdate) {
        resizeState.image.style.width = '';
        alert('图片尺寸写回失败，请稍后重试。');
    }
}

function renderAttachmentList(content) {
    const attachmentContainer = document.getElementById('attachment-container');
    if (!attachmentContainer) return;

    attachmentContainer.innerHTML = '';

    const references = window.editor && typeof window.editor.getAttachmentReferences === 'function'
        ? window.editor.getAttachmentReferences()
        : getAttachmentReferences(content);
    if (!references.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '当前文档还没有引用附件。把文件或文件夹拖进编辑区后，这里就会列出来。';
        attachmentContainer.appendChild(emptyState);
        return;
    }

    for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
        const reference = references[referenceIndex];
        const item = document.createElement('div');
        item.className = `attachment-item${reference.exists ? '' : ' missing'}`;

        const row = document.createElement('div');
        row.className = 'attachment-item-row';

        const toggle = document.createElement('div');
        const hasChildren = reference.exists && reference.isDirectory;
        toggle.className = `attachment-toggle${hasChildren ? '' : ' empty'}`;
        toggle.innerText = hasChildren
            ? (expandedAttachmentEntries.has(reference.relativePath) ? '▾' : '▸')
            : '•';
        toggle.addEventListener('click', (event) => {
            event.stopPropagation();
            if (!hasChildren) return;

            if (expandedAttachmentEntries.has(reference.relativePath)) {
                expandedAttachmentEntries.delete(reference.relativePath);
            } else {
                expandedAttachmentEntries.add(reference.relativePath);
            }

            renderAttachmentList(content);
        });

        const body = document.createElement('div');
        body.className = 'attachment-body';

        const title = document.createElement('div');
        title.className = 'attachment-title';
        title.innerText = reference.label || path.basename(reference.relativePath);

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';
        meta.innerText = reference.exists
            ? `${reference.isDirectory ? '文件夹' : '文件'} · 第 ${reference.lineNumber} 行 · ${reference.relativePath}`
            : `引用缺失 · 第 ${reference.lineNumber} 行 · ${reference.relativePath}`;

        body.appendChild(title);
        body.appendChild(meta);
        row.appendChild(toggle);
        row.appendChild(body);
        item.appendChild(row);

        item.addEventListener('click', () => {
            jumpEditorToAnchor('attachment', referenceIndex, {
                lineNumber: reference.lineNumber,
                preservePreviewScroll: true,
                preferredText: reference.label || path.basename(reference.relativePath),
                preferredKind: 'attachment'
            });
        });

        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            showAttachmentContextMenu(event, reference);
        });

        if (hasChildren && expandedAttachmentEntries.has(reference.relativePath)) {
            const childrenContainer = document.createElement('div');
            childrenContainer.className = 'attachment-children';
            renderAttachmentChildTree(
                getAttachmentTreeChildren(reference.absolutePath),
                childrenContainer,
                reference.lineNumber,
                referenceIndex,
                reference.label || path.basename(reference.relativePath)
            );
            item.appendChild(childrenContainer);
        }

        attachmentContainer.appendChild(item);
    }
}

function getSearchMatches(content, query) {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return [];

    if (window.editor && typeof window.editor.getSearchMatches === 'function') {
        return window.editor.getSearchMatches(normalizedQuery, 200);
    }

    return getMarkdownSearchMatches(content, normalizedQuery);
}

function getMarkdownSearchMatches(content, normalizedQuery, options = {}) {
    const {
        bundlePath = null,
        meta = '',
        limit = 200
    } = options;

    const lines = content.split('\n');
    const matches = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const normalizedLine = line.toLowerCase();
        const firstMatchIndex = normalizedLine.indexOf(normalizedQuery);

        if (firstMatchIndex === -1) continue;

        const jumpTarget = getSearchJumpTarget(line);

        matches.push({
            lineNumber: index + 1,
            text: normalizeSearchTargetText(line) || line.trim() || '(空行)',
            snippet: line.trim() || '(空行)',
            matchIndex: firstMatchIndex,
            jumpTarget,
            kind: jumpTarget.preferredKind || '',
            kindLabel: getSearchKindLabel(jumpTarget.preferredKind || ''),
            bundlePath,
            meta
        });

        if (matches.length >= limit) {
            break;
        }
    }

    return matches;
}

function getSearchKindLabel(kind) {
    switch (kind) {
    case 'heading':
        return '标题';
    case 'task':
        return '待办';
    case 'attachment':
        return '附件';
    default:
        return '正文';
    }
}

function getWorkspaceBundlePaths(rootPath) {
    if (!rootPath || !fs.existsSync(rootPath)) {
        return [];
    }

    const results = [];
    const visit = (dirPath) => {
        let entries = [];
        try {
            entries = fs.readdirSync(dirPath, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const entryPath = path.join(dirPath, entry.name);
            if (entry.name.endsWith('.textbundle')) {
                if (isValidTextBundlePath(entryPath)) {
                    results.push(entryPath);
                }
                continue;
            }
            visit(entryPath);
        }
    };

    visit(rootPath);
    return results;
}

function getBundleMarkdownForSearch(bundlePath) {
    const normalizedPath = path.resolve(bundlePath);
    const openTab = findTabByPath(normalizedPath);
    if (openTab) {
        return openTab.content || '';
    }

    try {
        const markdownPath = resolveBundleMarkdownFilePath(normalizedPath);
        return markdownPath ? fs.readFileSync(markdownPath, 'utf8') : '';
    } catch {
        return '';
    }
}

function getWorkspaceSearchMatches(query, limit = 80) {
    if (!workspaceRootPath) {
        return [];
    }

    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) {
        return [];
    }

    const matches = [];
    for (const bundlePath of getWorkspaceBundlePaths(workspaceRootPath)) {
        const content = getBundleMarkdownForSearch(bundlePath);
        if (!content) continue;

        const relativeBundlePath = path.relative(workspaceRootPath, bundlePath) || path.basename(bundlePath);
        const bundleMatches = path.resolve(bundlePath) === path.resolve(getActiveTab()?.path || '')
            && window.editor
            && typeof window.editor.getSearchMatches === 'function'
            ? window.editor.getSearchMatches(normalizedQuery, limit - matches.length).map((match) => ({
                ...match,
                bundlePath,
                meta: relativeBundlePath,
                kindLabel: match.kindLabel || getSearchKindLabel(match.kind || '')
            }))
            : getMarkdownSearchMatches(content, normalizedQuery, {
                bundlePath,
                meta: relativeBundlePath,
                limit: limit - matches.length
            });

        matches.push(...bundleMatches);
        if (matches.length >= limit) {
            break;
        }
    }

    return matches.slice(0, limit);
}

function getSearchJumpTarget(line) {
    const rawLine = String(line || '').trim();
    if (!rawLine) {
        return { preferredText: '', preferredKind: '' };
    }

    const headingMatch = rawLine.match(/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+(#{1,6})\s+(.+)$/) || rawLine.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
        return {
            preferredText: headingMatch[2].trim(),
            preferredKind: 'heading'
        };
    }

    const taskMatch = rawLine.match(/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+(.+)$/);
    if (taskMatch) {
        return {
            preferredText: taskMatch[1].trim(),
            preferredKind: 'task'
        };
    }

    const attachmentRef = collectAttachmentMarkdownRefs(rawLine)[0];
    if (attachmentRef) {
        return {
            preferredText: (attachmentRef.label || path.basename(attachmentRef.relativePath || '')).trim(),
            preferredKind: 'attachment'
        };
    }

    return {
        preferredText: normalizeSearchTargetText(rawLine),
        preferredKind: ''
    };
}

function normalizeSearchTargetText(text) {
    return String(text || '')
        .replace(/^#{1,6}\s+/, '')
        .replace(/^>\s?/, '')
        .replace(/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+/, '')
        .replace(/^(?:[-+*]|\d+\.)\s+/, '')
        .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => (alt || path.basename(src || '')).trim())
        .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, label, href) => (label || path.basename(href || '')).trim())
        .replace(/<img\b[^>]*alt\s*=\s*["']?([^"'>]*)["']?[^>]*src\s*=\s*["']?([^"'>\s]*)["']?[^>]*>/gi, (_, alt, src) => (alt || path.basename(src || '')).trim())
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function highlightSearchSnippet(text, query) {
    const safeText = escapeHtml(text);
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return safeText;

    const pattern = new RegExp(escapeRegExp(trimmedQuery), 'ig');
    return safeText.replace(pattern, (match) => `<span class="toolbar-search-mark">${match}</span>`);
}

function getSearchResultElements() {
    return Array.from(document.querySelectorAll('.toolbar-search-item'));
}

function setActiveSearchMatchIndex(nextIndex, options = {}) {
    const { scrollIntoView = true } = options;
    const items = getSearchResultElements();

    if (!items.length) {
        activeSearchMatchIndex = -1;
        return;
    }

    const clampedIndex = clamp(nextIndex, 0, items.length - 1);
    activeSearchMatchIndex = clampedIndex;

    items.forEach((item, index) => {
        item.classList.toggle('active', index === clampedIndex);
    });

    if (scrollIntoView) {
        items[clampedIndex]?.scrollIntoView({ block: 'nearest' });
    }
}

async function jumpToSearchMatch(match) {
    if (!match || !window.editor) return;

    if (match.bundlePath) {
        const activePath = getActiveTab()?.path ? path.resolve(getActiveTab().path) : null;
        const targetPath = path.resolve(match.bundlePath);
        if (activePath !== targetPath) {
            await openBundleFromExternalPath(targetPath);
        }
    }

    if (typeof window.editor.jumpToSearchResult === 'function') {
        const didJump = window.editor.jumpToSearchResult(match);
        if (didJump) {
            highlightEditorLine(match.lineNumber || 1);
            return;
        }
    }

    if (Number.isInteger(match.kindIndex) && match.kind) {
        jumpEditorToAnchor(match.kind, match.kindIndex, {
            lineNumber: match.lineNumber || 1,
            preferredText: match.text || '',
            preferredKind: match.kind || ''
        });
        return;
    }

    jumpEditorToLine(match.lineNumber || 1, {
        preferredText: match.jumpTarget?.preferredText || match.text || '',
        preferredKind: match.jumpTarget?.preferredKind || match.kind || ''
    });
}

function renderToolbarSearchResults(query = currentSearchQuery) {
    const container = document.getElementById('toolbar-search-results');
    if (!container || !window.editor) return;

    currentSearchQuery = query;
    const activeTab = getActiveTab();
    if (activeTab) {
        activeTab.searchQuery = query;
    }
    const trimmedQuery = query.trim();

    if (!trimmedQuery) {
        container.classList.remove('show');
        container.innerHTML = '';
        currentSearchMatches = [];
        activeSearchMatchIndex = -1;
        return;
    }

    const searchScope = currentSearchScope === 'workspace' ? 'workspace' : 'document';
    const matches = (
        searchScope === 'workspace'
            ? getWorkspaceSearchMatches(trimmedQuery, 80)
            : getSearchMatches(window.editor.getValue(), trimmedQuery).slice(0, 80)
    );
    currentSearchMatches = matches;
    container.innerHTML = '';

    if (!matches.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'toolbar-search-empty';
        emptyState.innerText = '没有找到匹配结果。';
        container.appendChild(emptyState);
        container.classList.add('show');
        activeSearchMatchIndex = -1;
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'toolbar-search-summary';
    summary.innerHTML = `
        <span class="toolbar-search-count">找到 ${matches.length} 条结果</span>
        <span class="toolbar-search-hint">${searchScope === 'workspace' ? '工作空间范围' : '当前文档'} · 回车打开，方向键切换</span>
    `;
    container.appendChild(summary);

    matches.forEach((match, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'toolbar-search-item';
        const kindLabel = escapeHtml(match.kindLabel || '正文');
        const metaParts = [];
        if (match.lineNumber) {
            metaParts.push(`第 ${match.lineNumber} 行`);
        }
        if (match.meta) {
            metaParts.push(escapeHtml(match.meta));
        }
        item.innerHTML = `
            <div class="toolbar-search-meta">
                <span class="toolbar-search-kind">${kindLabel}</span>
                <span class="toolbar-search-line">${metaParts.join(' · ')}</span>
            </div>
            <div class="toolbar-search-text">${highlightSearchSnippet(match.snippet || match.text, trimmedQuery)}</div>
        `;
        item.addEventListener('click', () => {
            container.classList.remove('show');
            void jumpToSearchMatch(match);
        });
        item.addEventListener('mouseenter', () => setActiveSearchMatchIndex(index, { scrollIntoView: false }));
        container.appendChild(item);
    });

    container.classList.add('show');
    setActiveSearchMatchIndex(0, { scrollIntoView: false });
}


function cleanUnusedImages(markdown) {
    const assetsDir = path.join(window.currentPath, 'assets');
    if (!fs.existsSync(assetsDir)) return;

    const used = getUsedImageEntries(markdown);

    for (const entryName of fs.readdirSync(assetsDir)) {
        if (used.has(entryName)) continue;

        const entryPath = path.join(assetsDir, entryName);
        const stat = fs.statSync(entryPath);

        if (stat.isDirectory()) {
            continue;
        }

        if (moveEntryToRecovery('assets', entryName)) {
            console.log("移入恢复区的图片资源:", entryName);
        }
    }
}

function getUsedAttachmentEntries(markdown, options = {}) {
    const { preferEditorState = false } = options;
    const used = new Set();

    if (
        preferEditorState
        && window.editor
        && typeof window.editor.getAttachmentReferences === 'function'
    ) {
        for (const ref of window.editor.getAttachmentReferences()) {
            const normalized = String(ref.relativePath || '')
                .replace(/^attachments\//i, '')
                .replace(/\\/g, '/')
                .replace(/^\/+/, '');
            const topLevelEntry = normalized.split('/')[0];

            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        }
    }

    for (const ref of collectAttachmentMarkdownRefs(markdown)) {
        const normalized = ref.relativePath.replace(/\\/g, '/').replace(/^\/+/, '');
        const topLevelEntry = normalized.split('/')[0];

        if (topLevelEntry) {
            used.add(topLevelEntry);
        }
    }

    return used;
}

async function cleanUnusedAttachments(markdown) {
    const attachmentsDir = path.join(window.currentPath, 'attachments');
    if (!fs.existsSync(attachmentsDir)) return true;

    const used = getUsedAttachmentEntries(markdown, { preferEditorState: true });

    for (const entryName of used) {
        preservedUnusedAttachmentEntries.delete(entryName);
    }

    for (const entryName of fs.readdirSync(attachmentsDir)) {
        if (used.has(entryName)) continue;

        const entryPath = path.join(attachmentsDir, entryName);
        if (!fs.existsSync(entryPath)) continue;

        const stat = fs.statSync(entryPath);
        const isDirectory = stat.isDirectory();

        backupEntryToRecovery('attachments', entryName);
        const trashResult = await ipcRenderer.invoke('shell:trashPath', {
            type: 'path',
            value: entryPath
        });

        if (!trashResult || !trashResult.ok) {
            moveEntryToRecovery('attachments', entryName);
        }

        preservedUnusedAttachmentEntries.delete(entryName);
        console.log(`删除并备份到恢复区的附件${isDirectory ? '文件夹' : '文件'}:`, entryName);
    }

    return true;
}


// ==============================
// 渲染
// ==============================
function updatePreview(options = {}) {
    if (!window.editor || !isPreviewActive()) return;
    const { preserveViewport = false, preserveMode = 'anchor' } = options;

    let raw = window.editor.getValue();
    const preview = document.getElementById('preview-container');
    const viewportState = preserveViewport ? capturePreviewViewportState(preserveMode) : null;

    raw = transformMarkdownForPreview(raw);

    preview.innerHTML = getMarkdownRenderer().render(raw);
    decoratePreviewImages();
    decoratePreviewLinks();

    if (viewportState) {
        restorePreviewViewportState(viewportState);
    }
}

function capturePreviewViewportState(mode = 'anchor') {
    const preview = document.getElementById('preview-container');
    if (!preview) return null;

    if (mode === 'scroll') {
        return {
            mode: 'scroll',
            scrollTop: preview.scrollTop
        };
    }

    const nodes = Array.from(preview.querySelectorAll('[data-source-line]'));
    if (!nodes.length) {
        return {
            mode: 'scroll',
            scrollTop: preview.scrollTop
        };
    }

    const anchorOffset = Math.min(Math.max(preview.clientHeight * 0.18, 24), 120);
    const anchorY = preview.scrollTop + anchorOffset;
    const anchorNode = nodes.find((node) => node.offsetTop + node.offsetHeight > anchorY) || nodes[nodes.length - 1];

    return {
        mode: 'anchor',
        sourceLine: Number(anchorNode.getAttribute('data-source-line') || 1),
        offset: anchorY - anchorNode.offsetTop,
        scrollTop: preview.scrollTop
    };
}

function restorePreviewViewportState(state) {
    if (!state) return;

    const preview = document.getElementById('preview-container');
    if (!preview) return;

    const maxScrollTop = Math.max(preview.scrollHeight - preview.clientHeight, 0);

    if (state.mode === 'scroll' || typeof state.sourceLine !== 'number') {
        preview.scrollTop = Math.min(Math.max(state.scrollTop || 0, 0), maxScrollTop);
        return;
    }

    const anchorNode = findPreviewNodeForLine(state.sourceLine);
    if (!anchorNode) {
        preview.scrollTop = Math.min(Math.max(state.scrollTop || 0, 0), maxScrollTop);
        return;
    }

    const anchorOffset = Math.min(Math.max(preview.clientHeight * 0.18, 24), 120);
    const anchorY = anchorNode.offsetTop + (state.offset || 0);
    preview.scrollTop = Math.min(Math.max(anchorY - anchorOffset, 0), maxScrollTop);
}

function findPreviewNodeForLine(lineNumber) {
    const preview = document.getElementById('preview-container');
    const nodes = Array.from(preview.querySelectorAll('[data-source-line]'));

    let fallbackNode = null;

    for (const node of nodes) {
        const startLine = Number(node.getAttribute('data-source-line') || 1);
        const endLine = Math.max(Number(node.getAttribute('data-source-line-end') || startLine), startLine);

        if (lineNumber >= startLine && lineNumber <= endLine) {
            return node;
        }

        if (!fallbackNode && startLine >= lineNumber) {
            fallbackNode = node;
        }
    }

    return fallbackNode || nodes[nodes.length - 1] || null;
}

function schedulePreviewSync(mode = 'cursor') {
    if (!isEditorReady) return;
    if (!isPreviewActive()) return;
    if (Date.now() < suppressEditorDrivenPreviewSyncUntil) return;

    if (mode === 'cursor') {
        pendingPreviewSyncMode = 'cursor';
    } else if (pendingPreviewSyncMode !== 'cursor') {
        pendingPreviewSyncMode = mode;
    }

    if (previewSyncFrame) return;

    previewSyncFrame = window.requestAnimationFrame(() => {
        const syncMode = pendingPreviewSyncMode;
        pendingPreviewSyncMode = 'cursor';
        previewSyncFrame = null;
        syncPreviewToEditor(syncMode);
    });
}

function resetEditorLineTracking() {
    lastKnownEditorLineCount = getEditorTotalLines();
}

function handleEditorContentChanged() {
    if (suppressDocumentStateSync) return;

    const markdown = window.editor?.getValue ? window.editor.getValue() : '';
    const restoredEntries = restoreRecoveredEntries(markdown);
    if (restoredEntries && window.editor && typeof window.editor.refreshDisplayState === 'function') {
        window.editor.refreshDisplayState();
    }

    setDirty(true);
    lastKnownEditorLineCount = getEditorTotalLines();
    pendingPreviewVisibleLine = getEditorAnchorLineFromCursor();
    scheduleAutoSave();
    if (currentSearchQuery.trim()) {
        renderToolbarSearchResults(currentSearchQuery);
    }
    if (!pendingAttachmentDeleteSnapshot) {
        persistActiveTabState();
    }
    scheduleEditorRender();
}

function scheduleEditorRender() {
    if (editorRenderFrame) return;

    editorRenderFrame = window.requestAnimationFrame(() => {
        editorRenderFrame = null;
        if (isPreviewActive()) {
            updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
        }
        updateOutline();

        if (isPreviewActive() && typeof pendingPreviewVisibleLine === 'number') {
            ensurePreviewLineVisible(pendingPreviewVisibleLine);
            pendingPreviewVisibleLine = null;
        } else if (!isPreviewActive()) {
            pendingPreviewVisibleLine = null;
        }
    });
}

function ensurePreviewLineVisible(lineNumber) {
    const preview = document.getElementById('preview-container');
    if (!preview) return;

    const targetScrollTop = getPreviewScrollTopForLine(lineNumber);
    const maxScrollTop = Math.max(preview.scrollHeight - preview.clientHeight, 0);
    const bottomSafeMargin = Math.min(Math.max(preview.clientHeight * 0.24, 72), 168);
    const visibleBottom = preview.scrollTop + preview.clientHeight - bottomSafeMargin;

    if (targetScrollTop > visibleBottom) {
        const desiredScrollTop = targetScrollTop - (preview.clientHeight - bottomSafeMargin);
        setPreviewScrollTop(Math.min(Math.max(desiredScrollTop, 0), maxScrollTop));
    }
}

function syncPreviewToEditor(mode = 'cursor') {
    const preview = document.getElementById('preview-container');
    if (!preview || !window.editor) return;

    const sourceLine = mode === 'viewport'
        ? getEditorAnchorLineFromViewport()
        : getEditorAnchorLineFromCursor();

    scrollPreviewToSourceLine(sourceLine, mode === 'follow-input' ? 'follow-input' : 'top');
}

function scrollPreviewToSourceLine(lineNumber, align = 'top') {
    const preview = document.getElementById('preview-container');
    const targetScrollTop = getPreviewScrollTopForLine(lineNumber);
    const maxScrollTop = Math.max(preview.scrollHeight - preview.clientHeight, 0);
    const topSafeMargin = Math.min(Math.max(preview.clientHeight * 0.12, 36), 96);
    const bottomSafeMargin = Math.min(Math.max(preview.clientHeight * 0.2, 56), 144);

    if (align === 'center') {
        const centered = targetScrollTop - preview.clientHeight * 0.35;
        setPreviewScrollTop(Math.max(centered, 0));
        return;
    }

    if (align === 'follow-input') {
        const visibleBottom = preview.scrollTop + preview.clientHeight - bottomSafeMargin;

        if (targetScrollTop > visibleBottom) {
            const desiredScrollTop = targetScrollTop - (preview.clientHeight - bottomSafeMargin);
            setPreviewScrollTop(Math.min(Math.max(desiredScrollTop, 0), maxScrollTop));
        }

        return;
    }

    if (targetScrollTop >= maxScrollTop - topSafeMargin) {
        setPreviewScrollTop(maxScrollTop);
        return;
    }

    setPreviewScrollTop(Math.max(targetScrollTop - topSafeMargin, 0));
}

function setPreviewScrollTop(value) {
    const preview = document.getElementById('preview-container');
    isSyncingPreviewScroll = true;
    suppressPreviewScrollSyncUntil = Date.now() + 120;
    preview.scrollTop = Math.max(value, 0);
    window.setTimeout(() => {
        isSyncingPreviewScroll = false;
    }, 120);
}

function getPreviewScrollTopForLine(lineNumber) {
    const preview = document.getElementById('preview-container');
    const anchors = getPreviewLineAnchors();
    const maxScrollTop = Math.max(preview.scrollHeight - preview.clientHeight, 0);

    if (!anchors.length) {
        return 0;
    }

    if (lineNumber <= anchors[0].line) {
        return 0;
    }

    for (let i = 0; i < anchors.length - 1; i++) {
        const current = anchors[i];
        const next = anchors[i + 1];

        if (lineNumber <= next.line) {
            const span = Math.max(next.line - current.line, 1);
            const ratio = Math.min(Math.max((lineNumber - current.line) / span, 0), 1);
            const interpolatedTop = current.top + (next.top - current.top) * ratio;
            return Math.min(Math.max(interpolatedTop, 0), maxScrollTop);
        }
    }

    return maxScrollTop;
}

function getPreviewLineAnchors() {
    const preview = document.getElementById('preview-container');
    const nodes = Array.from(preview.querySelectorAll('[data-source-line]'));
    const previewPaddingTop = 30;
    const anchors = [];

    for (const node of nodes) {
        const startLine = Number(node.getAttribute('data-source-line') || 1);
        const endLine = Math.max(Number(node.getAttribute('data-source-line-end') || startLine), startLine);
        const top = Math.max(node.offsetTop - previewPaddingTop, 0);
        const bottom = Math.max(node.offsetTop + node.offsetHeight - previewPaddingTop, top);
        const lineSpan = Math.max(endLine - startLine, 1);

        for (let line = startLine; line <= endLine; line++) {
            const ratio = (line - startLine) / lineSpan;
            const lineTop = top + (bottom - top) * ratio;
            const lastAnchor = anchors[anchors.length - 1];

            if (!lastAnchor || lastAnchor.line !== line) {
                anchors.push({ line, top: lineTop });
            }
        }
    }

    const totalLines = getEditorTotalLines();
    const maxScrollTop = Math.max(preview.scrollHeight - preview.clientHeight, 0);

    if (!anchors.length || anchors[0].line > 1) {
        anchors.unshift({ line: 1, top: 0 });
    } else {
        anchors[0].top = 0;
    }

    const virtualBottomLine = Math.max(totalLines + 1, anchors[anchors.length - 1].line + 1);
    anchors.push({ line: virtualBottomLine, top: maxScrollTop });

    return anchors;
}

function getEditorAnchorLineFromCursor() {
    if (!window.editor) return 1;

    if (typeof window.editor.getAnchorLineFromCursor === 'function') {
        return window.editor.getAnchorLineFromCursor();
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        return getPositionAtOffset(fallbackTextarea.value, fallbackTextarea.selectionStart).lineNumber;
    }

    const position = window.editor.getPosition ? window.editor.getPosition() : null;
    return position ? position.lineNumber : 1;
}

function getEditorAnchorLineFromViewport() {
    if (!window.editor) return 1;

    if (typeof window.editor.getAnchorLineFromViewport === 'function') {
        return window.editor.getAnchorLineFromViewport();
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        const style = window.getComputedStyle(fallbackTextarea);
        const lineHeight = parseFloat(style.lineHeight) || 26;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const viewportAnchorY = fallbackTextarea.scrollTop + paddingTop + fallbackTextarea.clientHeight * 0.35;
        const lineNumber = Math.floor(Math.max(viewportAnchorY - paddingTop, 0) / Math.max(lineHeight, 1)) + 1;
        return clamp(lineNumber, 1, getEditorTotalLines());
    }

    const visibleRanges = window.editor.getVisibleRanges ? window.editor.getVisibleRanges() : [];
    if (!visibleRanges.length) {
        return 1;
    }

    const range = visibleRanges[0];
    const anchorLine = Math.round(range.startLineNumber + (range.endLineNumber - range.startLineNumber) * 0.35);
    return clamp(anchorLine, 1, getEditorTotalLines());
}

function getEditorTotalLines() {
    if (!window.editor || !window.editor.getValue) return 1;
    return window.editor.getValue().split('\n').length;
}

function jumpEditorToLine(lineNumber, options = {}) {
    if (!window.editor) return;
    const { preservePreviewScroll = false, preferredText = '', preferredKind = '' } = options;

    if (preservePreviewScroll) {
        suppressEditorDrivenPreviewSyncUntil = Date.now() + 300;
    }

    highlightEditorLine(lineNumber);

    if (typeof window.editor.jumpToLine === 'function') {
        window.editor.jumpToLine(lineNumber, { preferredText, preferredKind });
        return;
    }

    if (isUsingFallbackEditor && fallbackTextarea) {
        const index = getIndexFromLineAndColumn(fallbackTextarea.value, lineNumber, 1);
        fallbackTextarea.focus();
        fallbackTextarea.setSelectionRange(index, index);
        const style = window.getComputedStyle(fallbackTextarea);
        const lineHeight = parseFloat(style.lineHeight) || 26;
        const paddingTop = parseFloat(style.paddingTop) || 0;
        const topSafeMargin = Math.max(lineHeight * 2, paddingTop);
        const targetTop = paddingTop + (lineNumber - 1) * lineHeight;
        fallbackTextarea.scrollTop = Math.max(targetTop - topSafeMargin, 0);
        return;
    }

    if (typeof window.editor.revealPositionInCenter === 'function') {
        window.editor.revealPositionInCenter({ lineNumber, column: 1 });
    } else if (typeof window.editor.revealLineInCenter === 'function') {
        window.editor.revealLineInCenter(lineNumber);
    } else if (typeof window.editor.revealLineNearTop === 'function') {
        window.editor.revealLineNearTop(lineNumber);
    }

    if (typeof window.editor.setPosition === 'function') {
        window.editor.setPosition({ lineNumber, column: 1 });
    }

    if (typeof window.editor.focus === 'function') {
        window.editor.focus();
    }
}

function jumpEditorToAnchor(kind, kindIndex, options = {}) {
    if (!window.editor) return;

    if (typeof window.editor.jumpToAnchor === 'function') {
        window.editor.jumpToAnchor(kind, kindIndex, options);
        highlightEditorLine(options.lineNumber || 1);
        return;
    }

    jumpEditorToLine(options.lineNumber || 1, options);
}

function highlightEditorLine(lineNumber) {
    activeEditorHighlightLine = lineNumber;

    if (window.editor && typeof window.editor.highlightLine === 'function') {
        window.editor.highlightLine(lineNumber);
        return;
    }

    if (clearEditorHighlightTimer) {
        window.clearTimeout(clearEditorHighlightTimer);
    }

    if (!isUsingFallbackEditor && monacoLineHighlightCollection && typeof monaco !== 'undefined') {
        monacoLineHighlightCollection.set([{
            range: new monaco.Range(lineNumber, 1, lineNumber, 1),
            options: {
                isWholeLine: true,
                className: 'codex-active-line-highlight'
            }
        }]);
    } else if (fallbackTextarea) {
        const highlightLayer = document.querySelector('.fallback-highlight');
        if (highlightLayer) {
            renderFallbackHighlight(fallbackTextarea, highlightLayer);
        }
    }

    clearEditorHighlightTimer = window.setTimeout(() => {
        activeEditorHighlightLine = null;

        if (!isUsingFallbackEditor && monacoLineHighlightCollection) {
            monacoLineHighlightCollection.clear();
        } else if (fallbackTextarea) {
            const highlightLayer = document.querySelector('.fallback-highlight');
            if (highlightLayer) {
                renderFallbackHighlight(fallbackTextarea, highlightLayer);
            }
        }
    }, 1200);
}


// ==============================
// UI 绑定
// ==============================
document.getElementById('sidebar-tab-workspace').addEventListener('click', () => setSidebarTab('workspace'));
document.getElementById('sidebar-tab-outline').addEventListener('click', () => setSidebarTab('outline'));
document.getElementById('sidebar-tab-todo').addEventListener('click', () => setSidebarTab('todo'));
document.getElementById('sidebar-tab-attachment').addEventListener('click', () => setSidebarTab('attachment'));
setupSidebarResizeHandle();
document.getElementById('editor-tabs').addEventListener('click', async (event) => {
    const closeButton = event.target.closest('[data-tab-close]');
    if (closeButton) {
        event.stopPropagation();
        await closeEditorTab(closeButton.dataset.tabClose);
        return;
    }

    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    activateTab(tabButton.dataset.tabId);
});
document.getElementById('editor-tabs').addEventListener('dragstart', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    draggedEditorTabId = tabButton.dataset.tabId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedEditorTabId);
});
document.getElementById('editor-tabs').addEventListener('dragover', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton || !draggedEditorTabId || tabButton.dataset.tabId === draggedEditorTabId) return;

    event.preventDefault();
    clearTabDragIndicators();

    const rect = tabButton.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;
    tabButton.classList.add(placeAfter ? 'drag-over-right' : 'drag-over-left');
});
document.getElementById('editor-tabs').addEventListener('drop', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton || !draggedEditorTabId || tabButton.dataset.tabId === draggedEditorTabId) {
        clearTabDragIndicators();
        draggedEditorTabId = null;
        return;
    }

    event.preventDefault();
    const rect = tabButton.getBoundingClientRect();
    const placeAfter = event.clientX > rect.left + rect.width / 2;
    reorderEditorTabs(draggedEditorTabId, tabButton.dataset.tabId, placeAfter);
    clearTabDragIndicators();
    draggedEditorTabId = null;
});
document.getElementById('editor-tabs').addEventListener('dragend', () => {
    clearTabDragIndicators();
    draggedEditorTabId = null;
});
document.getElementById('editor-tabs').addEventListener('dragleave', (event) => {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    clearTabDragIndicators();
});
document.getElementById('editor-tabs').addEventListener('contextmenu', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    event.preventDefault();
    showTabContextMenu(event, tabButton.dataset.tabId);
});
document.getElementById('tab-add-button').addEventListener('click', () => {
    void createEmptyTab();
});
document.getElementById('tab-menu-open-folder').addEventListener('click', async () => {
    const targetTabId = tabContextTargetId;
    hideTabContextMenu();
    await openTabFolder(targetTabId);
});
document.getElementById('tab-menu-export-html').addEventListener('click', async () => {
    const targetTabId = tabContextTargetId || activeTabId;
    hideTabContextMenu();
    await handleExportHtml(targetTabId);
});
document.getElementById('workspace-menu-open-bundle').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.openTarget) return;
    await openWorkspaceBundle(target.openTarget);
});
document.getElementById('workspace-menu-new-bundle').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    await createBundleInWorkspace(target?.createTarget || workspaceRootPath);
});
document.getElementById('workspace-menu-new-folder').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    await createFolderInWorkspace(target?.createTarget || workspaceRootPath);
});
document.getElementById('workspace-menu-rename').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.path) return;
    beginWorkspaceInlineRename(target.path);
});
document.getElementById('workspace-menu-open-folder').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    await revealWorkspaceTarget(target?.revealTarget || workspaceRootPath);
});
document.getElementById('workspace-menu-delete').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    await deleteWorkspaceEntry(target);
});
document.getElementById('editor-link-menu-open').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await openEditorLinkTarget(target);
});
document.getElementById('editor-link-menu-open-with').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await openEditorLinkWithChosenApp(target);
});
document.getElementById('editor-link-menu-reveal').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await revealEditorLinkTarget(target);
});
document.getElementById('editor-link-menu-rename').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await renameEditorLinkTarget(target);
});
document.getElementById('editor-link-menu-delete').addEventListener('click', () => {
    deleteSelectedEditorLink();
});
document.querySelectorAll('.view-toggle-button').forEach((button) => {
    button.addEventListener('click', () => {
        saveViewModePreference(button.dataset.viewMode);
    });
});
document.getElementById('attachment-menu-open').addEventListener('click', async () => {
    const target = attachmentContextTarget;
    hideAttachmentContextMenu();
    await openAttachmentTarget(target);
});
document.getElementById('attachment-menu-reveal').addEventListener('click', async () => {
    const target = attachmentContextTarget;
    hideAttachmentContextMenu();
    await revealAttachmentTarget(target);
});
document.getElementById('attachment-menu-rename').addEventListener('click', async () => {
    const target = attachmentContextTarget;
    hideAttachmentContextMenu();
    await renameAttachmentTarget(target);
});
document.getElementById('preview-image-menu-copy').addEventListener('click', () => {
    const target = previewImageContextTarget;
    hidePreviewImageContextMenu();
    copyPreviewImage(target);
});
document.getElementById('preview-image-menu-reveal').addEventListener('click', async () => {
    const target = previewImageContextTarget;
    hidePreviewImageContextMenu();
    await revealPreviewImageInFolder(target);
});
document.getElementById('preview-image-menu-open-with').addEventListener('click', async () => {
    const target = previewImageContextTarget;
    hidePreviewImageContextMenu();
    await openPreviewImageWithChosenApp(target);
});
document.getElementById('toolbar-search-input').addEventListener('input', (event) => {
    renderToolbarSearchResults(event.target.value);
});
document.getElementById('toolbar-search-input').addEventListener('focus', (event) => {
    if (event.target.value.trim()) {
        renderToolbarSearchResults(event.target.value);
    }
});
document.getElementById('toolbar-search-scope').addEventListener('click', () => {
    if (!workspaceRootPath) {
        currentSearchScope = 'document';
        updateEditorEmptyState();
        return;
    }
    currentSearchScope = currentSearchScope === 'workspace' ? 'document' : 'workspace';
    updateEditorEmptyState();
    renderToolbarSearchResults(document.getElementById('toolbar-search-input').value || '');
});
document.getElementById('toolbar-search-input').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        document.getElementById('toolbar-search-results').classList.remove('show');
        activeSearchMatchIndex = -1;
        event.target.blur();
        return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (!currentSearchMatches.length) return;
        event.preventDefault();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const nextIndex = activeSearchMatchIndex < 0
            ? (direction > 0 ? 0 : currentSearchMatches.length - 1)
            : (activeSearchMatchIndex + direction + currentSearchMatches.length) % currentSearchMatches.length;
        setActiveSearchMatchIndex(nextIndex);
        return;
    }

    if (event.key === 'Enter') {
        const targetMatch = currentSearchMatches[
            activeSearchMatchIndex >= 0 ? activeSearchMatchIndex : 0
        ];
        if (targetMatch) {
            event.preventDefault();
            document.getElementById('toolbar-search-results').classList.remove('show');
            void jumpToSearchMatch(targetMatch);
        }
    }
});
document.querySelectorAll('#editor-toolbar .editor-toolbar-button').forEach((button) => {
    button.addEventListener('click', () => {
        runEditorToolbarCommand(button.dataset.tool, {
            level: button.dataset.level
        });
    });
});
updateSidebarToggleButton();
document.getElementById('todo-scope-select').addEventListener('change', (event) => {
    updateTodoPanelSettings({ scope: event.target.value });
});
document.getElementById('todo-sort-select').addEventListener('change', (event) => {
    updateTodoPanelSettings({ sort: event.target.value });
});
document.getElementById('todo-hide-completed').addEventListener('change', (event) => {
    updateTodoPanelSettings({ hideCompleted: event.target.checked });
});
document.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.tab));
});
document.getElementById('settings-cancel-btn').addEventListener('click', () => closeSettingsModal());
document.getElementById('settings-save-btn').addEventListener('click', () => handleSaveSettings());
document.getElementById('settings-reset-btn').addEventListener('click', () => resetLayoutSettings());
document.getElementById('settings-modal').addEventListener('click', (event) => {
    if (event.target.id === 'settings-modal') {
        closeSettingsModal();
    }
});
ipcRenderer.on('bundle:openExternal', (_, folderPath) => {
    void openBundleFromExternalPath(folderPath);
});

ipcRenderer.on('menu:action', async (_, action) => {
    switch (action) {
    case 'new':
        await handleNewBundle();
        break;
    case 'open':
        await handleOpenBundle();
        break;
    case 'newInWorkspace':
        await handleNewBundleInWorkspace();
        break;
    case 'openFolder':
        await handleOpenWorkspaceFolder();
        break;
    case 'closeFolder':
        handleCloseWorkspaceFolder();
        break;
    case 'importMarkdownFolder':
        await handleImportMarkdownFolder();
        break;
    case 'save':
        await saveFile();
        break;
    case 'saveAs':
        await handleSaveAs();
        break;
    case 'exportHtml':
        await handleExportHtml();
        break;
    case 'settings':
        openSettingsModal();
        break;
    default:
        break;
    }
});

window.addEventListener('load', async () => {
    syncTodoPanelControls();
    const pendingBundlePath = await ipcRenderer.invoke('bundle:getPendingOpen');
    if (pendingBundlePath) {
        void openBundleFromExternalPath(pendingBundlePath, { skipConfirm: true });
    }
});
document.addEventListener('click', () => hideAttachmentContextMenu());
document.addEventListener('click', () => hidePreviewImageContextMenu());
document.addEventListener('click', () => hideTabContextMenu());
document.addEventListener('click', () => hideWorkspaceContextMenu());
document.addEventListener('click', () => hideEditorLinkContextMenu());
document.addEventListener('click', (event) => {
    if (event.target.closest('.preview-image-resizer')) return;
    clearSelectedPreviewImage();
});
document.addEventListener('click', (event) => {
    if (event.target.closest('.toolbar-search')) return;
    document.getElementById('toolbar-search-results').classList.remove('show');
    activeSearchMatchIndex = -1;
});
applyPlatformSpecificUi();
window.addEventListener('blur', () => {
    hideAttachmentContextMenu();
    hidePreviewImageContextMenu();
    hideTabContextMenu();
    hideWorkspaceContextMenu();
    hideEditorLinkContextMenu();
    closeSettingsModal();
    clearSelectedPreviewImage();
    finishActivePreviewImageResize();
    document.getElementById('toolbar-search-results').classList.remove('show');
});

window.__codexConfirmBeforeClose = async function () {
    const shouldClose = await confirmAllTabsBeforeClose();
    if (shouldClose) {
        for (const tab of editorTabs) {
            if (tab.path) {
                cleanupRecoveryDir(tab.path);
            }
        }
    }
    return shouldClose;
};

function updateOutline() {
    if (!window.editor) return;

    const content = window.editor.getValue();
    const outlineContainer = document.getElementById('outline-container');
    outlineContainer.innerHTML = '';
    renderTodoList(content);
    renderAttachmentList(content);

    // Regex to find headings (e.g., # Heading)
    const headingRegex = /^(?:(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+)?(#{1,6})\s+(.+)$/gm;
    let match;

    while ((match = headingRegex.exec(content)) !== null) {
        const level = match[1].length;
        const title = match[2];
        const lineNumber = getLineNumberAtOffset(content, match.index);

        const item = document.createElement('div');
        item.className = `outline-item level-${level}`;
        item.innerText = title;

        item.onclick = () => {
            jumpEditorToLine(lineNumber, {
                preservePreviewScroll: true,
                preferredText: title,
                preferredKind: 'heading'
            });
        };

        outlineContainer.appendChild(item);
    }

    if (!outlineContainer.children.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '当前文档还没有标题，写下 # 标题 后这里就会显示大纲。';
        outlineContainer.appendChild(emptyState);
    }
}
