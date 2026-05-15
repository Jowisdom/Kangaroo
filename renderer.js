const fs = window.nodeRequire('fs');
const path = window.nodeRequire('path');
const url = window.nodeRequire('url');
const os = window.nodeRequire('os');
const processRef = window.nodeRequire('process');
const { ipcRenderer, clipboard, webUtils, nativeImage } = window.nodeRequire('electron');
const https = window.nodeRequire('https');
const http = window.nodeRequire('http');
const crypto = window.nodeRequire('crypto');
const MarkdownIt = window.nodeRequire('markdown-it');
const { DOMSerializer, Slice } = window.nodeRequire('@tiptap/pm/model');
const { createWysiwygEditor } = window.nodeRequire(path.join(__dirname, 'wysiwyg-editor.js'));

function revokeRendererNodeGlobals() {
    for (const key of ['nodeRequire', 'require', 'module', 'exports']) {
        try {
            delete window[key];
        } catch {
            try {
                window[key] = undefined;
            } catch {
                // ignore locked globals
            }
        }
    }
}

revokeRendererNodeGlobals();

let markdownRenderer = null;
const IS_MACOS = processRef.platform === 'darwin';
const KANGAROO_INTERNAL_SLICE_MIME = 'application/x-kangaroo-slice+json';
const KANGAROO_WORKSPACE_ENTRY_MIME = 'application/x-kangaroo-workspace-entry+json';
const DEFAULT_BUNDLE_EXTENSION = '.kangaroo';
const LEGACY_BUNDLE_EXTENSIONS = ['.textbundle'];
const DEFAULT_BUNDLE_MARKDOWN_FILE = 'text.md';
const LEGACY_BUNDLE_MARKDOWN_FILE = 'text.markdown';
const PRIVATE_BUNDLE_MANIFEST_FILE = 'manifest.json';
const PRIVATE_BUNDLE_DOCUMENT_FILE = 'document.json';
const IMAGE_RESOURCE_DIR_NAME = 'images';
const LEGACY_IMAGE_RESOURCE_DIR_NAME = 'assets';
const RICH_TEXT_EDITOR_ONLY = true;
const APP_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'))?.version || '';
    } catch {
        return '';
    }
})();

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
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'zotero:']);
const ALLOWED_IMAGE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'data:']);
const REMOTE_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const REMOTE_IMAGE_TIMEOUT_MS = 15000;

function stripKnownBundleExtension(value) {
    let name = String(value || '').trim();
    for (const extension of [DEFAULT_BUNDLE_EXTENSION, ...LEGACY_BUNDLE_EXTENSIONS]) {
        if (name.toLowerCase().endsWith(extension)) {
            name = name.slice(0, -extension.length);
            break;
        }
    }
    return name;
}

function sanitizeFileNameSegment(value, fallback = '未命名文档') {
    const sanitized = String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '')
        .trim();
    return sanitized || fallback;
}

function cloneSerializableValue(value) {
    if (value == null) return null;

    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function clampNumber(value, min, max) {
    const num = Number(value);
    if (Number.isNaN(num)) {
        return min;
    }
    return Math.min(Math.max(num, min), max);
}

function getBundleManifestPath(folderPath) {
    return folderPath ? path.join(folderPath, PRIVATE_BUNDLE_MANIFEST_FILE) : '';
}

function getBundleDocumentJsonPath(folderPath) {
    return folderPath ? path.join(folderPath, PRIVATE_BUNDLE_DOCUMENT_FILE) : '';
}

function readJsonFileIfExists(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch {
        return null;
    }
}

function getImageResourceDirPath(folderPath) {
    return folderPath ? path.join(folderPath, 'attachments', IMAGE_RESOURCE_DIR_NAME) : '';
}

function getOldImageResourceDirPath(folderPath) {
    return folderPath ? path.join(folderPath, IMAGE_RESOURCE_DIR_NAME) : '';
}

function getLegacyImageResourceDirPath(folderPath) {
    return folderPath ? path.join(folderPath, LEGACY_IMAGE_RESOURCE_DIR_NAME) : '';
}

function getImageResourceDirCandidates(folderPath) {
    const candidates = [];
    const modernDir = getImageResourceDirPath(folderPath);
    const oldRootDir = getOldImageResourceDirPath(folderPath);
    const legacyDir = getLegacyImageResourceDirPath(folderPath);

    if (modernDir) candidates.push(modernDir);
    if (oldRootDir) candidates.push(oldRootDir);
    if (legacyDir) candidates.push(legacyDir);

    return candidates;
}

function resolveExistingImageResourceDir(folderPath) {
    for (const candidate of getImageResourceDirCandidates(folderPath)) {
        if (candidate && fs.existsSync(candidate)) {
            try {
                const entries = fs.readdirSync(candidate);
                if (entries.length > 0) {
                    return candidate;
                }
            } catch {
                return candidate;
            }
        }
    }

    for (const candidate of getImageResourceDirCandidates(folderPath)) {
        if (candidate && fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return getImageResourceDirPath(folderPath);
}

function getBundleDisplayTitleFromManifest(folderPath) {
    const manifest = readJsonFileIfExists(getBundleManifestPath(folderPath));
    if (manifest && typeof manifest.title === 'string' && manifest.title.trim()) {
        return manifest.title.trim();
    }

    return getCanonicalBundleDisplayName(folderPath);
}

function buildBundleManifest(folderPath, options = {}) {
    const now = new Date().toISOString();
    const existingManifest = options.existingManifest && typeof options.existingManifest === 'object'
        ? options.existingManifest
        : null;
    const title = String(options.title || existingManifest?.title || getCanonicalBundleDisplayName(folderPath) || '未命名').trim() || '未命名';

    return {
        format: 'kangaroo',
        formatVersion: 1,
        appVersion: APP_VERSION || processRef?.versions?.electron || '',
        documentId: String(existingManifest?.documentId || options.documentId || crypto.randomUUID()),
        title,
        createdAt: existingManifest?.createdAt || now,
        updatedAt: now,
        defaultLanguage: 'markdown',
        rootBlockId: 'root',
        documentFormat: 'tiptap-json'
    };
}

function writeJsonFile(filePath, data) {
    if (!filePath) return false;
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    return true;
}

function createDocumentJsonFromMarkdown(markdown) {
    if (!markdown && markdown !== '') {
        return null;
    }

    const scratchHost = document.createElement('div');
    scratchHost.style.position = 'fixed';
    scratchHost.style.left = '-99999px';
    scratchHost.style.top = '-99999px';
    scratchHost.style.width = '1px';
    scratchHost.style.height = '1px';
    scratchHost.style.overflow = 'hidden';
    scratchHost.style.pointerEvents = 'none';
    document.body.appendChild(scratchHost);

    try {
        const scratchEditor = createWysiwygEditor(scratchHost, String(markdown || ''));
        const documentJson = cloneSerializableValue(scratchEditor.getDocumentJson?.());
        scratchEditor.destroy();
        return documentJson;
    } catch {
        try {
            scratchHost.remove();
        } catch {
            // ignore cleanup failure
        }
        return null;
    } finally {
        try {
            scratchHost.remove();
        } catch {
            // ignore cleanup failure
        }
    }
}

function serializeDocumentJsonToMarkdown(documentJson) {
    const normalizedDocumentJson = cloneSerializableValue(documentJson);
    if (!normalizedDocumentJson) {
        return '';
    }

    const scratchHost = document.createElement('div');
    scratchHost.style.position = 'fixed';
    scratchHost.style.left = '-99999px';
    scratchHost.style.top = '-99999px';
    scratchHost.style.width = '1px';
    scratchHost.style.height = '1px';
    scratchHost.style.overflow = 'hidden';
    scratchHost.style.pointerEvents = 'none';
    document.body.appendChild(scratchHost);

    try {
        const scratchEditor = createWysiwygEditor(scratchHost, '');
        if (!scratchEditor?.setDocumentJson || !scratchEditor?.getValue) {
            scratchEditor?.destroy?.();
            return '';
        }

        const didApply = scratchEditor.setDocumentJson(normalizedDocumentJson, {
            emitChange: false,
            forceRebuild: true
        });
        const markdown = didApply ? String(scratchEditor.getValue() || '') : '';
        scratchEditor.destroy();
        return markdown;
    } catch {
        return '';
    } finally {
        try {
            scratchHost.remove();
        } catch {
            // ignore cleanup failure
        }
    }
}

function isPrivateBundlePath(folderPath) {
    if (!folderPath) return false;

    try {
        const manifestPath = getBundleManifestPath(folderPath);
        const documentJsonPath = getBundleDocumentJsonPath(folderPath);
        return fs.existsSync(manifestPath) && fs.existsSync(documentJsonPath);
    } catch {
        return false;
    }
}

function isSupportedBundleName(name) {
    const ext = path.extname(String(name || '')).toLowerCase();
    return ext === DEFAULT_BUNDLE_EXTENSION || LEGACY_BUNDLE_EXTENSIONS.includes(ext);
}

function getCanonicalBundleDisplayName(bundlePath) {
    const baseName = stripKnownBundleExtension(path.basename(String(bundlePath || '')));
    return baseName || '未命名';
}

function getHrefProtocol(value) {
    const href = String(value || '').trim();
    if (!href || href.startsWith('#')) return '';

    try {
        return new URL(href, 'file:///').protocol.toLowerCase();
    } catch {
        return '';
    }
}

function isAllowedExternalHref(value) {
    const href = String(value || '').trim();
    if (!href) return false;

    const protocol = getHrefProtocol(href);
    if (!protocol || protocol === 'file:') return true;
    return ALLOWED_EXTERNAL_PROTOCOLS.has(protocol);
}

function isAllowedImageSource(value) {
    const src = String(value || '').trim();
    if (!src) return false;

    if (src.startsWith('data:')) {
        return /^data:image\//i.test(src);
    }

    const protocol = getHrefProtocol(src);
    return !protocol || ALLOWED_IMAGE_PROTOCOLS.has(protocol);
}

function sanitizeRenderedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');

    const blockedTags = new Set([
        'script',
        'iframe',
        'object',
        'embed',
        'base',
        'link',
        'meta',
        'form',
        'button',
        'textarea',
        'select',
        'option'
    ]);

    for (const element of Array.from(template.content.querySelectorAll('*'))) {
        const tagName = element.tagName.toLowerCase();
        if (blockedTags.has(tagName)) {
            element.remove();
            continue;
        }

        for (const attribute of Array.from(element.attributes)) {
            const attrName = attribute.name.toLowerCase();
            const attrValue = attribute.value || '';

            if (attrName.startsWith('on') || attrName === 'srcdoc') {
                element.removeAttribute(attribute.name);
                continue;
            }

            if ((attrName === 'href' || attrName === 'xlink:href') && !isAllowedExternalHref(attrValue)) {
                element.removeAttribute(attribute.name);
                continue;
            }

            if (attrName === 'src' && !isAllowedImageSource(attrValue)) {
                element.removeAttribute(attribute.name);
                continue;
            }

            if (attrName === 'style' && /(?:url\s*\(|expression\s*\(|javascript:)/i.test(attrValue)) {
                element.removeAttribute(attribute.name);
            }
        }

        if (tagName === 'input') {
            const type = String(element.getAttribute('type') || '').toLowerCase();
            if (type !== 'checkbox') {
                element.remove();
            }
        }
    }

    return template.innerHTML;
}

function getMarkdownRenderer() {
    if (markdownRenderer) {
        return markdownRenderer;
    }

    const md = new MarkdownIt({
        html: true,
        linkify: true,
        breaks: true,
        validateLink: isAllowedExternalHref
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

            const taskMatch = token.content.match(/^\[([ xX])\](?:\s+|$)/);
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
let lastPreviewRenderKey = '';
let lastKnownEditorLineCount = 1;
let workspaceTodoRenderVersion = 0;
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
window.__kangarooPendingEditorNodeDrag = null;
let editorRenderFrame = null;
let autoSaveTimer = null;
let persistActiveTabTimer = null;
let persistActiveTabTimerContext = null;
let toolbarStateRefreshFrame = null;
let editorTabs = [];
let activeTabId = null;
let nextEditorTabId = 1;
let currentSidebarTab = 'workspace';
let expandedAttachmentEntries = new Set();
let attachmentContextTarget = null;
let previewImageContextTarget = null;
let tabContextTargetId = null;
let editorLinkContextTarget = null;
let timelineDayContextTarget = null;
let timelineDiaryContextTarget = null;
let timelineTodoContextTarget = null;
let timelineTodoDragState = null;
let timelineTodoDropState = null;
let timelineTodoEditState = null;
let pendingTimelineTodoInlineEditTarget = null;
let suppressContextMenuHideUntil = 0;
let selectedPreviewImageKey = null;
let activePreviewImageResize = null;
let pendingPreviewVisibleLine = null;
let currentSettingsTab = 'theme';
let textInputModalState = null;
let currentSearchQuery = '';
let currentSearchMatches = [];
let activeSearchMatchIndex = -1;
let currentSearchScope = 'document';
let suppressDocumentStateSync = false;
let draggedEditorTabId = null;
let draggedSidebarRailItem = null;
let workspaceRootPath = null;
let expandedWorkspaceEntries = new Set();
let workspaceContextTarget = null;
let workspaceSelectedEntryPath = null;
let draggedWorkspaceEntry = null;
let workspaceRenameTargetPath = null;
let suppressNextWorkspaceRenameBlurCommit = false;
let workspaceWatchers = [];
let workspaceRefreshTimer = null;
let workspaceBusyMessage = '';
let importProgressModalState = null;
let importProgressModalFrame = null;
let workspaceRefreshSuspended = 0;
let workspaceRefreshPending = false;
let workspaceTreeRenderVersion = 0;
let suppressWorkspaceWatcherUntil = 0;
let workspaceRevealFlashPath = null;
let workspaceRevealFlashTimer = null;
let bundleAttachmentWatchers = [];
let bundleAttachmentWatchTimer = null;
let bundleAttachmentPollTimer = null;
let suppressBundleAttachmentWatcherUntil = 0;
let bundleAttachmentSnapshot = new Map();
let bundleAttachmentSnapshotRoot = null;
let activeHistoryTransaction = null;
let suppressHistoryRecording = false;
let nextHistoryEntryId = 1;
let attachmentInlineRenameState = null;
let pendingAttachmentDeleteSnapshot = null;
let pendingAttachmentRenameSnapshot = null;
let pendingEditorClipboardSlicePayload = null;
let pendingEditorClipboardSliceTimestamp = 0;
let editorChangeToken = 0;
const DEBUG_TEST_SHORTCUTS_ENABLED = typeof process !== 'undefined'
    && process
    && process.env
    && process.env.KANGAROO_DEBUG_SHORTCUTS === '1';
let workspaceTreeSortSettings = null;
let workspaceManualDropPlacement = 'before';
let workspaceFolderDropIntentPath = null;
let workspaceFolderDropIntentReady = false;
let workspaceFolderDropIntentTimer = null;
let timelinePanelOpen = false;
let currentRightSidebarTab = 'timeline';
let timelinePanelNeedsRender = true;
let timelinePanelRenderFrame = null;
let timelineCalendarMonthCursor = null;
let timelineFilterMode = 'day';
let timelineFilterAnchor = null;
let timelineEntryFilterMode = 'all';
let pomodoroState = null;
let pomodoroTickTimer = null;
let pomodoroTaskPickerOpen = false;
let pomodoroCustomSettingsOpen = false;
let pomodoroSelectedMode = 'focus';
let workspaceTimelineEntriesCache = null;
let workspaceTimelineEntriesCacheRoot = null;
let workspaceTimelineEntriesCacheDirty = true;
let workspaceChildrenCache = new Map();
let workspaceBundlePathsCache = null;
let workspaceBundlePathsCacheRoot = null;
let workspaceBundlePathsCacheDirty = true;
let pendingWorkspaceRevealPath = null;
let skipEnsureActiveWorkspacePathExpandedOnce = false;
let featureVisibilitySettings = null;
let persistWorkspaceMusicPlaybackTimer = null;
let lastAutomaticHistorySnapshotAt = 0;
let selectedHistorySnapshotId = '';
let pendingHistoryRestore = null;
let renderedHistoryBundlePath = '';
let historyPanelDetailRenderToken = 0;
let historyPanelDetailRenderTimer = null;

const AUTO_SAVE_DELAY = 350;
const RECOVERY_DIR_NAME = '.kangaroo-recovery';
const LEGACY_RECOVERY_DIR_NAMES = ['recovery', '.kangaroo-recoery'];
const SESSION_HISTORY_DIR_NAME = '.kangaroo-session-history';
const HISTORY_DIR_NAME = '.kangaroo-history';
const HISTORY_MANIFEST_FILE = 'manifest.json';
const HISTORY_SNAPSHOT_DIR = 'snapshots';
const HISTORY_FILE_POOL_DIR = 'files';
const HISTORY_MAX_SNAPSHOTS = 50;
const HISTORY_AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;
const HISTORY_FEATURE_ENABLED = false;
const LAYOUT_SETTINGS_KEY = 'codex.layout.settings.v1';
const SIDEBAR_VISIBILITY_SETTINGS_KEY = 'codex.sidebar.visibility.v1';
const TOOLBAR_VISIBILITY_SETTINGS_KEY = 'codex.toolbar.visibility.v1';
const VIEW_MODE_SETTINGS_KEY = 'codex.view.mode.v1';
const THEME_SETTINGS_KEY = 'codex.theme.settings.v1';
const TYPOGRAPHY_SETTINGS_KEY = 'codex.typography.settings.v1';
const INLINE_MEDIA_POSITION_SETTINGS_KEY = 'codex.inline.media.position.v1';
const FEATURE_VISIBILITY_SETTINGS_KEY = 'codex.feature.visibility.v1';
const SIDEBAR_RAIL_ORDER_SETTINGS_KEY = 'codex.sidebar.rail.order.v1';
const WORKSPACE_TREE_SORT_SETTINGS_KEY = 'codex.workspace.tree.sort.v1';
const TIMELINE_PANEL_VISIBILITY_SETTINGS_KEY = 'codex.timeline.visibility.v1';
const POMODORO_STATE_SETTINGS_KEY = 'codex.pomodoro.state.v1';
const pendingTodoCheckedUpdates = new Map();
const WORKSPACE_TIMELINE_EVENTS_FILE = '.kangaroo-timeline.json';
const WORKSPACE_CHILDREN_CACHE_TTL = 1200;
const WORKSPACE_BUNDLE_PATHS_CACHE_TTL = 1200;
const WORKSPACE_ALBUM_PATHS_CACHE_TTL = 1200;
const WORKSPACE_VIDEO_PATHS_CACHE_TTL = 1200;
const DEFAULT_THEME_ID = 'dark-ocean';
const DEFAULT_UNTITLED_CONTENT = '';
const DEFAULT_VIEW_MODE = 'editor';
const WORKSPACE_SETTINGS_KEY = 'codex.workspace.root.v1';
const TODO_PANEL_SETTINGS_KEY = 'codex.todo.panel.v1';
const TIMELINE_TODO_GROUP_SETTINGS_KEY = 'codex.timeline.todo.groups.v1';
const PINNED_EDITOR_TABS_KEY = 'codex.editor.tabs.pinned.v1';
const DEFAULT_LAYOUT_SETTINGS = {
    sidebarWidth: 30,
    editorWidth: 76,
    previewWidth: 46
};
const DEFAULT_INLINE_MEDIA_POSITION_SETTINGS = {
    position: 'offset',
    leftOffset: 5
};
const DEFAULT_TODO_PANEL_SETTINGS = {
    scope: 'document',
    sort: 'position',
    hideCompleted: false
};
const POMODORO_DURATION_STEP_MINUTES = 5;
const POMODORO_WORK_MIN_MINUTES = 5;
const POMODORO_WORK_MAX_MINUTES = 45;
const POMODORO_BREAK_MIN_MINUTES = 5;
const POMODORO_BREAK_MAX_MINUTES = 20;
const DEFAULT_POMODORO_STATE = {
    workMinutes: 25,
    breakMinutes: 5,
    phase: 'idle',
    phaseDurationMinutes: null,
    selectedTodo: null,
    activeTodo: null,
    startedAt: null,
    endsAt: null,
    cycleCount: 0,
    todayCycleDate: null,
    todayCycleCount: 0,
    pausedRemainingMs: null,
    snoozeMinutes: null,
    updatedAt: null
};
const DEFAULT_WORKSPACE_SORT_MODE = 'name-asc';
const VALID_WORKSPACE_SORT_MODES = new Set([
    'name-asc',
    'name-desc',
    'created-asc',
    'created-desc',
    'manual'
]);
const FONT_FAMILY_MAP = {
    'ui-system': '"IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Helvetica Neue", sans-serif',
    'ui-noto-sans': '"Noto Sans SC", "IBM Plex Sans", "Segoe UI", "Helvetica Neue", sans-serif',
    'ui-pingfang': '"LXGW WenKai", "Noto Sans SC", "IBM Plex Sans", sans-serif',
    'ui-rounded': '"M PLUS Rounded 1c", "ZCOOL QingKe HuangYou", "Noto Sans SC", sans-serif',
    'editor-sfmono': '"IBM Plex Mono", "LXGW WenKai", "Menlo", "Monaco", monospace',
    'editor-maple': '"Maple Mono Normal NL CN", "Long Cang", "Menlo", monospace',
    'editor-jetbrains': '"JetBrains Mono", "Noto Sans SC", "Menlo", monospace',
    'editor-fira': '"Fira Code", "ZCOOL XiaoWei", "Menlo", monospace',
    'preview-charter': '"Libre Baskerville", "Noto Serif SC", "Palatino Linotype", serif',
    'preview-songti': '"Noto Serif SC", "ZCOOL XiaoWei", "Libre Baskerville", serif',
    'preview-pingfang': '"LXGW WenKai", "Noto Sans SC", "IBM Plex Sans", sans-serif'
};

const FONT_STYLESHEET_MAP = {
    'ui-system': [
        'node_modules/@fontsource/ibm-plex-sans/400.css',
        'node_modules/@fontsource/ibm-plex-sans/700.css'
    ],
    'ui-noto-sans': [],
    'ui-pingfang': [],
    'ui-rounded': [],
    'editor-sfmono': [
        'node_modules/@fontsource/ibm-plex-mono/400.css',
        'node_modules/@fontsource/ibm-plex-mono/700.css'
    ],
    'editor-maple': [
        'assets/fonts/maple-mono-normalnl/maple-mono-normalnl.css'
    ],
    'editor-jetbrains': [
        'node_modules/@fontsource/jetbrains-mono/400.css',
        'node_modules/@fontsource/jetbrains-mono/700.css'
    ],
    'editor-fira': [
        'node_modules/@fontsource/fira-code/400.css',
        'node_modules/@fontsource/fira-code/700.css'
    ],
    'preview-charter': [
        'node_modules/@fontsource/libre-baskerville/400.css',
        'node_modules/@fontsource/libre-baskerville/700.css'
    ],
    'preview-songti': [],
    'preview-pingfang': []
};

const LOADED_FONT_STYLESHEETS = new Set();

function loadStylesheetOnce(href) {
    if (!href || LOADED_FONT_STYLESHEETS.has(href)) {
        return;
    }

    if (document.querySelector(`link[data-typography-font-href="${href}"]`)) {
        LOADED_FONT_STYLESHEETS.add(href);
        return;
    }

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    link.setAttribute('data-typography-font-href', href);
    document.head.appendChild(link);
    LOADED_FONT_STYLESHEETS.add(href);
}

function ensureTypographyFontStylesheets(fontIds = []) {
    const hrefs = new Set();

    for (const fontId of fontIds) {
        for (const href of FONT_STYLESHEET_MAP[fontId] || []) {
            hrefs.add(href);
        }
    }

    for (const href of hrefs) {
        loadStylesheetOnce(href);
    }
}

const DEFAULT_TYPOGRAPHY_FONT_IDS = ['ui-system', 'editor-sfmono', 'preview-charter'];

const DEFAULT_TYPOGRAPHY_SETTINGS = {
    uiFont: 'ui-system',
    editorFont: 'editor-sfmono',
    uiFontSize: 14,
    editorFontSize: 16,
    editorLineHeight: 1.3,
    editorParagraphSpacing: 4
};
const FIXED_TOOLBAR_POSITION = 'right';
const DEFAULT_FEATURE_VISIBILITY_SETTINGS = {
    timeline: true,
    pomodoro: true
};
const DEFAULT_SIDEBAR_RAIL_ORDER = [
    'workspace',
    'timeline',
    'outline',
    'todo',
    'attachment',
    'history',
    'pomodoro'
];

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
applyInlineMediaPositionSettings(loadInlineMediaPositionSettings());
applySidebarVisibility(loadSidebarVisibilityPreference());
applyToolbarVisibility(loadToolbarVisibilityPreference());
featureVisibilitySettings = applyFeatureVisibility(loadFeatureVisibilitySettings());
applyTimelinePanelVisibility(loadTimelinePanelVisibilityPreference(), { persist: false });
applyViewMode(loadViewModePreference());
pomodoroState = loadPomodoroState();
ensurePomodoroTicker();
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

function createEditorTabState({ path: folderPath = null, content = DEFAULT_UNTITLED_CONTENT, isDirty: dirty = false, searchQuery = '', preservedEntries = [], pinned = false, documentJson = null, manifest = null } = {}) {
    return {
        id: `tab-${nextEditorTabId++}`,
        path: folderPath,
        content,
        previousContent: content,
        documentJson: cloneSerializableValue(documentJson),
        manifest: cloneSerializableValue(manifest),
        isDirty: dirty,
        previousIsDirty: dirty,
        searchQuery,
        preservedEntries: [...preservedEntries],
        pinned: Boolean(pinned),
        attachmentSnapshot: null,
        attachmentSnapshotRoot: null,
        pendingSelectionSnapshot: null,
        selectionSnapshot: null,
        undoStack: [],
        redoStack: []
    };
}

function ensureTabHistoryStacks(tab) {
    if (!tab) return;
    if (!Array.isArray(tab.undoStack)) {
        tab.undoStack = [];
    }
    if (!Array.isArray(tab.redoStack)) {
        tab.redoStack = [];
    }
}

function createTabStateSnapshot(tab) {
    if (!tab) {
        return {
            content: '',
            documentJson: null,
            manifest: null,
            isDirty: false,
            searchQuery: '',
            preservedEntries: [],
            selection: null
        };
    }

    return {
        content: typeof tab.content === 'string' ? tab.content : '',
        documentJson: cloneSerializableValue(tab.documentJson),
        manifest: cloneSerializableValue(tab.manifest),
        isDirty: Boolean(tab.isDirty),
        searchQuery: tab.searchQuery || '',
        preservedEntries: Array.from(tab.preservedEntries || []),
        attachmentSnapshot: cloneSerializableValue(tab.attachmentSnapshot),
        attachmentSnapshotRoot: tab.attachmentSnapshotRoot || null,
        selection: cloneSerializableValue(tab.pendingSelectionSnapshot)
            || cloneSerializableValue(tab.selectionSnapshot)
            || (typeof window.editor?.getSelectionSnapshot === 'function'
            ? cloneSerializableValue(window.editor.getSelectionSnapshot())
            : null)
    };
}

function historySnapshotKey(snapshot) {
    if (!snapshot) {
        return '';
    }

    return JSON.stringify({
        content: typeof snapshot.content === 'string' ? snapshot.content : '',
        documentJson: snapshot.documentJson || null,
        manifest: snapshot.manifest || null,
        isDirty: Boolean(snapshot.isDirty),
        searchQuery: snapshot.searchQuery || '',
        preservedEntries: Array.from(snapshot.preservedEntries || []),
        attachmentSnapshot: snapshot.attachmentSnapshot || null,
        attachmentSnapshotRoot: snapshot.attachmentSnapshotRoot || null
    });
}

function historySnapshotsEqual(leftSnapshot, rightSnapshot) {
    return historySnapshotKey(leftSnapshot) === historySnapshotKey(rightSnapshot);
}

function capturePendingSelectionSnapshot() {
    const tab = getActiveTab();
    if (!tab || !window.editor || typeof window.editor.getSelectionSnapshot !== 'function') {
        return false;
    }

    const selectionSnapshot = cloneSerializableValue(window.editor.getSelectionSnapshot());
    if (!selectionSnapshot) {
        return false;
    }

    tab.pendingSelectionSnapshot = selectionSnapshot;
    return true;
}

function createSnapshotHistoryEntry(tab, previousSnapshot, nextSnapshot, label = '文档修改') {
    return {
        id: createHistoryEntryId(),
        kind: 'snapshot',
        label,
        beforeSnapshot: cloneSerializableValue(previousSnapshot),
        afterSnapshot: cloneSerializableValue(nextSnapshot),
        undo() {
            return applyTabStateSnapshot(tab, previousSnapshot, {
                preserveSelection: false,
                selectionSnapshot: previousSnapshot?.selection || null,
                addCurrentToOppositeStack: false
            });
        },
        redo() {
            return applyTabStateSnapshot(tab, nextSnapshot, {
                preserveSelection: false,
                selectionSnapshot: nextSnapshot?.selection || null,
                addCurrentToOppositeStack: false
            });
        }
    };
}

function createCompositeHistoryEntry(tab, previousSnapshot, nextSnapshot, steps = [], label = '文档修改') {
    const attachmentSteps = Array.isArray(steps) ? steps.filter(Boolean) : [];
    return {
        id: createHistoryEntryId(),
        kind: 'transaction',
        label,
        beforeSnapshot: cloneSerializableValue(previousSnapshot),
        afterSnapshot: cloneSerializableValue(nextSnapshot),
        steps: attachmentSteps,
        async undo() {
            for (let index = attachmentSteps.length - 1; index >= 0; index--) {
                const step = attachmentSteps[index];
                if (typeof step?.undo === 'function') {
                    const didUndoStep = await step.undo();
                    if (didUndoStep === false) {
                        return false;
                    }
                }
            }
            return applyTabStateSnapshot(tab, previousSnapshot, {
                preserveSelection: false,
                selectionSnapshot: previousSnapshot?.selection || null,
                addCurrentToOppositeStack: false
            });
        },
        async redo() {
            for (const step of attachmentSteps) {
                if (typeof step?.redo === 'function') {
                    const didRedoStep = await step.redo();
                    if (didRedoStep === false) {
                        return false;
                    }
                }
            }
            return applyTabStateSnapshot(tab, nextSnapshot, {
                preserveSelection: false,
                selectionSnapshot: nextSnapshot?.selection || null,
                addCurrentToOppositeStack: false
            });
        }
    };
}

function pushTabHistoryEntry(tab, entry) {
    if (!tab || !entry) return;
    ensureTabHistoryStacks(tab);

    const lastEntry = tab.undoStack[tab.undoStack.length - 1];
    const lastSnapshot = lastEntry?.afterSnapshot || lastEntry?.snapshot || null;
    const nextSnapshot = entry.afterSnapshot || entry.snapshot || null;
    if (historySnapshotsEqual(lastSnapshot, nextSnapshot) && !entry.steps?.length) {
        return;
    }

    tab.undoStack.push(entry);
    if (tab.undoStack.length > 200) {
        tab.undoStack.splice(0, tab.undoStack.length - 200);
    }
    tab.redoStack.length = 0;
}

function pushTabUndoSnapshot(tab, previousSnapshot = null, nextSnapshot = null, label = '文档修改') {
    if (!tab) return;
    const beforeSnapshot = cloneSerializableValue(previousSnapshot) || createTabStateSnapshot(tab);
    const afterSnapshot = cloneSerializableValue(nextSnapshot) || createTabStateSnapshot(tab);

    if (historySnapshotsEqual(beforeSnapshot, afterSnapshot)) {
        return;
    }

    pushTabHistoryEntry(tab, createSnapshotHistoryEntry(tab, beforeSnapshot, afterSnapshot, label));
}

function clearTabRedoStack(tab) {
    if (!tab) return;
    ensureTabHistoryStacks(tab);
    tab.redoStack.length = 0;
}

function resetTabHistory(tab, content = null) {
    if (!tab) return;
    ensureTabHistoryStacks(tab);
    tab.undoStack.length = 0;
    tab.redoStack.length = 0;
    if (typeof content === 'string') {
        tab.content = content;
        tab.previousContent = content;
    }
    tab.previousIsDirty = Boolean(tab.isDirty);
}

function getActiveTabUndoAvailability() {
    const activeTab = getActiveTab();
    if (!activeTab) {
        return false;
    }

    ensureTabHistoryStacks(activeTab);
    return Boolean(
        activeTab.undoStack.length
        || (pendingAttachmentDeleteSnapshot && shouldApplyPendingAttachmentDeleteSnapshot())
        || (pendingAttachmentRenameSnapshot && shouldApplyPendingAttachmentRenameUndo())
    );
}

function getActiveTabRedoAvailability() {
    const activeTab = getActiveTab();
    if (!activeTab) {
        return false;
    }

    ensureTabHistoryStacks(activeTab);
    return activeTab.redoStack.length > 0;
}

function refreshActiveEditorAttachmentDom() {
    if (!window.editor) return;

    const refresh = () => {
        if (!window.editor) return;
        if (typeof window.editor.normalizeAttachmentNodes === 'function') {
            window.editor.normalizeAttachmentNodes();
        }
        if (typeof window.editor.refreshLinkDomState === 'function') {
            window.editor.refreshLinkDomState(true);
        }
        if (typeof window.editor.refreshAttachmentNodeLabels === 'function') {
            window.editor.refreshAttachmentNodeLabels(true);
        }
        if (typeof window.editor.refreshRangeSelectionHighlights === 'function') {
            window.editor.refreshRangeSelectionHighlights();
        }
    };

    window.requestAnimationFrame(() => {
        refresh();
        window.requestAnimationFrame(refresh);
    });
}

function applyTabStateSnapshot(tab, snapshot, options = {}) {
    if (!tab || !window.editor || !snapshot) return false;
    if (tab.id !== activeTabId) return false;

    const {
        preserveSelection = true,
        selectionSnapshot = null,
        addCurrentToOppositeStack = false,
        oppositeStack = 'redo'
    } = options;
    const currentSnapshot = createTabStateSnapshot(tab);
    ensureTabHistoryStacks(tab);

    if (addCurrentToOppositeStack) {
        const targetStack = oppositeStack === 'redo' ? tab.redoStack : tab.undoStack;
        targetStack.push(currentSnapshot);
        if (targetStack.length > 200) {
            targetStack.splice(0, targetStack.length - 200);
        }
    }

    suppressDocumentStateSync = true;
    const nextSelectionSnapshot = selectionSnapshot || (preserveSelection ? snapshot.selection || null : null);
    const didApplyDocumentJson = snapshot.documentJson && typeof window.editor.setDocumentJson === 'function'
        ? window.editor.setDocumentJson(cloneSerializableValue(snapshot.documentJson), {
            emitChange: false,
            preserveSelection
        })
        : false;
    if (!didApplyDocumentJson && typeof window.editor.setValue === 'function') {
        window.editor.setValue(snapshot.content || '', {
            emitChange: false,
            preserveSelection
        });
    }
    suppressDocumentStateSync = false;

    const refreshedContent = typeof window.editor.getValue === 'function'
        ? window.editor.getValue()
        : (typeof snapshot.content === 'string' ? snapshot.content : '');
    tab.previousContent = tab.content;
    tab.previousIsDirty = tab.isDirty;
    tab.content = refreshedContent;
    tab.documentJson = cloneSerializableValue(snapshot.documentJson);
    tab.manifest = cloneSerializableValue(snapshot.manifest);
    tab.isDirty = Boolean(snapshot.isDirty);
    tab.searchQuery = snapshot.searchQuery || '';
    tab.preservedEntries = [...(snapshot.preservedEntries || [])];
    tab.attachmentSnapshot = cloneSerializableValue(snapshot.attachmentSnapshot);
    tab.attachmentSnapshotRoot = snapshot.attachmentSnapshotRoot || null;
    tab.selectionSnapshot = cloneSerializableValue(nextSelectionSnapshot);
    tab.pendingSelectionSnapshot = null;
    preservedUnusedAttachmentEntries = new Set(tab.preservedEntries);
    currentSearchQuery = tab.searchQuery;

    const searchInput = document.getElementById('toolbar-search-input');
    if (searchInput) {
        searchInput.value = currentSearchQuery;
    }

    updateBundleStatus(tab.path || null);
    const restoredEntries = restoreRecoveredEntries(tab.content || '', tab.documentJson || null);
    refreshActiveEditorAttachmentDom();
    if (nextSelectionSnapshot && typeof window.editor.restoreSelectionSnapshot === 'function') {
        window.editor.restoreSelectionSnapshot(nextSelectionSnapshot, { scrollIntoView: false });
    }
    renderToolbarSearchResults(currentSearchQuery);
    updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
    updateOutline();
    setDirty(Boolean(snapshot.isDirty) || restoredEntries);
    refreshAttachmentPanelIfVisible();
    refreshEditorToolbarState();
    lastKnownEditorLineCount = getEditorTotalLines();
    pendingPreviewVisibleLine = getEditorAnchorLineFromCursor();
    if (tab.isDirty) {
        scheduleAutoSave();
    }
    schedulePersistActiveTabState();
    scheduleEditorRender();
    return true;
}

async function undoActiveTabState() {
    const activeTab = getActiveTab();
    if (!activeTab || !window.editor) return false;

    flushScheduledPersistActiveTabState();

    if (restorePendingAttachmentDeleteSnapshotForCancel()) {
        return true;
    }

    const didUndoAttachmentRename = applyPendingAttachmentRenameUndo();
    if (didUndoAttachmentRename) {
        return true;
    }

    ensureTabHistoryStacks(activeTab);
    const entry = activeTab.undoStack[activeTab.undoStack.length - 1];
    if (!entry) {
        return false;
    }

    suppressHistoryRecording = true;
    try {
        const didUndo = typeof entry.undo === 'function' ? Boolean(await entry.undo()) : false;
        if (!didUndo) {
            return false;
        }

        activeTab.undoStack.pop();
        activeTab.redoStack.push(entry);
        if (activeTab.redoStack.length > 200) {
            activeTab.redoStack.splice(0, activeTab.redoStack.length - 200);
        }
        return true;
    } catch (error) {
        console.error('Undo failed:', error);
        alert(`撤销失败: ${error?.message || error}`);
        return false;
    } finally {
        suppressHistoryRecording = false;
    }
}

async function redoActiveTabState() {
    const activeTab = getActiveTab();
    if (!activeTab || !window.editor) return false;

    flushScheduledPersistActiveTabState();

    ensureTabHistoryStacks(activeTab);
    const entry = activeTab.redoStack[activeTab.redoStack.length - 1];
    if (!entry) {
        return false;
    }

    suppressHistoryRecording = true;
    try {
        const didRedo = typeof entry.redo === 'function' ? Boolean(await entry.redo()) : false;
        if (!didRedo) {
            return false;
        }

        activeTab.redoStack.pop();
        activeTab.undoStack.push(entry);
        if (activeTab.undoStack.length > 200) {
            activeTab.undoStack.splice(0, activeTab.undoStack.length - 200);
        }
        return true;
    } catch (error) {
        console.error('Redo failed:', error);
        alert(`重做失败: ${error?.message || error}`);
        return false;
    } finally {
        suppressHistoryRecording = false;
    }
}

function beginHistoryTransaction(label, tab = getActiveTab()) {
    if (!tab || activeHistoryTransaction) {
        return false;
    }

    flushScheduledPersistActiveTabState();
    if (tab.path) {
        tab.attachmentSnapshot = captureBundleAttachmentSnapshot(tab.path);
        tab.attachmentSnapshotRoot = path.resolve(tab.path);
    }
    activeHistoryTransaction = {
        id: createHistoryEntryId(),
        label: String(label || '文档修改'),
        tabId: tab.id,
        beforeSnapshot: createTabStateSnapshot(tab),
        steps: []
    };
    suppressHistoryRecording = true;
    return true;
}

function recordHistoryAttachmentStep(step) {
    if (!activeHistoryTransaction || !step) {
        return false;
    }
    if (activeHistoryTransaction.tabId !== activeTabId) {
        return false;
    }

    activeHistoryTransaction.steps.push(step);
    return true;
}

function commitHistoryTransaction() {
    const transaction = activeHistoryTransaction;
    if (!transaction) {
        suppressHistoryRecording = false;
        return false;
    }

    const tab = getTabById(transaction.tabId);
    activeHistoryTransaction = null;
    suppressHistoryRecording = false;

    if (!tab) {
        return false;
    }

    if (tab.path) {
        tab.attachmentSnapshot = captureBundleAttachmentSnapshot(tab.path);
        tab.attachmentSnapshotRoot = path.resolve(tab.path);
    }
    const afterSnapshot = createTabStateSnapshot(tab);
    if (historySnapshotsEqual(transaction.beforeSnapshot, afterSnapshot) && !transaction.steps.length) {
        return false;
    }

    pushTabHistoryEntry(
        tab,
        createCompositeHistoryEntry(
            tab,
            transaction.beforeSnapshot,
            afterSnapshot,
            transaction.steps,
            transaction.label
        )
    );
    return true;
}

async function cancelHistoryTransaction(options = {}) {
    const { rollback = false } = options;
    const transaction = activeHistoryTransaction;
    activeHistoryTransaction = null;
    suppressHistoryRecording = false;

    if (!rollback || !transaction) {
        return;
    }

    const tab = getTabById(transaction.tabId);
    if (!tab) {
        return;
    }

    for (let index = transaction.steps.length - 1; index >= 0; index--) {
        const step = transaction.steps[index];
        if (typeof step?.undo === 'function') {
            try {
                await step.undo();
            } catch {
                // ignore rollback failures
            }
        }
    }

    if (transaction.beforeSnapshot) {
        try {
            applyTabStateSnapshot(tab, transaction.beforeSnapshot, {
                preserveSelection: true,
                addCurrentToOppositeStack: false
            });
        } catch {
            // ignore rollback failures
        }
    }
}

async function runHistoryTransaction(label, callback, tab = getActiveTab()) {
    const started = beginHistoryTransaction(label, tab);
    try {
        const result = await callback();
        if (started && result === false) {
            await cancelHistoryTransaction({ rollback: true });
            return result;
        }
        if (started) {
            commitHistoryTransaction();
        }
        return result;
    } catch (error) {
        if (started) {
            await cancelHistoryTransaction({ rollback: true });
        }
        throw error;
    }
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

function getActiveEditorSnapshot(markdownOverride = null) {
    if (!window.editor) {
        return {
            markdown: typeof markdownOverride === 'string' ? markdownOverride : '',
            documentJson: null
        };
    }

    const markdown = typeof markdownOverride === 'string'
        ? markdownOverride
        : (typeof window.editor.getValue === 'function'
            ? window.editor.getValue()
            : (typeof window.editor.getLiveMarkdownSnapshot === 'function'
                ? window.editor.getLiveMarkdownSnapshot()
                : ''));

    const documentJson = typeof window.editor.getDocumentJson === 'function'
        ? cloneSerializableValue(window.editor.getDocumentJson())
        : null;

    return { markdown, documentJson };
}

function persistActiveTabState(markdownOverride = null) {
    if (suppressDocumentStateSync || !window.editor) return;

    const tab = getActiveTab();
    if (!tab) return;
    const previousSnapshot = createTabStateSnapshot(tab);
    const { markdown: liveMarkdown, documentJson: liveDocumentJson } = getActiveEditorSnapshot(markdownOverride);
    const tabDocumentJson = cloneSerializableValue(tab.documentJson);
    const liveDocumentJsonString = JSON.stringify(liveDocumentJson || null);
    const tabDocumentJsonString = JSON.stringify(tabDocumentJson || null);
    const hasDocumentJsonState = Boolean(liveDocumentJson || tabDocumentJson);
    const didStructuralChange = hasDocumentJsonState
        ? liveDocumentJsonString !== tabDocumentJsonString
        : liveMarkdown !== tab.content;

    ensureTabHistoryStacks(tab);

    tab.previousContent = tab.content;
    tab.previousIsDirty = tab.isDirty;
    tab.path = window.currentPath || null;
    tab.content = liveMarkdown;
    tab.documentJson = liveDocumentJson;
    tab.isDirty = isDirty;
    tab.searchQuery = currentSearchQuery;
    tab.preservedEntries = Array.from(preservedUnusedAttachmentEntries);
    tab.selectionSnapshot = typeof window.editor.getSelectionSnapshot === 'function'
        ? cloneSerializableValue(window.editor.getSelectionSnapshot())
        : tab.selectionSnapshot || null;
    tab.pendingSelectionSnapshot = null;
    if (tab.path) {
        tab.attachmentSnapshot = captureBundleAttachmentSnapshot(tab.path);
        tab.attachmentSnapshotRoot = path.resolve(tab.path);
    }

    const nextSnapshot = createTabStateSnapshot(tab);
    if (didStructuralChange && !suppressHistoryRecording) {
        pushTabUndoSnapshot(tab, previousSnapshot, nextSnapshot);
    }
}

function schedulePersistActiveTabState(markdownOverride = null, delay = 120, tabId = activeTabId) {
    if (persistActiveTabTimer) {
        window.clearTimeout(persistActiveTabTimer);
    }

    persistActiveTabTimerContext = { tabId };
    persistActiveTabTimer = window.setTimeout(() => {
        const context = persistActiveTabTimerContext;
        persistActiveTabTimer = null;
        persistActiveTabTimerContext = null;
        if (context?.tabId && context.tabId !== activeTabId) {
            return;
        }
        persistActiveTabState(markdownOverride);
    }, delay);
}

function flushScheduledPersistActiveTabState() {
    if (!persistActiveTabTimer) return;
    window.clearTimeout(persistActiveTabTimer);
    const context = persistActiveTabTimerContext;
    persistActiveTabTimer = null;
    persistActiveTabTimerContext = null;
    if (context?.tabId && context.tabId !== activeTabId) {
        return;
    }
    persistActiveTabState();
}

function scheduleToolbarStateRefresh() {
    if (toolbarStateRefreshFrame) return;
    toolbarStateRefreshFrame = window.requestAnimationFrame(() => {
        toolbarStateRefreshFrame = null;
        refreshEditorToolbarState();
    });
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
        changeToken: editorChangeToken,
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

function shouldApplyPendingAttachmentDeleteSnapshot() {
    const activeTab = getActiveTab();
    const snapshot = pendingAttachmentDeleteSnapshot;
    if (!activeTab || !snapshot || !window.currentPath) {
        return false;
    }

    return (
        snapshot.tabId === activeTab.id
        && path.resolve(snapshot.path || '') === path.resolve(window.currentPath)
        && editorChangeToken === Number(snapshot.changeToken || 0) + 1
    );
}

function capturePendingAttachmentRenameSnapshot(oldAbsolutePath, newAbsolutePath) {
    const activeTab = getActiveTab();
    if (!activeTab || !window.currentPath || activeHistoryTransaction || suppressHistoryRecording) {
        pendingAttachmentRenameSnapshot = null;
        return;
    }

    pendingAttachmentRenameSnapshot = {
        tabId: activeTab.id,
        path: window.currentPath,
        oldAbsolutePath: path.resolve(String(oldAbsolutePath || '')),
        newAbsolutePath: path.resolve(String(newAbsolutePath || '')),
        changeToken: editorChangeToken
    };
}

function clearPendingAttachmentRenameSnapshot() {
    pendingAttachmentRenameSnapshot = null;
}

function shouldApplyPendingAttachmentRenameUndo() {
    const activeTab = getActiveTab();
    const snapshot = pendingAttachmentRenameSnapshot;
    if (!activeTab || !snapshot || !window.currentPath) {
        return false;
    }

    return (
        snapshot.tabId === activeTab.id
        && path.resolve(snapshot.path) === path.resolve(window.currentPath)
        && snapshot.changeToken === editorChangeToken
    );
}

function applyPendingAttachmentRenameUndo() {
    const snapshot = pendingAttachmentRenameSnapshot;
    if (!shouldApplyPendingAttachmentRenameUndo() || !snapshot) {
        return false;
    }

    try {
        const oldPath = snapshot.oldAbsolutePath;
        const newPath = snapshot.newAbsolutePath;
        if (!oldPath || !newPath || !fs.existsSync(newPath) || fs.existsSync(oldPath)) {
            clearPendingAttachmentRenameSnapshot();
            return false;
        }

        suppressWorkspaceWatcherUntil = Math.max(suppressWorkspaceWatcherUntil, Date.now() + 1500);
        fs.renameSync(newPath, oldPath);
        clearPendingAttachmentRenameSnapshot();
        if (workspaceRootPath) {
            scheduleWorkspaceTreeRefresh();
        }
        refreshEditorToolbarState();
        return true;
    } catch {
        clearPendingAttachmentRenameSnapshot();
        return false;
    }
}

function applyPendingAttachmentDeleteSnapshot() {
    const activeTab = getActiveTab();
    const deleteSnapshot = pendingAttachmentDeleteSnapshot;
    if (!activeTab || !window.editor || !deleteSnapshot || !shouldApplyPendingAttachmentDeleteSnapshot()) {
        if (deleteSnapshot && editorChangeToken > Number(deleteSnapshot.changeToken || 0) + 1) {
            clearPendingAttachmentDeleteSnapshot();
        }
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
    ensureTabHistoryStacks(activeTab);
    const lastHistoryEntry = activeTab.undoStack[activeTab.undoStack.length - 1];
    const lastHistoryContent = lastHistoryEntry?.afterSnapshot?.content
        || lastHistoryEntry?.snapshot?.content
        || lastHistoryEntry?.content
        || '';
    if (activeTab.undoStack.length && lastHistoryContent === deleteSnapshot.content) {
        activeTab.undoStack.pop();
    }
    clearTabRedoStack(activeTab);
    preservedUnusedAttachmentEntries = new Set(deleteSnapshot.preservedEntries || []);
    currentSearchQuery = deleteSnapshot.searchQuery || '';

    const searchInput = document.getElementById('toolbar-search-input');
    if (searchInput) {
        searchInput.value = currentSearchQuery;
    }

    updateBundleStatus(activeTab.path || null);
    const restoredEntries = restoreRecoveredEntries(deleteSnapshot.content || '');
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
    setDirty(Boolean(deleteSnapshot.isDirty) || restoredEntries);
    if (restoredEntries) {
        scheduleAutoSave();
    }
    renderEditorTabs();
    refreshEditorToolbarState();
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
    if (autoSaveTimer) {
        window.clearTimeout(autoSaveTimer);
        autoSaveTimer = null;
    }
    if (persistActiveTabTimer) {
        window.clearTimeout(persistActiveTabTimer);
        persistActiveTabTimer = null;
    }
}

function isPreviewActive() {
    if (RICH_TEXT_EDITOR_ONLY) return false;
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

    normalizeEditorTabOrder();
    container.innerHTML = '';

    for (const tab of editorTabs) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `editor-tab${tab.id === activeTabId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}`;
        button.dataset.tabId = tab.id;
        button.title = tab.path || '未保存文档';
        button.draggable = !tab.pinned;

        const dirtyDot = tab.isDirty ? '<span class="editor-tab-dot"></span>' : '';
        const pinIcon = tab.pinned ? '<span class="editor-tab-pin" aria-hidden="true"><i class="fa-solid fa-thumbtack"></i></span>' : '';
        button.innerHTML = `
            <span class="editor-tab-curve editor-tab-curve-left"></span>
            <span class="editor-tab-curve editor-tab-curve-right"></span>
            <span class="editor-tab-surface"></span>
            <span class="editor-tab-label">${escapeHtml(getTabTitle(tab))}</span>
            ${pinIcon}
            ${dirtyDot}
            <span class="editor-tab-close" data-tab-close="${tab.id}" role="button" aria-label="关闭标签页">×</span>
        `;

        container.appendChild(button);
    }
}

async function createEmptyTab() {
    if (activeHistoryTransaction) {
        return null;
    }
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
    if (window.currentPath) {
        migrateLegacyRecoveryRoot(window.currentPath);
    }
    preservedUnusedAttachmentEntries = new Set(tab.preservedEntries || []);
    currentSearchQuery = tab.searchQuery || '';
}

function applyTabToEditor(tab) {
    if (!tab || !window.editor) return;

    suppressDocumentStateSync = true;
    syncGlobalsFromTab(tab);
    if (typeof window.editor.setEditable === 'function') {
        window.editor.setEditable(true);
    }
    if (typeof window.editor.setBundlePath === 'function') {
        window.editor.setBundlePath(tab.path || null);
    }

    const canSetDocumentJson = typeof window.editor.setDocumentJson === 'function' && tab.documentJson;
    const documentJsonApplied = canSetDocumentJson
        ? window.editor.setDocumentJson(cloneSerializableValue(tab.documentJson), {
            emitChange: false,
            preserveSelection: false
        })
        : false;
    if (!documentJsonApplied) {
        window.editor.setValue(tab.content || '');
    }

    let didRepairAttachments = false;
    if (typeof window.editor.repairAttachmentReferencesByIdentity === 'function') {
        try {
            didRepairAttachments = Boolean(window.editor.repairAttachmentReferencesByIdentity());
        } catch {
            didRepairAttachments = false;
        }
    }

    if (typeof window.editor.getValue === 'function') {
        const refreshedContent = window.editor.getValue();
        tab.content = refreshedContent;
        tab.previousContent = refreshedContent;
    }
    if (typeof window.editor.getDocumentJson === 'function') {
        tab.documentJson = cloneSerializableValue(window.editor.getDocumentJson());
    }
    suppressDocumentStateSync = false;

    if (didRepairAttachments && typeof window.editor.getValue === 'function') {
        const repairedContent = window.editor.getValue();
        tab.content = repairedContent;
        tab.previousContent = repairedContent;
    }
    if (didRepairAttachments && typeof window.editor.getDocumentJson === 'function') {
        tab.documentJson = cloneSerializableValue(window.editor.getDocumentJson());
    }

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
    if (activeHistoryTransaction && activeHistoryTransaction.tabId !== tabId) {
        return;
    }

    if (activeTabId === tabId) {
        renderEditorTabs();
        return;
    }

    clearPendingAutoSave();
    persistActiveTabState();
    activeTabId = tabId;
    repairTabAttachmentStateFromFilesystem(nextTab);
    applyTabToEditor(nextTab);
    syncWorkspaceSelectionToPath(nextTab.path);
    renderEditorTabs();
}

function findTabByPath(folderPath) {
    if (!folderPath) return null;
    const normalizedTarget = path.resolve(folderPath);
    return editorTabs.find((tab) => tab.path && path.resolve(tab.path) === normalizedTarget) || null;
}

function openTabWithContent(folderPath, content, options = {}) {
    if (activeHistoryTransaction) {
        return null;
    }
    const normalizedPath = folderPath ? path.resolve(folderPath) : null;
    const existingTab = normalizedPath ? findTabByPath(normalizedPath) : null;
    const nextDocumentJson = options.documentJson ? cloneSerializableValue(options.documentJson) : null;
    const nextManifest = options.manifest ? cloneSerializableValue(options.manifest) : null;

    if (existingTab) {
        existingTab.path = normalizedPath;
        if (nextDocumentJson) {
            existingTab.documentJson = nextDocumentJson;
        }
        if (nextManifest) {
            existingTab.manifest = nextManifest;
        }
        if (!existingTab.isDirty) {
            existingTab.content = content;
            resetTabHistory(existingTab, content);
        }
        existingTab.attachmentSnapshot = existingTab.path ? captureBundleAttachmentSnapshot(existingTab.path) : null;
        existingTab.attachmentSnapshotRoot = existingTab.path ? path.resolve(existingTab.path) : null;
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
        activeTab.documentJson = nextDocumentJson;
        activeTab.manifest = nextManifest;
        activeTab.previousContent = content;
        activeTab.isDirty = false;
        activeTab.previousIsDirty = false;
        activeTab.searchQuery = '';
        activeTab.preservedEntries = [];
        activeTab.attachmentSnapshot = activeTab.path ? captureBundleAttachmentSnapshot(activeTab.path) : null;
        activeTab.attachmentSnapshotRoot = activeTab.path ? path.resolve(activeTab.path) : null;
        resetTabHistory(activeTab, content);
        applyTabToEditor(activeTab);
        renderEditorTabs();
        return activeTab;
    }

    clearPendingAutoSave();
    persistActiveTabState();
    const tab = createEditorTabState({
        path: normalizedPath,
        content,
        isDirty: false,
        documentJson: nextDocumentJson,
        manifest: nextManifest
    });
    editorTabs.push(tab);
    activeTabId = tab.id;
    tab.attachmentSnapshot = tab.path ? captureBundleAttachmentSnapshot(tab.path) : null;
    tab.attachmentSnapshotRoot = tab.path ? path.resolve(tab.path) : null;
    applyTabToEditor(tab);
    syncWorkspaceSelectionToPath(tab.path);
    renderEditorTabs();
    return tab;
}

async function closeEditorTab(tabId) {
    const targetTab = getTabById(tabId);
    if (!targetTab) return;
    if (activeHistoryTransaction) return;

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
    if (targetTab.pinned && closedPath) {
        const normalizedClosedPath = path.resolve(closedPath);
        savePinnedEditorTabPaths(
            loadPinnedEditorTabPaths().filter((entry) => path.resolve(entry) !== normalizedClosedPath)
        );
    }

    if (closedPath && !targetTab.isDirty) {
        await cleanupUnusedResourcesForTab(targetTab);
    }
    editorTabs = editorTabs.filter((tab) => tab.id !== tabId);

    if (!editorTabs.length) {
        clearEditorForNoTab();
    } else {
        const nextTab = editorTabs[Math.max(editorTabs.findIndex((tab) => tab.id === previousActiveId), 0)] || editorTabs[Math.max(editorTabs.length - 1, 0)];
        activeTabId = nextTab.id;
        applyTabToEditor(nextTab);
    }

    if (closedPath) {
        cleanupRecoveryDir(closedPath, { preservePrimary: true });
    }

    if (editorTabs.length) {
        renderEditorTabs();
    }
}

async function confirmAllTabsBeforeClose() {
    if (activeHistoryTransaction) {
        return false;
    }
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

    for (const tab of editorTabs) {
        if (!tab || !tab.path || tab.isDirty) continue;
        await cleanupUnusedResourcesForTab(tab);
        cleanupRecoveryDir(tab.path);
    }

    return true;
}

function updateWindowTitle() {
    const activeTab = getActiveTab();
    const title = activeTab ? `${getTabTitle(activeTab)} - Kangaroo` : 'Kangaroo';
    document.title = isDirty ? `* ${title}` : title;
}

function updateAddressBar(folderPath) {
    void folderPath;
}

function getWorkspaceTimelineEventsPath(rootPath = workspaceRootPath) {
    if (!rootPath) return null;
    return path.join(rootPath, WORKSPACE_TIMELINE_EVENTS_FILE);
}

function readWorkspaceTimelineEvents(rootPath = workspaceRootPath) {
    const eventsPath = getWorkspaceTimelineEventsPath(rootPath);
    if (!eventsPath || !fs.existsSync(eventsPath)) {
        return [];
    }

    try {
        const raw = fs.readFileSync(eventsPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function writeWorkspaceTimelineEvents(events, rootPath = workspaceRootPath) {
    const eventsPath = getWorkspaceTimelineEventsPath(rootPath);
    if (!eventsPath) return false;

    try {
        fs.writeFileSync(eventsPath, JSON.stringify(events, null, 2), 'utf-8');
        return true;
    } catch {
        return false;
    }
}

function appendWorkspaceTimelineEvent(event, rootPath = workspaceRootPath) {
    if (!rootPath || !event) return false;

    const existing = readWorkspaceTimelineEvents(rootPath);
    const nextEvents = Array.isArray(existing) ? existing.slice(-999) : [];
    nextEvents.push(event);
    const didWrite = writeWorkspaceTimelineEvents(nextEvents, rootPath);
    if (didWrite) {
        invalidateWorkspaceTimelineEntriesCache(rootPath);
        scheduleTimelinePanelRender();
    }
    return didWrite;
}

function getTodoTimelineEventIdentity(todo = {}) {
    const normalizedBundlePath = todo?.bundlePath ? path.resolve(todo.bundlePath) : '';
    if (!normalizedBundlePath) {
        return null;
    }

    const stableId = String(todo?.stableId || '').trim();
    if (stableId) {
        return `${normalizedBundlePath}::id::${stableId}`;
    }

    const kindIndex = Number.isInteger(todo?.kindIndex) ? todo.kindIndex : null;
    if (Number.isInteger(kindIndex)) {
        return `${normalizedBundlePath}::kind::${kindIndex}`;
    }

    const lineNumber = Number.isInteger(todo?.lineNumber) ? todo.lineNumber : Number.isInteger(todo?.sourceLine) ? todo.sourceLine : null;
    if (!Number.isInteger(lineNumber)) {
        return null;
    }

    return `${normalizedBundlePath}::line::${lineNumber}`;
}

function getTodoCheckedUpdateKey(todo = {}) {
    const normalizedBundlePath = todo?.bundlePath
        ? path.resolve(todo.bundlePath)
        : (window.currentPath ? path.resolve(window.currentPath) : '');
    if (!normalizedBundlePath) {
        return null;
    }

    const stableId = String(todo?.stableId || '').trim();
    if (stableId) {
        return `${normalizedBundlePath}::id::${stableId}`;
    }

    const kindIndex = Number.isInteger(todo?.kindIndex) ? todo.kindIndex : null;
    if (Number.isInteger(kindIndex)) {
        return `${normalizedBundlePath}::kind::${kindIndex}`;
    }

    const lineNumber = Number.isInteger(todo?.lineNumber) ? todo.lineNumber : null;
    if (Number.isInteger(lineNumber)) {
        return `${normalizedBundlePath}::line::${lineNumber}`;
    }

    return null;
}

function getNormalizedTodoTimelineText(todo = {}) {
    const text = stripTodoCompletionTimestamp(String(todo?.todoText || todo?.text || '').trim());
    return text ? text.replace(/\s+/g, ' ').trim().toLowerCase() : '';
}

function todoCompletedEventMatchesTodo(entry, todo, eventIdentity = null) {
    if (String(entry?.type || '') !== 'todo-completed') {
        return false;
    }

    const entryBundlePath = entry?.bundlePath ? path.resolve(entry.bundlePath) : '';
    const todoBundlePath = todo?.bundlePath ? path.resolve(todo.bundlePath) : '';
    if (!entryBundlePath || !todoBundlePath || entryBundlePath !== todoBundlePath) {
        return false;
    }

    const entryStableId = String(entry?.stableId || '').trim();
    const todoStableId = String(todo?.stableId || '').trim();
    if (entryStableId && todoStableId && entryStableId === todoStableId) {
        return true;
    }

    const entryKindIndex = Number.isInteger(entry?.kindIndex) ? entry.kindIndex : null;
    const todoKindIndex = Number.isInteger(todo?.kindIndex) ? todo.kindIndex : Number.isInteger(todo?.sourceKindIndex) ? todo.sourceKindIndex : null;
    if (entryKindIndex != null && todoKindIndex != null && entryKindIndex === todoKindIndex) {
        return true;
    }

    const entryLineNumber = Number.isInteger(entry?.lineNumber) ? entry.lineNumber : null;
    const todoLineNumber = Number.isInteger(todo?.lineNumber) ? todo.lineNumber : Number.isInteger(todo?.sourceLine) ? todo.sourceLine : null;
    if (eventIdentity && entryLineNumber != null && `${entryBundlePath}::line::${entryLineNumber}` === eventIdentity) {
        return true;
    }

    if (eventIdentity && entryKindIndex != null && `${entryBundlePath}::kind::${entryKindIndex}` === eventIdentity) {
        return true;
    }

    if (eventIdentity && entryStableId && `${entryBundlePath}::id::${entryStableId}` === eventIdentity) {
        return true;
    }

    if (entryLineNumber != null && todoLineNumber != null && entryLineNumber === todoLineNumber) {
        return true;
    }

    const entryText = getNormalizedTodoTimelineText(entry);
    const todoText = getNormalizedTodoTimelineText(todo);
    return Boolean(entryText && todoText && entryText === todoText);
}

function removeTodoCompletedTimelineEvent(todo, rootPath = workspaceRootPath) {
    if (!rootPath || !todo?.bundlePath) return false;

    const eventIdentity = getTodoTimelineEventIdentity(todo);

    const existing = readWorkspaceTimelineEvents(rootPath);
    if (!Array.isArray(existing) || !existing.length) return false;

    const nextEvents = existing.filter((entry) => {
        if (!todoCompletedEventMatchesTodo(entry, todo, eventIdentity)) {
            return true;
        }
    });

    if (nextEvents.length === existing.length) {
        return false;
    }

    const didWrite = writeWorkspaceTimelineEvents(nextEvents, rootPath);
    if (didWrite) {
        invalidateWorkspaceTimelineEntriesCache(rootPath);
        scheduleTimelinePanelRender();
    }
    return didWrite;
}

function upsertTodoCompletedTimelineEvent(todo, options = {}) {
    if (!workspaceRootPath || !todo?.bundlePath) return false;

    const nextTodo = {
        ...todo,
        bundlePath: path.resolve(todo.bundlePath)
    };

    if (!Boolean(options.checked)) {
        return removeTodoCompletedTimelineEvent(nextTodo, workspaceRootPath);
    }

    const eventIdentity = getTodoTimelineEventIdentity(nextTodo);
    if (!eventIdentity) {
        return false;
    }

    const existing = readWorkspaceTimelineEvents(workspaceRootPath);
    const nextEvents = Array.isArray(existing) ? existing.slice(-999) : [];
    const filteredEvents = nextEvents.filter((entry) => {
        if (!todoCompletedEventMatchesTodo(entry, nextTodo, eventIdentity)) {
            return true;
        }
    });

    const nextEventsWithCurrent = filteredEvents.concat({
        id: `todo-completed:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
        type: 'todo-completed',
        timestamp: Number.isFinite(options.timestamp) ? options.timestamp : Date.now(),
        bundlePath: nextTodo.bundlePath,
        relativeFolder: getRelativeWorkspaceFolder(nextTodo.bundlePath),
        relativeBundlePath: path.relative(path.resolve(workspaceRootPath), nextTodo.bundlePath) || path.basename(nextTodo.bundlePath),
        noteTitle: getDocumentTitleFromBundlePath(nextTodo.bundlePath),
        todoText: stripTodoCompletionTimestamp(String(nextTodo.text || '').trim()),
        kindIndex: Number.isInteger(nextTodo.kindIndex) ? nextTodo.kindIndex : null,
        lineNumber: Number.isInteger(nextTodo.lineNumber) ? nextTodo.lineNumber : null,
        stableId: String(nextTodo.stableId || '').trim() || null,
        action: (() => {
            const cleanedTodoText = stripTodoCompletionTimestamp(String(nextTodo.text || '').trim());
            const trimmedTodoText = cleanedTodoText.length > 80 ? `${cleanedTodoText.slice(0, 80)}...` : cleanedTodoText;
            const noteTitle = getDocumentTitleFromBundlePath(nextTodo.bundlePath);
            return trimmedTodoText
                ? `完成了《${noteTitle}》中的待办：${trimmedTodoText}`
                : `完成了《${noteTitle}》中的待办`;
        })()
    });

    const didWrite = writeWorkspaceTimelineEvents(nextEventsWithCurrent, workspaceRootPath);
    if (didWrite) {
        invalidateWorkspaceTimelineEntriesCache(workspaceRootPath);
        scheduleTimelinePanelRender();
    }
    return didWrite;
}

function recordPomodoroCompletedTimelineEvent(todo, options = {}) {
    if (!workspaceRootPath || !todo?.bundlePath) return false;

    const normalizedBundlePath = path.resolve(todo.bundlePath);
    const normalizedRoot = path.resolve(workspaceRootPath);
    if (!normalizedBundlePath.startsWith(`${normalizedRoot}${path.sep}`) && normalizedBundlePath !== normalizedRoot) {
        return false;
    }

    const noteTitle = getDocumentTitleFromBundlePath(normalizedBundlePath);
    const relativeFolder = getRelativeWorkspaceFolder(normalizedBundlePath);
    const relativeBundlePath = path.relative(normalizedRoot, normalizedBundlePath) || path.basename(normalizedBundlePath);
    const cleanedTodoText = stripTodoCompletionTimestamp(String(todo.text || '').trim());
    const trimmedTodoText = cleanedTodoText.length > 80 ? `${cleanedTodoText.slice(0, 80)}...` : cleanedTodoText;
    const timestamp = Number.isFinite(options.timestamp) ? options.timestamp : Date.now();
    const workMinutes = clampPomodoroMinutes(
        options.workMinutes,
        DEFAULT_POMODORO_STATE.workMinutes,
        POMODORO_WORK_MIN_MINUTES,
        POMODORO_WORK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );

    return appendWorkspaceTimelineEvent({
        id: `pomodoro-completed:${timestamp}:${Math.random().toString(36).slice(2, 10)}`,
        type: 'pomodoro-completed',
        timestamp,
        bundlePath: normalizedBundlePath,
        relativeFolder,
        relativeBundlePath,
        noteTitle,
        todoText: cleanedTodoText,
        workMinutes,
        action: trimmedTodoText
            ? `完成了《${noteTitle}》中的一个番茄：${trimmedTodoText}`
            : `完成了《${noteTitle}》中的一个番茄`
    });
}

function recordTodoCompletedTimelineEvent(todo, options = {}) {
    if (!workspaceRootPath || !todo?.bundlePath) return false;

    const normalizedBundlePath = path.resolve(todo.bundlePath);
    const normalizedRoot = path.resolve(workspaceRootPath);
    if (!normalizedBundlePath.startsWith(`${normalizedRoot}${path.sep}`) && normalizedBundlePath !== normalizedRoot) {
        return false;
    }

    return upsertTodoCompletedTimelineEvent({
        ...todo,
        bundlePath: normalizedBundlePath
    }, {
        ...options,
        checked: true
    });
}

function invalidateWorkspaceTimelineEntriesCache(rootPath = workspaceRootPath) {
    if (!rootPath) {
        workspaceTimelineEntriesCache = null;
        workspaceTimelineEntriesCacheRoot = null;
        workspaceTimelineEntriesCacheDirty = true;
        return;
    }

    const normalizedRoot = path.resolve(rootPath);
    if (!workspaceTimelineEntriesCacheRoot || workspaceTimelineEntriesCacheRoot === normalizedRoot) {
        workspaceTimelineEntriesCache = null;
        workspaceTimelineEntriesCacheRoot = normalizedRoot;
    }
    workspaceTimelineEntriesCacheDirty = true;
}

function invalidateWorkspaceStructureCaches() {
    workspaceChildrenCache = new Map();
    workspaceBundlePathsCache = null;
    workspaceBundlePathsCacheRoot = null;
    workspaceBundlePathsCacheDirty = true;
    workspaceTreeRenderVersion += 1;
}

function formatFileSize(size) {
    const value = Number(size);
    if (!Number.isFinite(value) || value < 0) {
        return '';
    }

    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatVideoTimestamp(dateLike) {
    const date = new Date(dateLike);
    if (Number.isNaN(date.getTime())) {
        return '';
    }

    return date.toLocaleString('zh-CN', {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatMediaDuration(seconds) {
    const totalSeconds = Number(seconds);
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return '--:--';
    }

    const rounded = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(rounded / 3600);
    const minutes = Math.floor((rounded % 3600) / 60);
    const secs = rounded % 60;

    if (hours > 0) {
        return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    }

    return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function getWorkspaceVideoBundleCandidates(rootPath = workspaceRootPath) {
    if (!rootPath) {
        return [];
    }

    return getWorkspaceBundlePaths(rootPath).map((bundlePath) => ({
        path: path.resolve(bundlePath),
        title: getDocumentTitleFromBundlePath(bundlePath),
        relativePath: path.relative(rootPath, bundlePath) || path.basename(bundlePath)
    }));
}

function isValidTextBundlePath(folderPath) {
    if (!folderPath) return false;

    try {
        return Boolean(resolveBundleMarkdownFilePath(folderPath) || isPrivateBundlePath(folderPath));
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
    candidates.push(DEFAULT_BUNDLE_MARKDOWN_FILE, LEGACY_BUNDLE_MARKDOWN_FILE);

    for (const fileName of candidates) {
        const fullPath = path.join(folderPath, fileName);
        if (fs.existsSync(fullPath)) {
            return fullPath;
        }
    }

    if (options.createIfMissing) {
        return path.join(folderPath, options.preferredName || DEFAULT_BUNDLE_MARKDOWN_FILE);
    }

    return '';
}

function getBundleMarkdownFileName(folderPath, options = {}) {
    const fullPath = resolveBundleMarkdownFilePath(folderPath, options);
    return fullPath ? path.basename(fullPath) : (options.preferredName || DEFAULT_BUNDLE_MARKDOWN_FILE);
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

function scheduleWorkspaceDataWarmup(rootPath = workspaceRootPath) {
    if (!rootPath) {
        return;
    }

    const normalizedRootPath = path.resolve(rootPath);
    window.setTimeout(() => {
        if (!workspaceRootPath || path.resolve(workspaceRootPath) !== normalizedRootPath) {
            return;
        }

        getWorkspaceBundlePaths(normalizedRootPath);
    }, 0);
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

function clearBundleAttachmentWatchers() {
    if (bundleAttachmentWatchTimer) {
        window.clearTimeout(bundleAttachmentWatchTimer);
        bundleAttachmentWatchTimer = null;
    }

    if (bundleAttachmentPollTimer) {
        window.clearInterval(bundleAttachmentPollTimer);
        bundleAttachmentPollTimer = null;
    }

    for (const watcher of bundleAttachmentWatchers) {
        try {
            watcher.close();
        } catch {
            // ignore
        }
    }
    bundleAttachmentWatchers = [];
    bundleAttachmentSnapshot = new Map();
    bundleAttachmentSnapshotRoot = null;
}

function getAttachmentIdentityFromPath(targetPath) {
    try {
        const stat = fs.statSync(targetPath);
        const dev = stat?.dev;
        const ino = stat?.ino;
        if ((typeof dev === 'number' || typeof dev === 'bigint') && (typeof ino === 'number' || typeof ino === 'bigint')) {
            return `${String(dev)}:${String(ino)}`;
        }
    } catch {
        // ignore
    }

    return null;
}

function captureBundleAttachmentSnapshot(folderPath = window.currentPath) {
    const snapshot = new Map();
    if (!folderPath) {
        return snapshot;
    }

    const normalizedRoot = path.resolve(folderPath);
    const attachmentsDir = path.join(normalizedRoot, 'attachments');
    if (!fs.existsSync(attachmentsDir)) {
        return snapshot;
    }

    const stack = [attachmentsDir];
    while (stack.length) {
        const currentDir = stack.pop();
        let entries = [];

        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            entries = [];
        }

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);
            const relativePath = normalizeAttachmentMarkdownHref(path.relative(attachmentsDir, absolutePath));
            let stat = null;

            try {
                stat = fs.statSync(absolutePath);
            } catch {
                stat = null;
            }

            const identity = stat ? getAttachmentIdentityFromPath(absolutePath) : null;
            const fallbackKey = `${entry.isDirectory() ? 'dir' : 'file'}:${path.basename(relativePath)}|${stat?.size ?? ''}|${stat?.mtimeMs ?? ''}`;

            snapshot.set(identity ? `${entry.isDirectory() ? 'dir' : 'file'}:${identity}` : fallbackKey, {
                absolutePath,
                relativePath,
                identity,
                size: stat?.size ?? null,
                mtimeMs: stat?.mtimeMs ?? null,
                isDirectory: entry.isDirectory()
            });

            if (entry.isDirectory()) {
                stack.push(absolutePath);
            }
        }
    }

    return snapshot;
}

function diffBundleAttachmentSnapshots(previousSnapshot, nextSnapshot) {
    const previousByIdentity = new Map();
    const nextByIdentity = new Map();
    const previousFallback = new Map();
    const nextFallback = new Map();

    for (const entry of previousSnapshot.values()) {
        if (entry.identity) {
            previousByIdentity.set(`${entry.isDirectory ? 'dir' : 'file'}:${entry.identity}`, entry);
            continue;
        }

        const key = `${entry.isDirectory ? 'dir' : 'file'}:${path.basename(entry.relativePath)}|${entry.size ?? ''}|${entry.mtimeMs ?? ''}`;
        previousFallback.set(key, entry);
    }

    for (const entry of nextSnapshot.values()) {
        if (entry.identity) {
            nextByIdentity.set(`${entry.isDirectory ? 'dir' : 'file'}:${entry.identity}`, entry);
            continue;
        }

        const key = `${entry.isDirectory ? 'dir' : 'file'}:${path.basename(entry.relativePath)}|${entry.size ?? ''}|${entry.mtimeMs ?? ''}`;
        nextFallback.set(key, entry);
    }

    const renamePairs = [];
    const renamedDirectorySources = [];
    const isInsideRenamedDirectory = (absolutePath) => {
        const normalizedPath = path.resolve(String(absolutePath || ''));
        return renamedDirectorySources.some((directoryPath) => {
            const normalizedDirectory = path.resolve(String(directoryPath || ''));
            return normalizedPath === normalizedDirectory || normalizedPath.startsWith(`${normalizedDirectory}${path.sep}`);
        });
    };

    for (const [identityKey, previousEntry] of previousByIdentity) {
        if (!previousEntry.isDirectory && isInsideRenamedDirectory(previousEntry.absolutePath)) {
            continue;
        }

        const nextEntry = nextByIdentity.get(identityKey);
        if (!nextEntry || nextEntry.relativePath === previousEntry.relativePath) {
            continue;
        }

        if (previousEntry.isDirectory) {
            renamedDirectorySources.push(previousEntry.absolutePath);
        }

        renamePairs.push({
            oldAbsolutePath: previousEntry.absolutePath,
            newAbsolutePath: nextEntry.absolutePath
        });
    }

    for (const [key, previousEntry] of previousFallback) {
        if (previousEntry.isDirectory && isInsideRenamedDirectory(previousEntry.absolutePath)) {
            continue;
        }

        const nextEntry = nextFallback.get(key);
        if (!nextEntry || nextEntry.relativePath === previousEntry.relativePath) {
            continue;
        }

        if (previousEntry.isDirectory) {
            renamedDirectorySources.push(previousEntry.absolutePath);
        } else if (isInsideRenamedDirectory(previousEntry.absolutePath)) {
            continue;
        }

        renamePairs.push({
            oldAbsolutePath: previousEntry.absolutePath,
            newAbsolutePath: nextEntry.absolutePath
        });
    }

    return renamePairs;
}

function refreshCurrentBundleAttachmentSnapshot(folderPath = window.currentPath) {
    if (!folderPath) {
        bundleAttachmentSnapshot = new Map();
        bundleAttachmentSnapshotRoot = null;
        return [];
    }

    const normalizedRoot = path.resolve(folderPath);
    const nextSnapshot = captureBundleAttachmentSnapshot(normalizedRoot);
    const renamePairs = bundleAttachmentSnapshotRoot === normalizedRoot
        ? diffBundleAttachmentSnapshots(bundleAttachmentSnapshot, nextSnapshot)
        : [];

    bundleAttachmentSnapshot = nextSnapshot;
    bundleAttachmentSnapshotRoot = normalizedRoot;
    return renamePairs;
}

function repairTabAttachmentStateFromFilesystem(tab) {
    if (!tab?.path) {
        return false;
    }

    const normalizedRoot = path.resolve(tab.path);
    const previousSnapshot = tab.attachmentSnapshotRoot && path.resolve(String(tab.attachmentSnapshotRoot || '')) === normalizedRoot
        ? tab.attachmentSnapshot
        : null;
    const nextSnapshot = captureBundleAttachmentSnapshot(normalizedRoot);
    const renamePairs = previousSnapshot ? diffBundleAttachmentSnapshots(previousSnapshot, nextSnapshot) : [];
    if (!renamePairs.length) {
        tab.attachmentSnapshot = nextSnapshot;
        tab.attachmentSnapshotRoot = normalizedRoot;
        return false;
    }

    let nextContent = typeof tab.content === 'string' ? tab.content : '';
    let nextDocumentJson = cloneSerializableValue(tab.documentJson);
    let didChange = false;

    for (const pair of renamePairs) {
        if (!pair?.oldAbsolutePath || !pair?.newAbsolutePath) {
            continue;
        }

        const rewrittenContent = rewriteAttachmentReferencesAfterRenameInMarkdown(
            nextContent,
            pair.oldAbsolutePath,
            pair.newAbsolutePath,
            normalizedRoot
        );
        if (rewrittenContent !== nextContent) {
            nextContent = rewrittenContent;
            didChange = true;
        }

        if (nextDocumentJson) {
            const rewrittenDocumentJson = rewriteAttachmentReferencesAfterRenameInDocumentJson(
                nextDocumentJson,
                pair.oldAbsolutePath,
                pair.newAbsolutePath,
                normalizedRoot
            );
            if (JSON.stringify(rewrittenDocumentJson || null) !== JSON.stringify(nextDocumentJson || null)) {
                nextDocumentJson = rewrittenDocumentJson;
                didChange = true;
            }
        }
    }

    tab.attachmentSnapshot = nextSnapshot;
    tab.attachmentSnapshotRoot = normalizedRoot;

    if (!didChange) {
        return false;
    }

    tab.content = nextContent;
    tab.documentJson = nextDocumentJson;
    tab.previousContent = nextContent;
    if (!tab.isDirty) {
        resetTabHistory(tab, nextContent);
    }
    return true;
}

function scheduleCurrentBundleAttachmentRefresh() {
    if (bundleAttachmentWatchTimer) {
        window.clearTimeout(bundleAttachmentWatchTimer);
    }

    bundleAttachmentWatchTimer = window.setTimeout(async () => {
        bundleAttachmentWatchTimer = null;
        if (!window.currentPath || !window.editor) {
            return;
        }

        const activeTab = getActiveTab();
        if (!activeTab || path.resolve(activeTab.path || '') !== path.resolve(window.currentPath || '')) {
            return;
        }

        const renamePairs = refreshCurrentBundleAttachmentSnapshot(window.currentPath);
        let didRepair = false;

        for (const pair of renamePairs) {
            if (!pair?.oldAbsolutePath || !pair?.newAbsolutePath) {
                continue;
            }

            didRepair = Boolean(await syncOpenEditorAfterAttachmentRename(pair.oldAbsolutePath, pair.newAbsolutePath)) || didRepair;
        }

        if (typeof window.editor.repairAttachmentReferencesByIdentity === 'function') {
            didRepair = Boolean(window.editor.repairAttachmentReferencesByIdentity());
        }

        if (typeof window.editor.refreshLinkDomState === 'function') {
            window.editor.refreshLinkDomState(true);
        }
        if (typeof window.editor.refreshAttachmentNodeLabels === 'function') {
            window.editor.refreshAttachmentNodeLabels(true);
        }
        updateOutline(true);
        updatePreview({ preserveViewport: true, preserveMode: 'anchor' });

        if (didRepair && typeof window.editor.getValue === 'function') {
            persistActiveTabState(window.editor.getValue());
            scheduleAutoSave();
        }
    }, 90);
}

function registerCurrentBundleAttachmentWatchers(folderPath = window.currentPath) {
    clearBundleAttachmentWatchers();

    if (!folderPath) {
        return;
    }

    const normalizedBundlePath = path.resolve(folderPath);
    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    if (!fs.existsSync(attachmentsDir)) {
        return;
    }

    refreshCurrentBundleAttachmentSnapshot(normalizedBundlePath);

    const handleAttachmentChange = () => {
        if (Date.now() < suppressBundleAttachmentWatcherUntil) return;
        scheduleCurrentBundleAttachmentRefresh();
    };

    const supportsRecursiveWatch = process.platform === 'darwin' || process.platform === 'win32';
    if (supportsRecursiveWatch) {
        try {
            const watcher = fs.watch(attachmentsDir, { recursive: true }, handleAttachmentChange);
            bundleAttachmentWatchers.push(watcher);
            return;
        } catch {
            // fallback below
        }
    }

    const visited = new Set();
    const watchDirectory = (dirPath) => {
        const normalizedDir = path.resolve(dirPath);
        if (visited.has(normalizedDir)) return;
        visited.add(normalizedDir);

        try {
            const watcher = fs.watch(normalizedDir, handleAttachmentChange);
            bundleAttachmentWatchers.push(watcher);
        } catch {
            return;
        }

        for (const entry of fs.readdirSync(normalizedDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            watchDirectory(path.join(normalizedDir, entry.name));
        }
    };

    watchDirectory(attachmentsDir);
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

function updateImportProgressModal() {
    if (importProgressModalFrame != null) {
        return;
    }

    importProgressModalFrame = window.requestAnimationFrame(() => {
        importProgressModalFrame = null;
        const modal = document.getElementById('import-progress-modal');
        if (!modal) return;

        const state = importProgressModalState;
        if (!state) {
            modal.classList.remove('show');
            modal.setAttribute('aria-hidden', 'true');
            return;
        }

        const title = document.getElementById('import-progress-title');
        const detail = document.getElementById('import-progress-detail');
        const fill = document.getElementById('import-progress-fill');
        const left = document.getElementById('import-progress-left');
        const right = document.getElementById('import-progress-right');

        if (title) title.textContent = state.title || '正在导入附件';
        if (detail) detail.textContent = state.detail || '请稍候，正在处理文件夹内容。';

        const total = Number(state.total || 0);
        const completed = Number(state.completed || 0);
        const percent = total > 0 ? Math.min(100, Math.max(0, Math.round((completed / total) * 100))) : 0;
        if (fill) {
            fill.style.width = `${percent}%`;
        }
        if (left) {
            left.textContent = `${completed} / ${total}`;
        }
        if (right) {
            right.textContent = `${percent}%`;
        }

        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');
    });
}

function showImportProgressModal(state = {}) {
    importProgressModalState = {
        title: String(state.title || '正在导入附件'),
        detail: String(state.detail || '请稍候，正在处理文件夹内容。'),
        total: Math.max(0, Number(state.total || 0)),
        completed: Math.max(0, Number(state.completed || 0))
    };
    updateImportProgressModal();
}

function setImportProgressModalProgress(completed, total, detail = null) {
    if (!importProgressModalState) {
        showImportProgressModal({ completed, total, detail });
        return;
    }

    importProgressModalState.completed = Math.max(0, Number(completed || 0));
    importProgressModalState.total = Math.max(0, Number(total || 0));
    if (detail != null) {
        importProgressModalState.detail = String(detail || '');
    }
    updateImportProgressModal();
}

function hideImportProgressModal() {
    importProgressModalState = null;
    if (importProgressModalFrame != null) {
        window.cancelAnimationFrame(importProgressModalFrame);
        importProgressModalFrame = null;
    }
    updateImportProgressModal();
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
            invalidateWorkspaceStructureCaches();
            renderWorkspaceTree(true);
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
        refreshWorkspaceTreeFromFilesystem({ refreshCurrentDocument: true });
    }, 0);
}

function refreshWorkspaceTreeFromFilesystem(options = {}) {
    const refreshCurrentDocument = options.refreshCurrentDocument !== false;

    if (workspaceRefreshTimer) {
        window.clearTimeout(workspaceRefreshTimer);
        workspaceRefreshTimer = null;
    }

    workspaceRefreshPending = false;
    workspaceTodoRenderVersion += 1;
    workspaceTreeRenderVersion += 1;
    invalidateWorkspaceStructureCaches();
    renderWorkspaceTree(true);
    registerWorkspaceWatchers();
    if (timelinePanelOpen && currentRightSidebarTab === 'todo') {
        renderTodoList(getActiveEditorSnapshot());
    }

    if (refreshCurrentDocument && window.currentPath && window.editor && typeof window.editor.refreshDisplayState === 'function') {
        const didRepairDocument = window.editor.refreshDisplayState();
        if (didRepairDocument) {
            suppressWorkspaceWatcherUntil = Date.now() + 1500;
            void saveFile({ silent: true });
        }
    }
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

function normalizeTimelineTodoGroupSettings(settings = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const rawHidden = source.hiddenCompletedByGroup && typeof source.hiddenCompletedByGroup === 'object'
        ? source.hiddenCompletedByGroup
        : (source.hideCompletedByGroup && typeof source.hideCompletedByGroup === 'object'
            ? source.hideCompletedByGroup
            : {});
    const hiddenCompletedByGroup = {};

    for (const [key, value] of Object.entries(rawHidden)) {
        const normalizedKey = String(key || '').trim();
        if (!normalizedKey) {
            continue;
        }
        hiddenCompletedByGroup[normalizedKey] = Boolean(value);
    }

    return {
        hiddenCompletedByGroup
    };
}

function loadTimelineTodoGroupSettings() {
    try {
        const raw = window.localStorage.getItem(TIMELINE_TODO_GROUP_SETTINGS_KEY);
        return normalizeTimelineTodoGroupSettings(raw ? JSON.parse(raw) : {});
    } catch {
        return normalizeTimelineTodoGroupSettings();
    }
}

function saveTimelineTodoGroupSettings(settings = {}) {
    const normalized = normalizeTimelineTodoGroupSettings(settings);
    try {
        window.localStorage.setItem(TIMELINE_TODO_GROUP_SETTINGS_KEY, JSON.stringify(normalized));
    } catch {
        // ignore persistence failures
    }
    return normalized;
}

function getTimelineTodoGroupKey(bundlePath) {
    const normalizedPath = String(bundlePath || '').trim();
    if (!normalizedPath || normalizedPath === 'Someday') {
        return 'Someday';
    }
    return path.resolve(normalizedPath);
}

function isTimelineTodoGroupHidden(bundlePath) {
    const settings = loadTimelineTodoGroupSettings();
    return Boolean(settings.hiddenCompletedByGroup[getTimelineTodoGroupKey(bundlePath)]);
}

function setTimelineTodoGroupHidden(bundlePath, hidden) {
    const settings = loadTimelineTodoGroupSettings();
    settings.hiddenCompletedByGroup[getTimelineTodoGroupKey(bundlePath)] = Boolean(hidden);
    saveTimelineTodoGroupSettings(settings);
    scheduleTimelinePanelRender();
}

function toggleTimelineTodoGroupHidden(bundlePath) {
    const settings = loadTimelineTodoGroupSettings();
    const key = getTimelineTodoGroupKey(bundlePath);
    const nextHidden = !Boolean(settings.hiddenCompletedByGroup[key]);
    settings.hiddenCompletedByGroup[key] = nextHidden;
    saveTimelineTodoGroupSettings(settings);
    scheduleTimelinePanelRender();
    return nextHidden;
}

function normalizePinnedEditorTabPaths(paths = []) {
    if (!Array.isArray(paths)) return [];

    const normalized = [];
    const seen = new Set();
    for (const entry of paths) {
        if (!entry) continue;
        const normalizedPath = path.resolve(String(entry));
        if (seen.has(normalizedPath)) continue;
        seen.add(normalizedPath);
        normalized.push(normalizedPath);
    }
    return normalized;
}

function loadPinnedEditorTabPaths() {
    try {
        const raw = localStorage.getItem(PINNED_EDITOR_TABS_KEY);
        if (!raw) return [];
        return normalizePinnedEditorTabPaths(JSON.parse(raw));
    } catch {
        return [];
    }
}

function savePinnedEditorTabPaths(paths = []) {
    const normalized = normalizePinnedEditorTabPaths(paths);
    try {
        if (normalized.length) {
            localStorage.setItem(PINNED_EDITOR_TABS_KEY, JSON.stringify(normalized));
        } else {
            localStorage.removeItem(PINNED_EDITOR_TABS_KEY);
        }
    } catch {
        // Ignore preference failures.
    }
    return normalized;
}

function getPinnedEditorTabPathsFromOpenTabs() {
    return normalizePinnedEditorTabPaths(
        editorTabs
            .filter((tab) => tab?.pinned && tab.path)
            .map((tab) => tab.path)
    );
}

function persistPinnedEditorTabPathsFromOpenTabs() {
    return savePinnedEditorTabPaths(getPinnedEditorTabPathsFromOpenTabs());
}

function normalizeEditorTabOrder() {
    if (!Array.isArray(editorTabs) || editorTabs.length < 2) {
        return editorTabs;
    }

    const pinnedOrder = loadPinnedEditorTabPaths();
    const pinnedOrderMap = new Map(pinnedOrder.map((tabPath, index) => [path.resolve(tabPath), index]));
    const pinnedTabs = [];
    const unpinnedTabs = [];

    editorTabs.forEach((tab, index) => {
        if (!tab?.pinned || !tab.path) {
            unpinnedTabs.push({ tab, index });
            return;
        }

        pinnedTabs.push({ tab, index });
    });

    pinnedTabs.sort((left, right) => {
        const leftKey = path.resolve(left.tab.path);
        const rightKey = path.resolve(right.tab.path);
        const leftOrder = pinnedOrderMap.has(leftKey) ? pinnedOrderMap.get(leftKey) : Number.MAX_SAFE_INTEGER;
        const rightOrder = pinnedOrderMap.has(rightKey) ? pinnedOrderMap.get(rightKey) : Number.MAX_SAFE_INTEGER;

        if (leftOrder !== rightOrder) {
            return leftOrder - rightOrder;
        }

        return left.index - right.index;
    });

    editorTabs = pinnedTabs.map((entry) => entry.tab).concat(unpinnedTabs.map((entry) => entry.tab));
    return editorTabs;
}

function isEditorTabPinned(tabId = activeTabId) {
    const tab = getTabById(tabId);
    return Boolean(tab?.pinned);
}

function setEditorTabPinned(tabId, pinned) {
    const tab = getTabById(tabId);
    if (!tab) return false;

    const nextPinned = Boolean(pinned);
    if (tab.pinned === nextPinned) {
        return true;
    }

    tab.pinned = nextPinned;
    const tabPath = tab.path ? path.resolve(tab.path) : null;
    if (tabPath) {
        const nextPinnedPaths = loadPinnedEditorTabPaths().filter((entry) => path.resolve(entry) !== tabPath);
        if (nextPinned) {
            nextPinnedPaths.push(tabPath);
        }
        savePinnedEditorTabPaths(nextPinnedPaths);
    } else {
        persistPinnedEditorTabPathsFromOpenTabs();
    }
    normalizeEditorTabOrder();
    renderEditorTabs();
    return true;
}

function clampPomodoroMinutes(value, fallback, min = 1, max = 180, step = 1) {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (typeof value === 'string' && value.trim() === '') {
        return fallback;
    }
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    const safeStep = Number.isFinite(step) && step > 1 ? Math.round(step) : 1;
    let normalized = Math.round(numeric);
    if (safeStep > 1) {
        normalized = min + Math.round((normalized - min) / safeStep) * safeStep;
    }
    return Math.min(max, Math.max(min, normalized));
}

function normalizePomodoroTodo(todo) {
    if (!todo || !todo.bundlePath) {
        return null;
    }

    return {
        bundlePath: path.resolve(todo.bundlePath),
        kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : 0,
        text: String(todo.text || '').trim(),
        documentTitle: String(todo.documentTitle || getDocumentTitleFromBundlePath(todo.bundlePath) || ''),
        relativeFolder: String(todo.relativeFolder || getRelativeWorkspaceFolder(todo.bundlePath) || ''),
        lineNumber: Number.isInteger(todo.lineNumber) ? todo.lineNumber : 1
    };
}

function normalizePomodoroState(state = {}) {
    const normalized = {
        ...DEFAULT_POMODORO_STATE,
        ...state
    };
    normalized.workMinutes = clampPomodoroMinutes(
        normalized.workMinutes,
        DEFAULT_POMODORO_STATE.workMinutes,
        POMODORO_WORK_MIN_MINUTES,
        POMODORO_WORK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );
    normalized.breakMinutes = clampPomodoroMinutes(
        normalized.breakMinutes,
        DEFAULT_POMODORO_STATE.breakMinutes,
        POMODORO_BREAK_MIN_MINUTES,
        POMODORO_BREAK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );
    normalized.phase = ['idle', 'work', 'work-paused', 'work-snooze', 'work-complete', 'break', 'break-complete'].includes(normalized.phase)
        ? normalized.phase
        : 'idle';
    normalized.phaseDurationMinutes = Number.isFinite(normalized.phaseDurationMinutes)
        ? clampPomodoroMinutes(normalized.phaseDurationMinutes, null, 1, POMODORO_WORK_MAX_MINUTES)
        : null;
    if (!['work', 'work-paused', 'work-snooze', 'break'].includes(normalized.phase)) {
        normalized.phaseDurationMinutes = null;
    }
    normalized.selectedTodo = normalizePomodoroTodo(normalized.selectedTodo);
    normalized.activeTodo = normalizePomodoroTodo(normalized.activeTodo);
    normalized.startedAt = Number.isFinite(normalized.startedAt) ? normalized.startedAt : null;
    normalized.endsAt = Number.isFinite(normalized.endsAt) ? normalized.endsAt : null;
    normalized.cycleCount = Number.isFinite(normalized.cycleCount) ? Math.max(0, Math.round(normalized.cycleCount)) : 0;
    normalized.todayCycleDate = typeof normalized.todayCycleDate === 'string' ? normalized.todayCycleDate : null;
    normalized.todayCycleCount = Number.isFinite(normalized.todayCycleCount) ? Math.max(0, Math.round(normalized.todayCycleCount)) : 0;
    normalized.pausedRemainingMs = Number.isFinite(normalized.pausedRemainingMs)
        ? Math.max(0, Math.round(normalized.pausedRemainingMs))
        : null;
    if (normalized.phase !== 'work-paused') {
        normalized.pausedRemainingMs = null;
    }
    normalized.snoozeMinutes = Number.isFinite(normalized.snoozeMinutes) ? Math.max(0, Math.round(normalized.snoozeMinutes)) : null;
    normalized.updatedAt = Number.isFinite(normalized.updatedAt) ? normalized.updatedAt : null;
    return normalized;
}

function loadPomodoroState() {
    try {
        const raw = localStorage.getItem(POMODORO_STATE_SETTINGS_KEY);
        return normalizePomodoroState(raw ? JSON.parse(raw) : {});
    } catch {
        return { ...DEFAULT_POMODORO_STATE };
    }
}

function persistPomodoroState(options = {}) {
    const { render = true } = options;
    pomodoroState = normalizePomodoroState({
        ...pomodoroState,
        updatedAt: Date.now()
    });
    try {
        localStorage.setItem(POMODORO_STATE_SETTINGS_KEY, JSON.stringify(pomodoroState));
    } catch {
        // ignore persistence failures
    }
    if (render && timelinePanelOpen && currentRightSidebarTab === 'pomodoro') {
        renderPomodoroPanel();
    }
}

function ensurePomodoroState() {
    if (!pomodoroState) {
        pomodoroState = loadPomodoroState();
    }
    return pomodoroState;
}

function isPomodoroRunningPhase(phase = ensurePomodoroState().phase) {
    return phase === 'work' || phase === 'work-snooze' || phase === 'break';
}

function formatPomodoroCountdown(ms) {
    const safe = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(safe / 60);
    const seconds = safe % 60;
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function getPomodoroRemainingMs() {
    const state = ensurePomodoroState();
    if (state.phase === 'work-paused' && Number.isFinite(state.pausedRemainingMs)) {
        return Math.max(0, state.pausedRemainingMs);
    }
    if (!Number.isFinite(state.endsAt)) {
        return 0;
    }
    return Math.max(0, state.endsAt - Date.now());
}

function getPomodoroTaskKey(todo) {
    const normalizedTodo = normalizePomodoroTodo(todo);
    if (!normalizedTodo) {
        return '';
    }
    return `${normalizedTodo.bundlePath}::${normalizedTodo.kindIndex}`;
}

function getPomodoroTodayCycleCount() {
    ensurePomodoroState();
    const todayKey = getDateKey(new Date());
    return pomodoroState.todayCycleDate === todayKey
        ? Math.max(0, Number(pomodoroState.todayCycleCount) || 0)
        : 0;
}

function incrementPomodoroTodayCycleCount() {
    ensurePomodoroState();
    const todayKey = getDateKey(new Date());
    if (pomodoroState.todayCycleDate !== todayKey) {
        pomodoroState.todayCycleDate = todayKey;
        pomodoroState.todayCycleCount = 0;
    }
    pomodoroState.todayCycleCount += 1;
}

function getPomodoroDisplayedCycleCount() {
    ensurePomodoroState();
    const todayCycleCount = getPomodoroTodayCycleCount();
    const count = todayCycleCount + ((pomodoroState.phase === 'idle' || pomodoroState.phase === 'break') ? 1 : 0);
    return Math.max(1, count);
}

function getPomodoroModePreview(mode) {
    ensurePomodoroState();
    switch (mode) {
        case 'short-break':
            return {
                label: '休息时间',
                minutes: pomodoroState.breakMinutes,
                kind: 'break'
            };
        case 'long-break':
            return {
                label: '休息时间',
                minutes: Math.max(pomodoroState.breakMinutes, 15),
                kind: 'break'
            };
        case 'custom':
            return {
                label: '专注时间',
                minutes: pomodoroState.workMinutes,
                kind: 'focus'
            };
        case 'focus':
        default:
            return {
                label: '专注时间',
                minutes: pomodoroState.workMinutes,
                kind: 'focus'
            };
    }
}

function startPomodoroSelectedMode() {
    ensurePomodoroState();
    const preview = getPomodoroModePreview(pomodoroSelectedMode);
    if (preview.kind === 'break') {
        return startPomodoroBreak(preview.minutes);
    }
    return startPomodoroWork(pomodoroState.activeTodo || pomodoroState.selectedTodo);
}

function selectPomodoroMode(mode) {
    ensurePomodoroState();
    pomodoroSelectedMode = mode;
    pomodoroCustomSettingsOpen = false;
    if (pomodoroState.phase !== 'idle') {
        stopPomodoroSession();
    }
    renderPomodoroPanel();
}

function selectPomodoroTodo(todo) {
    const normalizedTodo = normalizePomodoroTodo(todo);
    if (!normalizedTodo) return;
    ensurePomodoroState();
    pomodoroState.selectedTodo = normalizedTodo;
    pomodoroTaskPickerOpen = false;
    persistPomodoroState();
}

function updatePomodoroDurations(workMinutes, breakMinutes, options = {}) {
    ensurePomodoroState();
    const {
        render = true,
        persist = true
    } = options;
    const nextWorkMinutes = clampPomodoroMinutes(
        workMinutes,
        pomodoroState.workMinutes,
        POMODORO_WORK_MIN_MINUTES,
        POMODORO_WORK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );
    const nextBreakMinutes = clampPomodoroMinutes(
        breakMinutes,
        pomodoroState.breakMinutes,
        POMODORO_BREAK_MIN_MINUTES,
        POMODORO_BREAK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );
    pomodoroState.workMinutes = nextWorkMinutes;
    pomodoroState.breakMinutes = nextBreakMinutes;

    if (pomodoroState.phase === 'work' && Number.isFinite(pomodoroState.startedAt)) {
        pomodoroState.phaseDurationMinutes = nextWorkMinutes;
        pomodoroState.endsAt = pomodoroState.startedAt + nextWorkMinutes * 60 * 1000;
    } else if (pomodoroState.phase === 'work-paused') {
        pomodoroState.phaseDurationMinutes = nextWorkMinutes;
        pomodoroState.pausedRemainingMs = Math.min(
            Number.isFinite(pomodoroState.pausedRemainingMs)
                ? pomodoroState.pausedRemainingMs
                : nextWorkMinutes * 60 * 1000,
            nextWorkMinutes * 60 * 1000
        );
    } else if (pomodoroState.phase === 'break' && Number.isFinite(pomodoroState.startedAt)) {
        pomodoroState.phaseDurationMinutes = nextBreakMinutes;
        pomodoroState.endsAt = pomodoroState.startedAt + nextBreakMinutes * 60 * 1000;
    }

    if (persist) {
        persistPomodoroState({ render });
        return;
    }
    if (render && timelinePanelOpen && currentRightSidebarTab === 'pomodoro') {
        renderPomodoroPanel();
    }
}

function startPomodoroWork(todo = null) {
    ensurePomodoroState();
    const selectedTodo = normalizePomodoroTodo(todo || pomodoroState.selectedTodo || pomodoroState.activeTodo);
    const now = Date.now();
    pomodoroState.selectedTodo = selectedTodo;
    pomodoroState.activeTodo = selectedTodo;
    pomodoroState.phase = 'work';
    pomodoroState.phaseDurationMinutes = pomodoroState.workMinutes;
    pomodoroState.startedAt = now;
    pomodoroState.endsAt = now + pomodoroState.workMinutes * 60 * 1000;
    pomodoroState.pausedRemainingMs = null;
    pomodoroState.snoozeMinutes = null;
    ensurePomodoroTicker();
    persistPomodoroState();
    return true;
}

function startPomodoroBreak(overrideMinutes = null) {
    ensurePomodoroState();
    const now = Date.now();
    const breakMinutes = clampPomodoroMinutes(
        overrideMinutes,
        pomodoroState.breakMinutes,
        POMODORO_BREAK_MIN_MINUTES,
        POMODORO_BREAK_MAX_MINUTES,
        POMODORO_DURATION_STEP_MINUTES
    );
    pomodoroState.phase = 'break';
    pomodoroState.phaseDurationMinutes = breakMinutes;
    pomodoroState.startedAt = now;
    pomodoroState.endsAt = now + breakMinutes * 60 * 1000;
    pomodoroState.pausedRemainingMs = null;
    pomodoroState.snoozeMinutes = null;
    ensurePomodoroTicker();
    persistPomodoroState();
    return true;
}

function pausePomodoroWork() {
    ensurePomodoroState();
    if (pomodoroState.phase !== 'work') {
        return false;
    }

    const remainingMs = getPomodoroRemainingMs();
    if (!(remainingMs > 0)) {
        return false;
    }

    pomodoroState.phase = 'work-paused';
    pomodoroState.startedAt = null;
    pomodoroState.endsAt = null;
    pomodoroState.pausedRemainingMs = remainingMs;
    persistPomodoroState();
    return true;
}

function resumePomodoroWork() {
    ensurePomodoroState();
    if (pomodoroState.phase !== 'work-paused') {
        return false;
    }

    const remainingMs = Math.max(
        1000,
        Number.isFinite(pomodoroState.pausedRemainingMs)
            ? pomodoroState.pausedRemainingMs
            : pomodoroState.workMinutes * 60 * 1000
    );
    const now = Date.now();
    pomodoroState.phase = 'work';
    pomodoroState.phaseDurationMinutes = Number.isFinite(pomodoroState.phaseDurationMinutes)
        ? pomodoroState.phaseDurationMinutes
        : pomodoroState.workMinutes;
    pomodoroState.startedAt = now;
    pomodoroState.endsAt = now + remainingMs;
    pomodoroState.pausedRemainingMs = null;
    persistPomodoroState();
    return true;
}

function resetPomodoroWorkTimer() {
    ensurePomodoroState();
    if (pomodoroState.phase !== 'work' && pomodoroState.phase !== 'work-paused') {
        return false;
    }

    const now = Date.now();
    pomodoroState.phase = 'work';
    pomodoroState.phaseDurationMinutes = pomodoroState.workMinutes;
    pomodoroState.startedAt = now;
    pomodoroState.endsAt = now + pomodoroState.workMinutes * 60 * 1000;
    pomodoroState.pausedRemainingMs = null;
    persistPomodoroState();
    return true;
}

function switchPomodoroWorkToBreak() {
    ensurePomodoroState();
    if (pomodoroState.phase !== 'work' && pomodoroState.phase !== 'work-paused') {
        return false;
    }
    return startPomodoroBreak();
}

function snoozePomodoroReminder(minutes) {
    ensurePomodoroState();
    const snoozeMinutes = clampPomodoroMinutes(minutes, 5, 1, 30);
    pomodoroState.phase = 'work-snooze';
    pomodoroState.phaseDurationMinutes = snoozeMinutes;
    pomodoroState.startedAt = Date.now();
    pomodoroState.endsAt = pomodoroState.startedAt + snoozeMinutes * 60 * 1000;
    pomodoroState.snoozeMinutes = snoozeMinutes;
    ensurePomodoroTicker();
    persistPomodoroState();
}

function stopPomodoroSession() {
    ensurePomodoroState();
    pomodoroState.phase = 'idle';
    pomodoroState.phaseDurationMinutes = null;
    pomodoroState.startedAt = null;
    pomodoroState.endsAt = null;
    pomodoroState.pausedRemainingMs = null;
    pomodoroState.snoozeMinutes = null;
    persistPomodoroState();
}

let pomodoroAudioContext = null;

function playPomodoroAlertSound() {
    try {
        const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextCtor) return;
        if (!pomodoroAudioContext) {
            pomodoroAudioContext = new AudioContextCtor();
        }
        const ctx = pomodoroAudioContext;
        if (ctx.state === 'suspended') {
            void ctx.resume();
        }

        const now = ctx.currentTime + 0.02;
        const notes = [523.25, 659.25, 783.99, 1046.5];
        notes.forEach((frequency, index) => {
            const start = now + index * 0.34;
            const duration = 0.68;
            const gain = ctx.createGain();
            const osc = ctx.createOscillator();
            const osc2 = ctx.createOscillator();
            const filter = ctx.createBiquadFilter();

            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(2600, start);
            filter.Q.setValueAtTime(0.35, start);

            osc.type = 'triangle';
            osc.frequency.setValueAtTime(frequency, start);
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(frequency * 2, start);

            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.18, start + 0.04);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);

            osc.connect(filter);
            osc2.connect(filter);
            filter.connect(gain);
            gain.connect(ctx.destination);

            osc.start(start);
            osc.stop(start + duration + 0.02);
            osc2.start(start);
            osc2.stop(start + duration * 0.82);
        });
    } catch {
        // ignore audio failures
    }
}

function getPomodoroDisplayTotalMs() {
    const state = ensurePomodoroState();
    if (isPomodoroRunningPhase(state.phase) && Number.isFinite(state.phaseDurationMinutes)) {
        return state.phaseDurationMinutes * 60 * 1000;
    }
    if (state.phase === 'work') {
        return state.workMinutes * 60 * 1000;
    }
    if (state.phase === 'work-paused') {
        return (state.phaseDurationMinutes || state.workMinutes) * 60 * 1000;
    }
    if (state.phase === 'work-snooze') {
        return (state.snoozeMinutes || 5) * 60 * 1000;
    }
    if (state.phase === 'break') {
        return state.breakMinutes * 60 * 1000;
    }
    return state.workMinutes * 60 * 1000;
}

function getPomodoroProgress() {
    const state = ensurePomodoroState();
    if (state.phase === 'work-paused' && Number.isFinite(state.pausedRemainingMs)) {
        const total = Math.max(1000, getPomodoroDisplayTotalMs());
        const elapsed = Math.max(0, total - state.pausedRemainingMs);
        return Math.min(1, Math.max(0, elapsed / total));
    }
    if (!isPomodoroRunningPhase(state.phase) || !Number.isFinite(state.startedAt) || !Number.isFinite(state.endsAt)) {
        return state.phase === 'work-complete' || state.phase === 'break-complete' ? 1 : 0;
    }
    const total = Math.max(1000, getPomodoroDisplayTotalMs());
    const elapsed = Math.max(0, Date.now() - state.startedAt);
    return Math.min(1, Math.max(0, elapsed / total));
}

function getPomodoroStats(rootPath = workspaceRootPath) {
    const events = readWorkspaceTimelineEvents(rootPath).filter((entry) => String(entry?.type || '') === 'pomodoro-completed');
    const dailyCounts = new Map();
    const weeklyCounts = new Map();
    const monthlyCounts = new Map();
    const yearlyCounts = new Map();
    const taskCounts = new Map();

    for (const entry of events) {
        const entryDate = new Date(entry.timestamp);
        const dateKey = getDateKey(entryDate);
        const weekStart = getStartOfWeek(entryDate);
        const weekEnd = new Date(weekStart);
        weekEnd.setDate(weekEnd.getDate() + 6);
        const weekKey = `${getDateKey(weekStart)} ~ ${getDateKey(weekEnd)}`;
        const monthKey = `${entryDate.getFullYear()}-${String(entryDate.getMonth() + 1).padStart(2, '0')}`;
        const yearKey = `${entryDate.getFullYear()}`;
        dailyCounts.set(dateKey, (dailyCounts.get(dateKey) || 0) + 1);
        weeklyCounts.set(weekKey, (weeklyCounts.get(weekKey) || 0) + 1);
        monthlyCounts.set(monthKey, (monthlyCounts.get(monthKey) || 0) + 1);
        yearlyCounts.set(yearKey, (yearlyCounts.get(yearKey) || 0) + 1);
        const taskLabel = String(entry.todoText || '').trim() || String(entry.noteTitle || '未命名任务');
        taskCounts.set(taskLabel, (taskCounts.get(taskLabel) || 0) + 1);
    }

    return {
        daily: Array.from(dailyCounts.entries())
            .sort((left, right) => right[0].localeCompare(left[0]))
            .slice(0, 10),
        weekly: Array.from(weeklyCounts.entries())
            .sort((left, right) => right[0].localeCompare(left[0]))
            .slice(0, 10),
        monthly: Array.from(monthlyCounts.entries())
            .sort((left, right) => right[0].localeCompare(left[0]))
            .slice(0, 12),
        yearly: Array.from(yearlyCounts.entries())
            .sort((left, right) => right[0].localeCompare(left[0]))
            .slice(0, 10),
        tasks: Array.from(taskCounts.entries())
            .sort((left, right) => {
                if (right[1] !== left[1]) return right[1] - left[1];
                return left[0].localeCompare(right[0], 'zh-Hans-CN');
            })
            .slice(0, 12)
    };
}

async function revealPomodoroReminder() {
    setSidebarTab('pomodoro');
    try {
        await ipcRenderer.invoke('window:showAndFocus');
    } catch {
        // ignore focus failures
    }
}

async function completePomodoroPhase(nextPhase) {
    ensurePomodoroState();
    const completedTodo = normalizePomodoroTodo(pomodoroState.activeTodo || pomodoroState.selectedTodo);
    const currentPhase = pomodoroState.phase;
    pomodoroState.phase = nextPhase;
    pomodoroState.phaseDurationMinutes = null;
    pomodoroState.startedAt = null;
    pomodoroState.endsAt = null;
    pomodoroState.pausedRemainingMs = null;
    pomodoroState.snoozeMinutes = null;
    if (currentPhase === 'work' && nextPhase === 'work-complete') {
        pomodoroState.cycleCount += 1;
        incrementPomodoroTodayCycleCount();
        if (completedTodo) {
            recordPomodoroCompletedTimelineEvent(completedTodo, {
                workMinutes: pomodoroState.workMinutes
            });
        }
        playPomodoroAlertSound();
    } else if (nextPhase === 'break-complete') {
        playPomodoroAlertSound();
    } else if (nextPhase === 'work-complete') {
        playPomodoroAlertSound();
    }
    persistPomodoroState();
    await revealPomodoroReminder();
}

async function tickPomodoroState() {
    ensurePomodoroState();
    if (!isPomodoroRunningPhase(pomodoroState.phase) || !Number.isFinite(pomodoroState.endsAt)) {
        return;
    }

    if (Date.now() >= pomodoroState.endsAt) {
        if (pomodoroState.phase === 'break') {
            await completePomodoroPhase('break-complete');
            return;
        }
        await completePomodoroPhase('work-complete');
        return;
    }

    if (timelinePanelOpen && currentRightSidebarTab === 'pomodoro') {
        updatePomodoroRuntimeDisplay();
    }
}

function ensurePomodoroTicker() {
    if (pomodoroTickTimer) return;
    pomodoroTickTimer = window.setInterval(() => {
        void tickPomodoroState();
    }, 1000);
}

function setWorkspaceRoot(folderPath) {
    workspaceRootPath = folderPath ? path.resolve(folderPath) : null;
    expandedWorkspaceEntries = workspaceRootPath ? new Set([workspaceRootPath]) : new Set();
    workspaceSelectedEntryPath = null;
    invalidateWorkspaceStructureCaches();
    saveWorkspaceRootPreference(workspaceRootPath);
    renderWorkspaceTree();
    registerWorkspaceWatchers();
    scheduleWorkspaceDataWarmup(workspaceRootPath);
}

function loadWorkspaceTreeSortSettings() {
    try {
        const raw = window.localStorage.getItem(WORKSPACE_TREE_SORT_SETTINGS_KEY);
        if (!raw) {
            return { roots: {} };
        }

        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') {
            return { roots: {} };
        }

        const normalized = { roots: {} };
        const roots = parsed.roots && typeof parsed.roots === 'object' ? parsed.roots : {};
        for (const [rootPath, rootValue] of Object.entries(roots)) {
            const normalizedRootPath = path.resolve(rootPath);
            const sortModes = {};
            const manualOrders = {};
            const rawSortModes = rootValue?.sortModes && typeof rootValue.sortModes === 'object' ? rootValue.sortModes : {};
            const rawManualOrders = rootValue?.manualOrders && typeof rootValue.manualOrders === 'object' ? rootValue.manualOrders : {};

            for (const [folderPath, mode] of Object.entries(rawSortModes)) {
                if (!VALID_WORKSPACE_SORT_MODES.has(mode)) continue;
                sortModes[path.resolve(folderPath)] = mode;
            }

            for (const [folderPath, order] of Object.entries(rawManualOrders)) {
                if (!Array.isArray(order)) continue;
                manualOrders[path.resolve(folderPath)] = order
                    .map((entryPath) => {
                        try {
                            return path.resolve(String(entryPath || ''));
                        } catch {
                            return null;
                        }
                    })
                    .filter(Boolean);
            }

            normalized.roots[normalizedRootPath] = {
                sortModes,
                manualOrders
            };
        }

        return normalized;
    } catch {
        return { roots: {} };
    }
}

function saveWorkspaceTreeSortSettings() {
    try {
        window.localStorage.setItem(
            WORKSPACE_TREE_SORT_SETTINGS_KEY,
            JSON.stringify(workspaceTreeSortSettings)
        );
    } catch {
        // Ignore preference failures.
    }
}

function getWorkspaceTreeSortRootStore(rootPath = workspaceRootPath, { create = false } = {}) {
    if (!rootPath) return null;
    const normalizedRootPath = path.resolve(rootPath);
    if (!workspaceTreeSortSettings || typeof workspaceTreeSortSettings !== 'object') {
        workspaceTreeSortSettings = loadWorkspaceTreeSortSettings();
    }
    if (!workspaceTreeSortSettings || typeof workspaceTreeSortSettings !== 'object') {
        workspaceTreeSortSettings = { roots: {} };
    }
    if (!workspaceTreeSortSettings.roots || typeof workspaceTreeSortSettings.roots !== 'object') {
        workspaceTreeSortSettings.roots = {};
    }
    if (!workspaceTreeSortSettings.roots[normalizedRootPath] && create) {
        workspaceTreeSortSettings.roots[normalizedRootPath] = {
            sortModes: {},
            manualOrders: {}
        };
    }
    return workspaceTreeSortSettings.roots[normalizedRootPath] || null;
}

function getWorkspaceFolderSortMode(folderPath) {
    if (!folderPath) return DEFAULT_WORKSPACE_SORT_MODE;
    const store = getWorkspaceTreeSortRootStore();
    const normalizedFolderPath = path.resolve(folderPath);
    const mode = store?.sortModes?.[normalizedFolderPath];
    return VALID_WORKSPACE_SORT_MODES.has(mode) ? mode : DEFAULT_WORKSPACE_SORT_MODE;
}

function sortWorkspaceEntriesByMode(entries, sortMode) {
    const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
    const getCreatedMs = (entry) => {
        if (Number.isFinite(entry?.createdMs)) {
            return entry.createdMs;
        }
        return 0;
    };

    const sorted = [...entries];
    if (sortMode === 'name-desc') {
        sorted.sort((a, b) => collator.compare(b.name, a.name));
        return sorted;
    }
    if (sortMode === 'created-asc') {
        sorted.sort((a, b) => {
            const diff = getCreatedMs(a) - getCreatedMs(b);
            return diff || collator.compare(a.name, b.name);
        });
        return sorted;
    }
    if (sortMode === 'created-desc') {
        sorted.sort((a, b) => {
            const diff = getCreatedMs(b) - getCreatedMs(a);
            return diff || collator.compare(a.name, b.name);
        });
        return sorted;
    }

    sorted.sort((a, b) => collator.compare(a.name, b.name));
    return sorted;
}

function applyWorkspaceChildrenSort(folderPath, entries) {
    const normalizedFolderPath = path.resolve(folderPath);
    const sortMode = getWorkspaceFolderSortMode(normalizedFolderPath);
    const baseSorted = sortWorkspaceEntriesByMode(entries, DEFAULT_WORKSPACE_SORT_MODE);

    if (sortMode !== 'manual') {
        return sortWorkspaceEntriesByMode(entries, sortMode);
    }

    const store = getWorkspaceTreeSortRootStore();
    const manualOrder = Array.isArray(store?.manualOrders?.[normalizedFolderPath])
        ? store.manualOrders[normalizedFolderPath]
        : [];
    const orderIndex = new Map(manualOrder.map((entryPath, index) => [path.resolve(entryPath), index]));

    return [...baseSorted].sort((a, b) => {
        const aIndex = orderIndex.has(a.path) ? orderIndex.get(a.path) : Number.POSITIVE_INFINITY;
        const bIndex = orderIndex.has(b.path) ? orderIndex.get(b.path) : Number.POSITIVE_INFINITY;
        if (aIndex !== bIndex) {
            return aIndex - bIndex;
        }
        return 0;
    });
}

function setWorkspaceFolderSortMode(folderPath, sortMode) {
    if (!folderPath || !VALID_WORKSPACE_SORT_MODES.has(sortMode)) {
        return false;
    }

    const normalizedFolderPath = path.resolve(folderPath);
    const store = getWorkspaceTreeSortRootStore(workspaceRootPath, { create: true });
    store.sortModes[normalizedFolderPath] = sortMode;

    if (sortMode === 'manual') {
        const currentChildren = getWorkspaceChildren(normalizedFolderPath);
        store.manualOrders[normalizedFolderPath] = currentChildren.map((entry) => entry.path);
    }

    saveWorkspaceTreeSortSettings();
    invalidateWorkspaceStructureCaches();
    workspaceTreeRenderVersion += 1;
    renderWorkspaceTree(true);
    return true;
}

function updateWorkspaceManualOrder(folderPath, orderedPaths) {
    if (!folderPath) return false;
    const normalizedFolderPath = path.resolve(folderPath);
    const store = getWorkspaceTreeSortRootStore(workspaceRootPath, { create: true });
    store.sortModes[normalizedFolderPath] = 'manual';
    store.manualOrders[normalizedFolderPath] = Array.from(new Set((orderedPaths || []).map((entryPath) => path.resolve(entryPath))));
    saveWorkspaceTreeSortSettings();
    invalidateWorkspaceStructureCaches();
    workspaceTreeRenderVersion += 1;
    return true;
}

function getWorkspaceChildrenPathsInCurrentOrder(folderPath) {
    return getWorkspaceChildren(folderPath).map((entry) => path.resolve(entry.path));
}

function moveWorkspaceEntryInManualOrder(folderPath, sourcePath, targetPath, placement = 'before') {
    if (!folderPath || !sourcePath || !targetPath) return false;
    const normalizedFolderPath = path.resolve(folderPath);
    const normalizedSource = path.resolve(sourcePath);
    const normalizedTarget = path.resolve(targetPath);
    const currentChildren = getWorkspaceChildrenPathsInCurrentOrder(normalizedFolderPath);
    const withoutSource = currentChildren.filter((entryPath) => path.resolve(entryPath) !== normalizedSource);
    const targetIndex = withoutSource.findIndex((entryPath) => path.resolve(entryPath) === normalizedTarget);
    if (targetIndex === -1) {
        return false;
    }
    const insertionIndex = placement === 'after' ? targetIndex + 1 : targetIndex;
    withoutSource.splice(insertionIndex, 0, normalizedSource);
    updateWorkspaceManualOrder(normalizedFolderPath, withoutSource);
    renderWorkspaceTree(true);
    return true;
}

function updateWorkspaceSortSettingsAfterPathChange(fromPath, toPath = null) {
    if (!workspaceTreeSortSettings?.roots) return;
    const normalizedFrom = path.resolve(fromPath);
    const normalizedTo = toPath ? path.resolve(toPath) : null;
    let changed = false;

    const rewritePath = (candidatePath) => {
        const normalizedCandidate = path.resolve(candidatePath);
        if (normalizedCandidate === normalizedFrom) {
            return normalizedTo;
        }
        if (normalizedTo && normalizedCandidate.startsWith(`${normalizedFrom}${path.sep}`)) {
            const suffix = path.relative(normalizedFrom, normalizedCandidate);
            return path.join(normalizedTo, suffix);
        }
        if (!normalizedTo && (normalizedCandidate === normalizedFrom || normalizedCandidate.startsWith(`${normalizedFrom}${path.sep}`))) {
            return null;
        }
        return normalizedCandidate;
    };

    for (const rootStore of Object.values(workspaceTreeSortSettings.roots)) {
        if (!rootStore) continue;
        const nextSortModes = {};
        for (const [folderPath, mode] of Object.entries(rootStore.sortModes || {})) {
            const rewrittenFolderPath = rewritePath(folderPath);
            if (!rewrittenFolderPath) {
                changed = true;
                continue;
            }
            nextSortModes[rewrittenFolderPath] = mode;
            if (rewrittenFolderPath !== folderPath) {
                changed = true;
            }
        }

        const nextManualOrders = {};
        for (const [folderPath, order] of Object.entries(rootStore.manualOrders || {})) {
            const rewrittenFolderPath = rewritePath(folderPath);
            if (!rewrittenFolderPath) {
                changed = true;
                continue;
            }

            const rewrittenOrder = Array.from(new Set((order || [])
                .map((entryPath) => rewritePath(entryPath))
                .filter(Boolean)));

            nextManualOrders[rewrittenFolderPath] = rewrittenOrder;
            if (rewrittenFolderPath !== folderPath || rewrittenOrder.length !== (order || []).length) {
                changed = true;
            }
        }

        rootStore.sortModes = nextSortModes;
        rootStore.manualOrders = nextManualOrders;
    }

    if (changed) {
        saveWorkspaceTreeSortSettings();
    }
}

function appendWorkspaceEntryToManualOrder(folderPath, entryPath) {
    if (!folderPath || !entryPath) return;
    if (getWorkspaceFolderSortMode(folderPath) !== 'manual') return;
    const normalizedFolderPath = path.resolve(folderPath);
    const normalizedEntryPath = path.resolve(entryPath);
    const store = getWorkspaceTreeSortRootStore(workspaceRootPath, { create: true });
    const currentOrder = Array.isArray(store.manualOrders[normalizedFolderPath])
        ? store.manualOrders[normalizedFolderPath].map((item) => path.resolve(item))
        : [];
    if (!currentOrder.includes(normalizedEntryPath)) {
        currentOrder.push(normalizedEntryPath);
        store.manualOrders[normalizedFolderPath] = currentOrder;
        saveWorkspaceTreeSortSettings();
        invalidateWorkspaceStructureCaches();
        workspaceTreeRenderVersion += 1;
    }
}

function isWorkspaceManualReorderDrop(sourcePath, targetPath) {
    if (!sourcePath || !targetPath) return false;
    const normalizedSource = path.resolve(sourcePath);
    const normalizedTarget = path.resolve(targetPath);
    const sourceParent = path.dirname(normalizedSource);
    const targetParent = path.dirname(normalizedTarget);
    return sourceParent === targetParent && getWorkspaceFolderSortMode(sourceParent) === 'manual';
}

function getWorkspaceChildren(folderPath, options = {}) {
    if (!folderPath || !fs.existsSync(folderPath)) {
        return [];
    }

    const normalizedFolderPath = path.resolve(folderPath);
    const now = Date.now();
    let entries = null;
    const cached = workspaceChildrenCache.get(normalizedFolderPath);
    if (cached && cached.expiresAt > now) {
        entries = cached.entries;
    }

    if (!entries) {
        entries = fs.readdirSync(normalizedFolderPath, { withFileTypes: true })
            .filter((entry) => !entry.name.startsWith('.'))
            .map((entry) => {
                const absolutePath = path.join(normalizedFolderPath, entry.name);
                const isBundle = entry.isDirectory() && isValidTextBundlePath(absolutePath);
                const isDirectory = entry.isDirectory() && !isBundle;
                let createdMs = 0;

                if (isBundle || isDirectory) {
                    try {
                        const stat = fs.statSync(absolutePath);
                        createdMs = Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs > 0
                            ? stat.birthtimeMs
                            : (Number.isFinite(stat.ctimeMs) ? stat.ctimeMs : 0);
                    } catch {
                        createdMs = 0;
                    }
                }

                return {
                    name: entry.name,
                    path: absolutePath,
                    isBundle,
                    isDirectory,
                    createdMs
                };
            })
            .filter((entry) => entry.isBundle || entry.isDirectory);

        workspaceChildrenCache.set(normalizedFolderPath, {
            entries,
            expiresAt: now + WORKSPACE_CHILDREN_CACHE_TTL
        });
    }

    if (options.preserveManualOrder === false) {
        return sortWorkspaceEntriesByMode(entries, DEFAULT_WORKSPACE_SORT_MODE);
    }

    return applyWorkspaceChildrenSort(normalizedFolderPath, entries);
}

async function openWorkspaceBundle(bundlePath) {
    if (!bundlePath) return;
    pendingWorkspaceRevealPath = path.resolve(bundlePath);
    ensureWorkspacePathExpanded(bundlePath);
    await openBundleFromExternalPath(bundlePath);
}

function ensureWorkspacePathExpanded(targetPath) {
    if (!workspaceRootPath || !targetPath) return false;

    const normalizedRoot = path.resolve(workspaceRootPath);
    const normalizedTarget = path.resolve(targetPath);
    if (!normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`) && normalizedTarget !== normalizedRoot) {
        return false;
    }

    let didExpand = false;
    let currentPath = path.dirname(normalizedTarget);
    while (currentPath && currentPath.startsWith(normalizedRoot)) {
        if (!expandedWorkspaceEntries.has(currentPath)) {
            didExpand = true;
        }
        expandedWorkspaceEntries.add(currentPath);
        if (currentPath === normalizedRoot) {
            break;
        }
        const nextPath = path.dirname(currentPath);
        if (nextPath === currentPath) {
            break;
        }
        currentPath = nextPath;
    }

    if (didExpand) {
        workspaceTreeRenderVersion += 1;
    }

    return didExpand;
}

function ensureActiveWorkspacePathExpanded() {
    if (skipEnsureActiveWorkspacePathExpandedOnce) {
        skipEnsureActiveWorkspacePathExpandedOnce = false;
        return;
    }

    const activeTab = getActiveTab();
    const preferredPath = pendingWorkspaceRevealPath || activeTab?.path || null;
    if (!preferredPath) return;
    ensureWorkspacePathExpanded(preferredPath);
}

function collapseWorkspaceTree() {
    if (!workspaceRootPath) return;
    expandedWorkspaceEntries = new Set([path.resolve(workspaceRootPath)]);
    workspaceTreeRenderVersion += 1;
    skipEnsureActiveWorkspacePathExpandedOnce = true;
    renderWorkspaceTree();
}

function hideWorkspaceContextMenu() {
    const menu = document.getElementById('workspace-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    hideWorkspaceSortSubmenu();
    workspaceContextTarget = null;
}

function hideWorkspaceSortSubmenu() {
    const submenu = document.getElementById('workspace-sort-submenu');
    if (!submenu) return;
    submenu.classList.remove('show');
}

function setWorkspaceSelectedEntryPath(targetPath) {
    const nextPath = targetPath ? path.resolve(targetPath) : null;
    if (workspaceSelectedEntryPath === nextPath) {
        return;
    }

    workspaceSelectedEntryPath = nextPath;
    renderWorkspaceTree();
}

function getWorkspaceSelectedEntryPath() {
    if (workspaceSelectedEntryPath) {
        return workspaceSelectedEntryPath;
    }
    if (workspaceContextTarget?.path) {
        return path.resolve(workspaceContextTarget.path);
    }
    return null;
}

function syncWorkspaceSelectionToPath(targetPath) {
    if (!targetPath || !workspaceRootPath) return;
    const normalizedTarget = path.resolve(targetPath);
    const normalizedRoot = path.resolve(workspaceRootPath);
    if (normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)) {
        workspaceSelectedEntryPath = normalizedTarget;
    }
}

function flashWorkspaceEntry(targetPath, duration = 2000) {
    if (!targetPath) return;

    const normalizedTarget = path.resolve(targetPath);
    if (workspaceRevealFlashTimer) {
        window.clearTimeout(workspaceRevealFlashTimer);
        workspaceRevealFlashTimer = null;
    }

    workspaceRevealFlashPath = normalizedTarget;
    renderWorkspaceTree(true);

    window.requestAnimationFrame(() => {
        const escapedTarget = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
            ? CSS.escape(normalizedTarget)
            : normalizedTarget.replace(/["\\]/g, '\\$&');
        const row = document.querySelector(`.workspace-node-row[data-path="${escapedTarget}"]`);
        if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
        }
    });

    workspaceRevealFlashTimer = window.setTimeout(() => {
        workspaceRevealFlashTimer = null;
        if (workspaceRevealFlashPath === normalizedTarget) {
            workspaceRevealFlashPath = null;
            renderWorkspaceTree(true);
        }
    }, Math.max(300, Number(duration) || 2000));
}

function clearWorkspaceDropIndicators() {
    document.querySelectorAll('.workspace-node-row.drop-target, .workspace-node-row.drop-insert-before, .workspace-node-row.drop-insert-after, .workspace-root.drop-target').forEach((node) => {
        node.classList.remove('drop-target', 'drop-insert-before', 'drop-insert-after');
    });
}

function resetWorkspaceFolderDropIntent() {
    workspaceFolderDropIntentPath = null;
    workspaceFolderDropIntentReady = false;
    if (workspaceFolderDropIntentTimer) {
        window.clearTimeout(workspaceFolderDropIntentTimer);
        workspaceFolderDropIntentTimer = null;
    }
}

function beginWorkspaceInlineRename(targetPath) {
    suspendWorkspaceRefresh();
    workspaceRenameTargetPath = targetPath ? path.resolve(targetPath) : null;
    rerenderWorkspaceTree();
}

function cancelWorkspaceInlineRename() {
    if (!workspaceRenameTargetPath) return;
    workspaceRenameTargetPath = null;
    rerenderWorkspaceTree();
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
    workspaceTreeRenderVersion += 1;
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
        rerenderWorkspaceTree();
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
        ? `${stripKnownBundleExtension(trimmedName)}${DEFAULT_BUNDLE_EXTENSION}`
        : trimmedName;

    if (targetName === currentName) {
        workspaceRenameTargetPath = null;
        rerenderWorkspaceTree();
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
        updateWorkspaceSortSettingsAfterPathChange(normalizedSource, normalizedTarget);
        updateExpandedWorkspaceEntriesAfterMove(normalizedSource, normalizedTarget);
        workspaceTreeRenderVersion += 1;
        updateWorkspaceTabPathsAfterMove(normalizedSource, normalizedTarget);

        if (isPathInsideCurrentBundleAttachments(normalizedSource) || isPathInsideCurrentBundleAttachments(normalizedTarget)) {
            suppressBundleAttachmentWatcherUntil = Date.now() + 300;
            await syncOpenEditorAfterAttachmentRename(normalizedSource, normalizedTarget);
        }

        workspaceRenameTargetPath = null;
        rerenderWorkspaceTree();
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
        updateWorkspaceSortSettingsAfterPathChange(normalizedSource, nextPath);
        expandedWorkspaceEntries.add(normalizedTargetDir);
        workspaceTreeRenderVersion += 1;
        appendWorkspaceEntryToManualOrder(normalizedTargetDir, nextPath);
        updateExpandedWorkspaceEntriesAfterMove(normalizedSource, nextPath);
        updateWorkspaceTabPathsAfterMove(normalizedSource, nextPath);
        rerenderWorkspaceTree();
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

async function copyPathRecursiveAsync(sourcePath, targetPath, options = {}) {
    const sourceStat = await fs.promises.lstat(sourcePath);
    const totalEntries = Number(options.totalEntries || 0);
    const progressState = options.progressState || { completed: 0 };
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const reportProgress = async () => {
        progressState.completed += 1;
        if (onProgress) {
            onProgress(progressState.completed, totalEntries);
        }
        if (progressState.completed % 32 === 0) {
            await yieldToUiFrame();
        }
    };

    if (sourceStat.isSymbolicLink()) {
        await reportProgress();
        return;
    }

    if (sourceStat.isDirectory()) {
        await fs.promises.mkdir(targetPath, { recursive: true });
        await reportProgress();
        const entries = await fs.promises.readdir(sourcePath);
        for (const entryName of entries) {
            await copyPathRecursiveAsync(
                path.join(sourcePath, entryName),
                path.join(targetPath, entryName),
                {
                    ...options,
                    progressState
                }
            );
        }
        return;
    }

    await copyFileRobustAsync(sourcePath, targetPath, sourceStat);
    await reportProgress();
}

async function countPathEntriesAsync(sourcePath) {
    const sourceStat = await fs.promises.stat(sourcePath);
    if (!sourceStat.isDirectory()) {
        return 1;
    }

    let total = 1;
    const stack = [sourcePath];
    let processed = 0;

    while (stack.length) {
        const currentPath = stack.pop();
        const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });
        for (const entry of entries) {
            total += 1;
            processed += 1;
            if (processed % 200 === 0) {
                await yieldToUiFrame();
            }

            if (entry.isDirectory()) {
                stack.push(path.join(currentPath, entry.name));
            }
        }
    }

    return total;
}

async function importExternalBundlesIntoWorkspace(bundlePaths, targetDir) {
    const normalizedTargetDir = path.resolve(targetDir);
    if (!bundlePaths?.length || !fs.existsSync(normalizedTargetDir)) {
        return false;
    }

    let importedCount = 0;

    setWorkspaceBusy('正在导入并整理 Kangaroo bundle…');
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
            workspaceTreeRenderVersion += 1;
            appendWorkspaceEntryToManualOrder(normalizedTargetDir, targetBundlePath);
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
    const sortButton = document.getElementById('workspace-menu-sort');
    const sortNameAscButton = document.getElementById('workspace-menu-sort-name-asc');
    const sortNameDescButton = document.getElementById('workspace-menu-sort-name-desc');
    const sortCreatedAscButton = document.getElementById('workspace-menu-sort-created-asc');
    const sortCreatedDescButton = document.getElementById('workspace-menu-sort-created-desc');
    const sortManualButton = document.getElementById('workspace-menu-sort-manual');
    const renameButton = document.getElementById('workspace-menu-rename');
    const duplicateButton = document.getElementById('workspace-menu-duplicate');
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
    const sortButtons = [
        sortNameAscButton,
        sortNameDescButton,
        sortCreatedAscButton,
        sortCreatedDescButton,
        sortManualButton
    ];
    if (sortButton) {
        sortButton.style.display = target?.sortTarget ? '' : 'none';
    }
    for (const button of sortButtons) {
        if (!button) continue;
        button.classList.remove('active');
    }
    if (target?.sortTarget) {
        const activeButtonByMode = {
            'name-asc': sortNameAscButton,
            'name-desc': sortNameDescButton,
            'created-asc': sortCreatedAscButton,
            'created-desc': sortCreatedDescButton,
            'manual': sortManualButton
        };
        const activeButton = activeButtonByMode[getWorkspaceFolderSortMode(target.sortTarget)];
        if (activeButton) {
            activeButton.classList.add('active');
        }
    }
    if (renameButton) {
        renameButton.style.display = target?.allowRename ? '' : 'none';
    }
    if (duplicateButton) {
        duplicateButton.style.display = target?.allowDuplicate ? '' : 'none';
        duplicateButton.textContent = target?.duplicateLabel || '复制文档';
    }
    if (deleteButton) {
        deleteButton.style.display = target?.allowDelete ? '' : 'none';
        deleteButton.textContent = target?.deleteLabel || '删除';
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    hideWorkspaceSortSubmenu();
    positionContextMenu(menu, event, { kind: 'workspace', minWidth: 152 });
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

async function deleteWorkspaceEntry(target, options = {}) {
    if (!target?.path) return false;

    const normalizedPath = path.resolve(target.path);
    const entryName = path.basename(normalizedPath) || normalizedPath;
    const isFolder = !target.isBundle;
    if (options.prompt !== false) {
        const decision = await ipcRenderer.invoke('dialog:confirmDeleteWorkspaceEntry', {
            entryName,
            isFolder
        });

        if (decision !== 'delete') {
            return false;
        }
    }

    setWorkspaceBusy(options.busyMessage || (isFolder ? '正在删除文件夹…' : '正在删除文档…'));
    suspendWorkspaceRefresh();
    await yieldToUiFrame();

    try {
        const canDelete = await closeWorkspaceEntryTabs(normalizedPath);
        if (!canDelete) {
            return false;
        }

        const trashResult = await ipcRenderer.invoke('shell:trashPath', {
            type: 'path',
            value: normalizedPath
        });

        if (!trashResult || !trashResult.ok) {
            alert(`删除失败: ${(trashResult && trashResult.error) || normalizedPath}`);
            return false;
        }

        if (workspaceRootPath) {
            const currentRoot = path.resolve(workspaceRootPath);
            if (normalizedPath === currentRoot) {
                setWorkspaceRoot(null);
                setSidebarTab('workspace');
                applyTimelinePanelVisibility(false);
                return true;
            }

            if (expandedWorkspaceEntries.has(normalizedPath)) {
                expandedWorkspaceEntries.delete(normalizedPath);
                workspaceTreeRenderVersion += 1;
            }
        }

        updateWorkspaceSortSettingsAfterPathChange(normalizedPath, null);
        workspaceRefreshPending = false;
        refreshWorkspaceTreeFromFilesystem({ refreshCurrentDocument: false });
        if (workspaceRootPath) {
            invalidateWorkspaceTimelineEntriesCache(workspaceRootPath);
            scheduleTimelinePanelRender();
        }
        return true;
    } finally {
        resumeWorkspaceRefresh({ immediate: true });
        clearWorkspaceBusy();
    }
}

function generateUniqueWorkspaceDuplicatePath(targetDir, sourcePath) {
    const normalizedTargetDir = path.resolve(targetDir);
    const normalizedSourcePath = path.resolve(sourcePath);
    const sourceStat = fs.statSync(normalizedSourcePath);
    const isBundle = sourceStat.isDirectory() && isValidTextBundlePath(normalizedSourcePath);
    const sourceName = path.basename(normalizedSourcePath);
    const parsed = path.parse(sourceName);

    let baseName = parsed.name || sourceName || '复制';
    let extension = parsed.ext || '';

    if (isBundle) {
        baseName = stripKnownBundleExtension(path.basename(normalizedSourcePath)) || baseName;
        extension = DEFAULT_BUNDLE_EXTENSION;
    } else if (sourceStat.isDirectory()) {
        extension = '';
    }

    let candidateName = `${baseName} copy${extension}`;
    let counter = 2;
    let candidatePath = path.join(normalizedTargetDir, candidateName);

    while (fs.existsSync(candidatePath)) {
        candidateName = `${baseName} copy ${counter++}${extension}`;
        candidatePath = path.join(normalizedTargetDir, candidateName);
    }

    return candidatePath;
}

function insertWorkspaceEntryIntoManualOrder(folderPath, entryPath, anchorPath, placement = 'before') {
    if (!folderPath || !entryPath || !anchorPath) return false;
    const normalizedFolderPath = path.resolve(folderPath);
    const normalizedEntryPath = path.resolve(entryPath);
    const normalizedAnchorPath = path.resolve(anchorPath);
    const currentChildren = getWorkspaceChildrenPathsInCurrentOrder(normalizedFolderPath);
    const withoutEntry = currentChildren.filter((entry) => path.resolve(entry) !== normalizedEntryPath);
    const anchorIndex = withoutEntry.findIndex((entry) => path.resolve(entry) === normalizedAnchorPath);
    if (anchorIndex === -1) {
        return appendWorkspaceEntryToManualOrder(normalizedFolderPath, normalizedEntryPath);
    }

    const insertionIndex = placement === 'after' ? anchorIndex + 1 : anchorIndex;
    withoutEntry.splice(insertionIndex, 0, normalizedEntryPath);
    updateWorkspaceManualOrder(normalizedFolderPath, withoutEntry);
    renderWorkspaceTree(true);
    return true;
}

async function copyWorkspaceEntry(sourcePath, targetDir, options = {}) {
    if (!sourcePath || !targetDir) return false;

    const normalizedSource = path.resolve(sourcePath);
    let normalizedTargetDir = path.resolve(targetDir);
    if (!fs.existsSync(normalizedSource) || !fs.existsSync(normalizedTargetDir)) {
        return false;
    }

    let sourceStat = null;
    try {
        sourceStat = fs.statSync(normalizedSource);
    } catch (error) {
        alert(`复制失败: ${error.message}`);
        return false;
    }

    if (!sourceStat.isDirectory() && !sourceStat.isFile()) {
        return false;
    }

    if (sourceStat.isDirectory() && (normalizedTargetDir === normalizedSource || isSameOrNestedPath(normalizedTargetDir, normalizedSource))) {
        normalizedTargetDir = path.dirname(normalizedSource);
    }

    const sourceName = path.basename(normalizedSource);
    const targetPath = options.targetPath
        ? path.resolve(options.targetPath)
        : generateUniqueWorkspaceDuplicatePath(normalizedTargetDir, normalizedSource);

    if (!targetPath || fs.existsSync(targetPath)) {
        if (targetPath && fs.existsSync(targetPath)) {
            alert(`已存在同名项目：${path.basename(targetPath)}`);
        }
        return false;
    }

    setWorkspaceBusy(sourceStat.isDirectory() ? '正在复制文件夹…' : '正在复制文档…');
    suspendWorkspaceRefresh();
    await yieldToUiFrame();

    try {
        if (sourceStat.isDirectory()) {
            await copyPathRecursiveAsync(normalizedSource, targetPath);
        } else {
            await copyFileRobustAsync(normalizedSource, targetPath, sourceStat);
        }

        const targetParentDir = path.dirname(targetPath);
        expandedWorkspaceEntries.add(targetParentDir);
        workspaceTreeRenderVersion += 1;
        invalidateWorkspaceStructureCaches();

        if (getWorkspaceFolderSortMode(targetParentDir) === 'manual') {
            if (options.anchorPath) {
                insertWorkspaceEntryIntoManualOrder(targetParentDir, targetPath, options.anchorPath, options.placement || 'after');
            } else {
                appendWorkspaceEntryToManualOrder(targetParentDir, targetPath);
            }
        } else {
            invalidateWorkspaceStructureCaches();
        }

        workspaceSelectedEntryPath = targetPath;
        invalidateWorkspaceStructureCaches();
        renderWorkspaceTree(true);
        registerWorkspaceWatchers();
        return true;
    } catch (error) {
        alert(`复制失败: ${error.message}`);
        return false;
    } finally {
        if (workspaceRefreshSuspended > 0) {
            resumeWorkspaceRefresh({ immediate: true });
        }
        clearWorkspaceBusy();
    }
}

async function duplicateWorkspaceEntry(target, options = {}) {
    if (!target?.path) return false;

    const normalizedSource = path.resolve(target.path);
    if (!fs.existsSync(normalizedSource)) {
        return false;
    }

    const destinationDir = options.targetDir
        ? path.resolve(options.targetDir)
        : path.dirname(normalizedSource);

    const placement = options.placement || 'after';
    return copyWorkspaceEntry(normalizedSource, destinationDir, {
        anchorPath: options.anchorPath || normalizedSource,
        placement
    });
}

function getWorkspaceClipboardSourceTarget() {
    const targetPath = getWorkspaceSelectedEntryPath() || workspaceContextTarget?.path || null;
    if (!targetPath) return null;
    if (!fs.existsSync(targetPath)) return null;
    return {
        path: path.resolve(targetPath),
        isDirectory: fs.statSync(targetPath).isDirectory(),
        isBundle: isValidTextBundlePath(targetPath)
    };
}

function writeWorkspaceClipboardEntry(target) {
    if (!target?.path) return false;

    const normalizedPath = path.resolve(target.path);
    clipboard.writeBuffer(
        KANGAROO_WORKSPACE_ENTRY_MIME,
        Buffer.from(JSON.stringify({
            path: normalizedPath,
            isDirectory: Boolean(target.isDirectory),
            isBundle: Boolean(target.isBundle)
        }), 'utf-8')
    );
    clipboard.writeText(normalizedPath);
    return true;
}

function readWorkspaceClipboardEntry() {
    try {
        const availableFormats = clipboard.availableFormats() || [];
        if (availableFormats.includes(KANGAROO_WORKSPACE_ENTRY_MIME)) {
            const raw = clipboard.readBuffer(KANGAROO_WORKSPACE_ENTRY_MIME).toString('utf-8');
            const parsed = JSON.parse(raw);
            if (parsed?.path) {
                return {
                    path: path.resolve(parsed.path),
                    isDirectory: Boolean(parsed.isDirectory),
                    isBundle: Boolean(parsed.isBundle)
                };
            }
        }
    } catch (error) {
        console.warn('读取工作空间剪贴板失败:', error);
    }

    const text = String(clipboard.readText() || '').trim();
    if (text && fs.existsSync(text)) {
        const resolved = path.resolve(text);
        return {
            path: resolved,
            isDirectory: fs.statSync(resolved).isDirectory(),
            isBundle: isValidTextBundlePath(resolved)
        };
    }

    return null;
}

function getWorkspaceCopyDestinationDir(targetPath) {
    if (!targetPath) {
        return workspaceRootPath;
    }

    const normalizedTarget = path.resolve(targetPath);
    if (!fs.existsSync(normalizedTarget)) {
        if (isValidTextBundlePath(normalizedTarget)) {
            return workspaceRootPath || path.dirname(normalizedTarget);
        }
        return workspaceRootPath || path.dirname(normalizedTarget);
    }

    const targetStat = fs.statSync(normalizedTarget);
    if (targetStat.isDirectory() && !isValidTextBundlePath(normalizedTarget)) {
        return normalizedTarget;
    }

    return path.dirname(normalizedTarget);
}

async function pasteWorkspaceEntryFromClipboard(targetPath = null) {
    const clipboardEntry = readWorkspaceClipboardEntry();
    if (!clipboardEntry?.path) return false;

    const targetDir = getWorkspaceCopyDestinationDir(targetPath || getWorkspaceSelectedEntryPath() || workspaceRootPath);
    if (!targetDir) return false;

    const normalizedTargetDir = path.resolve(targetDir);
    const normalizedSourcePath = path.resolve(clipboardEntry.path);
    if (normalizedTargetDir === normalizedSourcePath || isSameOrNestedPath(normalizedTargetDir, normalizedSourcePath)) {
        return copyWorkspaceEntry(normalizedSourcePath, path.dirname(normalizedSourcePath));
    }

    const sourceTarget = {
        path: normalizedSourcePath,
        isDirectory: clipboardEntry.isDirectory,
        isBundle: clipboardEntry.isBundle
    };
    return copyWorkspaceEntry(sourceTarget.path, normalizedTargetDir, {
        anchorPath: targetPath && fs.existsSync(targetPath) ? path.resolve(targetPath) : null,
        placement: 'after'
    });
}

function getDefaultWorkspaceNewBundlePath(parentDir) {
    return path.join(parentDir, `未命名文档${DEFAULT_BUNDLE_EXTENSION}`);
}

function getDefaultBundleTitleFromPath(bundlePath) {
    return stripKnownBundleExtension(path.basename(String(bundlePath || ''))) || '未命名文档';
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
        if (workspaceRootPath && isSameOrNestedPath(normalizedFolderPath, path.resolve(workspaceRootPath))) {
            expandedWorkspaceEntries.add(path.resolve(targetDir));
            workspaceTreeRenderVersion += 1;
        }
        appendWorkspaceEntryToManualOrder(targetBaseDir, normalizedFolderPath);
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
        let nextBundleName = `未命名文档${DEFAULT_BUNDLE_EXTENSION}`;
        let suffix = 2;
        let folderPath = path.join(targetBaseDir, nextBundleName);
        while (fs.existsSync(folderPath)) {
            nextBundleName = `未命名文档 ${suffix++}${DEFAULT_BUNDLE_EXTENSION}`;
            folderPath = path.join(targetBaseDir, nextBundleName);
        }

        await waitForEditorReady();
        ensureBundleStructure(folderPath);

        const initialContent = buildDefaultBundleContent(getDefaultBundleTitleFromPath(folderPath));
        writeBundlePackageToPath(folderPath, initialContent, null, null, {
            title: getDefaultBundleTitleFromPath(folderPath)
        });
        if (workspaceRootPath && isSameOrNestedPath(path.resolve(folderPath), path.resolve(workspaceRootPath))) {
            expandedWorkspaceEntries.add(path.dirname(path.resolve(folderPath)));
            workspaceTreeRenderVersion += 1;
        }
        appendWorkspaceEntryToManualOrder(targetBaseDir, folderPath);
        beginWorkspaceInlineRename(path.resolve(folderPath));
        return true;
    } catch (error) {
        alert(`创建失败: ${error.message}`);
        return false;
    }
}

async function createDiaryBundleForDate(dateLike) {
    if (!workspaceRootPath) {
        alert('请先打开工作空间文件夹。');
        return false;
    }

    const diaryFolderPath = getDiaryFolderPath();
    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);
    const targetDate = dateLike ? new Date(dateLike) : new Date();
    const diaryTitle = getDiaryBundleTitle(targetDate);
    const exactDiaryPath = getDiaryBundlePath(targetDate);

    try {
        if (fs.existsSync(diaryFolderPath) && !fs.statSync(diaryFolderPath).isDirectory()) {
            alert('工作空间中已有一个同名文件 Dairy，无法创建日记文件夹。');
            return false;
        }

        let createdDiaryFolder = false;
        if (!fs.existsSync(diaryFolderPath)) {
            fs.mkdirSync(diaryFolderPath, { recursive: true });
            createdDiaryFolder = true;
        }

        if (createdDiaryFolder && isSameOrNestedPath(diaryFolderPath, normalizedWorkspaceRoot)) {
            appendWorkspaceEntryToManualOrder(normalizedWorkspaceRoot, diaryFolderPath);
        }

        let diaryBundlePath = exactDiaryPath;
        const diaryExists = fs.existsSync(exactDiaryPath);
        if (diaryExists && isValidTextBundlePath(exactDiaryPath)) {
            diaryBundlePath = exactDiaryPath;
        } else if (diaryExists) {
            diaryBundlePath = generateUniqueBundlePathInDirectory(diaryFolderPath, diaryTitle);
        }

        const bundleAlreadyExists = fs.existsSync(diaryBundlePath) && isValidTextBundlePath(diaryBundlePath);
        if (!bundleAlreadyExists) {
            await waitForEditorReady();
            ensureBundleStructure(diaryBundlePath);
            writeBundlePackageToPath(diaryBundlePath, buildDefaultBundleContent(diaryTitle), null, null, {
                title: diaryTitle
            });
        }

        appendWorkspaceEntryToManualOrder(diaryFolderPath, diaryBundlePath);
        invalidateWorkspaceStructureCaches();
        workspaceTreeRenderVersion += 1;
        registerWorkspaceWatchers();

        await openBundleFromExternalPath(diaryBundlePath);
        pendingWorkspaceRevealPath = diaryBundlePath;
        ensureWorkspacePathExpanded(diaryBundlePath);
        setWorkspaceSelectedEntryPath(diaryBundlePath);
        flashWorkspaceEntry(diaryBundlePath, 2000);
        return true;
    } catch (error) {
        alert(`创建日记失败: ${error.message}`);
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
    row.dataset.path = normalizedEntryPath;
    const activePath = window.currentPath ? path.resolve(window.currentPath) : '';
    if (entry.isBundle && activePath && normalizedEntryPath === activePath) {
        row.classList.add('active');
    }
    if (workspaceRevealFlashPath && normalizedEntryPath === workspaceRevealFlashPath) {
        row.classList.add('workspace-reveal-flash');
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
        setWorkspaceSelectedEntryPath(normalizedEntryPath);

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
        setWorkspaceSelectedEntryPath(normalizedEntryPath);

        showWorkspaceContextMenu(event, {
            path: normalizedEntryPath,
            openTarget: entry.isBundle ? normalizedEntryPath : null,
            allowOpenBundle: entry.isBundle,
            revealTarget: entry.isBundle ? normalizedEntryPath : normalizedEntryPath,
            createTarget: getWorkspaceCreateTarget(normalizedEntryPath, entry.isDirectory),
            sortTarget: entry.isDirectory ? normalizedEntryPath : null,
            allowCreate: true,
            createLabel: '新建文档',
            allowCreateFolder: true,
            createFolderLabel: '新建文件夹',
            allowRename: true,
            allowDuplicate: true,
            duplicateLabel: entry.isBundle ? '复制文档' : '复制文件夹',
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
            parentPath: path.dirname(normalizedEntryPath),
            isBundle: entry.isBundle,
            isDirectory: entry.isDirectory,
            copyIntent: Boolean(event.altKey)
        };
        row.classList.add('dragging');
        if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = event.altKey ? 'copy' : 'move';
            event.dataTransfer.setData('text/plain', normalizedEntryPath);
        }
    });

    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        draggedWorkspaceEntry = null;
        clearWorkspaceDropIndicators();
        resetWorkspaceFolderDropIntent();
    });

    row.addEventListener('dragover', (event) => {
        const canHandleManualReorder = draggedWorkspaceEntry
            && draggedWorkspaceEntry.path !== normalizedEntryPath
            && isWorkspaceManualReorderDrop(draggedWorkspaceEntry.path, normalizedEntryPath);
        const canHandleInternalMove = entry.isDirectory && draggedWorkspaceEntry && draggedWorkspaceEntry.path !== normalizedEntryPath;
        const canHandleExternalImport = entry.isDirectory && isExternalFileDrag(event.dataTransfer);
        const isCopyDrag = Boolean(draggedWorkspaceEntry?.copyIntent);
        if (!canHandleManualReorder && !canHandleInternalMove && !canHandleExternalImport) return;
        event.preventDefault();
        event.stopPropagation();
        clearWorkspaceDropIndicators();
        workspaceManualDropPlacement = 'before';
        if (canHandleManualReorder) {
            const rowRect = row.getBoundingClientRect();
            const relativeY = event.clientY - rowRect.top;
            const topThreshold = rowRect.height * 0.28;
            const bottomThreshold = rowRect.height * 0.72;
            const canDropInsideFolder = entry.isDirectory && canHandleInternalMove;

            if (canDropInsideFolder && relativeY > topThreshold && relativeY < bottomThreshold) {
                const shouldDelayFolderDropIntent = canHandleManualReorder;

                if (!shouldDelayFolderDropIntent) {
                    workspaceManualDropPlacement = 'inside';
                    row.classList.add('drop-target');
                } else {
                    if (workspaceFolderDropIntentPath !== normalizedEntryPath) {
                        workspaceFolderDropIntentPath = normalizedEntryPath;
                        workspaceFolderDropIntentReady = false;
                        if (workspaceFolderDropIntentTimer) {
                            window.clearTimeout(workspaceFolderDropIntentTimer);
                        }
                        workspaceFolderDropIntentTimer = window.setTimeout(() => {
                            workspaceFolderDropIntentReady = true;
                        }, 280);
                    }

                    if (workspaceFolderDropIntentReady && workspaceFolderDropIntentPath === normalizedEntryPath) {
                        workspaceManualDropPlacement = 'inside';
                        row.classList.add('drop-target');
                    } else {
                        workspaceManualDropPlacement = relativeY >= rowRect.height / 2 ? 'after' : 'before';
                        row.classList.add(workspaceManualDropPlacement === 'after' ? 'drop-insert-after' : 'drop-insert-before');
                    }
                }
            } else {
                if (workspaceFolderDropIntentPath === normalizedEntryPath) {
                    workspaceFolderDropIntentPath = null;
                    workspaceFolderDropIntentReady = false;
                    if (workspaceFolderDropIntentTimer) {
                        window.clearTimeout(workspaceFolderDropIntentTimer);
                        workspaceFolderDropIntentTimer = null;
                    }
                }
                workspaceManualDropPlacement = relativeY >= rowRect.height / 2 ? 'after' : 'before';
                row.classList.add(workspaceManualDropPlacement === 'after' ? 'drop-insert-after' : 'drop-insert-before');
            }
        } else {
            row.classList.add('drop-target');
        }
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = (canHandleExternalImport || isCopyDrag) ? 'copy' : 'move';
        }
    });

    row.addEventListener('dragleave', (event) => {
        event.stopPropagation();
        if (event.currentTarget.contains(event.relatedTarget)) return;
        row.classList.remove('drop-target');
        row.classList.remove('drop-insert-before', 'drop-insert-after');
        if (workspaceFolderDropIntentPath === normalizedEntryPath) {
            workspaceFolderDropIntentPath = null;
            workspaceFolderDropIntentReady = false;
            if (workspaceFolderDropIntentTimer) {
                window.clearTimeout(workspaceFolderDropIntentTimer);
                workspaceFolderDropIntentTimer = null;
            }
        }
    });

    row.addEventListener('drop', async (event) => {
        const canHandleManualReorder = draggedWorkspaceEntry
            && draggedWorkspaceEntry.path !== normalizedEntryPath
            && isWorkspaceManualReorderDrop(draggedWorkspaceEntry.path, normalizedEntryPath);
        const canHandleInternalMove = entry.isDirectory && draggedWorkspaceEntry && draggedWorkspaceEntry.path !== normalizedEntryPath;
        const canHandleExternalImport = entry.isDirectory && getExternalBundlePathsFromDataTransfer(event.dataTransfer).length;
        const isCopyDrag = Boolean(draggedWorkspaceEntry?.copyIntent);
        if (!canHandleManualReorder && !canHandleInternalMove && !canHandleExternalImport) return;

        event.preventDefault();
        event.stopPropagation();
        clearWorkspaceDropIndicators();
        const externalBundlePaths = getExternalBundlePathsFromDataTransfer(event.dataTransfer);
        if (canHandleManualReorder && workspaceManualDropPlacement !== 'inside') {
            if (isCopyDrag) {
                await copyWorkspaceEntry(
                    draggedWorkspaceEntry.path,
                    path.dirname(normalizedEntryPath),
                    {
                        anchorPath: normalizedEntryPath,
                        placement: workspaceManualDropPlacement
                    }
                );
            } else {
                await moveWorkspaceEntryInManualOrder(
                    path.dirname(normalizedEntryPath),
                    draggedWorkspaceEntry.path,
                    normalizedEntryPath,
                    workspaceManualDropPlacement
                );
            }
        } else if (draggedWorkspaceEntry) {
            if (isCopyDrag) {
                await copyWorkspaceEntry(
                    draggedWorkspaceEntry.path,
                    canHandleInternalMove ? normalizedEntryPath : path.dirname(normalizedEntryPath),
                    {
                        anchorPath: canHandleInternalMove ? null : normalizedEntryPath,
                        placement: 'after'
                    }
                );
            } else {
                await moveWorkspaceEntry(draggedWorkspaceEntry.path, normalizedEntryPath);
            }
        } else if (externalBundlePaths.length) {
            await importExternalBundlesIntoWorkspace(externalBundlePaths, normalizedEntryPath);
        }
        draggedWorkspaceEntry = null;
        workspaceManualDropPlacement = 'before';
        clearWorkspaceDropIndicators();
        resetWorkspaceFolderDropIntent();
    });

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

function renderWorkspaceTree(force = false) {
    const container = document.getElementById('workspace-container');
    const panel = document.getElementById('workspace-panel');
    if (!container || !panel) return;

    ensureActiveWorkspacePathExpanded();
    const renderKey = [
        workspaceRootPath || '',
        window.currentPath || '',
        workspaceRenameTargetPath || '',
        workspaceTreeRenderVersion,
        Array.from(expandedWorkspaceEntries).sort().join('|')
    ].join('::');

    if (!force && container.dataset.renderKey === renderKey && container.childElementCount > 0) {
        return;
    }

    invalidateWorkspaceTimelineEntriesCache();
    scheduleTimelinePanelRender();
    container.innerHTML = '';
    container.dataset.renderKey = renderKey;

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
        const isCopyDrag = Boolean(draggedWorkspaceEntry?.copyIntent);
        if (draggedWorkspaceEntry && workspaceRootPath && draggedWorkspaceEntry.parentPath === path.resolve(workspaceRootPath) && getWorkspaceFolderSortMode(workspaceRootPath) === 'manual') {
            if (isCopyDrag) {
                await copyWorkspaceEntry(
                    draggedWorkspaceEntry.path,
                    workspaceRootPath,
                    {
                        anchorPath: draggedWorkspaceEntry.path,
                        placement: 'after'
                    }
                );
            } else {
                const rootChildren = getWorkspaceChildrenPathsInCurrentOrder(workspaceRootPath);
                const reordered = rootChildren.filter((entryPath) => path.resolve(entryPath) !== path.resolve(draggedWorkspaceEntry.path));
                reordered.push(path.resolve(draggedWorkspaceEntry.path));
                updateWorkspaceManualOrder(workspaceRootPath, reordered);
                renderWorkspaceTree();
            }
        } else if (draggedWorkspaceEntry && workspaceRootPath) {
            if (isCopyDrag) {
                await copyWorkspaceEntry(draggedWorkspaceEntry.path, workspaceRootPath);
            } else {
                await moveWorkspaceEntry(draggedWorkspaceEntry.path, workspaceRootPath);
            }
        } else if (externalBundlePaths.length && workspaceRootPath) {
            await importExternalBundlesIntoWorkspace(externalBundlePaths, workspaceRootPath);
        }
        draggedWorkspaceEntry = null;
        clearWorkspaceDropIndicators();
        resetWorkspaceFolderDropIntent();
    };

    const header = document.createElement('div');
    header.className = 'workspace-root';
    header.innerHTML = `
        <div class="workspace-root-header">
            <div class="workspace-root-meta">
                <div class="workspace-root-title">${escapeHtml(path.basename(workspaceRootPath) || workspaceRootPath)}</div>
                <div class="workspace-root-path">${escapeHtml(workspaceRootPath)}</div>
            </div>
            <div class="workspace-root-actions">
                <button id="workspace-refresh-button" class="workspace-root-action" type="button" title="刷新目录树" aria-label="刷新目录树">
                    <i class="fa-solid fa-rotate" aria-hidden="true"></i>
                </button>
                <button id="workspace-collapse-button" class="workspace-root-action" type="button" title="折叠目录树" aria-label="折叠目录树">
                    <i class="fa-solid fa-compress" aria-hidden="true"></i>
                </button>
            </div>
        </div>
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
            sortTarget: workspaceRootPath,
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
    const refreshButton = header.querySelector('#workspace-refresh-button');
    refreshButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        refreshWorkspaceTreeFromFilesystem({ refreshCurrentDocument: false });
    });
    const collapseButton = header.querySelector('#workspace-collapse-button');
    collapseButton?.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        collapseWorkspaceTree();
    });

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
        emptyState.innerText = '这个文件夹目前还没有可打开的 Kangaroo 文档。';
        tree.appendChild(emptyState);
        return;
    }

    for (const child of children) {
        renderWorkspaceNode(child, tree);
    }

    updateWorkspaceBusyIndicator();
}

function rerenderWorkspaceTree() {
    invalidateWorkspaceStructureCaches();
    renderWorkspaceTree(true);
}

function clearTabDragIndicators() {
    for (const tabButton of document.querySelectorAll('.editor-tab.drag-over-left, .editor-tab.drag-over-right')) {
        tabButton.classList.remove('drag-over-left', 'drag-over-right');
    }
}

function reorderEditorTabs(draggedId, targetId, placeAfter = false) {
    const fromIndex = editorTabs.findIndex((tab) => tab.id === draggedId);
    const targetIndex = editorTabs.findIndex((tab) => tab.id === targetId);
    const draggedTab = fromIndex >= 0 ? editorTabs[fromIndex] : null;
    const targetTab = targetIndex >= 0 ? editorTabs[targetIndex] : null;
    if (!draggedTab || !targetTab || draggedTab === targetTab || draggedTab.pinned || targetTab.pinned) {
        return;
    }

    const [movedTab] = editorTabs.splice(fromIndex, 1);
    const adjustedTargetIndex = editorTabs.findIndex((tab) => tab.id === targetId);
    const insertionIndex = adjustedTargetIndex + (placeAfter ? 1 : 0);
    editorTabs.splice(insertionIndex, 0, movedTab);
    normalizeEditorTabOrder();
    renderEditorTabs();
}

function focusToolbarSearch() {
    const input = document.getElementById('toolbar-search-input');
    if (!input) return;
    input.focus();
    input.select();
}

function hideHeadingToolbarSubmenu() {
    const submenu = document.getElementById('heading-toolbar-submenu');
    if (!submenu) return;
    submenu.classList.remove('show');
}

function showHeadingToolbarSubmenu(triggerButton) {
    const submenu = document.getElementById('heading-toolbar-submenu');
    if (!submenu || !triggerButton) return;
    const triggerRect = triggerButton.getBoundingClientRect();
    const toolbarPosition = document.body.dataset.toolbarPosition || FIXED_TOOLBAR_POSITION;

    submenu.style.left = '-9999px';
    submenu.style.top = '-9999px';
    submenu.classList.add('show');

    window.requestAnimationFrame(() => {
        const submenuWidth = submenu.offsetWidth || 124;
        const submenuHeight = submenu.offsetHeight || 224;
        let left = triggerRect.left;
        let top = triggerRect.bottom + 6;

        if (toolbarPosition === 'right') {
            left = triggerRect.left - submenuWidth - 8;
            top = triggerRect.top;
        }

        left = Math.min(Math.max(left, 8), window.innerWidth - submenuWidth - 8);
        top = Math.min(Math.max(top, 8), window.innerHeight - submenuHeight - 8);
        submenu.style.left = `${left}px`;
        submenu.style.top = `${top}px`;
    });
}

function refreshEditorToolbarState() {
    const toolbar = document.getElementById('editor-toolbar');
    if (!toolbar) return;
    const hasActiveTab = Boolean(getActiveTab());
    const headingMenuTrigger = document.getElementById('heading-menu-trigger');
    const headingMenuLabel = document.getElementById('heading-menu-label');

    const state = window.editor && typeof window.editor.getToolbarState === 'function'
        ? window.editor.getToolbarState()
        : null;

    for (const button of toolbar.querySelectorAll('.editor-toolbar-button')) {
        const tool = button.dataset.tool || '';
        let isActive = false;

        if (state) {
            if (tool === 'heading-menu') {
                isActive = Number(state.headingLevel || 0) > 0;
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
        if (tool === 'task-list') {
            button.title = isActive ? '取消待办（Cmd+T）' : '切换待办（Cmd+T）';
            button.setAttribute('aria-label', button.title);
        }
        if (tool === 'toggle-sidebar') {
            button.disabled = false;
        } else if (tool === 'undo') {
            button.disabled = !hasActiveTab || !getActiveTabUndoAvailability();
        } else if (tool === 'redo') {
            button.disabled = !hasActiveTab || !getActiveTabRedoAvailability();
        } else if (tool === 'heading-menu') {
            button.disabled = !hasActiveTab;
        } else {
            button.disabled = !hasActiveTab;
        }
    }

    if (headingMenuLabel) {
        const headingLevel = Number(state?.headingLevel || 0);
        headingMenuLabel.textContent = headingLevel > 0 ? `H${headingLevel}` : 'H';
    }

    const headingLevel = Number(state?.headingLevel || 0);
    for (const button of document.querySelectorAll('#heading-toolbar-submenu .editor-toolbar-submenu-button')) {
        button.classList.toggle('active', Number(button.dataset.headingLevel || 0) === headingLevel);
    }

    if (headingMenuTrigger && !hasActiveTab) {
        hideHeadingToolbarSubmenu();
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

    if (tool === 'undo') {
        void undoActiveTabState();
        refreshEditorToolbarState();
        return true;
    }

    if (tool === 'redo') {
        void redoActiveTabState();
        refreshEditorToolbarState();
        return true;
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

function loadTimelinePanelVisibilityPreference() {
    return false;
}

function saveTimelinePanelVisibilityPreference(isOpen) {
    try {
        window.localStorage.setItem(TIMELINE_PANEL_VISIBILITY_SETTINGS_KEY, isOpen ? 'open' : 'closed');
    } catch {
        // ignore persistence failures
    }
}

function updateTimelineToggleButton() {
    const button = document.getElementById('timeline-toggle-button');
    if (!button) return;
    const enabled = isFeatureEnabled('timeline');
    button.hidden = !enabled;
    button.disabled = !enabled;
    button.style.display = enabled ? '' : 'none';
    const isActive = timelinePanelOpen && currentSidebarTab === 'timeline' && currentRightSidebarTab === 'timeline';
    button.classList.toggle('active', isActive);
    button.title = isActive ? '返回目录' : '显示时间线';
    button.setAttribute('aria-label', button.title);
}

function getRightSidebarTabMeta(tab) {
    switch (tab) {
        case 'outline':
            return {
                title: '大纲',
                subtitle: '按标题层级查看当前文档结构'
            };
        case 'todo':
            return {
                title: '待办',
                subtitle: '查看当前文档或整个工作空间的待办'
            };
        case 'attachment':
            return {
                title: '附件',
                subtitle: '查看当前文档中的附件、PDF 和图片资源'
            };
        case 'pomodoro':
            return {
                title: '番茄钟',
                subtitle: '从工作空间待办中选择任务，开始专注与休息'
            };
        default:
            return {
                title: '时间线',
                subtitle: '按时间查看笔记的创建与编辑记录'
            };
    }
}

function updateRightSidebarButtons() {
    const workspaceButton = document.getElementById('sidebar-tab-workspace');
    const outlineButton = document.getElementById('outline-toggle-button');
    const todoButton = document.getElementById('todo-toggle-button');
    const attachmentButton = document.getElementById('attachment-toggle-button');
    const pomodoroButton = document.getElementById('pomodoro-toggle-button');

    if (workspaceButton) {
        const isActive = currentSidebarTab === 'workspace';
        workspaceButton.classList.toggle('active', isActive);
        workspaceButton.title = '显示目录';
        workspaceButton.setAttribute('aria-label', workspaceButton.title);
    }

    if (outlineButton) {
        const isActive = timelinePanelOpen && currentSidebarTab === 'outline' && currentRightSidebarTab === 'outline';
        outlineButton.classList.toggle('active', isActive);
        outlineButton.title = isActive ? '返回目录' : '显示大纲';
        outlineButton.setAttribute('aria-label', outlineButton.title);
    }

    if (todoButton) {
        const isActive = timelinePanelOpen && currentSidebarTab === 'todo' && currentRightSidebarTab === 'todo';
        todoButton.classList.toggle('active', isActive);
        todoButton.title = isActive ? '返回目录' : '显示待办';
        todoButton.setAttribute('aria-label', todoButton.title);
    }

    if (attachmentButton) {
        const isActive = timelinePanelOpen && currentSidebarTab === 'attachment' && currentRightSidebarTab === 'attachment';
        attachmentButton.classList.toggle('active', isActive);
        attachmentButton.title = isActive ? '返回目录' : '显示附件';
        attachmentButton.setAttribute('aria-label', attachmentButton.title);
    }

    if (pomodoroButton) {
        const enabled = isFeatureEnabled('pomodoro');
        pomodoroButton.hidden = !enabled;
        pomodoroButton.disabled = !enabled;
        pomodoroButton.style.display = enabled ? '' : 'none';
        const isActive = timelinePanelOpen && currentSidebarTab === 'pomodoro' && currentRightSidebarTab === 'pomodoro';
        pomodoroButton.classList.toggle('active', isActive);
        pomodoroButton.title = isActive ? '返回目录' : '显示番茄钟';
        pomodoroButton.setAttribute('aria-label', pomodoroButton.title);
    }

    updateTimelineToggleButton();
}

function updateRightSidebarHeader() {
    const detailHeader = document.getElementById('sidebar-detail-header');
    const searchWrap = document.querySelector('.sidebar-search-wrap');
    const title = document.getElementById('right-sidebar-title');
    const subtitle = document.getElementById('timeline-panel-subtitle');
    const todoActions = document.getElementById('todo-header-actions');
    const meta = getRightSidebarTabMeta(currentRightSidebarTab);
    const isDetailOpen = timelinePanelOpen && currentSidebarTab !== 'workspace';

    detailHeader?.classList.toggle('active', isDetailOpen);
    if (detailHeader) {
        detailHeader.hidden = !isDetailOpen;
    }
    if (searchWrap) {
        searchWrap.hidden = isDetailOpen;
    }
    document.body.classList.toggle('sidebar-detail-open', isDetailOpen);

    if (title) {
        title.textContent = meta.title;
    }

    if (subtitle) {
        subtitle.textContent = meta.subtitle;
    }

    todoActions?.classList.toggle('active', isDetailOpen && currentRightSidebarTab === 'todo');
}

function updateRightSidebarPanels() {
    const workspacePanel = document.getElementById('workspace-panel');
    const timelinePanel = document.getElementById('timeline-panel-content');
    const outlinePanel = document.getElementById('outline-panel');
    const todoPanel = document.getElementById('todo-panel');
    const attachmentPanel = document.getElementById('attachment-panel');
    const pomodoroPanel = document.getElementById('pomodoro-panel');
    const activeDetailTab = timelinePanelOpen ? currentRightSidebarTab : null;

    workspacePanel?.classList.toggle('active', currentSidebarTab === 'workspace');
    timelinePanel?.classList.toggle('active', activeDetailTab === 'timeline');
    outlinePanel?.classList.toggle('active', activeDetailTab === 'outline');
    todoPanel?.classList.toggle('active', activeDetailTab === 'todo');
    attachmentPanel?.classList.toggle('active', activeDetailTab === 'attachment');
    pomodoroPanel?.classList.toggle('active', activeDetailTab === 'pomodoro');
}

function renderTimelineEmptyState(container, message) {
    container.innerHTML = '';
    const emptyState = document.createElement('div');
    emptyState.className = 'sidebar-empty';
    emptyState.innerText = message;
    container.appendChild(emptyState);
}

function formatTimelineTimestampParts(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) {
        return { date: '--', clock: '--:--' };
    }

    const currentYear = new Date().getFullYear();
    const yearPrefix = date.getFullYear() === currentYear ? '' : `${date.getFullYear()}-`;

    return {
        date: `${yearPrefix}${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
        clock: `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    };
}

function getStartOfDay(dateLike) {
    const date = new Date(dateLike);
    date.setHours(0, 0, 0, 0);
    return date;
}

function getDateKey(dateLike) {
    const date = getStartOfDay(dateLike);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function getMonthKey(dateLike) {
    const date = getStartOfDay(dateLike);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getStartOfWeek(dateLike) {
    const date = getStartOfDay(dateLike);
    const day = date.getDay();
    const diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return date;
}

function getWeekKey(dateLike) {
    return getDateKey(getStartOfWeek(dateLike));
}

function getWeekNumber(dateLike) {
    const date = getStartOfDay(dateLike);
    const target = new Date(date.valueOf());
    target.setHours(0, 0, 0, 0);
    target.setDate(target.getDate() + 3 - ((target.getDay() + 6) % 7));
    const firstThursday = new Date(target.getFullYear(), 0, 4);
    firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
    return 1 + Math.round((target - firstThursday) / 604800000);
}

function ensureTimelineFilterState() {
    const now = new Date();
    if (!timelineCalendarMonthCursor) {
        timelineCalendarMonthCursor = new Date(now.getFullYear(), now.getMonth(), 1);
    }
    if (!timelineFilterAnchor) {
        timelineFilterAnchor = getDateKey(now);
    }
}

function getTimelineFilterSummary() {
    const range = getTimelineDateRange();
    return range.label;
}

function getTimelineDateRange(mode = timelineFilterMode, anchorDateLike = timelineFilterAnchor) {
    const normalizedMode = ['day', 'week', 'month'].includes(mode) ? mode : 'month';
    const anchorDate = anchorDateLike ? getStartOfDay(anchorDateLike) : new Date();
    const normalizedAnchor = getStartOfDay(anchorDate);

    if (normalizedMode === 'day') {
        return {
            mode: normalizedMode,
            anchorDate: normalizedAnchor,
            startDate: getStartOfDay(normalizedAnchor),
            endDate: getEndOfDay(normalizedAnchor),
            label: `显示 ${getDateKey(normalizedAnchor)} 的记录`
        };
    }

    if (normalizedMode === 'week') {
        const startDate = getStartOfWeek(normalizedAnchor);
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        endDate.setHours(23, 59, 59, 999);
        return {
            mode: normalizedMode,
            anchorDate: normalizedAnchor,
            startDate,
            endDate,
            label: `显示第 ${getWeekNumber(startDate)} 周 · ${getDateKey(startDate)} 至 ${getDateKey(endDate)}`
        };
    }

    const startDate = new Date(normalizedAnchor.getFullYear(), normalizedAnchor.getMonth(), 1);
    const endDate = new Date(normalizedAnchor.getFullYear(), normalizedAnchor.getMonth() + 1, 0);
    endDate.setHours(23, 59, 59, 999);
    return {
        mode: normalizedMode,
        anchorDate: normalizedAnchor,
        startDate,
        endDate,
        label: `显示 ${normalizedAnchor.getFullYear()}-${String(normalizedAnchor.getMonth() + 1).padStart(2, '0')} 的记录`
    };
}

function getEndOfDay(dateLike) {
    const date = getStartOfDay(dateLike);
    date.setHours(23, 59, 59, 999);
    return date;
}

function setTimelineEntryFilter(mode) {
    const normalizedMode = ['all', 'created', 'todo'].includes(mode) ? mode : 'all';
    if (timelineEntryFilterMode === normalizedMode) {
        return;
    }

    timelineEntryFilterMode = normalizedMode;
    renderTimelinePanel({ force: true });
}

function getTimelineEntryFilterSummary() {
    if (timelineEntryFilterMode === 'created') {
        return '仅显示新建';
    }
    if (timelineEntryFilterMode === 'todo') {
        return '仅显示待办';
    }
    return '显示全部';
}

function setTimelineFilter(mode, anchorDateLike) {
    const normalizedMode = ['day', 'week', 'month'].includes(mode) ? mode : 'month';
    const anchorDate = anchorDateLike ? getStartOfDay(anchorDateLike) : new Date();
    timelineFilterMode = normalizedMode;
    timelineFilterAnchor = getDateKey(anchorDate);
    timelineCalendarMonthCursor = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
    renderTimelinePanel({ force: true });
}

function filterTimelineEntries(entries, entryFilter = timelineEntryFilterMode) {
    const range = getTimelineDateRange();
    const startTime = range.startDate.getTime();
    const endTime = range.endDate.getTime();

    return entries.filter((entry) => {
        const entryDate = new Date(entry.timestamp);
        const time = entryDate.getTime();
        if (!(time >= startTime && time <= endTime)) {
            return false;
        }
        if (entryFilter === 'created') {
            return entry.type === 'created';
        }
        if (entryFilter === 'todo') {
            return entry.type === 'todo-completed';
        }
        return true;
    });
}

function getDiaryFolderPath() {
    return workspaceRootPath ? path.join(path.resolve(workspaceRootPath), 'Dairy') : '';
}

function getDiaryBundleTitle(dateLike) {
    return `${getDateKey(dateLike || new Date())}日记`;
}

function getDiaryBundlePath(dateLike) {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath) return '';
    return path.join(diaryFolderPath, `${getDiaryBundleTitle(dateLike)}${DEFAULT_BUNDLE_EXTENSION}`);
}

function getSomedayBundlePath() {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath) return '';
    return path.join(diaryFolderPath, `Someday${DEFAULT_BUNDLE_EXTENSION}`);
}

async function ensureSomedayBundlePath() {
    if (!workspaceRootPath) {
        alert('请先打开工作空间文件夹。');
        return '';
    }

    const diaryFolderPath = getDiaryFolderPath();
    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);
    const somedayBundlePath = getSomedayBundlePath();

    try {
        if (fs.existsSync(diaryFolderPath) && !fs.statSync(diaryFolderPath).isDirectory()) {
            alert('工作空间中已有一个同名文件 Dairy，无法创建日记文件夹。');
            return '';
        }

        let createdDiaryFolder = false;
        if (!fs.existsSync(diaryFolderPath)) {
            fs.mkdirSync(diaryFolderPath, { recursive: true });
            createdDiaryFolder = true;
        }

        if (createdDiaryFolder && isSameOrNestedPath(diaryFolderPath, normalizedWorkspaceRoot)) {
            appendWorkspaceEntryToManualOrder(normalizedWorkspaceRoot, diaryFolderPath);
        }

        if (fs.existsSync(somedayBundlePath) && !isValidTextBundlePath(somedayBundlePath)) {
            alert('Someday 位置已被同名文件占用，无法创建待办文档。');
            return '';
        }

        if (!fs.existsSync(somedayBundlePath)) {
            await waitForEditorReady();
            ensureBundleStructure(somedayBundlePath);
            writeBundlePackageToPath(somedayBundlePath, buildDefaultBundleContent('Someday'), null, null, {
                title: 'Someday'
            });
            appendWorkspaceEntryToManualOrder(diaryFolderPath, somedayBundlePath);
            invalidateWorkspaceStructureCaches();
            workspaceTreeRenderVersion += 1;
            registerWorkspaceWatchers();
            scheduleWorkspaceTreeRefresh();
        }

        return somedayBundlePath;
    } catch (error) {
        alert(`创建 Someday 文档失败: ${error.message}`);
        return '';
    }
}

function getDiaryBundlePathsForDate(dateLike) {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath || !fs.existsSync(diaryFolderPath)) {
        return [];
    }

    const targetDateKey = getDateKey(dateLike || new Date());
    return getWorkspaceBundlePaths(diaryFolderPath)
        .map((bundlePath) => path.resolve(bundlePath))
        .filter((bundlePath) => {
            const baseName = stripKnownBundleExtension(path.basename(bundlePath));
            return baseName === `${targetDateKey}日记` || baseName.startsWith(`${targetDateKey}日记 `);
        })
        .sort((left, right) => path.basename(left).localeCompare(path.basename(right), 'zh-Hans-CN'));
}

function getDiaryBundleDateKey(bundlePath) {
    const baseName = stripKnownBundleExtension(path.basename(String(bundlePath || '')));
    const match = baseName.match(/^(\d{4}-\d{2}-\d{2})日记(?:\s+\d+)?$/);
    return match ? match[1] : '';
}

function getDiaryBundlesForCurrentTimelineFilter() {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath || !fs.existsSync(diaryFolderPath)) {
        return [];
    }

    const { startDate, endDate } = getTimelineDateRange();
    const startTime = startDate.getTime();
    const endTime = endDate.getTime();

    return getWorkspaceBundlePaths(diaryFolderPath)
        .map((bundlePath) => ({
            path: path.resolve(bundlePath),
            dateKey: getDiaryBundleDateKey(bundlePath)
        }))
        .filter((entry) => {
            if (!entry.dateKey) return false;
            const entryDate = new Date(`${entry.dateKey}T00:00:00`);
            const time = entryDate.getTime();
            return Number.isFinite(time) && time >= startTime && time <= endTime;
        })
        .sort((left, right) => {
            if (left.dateKey !== right.dateKey) {
                return left.dateKey.localeCompare(right.dateKey, 'zh-Hans-CN');
            }
            return path.basename(left.path).localeCompare(path.basename(right.path), 'zh-Hans-CN');
        })
        .map((entry) => ({
            ...entry,
            title: stripKnownBundleExtension(path.basename(entry.path)),
            relativePath: path.relative(diaryFolderPath, entry.path) || path.basename(entry.path)
        }));
}

function getTimelineSeparatorBundlesForCurrentTimelineFilter() {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath || !fs.existsSync(diaryFolderPath)) {
        return [];
    }

    return getWorkspaceBundlePaths(diaryFolderPath)
        .map((bundlePath) => {
            const resolvedPath = path.resolve(bundlePath);
            return {
                path: resolvedPath,
                dateKey: getDiaryBundleDateKey(resolvedPath)
            };
        })
        .filter((entry) => !entry.dateKey)
        .map((entry) => ({
            ...entry,
            title: stripKnownBundleExtension(path.basename(entry.path)),
            relativePath: path.relative(diaryFolderPath, entry.path) || path.basename(entry.path)
        }));
}

function getSeparatorTodoGroupsForCurrentTimelineFilter() {
    return getTimelineSeparatorBundlesForCurrentTimelineFilter().map((separator) => {
        const todos = sortTodoEntries(
            getTodoItemsForBundlePath(separator.path)
                .map((todo, index) => buildTodoEntry({
                    ...todo,
                    kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : index
                }, separator.path, 0)),
            'position'
        );

        return {
            ...separator,
            todos
        };
    });
}

function updateTimelineTodoGroupHiddenKey(fromBundlePath, toBundlePath) {
    const fromKey = getTimelineTodoGroupKey(fromBundlePath);
    const toKey = getTimelineTodoGroupKey(toBundlePath);
    if (!fromKey || !toKey || fromKey === toKey) {
        return false;
    }

    const settings = loadTimelineTodoGroupSettings();
    if (Object.prototype.hasOwnProperty.call(settings.hiddenCompletedByGroup, fromKey)) {
        settings.hiddenCompletedByGroup[toKey] = Boolean(settings.hiddenCompletedByGroup[fromKey]);
        delete settings.hiddenCompletedByGroup[fromKey];
        saveTimelineTodoGroupSettings(settings);
        return true;
    }

    return false;
}

function removeTimelineTodoGroupHiddenKey(bundlePath) {
    const key = getTimelineTodoGroupKey(bundlePath);
    if (!key) {
        return false;
    }

    const settings = loadTimelineTodoGroupSettings();
    if (!Object.prototype.hasOwnProperty.call(settings.hiddenCompletedByGroup, key)) {
        return false;
    }

    delete settings.hiddenCompletedByGroup[key];
    saveTimelineTodoGroupSettings(settings);
    return true;
}

async function createSeparatorBundleInDiaryFolder() {
    if (!workspaceRootPath) {
        alert('请先打开工作空间文件夹。');
        return false;
    }

    const diaryFolderPath = getDiaryFolderPath();
    const normalizedWorkspaceRoot = path.resolve(workspaceRootPath);

    try {
        if (fs.existsSync(diaryFolderPath) && !fs.statSync(diaryFolderPath).isDirectory()) {
            alert('工作空间中已有一个同名文件 Dairy，无法创建分隔条文件夹。');
            return false;
        }

        let createdDiaryFolder = false;
        if (!fs.existsSync(diaryFolderPath)) {
            fs.mkdirSync(diaryFolderPath, { recursive: true });
            createdDiaryFolder = true;
        }

        if (createdDiaryFolder && isSameOrNestedPath(diaryFolderPath, normalizedWorkspaceRoot)) {
            appendWorkspaceEntryToManualOrder(normalizedWorkspaceRoot, diaryFolderPath);
        }

        const separatorName = await openTextInputModal({
            title: '新增分隔条',
            message: '请输入分隔条名称。',
            defaultValue: '新分隔条',
            confirmText: '创建',
            allowEmpty: false
        });
        if (separatorName == null) {
            return false;
        }

        const trimmedName = String(separatorName || '').trim();
        if (!trimmedName) {
            alert('分隔条名称不能为空。');
            return false;
        }

        const separatorBundlePath = generateUniqueBundlePathInDirectory(diaryFolderPath, trimmedName);
        await waitForEditorReady();
        ensureBundleStructure(separatorBundlePath);
        writeBundlePackageToPath(separatorBundlePath, buildDefaultBundleContent(trimmedName), null, null, {
            title: trimmedName
        });
        appendWorkspaceEntryToManualOrder(diaryFolderPath, separatorBundlePath);
        invalidateWorkspaceStructureCaches();
        workspaceTreeRenderVersion += 1;
        registerWorkspaceWatchers();
        scheduleWorkspaceTreeRefresh();
        pendingWorkspaceRevealPath = separatorBundlePath;
        ensureWorkspacePathExpanded(separatorBundlePath);
        setWorkspaceSelectedEntryPath(separatorBundlePath);
        flashWorkspaceEntry(separatorBundlePath, 2000);
        scheduleTimelinePanelRender();
        return true;
    } catch (error) {
        alert(`创建分隔条失败: ${error.message}`);
        return false;
    }
}

async function renameSeparatorBundle(bundlePath) {
    if (!bundlePath) {
        return false;
    }

    const normalizedPath = path.resolve(bundlePath);
    const currentTitle = getDefaultBundleTitleFromPath(normalizedPath);
    const nextTitle = await openTextInputModal({
        title: '重命名分隔条',
        message: '请输入新的分隔条名称。',
        defaultValue: currentTitle,
        confirmText: '重命名',
        allowEmpty: false
    });
    if (nextTitle == null) {
        return false;
    }

    const trimmedName = String(nextTitle || '').trim();
    if (!trimmedName) {
        alert('分隔条名称不能为空。');
        return false;
    }

    const nextBundlePath = path.join(path.dirname(normalizedPath), `${stripKnownBundleExtension(trimmedName)}${DEFAULT_BUNDLE_EXTENSION}`);
    const didRename = await renameWorkspaceEntry(normalizedPath, trimmedName, { isBundle: true });
    if (!didRename) {
        return false;
    }

    updateTimelineTodoGroupHiddenKey(normalizedPath, nextBundlePath);
    scheduleTimelinePanelRender();
    return true;
}

async function deleteSeparatorBundle(bundlePath) {
    if (!bundlePath) {
        return false;
    }

    const normalizedPath = path.resolve(bundlePath);
    const didDelete = await deleteWorkspaceEntry({
        path: normalizedPath,
        isBundle: true
    }, {
        busyMessage: '正在删除分隔条…'
    });

    if (!didDelete) {
        return false;
    }

    removeTimelineTodoGroupHiddenKey(normalizedPath);
    scheduleTimelinePanelRender();
    return true;
}

function findTodoTaskItemLocationInDocumentJson(documentJson, todo = {}, options = {}) {
    const shouldClone = options.cloneDocument !== false;
    const nextDocumentJson = shouldClone ? cloneSerializableValue(documentJson) : documentJson;
    if (!nextDocumentJson || typeof nextDocumentJson !== 'object') {
        return null;
    }

    const stableId = String(todo.stableId || '').trim();
    const targetKindIndex = Number.isInteger(todo.kindIndex) ? todo.kindIndex : null;
    let currentKindIndex = 0;
    let found = null;

    const walk = (node, parentContent = null, indexInParent = -1) => {
        if (found || !node || typeof node !== 'object') {
            return;
        }

        if (node.type === 'taskItem') {
            const matches = stableId
                ? String(node.attrs?.id || '').trim() === stableId
                : (targetKindIndex != null ? currentKindIndex === targetKindIndex : false);
            if (matches) {
                found = {
                    documentJson: nextDocumentJson,
                    parentContent,
                    indexInParent,
                    taskNode: node,
                    kindIndex: currentKindIndex
                };
                return;
            }
            currentKindIndex += 1;
        }

        if (Array.isArray(node.content)) {
            node.content.forEach((child, index) => {
                walk(child, node.content, index);
            });
        }
    };

    walk(nextDocumentJson);
    return found;
}

function removeTodoTaskItemFromDocumentJson(documentJson, todo = {}) {
    const location = findTodoTaskItemLocationInDocumentJson(documentJson, todo);
    if (!location || !location.parentContent || !Number.isInteger(location.indexInParent) || location.indexInParent < 0) {
        return null;
    }

    const removedTaskNode = location.parentContent.splice(location.indexInParent, 1)[0] || null;
    if (!removedTaskNode) {
        return null;
    }

    pruneEmptyTaskListNodesFromDocumentJson(location.documentJson);

    return {
        documentJson: location.documentJson,
        taskNode: removedTaskNode,
        kindIndex: location.kindIndex
    };
}

function moveTodoTaskItemWithinDocumentJson(documentJson, sourceTodo = {}, targetTodo = {}, placeAfter = false) {
    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson || typeof nextDocumentJson !== 'object') {
        return null;
    }

    const sourceLocation = findTodoTaskItemLocationInDocumentJson(nextDocumentJson, sourceTodo, {
        cloneDocument: false
    });
    const targetLocation = findTodoTaskItemLocationInDocumentJson(nextDocumentJson, targetTodo, {
        cloneDocument: false
    });
    if (
        !sourceLocation
        || !targetLocation
        || !sourceLocation.parentContent
        || !targetLocation.parentContent
        || !Number.isInteger(sourceLocation.indexInParent)
        || !Number.isInteger(targetLocation.indexInParent)
        || sourceLocation.indexInParent < 0
        || targetLocation.indexInParent < 0
    ) {
        return null;
    }

    const sourceStableId = String(sourceTodo.stableId || '').trim();
    const targetStableId = String(targetTodo.stableId || '').trim();
    if (sourceStableId && targetStableId && sourceStableId === targetStableId) {
        return null;
    }

    const [movedTaskNode] = sourceLocation.parentContent.splice(sourceLocation.indexInParent, 1);
    if (!movedTaskNode) {
        return null;
    }

    let insertIndex = placeAfter ? targetLocation.indexInParent + 1 : targetLocation.indexInParent;
    if (sourceLocation.parentContent === targetLocation.parentContent && sourceLocation.indexInParent < insertIndex) {
        insertIndex -= 1;
    }

    insertIndex = clampNumber(insertIndex, 0, targetLocation.parentContent.length);
    targetLocation.parentContent.splice(insertIndex, 0, movedTaskNode);
    pruneEmptyTaskListNodesFromDocumentJson(nextDocumentJson);

    return nextDocumentJson;
}

function pruneEmptyTaskListNodesFromDocumentJson(node) {
    if (!node || typeof node !== 'object') {
        return node;
    }

    if (Array.isArray(node.content)) {
        const nextContent = [];
        for (const child of node.content) {
            const prunedChild = pruneEmptyTaskListNodesFromDocumentJson(child);
            if (!prunedChild) {
                continue;
            }

            if (prunedChild.type === 'taskList' && Array.isArray(prunedChild.content) && prunedChild.content.length === 0) {
                continue;
            }

            nextContent.push(prunedChild);
        }
        node.content = nextContent;
    }

    if (node.type === 'taskList' && Array.isArray(node.content) && node.content.length === 0) {
        return null;
    }

    return node;
}

function appendTodoTaskNodeToDocumentJson(documentJson, taskNode) {
    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson || typeof nextDocumentJson !== 'object' || !taskNode) {
        return null;
    }

    const rootContent = Array.isArray(nextDocumentJson.content)
        ? nextDocumentJson.content
        : (nextDocumentJson.content = []);
    const clonedTaskNode = cloneSerializableValue(taskNode);
    const lastNode = rootContent[rootContent.length - 1];

    if (lastNode?.type === 'taskList') {
        if (!Array.isArray(lastNode.content)) {
            lastNode.content = [];
        }
        lastNode.content.push(clonedTaskNode);
    } else {
        rootContent.push({
            type: 'taskList',
            attrs: {},
            content: [clonedTaskNode]
        });
    }

    return nextDocumentJson;
}

function setTodoTextInDocumentJson(documentJson, todo = {}, nextText = '') {
    const location = findTodoTaskItemLocationInDocumentJson(documentJson, todo);
    if (!location || !location.taskNode) {
        return null;
    }

    const normalizedText = String(nextText ?? '');
    location.taskNode.content = [{
        type: 'paragraph',
        content: normalizedText ? [{
            type: 'text',
            text: normalizedText
        }] : []
    }];

    return location.documentJson;
}

async function persistTodoDocumentJsonUpdate(bundlePath, nextDocumentJson, options = {}) {
    if (!bundlePath || !nextDocumentJson) {
        return false;
    }

    const normalizedTarget = path.resolve(bundlePath);
    const serializedMarkdown = serializeDocumentJsonToMarkdown(nextDocumentJson);
    const nextMarkdown = serializedMarkdown || (
        Array.isArray(nextDocumentJson.content) && nextDocumentJson.content.length
            ? String(getMarkdownContentForBundlePath(normalizedTarget) || '')
            : ''
    );
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
    const targetTitle = options.title || getDefaultBundleTitleFromPath(normalizedTarget);

    if (currentBundlePath === normalizedTarget && window.editor) {
        const applied = typeof window.editor.setDocumentJson === 'function'
            ? window.editor.setDocumentJson(nextDocumentJson, {
                emitChange: false,
                preserveSelection: options.preserveSelection !== false,
                forceRebuild: true
            })
            : false;
        if (!applied) {
            return false;
        }

        const savedPackage = writeBundlePackageToPath(normalizedTarget, nextMarkdown, nextDocumentJson, normalizedTarget, {
            title: targetTitle
        });

        const openTab = getOpenTabByBundlePath(normalizedTarget);
        if (openTab) {
            openTab.content = nextMarkdown;
            openTab.documentJson = cloneSerializableValue(savedPackage.documentJson || nextDocumentJson);
            openTab.previousContent = nextMarkdown;
            openTab.previousIsDirty = false;
            openTab.isDirty = false;
        }

        setDirty(false);
        updateBundleStatus(normalizedTarget);

        if (timelinePanelOpen && currentRightSidebarTab === 'timeline') {
            scheduleTimelinePanelRender();
        }
        if (currentRightSidebarTab === 'todo') {
            renderTodoList(getActiveEditorSnapshot());
        }

        return true;
    }

    return persistTodoBundleUpdate(normalizedTarget, nextMarkdown, nextDocumentJson, {
        title: targetTitle,
        refreshWorkspaceTree: options.refreshWorkspaceTree
    });
}

async function updateTimelineTodoItemText(todo, nextText) {
    if (!todo?.bundlePath) {
        return false;
    }

    const normalizedTarget = path.resolve(todo.bundlePath);
    const currentDocumentJson = getDocumentJsonForBundlePath(normalizedTarget);
    if (!currentDocumentJson) {
        return false;
    }

    const nextDocumentJson = setTodoTextInDocumentJson(currentDocumentJson, todo, nextText);
    if (!nextDocumentJson) {
        return false;
    }

    return persistTodoDocumentJsonUpdate(normalizedTarget, nextDocumentJson, {
        title: getDefaultBundleTitleFromPath(normalizedTarget)
    });
}

async function deleteTimelineTodoItem(todo) {
    if (!todo?.bundlePath) {
        return false;
    }

    const normalizedTarget = path.resolve(todo.bundlePath);
    const currentDocumentJson = getDocumentJsonForBundlePath(normalizedTarget);
    if (!currentDocumentJson) {
        return false;
    }

    const removal = removeTodoTaskItemFromDocumentJson(currentDocumentJson, todo);
    if (!removal?.taskNode || !removal.documentJson) {
        return false;
    }

    if (timelineTodoEditState?.todo?.stableId && String(timelineTodoEditState.todo.stableId || '').trim() === String(todo.stableId || '').trim()) {
        cancelTimelineTodoInlineEdit();
    }

    const didDelete = await persistTodoDocumentJsonUpdate(normalizedTarget, removal.documentJson, {
        title: getDefaultBundleTitleFromPath(normalizedTarget)
    });

    if (didDelete && currentRightSidebarTab === 'todo') {
        renderTodoList(getActiveEditorSnapshot());
    }

    return didDelete;
}

async function moveTimelineTodoItemToBundle(todo, targetBundlePath) {
    if (!todo?.bundlePath || !targetBundlePath) {
        return false;
    }

    const sourceBundlePath = path.resolve(todo.bundlePath);
    const normalizedTarget = path.resolve(targetBundlePath);
    if (sourceBundlePath === normalizedTarget) {
        return false;
    }

    const sourceDocumentJson = getDocumentJsonForBundlePath(sourceBundlePath);
    if (!sourceDocumentJson) {
        return false;
    }

    const removal = removeTodoTaskItemFromDocumentJson(sourceDocumentJson, todo);
    if (!removal?.taskNode) {
        return false;
    }

    let targetDocumentJson = getDocumentJsonForBundlePath(normalizedTarget);
    if (!targetDocumentJson && normalizedTarget === getSomedayBundlePath()) {
        const ensuredSomedayPath = await ensureSomedayBundlePath();
        if (ensuredSomedayPath && path.resolve(ensuredSomedayPath) === normalizedTarget) {
            targetDocumentJson = getDocumentJsonForBundlePath(normalizedTarget);
        }
    }
    if (!targetDocumentJson) {
        return false;
    }

    const nextTargetDocumentJson = appendTodoTaskNodeToDocumentJson(targetDocumentJson, removal.taskNode);
    if (!nextTargetDocumentJson) {
        return false;
    }

    const didRemove = await persistTodoDocumentJsonUpdate(sourceBundlePath, removal.documentJson, {
        title: getDefaultBundleTitleFromPath(sourceBundlePath)
    });
    if (!didRemove) {
        return false;
    }

    const didAppend = await persistTodoDocumentJsonUpdate(normalizedTarget, nextTargetDocumentJson, {
        title: getDefaultBundleTitleFromPath(normalizedTarget)
    });

    if (didAppend && timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        scheduleTimelinePanelRender();
    }

    return didAppend;
}

async function reorderTimelineTodoItemWithinBundle(todo, targetTodo, placeAfter = false) {
    if (!todo?.bundlePath || !targetTodo?.bundlePath) {
        return false;
    }

    const sourceBundlePath = path.resolve(todo.bundlePath);
    const targetBundlePath = path.resolve(targetTodo.bundlePath);
    if (sourceBundlePath !== targetBundlePath) {
        return false;
    }

    const currentDocumentJson = getDocumentJsonForBundlePath(sourceBundlePath);
    if (!currentDocumentJson) {
        return false;
    }

    const nextDocumentJson = moveTodoTaskItemWithinDocumentJson(currentDocumentJson, todo, targetTodo, placeAfter);
    if (!nextDocumentJson) {
        return false;
    }

    const didPersist = await persistTodoDocumentJsonUpdate(sourceBundlePath, nextDocumentJson, {
        title: getDefaultBundleTitleFromPath(sourceBundlePath)
    });
    if (didPersist && timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        scheduleTimelinePanelRender();
    }
    return didPersist;
}

async function commitTimelineTodoDragReorder() {
    const state = timelineTodoDropState;
    if (!state || state.committed) {
        return false;
    }

    state.committed = true;
    const didReorder = await reorderTimelineTodoItemWithinBundle(
        state.sourceTodo,
        state.targetTodo,
        state.placeAfter
    );
    if (!didReorder) {
        state.committed = false;
    }
    return didReorder;
}

function getDiaryTodoGroupsForCurrentTimelineFilter(diaryEntries = getDiaryBundlesForCurrentTimelineFilter()) {
    return diaryEntries.map((diary) => {
        const todos = sortTodoEntries(
            getTodoItemsForBundlePath(diary.path)
                .map((todo, index) => buildTodoEntry({
                    ...todo,
                    kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : index
                }, diary.path, 0)),
            'position'
        );

        return {
            ...diary,
            todos
        };
    });
}

async function addTodoToDiaryBundle(diaryBundlePath, todoText = '') {
    if (!diaryBundlePath) {
        return false;
    }

    return appendTodoToBundlePath(diaryBundlePath, todoText);
}

async function addTodoToSomedayBundle(todoText = '') {
    const somedayBundlePath = await ensureSomedayBundlePath();
    if (!somedayBundlePath) {
        return false;
    }

    return appendTodoToBundlePath(somedayBundlePath, todoText);
}

function getDiaryDateKeysForMonth(monthDate) {
    const diaryFolderPath = getDiaryFolderPath();
    if (!diaryFolderPath || !fs.existsSync(diaryFolderPath)) {
        return new Set();
    }

    const monthKey = getMonthKey(monthDate || new Date());
    const keys = new Set();
    for (const bundlePath of getWorkspaceBundlePaths(diaryFolderPath)) {
        const dateKey = getDiaryBundleDateKey(bundlePath);
        if (dateKey && dateKey.startsWith(monthKey)) {
            keys.add(dateKey);
        }
    }
    return keys;
}

function findDiaryBundleForDate(dateLike) {
    const diaryPaths = getDiaryBundlePathsForDate(dateLike);
    return diaryPaths[0] || '';
}

async function deleteDiaryBundlePath(diaryBundlePath) {
    if (!diaryBundlePath) return false;

    return deleteWorkspaceEntry({
        path: diaryBundlePath,
        isBundle: true
    }, {
        busyMessage: '正在删除日记…'
    });
}

async function deleteDiaryBundlesForDate(dateLike) {
    const diaryPaths = getDiaryBundlePathsForDate(dateLike);
    if (!diaryPaths.length) {
        alert('这一天还没有日记。');
        return false;
    }

    const dateKey = getDateKey(dateLike || new Date());
    const targetLabel = diaryPaths.length === 1
        ? path.basename(diaryPaths[0])
        : `${dateKey} 的 ${diaryPaths.length} 篇日记`;
    if (!confirm(`要删除${targetLabel}吗？删除后会进入系统废纸篓。`)) {
        return false;
    }

    for (const diaryPath of diaryPaths) {
        const deleted = await deleteWorkspaceEntry({
            path: diaryPath,
            isBundle: true
        }, {
            prompt: false,
            busyMessage: '正在删除日记…'
        });
        if (!deleted) {
            return false;
        }
    }

    if (workspaceRootPath) {
        invalidateWorkspaceTimelineEntriesCache(workspaceRootPath);
        scheduleTimelinePanelRender();
    }
    return true;
}

function buildTimelineCalendarMatrix(monthDate, diaryDateKeys = new Set()) {
    const monthStart = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
    const monthEnd = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0);
    const gridStart = getStartOfWeek(monthStart);
    const gridEnd = getStartOfWeek(monthEnd);
    gridEnd.setDate(gridEnd.getDate() + 6);

    const weeks = [];
    const todayKey = getDateKey(new Date());
    let cursor = new Date(gridStart);
    while (cursor <= gridEnd) {
        const weekStart = new Date(cursor);
        const days = [];
        for (let index = 0; index < 7; index++) {
            const current = new Date(cursor);
            const dateKey = getDateKey(current);
            days.push({
                date: current,
                dateKey,
                isCurrentMonth: current.getMonth() === monthStart.getMonth(),
                hasDiary: diaryDateKeys.has(dateKey),
                isToday: dateKey === todayKey
            });
            cursor.setDate(cursor.getDate() + 1);
        }
        weeks.push({
            weekStart,
            weekKey: getWeekKey(weekStart),
            weekNumber: getWeekNumber(weekStart),
            days
        });
    }

    return weeks;
}

function updateTimelinePanelSubtitle(text) {
    const subtitle = document.getElementById('timeline-panel-subtitle');
    if (subtitle && currentRightSidebarTab === 'timeline') {
        subtitle.textContent = text;
    }
}

function shiftTimelineCalendarMonth(offset) {
    ensureTimelineFilterState();
    const nextMonth = new Date(timelineCalendarMonthCursor.getFullYear(), timelineCalendarMonthCursor.getMonth() + offset, 1);
    timelineCalendarMonthCursor = nextMonth;
    if (timelineFilterMode === 'month') {
        timelineFilterAnchor = getDateKey(nextMonth);
    }
    renderTimelinePanel({ force: true });
}

function getWorkspaceTimelineEntries(limit = 160) {
    if (!workspaceRootPath) {
        return [];
    }

    const normalizedRoot = path.resolve(workspaceRootPath);
    if (
        !workspaceTimelineEntriesCacheDirty
        && workspaceTimelineEntriesCacheRoot === normalizedRoot
        && Array.isArray(workspaceTimelineEntriesCache)
    ) {
        return workspaceTimelineEntriesCache.slice(0, limit);
    }

    persistActiveTabState();

    const entries = [];
    for (const bundlePath of getWorkspaceBundlePaths(workspaceRootPath)) {
        const normalizedBundlePath = path.resolve(bundlePath);
        let bundleStat = null;
        try {
            bundleStat = fs.statSync(normalizedBundlePath);
        } catch {
            continue;
        }

        const markdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath);
        let markdownStat = null;
        try {
            if (markdownPath && fs.existsSync(markdownPath)) {
                markdownStat = fs.statSync(markdownPath);
            }
        } catch {
            markdownStat = null;
        }

        const createdAt = Number.isFinite(bundleStat.birthtimeMs) && bundleStat.birthtimeMs > 0
            ? bundleStat.birthtimeMs
            : (Number.isFinite(bundleStat.ctimeMs) && bundleStat.ctimeMs > 0
                ? bundleStat.ctimeMs
                : bundleStat.mtimeMs);
        const editedAt = Number.isFinite(markdownStat?.mtimeMs) && markdownStat.mtimeMs > 0
            ? markdownStat.mtimeMs
            : (Number.isFinite(bundleStat.mtimeMs) && bundleStat.mtimeMs > 0 ? bundleStat.mtimeMs : createdAt);
        const documentTitle = getDocumentTitleFromBundlePath(normalizedBundlePath);
        const relativeFolder = getRelativeWorkspaceFolder(normalizedBundlePath);
        const relativeBundlePath = path.relative(workspaceRootPath, normalizedBundlePath) || path.basename(normalizedBundlePath);

        entries.push({
            id: `${normalizedBundlePath}:created`,
            type: 'created',
            timestamp: createdAt,
            bundlePath: normalizedBundlePath,
            relativeFolder,
            relativeBundlePath,
            action: `创建了《${documentTitle}》`
        });

        if (Number.isFinite(editedAt) && Number.isFinite(createdAt) && Math.abs(editedAt - createdAt) > 1000) {
            entries.push({
                id: `${normalizedBundlePath}:edited`,
                type: 'edited',
                timestamp: editedAt,
                bundlePath: normalizedBundlePath,
                relativeFolder,
                relativeBundlePath,
                action: `编辑了《${documentTitle}》`
            });
        }
    }

    const customEvents = readWorkspaceTimelineEvents(workspaceRootPath);
    for (const entry of customEvents) {
        const timestamp = Number(entry?.timestamp);
        if (!Number.isFinite(timestamp)) continue;

        const relativeBundlePath = String(entry.relativeBundlePath || '').trim();
        const bundlePath = relativeBundlePath
            ? path.resolve(workspaceRootPath, relativeBundlePath)
            : path.resolve(String(entry.bundlePath || ''));
        if (!bundlePath) continue;

        entries.push({
            id: String(entry.id || `timeline:${timestamp}:${Math.random().toString(36).slice(2, 8)}`),
            type: String(entry.type || 'edited'),
            timestamp,
            bundlePath,
            relativeFolder: String(entry.relativeFolder || getRelativeWorkspaceFolder(bundlePath) || ''),
            relativeBundlePath: relativeBundlePath || path.relative(workspaceRootPath, bundlePath) || path.basename(bundlePath),
            action: String(entry.action || ''),
            todoText: String(entry.todoText || ''),
            noteTitle: String(entry.noteTitle || getDocumentTitleFromBundlePath(bundlePath))
        });
    }

    entries.sort((left, right) => {
        if (right.timestamp !== left.timestamp) {
            return right.timestamp - left.timestamp;
        }
        return String(left.relativeBundlePath || '').localeCompare(String(right.relativeBundlePath || ''), 'zh-Hans-CN');
    });

    workspaceTimelineEntriesCache = entries;
    workspaceTimelineEntriesCacheRoot = normalizedRoot;
    workspaceTimelineEntriesCacheDirty = false;

    return entries.slice(0, limit);
}

function renderTimelinePanel(options = {}) {
    const { force = false } = options;
    const container = document.getElementById('timeline-panel-content');
    if (!container) return;

    if (!force && !timelinePanelNeedsRender && container.childElementCount) {
        return;
    }

    timelinePanelNeedsRender = false;

    if (!workspaceRootPath) {
        updateTimelinePanelSubtitle('按时间查看笔记的创建与编辑记录');
        renderTimelineEmptyState(container, '打开工作空间后，这里会按时间显示你创建和编辑过的笔记。');
        return;
    }

    ensureTimelineFilterState();

    const entries = getWorkspaceTimelineEntries();
    if (!entries.length) {
        updateTimelinePanelSubtitle('按时间查看笔记的创建与编辑记录');
        renderTimelineEmptyState(container, '当前工作空间还没有可显示的时间线记录。');
        return;
    }

    updateTimelinePanelSubtitle(getTimelineFilterSummary());

    container.innerHTML = '';
    const diaryDateKeys = getDiaryDateKeysForMonth(timelineCalendarMonthCursor);
    const calendarWeeks = buildTimelineCalendarMatrix(timelineCalendarMonthCursor, diaryDateKeys);

    const calendar = document.createElement('div');
    calendar.className = 'timeline-calendar';

    const calendarHeader = document.createElement('div');
    calendarHeader.className = 'timeline-calendar-header';
    const nav = document.createElement('div');
    nav.className = 'timeline-calendar-nav';
    const prevMonthButton = document.createElement('button');
    prevMonthButton.type = 'button';
    prevMonthButton.className = 'timeline-month-nav';
    prevMonthButton.title = '上一个月';
    prevMonthButton.setAttribute('aria-label', '上一个月');
    prevMonthButton.innerHTML = '<i class="fa-solid fa-chevron-left" aria-hidden="true"></i>';
    prevMonthButton.addEventListener('click', () => {
        shiftTimelineCalendarMonth(-1);
    });
    const monthButton = document.createElement('button');
    monthButton.type = 'button';
    monthButton.className = `timeline-month-button${timelineFilterMode === 'month' ? ' active' : ''}`;
    monthButton.textContent = `${timelineCalendarMonthCursor.getFullYear()}年${timelineCalendarMonthCursor.getMonth() + 1}月`;
    monthButton.addEventListener('click', () => {
        setTimelineFilter('month', timelineCalendarMonthCursor);
    });
    const nextMonthButton = document.createElement('button');
    nextMonthButton.type = 'button';
    nextMonthButton.className = 'timeline-month-nav';
    nextMonthButton.title = '下一个月';
    nextMonthButton.setAttribute('aria-label', '下一个月');
    nextMonthButton.innerHTML = '<i class="fa-solid fa-chevron-right" aria-hidden="true"></i>';
    nextMonthButton.addEventListener('click', () => {
        shiftTimelineCalendarMonth(1);
    });
    nav.appendChild(prevMonthButton);
    nav.appendChild(monthButton);
    nav.appendChild(nextMonthButton);
    const calendarActions = document.createElement('div');
    calendarActions.className = 'timeline-calendar-actions';
    const todayButton = document.createElement('button');
    todayButton.type = 'button';
    todayButton.className = 'timeline-today-button';
    todayButton.textContent = '今天';
    todayButton.addEventListener('click', () => {
        setTimelineFilter('month', new Date());
    });
    const calendarSummary = document.createElement('div');
    calendarSummary.className = 'timeline-calendar-summary';
    calendarSummary.textContent = `${calendarWeeks.length} 周`;
    calendarActions.appendChild(todayButton);
    calendarActions.appendChild(calendarSummary);
    calendarHeader.appendChild(nav);
    calendarHeader.appendChild(calendarActions);
    calendar.appendChild(calendarHeader);

    const calendarGrid = document.createElement('div');
    calendarGrid.className = 'timeline-calendar-grid';
    const corner = document.createElement('div');
    corner.className = 'timeline-weekday timeline-week-corner';
    calendarGrid.appendChild(corner);
    for (const label of ['一', '二', '三', '四', '五', '六', '日']) {
        const weekday = document.createElement('div');
        weekday.className = 'timeline-weekday';
        weekday.textContent = label;
        calendarGrid.appendChild(weekday);
    }

    for (const week of calendarWeeks) {
        const weekButton = document.createElement('button');
        weekButton.type = 'button';
        weekButton.className = `timeline-week-label${timelineFilterMode === 'week' && getWeekKey(timelineFilterAnchor) === week.weekKey ? ' active' : ''}`;
        weekButton.textContent = `W${week.weekNumber}`;
        weekButton.title = `查看第 ${week.weekNumber} 周`;
        weekButton.addEventListener('click', () => {
            setTimelineFilter('week', week.weekStart);
        });
        calendarGrid.appendChild(weekButton);

        for (const day of week.days) {
            const dayButton = document.createElement('button');
            dayButton.type = 'button';
            dayButton.className = 'timeline-day-cell';
            if (!day.isCurrentMonth) {
                dayButton.classList.add('muted');
            }
            if (day.isToday) {
                dayButton.classList.add('today');
            }
            if (timelineFilterMode === 'day' && timelineFilterAnchor === day.dateKey) {
                dayButton.classList.add('active');
            }
            dayButton.title = `${day.dateKey}${day.hasDiary ? ' · 有日记' : ''}`;
            dayButton.addEventListener('click', () => {
                setTimelineFilter('day', day.date);
            });
            dayButton.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                showTimelineDayContextMenu(event, day.date);
            });

            const number = document.createElement('span');
            number.className = 'timeline-day-number';
            number.textContent = String(day.date.getDate());
            dayButton.appendChild(number);
            if (day.hasDiary) {
                const marker = document.createElement('span');
                marker.className = 'timeline-day-marker';
                marker.setAttribute('aria-hidden', 'true');
                dayButton.appendChild(marker);
            }
            calendarGrid.appendChild(dayButton);
        }
    }
    calendar.appendChild(calendarGrid);
    container.appendChild(calendar);

    const diaryEntries = getDiaryBundlesForCurrentTimelineFilter();
    const diaryCard = document.createElement('div');
    diaryCard.className = 'timeline-diary-card';
    const diaryHead = document.createElement('div');
    diaryHead.className = 'timeline-diary-card-head';
    const diaryMeta = document.createElement('div');
    diaryMeta.className = 'timeline-diary-card-meta';
    const diaryTitle = document.createElement('div');
    diaryTitle.className = 'timeline-diary-card-title';
    diaryTitle.textContent = '日记';
    const diarySubtitle = document.createElement('div');
    diarySubtitle.className = 'timeline-diary-card-subtitle';
    diarySubtitle.textContent = diaryEntries.length
        ? `${getTimelineDateRange().label} · 共 ${diaryEntries.length} 篇`
        : `${getTimelineDateRange().label} · 这里还没有日记`;
    diaryMeta.appendChild(diaryTitle);
    diaryMeta.appendChild(diarySubtitle);
    diaryHead.appendChild(diaryMeta);

    const diaryActionButton = document.createElement('button');
    diaryActionButton.type = 'button';
    diaryActionButton.className = 'todo-header-button timeline-diary-card-action';
    diaryActionButton.title = '新建当天日记';
    diaryActionButton.setAttribute('aria-label', diaryActionButton.title);
    diaryActionButton.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i>';
    diaryActionButton.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await createDiaryBundleForDate(new Date());
    });
    diaryHead.appendChild(diaryActionButton);
    diaryCard.appendChild(diaryHead);

    const diaryBody = document.createElement('div');
    diaryBody.className = 'timeline-diary-card-body';
    if (!diaryEntries.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '这个时间范围内还没有日记。点击右上角按钮可以新建当天日记，也可以右键日历日期创建。';
        diaryBody.appendChild(emptyState);
    } else {
        for (const diary of diaryEntries) {
            const item = document.createElement('div');
            item.className = 'timeline-diary-item';
            const itemMain = document.createElement('button');
            itemMain.type = 'button';
            itemMain.className = 'timeline-diary-item-main';
            itemMain.title = diary.path;
            itemMain.addEventListener('click', () => {
                void openWorkspaceBundle(diary.path);
            });
            itemMain.addEventListener('contextmenu', (event) => {
                event.preventDefault();
                event.stopPropagation();
                showTimelineDiaryContextMenu(event, diary);
            });

            const itemTitle = document.createElement('div');
            itemTitle.className = 'timeline-diary-item-title';
            itemTitle.textContent = diary.dateKey;
            const itemMeta = document.createElement('div');
            itemMeta.className = 'timeline-diary-item-meta';
            itemMeta.textContent = '日记';
            itemMain.appendChild(itemTitle);
            itemMain.appendChild(itemMeta);

            item.appendChild(itemMain);
            diaryBody.appendChild(item);
        }
    }
    diaryCard.appendChild(diaryBody);
    container.appendChild(diaryCard);

    const timelineCard = document.createElement('div');
    timelineCard.className = 'timeline-feed-card';
    const timelineHead = document.createElement('div');
    timelineHead.className = 'timeline-feed-card-head';
    const timelineMeta = document.createElement('div');
    timelineMeta.className = 'timeline-feed-card-meta';
    const timelineTitle = document.createElement('div');
    timelineTitle.className = 'timeline-feed-card-title';
    timelineTitle.textContent = '时间线';
    const timelineSubtitle = document.createElement('div');
    timelineSubtitle.className = 'timeline-feed-card-subtitle';
    timelineSubtitle.textContent = `${getTimelineFilterSummary()} · ${getTimelineEntryFilterSummary()}`;
    timelineMeta.appendChild(timelineTitle);
    timelineMeta.appendChild(timelineSubtitle);
    timelineHead.appendChild(timelineMeta);

    const timelineFilters = document.createElement('div');
    timelineFilters.className = 'timeline-feed-filters';
    [
        { value: 'all', label: '显示全部' },
        { value: 'created', label: '仅显示新建' },
        { value: 'todo', label: '仅显示待办' }
    ].forEach((option) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `timeline-feed-filter${timelineEntryFilterMode === option.value ? ' active' : ''}`;
        button.textContent = option.label;
        button.addEventListener('click', () => {
            setTimelineEntryFilter(option.value);
        });
        timelineFilters.appendChild(button);
    });
    timelineHead.appendChild(timelineFilters);
    timelineCard.appendChild(timelineHead);

    const list = document.createElement('div');
    list.className = 'timeline-list';
    const visibleEntries = filterTimelineEntries(entries);

    if (!visibleEntries.length) {
        renderTimelineEmptyState(list, '这个时间范围内还没有时间线记录。');
    } else {
        for (const entry of visibleEntries) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'timeline-entry';
            item.title = `${entry.action}\n${entry.relativeBundlePath}`;
            item.addEventListener('click', () => {
                if (entry.type === 'todo-completed') {
                    void jumpToTimelineTodoEntry(entry);
                    return;
                }

                void openWorkspaceBundle(entry.bundlePath);
            });

            const time = formatTimelineTimestampParts(entry.timestamp);

            const timeColumn = document.createElement('div');
            timeColumn.className = 'timeline-time';
            const dateSpan = document.createElement('span');
            dateSpan.className = 'timeline-time-date';
            dateSpan.textContent = time.date;
            const clockSpan = document.createElement('span');
            clockSpan.className = 'timeline-time-clock';
            clockSpan.textContent = time.clock;
            timeColumn.appendChild(dateSpan);
            timeColumn.appendChild(clockSpan);

            const marker = document.createElement('div');
            marker.className = 'timeline-marker';
            const node = document.createElement('span');
            node.className = 'timeline-node';
            marker.appendChild(node);

            const card = document.createElement('div');
            card.className = 'timeline-card';
            const action = document.createElement('div');
            action.className = 'timeline-action';
            action.textContent = entry.action;

            const meta = document.createElement('div');
            meta.className = 'timeline-meta';
            const kind = document.createElement('span');
            kind.className = 'timeline-kind';
            kind.textContent = entry.type === 'created'
                ? '创建'
                : (entry.type === 'todo-completed'
                    ? '完成待办'
                    : (entry.type === 'pomodoro-completed' ? '番茄钟' : '编辑'));
            const pathMeta = document.createElement('span');
            pathMeta.className = 'timeline-path';
            pathMeta.textContent = entry.relativeFolder || '工作空间根目录';
            meta.appendChild(kind);
            meta.appendChild(pathMeta);

            card.appendChild(action);
            card.appendChild(meta);

            item.appendChild(timeColumn);
            item.appendChild(marker);
            item.appendChild(card);
            list.appendChild(item);
        }
    }

    timelineCard.appendChild(list);
    container.appendChild(timelineCard);

    window.requestAnimationFrame(() => {
        if (tryActivatePendingTimelineTodoInlineEdit()) {
            return;
        }
        restoreTimelineTodoInlineEdit();
    });
}

function scheduleTimelinePanelRender() {
    timelinePanelNeedsRender = true;
    if (!timelinePanelOpen || currentRightSidebarTab !== 'timeline' || timelinePanelRenderFrame) {
        return;
    }

    timelinePanelRenderFrame = window.requestAnimationFrame(() => {
        timelinePanelRenderFrame = null;
        renderTimelinePanel();
    });
}

function applyTimelinePanelVisibility(visible, options = {}) {
    const { persist = true } = options;
    timelinePanelOpen = Boolean(visible);
    document.body.classList.toggle('timeline-panel-open', timelinePanelOpen);
    document.body.classList.toggle('sidebar-detail-open', timelinePanelOpen && currentSidebarTab !== 'workspace');
    updateRightSidebarHeader();
    updateRightSidebarPanels();
    updateRightSidebarButtons();
    if (persist) {
        saveTimelinePanelVisibilityPreference(timelinePanelOpen);
    }
    if (timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        renderTimelinePanel({ force: true });
    }
    return timelinePanelOpen;
}

function toggleTimelinePanelVisibility() {
    if (!isFeatureEnabled('timeline')) {
        return false;
    }
    if (timelinePanelOpen && currentSidebarTab === 'timeline' && currentRightSidebarTab === 'timeline') {
        return setSidebarTab('workspace');
    }
    currentSidebarTab = 'timeline';
    currentRightSidebarTab = 'timeline';
    return applyTimelinePanelVisibility(true);
}

function toggleRightSidebarTab(tab) {
    const normalizedTab = ['timeline', 'outline', 'todo', 'attachment', 'pomodoro'].includes(tab) ? tab : 'timeline';
    if (
        (normalizedTab === 'timeline' && !isFeatureEnabled('timeline'))
        || (normalizedTab === 'pomodoro' && !isFeatureEnabled('pomodoro'))
    ) {
        return setSidebarTab('workspace');
    }
    if (timelinePanelOpen && currentSidebarTab === normalizedTab && currentRightSidebarTab === normalizedTab) {
        return setSidebarTab('workspace');
    }

    currentSidebarTab = normalizedTab;
    currentRightSidebarTab = normalizedTab;
    if (normalizedTab === 'timeline') {
        return applyTimelinePanelVisibility(true);
    }

    applyTimelinePanelVisibility(true);
    if (normalizedTab === 'outline') {
        updateOutline();
    } else if (normalizedTab === 'todo') {
        renderTodoList(getActiveEditorSnapshot());
    } else if (normalizedTab === 'pomodoro') {
        renderPomodoroPanel();
    }
    return true;
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
    document.documentElement.style.colorScheme = normalized.startsWith('light-') ? 'light' : 'dark';

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

function normalizeFeatureVisibilitySettings(settings = {}) {
    return {
        timeline: settings.timeline !== false,
        pomodoro: settings.pomodoro !== false
    };
}

function loadFeatureVisibilitySettings() {
    try {
        const raw = window.localStorage.getItem(FEATURE_VISIBILITY_SETTINGS_KEY);
        if (!raw) {
            return { ...DEFAULT_FEATURE_VISIBILITY_SETTINGS };
        }
        return normalizeFeatureVisibilitySettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_FEATURE_VISIBILITY_SETTINGS };
    }
}

function isFeatureEnabled(featureKey) {
    const normalized = featureVisibilitySettings || DEFAULT_FEATURE_VISIBILITY_SETTINGS;
    return normalized[featureKey] !== false;
}

function updateFeatureControlledUi() {
    const controlledButtons = [
        { id: 'timeline-toggle-button', enabled: isFeatureEnabled('timeline') },
        { id: 'pomodoro-toggle-button', enabled: isFeatureEnabled('pomodoro') }
    ];

    for (const entry of controlledButtons) {
        const button = document.getElementById(entry.id);
        if (!button) continue;
        button.hidden = !entry.enabled;
        button.disabled = !entry.enabled;
        button.style.display = entry.enabled ? '' : 'none';
    }
}

function applyFeatureVisibility(settings = {}) {
    const normalized = normalizeFeatureVisibilitySettings(settings);
    featureVisibilitySettings = normalized;

    const activeFeatureDisabled = (
        (currentSidebarTab === 'timeline' && !normalized.timeline)
        || (currentSidebarTab === 'pomodoro' && !normalized.pomodoro)
    );

    if (activeFeatureDisabled) {
        currentSidebarTab = 'workspace';
        timelinePanelOpen = false;
    }

    if (currentRightSidebarTab === 'timeline' && !normalized.timeline && timelinePanelOpen) {
        currentSidebarTab = 'workspace';
        timelinePanelOpen = false;
    }

    updateFeatureControlledUi();
    updateRightSidebarHeader();
    updateRightSidebarPanels();
    updateRightSidebarButtons();
    return normalized;
}

function saveFeatureVisibilitySettings(settings = {}) {
    const normalized = applyFeatureVisibility(settings);
    try {
        window.localStorage.setItem(FEATURE_VISIBILITY_SETTINGS_KEY, JSON.stringify(normalized));
    } catch {
        // ignore persistence failures
    }
    return normalized;
}

function normalizeSidebarRailOrder(order = []) {
    const normalized = [];
    const seen = new Set();
    const input = Array.isArray(order) ? order : [];

    for (const item of input) {
        const key = String(item || '').trim();
        if (!DEFAULT_SIDEBAR_RAIL_ORDER.includes(key) || seen.has(key)) {
            continue;
        }
        normalized.push(key);
        seen.add(key);
    }

    for (const key of DEFAULT_SIDEBAR_RAIL_ORDER) {
        if (seen.has(key)) continue;
        normalized.push(key);
    }

    return normalized;
}

function loadSidebarRailOrder() {
    try {
        const raw = window.localStorage.getItem(SIDEBAR_RAIL_ORDER_SETTINGS_KEY);
        if (!raw) {
            return DEFAULT_SIDEBAR_RAIL_ORDER.slice();
        }
        return normalizeSidebarRailOrder(JSON.parse(raw));
    } catch {
        return DEFAULT_SIDEBAR_RAIL_ORDER.slice();
    }
}

function saveSidebarRailOrder(order = []) {
    const normalized = normalizeSidebarRailOrder(order);
    try {
        window.localStorage.setItem(SIDEBAR_RAIL_ORDER_SETTINGS_KEY, JSON.stringify(normalized));
    } catch {
        // ignore persistence failures
    }
    return normalized;
}

function applySidebarRailOrder(order = loadSidebarRailOrder()) {
    const container = document.getElementById('sidebar-nav-primary');
    if (!container) {
        return;
    }

    const normalized = normalizeSidebarRailOrder(order);
    for (const key of normalized) {
        const button = container.querySelector(`[data-sidebar-item="${key}"]`);
        if (button) {
            container.appendChild(button);
        }
    }
}

function clearSidebarRailDragIndicators() {
    document.querySelectorAll('.sidebar-rail-button.drag-over-before, .sidebar-rail-button.drag-over-after, .sidebar-rail-button.dragging')
        .forEach((button) => {
            button.classList.remove('drag-over-before', 'drag-over-after', 'dragging');
        });
}

function persistCurrentSidebarRailOrder() {
    const container = document.getElementById('sidebar-nav-primary');
    if (!container) {
        return;
    }
    const order = Array.from(container.querySelectorAll('[data-sidebar-item]'))
        .map((button) => String(button.dataset.sidebarItem || '').trim())
        .filter(Boolean);
    saveSidebarRailOrder(order);
}

function setupSidebarRailReorder() {
    const container = document.getElementById('sidebar-nav-primary');
    if (!container) {
        return;
    }

    applySidebarRailOrder();

    container.querySelectorAll('.sidebar-rail-button[data-sidebar-item]').forEach((button) => {
        button.setAttribute('draggable', 'true');
    });

    container.addEventListener('dragstart', (event) => {
        const button = event.target.closest('.sidebar-rail-button[data-sidebar-item]');
        if (!button) return;

        draggedSidebarRailItem = String(button.dataset.sidebarItem || '').trim();
        button.classList.add('dragging');
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedSidebarRailItem);
    });

    container.addEventListener('dragover', (event) => {
        const target = event.target.closest('.sidebar-rail-button[data-sidebar-item]');
        if (!target || !draggedSidebarRailItem || target.dataset.sidebarItem === draggedSidebarRailItem) {
            return;
        }

        event.preventDefault();
        clearSidebarRailDragIndicators();
        const rect = target.getBoundingClientRect();
        const placeAfter = event.clientY > rect.top + rect.height / 2;
        target.classList.add(placeAfter ? 'drag-over-after' : 'drag-over-before');
    });

    container.addEventListener('drop', (event) => {
        const target = event.target.closest('.sidebar-rail-button[data-sidebar-item]');
        const draggedKey = draggedSidebarRailItem;
        if (!target || !draggedKey || target.dataset.sidebarItem === draggedKey) {
            clearSidebarRailDragIndicators();
            draggedSidebarRailItem = null;
            return;
        }

        event.preventDefault();
        const draggedButton = container.querySelector(`[data-sidebar-item="${draggedKey}"]`);
        if (!draggedButton) {
            clearSidebarRailDragIndicators();
            draggedSidebarRailItem = null;
            return;
        }

        const rect = target.getBoundingClientRect();
        const placeAfter = event.clientY > rect.top + rect.height / 2;
        if (placeAfter) {
            target.insertAdjacentElement('afterend', draggedButton);
        } else {
            target.insertAdjacentElement('beforebegin', draggedButton);
        }

        persistCurrentSidebarRailOrder();
        clearSidebarRailDragIndicators();
        draggedSidebarRailItem = null;
    });

    container.addEventListener('dragend', () => {
        clearSidebarRailDragIndicators();
        draggedSidebarRailItem = null;
    });

    container.addEventListener('dragleave', (event) => {
        if (event.currentTarget.contains(event.relatedTarget)) {
            return;
        }
        clearSidebarRailDragIndicators();
    });
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
    return {
        uiFont,
        editorFont,
        uiFontSize: Math.round(uiFontSize),
        editorFontSize: Math.round(editorFontSize),
        editorLineHeight: Math.round(editorLineHeight * 100) / 100,
        editorParagraphSpacing: Math.round(editorParagraphSpacing * 10) / 10
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
    ensureTypographyFontStylesheets([
        ...DEFAULT_TYPOGRAPHY_FONT_IDS,
        normalized.uiFont,
        normalized.editorFont
    ]);
    const root = document.documentElement;
    root.style.setProperty('--ui-font-family', FONT_FAMILY_MAP[normalized.uiFont]);
    root.style.setProperty('--editor-font-family', FONT_FAMILY_MAP[normalized.editorFont]);
    root.style.setProperty('--ui-font-size', `${normalized.uiFontSize}px`);
    root.style.setProperty('--editor-font-size', `${normalized.editorFontSize}px`);
    root.style.setProperty('--editor-line-height', String(normalized.editorLineHeight));
    root.style.setProperty('--editor-paragraph-spacing', `${normalized.editorParagraphSpacing}px`);
    document.body.setAttribute('data-toolbar-position', FIXED_TOOLBAR_POSITION);

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

    let editorWidth = Number(settings.editorWidth);
    if (!Number.isFinite(editorWidth)) editorWidth = DEFAULT_LAYOUT_SETTINGS.editorWidth;
    editorWidth = clamp(editorWidth, 50, 100);

    let previewWidth = Number(settings.previewWidth);
    if (!Number.isFinite(previewWidth)) previewWidth = DEFAULT_LAYOUT_SETTINGS.previewWidth;
    previewWidth = clamp(previewWidth, 10, 90);

    return {
        sidebarWidth: Math.round(sidebarWidth * 10) / 10,
        editorWidth: Math.round(editorWidth * 10) / 10,
        previewWidth: Math.round(previewWidth * 10) / 10
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
    const button = document.getElementById('bottom-sidebar-toggle-button');
    const icon = document.getElementById('bottom-sidebar-toggle-icon');
    if (!button) return;
    const isVisible = !document.body.classList.contains('sidebar-collapsed');
    button.classList.toggle('active', !isVisible);
    button.title = isVisible ? '隐藏侧边栏' : '显示侧边栏';
    button.setAttribute('aria-label', button.title);
    if (icon) icon.className = isVisible ? 'fa-solid fa-angles-left' : 'fa-solid fa-angles-right';
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

function loadToolbarVisibilityPreference() {
    try {
        return window.localStorage.getItem(TOOLBAR_VISIBILITY_SETTINGS_KEY) !== 'hidden';
    } catch {
        return true;
    }
}

function updateToolbarToggleButton() {
    const button = document.getElementById('bottom-toolbar-toggle-button');
    const icon = document.getElementById('bottom-toolbar-toggle-icon');
    if (!button) return;
    const isVisible = !document.body.classList.contains('toolbar-hidden');
    button.classList.toggle('active', !isVisible);
    button.title = isVisible ? '隐藏工具栏' : '显示工具栏';
    button.setAttribute('aria-label', button.title);
    if (icon) icon.className = 'fa-solid fa-sliders';
}

function applyToolbarVisibility(visible) {
    const isVisible = Boolean(visible);
    document.body.classList.toggle('toolbar-hidden', !isVisible);
    updateToolbarToggleButton();
    return isVisible;
}

function saveToolbarVisibilityPreference(visible) {
    const normalized = applyToolbarVisibility(visible);
    try {
        window.localStorage.setItem(TOOLBAR_VISIBILITY_SETTINGS_KEY, normalized ? 'visible' : 'hidden');
    } catch {
        // ignore persistence failures
    }
}

function toggleToolbarVisibility() {
    const nextVisible = document.body.classList.contains('toolbar-hidden');
    saveToolbarVisibilityPreference(nextVisible);
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
    if (RICH_TEXT_EDITOR_ONLY) {
        return 'editor';
    }
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

function normalizeInlineMediaPositionSettings(settings = {}) {
    const source = settings && typeof settings === 'object' ? settings : {};
    const position = ['left', 'center', 'right', 'offset'].includes(source.position)
        ? source.position
        : DEFAULT_INLINE_MEDIA_POSITION_SETTINGS.position;
    let leftOffset = Number(source.leftOffset);
    if (!Number.isFinite(leftOffset)) {
        leftOffset = DEFAULT_INLINE_MEDIA_POSITION_SETTINGS.leftOffset;
    }
    leftOffset = clamp(leftOffset, 0, 40);
    return {
        position,
        leftOffset: Math.round(leftOffset * 10) / 10
    };
}

function loadInlineMediaPositionSettings() {
    try {
        const raw = window.localStorage.getItem(INLINE_MEDIA_POSITION_SETTINGS_KEY);
        if (!raw) return { ...DEFAULT_INLINE_MEDIA_POSITION_SETTINGS };
        return normalizeInlineMediaPositionSettings(JSON.parse(raw));
    } catch {
        return { ...DEFAULT_INLINE_MEDIA_POSITION_SETTINGS };
    }
}

function applyInlineMediaPositionSettings(settings = {}) {
    const normalized = normalizeInlineMediaPositionSettings(settings);
    const root = document.documentElement;
    const body = document.body;
    root.style.setProperty('--inline-media-left-offset', `${normalized.leftOffset}ch`);
    body?.setAttribute('data-inline-media-position', normalized.position);
    return normalized;
}

function saveInlineMediaPositionSettings(settings = {}) {
    const normalized = applyInlineMediaPositionSettings(settings);
    window.localStorage.setItem(INLINE_MEDIA_POSITION_SETTINGS_KEY, JSON.stringify(normalized));
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
    const layout = loadLayoutSettings();
    const inlineMediaPosition = loadInlineMediaPositionSettings();
    const featureVisibility = loadFeatureVisibilitySettings();

    document.getElementById('settings-theme').value = theme;
    document.getElementById('settings-ui-font').value = typography.uiFont;
    document.getElementById('settings-editor-font').value = typography.editorFont;
    document.getElementById('settings-ui-font-size').value = typography.uiFontSize;
    document.getElementById('settings-editor-font-size').value = typography.editorFontSize;
    document.getElementById('settings-editor-line-height').value = typography.editorLineHeight;
    document.getElementById('settings-editor-paragraph-spacing').value = typography.editorParagraphSpacing;
    document.getElementById('settings-sidebar-width').value = layout.sidebarWidth;
    document.getElementById('settings-editor-width').value = layout.editorWidth;
    document.getElementById('settings-inline-media-position').value = inlineMediaPosition.position;
    document.getElementById('settings-inline-media-left-offset').value = inlineMediaPosition.leftOffset;
    syncInlineMediaPositionControls();
    document.getElementById('settings-feature-timeline').checked = featureVisibility.timeline;
    document.getElementById('settings-feature-pomodoro').checked = featureVisibility.pomodoro;

    setSettingsTab(currentSettingsTab);
    modal.classList.add('show');
}

function closeSettingsModal() {
    document.getElementById('settings-modal').classList.remove('show');
}

function hideTextInputModal() {
    const modal = document.getElementById('text-input-modal');
    if (!modal) return;

    modal.classList.remove('show');
    modal.setAttribute('aria-hidden', 'true');
}

function openTextInputModal(options = {}) {
    const {
        title = '输入',
        message = '',
        defaultValue = '',
        placeholder = '',
        confirmText = '确定',
        cancelText = '取消',
        allowEmpty = true
    } = options;

    const modal = document.getElementById('text-input-modal');
    const titleNode = document.getElementById('text-input-title');
    const messageNode = document.getElementById('text-input-message');
    const input = document.getElementById('text-input-field');
    const cancelButton = document.getElementById('text-input-cancel');
    const confirmButton = document.getElementById('text-input-confirm');

    if (!modal || !titleNode || !messageNode || !input || !cancelButton || !confirmButton) {
        return Promise.resolve(null);
    }

    if (textInputModalState?.cleanup) {
        try {
            textInputModalState.cleanup();
        } catch {
            // ignore cleanup failures
        }
    }
    if (textInputModalState?.resolve) {
        textInputModalState.resolve(null);
    }

    return new Promise((resolve) => {
        const state = {
            resolve,
            cleanup: () => {}
        };
        textInputModalState = state;

        titleNode.textContent = title;
        messageNode.textContent = message;
        input.value = String(defaultValue ?? '');
        input.placeholder = placeholder;
        cancelButton.textContent = cancelText;
        confirmButton.textContent = confirmText;
        modal.classList.add('show');
        modal.setAttribute('aria-hidden', 'false');

        const finish = (value) => {
            if (textInputModalState !== state) {
                return;
            }
            textInputModalState = null;
            hideTextInputModal();
            state.cleanup();
            resolve(value);
        };

        const confirmValue = () => {
            const nextValue = String(input.value ?? '');
            if (!allowEmpty && !nextValue.trim()) {
                alert('名称不能为空。');
                input.focus();
                input.select();
                return;
            }
            finish(nextValue);
        };

        const cancelValue = () => {
            finish(null);
        };

        const onInputKeydown = (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                confirmValue();
            } else if (event.key === 'Escape') {
                event.preventDefault();
                cancelValue();
            }
        };

        const onBackdropClick = (event) => {
            if (event.target === modal) {
                cancelValue();
            }
        };

        const cleanup = () => {
            input.removeEventListener('keydown', onInputKeydown);
            confirmButton.removeEventListener('click', confirmValue);
            cancelButton.removeEventListener('click', cancelValue);
            modal.removeEventListener('click', onBackdropClick);
        };
        state.cleanup = cleanup;

        input.addEventListener('keydown', onInputKeydown);
        confirmButton.addEventListener('click', confirmValue);
        cancelButton.addEventListener('click', cancelValue);
        modal.addEventListener('click', onBackdropClick);

        window.requestAnimationFrame(() => {
            input.focus();
            input.select();
        });
    });
}

function setSettingsTab(tab) {
    const nextTab = ['theme', 'font', 'media', 'feature'].includes(tab) ? tab : 'theme';
    currentSettingsTab = nextTab;

    for (const button of document.querySelectorAll('.settings-tab')) {
        button.classList.toggle('active', button.dataset.tab === nextTab);
    }

    for (const panel of document.querySelectorAll('.settings-panel')) {
        panel.classList.toggle('active', panel.id === `settings-panel-${nextTab}`);
    }
}

function syncInlineMediaPositionControls() {
    const positionSelect = document.getElementById('settings-inline-media-position');
    const leftOffsetInput = document.getElementById('settings-inline-media-left-offset');
    if (!positionSelect || !leftOffsetInput) {
        return;
    }

    const isCustomOffset = positionSelect.value === 'offset';
    leftOffsetInput.disabled = !isCustomOffset;
}

function handleSaveSettings() {
    saveThemePreference(document.getElementById('settings-theme').value);
    saveTypographySettings({
        uiFont: document.getElementById('settings-ui-font').value,
        editorFont: document.getElementById('settings-editor-font').value,
        uiFontSize: document.getElementById('settings-ui-font-size').value,
        editorFontSize: document.getElementById('settings-editor-font-size').value,
        editorLineHeight: document.getElementById('settings-editor-line-height').value,
        editorParagraphSpacing: document.getElementById('settings-editor-paragraph-spacing').value
    });
    saveLayoutSettings({
        ...loadLayoutSettings(),
        sidebarWidth: document.getElementById('settings-sidebar-width').value,
        editorWidth: document.getElementById('settings-editor-width').value
    });
    saveInlineMediaPositionSettings({
        position: document.getElementById('settings-inline-media-position').value,
        leftOffset: document.getElementById('settings-inline-media-left-offset').value
    });
    saveFeatureVisibilitySettings({
        timeline: document.getElementById('settings-feature-timeline').checked,
        pomodoro: document.getElementById('settings-feature-pomodoro').checked
    });
    closeSettingsModal();
}

function resetLayoutSettings() {
    saveThemePreference(DEFAULT_THEME_ID);
    saveTypographySettings(DEFAULT_TYPOGRAPHY_SETTINGS);
    saveLayoutSettings(DEFAULT_LAYOUT_SETTINGS);
    saveInlineMediaPositionSettings(DEFAULT_INLINE_MEDIA_POSITION_SETTINGS);
    saveFeatureVisibilitySettings(DEFAULT_FEATURE_VISIBILITY_SETTINGS);
    document.getElementById('settings-theme').value = DEFAULT_THEME_ID;
    document.getElementById('settings-ui-font').value = DEFAULT_TYPOGRAPHY_SETTINGS.uiFont;
    document.getElementById('settings-editor-font').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorFont;
    document.getElementById('settings-ui-font-size').value = DEFAULT_TYPOGRAPHY_SETTINGS.uiFontSize;
    document.getElementById('settings-editor-font-size').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorFontSize;
    document.getElementById('settings-editor-line-height').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorLineHeight;
    document.getElementById('settings-editor-paragraph-spacing').value = DEFAULT_TYPOGRAPHY_SETTINGS.editorParagraphSpacing;
    document.getElementById('settings-sidebar-width').value = DEFAULT_LAYOUT_SETTINGS.sidebarWidth;
    document.getElementById('settings-editor-width').value = DEFAULT_LAYOUT_SETTINGS.editorWidth;
    document.getElementById('settings-inline-media-position').value = DEFAULT_INLINE_MEDIA_POSITION_SETTINGS.position;
    document.getElementById('settings-inline-media-left-offset').value = DEFAULT_INLINE_MEDIA_POSITION_SETTINGS.leftOffset;
    syncInlineMediaPositionControls();
    document.getElementById('settings-feature-timeline').checked = DEFAULT_FEATURE_VISIBILITY_SETTINGS.timeline;
    document.getElementById('settings-feature-pomodoro').checked = DEFAULT_FEATURE_VISIBILITY_SETTINGS.pomodoro;
}

function initializeEditor() {
    if (window.editor) {
        return;
    }

    setupWindowDragAndDrop();
    if (!RICH_TEXT_EDITOR_ONLY) {
        setupPreviewScrollSync();
    }
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
    if (typeof window.editor.setTaskInteractionHandlers === 'function') {
        window.editor.setTaskInteractionHandlers({
            onCheckedChange: (node, checked, context = {}) => {
                const bundlePath = window.currentPath || getActiveTab()?.path || null;
                if (!bundlePath) return;

                const taskText = stripTodoCompletionTimestamp(String(node?.textContent || '').trim());
                upsertTodoCompletedTimelineEvent({
                    bundlePath,
                    text: taskText,
                    lineNumber: Number.isInteger(context.lineNumber) ? context.lineNumber : null
                }, { checked });
            }
        });
    }
    window.editor.onDidChangeModelContent(() => {
        handleEditorContentChanged();
        scheduleToolbarStateRefresh();
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
            if (!shouldApplyPendingAttachmentDeleteSnapshot()) {
                clearPendingAttachmentDeleteSnapshot();
            } else {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                applyPendingAttachmentDeleteSnapshot();
                return;
            }
        }

        if (event.defaultPrevented) return;
        if (!isEventInsideEditorRoot(event, root)) return;

        if (event.key === 'Backspace') {
            if (
                editorInstance.deleteCurrentEmptyParagraphNearImage?.()
                || editorInstance.preventImageBackspaceFromTrailingEmptyLine?.()
            ) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }
        }

        if (!isPrimaryModifier) return;

        if (!event.shiftKey && !event.altKey && key === 'x') {
            const cutPayload = buildEditorClipboardSlicePayload(editorInstance, 'cut');
            const parsedCutPayload = parseEditorClipboardSlicePayload(cutPayload);
            if (parsedCutPayload) {
                backupClipboardAttachmentEntriesToRecovery(parsedCutPayload);
                preserveClipboardAttachmentEntries(parsedCutPayload);
            }
        }

        if (!event.altKey && key === 'z' && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (restorePendingAttachmentDeleteSnapshotForCancel()) {
                return;
            }
            if (applyPendingAttachmentRenameUndo()) {
                return;
            }
            void undoActiveTabState();
            return;
        }

        if (!event.altKey && ((key === 'z' && event.shiftKey) || key === 'y')) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            void redoActiveTabState();
            return;
        }

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
    };

    root.addEventListener('beforeinput', () => {
        capturePendingSelectionSnapshot();
    }, true);
    root.addEventListener('keydown', (event) => {
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.isComposing) return;

        const key = String(event.key || '');
        if (key.length === 1 || key === 'Backspace' || key === 'Delete' || key === 'Enter' || key === 'Tab' || key === ' ') {
            capturePendingSelectionSnapshot();
        }
    }, true);
    root.addEventListener('keydown', handleEditorShortcut, true);
    document.addEventListener('keydown', handleEditorShortcut, true);
    root.addEventListener('keyup', scheduleToolbarRefresh, true);
    root.addEventListener('mouseup', scheduleToolbarRefresh, true);
    root.addEventListener('focusin', scheduleToolbarRefresh, true);
    root.addEventListener('click', scheduleToolbarRefresh, true);

    root.addEventListener('mousedown', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;

        const targetElement = getEventTargetElement(event.target);
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

    root.addEventListener('paste', async (event) => {
        capturePendingSelectionSnapshot();
        const internalSlicePayload = readEditorClipboardSlicePayload(event);
        if (internalSlicePayload) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        }
        const transformedInternalSlice = internalSlicePayload
            ? await transformClipboardSlicePayloadForCurrentBundle(internalSlicePayload)
            : null;
        if (transformedInternalSlice && window.editor && typeof window.editor.insertSliceJson === 'function') {
            const didInsertSlice = window.editor.insertSliceJson(transformedInternalSlice);
            if (didInsertSlice) {
                window.requestAnimationFrame(() => {
                    if (!window.editor) return;
                    if (typeof window.editor.normalizeAttachmentNodes === 'function') {
                        window.editor.normalizeAttachmentNodes();
                    }
                    if (typeof window.editor.refreshLinkDomState === 'function') {
                        window.editor.refreshLinkDomState(true);
                    }
                    if (typeof window.editor.refreshAttachmentNodeLabels === 'function') {
                        window.editor.refreshAttachmentNodeLabels(true);
                    }
                });
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }

            if (typeof window.editor.insertHtml === 'function') {
                const htmlFallback = serializeEditorSliceJsonToHtml(window.editor, transformedInternalSlice);
                if (htmlFallback) {
                    const didInsertHtml = window.editor.insertHtml(htmlFallback);
                    if (didInsertHtml) {
                        window.requestAnimationFrame(() => {
                            if (!window.editor) return;
                            if (typeof window.editor.normalizeAttachmentNodes === 'function') {
                                window.editor.normalizeAttachmentNodes();
                            }
                            if (typeof window.editor.refreshLinkDomState === 'function') {
                                window.editor.refreshLinkDomState(true);
                            }
                            if (typeof window.editor.refreshAttachmentNodeLabels === 'function') {
                                window.editor.refreshAttachmentNodeLabels(true);
                            }
                        });
                        event.preventDefault();
                        event.stopPropagation();
                        event.stopImmediatePropagation?.();
                        return;
                    }
                }
            }
        }

        const clipboardPathEntries = getClipboardPathEntries(event);
        const pastedAbsolutePath = clipboardPathEntries.length ? '' : getPastedAbsolutePath(event);
        const html = event.clipboardData?.getData('text/html') || '';
        const markdownClipboardText = String(
            event.clipboardData?.getData('text/markdown')
            || event.clipboardData?.getData('text/plain')
            || ''
        );
        const looksLikeMarkdownClipboard = (() => {
            const normalized = normalizeMarkdown(markdownClipboardText || '').replace(/\u00a0/g, ' ').trim();
            if (!normalized) return false;
            return /(^|\n)\s{0,3}#{1,6}\s+\S/.test(normalized)
                || /(^|\n)\s*>\s+\S/.test(normalized)
                || /(^|\n)\s*[-*+]\s+\S/.test(normalized)
                || /(^|\n)\s*\d+\.\s+\S/.test(normalized)
                || /(^|\n)\s*[-*]\s+\[[ xX]\]\s*\S?/.test(normalized)
                || /(^|\n)\s*```/.test(normalized)
                || /!\[[^\]]*]\([^)]+\)/.test(normalized)
                || /\[[^\]]+]\([^)]+\)/.test(normalized)
                || /(^|\n)\s*---+\s*($|\n)/.test(normalized)
                || /(^|[^*])\*\*[^*\n]+\*\*/.test(normalized)
                || /(^|[^_])__[^_\n]+__/.test(normalized)
                || /~~[^~\n]+~~/.test(normalized)
                || /`[^`\n]+`/.test(normalized);
        })();
        const transformedBundleHtml = html ? await transformPastedHtmlForCurrentBundle(html) : '';
        if (pastedAbsolutePath) {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            insertAbsolutePathLink(pastedAbsolutePath);
            return;
        }

        if (looksLikeMarkdownClipboard) {
            const markdownInsertText = markdownClipboardText || markdownClipboardText.trim();
            if (window.editor && typeof window.editor.insertMarkdown === 'function') {
                const didInsertMarkdown = window.editor.insertMarkdown(markdownInsertText);
                if (didInsertMarkdown) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation?.();
                    return;
                }
            }
            if (window.editor && typeof window.editor.insertText === 'function') {
                const didInsertText = window.editor.insertText(markdownInsertText);
                if (didInsertText !== false) {
                    event.preventDefault();
                    event.stopPropagation();
                    event.stopImmediatePropagation?.();
                    return;
                }
            }
            return;
        }

        if (transformedBundleHtml && window.editor && typeof window.editor.insertHtml === 'function') {
            const didInsertHtml = window.editor.insertHtml(transformedBundleHtml);
            if (didInsertHtml) {
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                return;
            }
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
        void handleClipboardPaste(event);
    }, true);

    root.addEventListener('beforeinput', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;
        if (String(event.inputType || '') !== 'deleteByCut') return;
        backupSelectedAttachmentEntriesForEditor(editorInstance);
    }, true);

    root.addEventListener('copy', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;

        const slicePayload = buildEditorClipboardSlicePayload(editorInstance, 'copy');
        const html = buildEditorClipboardHtml(editorInstance);
        if ((!html && !slicePayload) || !event.clipboardData) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();

        if (slicePayload) {
            event.clipboardData.clearData?.();
            event.clipboardData.setData(KANGAROO_INTERNAL_SLICE_MIME, slicePayload);
        }
        if (html) {
            event.clipboardData.setData('text/html', html);
        }
        const markdownText = buildEditorClipboardPlainText(editorInstance);
        if (markdownText) {
            event.clipboardData.setData('text/plain', markdownText);
            event.clipboardData.setData('text/markdown', markdownText);
        }
        if (slicePayload) {
            try {
                clipboard.writeBuffer(KANGAROO_INTERNAL_SLICE_MIME, Buffer.from(slicePayload, 'utf-8'));
            } catch {
                // ignore clipboard write failures
            }
        }
        rememberEditorClipboardSlicePayload(slicePayload);
    }, true);

    root.addEventListener('cut', (event) => {
        if (!isEventInsideEditorRoot(event, root)) return;
        if (!event.clipboardData) return;

        backupSelectedAttachmentEntriesForEditor(editorInstance);

        const slicePayload = buildEditorClipboardSlicePayload(editorInstance, 'cut');
        const html = buildEditorClipboardHtml(editorInstance);
        if ((!html && !slicePayload)) return;

        event.clipboardData.clearData?.();
        if (slicePayload) {
            event.clipboardData.setData(KANGAROO_INTERNAL_SLICE_MIME, slicePayload);
        }
        if (html) {
            event.clipboardData.setData('text/html', html);
        }
        const markdownText = buildEditorClipboardPlainText(editorInstance);
        if (markdownText) {
            event.clipboardData.setData('text/plain', markdownText);
            event.clipboardData.setData('text/markdown', markdownText);
        }
        const parsedSlicePayload = parseEditorClipboardSlicePayload(slicePayload);
        if (parsedSlicePayload) {
            backupClipboardAttachmentEntriesToRecovery(parsedSlicePayload);
            preserveClipboardAttachmentEntries(parsedSlicePayload);
        }
        if (slicePayload) {
            try {
                clipboard.writeBuffer(KANGAROO_INTERNAL_SLICE_MIME, Buffer.from(slicePayload, 'utf-8'));
            } catch {
                // ignore clipboard write failures
            }
        }
        rememberEditorClipboardSlicePayload(slicePayload);
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
        editorInstance.selectAttachment?.(attachmentInfo, {
            preserveScroll: true
        });
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
            void handleClipboardPaste();
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

        const draggedNode = getPendingEditorNodeDrag();
        const droppedFilePath = getDroppedFilePath(Array.from(e.dataTransfer?.files || [])[0] || null);
        if (
            draggedNode
            && droppedFilePath
            && draggedNode.documentPath
            && window.currentPath
            && path.resolve(draggedNode.documentPath) === path.resolve(window.currentPath)
            && path.resolve(droppedFilePath) === path.resolve(draggedNode.sourcePath || '')
            && isPointInsideElement(getEditorInteractiveElement(), e.clientX, e.clientY)
        ) {
            const targetPos = pendingDropLocation?.pos;
            const sourcePos = Number(draggedNode.pos);
            const didMove = window.editor && typeof window.editor.moveNodeAtPosToPosition === 'function'
                && Number.isInteger(sourcePos)
                && Number.isInteger(targetPos)
                ? window.editor.moveNodeAtPosToPosition(sourcePos, targetPos, {
                    nodeJSON: draggedNode.nodeJSON
                })
                : false;

            clearPendingEditorNodeDrag();
            hideDragCaretIndicator();
            if (!didMove) {
                return;
            }
            return;
        }

        hideDragCaretIndicator();

        await runHistoryTransaction('拖拽导入', async () => {
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

                    await handleAttachmentPath(filePath, stat);
                } catch (error) {
                    errors.push(`${file.name || getDroppedFilePath(file) || '未知项目'}: ${error.message}`);
                    continue;
                }
            }

            if (errors.length) {
                alert(`拖拽导入失败：\n${errors.join('\n')}`);
            }
        });
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

function getPendingEditorNodeDrag() {
    return window.__kangarooPendingEditorNodeDrag || null;
}

function clearPendingEditorNodeDrag() {
    window.__kangarooPendingEditorNodeDrag = null;
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
        if (!isAllowedExternalHref(normalizedHref)) {
            return null;
        }

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

function normalizeAttachmentMarkdownHref(value) {
    return safeDecodeUri(String(value || '').trim())
        .replace(/\\/g, '/')
        .replace(/^\.?\//, '')
        .replace(/^\/+/, '');
}

function serializeMarkdownHrefForRename(value) {
    const normalized = String(value || '').trim();
    if (!normalized) return '';

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(normalized) || normalized.startsWith('#')) {
        return normalized;
    }

    return normalized
        .replace(/\\/g, '/')
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
}

function escapeMarkdownTitleForRename(value) {
    return String(value || '').replace(/(["\\])/g, '\\$1');
}

function parseAttachmentIdentityFromTitle(title) {
    const match = String(title || '').match(/\[kangaroo-attachment-id=([^\]]+)\]/i);
    return match?.[1]?.trim() || null;
}

function normalizeMarkdown(markdown) {
    return String(markdown || '').replace(/\r\n/g, '\n');
}

function rewriteAttachmentReferencesAfterRenameInMarkdown(markdown, oldAbsolutePath, newAbsolutePath, bundlePath = window.currentPath) {
    const normalizedBundlePath = bundlePath ? path.resolve(bundlePath) : '';
    const previousAbsolutePath = path.resolve(String(oldAbsolutePath || ''));
    const nextAbsolutePath = path.resolve(String(newAbsolutePath || ''));

    if (!normalizedBundlePath || !previousAbsolutePath || !nextAbsolutePath) {
        return normalizeMarkdown(markdown || '');
    }

    let isDirectoryRename = false;
    try {
        isDirectoryRename = fs.existsSync(previousAbsolutePath) && fs.statSync(previousAbsolutePath).isDirectory();
    } catch {
        isDirectoryRename = false;
    }

    const oldRelativeHref = normalizeAttachmentMarkdownHref(path.relative(normalizedBundlePath, previousAbsolutePath));
    const nextRelativeHref = normalizeAttachmentMarkdownHref(path.relative(normalizedBundlePath, nextAbsolutePath));
    if (!oldRelativeHref || !nextRelativeHref) {
        return normalizeMarkdown(markdown || '');
    }

    const normalizedOldPrefix = oldRelativeHref.replace(/\/+$/, '');
    const oldRelativePrefix = `${normalizedOldPrefix}/`;
    const previousIdentity = getAttachmentIdentityFromPath(previousAbsolutePath);
    const nextIdentity = getAttachmentIdentityFromPath(nextAbsolutePath) || previousIdentity;
    const resolveAnyLocalPath = (href) => {
        const normalizedHref = safeDecodeUri(String(href || '').trim()).replace(/\\/g, '/');
        if (!normalizedHref || normalizedHref.startsWith('#')) {
            return '';
        }

        if (/^file:/i.test(normalizedHref)) {
            try {
                return path.resolve(url.fileURLToPath(normalizedHref));
            } catch {
                return '';
            }
        }

        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(normalizedHref)) {
            return '';
        }

        if (normalizedHref.startsWith('~/')) {
            return path.resolve(os.homedir(), normalizedHref.slice(2));
        }

        if (path.isAbsolute(normalizedHref)) {
            return path.resolve(normalizedHref);
        }

        return path.resolve(normalizedBundlePath, normalizedHref);
    };
    const attachmentRegex = /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?(attachments\/(?:<[^>]+>|[^)\s]+))(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;

    const nextMarkdown = String(markdown || '').replace(attachmentRegex, (fullMatch, rawLabel, rawHref, rawTitle = '') => {
        const normalizedHref = normalizeAttachmentMarkdownHref(String(rawHref || '').replace(/^<|>$/g, ''));
        if (!normalizedHref.startsWith('attachments/')) {
            return fullMatch;
        }

        const resolvedAbsolutePath = path.resolve(normalizedBundlePath, normalizedHref);
        const identityHint = String(rawTitle || '').match(/\[kangaroo-attachment-id=([^\]]+)\]/i)?.[1]?.trim() || '';
        const effectiveIdentity = identityHint || (resolvedAbsolutePath ? getAttachmentIdentityFromPath(resolvedAbsolutePath) : '');

        const matchesAttachment = isDirectoryRename
            ? normalizedHref === normalizedOldPrefix
                || normalizedHref.startsWith(oldRelativePrefix)
                || resolvedAbsolutePath === previousAbsolutePath
                || (Boolean(previousIdentity) && effectiveIdentity === previousIdentity)
            : normalizedHref === oldRelativeHref
                || resolvedAbsolutePath === previousAbsolutePath
                || (Boolean(previousIdentity) && effectiveIdentity === previousIdentity);

        if (!matchesAttachment) {
            return fullMatch;
        }

        let nextHref = nextRelativeHref;
        if (isDirectoryRename && normalizedHref.startsWith(normalizedOldPrefix)) {
            nextHref = `${nextRelativeHref}${normalizedHref.slice(normalizedOldPrefix.length)}`;
        }

        const nextLabel = safeDecodeUri(path.basename(nextHref)) || path.basename(nextHref) || rawLabel;
        const nextTitle = String(rawTitle || '').trim();
        const titleSuffix = nextTitle ? ` "${escapeMarkdownTitleForRename(nextTitle)}"` : '';
        return `[${escapeMarkdownLinkLabel(nextLabel)}](${serializeMarkdownHrefForRename(nextHref)}${titleSuffix})`;
    });

    const genericLinkRegex = /\[((?:\\.|[^\]])*)\]\((<[^>]+>|[^)\s]+)(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;
    const nextMarkdownWithAbsolutePaths = nextMarkdown.replace(genericLinkRegex, (fullMatch, rawLabel, rawHref, rawTitle = '') => {
        const normalizedHref = safeDecodeUri(String(rawHref || '').trim()).replace(/\\/g, '/');
        const resolvedAbsolutePath = resolveAnyLocalPath(normalizedHref);
        if (!resolvedAbsolutePath) {
            return fullMatch;
        }

        const isMatch = isDirectoryRename
            ? resolvedAbsolutePath === previousAbsolutePath
                || !path.relative(previousAbsolutePath, resolvedAbsolutePath).startsWith('..')
            : resolvedAbsolutePath === previousAbsolutePath;
        if (!isMatch) {
            return fullMatch;
        }

        const nextLabel = safeDecodeUri(path.basename(nextRelativeHref)) || path.basename(nextRelativeHref) || rawLabel;
        const nextTitle = String(rawTitle || '').trim();
        const titleSuffix = nextTitle ? ` "${escapeMarkdownTitleForRename(nextTitle)}"` : '';
        return `[${escapeMarkdownLinkLabel(nextLabel)}](${serializeMarkdownHrefForRename(nextRelativeHref)}${titleSuffix})`;
    });

    const nextRelativeHrefSerialized = serializeMarkdownHrefForRename(nextRelativeHref);
    const nextAbsoluteHrefSerialized = serializeMarkdownHrefForRename(nextAbsolutePath);
    const nextAbsoluteFileUrl = (() => {
        try {
            return url.pathToFileURL(nextAbsolutePath).href;
        } catch {
            return '';
        }
    })();
    const replacementCandidates = [
        previousAbsolutePath,
        url.pathToFileURL(previousAbsolutePath).href,
        serializeMarkdownHrefForRename(previousAbsolutePath)
    ].filter(Boolean);

    let nextMarkdownWithDirectPaths = nextMarkdownWithAbsolutePaths;
    for (const candidate of replacementCandidates) {
        const replacements = [
            [candidate, nextRelativeHrefSerialized],
            [serializeMarkdownHrefForRename(candidate), nextRelativeHrefSerialized]
        ];
        for (const [from, to] of replacements) {
            if (!from || from === to) continue;
            nextMarkdownWithDirectPaths = nextMarkdownWithDirectPaths.split(from).join(to);
        }
    }
    if (nextAbsoluteFileUrl) {
        nextMarkdownWithDirectPaths = nextMarkdownWithDirectPaths.split(nextAbsoluteFileUrl).join(nextRelativeHrefSerialized);
    }
    if (nextAbsoluteHrefSerialized) {
        nextMarkdownWithDirectPaths = nextMarkdownWithDirectPaths.split(nextAbsoluteHrefSerialized).join(nextRelativeHrefSerialized);
    }

    return normalizeMarkdown(nextMarkdownWithDirectPaths);
}

function rewriteAttachmentReferencesAfterRenameInDocumentJson(documentJson, oldAbsolutePath, newAbsolutePath, bundlePath = window.currentPath) {
    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson) {
        return null;
    }

    const normalizedBundlePath = bundlePath ? path.resolve(String(bundlePath)) : '';
    const previousAbsolutePath = path.resolve(String(oldAbsolutePath || ''));
    const nextAbsolutePath = path.resolve(String(newAbsolutePath || ''));
    if (!normalizedBundlePath || !previousAbsolutePath || !nextAbsolutePath) {
        return nextDocumentJson;
    }

    let isDirectoryRename = false;
    try {
        isDirectoryRename = fs.existsSync(previousAbsolutePath) && fs.statSync(previousAbsolutePath).isDirectory();
    } catch {
        isDirectoryRename = false;
    }

    const oldRelativeHref = normalizeAttachmentMarkdownHref(path.relative(normalizedBundlePath, previousAbsolutePath));
    const nextRelativeHref = normalizeAttachmentMarkdownHref(path.relative(normalizedBundlePath, nextAbsolutePath));
    if (!oldRelativeHref || !nextRelativeHref) {
        return nextDocumentJson;
    }

    const normalizedOldPrefix = oldRelativeHref.replace(/\/+$/, '');
    const oldRelativePrefix = `${normalizedOldPrefix}/`;
    const previousIdentity = getAttachmentIdentityFromPath(previousAbsolutePath);
    const nextIdentity = getAttachmentIdentityFromPath(nextAbsolutePath) || previousIdentity;

    const resolveAnyLocalPath = (href) => {
        const normalizedHref = safeDecodeUri(String(href || '').trim()).replace(/\\/g, '/');
        if (!normalizedHref || normalizedHref.startsWith('#')) {
            return '';
        }

        if (/^file:/i.test(normalizedHref)) {
            try {
                return path.resolve(url.fileURLToPath(normalizedHref));
            } catch {
                return '';
            }
        }

        if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(normalizedHref)) {
            return '';
        }

        if (normalizedHref.startsWith('~/')) {
            return path.resolve(os.homedir(), normalizedHref.slice(2));
        }

        if (path.isAbsolute(normalizedHref)) {
            return path.resolve(normalizedHref);
        }

        return path.resolve(normalizedBundlePath, normalizedHref);
    };

    const shouldMatchAttachmentRef = (href, title = null, identityAttr = null) => {
        const normalizedHref = normalizeAttachmentMarkdownHref(String(href || '').replace(/^<|>$/g, ''));
        const resolvedAbsolutePath = resolveAnyLocalPath(normalizedHref);
        const effectiveIdentity = identityAttr
            || parseAttachmentIdentityFromTitle(title)
            || (resolvedAbsolutePath ? getAttachmentIdentityFromPath(resolvedAbsolutePath) : null);
        const isAttachmentHref = normalizedHref.startsWith('attachments/');

        if (isDirectoryRename) {
            return (isAttachmentHref && (
                normalizedHref === normalizedOldPrefix
                || normalizedHref.startsWith(oldRelativePrefix)
            )) || (resolvedAbsolutePath && (
                resolvedAbsolutePath === previousAbsolutePath
                || !path.relative(previousAbsolutePath, resolvedAbsolutePath).startsWith('..')
            )) || (Boolean(previousIdentity) && effectiveIdentity === previousIdentity);
        }

        return (isAttachmentHref && normalizedHref === oldRelativeHref)
            || (resolvedAbsolutePath && resolvedAbsolutePath === previousAbsolutePath)
            || (Boolean(previousIdentity) && effectiveIdentity === previousIdentity);
    };

    const rewriteHref = (href) => {
        const normalizedHref = normalizeAttachmentMarkdownHref(String(href || '').replace(/^<|>$/g, ''));
        if (!normalizedHref) {
            return { href: String(href || ''), changed: false };
        }

        const resolvedAbsolutePath = resolveAnyLocalPath(normalizedHref);
        const isMatch = shouldMatchAttachmentRef(normalizedHref, null, null) || shouldMatchAttachmentRef(href, null, null);
        if (!isMatch) {
            return { href, changed: false };
        }

        let nextHref = nextRelativeHref;
        if (isDirectoryRename && normalizedHref.startsWith(normalizedOldPrefix)) {
            nextHref = `${nextRelativeHref}${normalizedHref.slice(normalizedOldPrefix.length)}`;
        } else if (isDirectoryRename && resolvedAbsolutePath) {
            const relativeWithinPrevious = path.relative(previousAbsolutePath, resolvedAbsolutePath).replace(/\\/g, '/');
            if (relativeWithinPrevious && !relativeWithinPrevious.startsWith('..') && !path.isAbsolute(relativeWithinPrevious)) {
                nextHref = `${nextRelativeHref.replace(/\/+$/, '')}/${relativeWithinPrevious.replace(/^\/+/, '')}`;
            } else {
                nextHref = nextRelativeHref;
            }
        }

        if (!normalizedHref.startsWith('attachments/')) {
            nextHref = nextRelativeHref;
        }

        return {
            href: nextHref,
            changed: nextHref !== href
        };
    };

    const visit = (node) => {
        if (!node || typeof node !== 'object') {
            return node;
        }

        let didChange = false;
        const nextNode = Array.isArray(node) ? node.slice() : { ...node };

        if (Array.isArray(nextNode.marks) && typeof nextNode.text === 'string') {
            let nextText = nextNode.text;
            const nextMarks = nextNode.marks.map((mark) => {
                if (!mark || typeof mark !== 'object' || mark.type !== 'link') {
                    return mark;
                }

                const attrs = mark.attrs || {};
                if (!shouldMatchAttachmentRef(attrs.href || '', attrs.title || null, null)) {
                    return mark;
                }

                const nextLink = rewriteHref(attrs.href || '');
                const nextLabel = safeDecodeUri(path.basename(nextLink.href)) || path.basename(nextLink.href) || nextText;
                if (nextLabel && nextLabel !== nextText) {
                    nextText = nextLabel;
                    didChange = true;
                }

                if (!nextLink.changed && nextText === node.text) {
                    return mark;
                }

                didChange = true;
                return {
                    ...mark,
                    attrs: {
                        ...attrs,
                        href: nextLink.href
                    }
                };
            });

            if (didChange) {
                nextNode.text = nextText;
                nextNode.marks = nextMarks;
            }
        }

        if (nextNode.attrs && typeof nextNode.attrs === 'object') {
            const typeName = String(nextNode.type || '');
            if (['kangarooAttachment', 'kangarooVideo', 'kangarooPdf'].includes(typeName)) {
                if (shouldMatchAttachmentRef(nextNode.attrs.href || '', nextNode.attrs.title || null, nextNode.attrs.identity || null)) {
                    const nextLink = rewriteHref(nextNode.attrs.href || '');
                    const nextLabel = safeDecodeUri(path.basename(nextLink.href)) || path.basename(nextLink.href) || nextNode.attrs.label || '';
                    const nextAttrs = {
                        ...nextNode.attrs,
                        href: nextLink.href,
                        label: nextLabel,
                        identity: nextIdentity || nextNode.attrs.identity || null
                    };

                    if (nextAttrs.href !== nextNode.attrs.href || nextAttrs.label !== nextNode.attrs.label || nextAttrs.identity !== nextNode.attrs.identity) {
                        nextNode.attrs = nextAttrs;
                        didChange = true;
                    }
                }
            }
        }

        if (Array.isArray(nextNode.content)) {
            const nextContent = nextNode.content.map((child) => {
                const nextChild = visit(child);
                if (nextChild !== child) {
                    didChange = true;
                }
                return nextChild;
            });

            if (didChange) {
                nextNode.content = nextContent;
            }
        }

        return didChange ? nextNode : node;
    };

    return visit(nextDocumentJson);
}

function isAttachmentRenameInsideBundle(bundlePath, sourcePath, targetPath = sourcePath) {
    if (!bundlePath || !sourcePath || !targetPath) return false;
    const normalizedBundlePath = path.resolve(bundlePath);
    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const normalizedSource = path.resolve(sourcePath);
    const normalizedTarget = path.resolve(targetPath);
    const sourceRelative = path.relative(attachmentsDir, normalizedSource);
    const targetRelative = path.relative(attachmentsDir, normalizedTarget);
    const isInside = (relativePath) => relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
    return isInside(sourceRelative) || isInside(targetRelative);
}

function syncOpenTabsAfterAttachmentRename(oldAbsolutePath, newAbsolutePath, activeMarkdown = null) {
    let didChange = false;

    for (const tab of editorTabs) {
        if (!tab?.path || !isAttachmentRenameInsideBundle(tab.path, oldAbsolutePath, newAbsolutePath)) {
            continue;
        }

        const currentContent = typeof tab.content === 'string' ? tab.content : '';
        const currentDocumentJson = cloneSerializableValue(tab.documentJson);
        const nextDocumentJson = currentDocumentJson
            ? rewriteAttachmentReferencesAfterRenameInDocumentJson(currentDocumentJson, oldAbsolutePath, newAbsolutePath, tab.path)
            : null;
        const nextContent = rewriteAttachmentReferencesAfterRenameInMarkdown(currentContent, oldAbsolutePath, newAbsolutePath, tab.path);
        const didUpdateDocumentJson = Boolean(
            nextDocumentJson
            && JSON.stringify(nextDocumentJson || null) !== JSON.stringify(currentDocumentJson || null)
        );
        const didUpdateContent = nextContent !== currentContent;

        if (!didUpdateDocumentJson && !didUpdateContent) {
            continue;
        }

        didChange = true;
        if (didUpdateDocumentJson) {
            tab.documentJson = nextDocumentJson;
        }
        if (didUpdateContent) {
            tab.content = nextContent;
        }
        tab.attachmentSnapshot = captureBundleAttachmentSnapshot(tab.path);
        tab.attachmentSnapshotRoot = tab.path ? path.resolve(tab.path) : null;
        if (tab.id === activeTabId) {
            tab.previousContent = tab.content;
            continue;
        }

        if (tab.isDirty) {
            tab.previousContent = tab.content;
        } else {
            resetTabHistory(tab, didUpdateContent ? nextContent : tab.content);
        }
    }

    if (didChange) {
        renderEditorTabs();
    }

    return didChange;
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

function normalizeImageResourceHrefForWrite(href) {
    const normalized = normalizePreviewImageSourceRef(href);
    if (!normalized) return '';
    const relativePath = normalizeImageResourceRelativePath(normalized);
    return relativePath ? `attachments/${IMAGE_RESOURCE_DIR_NAME}/${relativePath}` : normalized;
}

function normalizeImageResourceRelativePath(href) {
    const normalized = normalizePreviewImageSourceRef(href);
    if (!normalized) return '';

    const prefixes = [
        `attachments/${IMAGE_RESOURCE_DIR_NAME}/`,
        `${IMAGE_RESOURCE_DIR_NAME}/`,
        `${LEGACY_IMAGE_RESOURCE_DIR_NAME}/`,
        'attachments/'
    ];

    for (const prefix of prefixes) {
        if (normalized.startsWith(prefix)) {
            return normalized.slice(prefix.length).replace(/^\/+/, '');
        }
    }

    return normalized.replace(/^\/+/, '');
}

function resolveImageResourceSourceDir(bundlePath) {
    return resolveExistingImageResourceDir(bundlePath);
}

function normalizeMarkdownImageResourcePaths(markdown) {
    const source = String(markdown || '');
    if (!source) {
        return source;
    }

    return source
        .replace(/(!\[[^\]]*\]\()\s*(?:\.?\/)?(?:attachments\/images|images|assets|attachments)\//gi, `$1attachments/${IMAGE_RESOURCE_DIR_NAME}/`)
        .replace(/(<img\b[^>]*\bsrc\s*=\s*(?:"|')\s*(?:\.?\/)?(?:attachments\/images|images|assets|attachments)\/)/gi, (match) => match.replace(/(?:attachments\/images|images|assets|attachments)\//i, `attachments/${IMAGE_RESOURCE_DIR_NAME}/`));
}

function normalizeDocumentJsonImageResourcePaths(documentJson) {
    const root = cloneSerializableValue(documentJson);
    if (!root || typeof root !== 'object') {
        return root;
    }

    const visit = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node.type === 'image' && node.attrs && typeof node.attrs === 'object') {
            const nextSrc = normalizeImageResourceHrefForWrite(node.attrs.src || '');
            if (nextSrc && nextSrc !== node.attrs.src) {
                node.attrs = {
                    ...node.attrs,
                    src: nextSrc
                };
            }
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                visit(child);
            }
        }
    };

    visit(root);
    return root;
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
        const normalizedSrc = resolvedPath.replace(/^\.?\//, '');
        const baseDir = window.currentPath || process.cwd();
        const candidates = [path.resolve(baseDir, normalizedSrc)];
        if (normalizedSrc.startsWith(`attachments/${IMAGE_RESOURCE_DIR_NAME}/`)) {
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^attachments\/images\//, 'images/')));
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^attachments\/images\//, 'assets/')));
        } else if (normalizedSrc.startsWith(IMAGE_RESOURCE_DIR_NAME + '/')) {
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^images\//, 'attachments/images/')));
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^images\//, 'assets/')));
        } else if (normalizedSrc.startsWith(LEGACY_IMAGE_RESOURCE_DIR_NAME + '/')) {
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^assets\//, 'attachments/images/')));
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^assets\//, 'images/')));
        } else if (normalizedSrc.startsWith('attachments/')) {
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^attachments\//, 'attachments/images/')));
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^attachments\//, 'images/')));
            candidates.push(path.resolve(baseDir, normalizedSrc.replace(/^attachments\//, 'assets/')));
        }
        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
        resolvedPath = candidates[0];
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

    const lines = raw.split('\n');

    return lines.map((line, index) => {
        const lineNumber = index + 1;
        let nextLine = line.replace(
            /!\[(.*?)\]\((?:\.?\/)?(attachments\/images|images|assets|attachments)\/(.+?)\)/g,
            (_, alt, resourceDir, file) => {
                const relativeFile = safeDecodeUri(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
                const primaryPath = path.join(window.currentPath, resourceDir, relativeFile);
                const fallbackDirs = resourceDir === 'attachments'
                    ? [path.join('attachments', IMAGE_RESOURCE_DIR_NAME), IMAGE_RESOURCE_DIR_NAME, LEGACY_IMAGE_RESOURCE_DIR_NAME]
                    : (resourceDir === path.join('attachments', IMAGE_RESOURCE_DIR_NAME)
                        ? [IMAGE_RESOURCE_DIR_NAME, LEGACY_IMAGE_RESOURCE_DIR_NAME]
                        : (resourceDir === IMAGE_RESOURCE_DIR_NAME
                            ? [path.join('attachments', IMAGE_RESOURCE_DIR_NAME), LEGACY_IMAGE_RESOURCE_DIR_NAME]
                            : [path.join('attachments', IMAGE_RESOURCE_DIR_NAME), IMAGE_RESOURCE_DIR_NAME]));
                const fallbackPath = fallbackDirs
                    .map((dirName) => path.join(window.currentPath, dirName, relativeFile))
                    .find((candidate) => fs.existsSync(candidate)) || '';
                const absolutePath = fs.existsSync(primaryPath)
                    ? primaryPath
                    : fallbackPath;
                if (!absolutePath) {
                    return _;
                }

                return buildPreviewImageHtml({
                    alt,
                    absolutePath,
                    sourceRef: `${resourceDir}/${relativeFile}`,
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

function normalizeHttpImageUrlLike(value) {
    const normalized = String(value || '').trim();
    const webUrlMatch = normalized.match(/^(https?:)\/(?!\/)(.*)$/i);
    if (webUrlMatch) {
        return `${webUrlMatch[1]}//${webUrlMatch[2]}`;
    }
    return normalized;
}

async function handleClipboardPaste(event = null) {
    return runHistoryTransaction('粘贴', async () => {
        const clipboardPaths = getClipboardPathEntries(event);
        if (clipboardPaths.length) {
            for (const filePath of clipboardPaths) {
                const stat = fs.statSync(filePath);
                if (stat.isFile() && isImageFilePath(filePath)) {
                    handleImageBuffer(fs.readFileSync(filePath));
                    continue;
                }

                await handleAttachmentPath(filePath, stat);
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
    });
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

    const { markdown, documentJson } = getActiveEditorSnapshot();

    try {
        suppressWorkspaceWatcherUntil = Math.max(suppressWorkspaceWatcherUntil, Date.now() + 1500);
        if (!silent) {
            const migratedPath = migrateBundleToKangarooFormat(window.currentPath, markdown);
            if (migratedPath && migratedPath !== window.currentPath) {
                window.currentPath = migratedPath;
            }
        }
        const restoredEntries = restoreRecoveredEntries(markdown, documentJson);
        const canContinueSave = await cleanupUnusedResourcesForTab({
            path: window.currentPath,
            content: markdown,
            documentJson,
            preservedEntries: Array.from(preservedUnusedAttachmentEntries)
        });
        if (!canContinueSave) {
            return false;
        }

        const savedPackage = writeBundlePackageToPath(window.currentPath, markdown, documentJson, window.currentPath);

        setDirty(false);
        const activeTab = getActiveTab();
        if (activeTab) {
            activeTab.path = window.currentPath;
            activeTab.content = markdown;
            activeTab.documentJson = savedPackage.documentJson || documentJson;
            activeTab.manifest = savedPackage.manifest || activeTab.manifest;
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
        scheduleTimelinePanelRender();
        refreshHistoryPanelIfVisible(window.currentPath);
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

    const normalizedBundlePath = path.resolve(window.currentPath);
    const normalizedTargetDir = path.resolve(targetDir);
    const relativeTargetDir = path.relative(normalizedBundlePath, normalizedTargetDir).replace(/\\/g, '/');

    for (const recoveryRoot of getRecoveryRootCandidates(window.currentPath)) {
        if (relativeTargetDir && !relativeTargetDir.startsWith('..') && !path.isAbsolute(relativeTargetDir)) {
            const relativeRecoveryPath = path.join(recoveryRoot, relativeTargetDir, entryName);
            if (fs.existsSync(relativeRecoveryPath)) {
                return true;
            }
        }

        const legacyRecoveryPath = path.join(recoveryRoot, kind, entryName);
        if (fs.existsSync(legacyRecoveryPath)) {
            return true;
        }
    }

    return false;
}

function getImageFileExtensionFromMimeType(mimeType) {
    const normalized = String(mimeType || '').trim().toLowerCase();
    const map = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/webp': '.webp',
        'image/bmp': '.bmp',
        'image/svg+xml': '.svg',
        'image/x-icon': '.ico',
        'image/vnd.microsoft.icon': '.ico',
        'image/tiff': '.tiff',
        'image/heic': '.heic',
        'image/heif': '.heif'
    };

    return map[normalized] || '.png';
}

function generateFileName(imagesDir, options = {}) {
    const prefix = String(options.prefix || 'image').trim() || 'image';
    const extension = String(options.extension || '.png').trim() || '.png';
    const compactTimestamp = new Date().toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z')
        .replace('T', '-');
    const sessionNonce = crypto.randomUUID().replace(/-/g, '').slice(0, 12);

    let suffix = 0;
    while (true) {
        const nextSuffix = suffix ? `-${String(suffix).padStart(2, '0')}` : '';
        const candidate = `${prefix}-${compactTimestamp}-${sessionNonce}${nextSuffix}${extension}`;
        if (!doesEntryNameExist(path.basename(imagesDir), imagesDir, candidate)) {
            return candidate;
        }
        suffix += 1;
    }
}

function ensureDirectory(dirPath) {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function getRecoveryRootCandidates(bundlePath = window.currentPath) {
    if (!bundlePath) return [];

    const normalizedBundlePath = path.resolve(bundlePath);
    return [
        path.join(normalizedBundlePath, SESSION_HISTORY_DIR_NAME),
        path.join(normalizedBundlePath, RECOVERY_DIR_NAME),
        ...LEGACY_RECOVERY_DIR_NAMES.map((legacyName) => path.join(normalizedBundlePath, legacyName))
    ];
}

function mergeDirectoryContents(sourceDir, targetDir) {
    if (!fs.existsSync(sourceDir)) {
        return;
    }

    ensureDirectory(targetDir);
    for (const entryName of fs.readdirSync(sourceDir)) {
        const sourcePath = path.join(sourceDir, entryName);
        const targetPath = path.join(targetDir, entryName);
        if (!fs.existsSync(targetPath)) {
            movePathRobustSync(sourcePath, targetPath);
            continue;
        }

        const sourceStat = fs.statSync(sourcePath);
        const targetStat = fs.statSync(targetPath);
        if (sourceStat.isDirectory() && targetStat.isDirectory()) {
            mergeDirectoryContents(sourcePath, targetPath);
            removeDirectoryIfExists(sourcePath);
        }
    }
}

function migrateLegacyRecoveryRoot(bundlePath = window.currentPath) {
    if (!bundlePath) return;

    const normalizedBundlePath = path.resolve(bundlePath);
    const preferredRoot = path.join(normalizedBundlePath, RECOVERY_DIR_NAME);

    for (const legacyName of LEGACY_RECOVERY_DIR_NAMES) {
        const legacyRoot = path.join(normalizedBundlePath, legacyName);
        if (!fs.existsSync(legacyRoot)) {
            continue;
        }

        if (!fs.existsSync(preferredRoot)) {
            try {
                fs.renameSync(legacyRoot, preferredRoot);
                continue;
            } catch {
                // fall through to merge below
            }
        }

        ensureDirectory(preferredRoot);
        mergeDirectoryContents(legacyRoot, preferredRoot);
        removeDirectoryIfExists(legacyRoot);
    }
}

function ensureRecoveryDir(kind) {
    migrateLegacyRecoveryRoot(window.currentPath);
    const recoveryRoot = getSessionHistoryRoot(window.currentPath);
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

function backupEntryToRecoveryForBundle(bundlePath, kind, entryName) {
    if (!bundlePath || !entryName) return false;

    const normalizedBundlePath = path.resolve(bundlePath);
    const sourceDir = path.join(normalizedBundlePath, kind);
    const sourcePath = path.join(sourceDir, entryName);
    if (!fs.existsSync(sourcePath)) return false;

    const recoveryDir = path.join(normalizedBundlePath, SESSION_HISTORY_DIR_NAME, kind);
    ensureDirectory(recoveryDir);
    const targetPath = path.join(recoveryDir, entryName);

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    copyPathRecursive(sourcePath, targetPath);
    return true;
}

function moveEntryToRecoveryForBundle(bundlePath, kind, entryName) {
    if (!bundlePath || !entryName) return false;

    const normalizedBundlePath = path.resolve(bundlePath);
    const sourceDir = path.join(normalizedBundlePath, kind);
    const sourcePath = path.join(sourceDir, entryName);
    if (!fs.existsSync(sourcePath)) return false;

    const recoveryDir = path.join(normalizedBundlePath, SESSION_HISTORY_DIR_NAME, kind);
    ensureDirectory(recoveryDir);
    const targetPath = path.join(recoveryDir, entryName);

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });

    const sourceStat = fs.statSync(sourcePath);
    movePathRobustSync(sourcePath, targetPath, sourceStat);
    return true;
}

function getBundleEntryBackupInfo(absolutePath, bundlePath = null) {
    const normalizedAbsolutePath = path.resolve(String(absolutePath || ''));
    const normalizedBundlePath = bundlePath
        ? path.resolve(String(bundlePath))
        : findContainingTextBundlePath(normalizedAbsolutePath);

    if (!normalizedAbsolutePath || !normalizedBundlePath) {
        return null;
    }

    const relativeInsideBundle = path.relative(normalizedBundlePath, normalizedAbsolutePath).replace(/\\/g, '/');
    if (!relativeInsideBundle || relativeInsideBundle.startsWith('..')) {
        return null;
    }

    const segments = relativeInsideBundle.split('/').filter(Boolean);
    if (segments.length < 2) {
        return null;
    }

    const kind = segments[0];
    if (kind !== 'attachments' && kind !== IMAGE_RESOURCE_DIR_NAME && kind !== LEGACY_IMAGE_RESOURCE_DIR_NAME) {
        return null;
    }

    const entryName = segments.slice(1).join('/');
    if (!entryName) {
        return null;
    }

    return {
        bundlePath: normalizedBundlePath,
        kind,
        entryName
    };
}

function restoreEntryFromRecovery(kind, entryName) {
    for (const recoveryRoot of getRecoveryRootCandidates(window.currentPath)) {
        const sourcePath = path.join(recoveryRoot, kind, entryName);
        if (!fs.existsSync(sourcePath)) {
            continue;
        }

        const targetDir = path.join(window.currentPath, kind);
        ensureDirectory(targetDir);
        const targetPath = path.join(targetDir, entryName);
        if (fs.existsSync(targetPath)) {
            return false;
        }

        removeDirectoryIfExists(targetPath);
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.renameSync(sourcePath, targetPath);
        return true;
    }

    return false;
}

function restoreRecoveredEntries(markdown, documentJson = null) {
    if (!window.currentPath) return false;
    const structuredDocument = documentJson || window.editor?.getDocumentJson?.() || null;
    const usedAttachmentEntries = structuredDocument
        ? getUsedAttachmentEntriesFromDocumentJson(structuredDocument)
        : getUsedAttachmentEntries(markdown, { preferEditorState: true });
    const usedImageEntries = structuredDocument
        ? getUsedImageEntriesFromDocumentJson(structuredDocument)
        : getUsedImageEntries(markdown);

    let restored = false;

    for (const entryName of usedImageEntries) {
        restored = restoreEntryFromRecovery('attachments', path.join(IMAGE_RESOURCE_DIR_NAME, entryName)) || restored;
        restored = restoreEntryFromRecovery(IMAGE_RESOURCE_DIR_NAME, entryName) || restored;
        restored = restoreEntryFromRecovery(LEGACY_IMAGE_RESOURCE_DIR_NAME, entryName) || restored;
    }

    for (const entryName of usedAttachmentEntries) {
        restored = restoreEntryFromRecovery('attachments', entryName) || restored;
    }

    return restored;
}

function backupClipboardAttachmentEntriesToRecovery(payload) {
    const sourceBundlePath = String(payload?.bundlePath || '').trim();
    if (!sourceBundlePath) {
        return false;
    }

    const imagePayloads = payload?.images && typeof payload.images === 'object'
        ? Object.values(payload.images)
        : [];
    const attachmentPayloads = payload?.attachments && typeof payload.attachments === 'object'
        ? Object.values(payload.attachments)
        : [];

    let didBackup = false;
    for (const imagePayload of imagePayloads) {
        const absolutePath = String(imagePayload || '').trim();
        if (!absolutePath) {
            continue;
        }

        const normalizedBundlePath = path.resolve(sourceBundlePath);
        const normalizedSourcePath = path.resolve(absolutePath);
        const attachmentImagesDir = getImageResourceDirPath(normalizedBundlePath);
        for (const imagesDir of [...getImageResourceDirCandidates(normalizedBundlePath), path.join(normalizedBundlePath, 'attachments')]) {
            if (!fs.existsSync(imagesDir)) {
                continue;
            }
            const relative = path.relative(imagesDir, normalizedSourcePath);
            if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
                continue;
            }

            const entryName = relative.replace(/\\/g, '/');
            if (path.resolve(imagesDir) === path.resolve(attachmentImagesDir)) {
                didBackup = moveEntryToRecoveryForBundle(
                    normalizedBundlePath,
                    'attachments',
                    path.join(IMAGE_RESOURCE_DIR_NAME, entryName)
                ) || didBackup;
            } else if (path.basename(imagesDir) === 'attachments') {
                didBackup = moveEntryToRecoveryForBundle(
                    normalizedBundlePath,
                    'attachments',
                    entryName
                ) || didBackup;
            } else {
                didBackup = moveEntryToRecoveryForBundle(
                    normalizedBundlePath,
                    path.basename(imagesDir),
                    entryName
                ) || didBackup;
            }
            break;
        }
    }

    for (const attachmentPayload of attachmentPayloads) {
        const absolutePath = String(
            typeof attachmentPayload === 'string'
                ? attachmentPayload
                : attachmentPayload?.absolutePath || ''
        ).trim();
        if (!absolutePath) {
            continue;
        }

        const normalizedBundlePath = path.resolve(sourceBundlePath);
        const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
        const normalizedSourcePath = path.resolve(absolutePath);
        const relative = path.relative(attachmentsDir, normalizedSourcePath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }

        const topLevelEntry = relative.split(path.sep)[0];
        if (!topLevelEntry) {
            continue;
        }

        didBackup = moveEntryToRecoveryForBundle(normalizedBundlePath, 'attachments', topLevelEntry) || didBackup;
    }

    return didBackup;
}

function resolveRecoveredClipboardSourcePath(sourceBundlePath, sourcePath) {
    const normalizedBundlePath = String(sourceBundlePath || '').trim();
    const normalizedSourcePath = String(sourcePath || '').trim();
    if (!normalizedBundlePath || !normalizedSourcePath) {
        return '';
    }

    const sourceBundleRoot = path.resolve(normalizedBundlePath);
    const attachmentsDir = path.join(sourceBundleRoot, 'attachments');
    const absoluteSourcePath = path.isAbsolute(normalizedSourcePath)
        ? path.resolve(normalizedSourcePath)
        : path.resolve(sourceBundleRoot, normalizedSourcePath);
    const roots = [
        path.join(sourceBundleRoot, 'attachments'),
        path.join(sourceBundleRoot, IMAGE_RESOURCE_DIR_NAME),
        path.join(sourceBundleRoot, LEGACY_IMAGE_RESOURCE_DIR_NAME)
    ];

    for (const root of roots) {
        const relative = path.relative(root, absoluteSourcePath).replace(/\\/g, '/');
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }

        for (const recoveryRoot of getRecoveryRootCandidates(sourceBundleRoot)) {
            const recoveredPath = path.join(
                recoveryRoot,
                path.relative(sourceBundleRoot, root).replace(/\\/g, '/'),
                relative
            );
            if (fs.existsSync(recoveredPath)) {
                return recoveredPath;
            }
        }
    }

    return '';
}

function backupSelectedAttachmentEntriesForEditor(editorInstance) {
    const selection = editorInstance?.editor?.state?.selection;
    if (!selection) {
        return false;
    }

    let sliceJson = null;
    try {
        sliceJson = selection.content()?.toJSON?.() || null;
    } catch {
        sliceJson = null;
    }

    if (!sliceJson?.content) {
        return false;
    }

    let didBackup = false;
    const walk = (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;

            const nodeType = String(node.type || '');
            if (nodeType === 'image') {
                const src = String(node.attrs?.src || '').trim();
                const absolutePath = src && typeof editorInstance.resolveImagePath === 'function'
                    ? String(editorInstance.resolveImagePath(src) || '').trim()
                    : '';
                if (absolutePath) {
                    const sourceBundlePath = findContainingTextBundlePath(absolutePath);
                    const normalizedBundlePath = String(sourceBundlePath || '').trim();
                    if (normalizedBundlePath) {
                        const normalizedSourcePath = path.resolve(absolutePath);
                        for (const imagesDir of [...getImageResourceDirCandidates(normalizedBundlePath), path.join(normalizedBundlePath, 'attachments')]) {
                            if (!fs.existsSync(imagesDir)) {
                                continue;
                            }
                            const relative = path.relative(imagesDir, normalizedSourcePath).replace(/\\/g, '/');
                            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                                if (path.resolve(imagesDir) === path.resolve(getImageResourceDirPath(normalizedBundlePath))) {
                                    didBackup = moveEntryToRecoveryForBundle(
                                        normalizedBundlePath,
                                        'attachments',
                                        path.join(IMAGE_RESOURCE_DIR_NAME, relative)
                                    ) || didBackup;
                                } else if (path.basename(imagesDir) === 'attachments') {
                                    didBackup = moveEntryToRecoveryForBundle(
                                        normalizedBundlePath,
                                        'attachments',
                                        relative
                                    ) || didBackup;
                                } else {
                                    didBackup = moveEntryToRecoveryForBundle(
                                        normalizedBundlePath,
                                        path.basename(imagesDir),
                                        relative
                                    ) || didBackup;
                                }
                                break;
                            }
                        }
                    }
                }
            }
            if (nodeType === 'kangarooAttachment' || nodeType === 'kangarooVideo' || nodeType === 'kangarooPdf') {
                const href = String(node.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveAttachmentAbsolutePath === 'function'
                    ? String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim()
                    : '';
                if (absolutePath) {
                    const sourceBundlePath = findContainingTextBundlePath(absolutePath);
                    const normalizedBundlePath = String(sourceBundlePath || '').trim();
                    if (normalizedBundlePath) {
                        const attachmentsDir = path.join(path.resolve(normalizedBundlePath), 'attachments');
                        const normalizedSourcePath = path.resolve(absolutePath);
                        const relative = path.relative(attachmentsDir, normalizedSourcePath).replace(/\\/g, '/');
                        if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                            const topLevelEntry = relative.split('/')[0];
                            if (topLevelEntry) {
                                didBackup = moveEntryToRecoveryForBundle(
                                    normalizedBundlePath,
                                    'attachments',
                                    topLevelEntry
                                ) || didBackup;
                            }
                        }
                    }
                }
            }

            if (Array.isArray(node.content)) {
                walk(node.content);
            }
        }
    };

    walk(sliceJson.content);
    return didBackup;
}

function cleanupRecoveryDir(bundlePath = window.currentPath, options = {}) {
    const { preservePrimary = false } = options;
    if (!bundlePath) return;

    for (const recoveryRoot of getRecoveryRootCandidates(bundlePath)) {
        if (preservePrimary && path.basename(recoveryRoot) === RECOVERY_DIR_NAME) {
            continue;
        }
        if (!fs.existsSync(recoveryRoot)) continue;
        fs.rmSync(recoveryRoot, { recursive: true, force: true });
    }
}

function getSessionHistoryRoot(bundlePath = window.currentPath) {
    if (!bundlePath) return '';
    return path.join(path.resolve(bundlePath), SESSION_HISTORY_DIR_NAME);
}

function cleanupSessionHistoryDir(bundlePath = window.currentPath) {
    const historyRoot = getSessionHistoryRoot(bundlePath);
    if (!historyRoot || !fs.existsSync(historyRoot)) {
        return;
    }

    fs.rmSync(historyRoot, { recursive: true, force: true });
}

function createHistoryEntryId() {
    const nonce = String(nextHistoryEntryId++).padStart(4, '0');
    return `${Date.now().toString(36)}-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}-${nonce}`;
}

function getSessionHistoryEntryRoot(bundlePath, entryId) {
    if (!bundlePath || !entryId) return '';
    return path.join(getSessionHistoryRoot(bundlePath), 'entries', entryId);
}

function moveEntryToSessionHistoryForBundle(bundlePath, kind, entryName, entryId) {
    if (!bundlePath || !kind || !entryName || !entryId) return false;

    const normalizedBundlePath = path.resolve(bundlePath);
    const sourceDir = path.join(normalizedBundlePath, kind);
    const sourcePath = path.resolve(sourceDir, entryName);
    if (!isSameOrNestedPath(sourcePath, sourceDir)) return false;
    if (!fs.existsSync(sourcePath)) return false;

    const entryRoot = getSessionHistoryEntryRoot(normalizedBundlePath, entryId);
    const targetPath = path.resolve(entryRoot, kind, entryName);
    if (!isSameOrNestedPath(targetPath, entryRoot)) return false;
    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    movePathRobustSync(sourcePath, targetPath);
    return true;
}

function restoreEntryFromSessionHistoryForBundle(bundlePath, kind, entryName, entryId) {
    if (!bundlePath || !kind || !entryName || !entryId) return false;

    const normalizedBundlePath = path.resolve(bundlePath);
    const entryRoot = getSessionHistoryEntryRoot(normalizedBundlePath, entryId);
    const sourcePath = path.resolve(entryRoot, kind, entryName);
    if (!isSameOrNestedPath(sourcePath, entryRoot)) return false;
    if (!fs.existsSync(sourcePath)) return false;

    const targetDir = path.join(normalizedBundlePath, kind);
    ensureDirectory(targetDir);
    const targetPath = path.resolve(targetDir, entryName);
    if (!isSameOrNestedPath(targetPath, targetDir)) return false;
    if (fs.existsSync(targetPath)) {
        return false;
    }

    removeDirectoryIfExists(targetPath);
    fs.rmSync(targetPath, { recursive: true, force: true });
    movePathRobustSync(sourcePath, targetPath);
    return true;
}

function restoreActiveTabFromPreviousSnapshot() {
    return void undoActiveTabState();
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

function copyFileBufferedSync(sourcePath, targetPath) {
    const sourceHandle = fs.openSync(sourcePath, 'r');
    let targetHandle = null;

    try {
        targetHandle = fs.openSync(targetPath, 'w');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;

        while (true) {
            const bytesRead = fs.readSync(sourceHandle, buffer, 0, buffer.length, position);
            if (!bytesRead) {
                break;
            }
            fs.writeSync(targetHandle, buffer, 0, bytesRead);
            position += bytesRead;
        }
    } finally {
        try {
            if (targetHandle !== null) {
                fs.closeSync(targetHandle);
            }
        } catch {
            // ignore close failures
        }
        try {
            fs.closeSync(sourceHandle);
        } catch {
            // ignore close failures
        }
    }
}

async function copyFileBufferedAsync(sourcePath, targetPath) {
    const sourceHandle = await fs.promises.open(sourcePath, 'r');
    let targetHandle = null;

    try {
        targetHandle = await fs.promises.open(targetPath, 'w');
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        let position = 0;

        while (true) {
            const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
            if (!bytesRead) {
                break;
            }
            await targetHandle.write(buffer, 0, bytesRead);
            position += bytesRead;
        }
    } finally {
        try {
            if (targetHandle) {
                await targetHandle.close();
            }
        } catch {
            // ignore close failures
        }
        try {
            await sourceHandle.close();
        } catch {
            // ignore close failures
        }
    }
}

function copyFileRobustSync(sourcePath, targetPath, stat = null) {
    ensureDirectory(path.dirname(targetPath));

    try {
        fs.copyFileSync(sourcePath, targetPath);
    } catch (error) {
        const code = String(error?.code || '');
        if (!['EIO', 'EBUSY', 'EXDEV'].includes(code)) {
            throw error;
        }
        copyFileBufferedSync(sourcePath, targetPath);
    }

    const sourceStat = stat || fs.statSync(sourcePath);
    try {
        fs.chmodSync(targetPath, sourceStat.mode);
    } catch {
        // ignore chmod failures
    }
    try {
        fs.utimesSync(targetPath, sourceStat.atime, sourceStat.mtime);
    } catch {
        // ignore utimes failures
    }
}

async function copyFileRobustAsync(sourcePath, targetPath, stat = null) {
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });

    try {
        await fs.promises.copyFile(sourcePath, targetPath);
    } catch (error) {
        const code = String(error?.code || '');
        if (!['EIO', 'EBUSY', 'EXDEV'].includes(code)) {
            throw error;
        }
        await copyFileBufferedAsync(sourcePath, targetPath);
    }

    const sourceStat = stat || await fs.promises.stat(sourcePath);
    try {
        await fs.promises.chmod(targetPath, sourceStat.mode);
    } catch {
        // ignore chmod failures
    }
    try {
        await fs.promises.utimes(targetPath, sourceStat.atime, sourceStat.mtime);
    } catch {
        // ignore utimes failures
    }
}

function movePathRobustSync(sourcePath, targetPath, stat = null) {
    const normalizedSourcePath = path.resolve(sourcePath);
    const normalizedTargetPath = path.resolve(targetPath);
    ensureDirectory(path.dirname(normalizedTargetPath));

    if (normalizedSourcePath === normalizedTargetPath) {
        return;
    }

    const sourceStat = stat || fs.statSync(normalizedSourcePath);

    try {
        fs.renameSync(normalizedSourcePath, normalizedTargetPath);
        return;
    } catch (error) {
        const code = String(error?.code || '');
        if (!['EIO', 'EBUSY', 'EXDEV'].includes(code)) {
            throw error;
        }
    }

    if (sourceStat.isDirectory()) {
        copyPathRecursive(normalizedSourcePath, normalizedTargetPath, sourceStat);
        removeDirectoryIfExists(normalizedSourcePath);
        return;
    }

    copyFileRobustSync(normalizedSourcePath, normalizedTargetPath, sourceStat);
    try {
        fs.unlinkSync(normalizedSourcePath);
    } catch (error) {
        if (String(error?.code || '') !== 'ENOENT') {
            throw error;
        }
    }
}

function copyPathRecursive(sourcePath, targetPath, stat = null) {
    const sourceStat = fs.lstatSync(sourcePath);

    if (sourceStat.isSymbolicLink()) {
        return;
    }

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

    copyFileRobustSync(sourcePath, targetPath, sourceStat);
}

function getBundleHistoryRoot(bundlePath = window.currentPath) {
    if (!bundlePath) return '';
    return path.join(path.resolve(bundlePath), HISTORY_DIR_NAME);
}

function getBundleHistoryManifestPath(bundlePath = window.currentPath) {
    const historyRoot = getBundleHistoryRoot(bundlePath);
    return historyRoot ? path.join(historyRoot, HISTORY_MANIFEST_FILE) : '';
}

function createHistorySnapshotId(date = new Date()) {
    const timestamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const suffix = crypto.randomBytes(3).toString('hex');
    return `${timestamp}-${suffix}`;
}

function hashBuffer(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function hashString(value) {
    return hashBuffer(Buffer.from(String(value || ''), 'utf8'));
}

function readBundleMarkdownForSnapshot(bundlePath, options = {}) {
    if (typeof options.markdown === 'string') {
        return options.markdown;
    }

    const markdownPath = resolveBundleMarkdownFilePath(bundlePath);
    if (!markdownPath || !fs.existsSync(markdownPath)) {
        return '';
    }

    return fs.readFileSync(markdownPath, 'utf-8');
}

function readBundleHistoryManifest(bundlePath = window.currentPath) {
    if (!HISTORY_FEATURE_ENABLED) {
        return {
            version: 1,
            snapshots: []
        };
    }

    const manifestPath = getBundleHistoryManifestPath(bundlePath);
    if (!manifestPath || !fs.existsSync(manifestPath)) {
        return {
            version: 1,
            snapshots: []
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        return {
            version: 1,
            snapshots: Array.isArray(parsed?.snapshots)
                ? parsed.snapshots.map(normalizeHistoryManifestSnapshot)
                : []
        };
    } catch {
        return {
            version: 1,
            snapshots: []
        };
    }
}

function writeBundleHistoryManifest(bundlePath, manifest) {
    if (!HISTORY_FEATURE_ENABLED) {
        return;
    }

    const manifestPath = getBundleHistoryManifestPath(bundlePath);
    if (!manifestPath) return;
    ensureDirectory(path.dirname(manifestPath));
    fs.writeFileSync(manifestPath, JSON.stringify({
        version: 1,
        snapshots: Array.isArray(manifest?.snapshots)
            ? manifest.snapshots.map(normalizeHistoryManifestSnapshot)
            : []
    }, null, 2), 'utf-8');
}

function getHistoryReasonLabel(reason) {
    const labels = {
        manual: '手动快照',
        'manual-save': '手动保存',
        'before-save': '保存前',
        'before-restore': '恢复前',
        'before-attachment-rename': '重命名附件前',
        'before-cleanup': '清理附件前'
    };
    return labels[reason] || '自动快照';
}

function collectBundleHistoryResourceEntries(bundlePath, relativeRoot, filesRoot) {
    const bundleRoot = path.resolve(bundlePath);
    const sourceRoot = path.join(bundleRoot, relativeRoot);
    const entries = [];
    if (!fs.existsSync(sourceRoot)) {
        return entries;
    }

    const visit = (absolutePath) => {
        const stat = fs.lstatSync(absolutePath);
        if (stat.isSymbolicLink()) {
            return;
        }

        const relativePath = normalizeAttachmentMarkdownHref(path.relative(bundleRoot, absolutePath));
        if (!relativePath || relativePath.startsWith('..') || relativePath.split('/').includes(HISTORY_DIR_NAME)) {
            return;
        }

        if (stat.isDirectory()) {
            for (const entryName of fs.readdirSync(absolutePath)) {
                visit(path.join(absolutePath, entryName));
            }
            return;
        }

        if (!stat.isFile()) {
            return;
        }

        const buffer = fs.readFileSync(absolutePath);
        const sha256 = hashBuffer(buffer);
        const poolPath = path.join(filesRoot, sha256);
        if (!fs.existsSync(poolPath)) {
            ensureDirectory(path.dirname(poolPath));
            fs.writeFileSync(poolPath, buffer);
        }

        entries.push({
            relativePath,
            sha256,
            size: stat.size,
            mtimeMs: Math.round(stat.mtimeMs)
        });
    };

    visit(sourceRoot);
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return entries;
}

function buildHistoryContentHash(markdown, resources) {
    const hash = crypto.createHash('sha256');
    hash.update(String(markdown || ''));
    for (const resource of resources) {
        hash.update('\n');
        hash.update(resource.relativePath);
        hash.update(':');
        hash.update(resource.sha256);
    }
    return hash.digest('hex');
}

function readHistorySnapshot(bundlePath, snapshotId) {
    if (!bundlePath || !snapshotId) return null;
    const snapshotPath = path.join(getBundleHistoryRoot(bundlePath), HISTORY_SNAPSHOT_DIR, `${snapshotId}.json`);
    if (!fs.existsSync(snapshotPath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(snapshotPath, 'utf-8'));
    } catch {
        return null;
    }
}

function writeHistorySnapshot(bundlePath, snapshot) {
    if (!bundlePath || !snapshot?.id) return false;
    const snapshotPath = path.join(getBundleHistoryRoot(bundlePath), HISTORY_SNAPSHOT_DIR, `${snapshot.id}.json`);
    ensureDirectory(path.dirname(snapshotPath));
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return true;
}

function normalizeHistoryManifestSnapshot(snapshot) {
    return {
        id: snapshot.id,
        createdAt: snapshot.createdAt || '',
        reason: snapshot.reason || 'manual',
        title: snapshot.title || getHistoryReasonLabel(snapshot.reason),
        note: snapshot.note || '',
        pinned: Boolean(snapshot.pinned),
        contentHash: snapshot.contentHash || '',
        preview: snapshot.preview || '',
        stats: snapshot.stats || {}
    };
}

function sortHistorySnapshotsForDisplay(snapshots) {
    return [...(snapshots || [])].sort((a, b) => {
        const pinnedDelta = Number(Boolean(b.pinned)) - Number(Boolean(a.pinned));
        if (pinnedDelta) return pinnedDelta;
        return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
}

function pruneBundleHistory(bundlePath, manifest = readBundleHistoryManifest(bundlePath)) {
    if (!HISTORY_FEATURE_ENABLED) {
        return manifest;
    }

    const normalizedBundlePath = path.resolve(bundlePath);
    const historyRoot = getBundleHistoryRoot(normalizedBundlePath);
    if (!historyRoot || !fs.existsSync(historyRoot)) {
        return manifest;
    }

    const snapshots = [...(manifest.snapshots || [])]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const pinnedSnapshots = snapshots.filter((snapshot) => snapshot.pinned);
    const unpinnedSnapshots = snapshots.filter((snapshot) => !snapshot.pinned);
    const keptSnapshots = [
        ...pinnedSnapshots,
        ...unpinnedSnapshots.slice(0, Math.max(0, HISTORY_MAX_SNAPSHOTS - pinnedSnapshots.length))
    ];
    const keptSnapshotIds = new Set(keptSnapshots.map((snapshot) => snapshot.id));
    const removedSnapshots = snapshots.filter((snapshot) => !keptSnapshotIds.has(snapshot.id));
    const snapshotDir = path.join(historyRoot, HISTORY_SNAPSHOT_DIR);

    for (const snapshot of removedSnapshots) {
        const snapshotPath = path.join(snapshotDir, `${snapshot.id}.json`);
        if (fs.existsSync(snapshotPath)) {
            fs.rmSync(snapshotPath, { force: true });
        }
    }

    const referencedHashes = new Set();
    for (const snapshot of keptSnapshots) {
        const snapshotData = readHistorySnapshot(normalizedBundlePath, snapshot.id);
        for (const resource of snapshotData?.resources || []) {
            if (resource.sha256) {
                referencedHashes.add(resource.sha256);
            }
        }
    }

    const filesRoot = path.join(historyRoot, HISTORY_FILE_POOL_DIR);
    if (fs.existsSync(filesRoot)) {
        for (const entryName of fs.readdirSync(filesRoot)) {
            if (!referencedHashes.has(entryName)) {
                fs.rmSync(path.join(filesRoot, entryName), { force: true });
            }
        }
    }

    const nextManifest = {
        version: 1,
        snapshots: sortHistorySnapshotsForDisplay(keptSnapshots.map(normalizeHistoryManifestSnapshot))
    };
    writeBundleHistoryManifest(normalizedBundlePath, nextManifest);
    return nextManifest;
}

function createBundleSnapshot(bundlePath = window.currentPath, options = {}) {
    if (!HISTORY_FEATURE_ENABLED) {
        return null;
    }

    if (!bundlePath || !isValidTextBundlePath(bundlePath)) {
        return null;
    }

    const normalizedBundlePath = path.resolve(bundlePath);
    const now = new Date();
    const reason = String(options.reason || 'manual');
    const markdown = readBundleMarkdownForSnapshot(normalizedBundlePath, options);
    const historyRoot = getBundleHistoryRoot(normalizedBundlePath);
    const filesRoot = path.join(historyRoot, HISTORY_FILE_POOL_DIR);
    ensureDirectory(path.join(historyRoot, HISTORY_SNAPSHOT_DIR));
    ensureDirectory(filesRoot);

    const resources = [
        ...collectBundleHistoryResourceEntries(normalizedBundlePath, IMAGE_RESOURCE_DIR_NAME, filesRoot),
        ...collectBundleHistoryResourceEntries(normalizedBundlePath, LEGACY_IMAGE_RESOURCE_DIR_NAME, filesRoot),
        ...collectBundleHistoryResourceEntries(normalizedBundlePath, 'attachments', filesRoot)
    ];
    const contentHash = buildHistoryContentHash(markdown, resources);
    const manifest = readBundleHistoryManifest(normalizedBundlePath);
    const latestSnapshot = [...(manifest.snapshots || [])]
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
    if (!options.force && latestSnapshot?.contentHash === contentHash) {
        return latestSnapshot;
    }

    const id = createHistorySnapshotId(now);
    const snapshot = {
        id,
        createdAt: now.toISOString(),
        reason,
        title: options.title || getHistoryReasonLabel(reason),
        note: options.note || '',
        pinned: Boolean(options.pinned),
        markdown,
        markdownHash: hashString(markdown),
        contentHash,
        preview: String(markdown || '')
            .split('\n')
            .slice(0, 6)
            .join('\n')
            .trim(),
        resources,
        stats: {
            characters: markdown.length,
            lines: String(markdown || '').split('\n').length,
            files: resources.length,
            bytes: resources.reduce((sum, resource) => sum + Number(resource.size || 0), 0)
        }
    };

    fs.writeFileSync(
        path.join(historyRoot, HISTORY_SNAPSHOT_DIR, `${id}.json`),
        JSON.stringify(snapshot, null, 2),
        'utf-8'
    );

    const nextManifest = {
        version: 1,
        snapshots: [{
            id,
            createdAt: snapshot.createdAt,
            reason,
            title: snapshot.title,
            note: snapshot.note,
            pinned: snapshot.pinned,
            contentHash,
            preview: snapshot.preview,
            stats: snapshot.stats
        }, ...(manifest.snapshots || [])].map(normalizeHistoryManifestSnapshot)
    };
    writeBundleHistoryManifest(normalizedBundlePath, nextManifest);
    pruneBundleHistory(normalizedBundlePath, nextManifest);
    return normalizeHistoryManifestSnapshot(snapshot);
}

function createBundleSnapshotSafely(bundlePath = window.currentPath, options = {}) {
    if (!HISTORY_FEATURE_ENABLED) {
        return null;
    }

    try {
        return createBundleSnapshot(bundlePath, options);
    } catch (error) {
        console.warn('创建版本快照失败:', error);
        return null;
    }
}

function maybeCreateAutomaticHistorySnapshot(bundlePath, options = {}) {
    if (!HISTORY_FEATURE_ENABLED) {
        return null;
    }

    if (!bundlePath) return null;
    const now = Date.now();
    if (!options.force && now - lastAutomaticHistorySnapshotAt < HISTORY_AUTO_SNAPSHOT_INTERVAL_MS) {
        return null;
    }

    const snapshot = createBundleSnapshotSafely(bundlePath, {
        reason: options.reason || 'before-save',
        title: options.title || getHistoryReasonLabel(options.reason || 'before-save'),
        markdown: options.markdown,
        force: Boolean(options.force)
    });
    if (snapshot) {
        lastAutomaticHistorySnapshotAt = now;
    }
    return snapshot;
}

function deleteHistorySnapshot(bundlePath, snapshotId) {
    if (!HISTORY_FEATURE_ENABLED) {
        return;
    }

    const manifest = readBundleHistoryManifest(bundlePath);
    const nextManifest = {
        version: 1,
        snapshots: manifest.snapshots.filter((snapshot) => snapshot.id !== snapshotId)
    };
    const snapshotPath = path.join(getBundleHistoryRoot(bundlePath), HISTORY_SNAPSHOT_DIR, `${snapshotId}.json`);
    if (fs.existsSync(snapshotPath)) {
        fs.rmSync(snapshotPath, { force: true });
    }
    writeBundleHistoryManifest(bundlePath, nextManifest);
    pruneBundleHistory(bundlePath, nextManifest);
}

function restoreBundleSnapshotResources(bundlePath, snapshot) {
    const normalizedBundlePath = path.resolve(bundlePath);
    for (const dirName of [path.join('attachments', IMAGE_RESOURCE_DIR_NAME), IMAGE_RESOURCE_DIR_NAME, LEGACY_IMAGE_RESOURCE_DIR_NAME, 'attachments']) {
        const targetDir = path.join(normalizedBundlePath, dirName);
        if (fs.existsSync(targetDir)) {
            fs.rmSync(targetDir, { recursive: true, force: true });
        }
        ensureDirectory(targetDir);
    }

    const filesRoot = path.join(getBundleHistoryRoot(normalizedBundlePath), HISTORY_FILE_POOL_DIR);
    for (const resource of snapshot.resources || []) {
        const relativePath = normalizeAttachmentMarkdownHref(resource.relativePath || '');
        if (!relativePath || (!relativePath.startsWith(`${IMAGE_RESOURCE_DIR_NAME}/`) && !relativePath.startsWith(`${LEGACY_IMAGE_RESOURCE_DIR_NAME}/`) && !relativePath.startsWith('attachments/'))) {
            continue;
        }

        const sourcePath = path.join(filesRoot, resource.sha256 || '');
        if (!fs.existsSync(sourcePath)) {
            continue;
        }

        const targetPath = path.resolve(normalizedBundlePath, relativePath);
        if (!isSameOrNestedPath(targetPath, normalizedBundlePath)) {
            continue;
        }
        copyFileRobustSync(sourcePath, targetPath);
    }
}

async function restoreBundleSnapshot(bundlePath, snapshotId, mode = 'markdown') {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    const normalizedBundlePath = path.resolve(bundlePath || '');
    const snapshot = readHistorySnapshot(normalizedBundlePath, snapshotId);
    if (!snapshot) {
        alert('找不到所选版本快照。');
        return false;
    }

    createBundleSnapshotSafely(normalizedBundlePath, {
        reason: 'before-restore',
        title: '恢复前',
        markdown: getTabById(activeTabId)?.path && path.resolve(getTabById(activeTabId).path) === normalizedBundlePath
            ? getTabMarkdownContent()
            : undefined,
        force: true
    });

    if (mode === 'full') {
        restoreBundleSnapshotResources(normalizedBundlePath, snapshot);
    }

    const activeTab = getActiveTab();
    if (activeTab && activeTab.path && path.resolve(activeTab.path) === normalizedBundlePath && window.editor) {
        suppressDocumentStateSync = true;
        window.editor.setValue(snapshot.markdown || '', { emitChange: false });
        suppressDocumentStateSync = false;
        activeTab.content = snapshot.markdown || '';
        activeTab.previousContent = snapshot.markdown || '';
        activeTab.preservedEntries = [];
        setDirty(true);
        updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
        updateOutline();
    } else {
        await openBundleFromExternalPath(normalizedBundlePath);
        const nextTab = getActiveTab();
        if (nextTab && window.editor) {
            suppressDocumentStateSync = true;
            window.editor.setValue(snapshot.markdown || '', { emitChange: false });
            suppressDocumentStateSync = false;
            nextTab.content = snapshot.markdown || '';
            nextTab.previousContent = snapshot.markdown || '';
            setDirty(true);
            updatePreview();
            updateOutline();
        }
    }

    renderHistoryPanel();
    renderEditorTabs();
    return true;
}

function formatHistoryDateTime(value) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) {
        return '--';
    }

    return date.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

function formatHistoryBytes(bytes) {
    const value = Number(bytes || 0);
    if (value >= 1024 * 1024) {
        return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }
    if (value >= 1024) {
        return `${Math.round(value / 1024)} KB`;
    }
    return `${value} B`;
}

function collectBundleCurrentResourceEntries(bundlePath) {
    const bundleRoot = path.resolve(bundlePath || '');
    const entries = [];
    const seen = new Set();
    const visitRoot = (relativeRoot) => {
        const sourceRoot = path.join(bundleRoot, relativeRoot);
        if (!fs.existsSync(sourceRoot)) return;

        const visit = (absolutePath) => {
            const stat = fs.lstatSync(absolutePath);
            if (stat.isSymbolicLink()) return;
            if (stat.isDirectory()) {
                for (const entryName of fs.readdirSync(absolutePath)) {
                    visit(path.join(absolutePath, entryName));
                }
                return;
            }
            if (!stat.isFile()) return;

            const relativePath = normalizeAttachmentMarkdownHref(path.relative(bundleRoot, absolutePath));
            if (!relativePath || relativePath.startsWith('..') || seen.has(relativePath)) return;
            seen.add(relativePath);
            entries.push({
                relativePath,
                sha256: hashBuffer(fs.readFileSync(absolutePath)),
                size: stat.size,
                mtimeMs: Math.round(stat.mtimeMs)
            });
        };

        visit(sourceRoot);
    };

    visitRoot(path.join('attachments', IMAGE_RESOURCE_DIR_NAME));
    visitRoot(IMAGE_RESOURCE_DIR_NAME);
    visitRoot(LEGACY_IMAGE_RESOURCE_DIR_NAME);
    visitRoot('attachments');
    entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return entries;
}

function mapHistoryResources(resources) {
    const mapped = new Map();
    for (const resource of resources || []) {
        if (resource?.relativePath) {
            mapped.set(normalizeAttachmentMarkdownHref(resource.relativePath), resource);
        }
    }
    return mapped;
}

function compareHistoryResources(snapshotResources, currentResources) {
    const snapshotMap = mapHistoryResources(snapshotResources);
    const currentMap = mapHistoryResources(currentResources);
    const added = [];
    const removed = [];
    const changed = [];

    for (const [relativePath, currentResource] of currentMap.entries()) {
        const snapshotResource = snapshotMap.get(relativePath);
        if (!snapshotResource) {
            added.push(currentResource);
        } else if (snapshotResource.sha256 !== currentResource.sha256) {
            changed.push({
                relativePath,
                snapshot: snapshotResource,
                current: currentResource
            });
        }
    }

    for (const [relativePath, snapshotResource] of snapshotMap.entries()) {
        if (!currentMap.has(relativePath)) {
            removed.push(snapshotResource);
        }
    }

    return { added, removed, changed };
}

function checkHistorySnapshotHealth(bundlePath, snapshot) {
    const filesRoot = path.join(getBundleHistoryRoot(bundlePath), HISTORY_FILE_POOL_DIR);
    const missingResources = [];
    for (const resource of snapshot?.resources || []) {
        if (!resource?.sha256 || !fs.existsSync(path.join(filesRoot, resource.sha256))) {
            missingResources.push(resource);
        }
    }

    return {
        ok: missingResources.length === 0,
        missingResources
    };
}

function buildHistoryLineDiff(snapshotMarkdown, currentMarkdown) {
    const snapshotLines = String(snapshotMarkdown || '').split('\n');
    const currentLines = String(currentMarkdown || '').split('\n');
    const cells = snapshotLines.length * currentLines.length;
    if (cells > 220000) {
        return {
            truncated: true,
            rows: [{
                type: 'info',
                text: `文档较大，已跳过完整行级对比（${snapshotLines.length} 行 vs ${currentLines.length} 行）。`
            }],
            stats: {
                added: 0,
                removed: 0,
                unchanged: 0
            }
        };
    }

    const table = Array.from({ length: snapshotLines.length + 1 }, () => new Uint32Array(currentLines.length + 1));
    for (let i = snapshotLines.length - 1; i >= 0; i -= 1) {
        for (let j = currentLines.length - 1; j >= 0; j -= 1) {
            table[i][j] = snapshotLines[i] === currentLines[j]
                ? table[i + 1][j + 1] + 1
                : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const rows = [];
    let added = 0;
    let removed = 0;
    let unchanged = 0;
    let i = 0;
    let j = 0;
    while (i < snapshotLines.length && j < currentLines.length) {
        if (snapshotLines[i] === currentLines[j]) {
            rows.push({ type: 'equal', text: snapshotLines[i] });
            unchanged += 1;
            i += 1;
            j += 1;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            rows.push({ type: 'removed', text: snapshotLines[i] });
            removed += 1;
            i += 1;
        } else {
            rows.push({ type: 'added', text: currentLines[j] });
            added += 1;
            j += 1;
        }
    }
    while (i < snapshotLines.length) {
        rows.push({ type: 'removed', text: snapshotLines[i] });
        removed += 1;
        i += 1;
    }
    while (j < currentLines.length) {
        rows.push({ type: 'added', text: currentLines[j] });
        added += 1;
        j += 1;
    }

    return {
        truncated: false,
        rows,
        stats: { added, removed, unchanged }
    };
}

function compactHistoryDiffRows(rows, context = 2, maxRows = 180) {
    const importantIndexes = new Set();
    rows.forEach((row, index) => {
        if (row.type !== 'equal') {
            for (let offset = -context; offset <= context; offset += 1) {
                const targetIndex = index + offset;
                if (targetIndex >= 0 && targetIndex < rows.length) {
                    importantIndexes.add(targetIndex);
                }
            }
        }
    });

    if (!importantIndexes.size) {
        return rows.slice(0, Math.min(rows.length, 24));
    }

    const compacted = [];
    let skipped = 0;
    for (let index = 0; index < rows.length; index += 1) {
        if (!importantIndexes.has(index)) {
            skipped += 1;
            continue;
        }
        if (skipped) {
            compacted.push({ type: 'skip', text: `跳过 ${skipped} 行未变化内容` });
            skipped = 0;
        }
        compacted.push(rows[index]);
        if (compacted.length >= maxRows) {
            compacted.push({ type: 'skip', text: '后续差异已折叠' });
            break;
        }
    }
    return compacted;
}

function buildHistoryResourceChangesSection(resourceDiff) {
    const resourceSection = document.createElement('div');
    resourceSection.className = 'history-resource-section';
    const resourceTitle = document.createElement('div');
    resourceTitle.className = 'history-section-title';
    resourceTitle.textContent = '资源变化';
    resourceSection.appendChild(resourceTitle);

    const resourceList = document.createElement('div');
    resourceList.className = 'history-resource-list';
    const resourceRows = [
        ...resourceDiff.added.slice(0, 6).map((resource) => ({ type: '当前新增', path: resource.relativePath })),
        ...resourceDiff.removed.slice(0, 6).map((resource) => ({ type: '快照独有', path: resource.relativePath })),
        ...resourceDiff.changed.slice(0, 6).map((resource) => ({ type: '内容变更', path: resource.relativePath }))
    ];

    if (!resourceRows.length) {
        const empty = document.createElement('div');
        empty.className = 'history-item-meta';
        empty.textContent = '资源没有变化。';
        resourceList.appendChild(empty);
    } else {
        for (const row of resourceRows) {
            const resourceItem = document.createElement('div');
            resourceItem.className = 'history-resource-item';
            resourceItem.textContent = `${row.type} · ${row.path}`;
            resourceList.appendChild(resourceItem);
        }
    }

    resourceSection.appendChild(resourceList);
    return resourceSection;
}

function buildHistoryMarkdownDiffSection(compactRows) {
    const diffSection = document.createElement('div');
    diffSection.className = 'history-diff-section';
    const diffTitle = document.createElement('div');
    diffTitle.className = 'history-section-title';
    diffTitle.textContent = '正文差异';
    diffSection.appendChild(diffTitle);

    const diffList = document.createElement('div');
    diffList.className = 'history-diff-list';
    for (const row of compactRows) {
        const diffRow = document.createElement('div');
        diffRow.className = `history-diff-row ${row.type}`;
        diffRow.textContent = row.type === 'added'
            ? `+ ${row.text}`
            : row.type === 'removed'
                ? `- ${row.text}`
                : row.type === 'skip'
                    ? row.text
                    : `  ${row.text}`;
        diffList.appendChild(diffRow);
    }

    diffSection.appendChild(diffList);
    return diffSection;
}

function clearHistoryPanelDetailRenderTask() {
    historyPanelDetailRenderToken += 1;
    if (historyPanelDetailRenderTimer) {
        window.clearTimeout(historyPanelDetailRenderTimer);
        historyPanelDetailRenderTimer = null;
    }
}

function buildHistorySelectedSnapshotDetail(snapshot, bundlePath, currentMarkdown, currentResources) {
    const inlineDetail = document.createElement('div');
    inlineDetail.className = 'history-inline-detail';
    const lineDiff = buildHistoryLineDiff(snapshot.markdown || '', currentMarkdown);
    const compactRows = compactHistoryDiffRows(lineDiff.rows);
    const resourceDiff = compareHistoryResources(snapshot.resources || [], currentResources);
    const selectedHealth = checkHistorySnapshotHealth(bundlePath, snapshot);

    if (snapshot.note) {
        const note = document.createElement('div');
        note.className = 'history-note';
        note.textContent = snapshot.note;
        inlineDetail.appendChild(note);
    }

    if (!selectedHealth.ok) {
        const warning = document.createElement('div');
        warning.className = 'history-warning';
        warning.textContent = `这个快照缺少 ${selectedHealth.missingResources.length} 个资源文件，恢复全部时这些资源无法还原。`;
        inlineDetail.appendChild(warning);
    }

    const summary = document.createElement('div');
    summary.className = 'history-summary-grid';
    const summaryItems = [
        ['当前新增', lineDiff.stats.added],
        ['快照独有', lineDiff.stats.removed],
        ['资源新增', resourceDiff.added.length],
        ['资源缺失', resourceDiff.removed.length],
        ['资源变更', resourceDiff.changed.length]
    ];
    for (const [label, value] of summaryItems) {
        const chip = document.createElement('div');
        chip.className = 'history-summary-chip';
        const chipValue = document.createElement('strong');
        chipValue.textContent = String(value);
        const chipLabel = document.createElement('span');
        chipLabel.textContent = label;
        chip.appendChild(chipValue);
        chip.appendChild(chipLabel);
        summary.appendChild(chip);
    }
    inlineDetail.appendChild(summary);
    inlineDetail.appendChild(buildHistoryResourceChangesSection(resourceDiff));
    inlineDetail.appendChild(buildHistoryMarkdownDiffSection(compactRows));
    return inlineDetail;
}

async function renderHistorySelectedSnapshotDetailAsync(bundlePath, snapshotId, token) {
    await yieldToUiFrame();
    if (token !== historyPanelDetailRenderToken) return;

    const container = document.querySelector(`[data-history-detail-for="${snapshotId}"]`);
    if (!container) return;

    const snapshot = readHistorySnapshot(bundlePath, snapshotId);
    if (!snapshot) {
        container.innerHTML = '';
        const empty = document.createElement('div');
        empty.className = 'history-item-meta';
        empty.textContent = '找不到所选版本快照。';
        container.appendChild(empty);
        return;
    }

    const currentMarkdown = activeTab?.path && path.resolve(activeTab.path) === path.resolve(bundlePath)
        ? getTabMarkdownContent()
        : readBundleMarkdownForSnapshot(bundlePath);

    await yieldToUiFrame();
    if (token !== historyPanelDetailRenderToken) return;

    const currentResources = collectBundleCurrentResourceEntries(bundlePath);
    if (token !== historyPanelDetailRenderToken) return;

    const detail = buildHistorySelectedSnapshotDetail(snapshot, bundlePath, currentMarkdown, currentResources);
    if (token !== historyPanelDetailRenderToken) return;

    container.innerHTML = '';
    container.appendChild(detail);
}

function scheduleHistorySelectedSnapshotDetailRender(bundlePath, snapshotId) {
    clearHistoryPanelDetailRenderTask();
    const token = historyPanelDetailRenderToken;
    historyPanelDetailRenderTimer = window.setTimeout(() => {
        historyPanelDetailRenderTimer = null;
        void renderHistorySelectedSnapshotDetailAsync(bundlePath, snapshotId, token);
    }, 0);
}

function updateHistorySnapshotMetadata(bundlePath, snapshotId, patch) {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    const normalizedBundlePath = path.resolve(bundlePath || '');
    const manifest = readBundleHistoryManifest(normalizedBundlePath);
    const snapshot = readHistorySnapshot(normalizedBundlePath, snapshotId);
    if (!snapshot) return false;

    const nextSnapshot = {
        ...snapshot,
        title: typeof patch.title === 'string' ? patch.title.trim() || getHistoryReasonLabel(snapshot.reason) : snapshot.title,
        note: typeof patch.note === 'string' ? patch.note.trim() : snapshot.note || '',
        pinned: typeof patch.pinned === 'boolean' ? patch.pinned : Boolean(snapshot.pinned)
    };
    writeHistorySnapshot(normalizedBundlePath, nextSnapshot);

    const nextManifest = {
        version: 1,
        snapshots: manifest.snapshots.map((entry) => entry.id === snapshotId
            ? normalizeHistoryManifestSnapshot({ ...entry, ...nextSnapshot })
            : normalizeHistoryManifestSnapshot(entry))
    };
    writeBundleHistoryManifest(normalizedBundlePath, nextManifest);
    pruneBundleHistory(normalizedBundlePath, nextManifest);
    return true;
}

async function handleEditHistorySnapshotMetadata(bundlePath, snapshotId) {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    const snapshot = readHistorySnapshot(bundlePath, snapshotId);
    if (!snapshot) {
        alert('找不到所选版本快照。');
        return false;
    }

    const title = await openTextInputModal({
        title: '版本标题',
        message: '请输入版本标题。',
        defaultValue: snapshot.title || getHistoryReasonLabel(snapshot.reason),
        confirmText: '下一步'
    });
    if (title === null) return false;
    const note = await openTextInputModal({
        title: '版本备注',
        message: '请输入版本备注。',
        defaultValue: snapshot.note || '',
        confirmText: '保存'
    });
    if (note === null) return false;

    const updated = updateHistorySnapshotMetadata(bundlePath, snapshotId, { title, note });
    if (updated) {
        selectedHistorySnapshotId = snapshotId;
        renderHistoryPanel();
    }
    return updated;
}

function toggleHistorySnapshotPinned(bundlePath, snapshotId) {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    const snapshot = readHistorySnapshot(bundlePath, snapshotId);
    if (!snapshot) return false;
    const updated = updateHistorySnapshotMetadata(bundlePath, snapshotId, {
        pinned: !Boolean(snapshot.pinned)
    });
    if (updated) {
        selectedHistorySnapshotId = snapshotId;
        renderHistoryPanel();
    }
    return updated;
}

function requestHistoryRestore(bundlePath, snapshotId, mode) {
    if (!HISTORY_FEATURE_ENABLED) {
        return;
    }

    pendingHistoryRestore = {
        bundlePath: path.resolve(bundlePath || ''),
        snapshotId,
        mode
    };
    selectedHistorySnapshotId = snapshotId;
    renderHistoryPanel();
}

async function confirmPendingHistoryRestore() {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    if (!pendingHistoryRestore) return false;
    const restoreRequest = pendingHistoryRestore;
    pendingHistoryRestore = null;
    const restored = await restoreBundleSnapshot(restoreRequest.bundlePath, restoreRequest.snapshotId, restoreRequest.mode);
    if (!restored) {
        renderHistoryPanel();
    }
    return restored;
}

function saveHistorySnapshotToPath(sourceBundlePath, snapshot, targetBundlePath) {
    if (!HISTORY_FEATURE_ENABLED) {
        return;
    }

    const normalizedSourceBundlePath = path.resolve(sourceBundlePath || '');
    const normalizedTargetBundlePath = path.resolve(targetBundlePath || '');
    if (!snapshot || !normalizedTargetBundlePath) {
        throw new Error('无效的版本快照。');
    }

    if (normalizedSourceBundlePath && normalizedTargetBundlePath === normalizedSourceBundlePath) {
        throw new Error('不能另存为当前正在打开的文档路径，请选择一个新位置。');
    }

    ensureBundleStructure(normalizedTargetBundlePath);
    const attachmentsDir = path.join(normalizedTargetBundlePath, 'attachments');
    removeDirectoryIfExists(attachmentsDir);
    ensureDirectory(attachmentsDir);

    const filesRoot = path.join(getBundleHistoryRoot(normalizedSourceBundlePath), HISTORY_FILE_POOL_DIR);
    for (const resource of snapshot.resources || []) {
        const relativePath = normalizeImageResourceHrefForWrite(normalizeAttachmentMarkdownHref(resource.relativePath || ''));
        if (!relativePath || !relativePath.startsWith('attachments/')) {
            continue;
        }

        const sourcePath = path.join(filesRoot, resource.sha256 || '');
        if (!fs.existsSync(sourcePath)) {
            continue;
        }

        const targetPath = path.resolve(normalizedTargetBundlePath, relativePath);
        if (!isSameOrNestedPath(targetPath, normalizedTargetBundlePath)) {
            continue;
        }
        copyFileRobustSync(sourcePath, targetPath);
    }

    const preferredFileName = DEFAULT_BUNDLE_MARKDOWN_FILE;
    const markdownFilePath = resolveBundleMarkdownFilePath(normalizedTargetBundlePath, {
        preferredName: preferredFileName,
        createIfMissing: true
    });
    fs.writeFileSync(markdownFilePath, snapshot.markdown || '', 'utf-8');
}

function refreshHistoryPanelIfVisible(bundlePath = window.currentPath) {
    if (!HISTORY_FEATURE_ENABLED) {
        return;
    }

    if (!timelinePanelOpen || currentRightSidebarTab !== 'history') {
        return;
    }

    const activeTab = getActiveTab();
    const currentBundlePath = activeTab?.path || window.currentPath || '';
    if (!currentBundlePath || path.resolve(String(currentBundlePath)) !== path.resolve(String(bundlePath || ''))) {
        return;
    }

    renderedHistoryBundlePath = path.resolve(String(bundlePath || ''));
    renderHistoryPanel();
}

async function handleSaveHistorySnapshotAs(bundlePath, snapshotId) {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    const snapshot = readHistorySnapshot(bundlePath, snapshotId);
    if (!snapshot) {
        alert('找不到所选版本快照。');
        return false;
    }

    try {
        const baseName = stripKnownBundleExtension(path.basename(String(bundlePath || `历史版本${DEFAULT_BUNDLE_EXTENSION}`))) || '历史版本';
        const timeSuffix = formatHistoryDateTime(snapshot.createdAt).replace(/[/:]/g, '-').replace(/\s+/g, ' ');
        const targetPath = await ipcRenderer.invoke('dialog:saveBundleAs', {
            defaultPath: `${baseName} ${timeSuffix}${DEFAULT_BUNDLE_EXTENSION}`
        });
        if (!targetPath) return false;

        saveHistorySnapshotToPath(bundlePath, snapshot, targetPath);
        alert('版本已另存为新的 Kangaroo bundle。');
        return true;
    } catch (error) {
        alert(`版本另存为失败: ${error.message}`);
        return false;
    }
}

function renderHistoryPanel() {
    if (!HISTORY_FEATURE_ENABLED) {
        const container = document.getElementById('history-container');
        if (container) {
            container.innerHTML = '';
        }
        clearHistoryPanelDetailRenderTask();
        return;
    }

    const container = document.getElementById('history-container');
    if (!container) return;

    container.innerHTML = '';
    const panel = document.createElement('div');
    panel.className = 'history-panel';
    container.appendChild(panel);

    const activeTab = getActiveTab();
    const bundlePath = activeTab?.path || window.currentPath || '';
    if (!bundlePath) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '当前文档还没有保存位置，保存为 Kangaroo bundle 后才能创建版本快照。';
        panel.appendChild(emptyState);
        pendingHistoryRestore = null;
        selectedHistorySnapshotId = '';
        renderedHistoryBundlePath = '';
        clearHistoryPanelDetailRenderTask();
        return;
    }

    const normalizedHistoryBundlePath = path.resolve(bundlePath);
    if (renderedHistoryBundlePath !== normalizedHistoryBundlePath) {
        renderedHistoryBundlePath = normalizedHistoryBundlePath;
        selectedHistorySnapshotId = '';
        pendingHistoryRestore = null;
    }

    const createActionButton = (label, className, onClick) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `history-button${className ? ` ${className}` : ''}`;
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    };

    const appendResourceChanges = (target, resourceDiff) => {
        const resourceSection = document.createElement('div');
        resourceSection.className = 'history-resource-section';
        const resourceTitle = document.createElement('div');
        resourceTitle.className = 'history-section-title';
        resourceTitle.textContent = '资源变化';
        resourceSection.appendChild(resourceTitle);

        const resourceList = document.createElement('div');
        resourceList.className = 'history-resource-list';
        const resourceRows = [
            ...resourceDiff.added.slice(0, 6).map((resource) => ({ type: '当前新增', path: resource.relativePath })),
            ...resourceDiff.removed.slice(0, 6).map((resource) => ({ type: '快照独有', path: resource.relativePath })),
            ...resourceDiff.changed.slice(0, 6).map((resource) => ({ type: '内容变更', path: resource.relativePath }))
        ];

        if (!resourceRows.length) {
            const empty = document.createElement('div');
            empty.className = 'history-item-meta';
            empty.textContent = '资源没有变化。';
            resourceList.appendChild(empty);
        } else {
            for (const row of resourceRows) {
                const resourceItem = document.createElement('div');
                resourceItem.className = 'history-resource-item';
                resourceItem.textContent = `${row.type} · ${row.path}`;
                resourceList.appendChild(resourceItem);
            }
        }

        resourceSection.appendChild(resourceList);
        target.appendChild(resourceSection);
    };

    const appendMarkdownDiff = (target, compactRows) => {
        const diffSection = document.createElement('div');
        diffSection.className = 'history-diff-section';
        const diffTitle = document.createElement('div');
        diffTitle.className = 'history-section-title';
        diffTitle.textContent = '正文差异';
        diffSection.appendChild(diffTitle);

        const diffList = document.createElement('div');
        diffList.className = 'history-diff-list';
        for (const row of compactRows) {
            const diffRow = document.createElement('div');
            diffRow.className = `history-diff-row ${row.type}`;
            diffRow.textContent = row.type === 'added'
                ? `+ ${row.text}`
                : row.type === 'removed'
                    ? `- ${row.text}`
                    : row.type === 'skip'
                        ? row.text
                        : `  ${row.text}`;
            diffList.appendChild(diffRow);
        }

        diffSection.appendChild(diffList);
        target.appendChild(diffSection);
    };

    const toolbar = document.createElement('div');
    toolbar.className = 'history-toolbar';
    toolbar.appendChild(createActionButton('创建快照', 'primary', () => {
        handleCreateHistorySnapshot();
    }));
    panel.appendChild(toolbar);

    const manifest = readBundleHistoryManifest(bundlePath);
    const snapshots = sortHistorySnapshotsForDisplay(manifest.snapshots || []);

    if (!snapshots.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '还没有版本快照。点击上方按钮可以记录当前文档状态。';
        panel.appendChild(emptyState);
        pendingHistoryRestore = null;
        selectedHistorySnapshotId = '';
        clearHistoryPanelDetailRenderTask();
        return;
    }

    if (selectedHistorySnapshotId && !snapshots.some((snapshot) => snapshot.id === selectedHistorySnapshotId)) {
        selectedHistorySnapshotId = '';
    }

    const selectedSnapshot = selectedHistorySnapshotId
        ? readHistorySnapshot(bundlePath, selectedHistorySnapshotId)
        : null;

    const list = document.createElement('div');
    list.className = 'history-list';
    panel.appendChild(list);

    for (const snapshotMeta of snapshots) {
        const item = document.createElement('div');
        item.className = `history-item${snapshotMeta.id === selectedHistorySnapshotId ? ' active' : ''}`;
        item.tabIndex = 0;
        const stats = snapshotMeta.stats || {};

        const head = document.createElement('div');
        head.className = 'history-item-head';
        const titleWrap = document.createElement('div');
        const title = document.createElement('div');
        title.className = 'history-item-title';
        title.textContent = `${snapshotMeta.pinned ? '置顶 · ' : ''}${snapshotMeta.title || getHistoryReasonLabel(snapshotMeta.reason)}`;
        const reason = document.createElement('div');
        reason.className = 'history-item-meta';
        reason.textContent = getHistoryReasonLabel(snapshotMeta.reason);
        titleWrap.appendChild(title);
        titleWrap.appendChild(reason);
        const time = document.createElement('div');
        time.className = 'history-item-time';
        time.textContent = formatHistoryDateTime(snapshotMeta.createdAt);
        head.appendChild(titleWrap);
        head.appendChild(time);
        item.appendChild(head);

        const meta = document.createElement('div');
        meta.className = 'history-item-meta';
        meta.textContent = `${Number(stats.lines || 0)} 行 · ${Number(stats.files || 0)} 个资源 · ${formatHistoryBytes(stats.bytes || 0)}`;
        item.appendChild(meta);

        const preview = document.createElement('div');
        preview.className = 'history-preview';
        preview.textContent = snapshotMeta.preview || snapshotMeta.note || '';
        item.appendChild(preview);

        const actions = document.createElement('div');
        actions.className = 'history-actions';

        actions.appendChild(createActionButton('恢复全部', 'primary', async () => {
            const snapshot = readHistorySnapshot(bundlePath, snapshotMeta.id);
            if (!snapshot) {
                alert('找不到所选版本快照。');
                return;
            }
            const healthState = checkHistorySnapshotHealth(bundlePath, snapshot);
            const warningText = healthState.ok
                ? ''
                : `\n\n注意：这个快照缺少 ${healthState.missingResources.length} 个资源文件，恢复全部时这些资源无法还原。`;
            if (!confirm(`要恢复这个版本的正文、images 和 attachments 吗？当前状态会先创建“恢复前”快照。${warningText}`)) {
                return;
            }
            selectedHistorySnapshotId = snapshotMeta.id;
            await restoreBundleSnapshot(bundlePath, snapshotMeta.id, 'full');
        }));
        actions.appendChild(createActionButton('另存为', '', () => {
            void handleSaveHistorySnapshotAs(bundlePath, snapshotMeta.id);
        }));
        actions.appendChild(createActionButton('删除', 'danger', () => {
            if (!confirm('确定删除这个版本快照吗？')) return;
            deleteHistorySnapshot(bundlePath, snapshotMeta.id);
            if (selectedHistorySnapshotId === snapshotMeta.id) {
                selectedHistorySnapshotId = '';
            }
            pendingHistoryRestore = null;
            renderHistoryPanel();
        }));

        item.appendChild(actions);
        item.addEventListener('click', (event) => {
            if (event.target.closest('button')) return;
            selectedHistorySnapshotId = snapshotMeta.id;
            pendingHistoryRestore = null;
            renderHistoryPanel();
        });
        item.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            selectedHistorySnapshotId = snapshotMeta.id;
            pendingHistoryRestore = null;
            renderHistoryPanel();
        });

        if (selectedSnapshot && snapshotMeta.id === selectedHistorySnapshotId) {
            const inlineDetail = document.createElement('div');
            inlineDetail.className = 'history-inline-detail';
            inlineDetail.dataset.historyDetailFor = snapshotMeta.id;
            inlineDetail.classList.add('is-loading');
            const loading = document.createElement('div');
            loading.className = 'history-item-meta';
            loading.textContent = '正在计算差异…';
            inlineDetail.appendChild(loading);
            item.appendChild(inlineDetail);
        }

        list.appendChild(item);
    }

    if (selectedSnapshot) {
        scheduleHistorySelectedSnapshotDetailRender(bundlePath, selectedHistorySnapshotId);
    } else {
        clearHistoryPanelDetailRenderTask();
    }
}

function handleCreateHistorySnapshot() {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    if (!window.currentPath || !getActiveTab()) {
        alert('请先打开或保存一个 Kangaroo 文档。');
        return false;
    }

    let snapshot = null;
    try {
        snapshot = createBundleSnapshot(window.currentPath, {
            reason: 'manual',
            title: '手动快照',
            markdown: getTabMarkdownContent(),
            force: true
        });
    } catch (error) {
        console.warn('创建版本快照失败:', error);
    }

    if (!snapshot) {
        alert('创建版本快照失败。');
        return false;
    }

    renderHistoryPanel();
    alert('版本快照已创建。');
    return true;
}

function openHistoryPanel() {
    if (!HISTORY_FEATURE_ENABLED) {
        return false;
    }

    if (!window.currentPath && !getActiveTab()) {
        alert('请先打开或保存一个文档。');
        return false;
    }
    return toggleRightSidebarTab('history');
}

function getClipboardAttachmentEntryNamesFromPayload(payload) {
    const entryNames = new Set();
    const attachmentPayloads = payload?.attachments && typeof payload.attachments === 'object'
        ? Object.values(payload.attachments)
        : [];

    for (const attachmentPayload of attachmentPayloads) {
        const absolutePath = String(
            typeof attachmentPayload === 'string'
                ? attachmentPayload
                : attachmentPayload?.absolutePath || ''
        ).trim();
        if (!absolutePath || !window.currentPath) {
            continue;
        }

        const attachmentsDir = path.join(path.resolve(window.currentPath), 'attachments');
        const normalizedPath = path.resolve(absolutePath);
        const relative = path.relative(attachmentsDir, normalizedPath);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
            continue;
        }

        const topLevelEntry = relative.split(path.sep)[0];
        if (topLevelEntry) {
            entryNames.add(topLevelEntry);
        }
    }

    return entryNames;
}

function preserveClipboardAttachmentEntries(payload) {
    const entryNames = getClipboardAttachmentEntryNamesFromPayload(payload);
    if (!entryNames.size) {
        return false;
    }

    for (const entryName of entryNames) {
        preservedUnusedAttachmentEntries.add(entryName);
    }

    schedulePersistActiveTabState();
    return true;
}

function rememberEditorClipboardSlicePayload(payloadText) {
    pendingEditorClipboardSlicePayload = String(payloadText || '');
    pendingEditorClipboardSliceTimestamp = Date.now();
}

function getRecentEditorClipboardSlicePayload(maxAgeMs = 30000) {
    if (!pendingEditorClipboardSlicePayload) {
        return '';
    }

    if (Date.now() - pendingEditorClipboardSliceTimestamp > maxAgeMs) {
        pendingEditorClipboardSlicePayload = null;
        pendingEditorClipboardSliceTimestamp = 0;
        return '';
    }

    return pendingEditorClipboardSlicePayload;
}

function readEditorClipboardSlicePayload(event = null) {
    const eventPayload = String(event?.clipboardData?.getData?.(KANGAROO_INTERNAL_SLICE_MIME) || '').trim();
    if (eventPayload) {
        return eventPayload;
    }

    try {
        const availableFormats = clipboard.availableFormats() || [];
        if (availableFormats.includes(KANGAROO_INTERNAL_SLICE_MIME)) {
            const clipboardBuffer = clipboard.readBuffer(KANGAROO_INTERNAL_SLICE_MIME);
            if (clipboardBuffer && clipboardBuffer.length) {
                const bufferPayload = clipboardBuffer.toString('utf-8').trim();
                if (bufferPayload) {
                    return bufferPayload;
                }
            }
        }
    } catch {
        // ignore clipboard read failures
    }

    return getRecentEditorClipboardSlicePayload();
}

function copyNamedEntries(sourceDir, targetDir, entryNames) {
    ensureDirectory(targetDir);

    for (const entryName of entryNames) {
        const sourcePath = path.join(sourceDir, entryName);
        if (!fs.existsSync(sourcePath)) continue;

        copyPathRecursive(sourcePath, path.join(targetDir, entryName));
    }
}

function copyUsedImageEntriesToAttachments(sourceBundlePath, targetBundlePath, usedImageEntries) {
    if (!sourceBundlePath || !targetBundlePath || !usedImageEntries || !usedImageEntries.size) {
        return;
    }

    const normalizedSourceBundlePath = path.resolve(sourceBundlePath);
    const targetImagesDir = getImageResourceDirPath(path.resolve(targetBundlePath));
    ensureDirectory(targetImagesDir);

    for (const entryName of usedImageEntries) {
        if (!entryName) continue;

        const targetPath = path.join(targetImagesDir, entryName);
        const candidates = [
            ...getImageResourceDirCandidates(normalizedSourceBundlePath),
            path.join(normalizedSourceBundlePath, 'attachments', IMAGE_RESOURCE_DIR_NAME),
            path.join(normalizedSourceBundlePath, 'attachments')
        ];

        let sourcePath = '';
        for (const candidateDir of candidates) {
            const candidatePath = path.join(candidateDir, entryName);
            if (fs.existsSync(candidatePath)) {
                sourcePath = candidatePath;
                break;
            }
        }

        if (!sourcePath) {
            continue;
        }

        if (path.resolve(sourcePath) === path.resolve(targetPath)) {
            continue;
        }

        copyPathRecursive(sourcePath, targetPath);
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

async function handleAttachmentPath(sourcePath, stat = null) {
    return runHistoryTransaction('导入附件', async () => {
        const bundlePath = window.currentPath;
        if (!bundlePath) {
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
        const historyEntryId = createHistoryEntryId();

        recordHistoryAttachmentStep({
            kind: 'attachment-import',
            label: '导入附件',
            undo() {
                return moveEntryToSessionHistoryForBundle(bundlePath, 'attachments', entryName, historyEntryId);
            },
            redo() {
                return restoreEntryFromSessionHistoryForBundle(bundlePath, 'attachments', entryName, historyEntryId);
            }
        });

        if (sourceStat.isDirectory()) {
            const folderLabel = path.basename(normalizedSourcePath) || '附件文件夹';
            showImportProgressModal({
                title: '正在导入附件文件夹',
                detail: `${folderLabel} · 正在分析内容…`,
                total: 0,
                completed: 0
            });
            setWorkspaceBusy('正在导入附件文件夹…');
            try {
                await yieldToUiFrame();
                const totalEntries = Math.max(await countPathEntriesAsync(normalizedSourcePath), 1);
                const progressState = { completed: 0 };
                setImportProgressModalProgress(0, totalEntries, `${folderLabel} · 0/${totalEntries}`);
                await copyPathRecursiveAsync(normalizedSourcePath, targetPath, {
                    totalEntries,
                    progressState,
                    onProgress: (completed, total) => {
                        setImportProgressModalProgress(
                            completed,
                            total,
                            `${folderLabel} · ${completed}/${total}`
                        );
                    }
                });
            } finally {
                hideImportProgressModal();
                clearWorkspaceBusy();
            }
        } else {
            await copyFileRobustAsync(normalizedSourcePath, targetPath, sourceStat);
        }

        if (activeHistoryTransaction && activeHistoryTransaction.tabId !== activeTabId) {
            return;
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
    });
}


// ==============================
// 图片保存
// ==============================
function saveImage(buffer) {
    const bundlePath = window.currentPath;
    const imagesDir = getImageResourceDirPath(bundlePath);
    ensureDirectory(imagesDir);

    const filename = generateFileName(imagesDir, {
        extension: '.png'
    });
    const filePath = path.join(imagesDir, filename);
    const historyEntryId = createHistoryEntryId();
    const historyEntryName = path.join(IMAGE_RESOURCE_DIR_NAME, filename);

    if (activeHistoryTransaction && activeHistoryTransaction.tabId === getActiveTab()?.id) {
        recordHistoryAttachmentStep({
            kind: 'attachment-import',
            label: '插入图片',
            undo() {
                return moveEntryToSessionHistoryForBundle(bundlePath, 'attachments', historyEntryName, historyEntryId);
            },
            redo() {
                return restoreEntryFromSessionHistoryForBundle(bundlePath, 'attachments', historyEntryName, historyEntryId);
            }
        });
    }

    fs.writeFileSync(filePath, buffer);
    if (activeHistoryTransaction && activeHistoryTransaction.tabId !== activeTabId) {
        return;
    }

    const relativePath = `attachments/${IMAGE_RESOURCE_DIR_NAME}/${filename}`;
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
    const entries = String(rawValue || '')
        .split(/[\r\n\0]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

    const filePaths = [];
    for (let index = 0; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry) continue;
        if (/^(copy|cut)$/i.test(entry)) {
            continue;
        }

        const candidate = (() => {
            try {
                if (/^file:/i.test(entry)) {
                    return url.fileURLToPath(entry);
                }
                if (path.isAbsolute(entry)) {
                    return entry;
                }
                if (entry.startsWith('~')) {
                    return path.resolve(entry.replace(/^~/, os.homedir()));
                }
            } catch {
                return null;
            }
            return null;
        })();

        if (candidate) {
            filePaths.push(candidate);
        }
    }

    return filePaths.filter(Boolean);
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
        if (isSupportedBundleName(path.basename(currentPath)) && fs.existsSync(currentPath)) {
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

function importReferencedEntryIntoCurrentBundle(absolutePath, options = {}) {
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

    const normalizedSourceBundlePath = path.resolve(sourceBundlePath);
    const shouldMoveSourceEntry = Boolean(options.move) && normalizedSourceBundlePath !== currentBundlePath;

    const relativeInsideBundle = path.relative(sourceBundlePath, normalizedSourcePath).replace(/\\/g, '/');
    if (!relativeInsideBundle || relativeInsideBundle.startsWith('..')) {
        return null;
    }

    const topLevelDir = relativeInsideBundle.split('/')[0];
    const sourceStat = fs.statSync(normalizedSourcePath);
    const shouldTreatAsImage = (
        (topLevelDir === IMAGE_RESOURCE_DIR_NAME || topLevelDir === LEGACY_IMAGE_RESOURCE_DIR_NAME || topLevelDir === 'attachments')
        && !sourceStat.isDirectory()
        && isImageFilePath(normalizedSourcePath)
    );

    if (path.resolve(sourceBundlePath) === currentBundlePath) {
        return {
            relativePath: shouldTreatAsImage
                ? toMarkdownRelativeLink(normalizeImageResourceHrefForWrite(relativeInsideBundle))
                : toMarkdownRelativeLink(relativeInsideBundle),
            kind: shouldTreatAsImage ? 'image' : 'attachment',
            absolutePath: normalizedSourcePath
        };
    }

    const targetRootDir = shouldTreatAsImage
        ? getImageResourceDirPath(currentBundlePath)
        : path.join(currentBundlePath, 'attachments');
    ensureDirectory(targetRootDir);

    const entryName = generateUniqueEntryName(targetRootDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(targetRootDir, entryName);
    const targetHistoryEntryId = createHistoryEntryId();
    const targetHistoryEntryName = shouldTreatAsImage
        ? path.join(IMAGE_RESOURCE_DIR_NAME, entryName)
        : entryName;
    let importSourcePath = normalizedSourcePath;
    let importSourceStat = sourceStat;
    let sourceHistoryEntryId = '';
    let sourceBackupPath = '';
    const backupInfo = shouldMoveSourceEntry
        ? getBundleEntryBackupInfo(normalizedSourcePath, normalizedSourceBundlePath)
        : null;

    if (shouldMoveSourceEntry && backupInfo) {
        sourceHistoryEntryId = createHistoryEntryId();
        sourceBackupPath = path.join(
            getSessionHistoryEntryRoot(normalizedSourceBundlePath, sourceHistoryEntryId),
            backupInfo.kind,
            backupInfo.entryName
        );
        if (moveEntryToSessionHistoryForBundle(
            normalizedSourceBundlePath,
            backupInfo.kind,
            backupInfo.entryName,
            sourceHistoryEntryId
        )) {
            importSourcePath = sourceBackupPath;
            importSourceStat = sourceStat;
        }
    }

    if (activeHistoryTransaction && activeHistoryTransaction.tabId === getActiveTab()?.id) {
        recordHistoryAttachmentStep({
            kind: 'attachment-import',
            label: '导入引用附件',
            undo() {
                let didUndo = true;
                if (fs.existsSync(targetPath)) {
                    didUndo = moveEntryToSessionHistoryForBundle(
                        currentBundlePath,
                        'attachments',
                        targetHistoryEntryName,
                        targetHistoryEntryId
                    );
                }
                if (shouldMoveSourceEntry && sourceBackupPath && fs.existsSync(sourceBackupPath)) {
                    if (!fs.existsSync(normalizedSourcePath)) {
                        didUndo = restoreEntryFromSessionHistoryForBundle(
                            normalizedSourceBundlePath,
                            backupInfo.kind,
                            backupInfo.entryName,
                            sourceHistoryEntryId
                        ) && didUndo;
                    }
                }
                return didUndo;
            },
            redo() {
                if (shouldMoveSourceEntry && sourceBackupPath) {
                    if (fs.existsSync(normalizedSourcePath)) {
                        movePathRobustSync(normalizedSourcePath, sourceBackupPath, sourceStat);
                    }
                }
                return restoreEntryFromSessionHistoryForBundle(
                    currentBundlePath,
                    'attachments',
                    targetHistoryEntryName,
                    targetHistoryEntryId
                );
            }
        });
    }

    if (shouldMoveSourceEntry) {
        if (sourceHistoryEntryId && sourceBackupPath) {
            if (fs.existsSync(normalizedSourcePath)) {
                movePathRobustSync(normalizedSourcePath, sourceBackupPath, sourceStat);
            }
            if (fs.existsSync(sourceBackupPath)) {
                importSourcePath = sourceBackupPath;
                importSourceStat = fs.statSync(sourceBackupPath);
            }
        }
        if (importSourceStat.isDirectory()) {
            copyPathRecursive(importSourcePath, targetPath, importSourceStat);
        } else {
            copyFileRobustSync(importSourcePath, targetPath, importSourceStat);
        }
    } else if (importSourceStat.isDirectory()) {
        copyPathRecursive(importSourcePath, targetPath, importSourceStat);
    } else {
        copyFileRobustSync(importSourcePath, targetPath, importSourceStat);
    }

    return {
        relativePath: toMarkdownRelativeLink(
            shouldTreatAsImage
                ? path.join('attachments', IMAGE_RESOURCE_DIR_NAME, entryName)
                : path.join('attachments', entryName)
        ),
        kind: shouldTreatAsImage ? 'image' : 'attachment',
        absolutePath: targetPath
    };
}

async function importReferencedEntryIntoCurrentBundleAsync(absolutePath, options = {}) {
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

    const normalizedSourceBundlePath = path.resolve(sourceBundlePath);
    const shouldMoveSourceEntry = Boolean(options.move) && normalizedSourceBundlePath !== currentBundlePath;

    const relativeInsideBundle = path.relative(sourceBundlePath, normalizedSourcePath).replace(/\\/g, '/');
    if (!relativeInsideBundle || relativeInsideBundle.startsWith('..')) {
        return null;
    }

    const topLevelDir = relativeInsideBundle.split('/')[0];
    const sourceStat = await fs.promises.stat(normalizedSourcePath);
    const shouldTreatAsImage = (
        (topLevelDir === IMAGE_RESOURCE_DIR_NAME || topLevelDir === LEGACY_IMAGE_RESOURCE_DIR_NAME || topLevelDir === 'attachments')
        && !sourceStat.isDirectory()
        && isImageFilePath(normalizedSourcePath)
    );

    if (path.resolve(sourceBundlePath) === currentBundlePath) {
        return {
            relativePath: shouldTreatAsImage
                ? toMarkdownRelativeLink(normalizeImageResourceHrefForWrite(relativeInsideBundle))
                : toMarkdownRelativeLink(relativeInsideBundle),
            kind: shouldTreatAsImage ? 'image' : 'attachment',
            absolutePath: normalizedSourcePath
        };
    }

    const targetRootDir = shouldTreatAsImage
        ? getImageResourceDirPath(currentBundlePath)
        : path.join(currentBundlePath, 'attachments');
    ensureDirectory(targetRootDir);

    const entryName = generateUniqueEntryName(targetRootDir, path.basename(normalizedSourcePath));
    const targetPath = path.join(targetRootDir, entryName);
    const targetHistoryEntryId = createHistoryEntryId();
    const targetHistoryEntryName = shouldTreatAsImage
        ? path.join(IMAGE_RESOURCE_DIR_NAME, entryName)
        : entryName;
    let importSourcePath = normalizedSourcePath;
    let importSourceStat = sourceStat;
    let sourceHistoryEntryId = '';
    let sourceBackupPath = '';
    const backupInfo = shouldMoveSourceEntry
        ? getBundleEntryBackupInfo(normalizedSourcePath, normalizedSourceBundlePath)
        : null;

    if (shouldMoveSourceEntry && backupInfo) {
        sourceHistoryEntryId = createHistoryEntryId();
        sourceBackupPath = path.join(
            getSessionHistoryEntryRoot(normalizedSourceBundlePath, sourceHistoryEntryId),
            backupInfo.kind,
            backupInfo.entryName
        );
        if (moveEntryToSessionHistoryForBundle(
            normalizedSourceBundlePath,
            backupInfo.kind,
            backupInfo.entryName,
            sourceHistoryEntryId
        )) {
            importSourcePath = sourceBackupPath;
            importSourceStat = await fs.promises.stat(sourceBackupPath);
        }
    }

    const historyStep = {
        kind: 'attachment-import',
        label: '导入引用附件',
        async undo() {
            let didUndo = true;
            if (fs.existsSync(targetPath)) {
                didUndo = moveEntryToSessionHistoryForBundle(
                    currentBundlePath,
                    'attachments',
                    targetHistoryEntryName,
                    targetHistoryEntryId
                );
            }
            if (shouldMoveSourceEntry && sourceBackupPath && fs.existsSync(sourceBackupPath)) {
                if (!fs.existsSync(normalizedSourcePath)) {
                    didUndo = restoreEntryFromSessionHistoryForBundle(
                        normalizedSourceBundlePath,
                        backupInfo.kind,
                        backupInfo.entryName,
                        sourceHistoryEntryId
                    ) && didUndo;
                }
            }
            return didUndo;
        },
        async redo() {
            if (shouldMoveSourceEntry && sourceBackupPath) {
                if (fs.existsSync(normalizedSourcePath)) {
                    movePathRobustSync(normalizedSourcePath, sourceBackupPath, sourceStat);
                }
            }
            return restoreEntryFromSessionHistoryForBundle(
                currentBundlePath,
                'attachments',
                targetHistoryEntryName,
                targetHistoryEntryId
            );
        }
    };

    if (activeHistoryTransaction && activeHistoryTransaction.tabId === getActiveTab()?.id) {
        recordHistoryAttachmentStep(historyStep);
    }

    if (importSourceStat.isDirectory()) {
        const folderLabel = path.basename(importSourcePath) || path.basename(normalizedSourcePath) || '附件文件夹';
        const totalEntries = Math.max(await countPathEntriesAsync(importSourcePath), 1);
        const progressState = { completed: 0 };
        showImportProgressModal({
            title: shouldMoveSourceEntry ? '正在剪切导入附件文件夹' : '正在复制导入附件文件夹',
            detail: `${folderLabel} · 正在处理内容…`,
            total: totalEntries,
            completed: 0
        });
        setWorkspaceBusy(shouldMoveSourceEntry ? '正在剪切导入附件文件夹…' : '正在导入附件文件夹…');
        try {
            await yieldToUiFrame();
            await copyPathRecursiveAsync(importSourcePath, targetPath, {
                totalEntries,
                progressState,
                onProgress: (completed, total) => {
                    setImportProgressModalProgress(
                        completed,
                        total,
                        `${folderLabel} · ${completed}/${total}`
                    );
                }
            });
        } finally {
            hideImportProgressModal();
            clearWorkspaceBusy();
        }
    } else {
        await copyFileRobustAsync(importSourcePath, targetPath, importSourceStat);
    }

    return {
        relativePath: toMarkdownRelativeLink(
            shouldTreatAsImage
                ? path.join('attachments', IMAGE_RESOURCE_DIR_NAME, entryName)
                : path.join('attachments', entryName)
        ),
        kind: shouldTreatAsImage ? 'image' : 'attachment',
        absolutePath: targetPath
    };
}

async function transformPastedHtmlForCurrentBundle(html) {
    if (!window.currentPath || !html || typeof window.DOMParser === 'undefined') {
        return '';
    }

    const parser = new window.DOMParser();
    const doc = parser.parseFromString(String(html), 'text/html');
    let didChange = false;

    for (const image of Array.from(doc.querySelectorAll('img[src]'))) {
        const sourcePath = resolveClipboardLocalPath(
            image.getAttribute('data-kangaroo-path') || image.getAttribute('src')
        );
        if (!sourcePath) continue;

        const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath);
        if (!imported || imported.kind !== 'image') continue;

        image.setAttribute('src', imported.relativePath);
        didChange = true;
    }

    for (const attachment of Array.from(doc.querySelectorAll('[data-kangaroo-attachment][data-href]'))) {
        const sourcePath = resolveClipboardLocalPath(
            attachment.getAttribute('data-kangaroo-path') || attachment.getAttribute('data-href')
        );
        if (!sourcePath) continue;

        const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath);
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

        const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath);
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

        const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath);
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

        const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath);
        if (!imported) continue;

        link.setAttribute('href', imported.relativePath);
        if (!String(link.textContent || '').trim()) {
            link.textContent = path.basename(imported.relativePath);
        }
        didChange = true;
    }

    return didChange ? doc.body.innerHTML : '';
}

function serializeEditorSliceJsonToHtml(editorInstance, sliceJson) {
    const schema = editorInstance?.editor?.state?.schema;
    if (!schema || !sliceJson) {
        return '';
    }

    try {
        const slice = Slice.fromJSON(schema, sliceJson);
        const container = document.createElement('div');
        const serializer = DOMSerializer.fromSchema(schema);
        const fragment = serializer.serializeFragment(slice.content, { document });
        container.appendChild(fragment);
        return container.innerHTML;
    } catch {
        return '';
    }
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
        if (absolutePath) {
            image.setAttribute('data-kangaroo-path', absolutePath);
            image.setAttribute('src', url.pathToFileURL(absolutePath).href);
        }
    }

    for (const attachment of Array.from(container.querySelectorAll('[data-kangaroo-attachment][data-href]'))) {
        let absolutePath = String(attachment.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(attachment.getAttribute('data-href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveAttachmentAbsolutePath === 'function') {
            absolutePath = String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim();
        }

        if (absolutePath) {
            attachment.setAttribute('data-kangaroo-path', absolutePath);
        }
    }

    for (const pdf of Array.from(container.querySelectorAll('[data-kangaroo-pdf][data-href]'))) {
        let absolutePath = String(pdf.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(pdf.getAttribute('data-href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveAttachmentAbsolutePath === 'function') {
            absolutePath = String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim();
        }

        if (absolutePath) {
            pdf.setAttribute('data-kangaroo-path', absolutePath);
        }
    }

    for (const link of Array.from(container.querySelectorAll('a.kangaroo-link'))) {
        let absolutePath = String(link.getAttribute('data-kangaroo-path') || '').trim();
        const href = String(link.getAttribute('href') || '').trim();

        if (!absolutePath && editorInstance && typeof editorInstance.resolveLinkDisplayMeta === 'function') {
            absolutePath = String(editorInstance.resolveLinkDisplayMeta(href)?.absolutePath || '').trim();
        }

        if (absolutePath) {
            link.setAttribute('data-kangaroo-path', absolutePath);
            link.setAttribute('href', url.pathToFileURL(absolutePath).href);
        }
    }

    return container.innerHTML;
}

function buildEditorClipboardSlicePayload(editorInstance, operation = 'copy') {
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
        attachments: {},
        bundlePath: window.currentPath || '',
        operation: operation === 'cut' ? 'cut' : 'copy'
    };

    const walk = (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;

            if (node.type === 'image') {
                const src = String(node.attrs?.src || '').trim();
                const absolutePath = src && typeof editorInstance.resolveImagePath === 'function'
                    ? String(editorInstance.resolveImagePath(src) || '').trim()
                    : '';
                if (src) {
                    payload.images[src] = absolutePath || src;
                }
            }

            if (node.type === 'kangarooAttachment') {
                const href = String(node.attrs?.href || '').trim();
                const absolutePath = href && typeof editorInstance.resolveAttachmentAbsolutePath === 'function'
                    ? String(editorInstance.resolveAttachmentAbsolutePath(href) || '').trim()
                    : '';
                if (href) {
                    payload.attachments[href] = {
                        absolutePath: absolutePath || href,
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
                if (href) {
                    payload.attachments[href] = {
                        absolutePath: absolutePath || href,
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
                if (href) {
                    payload.attachments[href] = {
                        absolutePath: absolutePath || href,
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
                if (href) {
                    payload.links[href] = absolutePath || href;
                }
            }

            if (Array.isArray(node.content)) {
                walk(node.content);
            }
        }
    };

    walk(payload.slice?.content || []);
    return JSON.stringify(payload);
}

function parseEditorClipboardSlicePayload(payloadText) {
    if (!payloadText) {
        return null;
    }

    try {
        const parsed = JSON.parse(payloadText);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

function buildEditorClipboardPlainText(editorInstance) {
    const state = editorInstance?.editor?.state;
    const selection = state?.selection;
    if (!state || !selection || selection.empty) {
        return String(window.getSelection?.() || '');
    }

    const slice = selection.content();
    const sliceJson = slice?.toJSON?.();
    const markdownManager = editorInstance?.editor?.markdown || editorInstance?.editor?.storage?.manager || null;
    const normalizeClipboardMarkdown = (value) => normalizeMarkdown(value || '').replace(/[ \t]+$/g, '');
    const sliceContainsMediaNode = (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;
            if (node.type === 'image' || node.type === 'kangarooAttachment' || node.type === 'kangarooVideo' || node.type === 'kangarooPdf') {
                return true;
            }
            if (Array.isArray(node.content) && sliceContainsMediaNode(node.content)) {
                return true;
            }
        }
        return false;
    };
    const trimBoundaryWhitespaceNodes = (nodes = []) => {
        if (!Array.isArray(nodes) || !nodes.length) {
            return nodes;
        }

        const nextNodes = nodes.map((node) => {
            if (!node || typeof node !== 'object') {
                return node;
            }

            if (Array.isArray(node.content)) {
                return {
                    ...node,
                    content: trimBoundaryWhitespaceNodes(node.content)
                };
            }

            return node;
        });

        let start = 0;
        let end = nextNodes.length;
        while (start < end) {
            const node = nextNodes[start];
            if (node?.type === 'text' && !String(node.text || '').trim()) {
                start += 1;
                continue;
            }
            break;
        }
        while (end > start) {
            const node = nextNodes[end - 1];
            if (node?.type === 'text' && !String(node.text || '').trim()) {
                end -= 1;
                continue;
            }
            break;
        }

        return nextNodes.slice(start, end);
    };

    if (markdownManager && typeof markdownManager.serialize === 'function' && sliceJson?.content) {
        try {
            const serialized = markdownManager.serialize({
                type: 'doc',
                content: sliceJson.content
            });
            const normalized = normalizeClipboardMarkdown(serialized || '');
            if (normalized) {
                return normalized;
            }
        } catch {
            // fall through to selection text
        }

        if (sliceContainsMediaNode(sliceJson.content)) {
            try {
                const serialized = markdownManager.serialize({
                    type: 'doc',
                    content: sliceJson.content
                });
                const normalized = normalizeMarkdown(serialized || '');
                if (normalized) {
                    return normalized;
                }
            } catch {
                // fall through to selection text
            }
        }

        try {
            const cleanedContent = trimBoundaryWhitespaceNodes(sliceJson.content);
            if (cleanedContent !== sliceJson.content) {
                const serialized = markdownManager.serialize({
                    type: 'doc',
                    content: cleanedContent
                });
                const normalized = normalizeClipboardMarkdown(serialized || '');
                if (normalized) {
                    return normalized;
                }
            }
        } catch {
            // fall through to selection text
        }
    }

    return String(window.getSelection?.() || '');
}

async function transformClipboardSlicePayloadForCurrentBundle(payloadText) {
    if (!payloadText) {
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
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : '';
    const sourceBundlePath = String(payload.bundlePath || '').trim();
    const isMoveOperation = String(payload.operation || '').toLowerCase() === 'cut';

    const resolvePayloadSourcePath = (sourcePath) => {
        const normalizedSourcePath = String(sourcePath || '').trim();
        if (!normalizedSourcePath) return '';
        if (path.isAbsolute(normalizedSourcePath)) return path.resolve(normalizedSourcePath);
        if (sourceBundlePath) return path.resolve(sourceBundlePath, normalizedSourcePath);
        return normalizedSourcePath;
    };

    const resolvePayloadSourcePathWithRecovery = (sourcePath) => {
        const resolvedSourcePath = resolvePayloadSourcePath(sourcePath);
        if (resolvedSourcePath && fs.existsSync(resolvedSourcePath)) {
            return {
                sourcePath: resolvedSourcePath,
                fromRecovery: false
            };
        }

        const recoveredPath = resolveRecoveredClipboardSourcePath(sourceBundlePath, sourcePath);
        if (recoveredPath) {
            return {
                sourcePath: recoveredPath,
                fromRecovery: true
            };
        }

        return {
            sourcePath: resolvedSourcePath,
            fromRecovery: false
        };
    };

    const walk = async (nodes = []) => {
        for (const node of nodes) {
            if (!node || typeof node !== 'object') continue;

            if (node.type === 'image') {
                const src = String(node.attrs?.src || '').trim();
                const sourceInfo = resolvePayloadSourcePathWithRecovery(payload.images?.[src] || src);
                const sourcePath = sourceInfo.sourcePath;
                if (sourcePath) {
                    const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath, {
                        move: isMoveOperation && !sourceInfo.fromRecovery
                    });
                    if (imported?.kind === 'image') {
                        node.attrs = {
                            ...node.attrs,
                            src: imported.relativePath
                        };
                        didChange = true;
                    } else if (!currentBundlePath && !/^(data:|https?:|file:)/i.test(sourcePath)) {
                        node.attrs = {
                            ...node.attrs,
                            src: url.pathToFileURL(sourcePath).href
                        };
                        didChange = true;
                    }
                }
            }

            if (node.type === 'kangarooAttachment') {
                const href = String(node.attrs?.href || '').trim();
                const attachmentPayload = payload.attachments?.[href];
                const sourceInfo = typeof attachmentPayload === 'string'
                    ? resolvePayloadSourcePathWithRecovery(attachmentPayload || href)
                    : resolvePayloadSourcePathWithRecovery(attachmentPayload?.absolutePath || href);
                const sourcePath = sourceInfo.sourcePath;
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                const targetNodeType = typeof attachmentPayload === 'string'
                    ? 'kangarooAttachment'
                    : String(attachmentPayload?.nodeType || 'kangarooAttachment').trim() || 'kangarooAttachment';
                if (sourcePath) {
                    const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath, {
                        move: isMoveOperation && !sourceInfo.fromRecovery
                    });
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
                    } else if (!currentBundlePath) {
                        const fallbackHref = path.isAbsolute(sourcePath)
                            ? sourcePath
                            : resolvePayloadSourcePath(sourcePath);
                        node.type = targetNodeType;
                        node.attrs = {
                            ...node.attrs,
                            href: fallbackHref,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(fallbackHref)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            identity: null
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
                const sourceInfo = typeof attachmentPayload === 'string'
                    ? resolvePayloadSourcePathWithRecovery(attachmentPayload || href)
                    : resolvePayloadSourcePathWithRecovery(attachmentPayload?.absolutePath || href);
                const sourcePath = sourceInfo.sourcePath;
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                if (sourcePath) {
                    const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath, {
                        move: isMoveOperation && !sourceInfo.fromRecovery
                    });
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
                    } else if (!currentBundlePath) {
                        const fallbackHref = path.isAbsolute(sourcePath)
                            ? sourcePath
                            : resolvePayloadSourcePath(sourcePath);
                        node.type = 'kangarooAttachment';
                        node.attrs = {
                            ...node.attrs,
                            href: fallbackHref,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(fallbackHref)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            identity: null
                        };
                        didChange = true;
                    }
                }
            }

            if (node.type === 'kangarooPdf') {
                const href = String(node.attrs?.href || '').trim();
                const attachmentPayload = payload.attachments?.[href];
                const sourceInfo = typeof attachmentPayload === 'string'
                    ? resolvePayloadSourcePathWithRecovery(attachmentPayload || href)
                    : resolvePayloadSourcePathWithRecovery(attachmentPayload?.absolutePath || href);
                const sourcePath = sourceInfo.sourcePath;
                const originalLabel = typeof attachmentPayload === 'string'
                    ? ''
                    : String(attachmentPayload?.label || '').trim();
                if (sourcePath) {
                    const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath, {
                        move: isMoveOperation && !sourceInfo.fromRecovery
                    });
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
                    } else if (!currentBundlePath) {
                        const fallbackHref = path.isAbsolute(sourcePath)
                            ? sourcePath
                            : resolvePayloadSourcePath(sourcePath);
                        node.attrs = {
                            ...node.attrs,
                            href: fallbackHref,
                            label: originalLabel || String(node.attrs?.label || '').trim() || safeDecodeUri(path.basename(fallbackHref)),
                            title: typeof attachmentPayload === 'string' ? node.attrs?.title || null : attachmentPayload?.title || node.attrs?.title || null,
                            width: typeof attachmentPayload === 'string' ? node.attrs?.width || 560 : attachmentPayload?.width || node.attrs?.width || 560,
                            identity: null
                        };
                        didChange = true;
                    }
                }
            }

            for (const mark of Array.isArray(node.marks) ? node.marks : []) {
                if (mark?.type !== 'link') continue;
                const href = String(mark.attrs?.href || '').trim();
                const sourceInfo = resolvePayloadSourcePathWithRecovery(payload.links?.[href] || '');
                const sourcePath = sourceInfo.sourcePath;
                if (!sourcePath) continue;

                const imported = await importReferencedEntryIntoCurrentBundleAsync(sourcePath, {
                    move: isMoveOperation && !sourceInfo.fromRecovery
                });
                if (!imported) continue;

                mark.attrs = {
                    ...mark.attrs,
                    href: imported.relativePath
                };
                didChange = true;
            }

            if (Array.isArray(node.content)) {
                await walk(node.content);
            }
        }
    };

    await walk(nextSlice.content || []);
    return nextSlice;
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

    const eventGnomeCopiedFiles = event?.clipboardData?.getData?.('x-special/gnome-copied-files') || '';
    for (const filePath of parseClipboardFileUrls(eventGnomeCopiedFiles)) {
        paths.add(path.resolve(filePath));
    }

    for (const format of ['public.file-url', 'text/uri-list', 'x-special/gnome-copied-files']) {
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
    const bundlePath = window.currentPath;
    const imagesDir = getImageResourceDirPath(bundlePath);
    ensureDirectory(imagesDir);

    let parsedUrl;
    try {
        parsedUrl = new URL(normalizeHttpImageUrlLike(imageUrl));
    } catch {
        alert('图片地址无效，无法下载。');
        return Promise.resolve(false);
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        alert('只支持下载 http 或 https 图片。');
        return Promise.resolve(false);
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;

    return new Promise((resolve) => {
        let settled = false;
        let receivedBytes = 0;
        let filePath = '';
        const cleanupPartialFile = () => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch {
                // ignore cleanup failures
            }
        };
        const finish = (ok, message = '') => {
            if (settled) return;
            settled = true;
            if (!ok) {
                cleanupPartialFile();
                if (message) {
                    alert(message);
                }
            }
            resolve(ok);
        };

        const request = client.get(parsedUrl, (res) => {
            const statusCode = Number(res.statusCode || 0);
            const contentType = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
            const contentLength = Number(res.headers['content-length'] || 0);
            const filename = generateFileName(imagesDir, {
                extension: getImageFileExtensionFromMimeType(contentType)
            });
            filePath = path.join(imagesDir, filename);
            const historyEntryId = createHistoryEntryId();
            const historyEntryName = path.join(IMAGE_RESOURCE_DIR_NAME, filename);

            if (statusCode < 200 || statusCode >= 300) {
                res.resume();
                finish(false, `图片下载失败：HTTP ${statusCode || '未知状态'}`);
                return;
            }

            if (!contentType.startsWith('image/')) {
                res.resume();
                finish(false, '剪贴板中的远程地址不是图片资源。');
                return;
            }

            if (contentLength > REMOTE_IMAGE_MAX_BYTES) {
                res.resume();
                finish(false, '图片文件过大，已取消下载。');
                return;
            }

            const stream = fs.createWriteStream(filePath);

            res.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (receivedBytes > REMOTE_IMAGE_MAX_BYTES) {
                    request.destroy(new Error('图片文件过大，已取消下载。'));
                }
            });

            res.on('error', (error) => {
                stream.destroy();
                finish(false, `图片下载失败：${error.message}`);
            });

            stream.on('error', (error) => {
                request.destroy();
                finish(false, `保存图片失败：${error.message}`);
            });

            stream.on('finish', () => {
                stream.close(() => {
                    if (activeHistoryTransaction && activeHistoryTransaction.tabId === getActiveTab()?.id) {
                        recordHistoryAttachmentStep({
                            kind: 'attachment-import',
                            label: '下载图片',
                            undo() {
                                return moveEntryToSessionHistoryForBundle(bundlePath, 'attachments', historyEntryName, historyEntryId);
                            },
                            redo() {
                                return restoreEntryFromSessionHistoryForBundle(bundlePath, 'attachments', historyEntryName, historyEntryId);
                            }
                        });
                    }
                    if (activeHistoryTransaction && activeHistoryTransaction.tabId !== activeTabId) {
                        finish(false);
                        return;
                    }
                    const relativePath = `attachments/${IMAGE_RESOURCE_DIR_NAME}/${filename}`;
                    if (window.editor && typeof window.editor.insertImage === 'function') {
                        window.editor.insertImage(relativePath, { alt: filename });
                    } else {
                        insertMarkdown(`![image](${relativePath})\n`);
                    }
                    finish(true);
                });
            });

            res.pipe(stream);
        });

        request.setTimeout(REMOTE_IMAGE_TIMEOUT_MS, () => {
            request.destroy(new Error('图片下载超时。'));
        });

        request.on('error', (error) => {
            finish(false, `图片下载失败：${error.message}`);
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
    const markdownRegex = /!\[.*?\]\((?:\.?\/)?(?:attachments\/images|images|assets|attachments)\/([^)]+)\)/g;
    const htmlRegex = /<img\b[^>]*\bsrc\s*=\s*(?:"((?:\.?\/)?(?:attachments\/images|images|assets|attachments)\/[^"]+)"|'((?:\.?\/)?(?:attachments\/images|images|assets|attachments)\/[^']+)'|((?:\.?\/)?(?:attachments\/images|images|assets|attachments)\/[^\s>]+))[^>]*>/gi;

    let match;
    while ((match = markdownRegex.exec(markdown))) {
        const decodedPath = decodeRelativePathSegments(normalizeImageResourceRelativePath(match[1] || ''));
        const normalized = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const topLevelEntry = normalized.split('/')[0];

        if (topLevelEntry) {
            used.add(topLevelEntry);
        }
    }

    while ((match = htmlRegex.exec(markdown))) {
        const src = match[1] || match[2] || match[3] || '';
        const decodedPath = decodeRelativePathSegments(normalizeImageResourceRelativePath(src));
        const normalized = decodedPath.replace(/\\/g, '/').replace(/^\/+/, '');
        const topLevelEntry = normalized.split('/')[0];

        if (topLevelEntry) {
            used.add(topLevelEntry);
        }
    }

    return used;
}

function getUsedImageEntriesFromDocumentJson(documentJson) {
    const used = new Set();
    const root = documentJson && typeof documentJson === 'object' ? documentJson : null;
    if (!root) {
        return used;
    }

    const visit = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node.type === 'image') {
            const rawSrc = String(node.attrs?.src || '').trim();
            const normalizedSrc = decodeRelativePathSegments(normalizeImageResourceRelativePath(rawSrc));
            const normalized = normalizedSrc.replace(/\\/g, '/').replace(/^\/+/, '');
            const topLevelEntry = normalized.split('/')[0];
            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                visit(child);
            }
        }
    };

    visit(root);
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

function replaceEditorLine(lineNumber, newLineText, options = {}) {
    replaceEditorLines(lineNumber, lineNumber, [newLineText], options);
}

function replaceEditorLines(startLine, endLine, newLines, options = {}) {
    if (!isUsingFallbackEditor || !fallbackTextarea) return;

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
    if (window.currentPath) {
        registerCurrentBundleAttachmentWatchers(window.currentPath);
    } else {
        clearBundleAttachmentWatchers();
    }
    updateAddressBar(window.currentPath);
    updateWindowTitle();
}

function loadBundleContent(folderPath, content, options = {}) {
    openTabWithContent(folderPath, content, options);
    pendingWorkspaceRevealPath = null;
}

function ensureBundleStructure(folderPath) {
    if (fs.existsSync(folderPath) && !fs.statSync(folderPath).isDirectory()) {
        throw new Error("目标路径已存在同名文件，请换一个名称或先删除该文件。");
    }

    migrateLegacyRecoveryRoot(folderPath);
    ensureDirectory(folderPath);
    ensureDirectory(path.join(folderPath, 'attachments'));
    ensureDirectory(getImageResourceDirPath(folderPath));
}

function removeLegacyImageStorageDirs(folderPath) {
    if (!folderPath) return;
    removeDirectoryIfExists(getOldImageResourceDirPath(folderPath));
    removeDirectoryIfExists(getLegacyImageResourceDirPath(folderPath));
}

function writeBundlePackageToPath(folderPath, markdown, documentJson = null, sourceBundlePath = window.currentPath, options = {}) {
    ensureBundleStructure(folderPath);

    const imagesDir = getImageResourceDirPath(folderPath);
    const attachmentsDir = path.join(folderPath, 'attachments');
    const normalizedTargetBundlePath = path.resolve(String(folderPath));
    const normalizedSourceBundlePath = sourceBundlePath ? path.resolve(String(sourceBundlePath)) : '';
    const isSameBundlePath = normalizedSourceBundlePath && normalizedSourceBundlePath === normalizedTargetBundlePath;
    const resolvedMarkdown = String(markdown || '');
    const markdownForWrite = normalizeMarkdownImageResourcePaths(resolvedMarkdown);
    const nextDocumentJson = normalizeDocumentJsonImageResourcePaths(
        cloneSerializableValue(documentJson) || createDocumentJsonFromMarkdown(resolvedMarkdown) || null
    );

    if (!isSameBundlePath) {
        removeDirectoryIfExists(imagesDir);
        removeDirectoryIfExists(getOldImageResourceDirPath(folderPath));
        removeDirectoryIfExists(getLegacyImageResourceDirPath(folderPath));
        removeDirectoryIfExists(attachmentsDir);
    }
    ensureDirectory(imagesDir);
    ensureDirectory(attachmentsDir);

    if (sourceBundlePath && fs.existsSync(sourceBundlePath) && !isSameBundlePath) {
        const usedImageEntries = nextDocumentJson
            ? getUsedImageEntriesFromDocumentJson(nextDocumentJson)
            : getUsedImageEntries(resolvedMarkdown);
        copyUsedImageEntriesToAttachments(sourceBundlePath, folderPath, usedImageEntries);
        const usedAttachmentEntries = nextDocumentJson
            ? getUsedAttachmentEntriesFromDocumentJson(nextDocumentJson)
            : getUsedAttachmentEntries(resolvedMarkdown, {
                preferEditorState: Boolean(
                    sourceBundlePath
                    && window.currentPath
                    && path.resolve(sourceBundlePath) === path.resolve(window.currentPath)
                )
            });
        copyNamedEntries(
            path.join(sourceBundlePath, 'attachments'),
            attachmentsDir,
            usedAttachmentEntries
        );
    } else if (sourceBundlePath && fs.existsSync(sourceBundlePath) && isSameBundlePath) {
        const usedImageEntries = nextDocumentJson
            ? getUsedImageEntriesFromDocumentJson(nextDocumentJson)
            : getUsedImageEntries(resolvedMarkdown);
        copyUsedImageEntriesToAttachments(sourceBundlePath, folderPath, usedImageEntries);
    }

    const existingManifest = readJsonFileIfExists(getBundleManifestPath(folderPath));
    const nextManifest = buildBundleManifest(folderPath, {
        existingManifest,
        title: options.title || getBundleDisplayTitleFromManifest(folderPath),
        documentId: options.documentId || existingManifest?.documentId || null
    });

    writeJsonFile(getBundleManifestPath(folderPath), nextManifest);
    if (nextDocumentJson) {
        writeJsonFile(getBundleDocumentJsonPath(folderPath), nextDocumentJson);
    } else {
        const staleDocumentJsonPath = getBundleDocumentJsonPath(folderPath);
        if (staleDocumentJsonPath && fs.existsSync(staleDocumentJsonPath)) {
            try {
                fs.rmSync(staleDocumentJsonPath, { force: true });
            } catch {
                // ignore cleanup failures
            }
        }
    }

    const markdownFilePath = resolveBundleMarkdownFilePath(folderPath, {
        preferredName: DEFAULT_BUNDLE_MARKDOWN_FILE,
        createIfMissing: true
    });
    fs.writeFileSync(markdownFilePath, markdownForWrite, 'utf-8');

    removeLegacyImageStorageDirs(folderPath);

    return {
        manifest: nextManifest,
        documentJson: nextDocumentJson,
        markdownPath: markdownFilePath
    };
}

function saveBundleSnapshotToPath(folderPath, markdown, sourceBundlePath = window.currentPath, documentJson = null, options = {}) {
    return writeBundlePackageToPath(folderPath, markdown, documentJson, sourceBundlePath, options);
}

function needsBundleFormatMigration(bundlePath) {
    if (!bundlePath) return false;

    const normalizedBundlePath = path.resolve(String(bundlePath));
    if (!fs.existsSync(normalizedBundlePath)) {
        return false;
    }

    try {
        if (!fs.statSync(normalizedBundlePath).isDirectory()) {
            return false;
        }
    } catch {
        return false;
    }

    const bundleName = path.basename(normalizedBundlePath).toLowerCase();
    if (bundleName.endsWith(LEGACY_BUNDLE_EXTENSIONS[0])) {
        return true;
    }

    return fs.existsSync(path.join(normalizedBundlePath, LEGACY_BUNDLE_MARKDOWN_FILE));
}

function migrateBundleToKangarooFormat(bundlePath, markdown = '') {
    if (!bundlePath) {
        return '';
    }

    const normalizedSourceBundlePath = path.resolve(String(bundlePath));
    if (!needsBundleFormatMigration(normalizedSourceBundlePath)) {
        return normalizedSourceBundlePath;
    }

    const sourceMarkdownPath = resolveBundleMarkdownFilePath(normalizedSourceBundlePath, {
        preferredName: LEGACY_BUNDLE_MARKDOWN_FILE
    }) || path.join(normalizedSourceBundlePath, LEGACY_BUNDLE_MARKDOWN_FILE);
    const sourceBundleBaseName = stripKnownBundleExtension(path.basename(normalizedSourceBundlePath)) || '未命名文档';
    const targetBundlePath = path.extname(normalizedSourceBundlePath).toLowerCase() === LEGACY_BUNDLE_EXTENSIONS[0]
        ? path.join(path.dirname(normalizedSourceBundlePath), `${sourceBundleBaseName}${DEFAULT_BUNDLE_EXTENSION}`)
        : normalizedSourceBundlePath;

    if (targetBundlePath !== normalizedSourceBundlePath) {
        if (fs.existsSync(targetBundlePath)) {
            throw new Error(`目标新格式路径已存在：${path.basename(targetBundlePath)}`);
        }
        fs.renameSync(normalizedSourceBundlePath, targetBundlePath);
    }

    const sourceMarkdownPathAfterMove = targetBundlePath === normalizedSourceBundlePath
        ? sourceMarkdownPath
        : path.join(targetBundlePath, path.basename(sourceMarkdownPath));
    const targetMarkdownPath = path.join(targetBundlePath, DEFAULT_BUNDLE_MARKDOWN_FILE);
    const legacyMarkdownPath = path.join(targetBundlePath, LEGACY_BUNDLE_MARKDOWN_FILE);
    const nextMarkdownContent = String(markdown || '');

    if (fs.existsSync(targetMarkdownPath)) {
        fs.writeFileSync(targetMarkdownPath, nextMarkdownContent, 'utf-8');
    } else if (fs.existsSync(sourceMarkdownPathAfterMove)) {
        try {
            fs.renameSync(sourceMarkdownPathAfterMove, targetMarkdownPath);
        } catch {
            fs.writeFileSync(targetMarkdownPath, nextMarkdownContent, 'utf-8');
        }
    } else {
        fs.writeFileSync(targetMarkdownPath, nextMarkdownContent, 'utf-8');
    }

    if (fs.existsSync(legacyMarkdownPath) && path.resolve(legacyMarkdownPath) !== path.resolve(targetMarkdownPath)) {
        try {
            fs.rmSync(legacyMarkdownPath, { force: true });
        } catch {
            // ignore cleanup failures
        }
    }

    if (targetBundlePath !== normalizedSourceBundlePath) {
        updateWorkspaceSortSettingsAfterPathChange(normalizedSourceBundlePath, targetBundlePath);
        updateExpandedWorkspaceEntriesAfterMove(normalizedSourceBundlePath, targetBundlePath);
        updateWorkspaceTabPathsAfterMove(normalizedSourceBundlePath, targetBundlePath);
        syncWorkspaceSelectionToPath(targetBundlePath);
        workspaceTreeRenderVersion += 1;
        rerenderWorkspaceTree();
    }

    return targetBundlePath;
}

function getDefaultSaveAsPath() {
    if (window.currentPath) {
        const currentBaseName = sanitizeFileNameSegment(
            stripKnownBundleExtension(path.basename(window.currentPath)) || path.basename(window.currentPath)
        );
        if (isValidTextBundlePath(window.currentPath)) {
            return `${currentBaseName}${DEFAULT_BUNDLE_EXTENSION}`;
        }
        return sanitizeFileNameSegment(path.basename(window.currentPath));
    }

    return `我的文档${DEFAULT_BUNDLE_EXTENSION}`;
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
    const sanitizedBaseName = sanitizeFileNameSegment(stripKnownBundleExtension(baseName || '未命名文档'));
    let candidateName = `${sanitizedBaseName}${DEFAULT_BUNDLE_EXTENSION}`;
    let counter = 2;
    let candidatePath = path.join(targetDir, candidateName);

    while (fs.existsSync(candidatePath) || (reservedPaths && reservedPaths.has(path.resolve(candidatePath)))) {
        candidateName = `${sanitizedBaseName} ${counter}${DEFAULT_BUNDLE_EXTENSION}`;
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
    const bundleAttachmentsDir = path.join(bundlePath, 'attachments');
    const bundleImagesDir = getImageResourceDirPath(bundlePath);

    const rewriteLocalHref = (href, options = {}) => {
        const normalizedRef = normalizeImportSourceRef(href);
        if (!normalizedRef) {
            return href;
        }

        const resolvedSourcePath = path.resolve(sourceDir, normalizedRef);
        if (!isSameOrNestedPath(resolvedSourcePath, path.resolve(sourceRootPath)) || !fs.existsSync(resolvedSourcePath)) {
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
                bundleImagesDir,
                normalizedRefPath,
                copiedAssets,
                { flatten: true }
            );
            return toMarkdownRelativeLink(path.join('attachments', IMAGE_RESOURCE_DIR_NAME, targetRelativePath));
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

async function readBundleContentForOpenAsync(bundlePath) {
    const normalizedBundlePath = path.resolve(bundlePath);
    const markdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath, {
        createIfMissing: false
    });
    const manifestPath = getBundleManifestPath(normalizedBundlePath);
    const documentJsonPath = getBundleDocumentJsonPath(normalizedBundlePath);
    const hasPrivateStructure = fs.existsSync(manifestPath) && fs.existsSync(documentJsonPath);

    if (!markdownPath && !hasPrivateStructure) {
        throw new Error('所选文件夹缺少 text.md、text.markdown 或 private format 文件，不是有效的 Kangaroo bundle。');
    }

    const content = markdownPath && fs.existsSync(markdownPath)
        ? await fs.promises.readFile(markdownPath, 'utf-8')
        : '';

    return {
        markdownPath: markdownPath || path.join(normalizedBundlePath, DEFAULT_BUNDLE_MARKDOWN_FILE),
        content,
        manifest: hasPrivateStructure ? readJsonFileIfExists(manifestPath) : null,
        documentJson: hasPrivateStructure ? readJsonFileIfExists(documentJsonPath) : null,
        isPrivateFormat: hasPrivateStructure
    };
}

function normalizeBundleToKangarooFormat(bundlePath) {
    const normalizedBundlePath = path.resolve(bundlePath);
    ensureBundleStructure(normalizedBundlePath);

    const resolvedMarkdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath);
    if (!resolvedMarkdownPath) {
        throw new Error('所选文件夹缺少 text.md 或 text.markdown，不是有效的 Kangaroo bundle。');
    }

    const standardMarkdownPath = path.join(normalizedBundlePath, DEFAULT_BUNDLE_MARKDOWN_FILE);
    if (path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        fs.renameSync(resolvedMarkdownPath, standardMarkdownPath);
    }

    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const imagesDir = getImageResourceDirPath(normalizedBundlePath);
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
        if (!isSameOrNestedPath(resolvedSourcePath, normalizedBundlePath) || !fs.existsSync(resolvedSourcePath)) {
            return href;
        }

        const stat = fs.statSync(resolvedSourcePath);
        if (!stat.isDirectory() && isImageFilePath(resolvedSourcePath)) {
            const targetEntryName = ensureNormalizedBundleEntry(resolvedSourcePath, imagesDir, movedAssets);
            return toMarkdownRelativeLink(path.join('attachments', IMAGE_RESOURCE_DIR_NAME, targetEntryName));
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

    const savedPackage = writeBundlePackageToPath(normalizedBundlePath, nextContent, null, normalizedBundlePath, {
        title: getCanonicalBundleDisplayName(normalizedBundlePath)
    });

    return {
        markdownPath: savedPackage.markdownPath || standardMarkdownPath,
        content: nextContent
    };
}

async function normalizeBundleToKangarooFormatAsync(bundlePath) {
    const normalizedBundlePath = path.resolve(bundlePath);
    ensureBundleStructure(normalizedBundlePath);
    await yieldToUiFrame();

    const resolvedMarkdownPath = resolveBundleMarkdownFilePath(normalizedBundlePath);
    if (!resolvedMarkdownPath) {
        throw new Error('所选文件夹缺少 text.md 或 text.markdown，不是有效的 Kangaroo bundle。');
    }

    const standardMarkdownPath = path.join(normalizedBundlePath, DEFAULT_BUNDLE_MARKDOWN_FILE);
    if (path.resolve(resolvedMarkdownPath) !== path.resolve(standardMarkdownPath)) {
        await fs.promises.rename(resolvedMarkdownPath, standardMarkdownPath);
    }

    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const imagesDir = getImageResourceDirPath(normalizedBundlePath);
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
        if (!isSameOrNestedPath(resolvedSourcePath, normalizedBundlePath) || !fs.existsSync(resolvedSourcePath)) {
            return href;
        }

        const stat = await fs.promises.stat(resolvedSourcePath);
        if (!stat.isDirectory() && isImageFilePath(resolvedSourcePath)) {
            const targetEntryName = await ensureNormalizedBundleEntryAsync(resolvedSourcePath, imagesDir, movedAssets);
            return toMarkdownRelativeLink(path.join('attachments', IMAGE_RESOURCE_DIR_NAME, targetEntryName));
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

    const savedPackage = writeBundlePackageToPath(normalizedBundlePath, nextContent, null, normalizedBundlePath, {
        title: getCanonicalBundleDisplayName(normalizedBundlePath)
    });

    return {
        markdownPath: savedPackage.markdownPath || standardMarkdownPath,
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
        writeBundlePackageToPath(bundlePath, transformedContent, null, null, {
            title: path.basename(bundlePath, DEFAULT_BUNDLE_EXTENSION)
        });
        importedBundlePaths.push(bundlePath);
    }

    return importedBundlePaths;
}

async function handleOpenBundle() {
    try {
        const folderPath = await ipcRenderer.invoke('dialog:openBundle');

        if (folderPath) {
            await waitForEditorReady();
            const normalized = await readBundleContentForOpenAsync(folderPath);
            loadBundleContent(folderPath, normalized.content, normalized);
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

        if (workspaceRootPath && isSameOrNestedPath(path.resolve(targetFolderPath), path.resolve(workspaceRootPath))) {
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
        const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
        if (!options.skipConfirm && currentBundlePath !== normalizedPath) {
            const shouldContinue = await confirmUnsavedChanges('打开文档');
            if (!shouldContinue) {
                return false;
            }
        }
        await waitForEditorReady();
        const normalized = await readBundleContentForOpenAsync(normalizedPath);
        loadBundleContent(normalizedPath, normalized.content, normalized);
        ipcRenderer.send('bundle:clearPendingOpen', normalizedPath);
        return true;
    } catch (err) {
        alert(`打开失败: ${err.message}`);
        return false;
    }
}

async function handleNewBundle() {
    try {
        const folderPath = await ipcRenderer.invoke('dialog:createBundle');

        if (folderPath) {
            await waitForEditorReady();
            ensureBundleStructure(folderPath);

            const initialContent = "# 新建文档\n\n在此开始编写内容...";
            writeBundlePackageToPath(folderPath, initialContent, null, null, {
                title: getDefaultBundleTitleFromPath(folderPath)
            });
            const normalized = await readBundleContentForOpenAsync(folderPath);
            loadBundleContent(folderPath, normalized.content, normalized);
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
        const documentJson = typeof window.editor.getDocumentJson === 'function'
            ? cloneSerializableValue(window.editor.getDocumentJson())
            : null;
        const savedPackage = saveBundleSnapshotToPath(normalizedTargetPath, markdown, window.currentPath, documentJson, {
            title: getDefaultBundleTitleFromPath(normalizedTargetPath)
        });
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
            activeTab.documentJson = savedPackage.documentJson || documentJson;
            activeTab.manifest = savedPackage.manifest || activeTab.manifest;
            activeTab.isDirty = false;
            activeTab.preservedEntries = [];
            renderEditorTabs();
        }
        persistPinnedEditorTabPathsFromOpenTabs();
        refreshHistoryPanelIfVisible(normalizedTargetPath);
        return true;
    } catch (error) {
        alert(`另存为失败: ${error.message}`);
        return false;
    }
}

function getDefaultExportHtmlPath(tab) {
    const exportTitle = sanitizeFileNameSegment(getTabTitle(tab) || '未命名文档');

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
        const liveMarkdown = typeof window.editor.getValue === 'function'
            ? window.editor.getValue()
            : '';
        persistActiveTabState(liveMarkdown);
        return liveMarkdown;
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
    if (normalizedHref.startsWith(`attachments/${IMAGE_RESOURCE_DIR_NAME}/`)) return 'image';
    if (normalizedHref.startsWith('attachments/')) return 'attachment';
    if (normalizedHref.startsWith(`${IMAGE_RESOURCE_DIR_NAME}/`)) return 'image';
    if (normalizedHref.startsWith(`${LEGACY_IMAGE_RESOURCE_DIR_NAME}/`)) return 'asset';
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
        const assetPath = resolveExportAssetPath(src, bundlePath);
        const isEmbeddedImage = resourceType === 'image' || resourceType === 'asset' || (resourceType === 'attachment' && isImageFilePath(assetPath));
        if (!isEmbeddedImage) {
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

        if (resourceType === 'image') {
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
    const renderedHtml = sanitizeRenderedHtml(getMarkdownRenderer().render(markdown || ''));
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
            font: 17px/1.72 "Libre Baskerville", "Noto Serif SC", "Palatino Linotype", serif;
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
            font-family: "IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Helvetica Neue", sans-serif;
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
            font-family: "Maple Mono Normal NL CN", "IBM Plex Mono", "JetBrains Mono", "Fira Code", monospace;
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
            font-family: "IBM Plex Sans", "Noto Sans SC", "Segoe UI", "Helvetica Neue", sans-serif;
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

        if (!isUsingFallbackEditor) {
            return;
        }
    }

    const { startLine, endLine } = getEditorSelectedLineRange();
    const nextLines = [];

    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
        nextLines.push(normalizeLineAsTodo(getEditorLineText(lineNumber), false));
    }

    replaceEditorLines(startLine, endLine, nextLines, { preserveViewport: true });
}

function updateTaskLineCheckedState(lineNumber, checked) {
    const nextChecked = Boolean(checked);
    const todoItems = window.editor && typeof window.editor.getTodoItems === 'function'
        ? window.editor.getTodoItems()
        : [];
    const matchedTodo = todoItems.find((item) => Number(item?.lineNumber) === Number(lineNumber)) || null;
    if (!matchedTodo) return;

    const wasChecked = Boolean(matchedTodo.checked);
    if (window.editor && typeof window.editor.setTaskCheckedByKindIndex === 'function') {
        const didUpdate = window.editor.setTaskCheckedByKindIndex(matchedTodo.kindIndex, nextChecked);
        if (!didUpdate) {
            return;
        }
    }

    if (nextChecked !== wasChecked) {
        const activeTab = getActiveTab();
        const bundlePath = activeTab?.path || window.currentPath || null;
        if (bundlePath) {
            upsertTodoCompletedTimelineEvent({
                bundlePath,
                text: stripTodoCompletionTimestamp(matchedTodo.text || ''),
                lineNumber,
                kindIndex: matchedTodo.kindIndex,
                stableId: matchedTodo.stableId || null
            }, { checked: nextChecked });
        }
    }
}

function setSidebarTab(tab) {
    const normalizedTab = ['workspace', 'timeline', 'outline', 'todo', 'attachment', 'pomodoro'].includes(tab) ? tab : 'workspace';
    if (
        (normalizedTab === 'timeline' && !isFeatureEnabled('timeline'))
        || (normalizedTab === 'pomodoro' && !isFeatureEnabled('pomodoro'))
    ) {
        currentSidebarTab = 'workspace';
        return applyTimelinePanelVisibility(false);
    }

    currentSidebarTab = normalizedTab;

    if (normalizedTab === 'workspace') {
        return applyTimelinePanelVisibility(false);
    }

    currentRightSidebarTab = normalizedTab;
    if (normalizedTab === 'timeline') {
        return applyTimelinePanelVisibility(true);
    }

    applyTimelinePanelVisibility(true);
    if (normalizedTab === 'outline') {
        updateOutline();
    } else if (normalizedTab === 'todo') {
        renderTodoList(getActiveEditorSnapshot());
    } else if (normalizedTab === 'pomodoro') {
        renderPomodoroPanel();
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

function getDocumentJsonTextContent(node) {
    if (node == null) {
        return '';
    }

    if (typeof node === 'string') {
        return node;
    }

    if (typeof node.text === 'string' && node.text) {
        return node.text;
    }

    if (Array.isArray(node.content)) {
        return node.content.map((child) => getDocumentJsonTextContent(child)).join('');
    }

    return '';
}

function findFirstTextblockJsonNode(node) {
    if (!node || typeof node !== 'object' || !Array.isArray(node.content)) {
        return null;
    }

    return node.content.find((child) => child && typeof child === 'object' && typeof child.type === 'string' && getDocumentJsonTextContent(child).trim()) || null;
}

function getTodoItemsFromDocumentJson(documentJson) {
    const todos = [];
    const root = documentJson && typeof documentJson === 'object'
        ? documentJson
        : null;

    if (!root) {
        return todos;
    }

    let kindIndex = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node.type === 'taskItem') {
            const textNode = findFirstTextblockJsonNode(node) || node;
            todos.push({
                lineNumber: kindIndex + 1,
                checked: Boolean(node.attrs?.checked),
                text: stripTodoCompletionTimestamp(String(getDocumentJsonTextContent(textNode)).trim()),
                kindIndex,
                stableId: String(node.attrs?.id || '').trim() || null,
                isStructured: true
            });
            kindIndex += 1;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
            }
        }
    };

    walk(root);
    return todos;
}

function getTodoItemsForBundlePath(bundlePath) {
    if (!bundlePath) {
        return [];
    }

    const normalizedTarget = path.resolve(bundlePath);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
    if (currentBundlePath === normalizedTarget && window.editor && typeof window.editor.getTodoItems === 'function') {
        return window.editor.getTodoItems();
    }

    const openTab = getOpenTabByBundlePath(normalizedTarget);
    if (openTab?.documentJson) {
        return getTodoItemsFromDocumentJson(openTab.documentJson);
    }

    const manifestPath = getBundleManifestPath(normalizedTarget);
    const documentJsonPath = getBundleDocumentJsonPath(normalizedTarget);
    if (fs.existsSync(manifestPath) && fs.existsSync(documentJsonPath)) {
        const documentJson = readJsonFileIfExists(documentJsonPath);
        if (documentJson) {
            return getTodoItemsFromDocumentJson(documentJson);
        }
    }
    return [];
}

function getDocumentJsonForBundlePath(bundlePath) {
    if (!bundlePath) {
        return null;
    }

    const normalizedTarget = path.resolve(bundlePath);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
    if (currentBundlePath === normalizedTarget && window.editor && typeof window.editor.getDocumentJson === 'function') {
        return cloneSerializableValue(window.editor.getDocumentJson());
    }

    const openTab = getOpenTabByBundlePath(normalizedTarget);
    if (openTab?.documentJson) {
        return cloneSerializableValue(openTab.documentJson);
    }

    const manifestPath = getBundleManifestPath(normalizedTarget);
    const documentJsonPath = getBundleDocumentJsonPath(normalizedTarget);
    if (!fs.existsSync(manifestPath) || !fs.existsSync(documentJsonPath)) {
        return null;
    }

    return readJsonFileIfExists(documentJsonPath);
}

async function persistTodoBundleUpdate(bundlePath, nextMarkdown, nextDocumentJson = null, options = {}) {
    if (!bundlePath) {
        return false;
    }

    const normalizedTarget = path.resolve(bundlePath);
    const openTab = getOpenTabByBundlePath(normalizedTarget);
    const targetTitle = options.title || getDefaultBundleTitleFromPath(normalizedTarget);

    writeBundlePackageToPath(normalizedTarget, nextMarkdown, nextDocumentJson, normalizedTarget, {
        title: targetTitle
    });

    if (openTab) {
        openTab.content = nextMarkdown;
        openTab.documentJson = cloneSerializableValue(nextDocumentJson);
        openTab.previousContent = nextMarkdown;
        openTab.previousIsDirty = false;
        openTab.isDirty = false;
    }

    if (options.refreshWorkspaceTree && workspaceRootPath && isSameOrNestedPath(normalizedTarget, path.resolve(workspaceRootPath))) {
        scheduleWorkspaceTreeRefresh();
    }

    if (timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        scheduleTimelinePanelRender();
    }
    if (currentRightSidebarTab === 'todo') {
        renderTodoList(getActiveEditorSnapshot());
    }

    return true;
}

async function appendTodoToBundlePath(bundlePath, todoText = '') {
    if (!bundlePath) {
        return false;
    }

    const normalizedTarget = path.resolve(bundlePath);
    const nextTodoText = getDefaultTodoText(todoText);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;

    if (currentBundlePath === normalizedTarget && window.editor) {
        const currentDocumentJson = cloneSerializableValue(window.editor.getDocumentJson?.() || null)
            || getDocumentJsonForBundlePath(normalizedTarget)
            || null;
        const nextDocumentJson = appendTodoTaskToDocumentJson(currentDocumentJson, nextTodoText);
        if (!nextDocumentJson) {
            return false;
        }
        const nextTaskStableId = getTodoItemsFromDocumentJson(nextDocumentJson).slice(-1)[0]?.stableId || '';

        const applied = typeof window.editor.setDocumentJson === 'function'
            ? window.editor.setDocumentJson(nextDocumentJson, {
                emitChange: false,
                preserveSelection: true,
                forceRebuild: true
            })
            : false;
        if (!applied) {
            return false;
        }

        if (!await saveFile({ silent: true })) {
            return false;
        }

        if (timelinePanelOpen && currentRightSidebarTab === 'timeline') {
            queueTimelineTodoInlineEdit(normalizedTarget, nextTaskStableId, nextTodoText);
        }
        scheduleTimelinePanelRender();
        if (currentRightSidebarTab === 'todo') {
            renderTodoList(getActiveEditorSnapshot());
        }
        return true;
    }

    const currentDocumentJson = getDocumentJsonForBundlePath(normalizedTarget);
    if (currentDocumentJson) {
        const nextDocumentJson = appendTodoTaskToDocumentJson(currentDocumentJson, nextTodoText);
        if (!nextDocumentJson) {
            return false;
        }

        const nextMarkdown = serializeDocumentJsonToMarkdown(nextDocumentJson)
            || `${String(getMarkdownContentForBundlePath(normalizedTarget) || '').replace(/\s*$/, '')}\n\n- [ ] ${nextTodoText}\n`;
        const nextTaskStableId = getTodoItemsFromDocumentJson(nextDocumentJson).slice(-1)[0]?.stableId || '';
        const didPersist = await persistTodoBundleUpdate(normalizedTarget, nextMarkdown, nextDocumentJson, {
            title: getDefaultBundleTitleFromPath(normalizedTarget)
        });
        if (didPersist && timelinePanelOpen && currentRightSidebarTab === 'timeline') {
            queueTimelineTodoInlineEdit(normalizedTarget, nextTaskStableId, nextTodoText);
        }
        return didPersist;
    }

    const currentMarkdown = getMarkdownContentForBundlePath(normalizedTarget);
    const nextMarkdown = currentMarkdown
        ? `${String(currentMarkdown || '').replace(/\s*$/, '')}\n\n- [ ] ${nextTodoText}\n`
        : `# ${getDefaultBundleTitleFromPath(normalizedTarget)}\n\n- [ ] ${nextTodoText}\n`;

    const didPersist = await persistTodoBundleUpdate(normalizedTarget, nextMarkdown, null, {
        title: getDefaultBundleTitleFromPath(normalizedTarget)
    });
    if (didPersist && timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        const appendedTodoItems = getTodoItemsForBundlePath(normalizedTarget);
        const lastTodo = appendedTodoItems[appendedTodoItems.length - 1] || null;
        queueTimelineTodoInlineEdit(normalizedTarget, lastTodo?.stableId || '', nextTodoText);
    }
    return didPersist;
}

function setTaskCheckedInDocumentJson(documentJson, kindIndex, checked) {
    const targetIndex = Number(kindIndex);
    if (!Number.isInteger(targetIndex) || targetIndex < 0) {
        return null;
    }

    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson) {
        return null;
    }

    let currentIndex = 0;
    let updated = false;
    const walk = (node) => {
        if (!node || typeof node !== 'object' || updated) {
            return;
        }

        if (node.type === 'taskItem') {
            if (currentIndex === targetIndex) {
                node.attrs = {
                    ...node.attrs,
                    checked: Boolean(checked)
                };
                updated = true;
                return;
            }
            currentIndex += 1;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
                if (updated) {
                    return;
                }
            }
        }
    };

    walk(nextDocumentJson);
    return updated ? nextDocumentJson : null;
}

function setTaskCheckedInDocumentJsonByStableId(documentJson, stableId, checked) {
    const targetId = String(stableId || '').trim();
    if (!targetId) {
        return null;
    }

    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson) {
        return null;
    }

    let updated = false;
    const walk = (node) => {
        if (!node || typeof node !== 'object' || updated) {
            return;
        }

        if (node.type === 'taskItem' && String(node.attrs?.id || '').trim() === targetId) {
            node.attrs = {
                ...node.attrs,
                checked: Boolean(checked)
            };
            updated = true;
            return;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
                if (updated) {
                    return;
                }
            }
        }
    };

    walk(nextDocumentJson);
    return updated ? nextDocumentJson : null;
}

function isTodoStableIdUniqueInDocumentJson(documentJson, stableId) {
    const targetId = String(stableId || '').trim();
    if (!documentJson || !targetId) {
        return false;
    }

    let matchCount = 0;
    const walk = (node) => {
        if (!node || typeof node !== 'object' || matchCount > 1) {
            return;
        }

        if (node.type === 'taskItem' && String(node.attrs?.id || '').trim() === targetId) {
            matchCount += 1;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
                if (matchCount > 1) {
                    return;
                }
            }
        }
    };

    walk(documentJson);
    return matchCount === 1;
}

function setTaskCheckedInDocumentJsonByIdentity(documentJson, todo, checked) {
    if (!documentJson) {
        return null;
    }

    const stableId = String(todo?.stableId || '').trim();
    if (stableId && isTodoStableIdUniqueInDocumentJson(documentJson, stableId)) {
        const byStableId = setTaskCheckedInDocumentJsonByStableId(documentJson, stableId, checked);
        if (byStableId) {
            return byStableId;
        }
    }

    if (Number.isInteger(todo?.kindIndex)) {
        const byKindIndex = setTaskCheckedInDocumentJson(documentJson, todo.kindIndex, checked);
        if (byKindIndex) {
            return byKindIndex;
        }
    }

    return null;
}

function getDefaultTodoText(todoText = '') {
    const normalized = String(todoText || '').trim();
    return normalized;
}

function createTodoTaskNode(todoText = '') {
    const normalizedText = getDefaultTodoText(todoText);
    return {
        type: 'taskItem',
        attrs: {
            checked: false,
            headingLevel: 0,
            id: `task-${crypto.randomUUID()}`
        },
        content: [{
            type: 'paragraph',
            ...(normalizedText ? {
                content: [{
                    type: 'text',
                    text: normalizedText
                }]
            } : {})
        }]
    };
}

function appendTodoTaskToDocumentJson(documentJson, todoText = '') {
    const nextDocumentJson = cloneSerializableValue(documentJson);
    if (!nextDocumentJson || typeof nextDocumentJson !== 'object') {
        return null;
    }

    const rootContent = Array.isArray(nextDocumentJson.content)
        ? nextDocumentJson.content
        : (nextDocumentJson.content = []);
    const taskNode = createTodoTaskNode(todoText);
    const lastNode = rootContent[rootContent.length - 1];

    if (lastNode?.type === 'taskList') {
        if (!Array.isArray(lastNode.content)) {
            lastNode.content = [];
        }
        lastNode.content.push(taskNode);
    } else {
        rootContent.push({
            type: 'taskList',
            attrs: {},
            content: [taskNode]
        });
    }

    return nextDocumentJson;
}

const TODO_COMPLETION_TIMESTAMP_REGEX = /\s*@\+(\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2})?)\s*$/;

function stripTodoCompletionTimestamp(text) {
    return String(text || '').replace(TODO_COMPLETION_TIMESTAMP_REGEX, '').trimEnd();
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
    return stripKnownBundleExtension(path.basename(bundlePath)) || '未命名';
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
    const bundlePaths = getWorkspaceBundlePaths(folderPath);
    result.push(...bundlePaths);
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

function getTodoRenderSignature(todo) {
    const base = {
        checked: Boolean(todo?.checked),
        kindIndex: Number.isInteger(todo?.kindIndex) ? todo.kindIndex : -1,
        text: String(todo?.text || ''),
        stableId: String(todo?.stableId || ''),
        structured: Boolean(todo?.isStructured)
    };

    if (!base.structured) {
        base.lineNumber = Number.isInteger(todo?.lineNumber) ? todo.lineNumber : 0;
    }

    return base;
}

function findTodoItemByIdentity(todoItems, todo = {}) {
    const items = Array.isArray(todoItems) ? todoItems : [];
    const stableId = String(todo?.stableId || '').trim();
    if (stableId) {
        const stableIdMatch = items.find((item) => String(item?.stableId || '').trim() === stableId);
        if (stableIdMatch) {
            return stableIdMatch;
        }
    }

    if (Number.isInteger(todo?.kindIndex)) {
        const kindIndexMatch = items.find((item) => Number.isInteger(item?.kindIndex) && item.kindIndex === todo.kindIndex);
        if (kindIndexMatch) {
            return kindIndexMatch;
        }
    }

    if (Number.isInteger(todo?.lineNumber)) {
        const lineMatch = items.find((item) => Number.isInteger(item?.lineNumber) && item.lineNumber === todo.lineNumber);
        if (lineMatch) {
            return lineMatch;
        }
    }

    const preferredText = stripTodoCompletionTimestamp(todo?.todoText || todo?.text || '');
    if (preferredText) {
        const textMatch = items.find((item) => stripTodoCompletionTimestamp(item?.text || '') === preferredText);
        if (textMatch) {
            return textMatch;
        }
    }

    return items[0] || null;
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

function getCurrentDocumentTodoEntries(documentJson = null) {
    const activeTab = getActiveTab();
    const bundlePath = activeTab?.path || window.currentPath || null;
    const currentDocumentJson = documentJson || activeTab?.documentJson || null;
    const isCurrentBundle = window.currentPath && bundlePath && path.resolve(window.currentPath) === path.resolve(bundlePath);
    const todos = (isCurrentBundle && window.editor && typeof window.editor.getTodoItems === 'function')
        ? window.editor.getTodoItems().map((todo) => ({
            ...todo,
            isStructured: true
        }))
        : (currentDocumentJson
            ? getTodoItemsFromDocumentJson(currentDocumentJson)
            : []);

    return todos.map((todo, index) => buildTodoEntry({
        ...todo,
        kindIndex: Number.isInteger(todo.kindIndex) ? todo.kindIndex : index
    }, bundlePath, 0));
}

function getWorkspaceTodoEntries() {
    persistActiveTabState();

    const bundlePaths = getWorkspaceBundlePaths(workspaceRootPath);
    return bundlePaths.flatMap((bundlePath, documentOrder) => {
        const todos = getTodoItemsForBundlePath(bundlePath);
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

function getTimelineTodoItemDisplayText(todo) {
    return stripTodoCompletionTimestamp(String(todo?.text || todo?.todoText || '').trim()) || '';
}

function getTimelineTodoDropPlacement(event, element) {
    if (!event || !element) {
        return 'after';
    }

    const rect = element.getBoundingClientRect();
    if (!rect || rect.height <= 0) {
        return 'after';
    }

    const offsetY = Number(event.clientY || 0) - rect.top;
    return offsetY < rect.height / 2 ? 'before' : 'after';
}

function cancelTimelineTodoInlineEdit() {
    if (!timelineTodoEditState) {
        return;
    }

    const { item, body, meta, input } = timelineTodoEditState;
    if (input?.parentNode) {
        input.parentNode.removeChild(input);
    }
    if (meta) {
        meta.style.display = '';
    }
    if (item) {
        item.classList.remove('editing');
    }
    if (body) {
        body.classList.remove('editing');
    }
    timelineTodoEditState = null;
}

function restoreTimelineTodoInlineEdit() {
    const state = timelineTodoEditState;
    if (!state) {
        return false;
    }

    const container = document.getElementById('timeline-panel-content');
    if (!container) {
        return false;
    }

    const bundlePath = String(state.todo?.bundlePath || '').trim();
    const stableId = String(state.todo?.stableId || '').trim();
    if (!bundlePath || !stableId) {
        return false;
    }

    const item = Array.from(container.querySelectorAll('.todo-item')).find((element) => (
        String(element.dataset?.bundlePath || '') === bundlePath
        && String(element.dataset?.stableId || '') === stableId
    )) || null;
    if (!item) {
        return false;
    }

    if (state.item === item && item.querySelector('.todo-item-edit-input')) {
        return true;
    }

    const draftText = String(state.draftText ?? state.input?.value ?? state.todo?.text ?? state.todo?.todoText ?? '');
    const previousTodo = state.todo;
    cancelTimelineTodoInlineEdit();
    return beginTimelineTodoInlineEdit(item, previousTodo, {
        initialValue: draftText
    });
}

async function commitTimelineTodoInlineEdit() {
    const state = timelineTodoEditState;
    if (!state) {
        return false;
    }

    const nextText = String(state.input?.value || '');
    const originalText = String(state.todo?.text || state.todo?.todoText || '');
    if (nextText === originalText) {
        cancelTimelineTodoInlineEdit();
        return true;
    }

    const didUpdate = await updateTimelineTodoItemText(state.todo, nextText);
    if (!didUpdate) {
        state.input?.focus();
        state.input?.select?.();
        return false;
    }

    cancelTimelineTodoInlineEdit();
    return true;
}

function beginTimelineTodoInlineEdit(item, todo, options = {}) {
    if (!item || !todo) {
        return false;
    }

    if (timelineTodoEditState?.item && timelineTodoEditState.item !== item) {
        cancelTimelineTodoInlineEdit();
    }

    const body = item.querySelector('.todo-item-body');
    const meta = body?.querySelector('.todo-item-meta');
    if (!body || !meta) {
        return false;
    }

    const currentText = getTimelineTodoItemDisplayText(todo);
    const initialValue = String(options.initialValue ?? currentText ?? '');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'todo-item-edit-input';
    input.value = initialValue;
    input.setAttribute('aria-label', '编辑待办文本');

    meta.style.display = 'none';
    body.appendChild(input);
    item.classList.add('editing');
    body.classList.add('editing');
    timelineTodoEditState = {
        item,
        body,
        meta,
        input,
        draftText: initialValue,
        todo: {
            ...todo,
            bundlePath: todo.bundlePath ? path.resolve(todo.bundlePath) : ''
        }
    };

    const stopEvent = (event) => {
        event.stopPropagation();
    };
    input.addEventListener('mousedown', stopEvent);
    input.addEventListener('click', stopEvent);
    input.addEventListener('dblclick', stopEvent);
    input.addEventListener('contextmenu', stopEvent);
    input.addEventListener('input', () => {
        if (timelineTodoEditState?.input === input) {
            timelineTodoEditState.draftText = input.value;
        }
    });
    input.addEventListener('keydown', async (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
            event.preventDefault();
            await commitTimelineTodoInlineEdit();
        } else if (event.key === 'Escape') {
            event.preventDefault();
            cancelTimelineTodoInlineEdit();
        }
    });
    input.addEventListener('blur', () => {
        window.requestAnimationFrame(() => {
            if (timelineTodoEditState?.input !== input) {
                return;
            }
            if (!input.isConnected) {
                return;
            }
            void commitTimelineTodoInlineEdit();
        });
    });

    window.requestAnimationFrame(() => {
        input.focus();
        input.select();
    });

    return true;
}

function queueTimelineTodoInlineEdit(bundlePath, stableId, todoText = '') {
    const normalizedBundlePath = bundlePath ? path.resolve(bundlePath) : '';
    const normalizedStableId = String(stableId || '').trim();
    if (!normalizedBundlePath || !normalizedStableId) {
        pendingTimelineTodoInlineEditTarget = null;
        return false;
    }

    pendingTimelineTodoInlineEditTarget = {
        bundlePath: normalizedBundlePath,
        stableId: normalizedStableId,
        todoText: String(todoText || '')
    };
    return true;
}

function tryActivatePendingTimelineTodoInlineEdit() {
    if (!pendingTimelineTodoInlineEditTarget || !timelinePanelOpen || currentRightSidebarTab !== 'timeline') {
        return false;
    }

    const container = document.getElementById('timeline-panel-content');
    if (!container) {
        return false;
    }

    const { bundlePath, stableId, todoText } = pendingTimelineTodoInlineEditTarget;
    const item = Array.from(container.querySelectorAll('.todo-item')).find((element) => (
        String(element.dataset?.bundlePath || '') === bundlePath
        && String(element.dataset?.stableId || '') === stableId
    )) || null;
    if (!item) {
        return false;
    }

    const didBegin = beginTimelineTodoInlineEdit(item, {
        bundlePath,
        stableId,
        text: String(todoText || ''),
        todoText: String(todoText || '')
    });
    if (didBegin) {
        pendingTimelineTodoInlineEditTarget = null;
    }
    return didBegin;
}

function createTodoItemElement(todo, options = {}) {
    const {
        showDocumentMeta = false,
        onOpen = null,
        enableOpenOnClick = true,
        enableInlineEdit = false,
        enableContextMenu = false,
        enableDragDrop = false,
        onLocate = null,
        onDelete = null,
        onEdit = null
    } = options;

    const item = document.createElement('div');
    item.className = `todo-item${todo.checked ? ' done' : ''}`;
    item.dataset.lineNumber = String(todo.lineNumber);
    if (todo.bundlePath) {
        item.dataset.bundlePath = todo.bundlePath;
    }
    if (todo.stableId) {
        item.dataset.stableId = String(todo.stableId || '');
    }
    item.draggable = Boolean(enableDragDrop);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'todo-item-checkbox preview-task-checkbox';
    checkbox.checked = todo.checked;
    checkbox.dataset.taskLine = String(todo.lineNumber);
    checkbox.addEventListener('mousedown', (event) => {
        event.stopPropagation();
    });
    checkbox.addEventListener('click', (event) => {
        event.stopPropagation();
    });
    checkbox.addEventListener('change', async (event) => {
        event.stopPropagation();
        const nextChecked = Boolean(checkbox.checked);
        const previousChecked = Boolean(todo.checked);
        const updateKey = getTodoCheckedUpdateKey(todo);
        const updateToken = `${Date.now()}:${Math.random().toString(36).slice(2)}`;

        if (updateKey) {
            pendingTodoCheckedUpdates.set(updateKey, updateToken);
        }

        checkbox.disabled = true;
        item.classList.toggle('done', nextChecked);

        try {
            const didUpdate = await updateTodoCheckedState(todo, nextChecked);
            if (!didUpdate && (!updateKey || pendingTodoCheckedUpdates.get(updateKey) === updateToken)) {
                checkbox.checked = previousChecked;
                item.classList.toggle('done', previousChecked);
            }
        } finally {
            if (updateKey && pendingTodoCheckedUpdates.get(updateKey) === updateToken) {
                pendingTodoCheckedUpdates.delete(updateKey);
            }
            if (checkbox.isConnected) {
                checkbox.disabled = false;
            }
        }
    });

    const body = document.createElement('div');
    body.className = 'todo-item-body';

    const meta = document.createElement('div');
    meta.className = 'todo-item-meta';
    meta.innerText = showDocumentMeta
        ? `${todo.text || '(空的待办)'} · ${todo.documentTitle}`
        : `${todo.text || '(空的待办)'}`;

    body.appendChild(meta);
    item.appendChild(checkbox);
    item.appendChild(body);

    if (enableOpenOnClick) {
        item.addEventListener('click', async () => {
            await jumpToTodoEntry(todo);
            if (typeof onOpen === 'function') {
                onOpen(todo);
            }
        });
    }

    if (enableInlineEdit) {
        body.addEventListener('dblclick', (event) => {
            event.preventDefault();
            event.stopPropagation();
            const currentTodo = {
                ...todo,
                text: getTimelineTodoItemDisplayText(todo)
            };
            if (typeof onEdit === 'function') {
                const didHandle = onEdit(item, currentTodo);
                if (didHandle) {
                    return;
                }
            }
            beginTimelineTodoInlineEdit(item, currentTodo);
        });
    }

    if (enableContextMenu) {
        item.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            event.stopPropagation();
            showTimelineTodoContextMenu(event, todo, item);
        });
    }

    if (enableDragDrop) {
        item.addEventListener('dragstart', (event) => {
            timelineTodoDragState = {
                ...todo,
                bundlePath: todo.bundlePath ? path.resolve(todo.bundlePath) : ''
            };
            timelineTodoDropState = null;
            item.classList.add('dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.dropEffect = 'move';
                try {
                    event.dataTransfer.setData('application/x-kangaroo-todo+json', JSON.stringify(timelineTodoDragState));
                } catch {
                    // ignore drag data serialization failures
                }
                event.dataTransfer.setData('text/plain', timelineTodoDragState.bundlePath || '');
            }
        });
        item.addEventListener('dragover', (event) => {
            const sourceBundlePath = timelineTodoDragState?.bundlePath ? path.resolve(timelineTodoDragState.bundlePath) : '';
            const targetBundlePath = todo.bundlePath ? path.resolve(todo.bundlePath) : '';
            const sourceStableId = String(timelineTodoDragState?.stableId || '').trim();
            const targetStableId = String(todo.stableId || '').trim();
            if (!sourceBundlePath || !targetBundlePath || sourceBundlePath !== targetBundlePath || !sourceStableId || sourceStableId === targetStableId) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            const placement = getTimelineTodoDropPlacement(event, item);
            item.classList.toggle('drop-insert-before', placement === 'before');
            item.classList.toggle('drop-insert-after', placement === 'after');
            timelineTodoDropState = {
                sourceTodo: timelineTodoDragState ? {
                    ...timelineTodoDragState,
                    bundlePath: timelineTodoDragState.bundlePath ? path.resolve(timelineTodoDragState.bundlePath) : ''
                } : null,
                targetTodo: {
                    ...todo,
                    bundlePath: todo.bundlePath ? path.resolve(todo.bundlePath) : ''
                },
                placeAfter: placement === 'after',
                committed: false
            };
            if (event.dataTransfer) {
                event.dataTransfer.dropEffect = 'move';
            }
        });
        item.addEventListener('dragleave', (event) => {
            if (event.currentTarget.contains(event.relatedTarget)) {
                return;
            }
            item.classList.remove('drop-insert-before', 'drop-insert-after');
        });
        item.addEventListener('drop', async (event) => {
            const sourceBundlePath = timelineTodoDragState?.bundlePath ? path.resolve(timelineTodoDragState.bundlePath) : '';
            const targetBundlePath = todo.bundlePath ? path.resolve(todo.bundlePath) : '';
            const sourceStableId = String(timelineTodoDragState?.stableId || '').trim();
            const targetStableId = String(todo.stableId || '').trim();
            if (!sourceBundlePath || !targetBundlePath || sourceBundlePath !== targetBundlePath || !sourceStableId || sourceStableId === targetStableId) {
                return;
            }

            event.preventDefault();
            event.stopPropagation();
            const placement = item.classList.contains('drop-insert-before') ? 'before' : 'after';
            timelineTodoDropState = {
                sourceTodo: timelineTodoDragState ? {
                    ...timelineTodoDragState,
                    bundlePath: timelineTodoDragState.bundlePath ? path.resolve(timelineTodoDragState.bundlePath) : ''
                } : null,
                targetTodo: {
                    ...todo,
                    bundlePath: todo.bundlePath ? path.resolve(todo.bundlePath) : ''
                },
                placeAfter: placement === 'after',
                committed: false
            };
            clearTimelineTodoDropIndicators();
            await commitTimelineTodoDragReorder();
        });
        item.addEventListener('dragend', () => {
            const hasPendingReorder = Boolean(
                timelineTodoDropState
                && !timelineTodoDropState.committed
                && timelineTodoDropState.sourceTodo?.bundlePath
                && timelineTodoDropState.targetTodo?.bundlePath
            );
            item.classList.remove('dragging');
            if (hasPendingReorder) {
                void commitTimelineTodoDragReorder();
            }
            timelineTodoDragState = null;
            timelineTodoDropState = null;
            clearTimelineTodoDropIndicators();
        });
    }

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

    if (todo.stableId && window.editor && typeof window.editor.jumpToTaskByStableId === 'function') {
        const didJump = window.editor.jumpToTaskByStableId(todo.stableId, {
            lineNumber: todo.lineNumber,
            preservePreviewScroll: true,
            preferredText: todo.text || '',
            preferredKind: 'task'
        });
        if (didJump) {
            return;
        }
    }

    if (!Number.isInteger(todo.kindIndex)) {
        jumpEditorToLine(todo.lineNumber || 1, {
            preservePreviewScroll: true,
            preferredText: todo.text || '',
            preferredKind: 'task'
        });
        return;
    }

    jumpEditorToAnchor('task', todo.kindIndex, {
        lineNumber: todo.lineNumber,
        preservePreviewScroll: true,
        preferredText: todo.text || '',
        preferredKind: 'task'
    });
}

async function jumpToTimelineTodoEntry(todo) {
    if (!todo) return;

    if (todo.bundlePath) {
        const normalizedTarget = path.resolve(todo.bundlePath);
        const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
        if (currentBundlePath !== normalizedTarget) {
            await openBundleFromExternalPath(normalizedTarget, { skipConfirm: false });
        }
    }

    const normalizedTarget = todo.bundlePath ? path.resolve(todo.bundlePath) : null;
    const todoItems = normalizedTarget
        ? getTodoItemsForBundlePath(normalizedTarget)
        : getCurrentDocumentTodoEntries(getActiveTab()?.documentJson || null);
    const preferredText = stripTodoCompletionTimestamp(todo.todoText || todo.text || '');
    const matchedTodo = findTodoItemByIdentity(todoItems, todo);
    const targetLineNumber = Number.isInteger(matchedTodo?.lineNumber)
        ? matchedTodo.lineNumber
        : (Number.isInteger(todo.lineNumber) ? todo.lineNumber : null);
    const targetText = stripTodoCompletionTimestamp(matchedTodo?.text || preferredText || '');

    if (matchedTodo) {
        await new Promise((resolve) => {
            window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
        });
        await jumpToTodoEntry({
            ...matchedTodo,
            bundlePath: normalizedTarget || todo.bundlePath || null,
            text: targetText,
            todoText: targetText
        });
        return;
    }

    jumpEditorToLine(todo.lineNumber || 1, {
        preservePreviewScroll: true,
        preferredText: preferredText || '',
        preferredKind: 'task'
    });
}

async function focusTodoLineAfterOpen(lineNumber, preferredText = '') {
    if (!Number.isInteger(lineNumber) || lineNumber <= 0) {
        return false;
    }

    const tryFocus = () => {
        if (window.editor && typeof window.editor.refreshLineMap === 'function') {
            window.editor.refreshLineMap();
        }

        if (window.editor && typeof window.editor.scheduleFocusTaskLine === 'function') {
            window.editor.scheduleFocusTaskLine(lineNumber);
            return true;
        }

        if (window.editor && typeof window.editor.focusTaskLine === 'function' && window.editor.focusTaskLine(lineNumber)) {
            return true;
        }

        if (window.editor && typeof window.editor.jumpToLine === 'function') {
            window.editor.jumpToLine(lineNumber, {
                preservePreviewScroll: true,
                preferredText: preferredText || '',
                preferredKind: 'task'
            });
            return true;
        }

        return false;
    };

    if (tryFocus()) {
        return true;
    }

    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    if (tryFocus()) {
        return true;
    }

    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    if (tryFocus()) {
        return true;
    }

    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    return tryFocus();
}

function saveMarkdownToBundlePath(bundlePath, content) {
    if (!bundlePath) return;
    fs.writeFileSync(resolveBundleMarkdownFilePath(bundlePath, { createIfMissing: true }), content, 'utf-8');
}

async function updateTodoCheckedState(todo, checked) {
    const targetBundlePath = todo?.bundlePath || window.currentPath || null;
    if (!targetBundlePath) return false;

    const normalizedTarget = path.resolve(targetBundlePath);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
    const nextChecked = Boolean(checked);
    const wasChecked = Boolean(todo?.checked);
    const nextTodo = {
        ...todo,
        bundlePath: normalizedTarget,
        checked: nextChecked
    };

    if (currentBundlePath === normalizedTarget && window.editor) {
        let didUpdate = false;
        const liveTodoItems = typeof window.editor.getTodoItems === 'function'
            ? window.editor.getTodoItems()
            : [];
        const stableId = String(todo?.stableId || '').trim();
        const stableIdMatchCount = stableId && Array.isArray(liveTodoItems)
            ? liveTodoItems.filter((item) => String(item?.stableId || '').trim() === stableId).length
            : 0;
        if (stableId && stableIdMatchCount === 1 && typeof window.editor.setTaskCheckedByStableId === 'function') {
            didUpdate = window.editor.setTaskCheckedByStableId(todo.stableId, nextChecked);
        } else if (typeof window.editor.setTaskCheckedByKindIndex === 'function') {
            didUpdate = window.editor.setTaskCheckedByKindIndex(todo.kindIndex, nextChecked);
        }
        if (didUpdate) {
            if (nextChecked !== wasChecked) {
                upsertTodoCompletedTimelineEvent(nextTodo, { checked: nextChecked });
            }
            workspaceTodoRenderVersion += 1;
            renderTodoList(getActiveEditorSnapshot());
            return true;
        }
    }

    const openTab = getOpenTabByBundlePath(normalizedTarget);
    if (openTab) {
        const sourceDocumentJson = openTab.documentJson || getDocumentJsonForBundlePath(normalizedTarget);
        const nextDocumentJson = setTaskCheckedInDocumentJsonByIdentity(sourceDocumentJson, todo, nextChecked);
        if (!nextDocumentJson) {
            return false;
        }
        const serializedMarkdown = serializeDocumentJsonToMarkdown(nextDocumentJson);
        const nextContent = serializedMarkdown || (
            activeTabId === openTab.id && window.editor && typeof window.editor.getValue === 'function'
                ? window.editor.getValue()
                : (openTab.content || getMarkdownContentForBundlePath(normalizedTarget))
        );
        openTab.content = nextContent;
        openTab.documentJson = nextDocumentJson;
        openTab.previousContent = nextContent;
        openTab.isDirty = false;
        openTab.previousIsDirty = false;
        writeBundlePackageToPath(normalizedTarget, nextContent, nextDocumentJson, normalizedTarget, {
            title: getDefaultBundleTitleFromPath(normalizedTarget)
        });
        if (nextChecked !== wasChecked && activeTabId !== openTab.id) {
            upsertTodoCompletedTimelineEvent(nextTodo, { checked: nextChecked });
        }
        workspaceTodoRenderVersion += 1;
        if (activeTabId === openTab.id && window.editor) {
            window.editor.setValue(nextContent, { emitChange: true });
        } else {
            renderTodoList({
                markdown: nextContent,
                documentJson: nextDocumentJson
            });
        }
        return true;
    }

    const content = getMarkdownContentForBundlePath(normalizedTarget);
    const documentJson = getDocumentJsonForBundlePath(normalizedTarget);
    const nextDocumentJson = setTaskCheckedInDocumentJsonByIdentity(documentJson, todo, nextChecked);
    if (!nextDocumentJson) {
        return false;
    }
    const nextContent = serializeDocumentJsonToMarkdown(nextDocumentJson) || content;
    writeBundlePackageToPath(normalizedTarget, nextContent, nextDocumentJson, normalizedTarget, {
        title: getDefaultBundleTitleFromPath(normalizedTarget)
    });
    if (nextChecked !== wasChecked) {
        upsertTodoCompletedTimelineEvent(nextTodo, { checked: nextChecked });
    }
    workspaceTodoRenderVersion += 1;
    renderTodoList(getActiveEditorSnapshot());
    return true;
}

function renderTodoListContainer(todoContainer, todos, settings, renderKey, { workspace = false } = {}) {
    if (todoContainer.dataset.renderKey === renderKey && todoContainer.childElementCount > 0) {
        return;
    }

    todoContainer.innerHTML = '';
    todoContainer.dataset.renderKey = renderKey;

    if (!todos.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = workspace
            ? '当前工作空间还没有符合条件的待办。'
            : '当前文档还没有待办。按 Cmd+T 就能把当前段落变成待办。';
        todoContainer.appendChild(emptyState);
        return;
    }

    if (!workspace) {
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

function renderStructuredDocumentTodoList(documentJson = null) {
    const todoContainer = document.getElementById('todo-container');
    if (!todoContainer) return;

    const settings = loadTodoPanelSettings();
    const currentDocumentJson = documentJson || window.editor?.getDocumentJson?.() || getActiveTab()?.documentJson || null;
    const todos = applyTodoPanelFilters(getCurrentDocumentTodoEntries(currentDocumentJson));
    const renderKey = `todo::document::structured::${settings.hideCompleted ? '1' : '0'}::${settings.sort || ''}::${JSON.stringify(todos.map((todo) => getTodoRenderSignature(todo)))}`;
    renderTodoListContainer(todoContainer, todos, settings, renderKey, { workspace: false });
}

function renderWorkspaceTodoList() {
    const todoContainer = document.getElementById('todo-container');
    if (!todoContainer) return;

    const settings = loadTodoPanelSettings();
    const todos = getWorkspaceTodoEntries();
    const renderKey = `todo::workspace::${settings.hideCompleted ? '1' : '0'}::${settings.sort || ''}::${workspaceRootPath || ''}::${workspaceTodoRenderVersion}`;
    renderTodoListContainer(todoContainer, todos, settings, renderKey, { workspace: true });
}

function renderTodoList(context = null) {
    const settings = loadTodoPanelSettings();
    if (settings.scope === 'workspace') {
        renderWorkspaceTodoList();
        return;
    }

    const currentDocumentJson = context && typeof context === 'object'
        ? context.documentJson || null
        : (window.editor?.getDocumentJson?.() || getActiveTab()?.documentJson || null);
    renderStructuredDocumentTodoList(currentDocumentJson);
}

function getPomodoroPhaseMeta() {
    const state = ensurePomodoroState();
    switch (state.phase) {
        case 'work':
            return {
                badgeClass: 'work',
                label: '专注中',
                note: '保持专注，先把这一轮工作做完。'
            };
        case 'work-paused':
            return {
                badgeClass: 'alert',
                label: '已暂停',
                note: '当前专注已暂停。继续专注、重置时间，或直接切换到休息。'
            };
        case 'work-snooze':
            return {
                badgeClass: 'alert',
                label: '延后休息',
                note: `已延后休息 ${state.snoozeMinutes || 5} 分钟，到点会再次提醒。`
            };
        case 'work-complete':
            return {
                badgeClass: 'alert',
                label: '工作完成',
                note: '这一轮专注已经结束。现在休息，或者再推迟几分钟。'
            };
        case 'break':
            return {
                badgeClass: 'break',
                label: '休息中',
                note: '离开键盘，喝水或活动一下。'
            };
        case 'break-complete':
            return {
                badgeClass: 'alert',
                label: '休息结束',
                note: '休息时间到了。可以回到当前任务，开始下一轮专注。'
            };
        default:
            return {
                badgeClass: '',
                label: '待开始',
                note: '可以直接开始专注；如果愿意，也可以先从工作空间待办里选一个任务。'
            };
    }
}

function getPomodoroDisplayTime() {
    const state = ensurePomodoroState();
    if (isPomodoroRunningPhase(state.phase)) {
        return formatPomodoroCountdown(getPomodoroRemainingMs());
    }
    if (state.phase === 'work-paused') {
        return formatPomodoroCountdown(getPomodoroRemainingMs());
    }
    if (state.phase === 'work-complete' || state.phase === 'break-complete') {
        return '00:00';
    }
    return `${String(state.workMinutes).padStart(2, '0')}:00`;
}

function renderPomodoroPanel() {
    const container = document.getElementById('pomodoro-container');
    if (!container) return;

    ensurePomodoroState();
    container.innerHTML = '';
    container.className = 'pomodoro-panel';

    const phaseMeta = getPomodoroPhaseMeta();
    const shell = document.createElement('div');
    shell.className = 'pomodoro-shell';

    const isActiveBreak = pomodoroState.phase === 'break' || pomodoroState.phase === 'break-complete';
    const isLongBreak = isActiveBreak && Number(pomodoroState.phaseDurationMinutes || 0) > pomodoroState.breakMinutes;
    const activeMode = pomodoroCustomSettingsOpen
        ? 'custom'
        : isPomodoroRunningPhase(pomodoroState.phase) || pomodoroState.phase === 'work-paused' || pomodoroState.phase === 'work-complete' || pomodoroState.phase === 'break-complete'
            ? (isActiveBreak ? (isLongBreak ? 'long-break' : 'short-break') : 'focus')
            : pomodoroSelectedMode;
    const modeTabs = document.createElement('div');
    modeTabs.className = 'pomodoro-mode-tabs';
    const appendModeTab = ({ id, icon, label, onClick }) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pomodoro-mode-tab${activeMode === id ? ' active' : ''}`;
        button.innerHTML = `<i class="${icon}" aria-hidden="true"></i><span>${label}</span>`;
        button.addEventListener('click', onClick);
        modeTabs.appendChild(button);
    };
    appendModeTab({
        id: 'focus',
        icon: 'fa-solid fa-apple-whole',
        label: '专注',
        onClick: () => {
            selectPomodoroMode('focus');
        }
    });
    appendModeTab({
        id: 'short-break',
        icon: 'fa-solid fa-mug-saucer',
        label: '短休息',
        onClick: () => {
            selectPomodoroMode('short-break');
        }
    });
    appendModeTab({
        id: 'long-break',
        icon: 'fa-solid fa-tree',
        label: '长休息',
        onClick: () => {
            selectPomodoroMode('long-break');
        }
    });
    appendModeTab({
        id: 'custom',
        icon: 'fa-solid fa-gear',
        label: '自定义',
        onClick: () => {
            pomodoroSelectedMode = 'focus';
            pomodoroCustomSettingsOpen = !pomodoroCustomSettingsOpen;
            if (pomodoroState.phase !== 'idle') {
                stopPomodoroSession();
            }
            renderPomodoroPanel();
        }
    });

    const stage = document.createElement('div');
    stage.className = 'pomodoro-stage';

    const ring = document.createElement('div');
    const ringClass = activeMode === 'short-break' || activeMode === 'long-break'
        ? 'break'
        : phaseMeta.badgeClass;
    ring.className = `pomodoro-ring${ringClass ? ` ${ringClass}` : ''}`;
    ring.setAttribute('data-pomodoro-clock', '');
    ring.style.setProperty('--pomodoro-progress', `${Math.round(getPomodoroProgress() * 100)}%`);
    const ringContent = document.createElement('div');
    ringContent.className = 'pomodoro-ring-content';
    const ringLabel = document.createElement('div');
    ringLabel.className = 'pomodoro-ring-label';
    const preview = getPomodoroModePreview(activeMode);
    ringLabel.textContent = preview.label;
    const countdown = document.createElement('div');
    countdown.className = 'pomodoro-clock-countdown';
    countdown.setAttribute('data-pomodoro-countdown', '');
    if (pomodoroState.phase === 'idle') {
        countdown.textContent = `${String(preview.minutes).padStart(2, '0')}:00`;
    } else {
        countdown.textContent = getPomodoroDisplayTime();
    }
    const cyclePill = document.createElement('div');
    cyclePill.className = 'pomodoro-cycle-pill';
    cyclePill.setAttribute('data-pomodoro-cycle-pill', '');
    cyclePill.innerHTML = `<span aria-hidden="true">🍅</span><span>今日第 ${getPomodoroDisplayedCycleCount()} 个番茄钟</span>`;
    ringContent.appendChild(ringLabel);
    ringContent.appendChild(countdown);
    ringContent.appendChild(cyclePill);
    ring.appendChild(ringContent);

    const controls = document.createElement('div');
    controls.className = 'pomodoro-controls';
    const resetButton = document.createElement('button');
    resetButton.type = 'button';
    resetButton.className = 'pomodoro-circle-button';
    resetButton.setAttribute('aria-label', '重置');
    resetButton.innerHTML = '<i class="fa-solid fa-rotate-left" aria-hidden="true"></i>';
    resetButton.addEventListener('click', () => {
        if (pomodoroState.phase === 'work' || pomodoroState.phase === 'work-paused') {
            resetPomodoroWorkTimer();
            return;
        }
        stopPomodoroSession();
    });

    const mainButton = document.createElement('button');
    mainButton.type = 'button';
    const isPauseAction = pomodoroState.phase === 'work';
    mainButton.className = `pomodoro-main-button${isPauseAction ? ' is-pause' : ''}`;
    mainButton.setAttribute('aria-label', isPauseAction ? '暂停' : '开始');
    mainButton.innerHTML = `<span class="pomodoro-main-button-core"><i class="fa-solid ${isPauseAction ? 'fa-pause' : 'fa-play'}" aria-hidden="true"></i></span>`;
    mainButton.addEventListener('click', () => {
        if (pomodoroState.phase === 'work') {
            pausePomodoroWork();
            return;
        }
        if (pomodoroState.phase === 'work-paused') {
            resumePomodoroWork();
            return;
        }
        if (pomodoroState.phase === 'work-complete') {
            startPomodoroBreak();
            return;
        }
        if (pomodoroState.phase === 'break-complete') {
            startPomodoroWork(pomodoroState.activeTodo || pomodoroState.selectedTodo);
            return;
        }
        startPomodoroSelectedMode();
    });

    const skipButton = document.createElement('button');
    skipButton.type = 'button';
    skipButton.className = 'pomodoro-circle-button';
    skipButton.setAttribute('aria-label', '跳过');
    skipButton.innerHTML = '<i class="fa-solid fa-forward-step" aria-hidden="true"></i>';
    skipButton.addEventListener('click', () => {
        if (pomodoroState.phase === 'work' || pomodoroState.phase === 'work-paused') {
            switchPomodoroWorkToBreak();
            return;
        }
        if (pomodoroState.phase === 'break') {
            void completePomodoroPhase('break-complete');
            return;
        }
        startPomodoroBreak();
    });
    controls.appendChild(resetButton);
    controls.appendChild(mainButton);
    controls.appendChild(skipButton);

    const caption = document.createElement('div');
    caption.className = 'pomodoro-caption';
    caption.setAttribute('data-pomodoro-caption', '');
    if (isPomodoroRunningPhase(pomodoroState.phase) && Number.isFinite(pomodoroState.endsAt)) {
        caption.textContent = `结束于 ${new Date(pomodoroState.endsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    } else if (pomodoroState.phase === 'work-paused') {
        caption.textContent = '已暂停';
    } else if (pomodoroState.phase === 'idle') {
        caption.textContent = pomodoroSelectedMode === 'short-break' || pomodoroSelectedMode === 'long-break'
            ? `按播放键开始 ${preview.label}`
            : '按播放键开始专注';
    } else {
        caption.textContent = phaseMeta.note;
    }

    stage.appendChild(ring);
    stage.appendChild(controls);
    stage.appendChild(caption);

    const createDurationSlider = ({ label, value, min, max, step, onCommit }) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'pomodoro-setting';
        const head = document.createElement('div');
        head.className = 'pomodoro-setting-head';
        const labelEl = document.createElement('label');
        labelEl.textContent = label;
        const valueEl = document.createElement('span');
        valueEl.className = 'pomodoro-setting-value';
        head.appendChild(labelEl);
        head.appendChild(valueEl);

        const sliderRow = document.createElement('div');
        sliderRow.className = 'pomodoro-slider-row';
        const slider = document.createElement('input');
        slider.className = 'pomodoro-setting-range';
        slider.type = 'range';
        slider.min = String(min);
        slider.max = String(max);
        slider.step = String(step);
        const rangeHint = document.createElement('div');
        rangeHint.className = 'pomodoro-setting-range-hint';

        let currentValue = clampPomodoroMinutes(value, min, min, max, step);

        const updateSliderVisual = (nextValue) => {
            currentValue = clampPomodoroMinutes(nextValue, currentValue, min, max, step);
            const ratio = max === min ? 0 : (currentValue - min) / (max - min);
            slider.value = String(currentValue);
            slider.style.setProperty('--pomodoro-slider-progress', `${Math.round(ratio * 100)}%`);
            valueEl.textContent = `${currentValue} 分钟`;
            rangeHint.textContent = `每格 ${step} 分钟 · 范围 ${min}-${max}`;
        };

        const commitDuration = (nextValue, options = {}) => {
            const {
                render = true,
                persist = true
            } = options;
            const clampedValue = clampPomodoroMinutes(nextValue, currentValue, min, max, step);
            updateSliderVisual(clampedValue);
            onCommit(clampedValue, { render, persist });
        };

        slider.addEventListener('input', () => {
            commitDuration(slider.value, { render: false, persist: false });
        });
        slider.addEventListener('change', () => {
            commitDuration(slider.value, { render: true, persist: true });
        });

        updateSliderVisual(currentValue);
        sliderRow.appendChild(slider);

        wrapper.appendChild(head);
        wrapper.appendChild(sliderRow);
        wrapper.appendChild(rangeHint);
        return wrapper;
    };

    if (pomodoroCustomSettingsOpen) {
        const customPanel = document.createElement('div');
        customPanel.className = 'pomodoro-custom-panel';
        const settingsGrid = document.createElement('div');
        settingsGrid.className = 'pomodoro-settings-grid';
        settingsGrid.appendChild(createDurationSlider({
            label: '工作时间',
            value: pomodoroState.workMinutes,
            min: POMODORO_WORK_MIN_MINUTES,
            max: POMODORO_WORK_MAX_MINUTES,
            step: POMODORO_DURATION_STEP_MINUTES,
            onCommit: (value, options) => {
                updatePomodoroDurations(value, pomodoroState.breakMinutes, options);
            }
        }));
        settingsGrid.appendChild(createDurationSlider({
            label: '休息时间',
            value: pomodoroState.breakMinutes,
            min: POMODORO_BREAK_MIN_MINUTES,
            max: POMODORO_BREAK_MAX_MINUTES,
            step: POMODORO_DURATION_STEP_MINUTES,
            onCommit: (value, options) => {
                updatePomodoroDurations(pomodoroState.workMinutes, value, options);
            }
        }));
        customPanel.appendChild(settingsGrid);
        stage.appendChild(customPanel);
    }

    shell.appendChild(modeTabs);
    shell.appendChild(stage);
    container.appendChild(shell);
}

function updatePomodoroRuntimeDisplay() {
    const container = document.getElementById('pomodoro-container');
    if (!container || !timelinePanelOpen || currentRightSidebarTab !== 'pomodoro') {
        return;
    }

    ensurePomodoroState();

    const clock = container.querySelector('[data-pomodoro-clock]');
    const countdown = container.querySelector('[data-pomodoro-countdown]');
    const caption = container.querySelector('[data-pomodoro-caption]');
    const cyclePill = container.querySelector('[data-pomodoro-cycle-pill]');

    if (clock) {
        clock.style.setProperty('--pomodoro-progress', `${Math.round(getPomodoroProgress() * 100)}%`);
    }
    if (countdown) {
        countdown.textContent = pomodoroState.phase === 'idle'
            ? `${String(getPomodoroModePreview(pomodoroCustomSettingsOpen ? 'custom' : pomodoroSelectedMode).minutes).padStart(2, '0')}:00`
            : getPomodoroDisplayTime();
    }
    if (caption) {
        if (isPomodoroRunningPhase(pomodoroState.phase) && Number.isFinite(pomodoroState.endsAt)) {
            caption.textContent = `剩余 ${formatPomodoroCountdown(getPomodoroRemainingMs())} · 结束于 ${new Date(pomodoroState.endsAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        } else if (pomodoroState.phase === 'work-paused') {
            caption.textContent = `已暂停 · 剩余 ${formatPomodoroCountdown(getPomodoroRemainingMs())}`;
        } else if (pomodoroState.phase === 'idle') {
            const idlePreview = getPomodoroModePreview(pomodoroCustomSettingsOpen ? 'custom' : pomodoroSelectedMode);
            caption.textContent = `按播放键开始 ${idlePreview.label}`;
        } else {
            caption.textContent = `工作 ${pomodoroState.workMinutes} 分钟 / 休息 ${pomodoroState.breakMinutes} 分钟`;
        }
    }
    if (cyclePill) {
        cyclePill.innerHTML = `<span aria-hidden="true">🍅</span><span>今日第 ${getPomodoroDisplayedCycleCount()} 个番茄钟</span>`;
    }
}

function syncTodoPanelControls() {
    const settings = loadTodoPanelSettings();
    const scopeButton = document.getElementById('todo-scope-toggle');
    const scopeIcon = document.getElementById('todo-scope-toggle-icon');
    const sortButton = document.getElementById('todo-sort-toggle');
    const sortIcon = document.getElementById('todo-sort-toggle-icon');
    const hideCompletedButton = document.getElementById('todo-hide-completed-toggle');
    const hideCompletedIcon = document.getElementById('todo-hide-completed-icon');

    if (scopeButton && scopeIcon) {
        const isWorkspace = settings.scope === 'workspace';
        scopeButton.classList.toggle('active', isWorkspace);
        scopeButton.title = isWorkspace ? '切换到单个文档' : '切换到整个空间';
        scopeButton.setAttribute('aria-label', scopeButton.title);
        scopeIcon.className = isWorkspace ? 'fa-regular fa-folder-open' : 'fa-regular fa-file-lines';
    }

    if (sortButton && sortIcon) {
        const isStatus = settings.sort === 'status';
        sortButton.classList.toggle('active', isStatus);
        sortButton.title = isStatus ? '切换到按出现位置排序' : '切换到按状态排序';
        sortButton.setAttribute('aria-label', sortButton.title);
        sortIcon.className = isStatus ? 'fa-solid fa-check-double' : 'fa-solid fa-arrow-down-wide-short';
    }

    if (hideCompletedButton && hideCompletedIcon) {
        hideCompletedButton.classList.toggle('active', settings.hideCompleted);
        hideCompletedButton.title = settings.hideCompleted ? '显示已完成待办' : '隐藏已完成待办';
        hideCompletedButton.setAttribute('aria-label', hideCompletedButton.title);
        hideCompletedIcon.className = settings.hideCompleted ? 'fa-regular fa-eye-slash' : 'fa-regular fa-eye';
    }
}

function updateTodoPanelSettings(patch = {}) {
    const nextSettings = saveTodoPanelSettings({
        ...loadTodoPanelSettings(),
        ...patch
    });
    syncTodoPanelControls();
    renderTodoList(getActiveEditorSnapshot());
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

function collectAttachmentDocumentJsonRefs(documentJson, bundlePath = window.currentPath) {
    const references = [];
    const root = documentJson && typeof documentJson === 'object' ? documentJson : null;
    if (!root) {
        return references;
    }

    const normalizedBundlePath = bundlePath ? path.resolve(String(bundlePath)) : '';
    let kindIndex = 0;

    const visit = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        const typeName = String(node.type || '');
        let rawRelativePath = '';
        let label = '';
        let isDirectory = false;

        if (typeName === 'image') {
            rawRelativePath = String(node.attrs?.src || '');
            label = String(node.attrs?.alt || node.attrs?.title || '') || path.basename(rawRelativePath);
        } else if (typeName === 'kangarooAttachment') {
            rawRelativePath = String(node.attrs?.href || node.attrs?.src || '');
            label = String(node.attrs?.label || node.attrs?.title || '') || path.basename(rawRelativePath);
            isDirectory = Boolean(node.attrs?.isDirectory);
        } else if (typeName === 'kangarooVideo' || typeName === 'kangarooPdf') {
            rawRelativePath = String(node.attrs?.href || node.attrs?.src || '');
            label = String(node.attrs?.label || node.attrs?.title || '') || path.basename(rawRelativePath);
        }

        if (rawRelativePath) {
            const normalizedRelativePath = normalizeAttachmentMarkdownHref(rawRelativePath);
            const fullRelativePath = normalizedRelativePath.startsWith('attachments/')
                ? normalizedRelativePath
                : path.join('attachments', normalizedRelativePath);
            const absolutePath = normalizedBundlePath
                ? path.resolve(normalizedBundlePath, fullRelativePath)
                : path.resolve(fullRelativePath);
            let stat = null;
            try {
                stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
            } catch {
                stat = null;
            }

            references.push({
                label: label || path.basename(fullRelativePath),
                relativePath: fullRelativePath,
                absolutePath,
                lineNumber: kindIndex + 1,
                kindIndex,
                exists: Boolean(stat),
                isDirectory: Boolean(isDirectory || (stat && stat.isDirectory()))
            });
            kindIndex += 1;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                visit(child);
            }
        }
    };

    visit(root);
    return references;
}

function normalizeAttachmentRelativePath(relativePath) {
    return String(relativePath || '')
        .replace(/^attachments\//i, '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '');
}

function getAttachmentTopLevelEntryName(relativePath) {
    const normalized = normalizeAttachmentRelativePath(relativePath);
    if (!normalized) {
        return '';
    }

    return normalized.split('/')[0] || '';
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

function getAttachmentDirectoryEntries(attachmentsDir) {
    if (!attachmentsDir || !fs.existsSync(attachmentsDir)) {
        return [];
    }

    let entries = [];
    try {
        entries = fs.readdirSync(attachmentsDir, { withFileTypes: true });
    } catch {
        return [];
    }

    return entries
        .filter((entry) => entry.name !== IMAGE_RESOURCE_DIR_NAME)
        .filter((entry) => !entry.name.startsWith('.'))
        .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1;
            if (!a.isDirectory() && b.isDirectory()) return 1;
            return a.name.localeCompare(b.name, 'zh-Hans-CN');
        })
        .map((entry) => {
            const absolutePath = path.join(attachmentsDir, entry.name);
            let stat = null;
            try {
                stat = fs.lstatSync(absolutePath);
            } catch {
                stat = null;
            }

            if (!stat || stat.isSymbolicLink()) {
                return null;
            }

            return {
                name: entry.name,
                absolutePath,
                isDirectory: stat.isDirectory(),
                children: stat.isDirectory() ? getAttachmentTreeChildren(absolutePath) : [],
                size: stat.size,
                mtimeMs: Math.round(stat.mtimeMs)
            };
        })
        .filter(Boolean);
}

function getAttachmentDirectoryEntriesSignature(entries) {
    const parts = [];
    const visit = (entry, basePath = '') => {
        const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;
        parts.push(`${relativePath}:${entry.isDirectory ? 'd' : 'f'}:${entry.size || 0}:${entry.mtimeMs || 0}`);
        for (const child of entry.children || []) {
            visit(child, relativePath);
        }
    };

    for (const entry of entries || []) {
        visit(entry);
    }

    return parts.join('|');
}

function suppressAttachmentDropEvents(element) {
    if (!element) return;

    const suppress = (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.dataTransfer) {
            event.dataTransfer.dropEffect = 'none';
        }
    };

    element.addEventListener('dragenter', suppress);
    element.addEventListener('dragover', suppress);
    element.addEventListener('drop', suppress);
}

function renderAttachmentFilesystemTree(entries, container, depth = 0) {
    for (const entry of entries || []) {
        const card = document.createElement('div');
        card.className = `attachment-item attachment-orphan-card${entry.isDirectory ? ' folder' : ''}`;
        card.style.marginLeft = `${depth * 12}px`;
        card.setAttribute('draggable', 'true');
        suppressAttachmentDropEvents(card);

        const row = document.createElement('div');
        row.className = 'attachment-item-row';

        const toggle = document.createElement('div');
        toggle.className = 'attachment-toggle empty';
        toggle.innerText = '•';

        const body = document.createElement('div');
        body.className = 'attachment-body';

        const title = document.createElement('div');
        title.className = 'attachment-title';
        title.innerText = entry.name;

        const meta = document.createElement('div');
        meta.className = 'attachment-meta';
        meta.innerText = `${entry.isDirectory ? '未引用文件夹' : '未引用文件'} · ${entry.absolutePath}`;

        body.appendChild(title);
        body.appendChild(meta);
        row.appendChild(toggle);
        row.appendChild(body);
        card.appendChild(row);

        card.addEventListener('dragstart', (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer?.clearData();
            event.dataTransfer?.setData('text/plain', '');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.dropEffect = 'copy';
            }
            card.classList.add('dragging');
            startAttachmentSystemDrag(entry.absolutePath);
        });

        card.addEventListener('dragend', () => {
            card.classList.remove('dragging');
        });

        card.addEventListener('contextmenu', (event) => {
            event.preventDefault();
            showAttachmentContextMenu(event, {
                absolutePath: entry.absolutePath,
                isDirectory: entry.isDirectory,
                relativePath: path.join('attachments', path.relative(window.currentPath ? path.join(window.currentPath, 'attachments') : '', entry.absolutePath)),
                label: entry.name
            });
        });

        container.appendChild(card);

        if (entry.isDirectory && Array.isArray(entry.children) && entry.children.length) {
            const nested = document.createElement('div');
            nested.className = 'attachment-orphan-tree';
            renderAttachmentFilesystemTree(entry.children, nested, depth + 1);
            container.appendChild(nested);
        }
    }
}

function renderAttachmentChildTree(children, container, referenceLineNumber, referenceIndex, referenceLabel = '') {
    for (const child of children) {
        const item = document.createElement('div');
        item.className = `attachment-child${child.isDirectory ? ' folder' : ''}`;
        item.innerText = `${child.isDirectory ? '▸ ' : ''}${child.name}`;
        item.setAttribute('draggable', 'true');
        suppressAttachmentDropEvents(item);
        item.addEventListener('click', () => {
            jumpEditorToAnchor('attachment', referenceIndex, {
                lineNumber: referenceLineNumber,
                preservePreviewScroll: true,
                preferredText: referenceLabel || child.name,
                preferredKind: 'attachment'
            });
        });
        item.addEventListener('dragstart', (event) => {
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer?.clearData();
            event.dataTransfer?.setData('text/plain', '');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'copy';
                event.dataTransfer.dropEffect = 'copy';
            }
            item.classList.add('dragging');
            startAttachmentSystemDrag(child.absolutePath);
        });
        item.addEventListener('dragend', () => {
            item.classList.remove('dragging');
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

function hideTimelineDayContextMenu() {
    const menu = document.getElementById('timeline-day-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    timelineDayContextTarget = null;
}

function hideTimelineDiaryContextMenu() {
    const menu = document.getElementById('timeline-diary-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    timelineDiaryContextTarget = null;
}

function hideTimelineTodoContextMenu() {
    const menu = document.getElementById('timeline-todo-context-menu');
    if (!menu) return;

    menu.classList.remove('show');
    timelineTodoContextTarget = null;
}

function clearTimelineTodoDropIndicators() {
    document.querySelectorAll('.timeline-todo-group.drop-target').forEach((element) => {
        element.classList.remove('drop-target');
    });
    document.querySelectorAll('.todo-item.drop-insert-before, .todo-item.drop-insert-after').forEach((element) => {
        element.classList.remove('drop-insert-before', 'drop-insert-after');
    });
}

function markContextMenuRecentlyOpened() {
    suppressContextMenuHideUntil = Date.now() + 350;
}

const CONTEXT_MENU_MIN_WIDTHS = {
    default: 136,
    attachment: 136,
    editorLink: 152,
    previewImage: 148,
    tab: 156,
    timeline: 136,
    workspace: 152,
    workspaceSubmenu: 168
};

function positionContextMenu(menu, anchor, options = {}) {
    if (!menu || !anchor) return;

    const viewportPadding = Number.isFinite(options.viewportPadding) ? options.viewportPadding : 8;
    const kind = options.kind || menu.dataset?.contextMenuKind || 'default';
    const fallbackMinWidth = CONTEXT_MENU_MIN_WIDTHS[kind] || CONTEXT_MENU_MIN_WIDTHS.default;
    const computedStyle = window.getComputedStyle(menu);
    const computedMinWidth = Number.parseFloat(computedStyle.getPropertyValue('--context-menu-min-width'));
    const minWidth = Number.isFinite(options.minWidth)
        ? options.minWidth
        : (Number.isFinite(computedMinWidth) ? computedMinWidth : fallbackMinWidth);
    const maxWidth = Number.isFinite(options.maxWidth)
        ? options.maxWidth
        : Math.max(minWidth, window.innerWidth - (viewportPadding * 2));
    const gap = Number.isFinite(options.gap) ? options.gap : 6;

    menu.style.setProperty('--context-menu-min-width', `${minWidth}px`);
    menu.style.setProperty('--context-menu-max-width', `${maxWidth}px`);
    menu.style.minWidth = `${minWidth}px`;
    menu.style.maxWidth = `${maxWidth}px`;

    const menuWidth = Math.min(menu.offsetWidth || minWidth, maxWidth);
    const menuHeight = menu.offsetHeight || 0;

    let left;
    let top;
    const hasRectAnchor = Number.isFinite(anchor.left) && Number.isFinite(anchor.top) && Number.isFinite(anchor.right);

    if (hasRectAnchor) {
        const preferredPlacement = options.placement || 'right';
        const preferredLeft = preferredPlacement === 'left'
            ? anchor.left - menuWidth - gap
            : anchor.right + gap;
        const flippedLeft = preferredPlacement === 'left'
            ? anchor.right + gap
            : anchor.left - menuWidth - gap;
        const candidateLeft = (preferredLeft + menuWidth + viewportPadding) > window.innerWidth || preferredLeft < viewportPadding
            ? flippedLeft
            : preferredLeft;
        left = Math.min(candidateLeft, window.innerWidth - menuWidth - viewportPadding);
        top = Math.min(anchor.top, window.innerHeight - menuHeight - viewportPadding);
    } else {
        const anchorX = Number.isFinite(anchor.clientX) ? anchor.clientX : 0;
        const anchorY = Number.isFinite(anchor.clientY) ? anchor.clientY : 0;
        left = Math.min(anchorX, window.innerWidth - menuWidth - viewportPadding);
        top = Math.min(anchorY, window.innerHeight - menuHeight - viewportPadding);
    }

    menu.style.left = `${Math.max(left, viewportPadding)}px`;
    menu.style.top = `${Math.max(top, viewportPadding)}px`;
}

function showTimelineTodoContextMenu(event, todo, itemElement = null) {
    const menu = document.getElementById('timeline-todo-context-menu');
    if (!menu) return;

    hideTimelineDayContextMenu();
    hideTimelineDiaryContextMenu();
    hideAttachmentContextMenu();
    hidePreviewImageContextMenu();
    hideTabContextMenu();
    hideWorkspaceContextMenu();
    hideEditorLinkContextMenu();
    timelineTodoContextTarget = todo ? {
        ...todo,
        bundlePath: todo.bundlePath ? path.resolve(todo.bundlePath) : '',
        text: getTimelineTodoItemDisplayText(todo),
        element: itemElement || null
    } : null;

    const editButton = document.getElementById('timeline-todo-menu-edit');
    const locateButton = document.getElementById('timeline-todo-menu-locate');
    const deleteButton = document.getElementById('timeline-todo-menu-delete');
    if (editButton) {
        editButton.disabled = !timelineTodoContextTarget?.bundlePath;
    }
    if (locateButton) {
        locateButton.disabled = !timelineTodoContextTarget?.bundlePath;
    }
    if (deleteButton) {
        deleteButton.disabled = !timelineTodoContextTarget?.bundlePath;
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'timeline', minWidth: 136 });
}

function showTimelineDayContextMenu(event, dateLike) {
    const menu = document.getElementById('timeline-day-context-menu');
    if (!menu) return;

    hideTimelineDiaryContextMenu();
    timelineDayContextTarget = dateLike ? new Date(dateLike) : null;
    const openDiaryButton = document.getElementById('timeline-day-menu-open-diary');
    const newDiaryButton = document.getElementById('timeline-day-menu-new-diary');
    const deleteDiaryButton = document.getElementById('timeline-day-menu-delete-diary');
    const diaryBundlePath = timelineDayContextTarget ? findDiaryBundleForDate(timelineDayContextTarget) : '';
    if (openDiaryButton) {
        openDiaryButton.style.display = diaryBundlePath ? '' : 'none';
    }
    if (newDiaryButton) {
        newDiaryButton.disabled = !workspaceRootPath;
    }
    if (deleteDiaryButton) {
        deleteDiaryButton.style.display = diaryBundlePath ? '' : 'none';
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'timeline', minWidth: 136 });
}

function showTimelineDiaryContextMenu(event, diaryEntry) {
    const menu = document.getElementById('timeline-diary-context-menu');
    if (!menu) return;

    hideTimelineDayContextMenu();
    timelineDiaryContextTarget = diaryEntry ? {
        path: path.resolve(String(diaryEntry.path || '')),
        dateKey: String(diaryEntry.dateKey || ''),
        title: String(diaryEntry.title || '')
    } : null;

    const openDiaryButton = document.getElementById('timeline-diary-menu-open-diary');
    const deleteDiaryButton = document.getElementById('timeline-diary-menu-delete-diary');
    if (openDiaryButton) {
        openDiaryButton.disabled = !timelineDiaryContextTarget?.path;
    }
    if (deleteDiaryButton) {
        deleteDiaryButton.disabled = !timelineDiaryContextTarget?.path;
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'timeline', minWidth: 136 });
}

async function openDiaryBundleForDate(dateLike) {
    const diaryBundlePath = findDiaryBundleForDate(dateLike);
    if (!diaryBundlePath) {
        alert('这一天还没有日记。你可以先新建一个。');
        return false;
    }

    pendingWorkspaceRevealPath = path.resolve(diaryBundlePath);
    ensureWorkspacePathExpanded(diaryBundlePath);
    setWorkspaceSelectedEntryPath(diaryBundlePath);
    flashWorkspaceEntry(diaryBundlePath, 2000);
    await openWorkspaceBundle(diaryBundlePath);
    return true;
}

function showAttachmentContextMenu(event, reference) {
    const menu = document.getElementById('attachment-context-menu');
    if (!menu) return;

    attachmentContextTarget = buildAttachmentContextReference(reference) || reference;
    const target = attachmentContextTarget;
    const copyButton = document.getElementById('attachment-menu-copy-file');
    if (copyButton) {
        copyButton.style.display = target?.absolutePath ? '' : 'none';
    }
    const renameButton = document.getElementById('attachment-menu-rename');
    if (renameButton) {
        const canRenameTarget = Boolean(target?.absolutePath && fs.existsSync(target.absolutePath) && !target.isDirectory);
        renameButton.style.display = canRenameTarget ? '' : 'none';
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'attachment', minWidth: 136 });
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

function isPathInsideCurrentBundleAttachments(targetPath) {
    if (!window.currentPath || !targetPath) return false;

    const normalizedBundlePath = path.resolve(window.currentPath);
    const attachmentsDir = path.join(normalizedBundlePath, 'attachments');
    const normalizedTargetPath = path.resolve(targetPath);
    const relative = path.relative(attachmentsDir, normalizedTargetPath);

    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function syncOpenEditorAfterAttachmentRename(oldAbsolutePath, newAbsolutePath) {
    let didRepairDocument = false;

    if (window.editor && typeof window.editor.repairRenderedAttachmentNodesByAbsolutePath === 'function') {
        didRepairDocument = Boolean(window.editor.repairRenderedAttachmentNodesByAbsolutePath(oldAbsolutePath, newAbsolutePath)) || didRepairDocument;
    }

    if (window.editor && typeof window.editor.updateAttachmentReferencesAfterRename === 'function') {
        didRepairDocument = Boolean(window.editor.updateAttachmentReferencesAfterRename(oldAbsolutePath, newAbsolutePath)) || didRepairDocument;
    }

    if (
        !didRepairDocument
        && window.editor
        && typeof window.editor.getValue === 'function'
        && typeof window.editor.setValue === 'function'
    ) {
        const currentMarkdown = window.editor.getValue();
        const rewrittenMarkdown = rewriteAttachmentReferencesAfterRenameInMarkdown(
            currentMarkdown,
            oldAbsolutePath,
            newAbsolutePath
        );
        if (rewrittenMarkdown !== currentMarkdown) {
            window.editor.setValue(rewrittenMarkdown, {
                emitChange: true,
                preserveSelection: true,
                preserveViewport: true
            });
            didRepairDocument = true;
        }
    }

    if (!didRepairDocument && window.editor && typeof window.editor.refreshDisplayState === 'function') {
        didRepairDocument = Boolean(window.editor.refreshDisplayState());
    }

    const activeMarkdown = window.editor && typeof window.editor.getValue === 'function'
        ? window.editor.getValue()
        : '';
    const didSyncTabs = syncOpenTabsAfterAttachmentRename(oldAbsolutePath, newAbsolutePath, activeMarkdown);
    if (!didRepairDocument && didSyncTabs) {
        didRepairDocument = true;
    }

    const activeTab = getActiveTab();
    if (didSyncTabs && activeTab && window.editor) {
        const { markdown: nextActiveMarkdown, documentJson: nextActiveDocumentJson } = getActiveEditorSnapshot();
        activeTab.content = nextActiveMarkdown;
        activeTab.documentJson = nextActiveDocumentJson;
        activeTab.previousContent = nextActiveMarkdown;
        didRepairDocument = true;
    }

    updateOutline();
    if (workspaceRootPath) {
        invalidateWorkspaceStructureCaches();
        scheduleWorkspaceTreeRefresh();
    }

    if (window.editor) {
        persistActiveTabState(getActiveEditorSnapshot().markdown);
    }

    if (window.currentPath) {
        restoreRecoveredEntries(
            window.editor && typeof window.editor.getValue === 'function' ? window.editor.getValue() : '',
            window.editor && typeof window.editor.getDocumentJson === 'function'
                ? window.editor.getDocumentJson()
                : null
        );
        bundleAttachmentSnapshot = captureBundleAttachmentSnapshot(window.currentPath);
        bundleAttachmentSnapshotRoot = path.resolve(window.currentPath);
    }

    if (didRepairDocument) {
        suppressWorkspaceWatcherUntil = Math.max(suppressWorkspaceWatcherUntil, Date.now() + 1500);
        await saveFile({ silent: true });
    }

    capturePendingAttachmentRenameSnapshot(oldAbsolutePath, newAbsolutePath);
    return didRepairDocument || didSyncTabs;
}

async function renameBundleAttachmentAbsolutePath(absolutePath) {
    return runHistoryTransaction('重命名附件', async () => {
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
            if (window.currentPath && isSameOrNestedPath(sourcePath, path.resolve(window.currentPath))) {
                createBundleSnapshotSafely(window.currentPath, {
                    reason: 'before-attachment-rename',
                    title: '重命名附件前',
                    markdown: getTabMarkdownContent(),
                    force: true
                });
            }
            suppressBundleAttachmentWatcherUntil = Date.now() + 300;
            fs.renameSync(sourcePath, normalizedTargetPath);
            recordHistoryAttachmentStep({
                kind: 'attachment-rename',
                label: '重命名附件',
                async undo() {
                    if (!fs.existsSync(normalizedTargetPath) || fs.existsSync(sourcePath)) {
                        return false;
                    }
                    suppressBundleAttachmentWatcherUntil = Date.now() + 300;
                    fs.renameSync(normalizedTargetPath, sourcePath);
                    await syncOpenEditorAfterAttachmentRename(normalizedTargetPath, sourcePath);
                    return true;
                },
                async redo() {
                    if (!fs.existsSync(sourcePath) || fs.existsSync(normalizedTargetPath)) {
                        return false;
                    }
                    suppressBundleAttachmentWatcherUntil = Date.now() + 300;
                    fs.renameSync(sourcePath, normalizedTargetPath);
                    await syncOpenEditorAfterAttachmentRename(sourcePath, normalizedTargetPath);
                    return true;
                }
            });
            await syncOpenEditorAfterAttachmentRename(sourcePath, normalizedTargetPath);

            return true;
        } catch (error) {
            alert(`重命名失败: ${error.message}`);
            return false;
        }
    });
}

async function renameBundleAttachmentAbsolutePathToName(absolutePath, nextName) {
    return runHistoryTransaction('重命名附件', async () => {
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
            if (window.currentPath && isSameOrNestedPath(sourcePath, path.resolve(window.currentPath))) {
                createBundleSnapshotSafely(window.currentPath, {
                    reason: 'before-attachment-rename',
                    title: '重命名附件前',
                    markdown: getTabMarkdownContent(),
                    force: true
                });
            }
            suppressBundleAttachmentWatcherUntil = Date.now() + 300;
            fs.renameSync(sourcePath, normalizedTargetPath);
            recordHistoryAttachmentStep({
                kind: 'attachment-rename',
                label: '重命名附件',
                async undo() {
                    if (!fs.existsSync(normalizedTargetPath) || fs.existsSync(sourcePath)) {
                        return false;
                    }
                    suppressBundleAttachmentWatcherUntil = Date.now() + 300;
                    fs.renameSync(normalizedTargetPath, sourcePath);
                    await syncOpenEditorAfterAttachmentRename(normalizedTargetPath, sourcePath);
                    return true;
                },
                async redo() {
                    if (!fs.existsSync(sourcePath) || fs.existsSync(normalizedTargetPath)) {
                        return false;
                    }
                    suppressBundleAttachmentWatcherUntil = Date.now() + 300;
                    fs.renameSync(sourcePath, normalizedTargetPath);
                    await syncOpenEditorAfterAttachmentRename(sourcePath, normalizedTargetPath);
                    return true;
                }
            });
            await syncOpenEditorAfterAttachmentRename(sourcePath, normalizedTargetPath);

            return true;
        } catch (error) {
            alert(`重命名失败: ${error.message}`);
            return false;
        }
    });
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
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'previewImage', minWidth: 148 });
}

function showTabContextMenu(event, tabId) {
    const menu = document.getElementById('tab-context-menu');
    if (!menu) return;

    tabContextTargetId = tabId;
    const tab = getTabById(tabId);
    const pinButton = document.getElementById('tab-menu-pin-toggle');
    if (pinButton) {
        pinButton.textContent = tab?.pinned ? '取消固定标签页' : '固定标签页';
    }
    menu.classList.add('show');
    positionContextMenu(menu, event, { kind: 'tab', minWidth: 156 });
}

function toggleEditorTabPinned(tabId = tabContextTargetId || activeTabId) {
    const tab = getTabById(tabId);
    if (!tab) return false;
    const nextPinned = !Boolean(tab.pinned);
    tab.pinned = nextPinned;
    persistPinnedEditorTabPathsFromOpenTabs();
    renderEditorTabs();
    return nextPinned;
}

async function restorePinnedEditorTabs() {
    const pinnedPaths = loadPinnedEditorTabPaths();
    if (!pinnedPaths.length) {
        return;
    }

    const restoredPinnedPaths = [];
    for (const pinnedPath of pinnedPaths) {
        if (!pinnedPath) continue;
        if (!fs.existsSync(pinnedPath)) continue;
        restoredPinnedPaths.push(path.resolve(pinnedPath));
        await openBundleFromExternalPath(pinnedPath, { skipConfirm: true });
        const openTab = findTabByPath(pinnedPath);
        if (openTab) {
            openTab.pinned = true;
        }
    }

    savePinnedEditorTabPaths(restoredPinnedPaths);
    normalizeEditorTabOrder();
    renderEditorTabs();
}

function revealTabInWorkspaceTree(tabId) {
    const tab = getTabById(tabId);
    if (!tab?.path || !workspaceRootPath) return false;

    const normalizedPath = path.resolve(tab.path);
    const normalizedRoot = path.resolve(workspaceRootPath);
    if (normalizedPath !== normalizedRoot && !normalizedPath.startsWith(`${normalizedRoot}${path.sep}`)) {
        setSidebarTab('workspace');
        return false;
    }

    setSidebarTab('workspace');
    pendingWorkspaceRevealPath = normalizedPath;
    ensureWorkspacePathExpanded(normalizedPath);
    setWorkspaceSelectedEntryPath(normalizedPath);
    renderWorkspaceTree(true);
    flashWorkspaceEntry(normalizedPath, 2000);
    return true;
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
    const copyButton = document.getElementById('editor-link-menu-copy-file');
    const revealButton = document.getElementById('editor-link-menu-reveal');
    const renameButton = document.getElementById('editor-link-menu-rename');
    const isAttachmentTarget = /^attachments\//i.test(String(context.href || '').replace(/^\.?\//, ''));
    const canRenameTarget = ['attachment', 'pdf', 'video'].includes(cardKind) && Boolean(absolutePath) && fs.existsSync(absolutePath);

    if (openWithButton) {
        openWithButton.style.display = IS_MACOS && context.isPath && context.exists ? '' : 'none';
    }

    if (copyButton) {
        copyButton.style.display = absolutePath ? '' : 'none';
    }

    if (revealButton) {
        revealButton.style.display = context.isPath && context.exists ? '' : 'none';
    }

    if (renameButton) {
        renameButton.style.display = (isAttachmentTarget && canRenameTarget) ? '' : 'none';
    }

    menu.classList.add('show');
    markContextMenuRecentlyOpened();
    positionContextMenu(menu, event, { kind: 'editorLink', minWidth: 152 });
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

function getCopyableAttachmentPath(reference) {
    const absolutePath = String(
        (typeof reference === 'string' ? reference : '')
        || reference?.absolutePath
        || reference?.imagePath
        || reference?.pdfPath
        || reference?.videoPath
        || reference?.target?.value
        || reference?.displayMeta?.absolutePath
        || reference?.element?.getAttribute?.('data-kangaroo-path')
        || reference?.cardElement?.getAttribute?.('data-kangaroo-path')
        || ''
    ).trim();

    return absolutePath ? path.resolve(absolutePath) : '';
}

async function copyAttachmentFileToClipboard(reference) {
    const absolutePath = getCopyableAttachmentPath(reference);
    if (!absolutePath) {
        alert('复制附件失败: 找不到附件路径。');
        return false;
    }

    const result = await ipcRenderer.invoke('shell:copyFileTarget', {
        type: 'path',
        value: absolutePath
    });

    if (!result || !result.ok) {
        alert(`复制附件失败: ${(result && result.error) || absolutePath}`);
        return false;
    }

    return true;
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

    await renameBundleAttachmentAbsolutePath(absolutePath);
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

function refreshAttachmentPanelIfVisible() {
    if (!timelinePanelOpen || currentRightSidebarTab !== 'attachment') {
        return;
    }

    renderAttachmentList(getActiveEditorSnapshot(), true);
}

async function trashAttachmentTarget(reference) {
    if (!reference?.absolutePath) return false;

    const result = await ipcRenderer.invoke('shell:trashPath', {
        type: 'path',
        value: reference.absolutePath
    });
    if (!result || !result.ok) {
        alert(`删除失败: ${(result && result.error) || reference.absolutePath}`);
        return false;
    }

    return true;
}

function startAttachmentSystemDrag(absolutePath) {
    if (!absolutePath) return false;

    return ipcRenderer.sendSync('attachment:startDrag', {
        path: absolutePath
    }) === true;
}

async function deleteAttachmentTarget(reference) {
    if (!reference?.absolutePath) return false;

    return runHistoryTransaction('删除附件', async () => {
        const bundlePath = findContainingTextBundlePath(reference.absolutePath) || window.currentPath;
        const backupInfo = getBundleEntryBackupInfo(reference.absolutePath, bundlePath);
        const entryKind = backupInfo?.kind || 'attachments';
        const entryName = backupInfo?.entryName || path.basename(reference.absolutePath);
        const decision = await ipcRenderer.invoke('dialog:confirmDeleteAttachmentEntry', {
            entryName,
            isDirectory: Boolean(reference.isDirectory)
        });
        if (decision !== 'delete') {
            return false;
        }

        if (!bundlePath) {
            return false;
        }

        const historyEntryId = createHistoryEntryId();
        const removed = moveEntryToSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
        if (!removed) {
            return false;
        }

        recordHistoryAttachmentStep({
            kind: 'attachment-delete',
            label: '删除附件',
            undo() {
                const restored = restoreEntryFromSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
                if (restored) {
                    refreshActiveEditorAttachmentDom();
                    refreshAttachmentPanelIfVisible();
                }
                return restored;
            },
            redo() {
                const moved = moveEntryToSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
                if (moved) {
                    refreshActiveEditorAttachmentDom();
                    refreshAttachmentPanelIfVisible();
                }
                return moved;
            }
        });

        refreshAttachmentPanelIfVisible();
        if (window.editor) {
            updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
        }
        return true;
    });
}

async function deleteUnreferencedAttachments(entries) {
    const targets = Array.from(entries || []).filter((entry) => entry?.absolutePath);
    if (!targets.length) {
        return false;
    }

    return runHistoryTransaction('删除未引用附件', async () => {
        const decision = await ipcRenderer.invoke('dialog:confirmDeleteUnreferencedAttachments', {
            count: targets.length
        });
        if (decision !== 'delete') {
            return false;
        }

        setWorkspaceBusy('正在删除未引用附件…');
        suspendWorkspaceRefresh();
        await yieldToUiFrame();

        try {
            let removedCount = 0;
            for (const target of targets) {
                if (!target.absolutePath || !fs.existsSync(target.absolutePath)) {
                    continue;
                }

                const bundlePath = findContainingTextBundlePath(target.absolutePath) || window.currentPath;
                if (!bundlePath) {
                    continue;
                }

                const backupInfo = getBundleEntryBackupInfo(target.absolutePath, bundlePath);
                const entryKind = backupInfo?.kind || 'attachments';
                const entryName = backupInfo?.entryName || path.basename(target.absolutePath);
                const historyEntryId = createHistoryEntryId();
                const removed = moveEntryToSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
                if (!removed) {
                    continue;
                }

                recordHistoryAttachmentStep({
                    kind: 'attachment-delete',
                    label: '删除未引用附件',
                    undo() {
                        const restored = restoreEntryFromSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
                        if (restored) {
                            refreshActiveEditorAttachmentDom();
                            refreshAttachmentPanelIfVisible();
                        }
                        return restored;
                    },
                    redo() {
                        const moved = moveEntryToSessionHistoryForBundle(bundlePath, entryKind, entryName, historyEntryId);
                        if (moved) {
                            refreshActiveEditorAttachmentDom();
                            refreshAttachmentPanelIfVisible();
                        }
                        return moved;
                    }
                });
                removedCount += 1;
            }

            if (!removedCount) {
                return false;
            }

            refreshAttachmentPanelIfVisible();
            if (window.editor) {
                updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
            }
            return true;
        } finally {
            resumeWorkspaceRefresh({ immediate: true });
            clearWorkspaceBusy();
        }
    });
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

function renderAttachmentList(context, force = false) {
    const attachmentContainer = document.getElementById('attachment-container');
    if (!attachmentContainer) return;

    suppressAttachmentDropEvents(attachmentContainer);

    const normalizedContent = typeof context === 'string'
        ? String(context || '')
        : String(context?.markdown || '');
    const documentJson = context && typeof context === 'object'
        ? context.documentJson || null
        : null;
    const contentKey = documentJson ? JSON.stringify(documentJson) : normalizedContent;
    const attachmentsDir = window.currentPath ? path.join(window.currentPath, 'attachments') : '';
    const attachmentEntries = attachmentsDir ? getAttachmentDirectoryEntries(attachmentsDir) : [];
    const structuredReferences = window.editor && typeof window.editor.getAttachmentReferences === 'function'
        ? window.editor.getAttachmentReferences()
        : null;
    const documentJsonReferences = !structuredReferences && documentJson
        ? collectAttachmentDocumentJsonRefs(documentJson, window.currentPath)
        : null;
    const referenceSignature = structuredReferences
        ? JSON.stringify(structuredReferences.map((reference) => ({
            relativePath: String(reference.relativePath || ''),
            absolutePath: String(reference.absolutePath || ''),
            exists: Boolean(reference.exists),
            isDirectory: Boolean(reference.isDirectory),
            kindIndex: Number.isInteger(reference.kindIndex) ? reference.kindIndex : -1
        })))
        : documentJsonReferences
            ? JSON.stringify(documentJsonReferences.map((reference) => ({
                relativePath: String(reference.relativePath || ''),
                absolutePath: String(reference.absolutePath || ''),
                exists: Boolean(reference.exists),
                isDirectory: Boolean(reference.isDirectory),
                kindIndex: Number.isInteger(reference.kindIndex) ? reference.kindIndex : -1
            })))
            : documentJson
            ? JSON.stringify(documentJson)
        : '';
    const renderKey = `attachment::${window.currentPath || ''}::${contentKey}::${attachmentsDir ? getAttachmentDirectoryEntriesSignature(attachmentEntries) : ''}::${referenceSignature}`;
    if (!force && attachmentContainer.dataset.renderKey === renderKey && attachmentContainer.childElementCount > 0) {
        return;
    }

    attachmentContainer.innerHTML = '';
    attachmentContainer.dataset.renderKey = renderKey;

    const references = structuredReferences && structuredReferences.length
        ? structuredReferences
        : (documentJsonReferences && documentJsonReferences.length
            ? documentJsonReferences
            : (normalizedContent ? getAttachmentReferences(normalizedContent) : []));
    const missingReferences = references
        .map((reference, index) => ({ reference, index }))
        .filter(({ reference }) => !reference.exists);
    const referencedEntries = references.filter((reference) => reference.exists);
    const usedTopLevelEntries = structuredReferences && structuredReferences.length
        ? new Set(structuredReferences.flatMap((reference) => {
            const topLevelEntry = getAttachmentTopLevelEntryName(reference.relativePath);
            return topLevelEntry ? [topLevelEntry] : [];
        }))
        : (documentJsonReferences && documentJsonReferences.length
            ? new Set(documentJsonReferences.flatMap((reference) => {
                const topLevelEntry = getAttachmentTopLevelEntryName(reference.relativePath);
                return topLevelEntry ? [topLevelEntry] : [];
            }))
            : getUsedAttachmentEntries(normalizedContent, { preferEditorState: true }));
    const unreferencedEntries = attachmentEntries.filter((entry) => !usedTopLevelEntries.has(entry.name));

    if (!references.length && !unreferencedEntries.length) {
        const emptyState = document.createElement('div');
        emptyState.className = 'sidebar-empty';
        emptyState.innerText = '当前文档还没有引用附件，也没有可显示的未引用附件。把文件或文件夹拖进编辑区后，这里就会列出来。';
        attachmentContainer.appendChild(emptyState);
        return;
    }

    const summary = document.createElement('div');
    summary.className = 'attachment-section';
    summary.innerHTML = `
        <div class="attachment-section-head">
            <div class="attachment-section-head-main">
                <div class="attachment-section-title">附件概览</div>
                <div class="attachment-section-meta">${attachmentEntries.length} 个文件/文件夹</div>
            </div>
        </div>
    `;
    const summaryHead = summary.querySelector('.attachment-section-head');
    if (summaryHead) {
        const bulkDeleteButton = document.createElement('button');
        bulkDeleteButton.type = 'button';
        bulkDeleteButton.className = 'attachment-section-action-button';
        bulkDeleteButton.innerHTML = '<i class="fa-solid fa-trash-can" aria-hidden="true"></i>';
        bulkDeleteButton.title = unreferencedEntries.length ? '删除所有未引用附件' : '没有未引用附件';
        bulkDeleteButton.setAttribute('aria-label', bulkDeleteButton.title);
        bulkDeleteButton.disabled = !unreferencedEntries.length;
        bulkDeleteButton.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (!unreferencedEntries.length) return;
            await deleteUnreferencedAttachments(unreferencedEntries);
        });
        summaryHead.appendChild(bulkDeleteButton);
    }
    const summaryRow = document.createElement('div');
    summaryRow.className = 'attachment-summary';
    for (const [label, value] of [
        ['已引用', referencedEntries.length],
        ['缺失', missingReferences.length],
        ['未引用', unreferencedEntries.length]
    ]) {
        const chip = document.createElement('div');
        chip.className = 'attachment-summary-chip';
        chip.textContent = `${label} ${value}`;
        summaryRow.appendChild(chip);
    }
    summary.appendChild(summaryRow);
    attachmentContainer.appendChild(summary);

    if (referencedEntries.length) {
        const referencedSection = document.createElement('div');
        referencedSection.className = 'attachment-section';
        referencedSection.innerHTML = `
            <div class="attachment-section-head">
                <div class="attachment-section-title">文档引用</div>
                <div class="attachment-section-meta">${referencedEntries.length} 个已找到的附件</div>
            </div>
        `;
        const referencedList = document.createElement('div');
        referencedList.className = 'attachment-referenced-list';

        for (let referenceIndex = 0; referenceIndex < references.length; referenceIndex++) {
            const reference = references[referenceIndex];
            if (!reference.exists) {
                continue;
            }

            const item = document.createElement('div');
            item.className = 'attachment-item attachment-referenced-item';
            suppressAttachmentDropEvents(item);

            const row = document.createElement('div');
            row.className = 'attachment-item-row attachment-referenced-item-row';

            const toggle = document.createElement('div');
            const hasChildren = reference.isDirectory;
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

                renderAttachmentList(context);
            });

            const body = document.createElement('div');
            body.className = 'attachment-body';

            const title = document.createElement('div');
            title.className = 'attachment-title';
            title.innerText = reference.label || path.basename(reference.relativePath);

            const meta = document.createElement('div');
            meta.className = 'attachment-meta';
            meta.innerText = `${reference.isDirectory ? '文件夹' : '文件'} · 第 ${reference.lineNumber} 行 · ${reference.relativePath}`;

            body.appendChild(title);
            body.appendChild(meta);
            row.appendChild(toggle);
            row.appendChild(body);
            item.appendChild(row);
            item.setAttribute('draggable', 'true');

            item.addEventListener('dragstart', (event) => {
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer?.clearData();
                event.dataTransfer?.setData('text/plain', '');
                if (event.dataTransfer) {
                    event.dataTransfer.effectAllowed = 'copy';
                    event.dataTransfer.dropEffect = 'copy';
                }
                item.classList.add('dragging');
                startAttachmentSystemDrag(reference.absolutePath);
            });

            item.addEventListener('dragend', () => {
                item.classList.remove('dragging');
            });

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

            referencedList.appendChild(item);
        }

        referencedSection.appendChild(referencedList);
        attachmentContainer.appendChild(referencedSection);
    }

    if (missingReferences.length) {
        const missingSection = document.createElement('div');
        missingSection.className = 'attachment-section';
        missingSection.innerHTML = `
            <div class="attachment-section-head">
                <div class="attachment-section-title">缺失附件</div>
                <div class="attachment-section-meta">${missingReferences.length} 个引用在磁盘上找不到</div>
            </div>
        `;

        missingReferences.forEach(({ reference, index: referenceIndex }) => {
            const item = document.createElement('div');
            item.className = 'attachment-item missing';
            suppressAttachmentDropEvents(item);

            const row = document.createElement('div');
            row.className = 'attachment-item-row';

            const toggle = document.createElement('div');
            toggle.className = 'attachment-toggle empty';
            toggle.innerText = '•';

            const body = document.createElement('div');
            body.className = 'attachment-body';

            const title = document.createElement('div');
            title.className = 'attachment-title';
            title.innerText = reference.label || path.basename(reference.relativePath);

            const meta = document.createElement('div');
            meta.className = 'attachment-meta';
            meta.innerText = `引用缺失 · 第 ${reference.lineNumber} 行 · ${reference.relativePath}`;

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

            missingSection.appendChild(item);
        });

        attachmentContainer.appendChild(missingSection);
    }

    if (unreferencedEntries.length) {
        const unreferencedSection = document.createElement('div');
        unreferencedSection.className = 'attachment-section';
        unreferencedSection.innerHTML = `
            <div class="attachment-section-head">
                <div class="attachment-section-title">未引用附件</div>
                <div class="attachment-section-meta">${unreferencedEntries.length} 个文件/文件夹未被正文引用</div>
            </div>
        `;

        const tree = document.createElement('div');
        tree.className = 'attachment-orphan-tree';
        renderAttachmentFilesystemTree(unreferencedEntries, tree);
        if (!tree.childElementCount) {
            const emptyState = document.createElement('div');
            emptyState.className = 'attachment-orphan-empty';
            emptyState.innerText = '没有找到未引用附件。';
            tree.appendChild(emptyState);
        }
        unreferencedSection.appendChild(tree);
        attachmentContainer.appendChild(unreferencedSection);
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

    const normalizedRootPath = path.resolve(rootPath);
    const now = Date.now();
    if (
        !workspaceBundlePathsCacheDirty
        && workspaceBundlePathsCacheRoot === normalizedRootPath
        && workspaceBundlePathsCache
        && workspaceBundlePathsCache.expiresAt > now
    ) {
        return workspaceBundlePathsCache.bundlePaths;
    }

    const results = [];
    const visit = (dirPath) => {
        for (const entry of getWorkspaceChildren(dirPath, { preserveManualOrder: false })) {
            const entryPath = entry.path;
            if (isSupportedBundleName(entry.name)) {
                if (isValidTextBundlePath(entryPath)) {
                    results.push(entryPath);
                }
                continue;
            }
            if (entry.isDirectory) {
                visit(entryPath);
            }
        }
    };

    visit(normalizedRootPath);
    workspaceBundlePathsCache = {
        bundlePaths: results,
        expiresAt: now + WORKSPACE_BUNDLE_PATHS_CACHE_TTL
    };
    workspaceBundlePathsCacheRoot = normalizedRootPath;
    workspaceBundlePathsCacheDirty = false;
    return results;
}

function getBundleMarkdownForSearch(bundlePath) {
    const normalizedPath = path.resolve(bundlePath);
    const openTab = findTabByPath(normalizedPath);
    if (openTab?.documentJson) {
        return { markdown: openTab.content || '', documentJson: cloneSerializableValue(openTab.documentJson) };
    }

    if (openTab) {
        return { markdown: openTab.content || '', documentJson: null };
    }

    try {
        const markdownPath = resolveBundleMarkdownFilePath(normalizedPath);
        const manifestPath = getBundleManifestPath(normalizedPath);
        const documentJsonPath = getBundleDocumentJsonPath(normalizedPath);
        const hasPrivateStructure = fs.existsSync(manifestPath) && fs.existsSync(documentJsonPath);
        return {
            markdown: markdownPath ? fs.readFileSync(markdownPath, 'utf8') : '',
            documentJson: hasPrivateStructure ? readJsonFileIfExists(documentJsonPath) : null
        };
    } catch {
        return { markdown: '', documentJson: null };
    }
}

function getDocumentJsonSearchMatches(documentJson, normalizedQuery, options = {}) {
    const root = documentJson && typeof documentJson === 'object' ? documentJson : null;
    if (!root) {
        return [];
    }

    const {
        bundlePath = null,
        meta = '',
        limit = 200
    } = options;

    const matches = [];
    const seenKeys = new Set();
    let headingIndex = 0;
    let taskIndex = 0;
    let attachmentIndex = 0;
    let textblockIndex = 0;

    const pushMatch = (match) => {
        const key = `${match.kind || ''}::${match.kindIndex ?? -1}::${match.lineNumber ?? -1}::${match.text || ''}`;
        if (seenKeys.has(key)) {
            return;
        }
        seenKeys.add(key);
        matches.push(match);
    };

    const addTextMatch = (text, kind, kindLabel, kindIndex, lineNumber, extra = {}) => {
        const normalizedText = String(text || '').toLowerCase();
        const matchIndex = normalizedText.indexOf(normalizedQuery);
        if (matchIndex === -1) {
            return;
        }

        pushMatch({
            lineNumber: Number.isInteger(lineNumber) ? lineNumber : (kindIndex + 1),
            text: String(text || '').trim() || '(空行)',
            snippet: String(text || '').trim() || '(空行)',
            matchIndex,
            jumpTarget: {
                preferredText: String(extra.preferredText || text || '').trim(),
                preferredKind: extra.preferredKind || kind || ''
            },
            kind,
            kindLabel,
            kindIndex,
            bundlePath,
            meta,
            ...extra
        });
    };

    const walk = (node) => {
        if (!node || typeof node !== 'object' || matches.length >= limit) {
            return;
        }

        const type = String(node.type || '');
        const textContent = normalizeSearchTargetText(getDocumentJsonTextContent(node));
        const lineNumber = textblockIndex + 1;

        if (type === 'heading') {
            addTextMatch(
                textContent,
                'heading',
                '标题',
                headingIndex,
                headingIndex + 1,
                { preferredText: textContent, preferredKind: 'heading' }
            );
            headingIndex += 1;
            textblockIndex += 1;
            return;
        } else if (type === 'taskItem') {
            const firstTextblock = findFirstTextblockJsonNode(node) || node;
            const taskHeadingLevel = clampNumber(Number(node.attrs?.headingLevel || 0), 0, 6);
            const taskText = normalizeSearchTargetText(getDocumentJsonTextContent(firstTextblock));
            addTextMatch(
                taskText,
                taskHeadingLevel > 0 ? 'heading' : 'task',
                taskHeadingLevel > 0 ? '标题' : '待办',
                taskIndex,
                taskIndex + 1,
                {
                    preferredText: taskText,
                    preferredKind: taskHeadingLevel > 0 ? 'heading' : 'task'
                }
            );
            taskIndex += 1;
            textblockIndex += 1;
            return;
        } else if (type === 'kangarooAttachment' || type === 'kangarooVideo' || type === 'kangarooPdf') {
            const href = String(node.attrs?.href || '');
            const label = String(node.attrs?.label || path.basename(href) || '').trim();
            const searchableText = `${label} ${normalizeSearchTargetText(href)}`.trim();
            addTextMatch(
                searchableText,
                'attachment',
                '附件',
                attachmentIndex,
                attachmentIndex + 1,
                {
                    preferredText: label || path.basename(href) || '',
                    preferredKind: 'attachment',
                    meta: normalizeSearchTargetText(href)
                }
            );
            attachmentIndex += 1;
            return;
        } else if (node.isTextblock) {
            addTextMatch(
                textContent,
                'text',
                '正文',
                textblockIndex,
                lineNumber,
                { preferredText: textContent, preferredKind: '' }
            );
            textblockIndex += 1;
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                walk(child);
                if (matches.length >= limit) {
                    return;
                }
            }
        }

        if (Array.isArray(node.marks) && typeof node.text === 'string') {
            for (const mark of node.marks) {
                const href = String(mark?.attrs?.href || '');
                if (!/attachments\//i.test(href)) continue;

                const label = String(node.text || path.basename(href) || '').trim();
                const searchableText = `${label} ${normalizeSearchTargetText(href)}`.trim();
                const normalizedText = searchableText.toLowerCase();
                const matchIndex = normalizedText.indexOf(normalizedQuery);
                if (matchIndex === -1) continue;

                pushMatch({
                    lineNumber: lineNumber,
                    text: label || path.basename(href) || '(空行)',
                    snippet: searchableText,
                    matchIndex,
                    jumpTarget: {
                        preferredText: label || path.basename(href) || '',
                        preferredKind: 'attachment'
                    },
                    kind: 'attachment',
                    kindLabel: '附件',
                    kindIndex: attachmentIndex,
                    bundlePath,
                    meta: normalizeSearchTargetText(href)
                });
                attachmentIndex += 1;
                break;
            }
        }
    };

    walk(root);
    return matches;
}

function getBundleSearchMatches(bundlePath, normalizedQuery, limit = 200) {
    if (!bundlePath || !normalizedQuery) {
        return [];
    }

    const normalizedPath = path.resolve(bundlePath);
    const currentBundlePath = window.currentPath ? path.resolve(window.currentPath) : null;
    if (currentBundlePath === normalizedPath && window.editor && typeof window.editor.getSearchMatches === 'function') {
        return window.editor.getSearchMatches(normalizedQuery, limit).map((match) => ({
            ...match,
            bundlePath: normalizedPath,
            meta: match.meta || getRelativeWorkspaceFolder(normalizedPath) || path.basename(normalizedPath),
            kindLabel: match.kindLabel || getSearchKindLabel(match.kind || '')
        }));
    }

    const openTab = getOpenTabByBundlePath(normalizedPath);
    if (openTab?.documentJson && window.editor && typeof window.editor.getSearchMatches === 'function') {
        const matches = getDocumentJsonSearchMatches(openTab.documentJson, normalizedQuery, {
            bundlePath: normalizedPath,
            meta: getRelativeWorkspaceFolder(normalizedPath) || path.basename(normalizedPath),
            limit
        });
        if (matches.length) {
            return matches;
        }
    }

    const { markdown, documentJson } = getBundleMarkdownForSearch(normalizedPath);
    const relativeBundlePath = getRelativeWorkspaceFolder(normalizedPath) || path.basename(normalizedPath);

    if (documentJson) {
        const structuredMatches = getDocumentJsonSearchMatches(documentJson, normalizedQuery, {
            bundlePath: normalizedPath,
            meta: relativeBundlePath,
            limit
        });
        if (structuredMatches.length) {
            return structuredMatches;
        }
    }

    if (!markdown) {
        return [];
    }

    return getMarkdownSearchMatches(markdown, normalizedQuery, {
        bundlePath: normalizedPath,
        meta: relativeBundlePath,
        limit
    });
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
        const bundleMatches = getBundleSearchMatches(bundlePath, normalizedQuery, limit - matches.length);
        if (!bundleMatches.length) continue;

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


function cleanUnusedImages(markdown, documentJson = null, bundlePath = window.currentPath) {
    const imageDirs = getImageResourceDirCandidates(bundlePath).filter((dir) => fs.existsSync(dir));
    if (!imageDirs.length) return;

    const structuredDocument = documentJson || window.editor?.getDocumentJson?.() || null;
    const used = structuredDocument
        ? getUsedImageEntriesFromDocumentJson(structuredDocument)
        : getUsedImageEntries(markdown);

    for (const imageDir of imageDirs) {
        const isAttachmentImagesDir = path.resolve(imageDir) === path.resolve(getImageResourceDirPath(bundlePath));
        for (const entryName of fs.readdirSync(imageDir)) {
            if (used.has(entryName)) continue;

            const entryPath = path.join(imageDir, entryName);
            const stat = fs.statSync(entryPath);

            if (stat.isDirectory()) {
                continue;
            }

            const recovered = isAttachmentImagesDir
                ? moveEntryToRecoveryForBundle(bundlePath, 'attachments', path.join(IMAGE_RESOURCE_DIR_NAME, entryName))
                : moveEntryToRecoveryForBundle(bundlePath, path.basename(imageDir), entryName);

            if (recovered) {
                console.log("移入恢复区的图片资源:", entryName);
            }
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
            const topLevelEntry = getAttachmentTopLevelEntryName(ref.relativePath);

            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        }
    }

    if (String(markdown || '').trim()) {
        for (const ref of collectAttachmentMarkdownRefs(markdown)) {
            const topLevelEntry = getAttachmentTopLevelEntryName(ref.relativePath);

            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        }
    }

    return used;
}

function getUsedAttachmentEntriesFromDocumentJson(documentJson) {
    const used = new Set();
    const root = documentJson && typeof documentJson === 'object' ? documentJson : null;
    if (!root) {
        return used;
    }

    const visit = (node) => {
        if (!node || typeof node !== 'object') {
            return;
        }

        if (node.type === 'image') {
            const topLevelEntry = getAttachmentTopLevelEntryName(node.attrs?.src || '');
            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        } else if (node.type === 'kangarooAttachment' || node.type === 'kangarooVideo' || node.type === 'kangarooPdf') {
            const topLevelEntry = getAttachmentTopLevelEntryName(node.attrs?.href || node.attrs?.src || '');
            if (topLevelEntry) {
                used.add(topLevelEntry);
            }
        }

        if (Array.isArray(node.content)) {
            for (const child of node.content) {
                visit(child);
            }
        }
    };

    visit(root);
    return used;
}

async function cleanUnusedAttachments(markdown, documentJson = null, bundlePath = window.currentPath) {
    const attachmentsDir = path.join(bundlePath || '', 'attachments');
    if (!fs.existsSync(attachmentsDir)) return true;

    const structuredDocument = documentJson || window.editor?.getDocumentJson?.() || null;
    const used = structuredDocument
        ? getUsedAttachmentEntriesFromDocumentJson(structuredDocument)
        : getUsedAttachmentEntries(markdown, { preferEditorState: true });

    for (const entryName of used) {
        preservedUnusedAttachmentEntries.delete(entryName);
    }

    for (const entryName of fs.readdirSync(attachmentsDir)) {
        if (entryName === IMAGE_RESOURCE_DIR_NAME) {
            continue;
        }
        if (used.has(entryName)) continue;
        if (preservedUnusedAttachmentEntries.has(entryName)) continue;

        const entryPath = path.join(attachmentsDir, entryName);
        if (!fs.existsSync(entryPath)) continue;

        const stat = fs.statSync(entryPath);
        const isDirectory = stat.isDirectory();

        backupEntryToRecoveryForBundle(bundlePath, 'attachments', entryName);
        const trashResult = await ipcRenderer.invoke('shell:trashPath', {
            type: 'path',
            value: entryPath
        });

        if (!trashResult || !trashResult.ok) {
            moveEntryToRecoveryForBundle(bundlePath, 'attachments', entryName);
        }

        preservedUnusedAttachmentEntries.delete(entryName);
        console.log(`删除并备份到恢复区的附件${isDirectory ? '文件夹' : '文件'}:`, entryName);
    }

    return true;
}

async function cleanupUnusedResourcesForTab(tab) {
    if (!tab || !tab.path) {
        return true;
    }

    const markdown = typeof tab.content === 'string' ? tab.content : '';
    const documentJson = cloneSerializableValue(tab.documentJson) || null;
    preservedUnusedAttachmentEntries = new Set(tab.preservedEntries || []);

    cleanUnusedImages(markdown, documentJson, tab.path);
    const canContinueSave = await cleanUnusedAttachments(markdown, documentJson, tab.path);
    tab.preservedEntries = Array.from(preservedUnusedAttachmentEntries);
    return canContinueSave;
}


// ==============================
// 渲染
// ==============================
function updatePreview(options = {}) {
    if (!window.editor || !isPreviewActive()) return;
    const { preserveViewport = false, preserveMode = 'anchor' } = options;

    const preview = document.getElementById('preview-container');
    if (!preview) return;

    const sourceMarkdown = window.editor.getValue();
    const renderKey = `${window.currentPath || ''}::${sourceMarkdown}`;
    if (renderKey === lastPreviewRenderKey) {
        return;
    }

    const viewportState = preserveViewport ? capturePreviewViewportState(preserveMode) : null;
    const raw = transformMarkdownForPreview(sourceMarkdown);

    preview.innerHTML = sanitizeRenderedHtml(getMarkdownRenderer().render(raw));
    decoratePreviewImages();
    decoratePreviewLinks();
    lastPreviewRenderKey = renderKey;

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
    editorChangeToken += 1;

    if (pendingAttachmentDeleteSnapshot && !shouldApplyPendingAttachmentDeleteSnapshot()) {
        clearPendingAttachmentDeleteSnapshot();
    }
    if (pendingAttachmentRenameSnapshot && !shouldApplyPendingAttachmentRenameUndo()) {
        clearPendingAttachmentRenameSnapshot();
    }

    const markdown = window.editor?.getValue ? window.editor.getValue() : '';
    const restoredEntries = restoreRecoveredEntries(
        markdown,
        window.editor && typeof window.editor.getDocumentJson === 'function'
            ? window.editor.getDocumentJson()
            : null
    );
    if (restoredEntries && window.editor && typeof window.editor.refreshDisplayState === 'function') {
        window.editor.refreshDisplayState();
    }

    persistActiveTabState(markdown);

    setDirty(true);
    lastKnownEditorLineCount = getEditorTotalLines();
    pendingPreviewVisibleLine = getEditorAnchorLineFromCursor();
    scheduleAutoSave();
    if (currentSearchQuery.trim()) {
        renderToolbarSearchResults(currentSearchQuery);
    }
    if (!pendingAttachmentDeleteSnapshot) {
        schedulePersistActiveTabState();
    }
    if (loadTodoPanelSettings().scope === 'workspace') {
        workspaceTodoRenderVersion += 1;
    }
    if (timelinePanelOpen && currentRightSidebarTab === 'timeline') {
        scheduleTimelinePanelRender();
    }
    if (currentRightSidebarTab === 'todo' || currentRightSidebarTab === 'attachment' || currentRightSidebarTab === 'outline') {
        renderActiveRightSidebarPanel(getActiveEditorSnapshot());
    }
    scheduleToolbarStateRefresh();
    scheduleEditorRender();
}

function scheduleEditorRender() {
    if (editorRenderFrame) return;

    editorRenderFrame = window.requestAnimationFrame(() => {
        editorRenderFrame = null;
        const liveSnapshot = getActiveEditorSnapshot();
        if (isPreviewActive()) {
            updatePreview({ preserveViewport: true, preserveMode: 'anchor' });
        }
        renderActiveRightSidebarPanel(liveSnapshot);

        if (isPreviewActive() && typeof pendingPreviewVisibleLine === 'number') {
            ensurePreviewLineVisible(pendingPreviewVisibleLine);
            pendingPreviewVisibleLine = null;
        } else if (!isPreviewActive()) {
            pendingPreviewVisibleLine = null;
        }
    });
}

function renderOutlineList(context = null) {
    const outlineContainer = document.getElementById('outline-container');
    if (!outlineContainer) return;

    const normalizedContent = typeof context === 'string'
        ? String(context || '')
        : String(context?.markdown || '');
    const documentJson = context && typeof context === 'object'
        ? context.documentJson || null
        : null;
    const structuredEntries = window.editor && typeof window.editor.getOutlineEntries === 'function'
        ? window.editor.getOutlineEntries()
        : null;
    const renderKey = structuredEntries
        ? `outline::${JSON.stringify(structuredEntries.map((entry) => ({
            kindIndex: Number.isInteger(entry.kindIndex) ? entry.kindIndex : -1,
            level: Number(entry.level || 0),
            lineNumber: Number(entry.lineNumber || 0),
            text: String(entry.text || ''),
            stableId: String(entry.stableId || '')
        })))}`
        : documentJson
            ? `outline::documentJson::${JSON.stringify(documentJson)}`
        : `outline::${normalizedContent}`;
    if (outlineContainer.dataset.renderKey === renderKey && outlineContainer.childElementCount > 0) {
        return;
    }

    outlineContainer.innerHTML = '';
    outlineContainer.dataset.renderKey = renderKey;

    const entries = structuredEntries || (() => {
        const parsedEntries = [];
        const headingRegex = /^(?:(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+)?(#{1,6})\s+(.+)$/gm;
        let match;

        while ((match = headingRegex.exec(normalizedContent)) !== null) {
            parsedEntries.push({
                kind: 'heading',
                kindIndex: parsedEntries.length,
                level: match[1].length,
                lineNumber: getLineNumberAtOffset(normalizedContent, match.index),
                text: match[2].trim(),
                stableId: null
            });
        }

        return parsedEntries;
    })();

    for (const entry of entries) {
        const level = clampNumber(Number(entry.level || 0), 1, 6);
        const title = String(entry.text || '').trim();
        const lineNumber = Number.isInteger(entry.lineNumber) ? entry.lineNumber : 1;

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

function renderActiveRightSidebarPanel(context = null) {
    if (!timelinePanelOpen) return;

    if (currentRightSidebarTab === 'timeline' && !isFeatureEnabled('timeline')) {
        return;
    }
    if (currentRightSidebarTab === 'todo') {
        renderTodoList(context);
        return;
    }

    if (currentRightSidebarTab === 'pomodoro') {
        if (!isFeatureEnabled('pomodoro')) return;
        renderPomodoroPanel();
        return;
    }

    if (!window.editor) return;
    const currentContent = typeof context === 'string'
        ? context
        : (context?.markdown || window.editor.getValue());
    const currentDocumentJson = context && typeof context === 'object'
        ? context.documentJson || null
        : (typeof window.editor.getDocumentJson === 'function' ? window.editor.getDocumentJson() : null);

    if (currentRightSidebarTab === 'outline') {
        renderOutlineList({ markdown: currentContent, documentJson: currentDocumentJson });
        return;
    }

    if (currentRightSidebarTab === 'attachment') {
        renderAttachmentList({ markdown: currentContent, documentJson: currentDocumentJson });
    }
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

    if (kind === 'attachment' && typeof window.editor.selectBlockByKindIndex === 'function') {
        window.editor.selectBlockByKindIndex(kind, kindIndex, options);
        highlightEditorLine(options.lineNumber || 1);
        return;
    }

    if (typeof window.editor.focusBlockByKindIndex === 'function') {
        window.editor.focusBlockByKindIndex(kind, kindIndex, options);
        highlightEditorLine(options.lineNumber || 1);
        return;
    }

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
document.getElementById('sidebar-tab-workspace')?.addEventListener('click', () => setSidebarTab('workspace'));
setupSidebarResizeHandle();
setupSidebarRailReorder();
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
document.getElementById('editor-tabs').addEventListener('auxclick', async (event) => {
    if (event.button !== 1) return;
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    event.preventDefault();
    event.stopPropagation();
    await closeEditorTab(tabButton.dataset.tabId);
});
document.getElementById('editor-tabs').addEventListener('contextmenu', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    event.preventDefault();
    event.stopPropagation();
    showTabContextMenu(event, tabButton.dataset.tabId);
});
document.getElementById('editor-tabs').addEventListener('dragstart', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton) return;

    const tab = getTabById(tabButton.dataset.tabId);
    if (tab?.pinned) {
        event.preventDefault();
        return;
    }

    draggedEditorTabId = tabButton.dataset.tabId;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', draggedEditorTabId);
});
document.getElementById('editor-tabs').addEventListener('dragover', (event) => {
    const tabButton = event.target.closest('.editor-tab');
    if (!tabButton || !draggedEditorTabId || tabButton.dataset.tabId === draggedEditorTabId) return;

    const targetTab = getTabById(tabButton.dataset.tabId);
    if (targetTab?.pinned) return;

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

    const targetTab = getTabById(tabButton.dataset.tabId);
    const draggedTab = getTabById(draggedEditorTabId);
    if (!targetTab?.path || draggedTab?.pinned || targetTab?.pinned) {
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
document.getElementById('timeline-toggle-button').addEventListener('click', () => {
    toggleTimelinePanelVisibility();
});
document.getElementById('outline-toggle-button')?.addEventListener('click', () => {
    toggleRightSidebarTab('outline');
});
document.getElementById('todo-toggle-button')?.addEventListener('click', () => {
    toggleRightSidebarTab('todo');
});
document.getElementById('attachment-toggle-button')?.addEventListener('click', () => {
    toggleRightSidebarTab('attachment');
});
document.getElementById('pomodoro-toggle-button')?.addEventListener('click', () => {
    toggleRightSidebarTab('pomodoro');
});
document.getElementById('tab-menu-open-folder').addEventListener('click', async () => {
    const targetTabId = tabContextTargetId;
    hideTabContextMenu();
    await openTabFolder(targetTabId);
});
document.getElementById('tab-menu-reveal-workspace').addEventListener('click', () => {
    const targetTabId = tabContextTargetId;
    hideTabContextMenu();
    if (!targetTabId) return;
    revealTabInWorkspaceTree(targetTabId);
});
document.getElementById('tab-menu-pin-toggle').addEventListener('click', () => {
    const tabId = tabContextTargetId || activeTabId;
    hideTabContextMenu();
    if (!tabId) return;
    toggleEditorTabPinned(tabId);
});
document.getElementById('tab-menu-export-html').addEventListener('click', async () => {
    const targetTabId = tabContextTargetId || activeTabId;
    hideTabContextMenu();
    await handleExportHtml(targetTabId);
});
document.getElementById('timeline-day-menu-open-diary').addEventListener('click', async () => {
    const targetDate = timelineDayContextTarget ? new Date(timelineDayContextTarget) : new Date();
    hideTimelineDayContextMenu();
    await openDiaryBundleForDate(targetDate);
});
document.getElementById('timeline-day-menu-new-diary').addEventListener('click', async () => {
    const targetDate = timelineDayContextTarget ? new Date(timelineDayContextTarget) : new Date();
    hideTimelineDayContextMenu();
    await createDiaryBundleForDate(targetDate);
});
document.getElementById('timeline-day-menu-delete-diary').addEventListener('click', async () => {
    const targetDate = timelineDayContextTarget ? new Date(timelineDayContextTarget) : new Date();
    hideTimelineDayContextMenu();
    await deleteDiaryBundlesForDate(targetDate);
});
document.getElementById('timeline-diary-menu-open-diary').addEventListener('click', async () => {
    const target = timelineDiaryContextTarget;
    hideTimelineDiaryContextMenu();
    if (!target?.path) return;
    await openWorkspaceBundle(target.path);
});
document.getElementById('timeline-diary-menu-delete-diary').addEventListener('click', async () => {
    const target = timelineDiaryContextTarget;
    hideTimelineDiaryContextMenu();
    if (!target?.path) return;
    await deleteDiaryBundlePath(target.path);
});
document.getElementById('timeline-todo-menu-edit').addEventListener('click', async () => {
    const target = timelineTodoContextTarget;
    hideTimelineTodoContextMenu();
    if (!target) return;
    const todoItem = target.element?.closest?.('.todo-item') || null;
    if (todoItem) {
        beginTimelineTodoInlineEdit(todoItem, target);
    }
});
document.getElementById('timeline-todo-menu-locate').addEventListener('click', async () => {
    const target = timelineTodoContextTarget;
    hideTimelineTodoContextMenu();
    if (!target) return;
    await jumpToTimelineTodoEntry(target);
});
document.getElementById('timeline-todo-menu-delete').addEventListener('click', async () => {
    const target = timelineTodoContextTarget;
    hideTimelineTodoContextMenu();
    if (!target) return;
    const label = getTimelineTodoItemDisplayText(target) || '这条待办';
    if (!confirm(`要删除“${label}”吗？`)) {
        return;
    }
    await deleteTimelineTodoItem(target);
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
document.getElementById('workspace-menu-sort').addEventListener('click', (event) => {
    event.stopPropagation();
    const target = workspaceContextTarget;
    if (!target?.sortTarget) return;
    const trigger = event.currentTarget;
    const submenu = document.getElementById('workspace-sort-submenu');
    if (!submenu || !trigger) return;

    const triggerRect = trigger.getBoundingClientRect();
    submenu.classList.add('show');
    positionContextMenu(submenu, triggerRect, { kind: 'workspaceSubmenu', minWidth: 168, placement: 'right' });
});
document.getElementById('workspace-menu-sort-name-asc').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.sortTarget) return;
    setWorkspaceFolderSortMode(target.sortTarget, 'name-asc');
});
document.getElementById('workspace-menu-sort-name-desc').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.sortTarget) return;
    setWorkspaceFolderSortMode(target.sortTarget, 'name-desc');
});
document.getElementById('workspace-menu-sort-created-asc').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.sortTarget) return;
    setWorkspaceFolderSortMode(target.sortTarget, 'created-asc');
});
document.getElementById('workspace-menu-sort-created-desc').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.sortTarget) return;
    setWorkspaceFolderSortMode(target.sortTarget, 'created-desc');
});
document.getElementById('workspace-menu-sort-manual').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.sortTarget) return;
    setWorkspaceFolderSortMode(target.sortTarget, 'manual');
});
document.getElementById('workspace-menu-rename').addEventListener('click', () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.path) return;
    beginWorkspaceInlineRename(target.path);
});
document.getElementById('workspace-menu-duplicate').addEventListener('click', async () => {
    const target = workspaceContextTarget;
    hideWorkspaceContextMenu();
    if (!target?.path) return;
    await duplicateWorkspaceEntry(target, {
        targetDir: path.dirname(path.resolve(target.path)),
        anchorPath: target.path,
        placement: 'after'
    });
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
document.getElementById('tab-menu-reveal-workspace').addEventListener('click', () => {
    const tabId = tabContextTargetId;
    hideTabContextMenu();
    if (!tabId) return;
    revealTabInWorkspaceTree(tabId);
});
document.addEventListener('keydown', async (event) => {
    if (event.defaultPrevented) return;
    const isPrimaryModifier = event.metaKey || event.ctrlKey;
    if (!isPrimaryModifier || event.altKey) return;

    const key = event.key.toLowerCase();
    const editorRoot = document.getElementById('editor-container');

    if (DEBUG_TEST_SHORTCUTS_ENABLED && event.shiftKey) {
        if (key === 'x') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (window.editor && typeof window.editor.focus === 'function') {
                window.editor.focus();
            }
            if (window.editor && typeof window.editor.insertText === 'function') {
                window.editor.insertText('x');
            } else {
                insertText('x');
            }
            console.log('[debug] inserted test text');
            return;
        }

        if (key === 'p') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            await handleClipboardPaste();
            console.log('[debug] clipboard paste handled');
            return;
        }

        if (key === 'u') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            await undoActiveTabState();
            console.log('[debug] undo handled');
            return;
        }

        if (key === 'r') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            await redoActiveTabState();
            console.log('[debug] redo handled');
            return;
        }

        if (key === 'f') {
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
            if (window.editor && typeof window.editor.focus === 'function') {
                window.editor.focus();
            }
            console.log('[debug] editor focus requested');
            return;
        }
    }

    if (key === 'w' && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        const activeTab = getActiveTab();
        if (activeTab) {
            void closeEditorTab(activeTab.id);
        }
        return;
    }

    if (key !== 'c' && key !== 'v') return;

    if (isEventInsideEditorRoot(event, editorRoot)) return;

    const activeElement = document.activeElement;
    const activeTagName = String(activeElement?.tagName || '').toLowerCase();
    if (activeElement?.isContentEditable || activeTagName === 'input' || activeTagName === 'textarea' || activeTagName === 'select') {
        return;
    }

    if (key === 'c') {
        const sourceTarget = getWorkspaceClipboardSourceTarget();
        if (!sourceTarget) return;

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation?.();
        writeWorkspaceClipboardEntry(sourceTarget);
        return;
    }

    const destinationPath = getWorkspaceSelectedEntryPath() || workspaceContextTarget?.path || workspaceRootPath;
    if (!destinationPath) return;

    const clipboardEntry = readWorkspaceClipboardEntry();
    if (!clipboardEntry?.path) return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation?.();
    void pasteWorkspaceEntryFromClipboard(destinationPath);
}, true);
document.getElementById('editor-link-menu-open').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await openEditorLinkTarget(target);
});
document.getElementById('editor-link-menu-copy-file').addEventListener('click', async () => {
    const target = editorLinkContextTarget;
    hideEditorLinkContextMenu();
    await copyAttachmentFileToClipboard(target);
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
document.getElementById('attachment-menu-copy-file').addEventListener('click', async () => {
    const target = attachmentContextTarget;
    hideAttachmentContextMenu();
    await copyAttachmentFileToClipboard(target);
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
document.getElementById('attachment-menu-delete').addEventListener('click', async () => {
    const target = attachmentContextTarget;
    hideAttachmentContextMenu();
    await deleteAttachmentTarget(target);
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
    button.addEventListener('click', (event) => {
        const tool = button.dataset.tool || '';
        if (tool === 'heading-menu') {
            event.stopPropagation();
            const submenu = document.getElementById('heading-toolbar-submenu');
            if (submenu?.classList.contains('show')) {
                hideHeadingToolbarSubmenu();
            } else {
                showHeadingToolbarSubmenu(button);
            }
            return;
        }

        hideHeadingToolbarSubmenu();
        runEditorToolbarCommand(tool, {
            level: button.dataset.level
        });
    });
});
document.querySelectorAll('#heading-toolbar-submenu .editor-toolbar-submenu-button').forEach((button) => {
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        hideHeadingToolbarSubmenu();
        runEditorToolbarCommand('heading', {
            level: button.dataset.headingLevel
        });
    });
});
updateSidebarToggleButton();
updateToolbarToggleButton();
document.getElementById('todo-scope-toggle')?.addEventListener('click', () => {
    const settings = loadTodoPanelSettings();
    updateTodoPanelSettings({ scope: settings.scope === 'workspace' ? 'document' : 'workspace' });
});
document.getElementById('todo-sort-toggle')?.addEventListener('click', () => {
    const settings = loadTodoPanelSettings();
    updateTodoPanelSettings({ sort: settings.sort === 'status' ? 'position' : 'status' });
});
document.getElementById('todo-hide-completed-toggle')?.addEventListener('click', () => {
    const settings = loadTodoPanelSettings();
    updateTodoPanelSettings({ hideCompleted: !settings.hideCompleted });
});
document.getElementById('bottom-sidebar-toggle-button')?.addEventListener('click', () => {
    toggleSidebarVisibility();
});
document.getElementById('bottom-toolbar-toggle-button')?.addEventListener('click', () => {
    toggleToolbarVisibility();
});
document.getElementById('bottom-settings-button')?.addEventListener('click', () => {
    openSettingsModal();
});
document.querySelectorAll('.settings-tab').forEach((button) => {
    button.addEventListener('click', () => setSettingsTab(button.dataset.tab));
});
document.getElementById('settings-inline-media-position')?.addEventListener('change', () => {
    syncInlineMediaPositionControls();
});
document.getElementById('settings-cancel-btn').addEventListener('click', () => closeSettingsModal());
document.getElementById('settings-save-btn').addEventListener('click', () => handleSaveSettings());
document.getElementById('settings-reset-btn').addEventListener('click', () => resetLayoutSettings());
document.getElementById('settings-modal').addEventListener('click', (event) => {
    if (event.target.id === 'settings-modal') {
        closeSettingsModal();
    }
});
window.addEventListener('beforeunload', () => {
    persistPinnedEditorTabPathsFromOpenTabs();
});
ipcRenderer.on('bundle:openExternal', (_, folderPath) => {
    void openBundleFromExternalPath(folderPath);
});

ipcRenderer.on('menu:action', async (_, action) => {
    switch (action) {
    case 'undo':
        void undoActiveTabState();
        break;
    case 'redo':
        void redoActiveTabState();
        break;
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
    await restorePinnedEditorTabs();
    const pendingBundlePath = await ipcRenderer.invoke('bundle:getPendingOpen');
    if (pendingBundlePath) {
        void openBundleFromExternalPath(pendingBundlePath, { skipConfirm: true });
    }
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideAttachmentContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hidePreviewImageContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideTabContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideTimelineDayContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideTimelineDiaryContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideTimelineTodoContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideWorkspaceContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideEditorLinkContextMenu();
});
document.addEventListener('click', () => {
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideHeadingToolbarSubmenu();
});
document.getElementById('workspace-context-menu').addEventListener('click', (event) => event.stopPropagation());
document.getElementById('workspace-sort-submenu').addEventListener('click', (event) => event.stopPropagation());
document.getElementById('heading-toolbar-submenu').addEventListener('click', (event) => event.stopPropagation());
document.getElementById('timeline-day-context-menu')?.addEventListener('click', (event) => event.stopPropagation());
document.getElementById('timeline-diary-context-menu')?.addEventListener('click', (event) => event.stopPropagation());
document.getElementById('timeline-todo-context-menu')?.addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('click', (event) => {
    if (Date.now() < suppressContextMenuHideUntil) return;
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
    if (Date.now() < suppressContextMenuHideUntil) return;
    hideAttachmentContextMenu();
    hidePreviewImageContextMenu();
    hideTabContextMenu();
    hideTimelineDayContextMenu();
    hideTimelineDiaryContextMenu();
    hideTimelineTodoContextMenu();
    hideWorkspaceContextMenu();
    hideEditorLinkContextMenu();
    hideHeadingToolbarSubmenu();
    closeSettingsModal();
    clearSelectedPreviewImage();
    finishActivePreviewImageResize();
    document.getElementById('toolbar-search-results').classList.remove('show');
});

window.__codexConfirmBeforeClose = async function () {
    return await confirmAllTabsBeforeClose();
};

function updateOutline(force = false) {
    if (!window.editor) return;

    const snapshot = getActiveEditorSnapshot();
    renderTodoList(snapshot);
    renderAttachmentList(snapshot, force);
    renderOutlineList(snapshot);
}
