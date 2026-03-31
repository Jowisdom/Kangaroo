const fs = require('fs');
const { Editor, mergeAttributes, getMarkRange } = require('@tiptap/core');
const { StarterKit } = require('@tiptap/starter-kit');
const { Underline } = require('@tiptap/extension-underline');
const { Link } = require('@tiptap/extension-link');
const { Image } = require('@tiptap/extension-image');
const { TaskList, TaskItem } = require('@tiptap/extension-list');
const { Markdown } = require('@tiptap/markdown');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');

const KangarooLink = Link.extend({
    addOptions() {
        return {
            ...this.parent?.(),
            openOnClick: false,
            resolveDisplayMeta: null
        };
    },
    renderHTML({ HTMLAttributes }) {
        const href = String(HTMLAttributes?.href || '');
        const displayMeta = this.options.resolveDisplayMeta
            ? this.options.resolveDisplayMeta(href)
            : getLinkDisplayMeta(href);

        const classes = ['kangaroo-link'];
        if (displayMeta.kind) {
            classes.push(`kangaroo-link-${displayMeta.kind}`);
        }

        return ['a', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
            class: classes.join(' '),
            'data-link-kind': displayMeta.kind || 'link',
            'data-link-icon': displayMeta.icon || '↗',
            'data-link-badge': displayMeta.badge || '链接',
            title: HTMLAttributes?.title || displayMeta.title || href || ''
        }), 0];
    }
});

const ResizableImage = Image.extend({
    addOptions() {
        return {
            ...this.parent?.(),
            resolveSrc: null,
            resize: {
                enabled: true,
                directions: ['bottom-right'],
                minWidth: 80,
                minHeight: 80,
                alwaysPreserveAspectRatio: true
            }
        };
    },
    atom: true,
    selectable: true,
    renderHTML({ HTMLAttributes }) {
        const resolvedSrc = this.options.resolveSrc
            ? this.options.resolveSrc(HTMLAttributes?.src)
            : HTMLAttributes?.src;

        return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
            src: resolvedSrc
        })];
    },
    renderMarkdown(node) {
        const src = node.attrs?.src || '';
        const alt = node.attrs?.alt || '';
        const title = node.attrs?.title || '';
        const width = node.attrs?.width;
        const height = node.attrs?.height;

        if (width || height) {
            const attributes = [`src="${escapeHtmlAttribute(src)}"`];

            if (alt) attributes.push(`alt="${escapeHtmlAttribute(alt)}"`);
            if (title) attributes.push(`title="${escapeHtmlAttribute(title)}"`);
            if (width) attributes.push(`width="${escapeHtmlAttribute(String(width))}"`);
            if (height) attributes.push(`height="${escapeHtmlAttribute(String(height))}"`);

            return `<img ${attributes.join(' ')} />`;
        }

        return this.parent?.(node) || `![${alt}](${src})`;
    },
    addNodeView() {
        if (!this.options.resize || !this.options.resize.enabled || typeof document === 'undefined') {
            return null;
        }

        const { minWidth, minHeight, alwaysPreserveAspectRatio } = this.options.resize;

        return ({ node, getPos, HTMLAttributes, editor }) => {
            let currentNode = node;
            let isResizing = false;
            let startX = 0;
            let startY = 0;
            let startWidth = 0;
            let startHeight = 0;
            let aspectRatio = 1;

            const container = document.createElement('div');
            container.dataset.resizeContainer = '';
            container.dataset.node = this.name;

            const wrapper = document.createElement('div');
            wrapper.dataset.resizeWrapper = '';
            wrapper.style.position = 'relative';
            wrapper.style.display = 'inline-block';
            wrapper.style.maxWidth = '100%';

            const el = document.createElement('img');
            const handle = document.createElement('div');
            handle.dataset.resizeHandle = 'bottom-right';
            const selectSelf = () => {
                this.editor?.storage?.kangarooWysiwygInstance?.selectImageNode?.(nodeViewApi);
            };
            const deselectSelf = () => {
                container.classList.remove('ProseMirror-selectednode', 'is-selected');
            };

            const applyNodeSelection = (preserveScroll = true) => {
                selectSelf();
                editor.commands.focus(undefined, {
                    scrollIntoView: !preserveScroll
                });
            };

            Object.entries(HTMLAttributes).forEach(([key, value]) => {
                if (value == null) return;
                if (key === 'width' || key === 'height' || key === 'src') return;
                el.setAttribute(key, value);
            });

            el.draggable = false;
            el.addEventListener('mousedown', (event) => {
                event.preventDefault();
                applyNodeSelection(true);
            });

            const syncImageSource = (src) => {
                const resolvedSrc = this.options.resolveSrc
                    ? this.options.resolveSrc(src)
                    : src;

                if (!resolvedSrc) return;

                el.setAttribute('src', resolvedSrc);
                el.src = resolvedSrc;
            };

            const syncNodeState = (updatedNode = currentNode) => {
                currentNode = updatedNode;
                syncImageSource(updatedNode.attrs?.src || HTMLAttributes.src);

                const width = Number(updatedNode.attrs?.width || 0);
                const height = Number(updatedNode.attrs?.height || 0);

                if (width > 0) {
                    el.style.width = `${width}px`;
                } else {
                    el.style.width = '';
                }

                if (height > 0) {
                    el.style.height = `${height}px`;
                } else if (width > 0) {
                    el.style.height = 'auto';
                } else {
                    el.style.height = '';
                }
            };

            const handleMouseMove = (event) => {
                if (!isResizing) return;

                const deltaX = event.clientX - startX;
                const deltaY = event.clientY - startY;
                let nextWidth = Math.max(minWidth, Math.round(startWidth + deltaX));
                let nextHeight = Math.max(minHeight, Math.round(startHeight + deltaY));

                if (alwaysPreserveAspectRatio && aspectRatio > 0) {
                    nextHeight = Math.max(minHeight, Math.round(nextWidth / aspectRatio));
                }

                el.style.width = `${nextWidth}px`;
                el.style.height = `${nextHeight}px`;
            };

            const handleMouseUp = () => {
                if (!isResizing) return;
                isResizing = false;
                document.removeEventListener('mousemove', handleMouseMove);
                document.removeEventListener('mouseup', handleMouseUp);

                const pos = getPos();
                if (typeof pos !== 'number') {
                    return;
                }

                const appliedWidth = Math.max(minWidth, Math.round(el.getBoundingClientRect().width));
                const appliedHeight = Math.max(minHeight, Math.round(el.getBoundingClientRect().height));
                const scrollHost = this.editor?.storage?.kangarooWysiwygInstance?.host || editor.view.dom.parentElement || null;
                const previousScrollTop = scrollHost ? scrollHost.scrollTop : 0;
                const previousScrollLeft = scrollHost ? scrollHost.scrollLeft : 0;
                const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
                    ...currentNode.attrs,
                    width: appliedWidth,
                    height: appliedHeight
                });
                editor.view.dispatch(tr);
                if (scrollHost) {
                    scrollHost.scrollTop = previousScrollTop;
                    scrollHost.scrollLeft = previousScrollLeft;
                }
                applyNodeSelection(true);
            };

            el.draggable = false;
            el.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                applyNodeSelection(true);
            });

            handle.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                applyNodeSelection(true);

                const rect = el.getBoundingClientRect();
                startX = event.clientX;
                startY = event.clientY;
                startWidth = rect.width;
                startHeight = rect.height;
                aspectRatio = rect.height > 0 ? rect.width / rect.height : 1;
                isResizing = true;

                document.addEventListener('mousemove', handleMouseMove);
                document.addEventListener('mouseup', handleMouseUp);
            });

            wrapper.appendChild(el);
            wrapper.appendChild(handle);
            container.appendChild(wrapper);
            syncNodeState(currentNode);

            const nodeViewApi = {
                select: () => {
                    container.classList.add('ProseMirror-selectednode', 'is-selected');
                },
                deselect: deselectSelf,
                getPos,
                getNode: () => currentNode,
                getDom: () => container,
                getImageElement: () => el,
                getSourceSrc: () => String(currentNode?.attrs?.src || HTMLAttributes.src || ''),
                getResolvedSrc: () => String(el.getAttribute('src') || '')
            };

            container.__kangarooImageNodeView = nodeViewApi;

            return {
                dom: container,
                update: (updatedNode) => {
                    if (updatedNode.type !== currentNode.type) {
                        return false;
                    }

                    syncNodeState(updatedNode);
                    return true;
                },
                selectNode: () => {
                    nodeViewApi.select();
                },
                deselectNode: () => {
                    nodeViewApi.deselect();
                },
                stopEvent: (event) => {
                    return event.target === el || event.target === handle;
                },
                ignoreMutation: () => true,
                destroy: () => {
                    document.removeEventListener('mousemove', handleMouseMove);
                    document.removeEventListener('mouseup', handleMouseUp);
                    delete container.__kangarooImageNodeView;
                    if (this.editor?.storage?.kangarooWysiwygInstance?.selectedImageNodeView === nodeViewApi) {
                        this.editor.storage.kangarooWysiwygInstance.clearSelectedImageNode();
                    }
                }
            };
        };
    },
    addKeyboardShortcuts() {
        return {
            Backspace: () => {
                const { selection } = this.editor.state;
                if (selection?.node?.type?.name !== this.name) return false;
                return this.editor.commands.deleteSelection();
            },
            Delete: () => {
                const { selection } = this.editor.state;
                if (selection?.node?.type?.name !== this.name) return false;
                return this.editor.commands.deleteSelection();
            }
        };
    }
});

class KangarooWysiwygEditor {
    constructor(container, initialMarkdown = '') {
        this.container = container;
        this.listeners = new Set();
        this.lineBlocks = [];
        this.activeHighlightElement = null;
        this.clearHighlightTimer = null;
        this.isApplyingExternalUpdate = false;
        this.currentMarkdown = normalizeMarkdown(initialMarkdown);
        this.bundlePath = null;
        this.pendingMarkdownLinkConversion = false;
        this.pendingRawLinkConversion = false;
        this.pendingLinkHrefSync = false;
        this.selectedImageNodeView = null;
        this.selectedLinkInfo = null;
        this.selectedLinkElement = null;
        this.selectedLinkOverlay = null;
        this.kindAnchors = {
            heading: [],
            task: [],
            attachment: []
        };
        this.docKindAnchors = {
            heading: [],
            task: [],
            attachment: []
        };

        container.innerHTML = '';

        this.host = document.createElement('div');
        this.host.className = 'wysiwyg-editor-host';

        this.root = document.createElement('div');
        this.root.className = 'wysiwyg-editor-root';
        this.host.appendChild(this.root);

        this.selectedLinkOverlay = document.createElement('div');
        this.selectedLinkOverlay.className = 'wysiwyg-link-selection';
        this.host.appendChild(this.selectedLinkOverlay);
        container.appendChild(this.host);

        this.editor = new Editor({
            element: this.root,
            content: this.currentMarkdown,
            contentType: 'markdown',
            autofocus: false,
            extensions: [
                StarterKit.configure({
                    link: false
                }),
                Underline,
                KangarooLink.configure({
                    autolink: true,
                    linkOnPaste: true,
                    protocols: ['http', 'https', 'file', 'mailto', 'zotero'],
                    resolveDisplayMeta: (href) => this.resolveLinkDisplayMeta(href)
                }),
                TaskList,
                TaskItem.configure({
                    nested: true
                }),
                ResizableImage.configure({
                    resolveSrc: (src) => this.resolveDisplaySource(src)
                }),
                Markdown.configure({
                    markedOptions: {
                        gfm: true,
                        breaks: true
                    }
                })
            ],
            editorProps: {
                attributes: {
                    class: 'kangaroo-prosemirror'
                },
                handleKeyDown: (view, event) => {
                    if (event.key !== 'Backspace' && event.key !== 'Delete') {
                        return false;
                    }

                    if (this.selectedImageNodeView) {
                        event.preventDefault();
                        this.deleteSelectedImageNode();
                        return true;
                    }

                    if (this.selectedLinkInfo) {
                        event.preventDefault();
                        this.deleteSelectedLink();
                        return true;
                    }

                    return false;
                }
            },
            onCreate: () => {
                this.syncMarkdown();
                this.refreshLineMap();
                this.refreshLinkDomState();
                this.normalizeLinkDisplayToHref();
                this.normalizeInternalResourceLinkLabels();
            },
            onSelectionUpdate: () => {
                this.refreshLineMap();
                this.syncSelectedLinkWithSelection();
            },
            onUpdate: () => {
                if (this.isApplyingExternalUpdate) return;
                this.syncMarkdown();
                this.refreshLineMap();
                this.refreshLinkDomState();
                this.emitChange();
                this.scheduleRawLinkConversion();
                this.scheduleLinkHrefSync();
            }
        });
        this.editor.storage.kangarooWysiwygInstance = this;

        this.syncMarkdown();
        this.refreshLineMap();
        this.root.addEventListener('mousedown', (event) => {
            const targetElement = getEventTargetElement(event.target);
            if (targetElement?.closest?.('[data-resize-container][data-node="image"]')) {
                return;
            }

            if (targetElement?.closest?.('a.kangaroo-link')) {
                return;
            }

            this.clearSelectedImageNode();
            this.clearSelectedLink();
        }, true);
        this.host.addEventListener('mousedown', (event) => {
            if (event.button !== 0) return;
            if (this.handleTrailingBlankAreaClick(event)) {
                event.preventDefault();
                event.stopPropagation();
            }
        }, true);
        this.root.addEventListener('change', (event) => {
            const targetElement = getEventTargetElement(event.target);
            if (!(targetElement instanceof HTMLInputElement) || targetElement.type !== 'checkbox') {
                return;
            }

            if (!targetElement.closest('li[data-type="taskItem"]')) {
                return;
            }

            window.requestAnimationFrame(() => {
                this.syncMarkdown();
                this.refreshLineMap();
                this.refreshLinkDomState();
                this.emitChange();
            });
        }, true);
        this.host.addEventListener('scroll', () => {
            this.updateSelectedLinkOverlay();
        }, { passive: true });
    }

    destroy() {
        if (this.clearHighlightTimer) {
            window.clearTimeout(this.clearHighlightTimer);
            this.clearHighlightTimer = null;
        }

        this.clearSelectedImageNode();
        this.clearSelectedLink();
        this.editor.destroy();
    }

    getValue() {
        return this.currentMarkdown;
    }

    setValue(markdown, options = {}) {
        const { emitChange = false } = options;
        this.currentMarkdown = normalizeMarkdown(markdown);
        this.isApplyingExternalUpdate = true;
        this.editor.commands.setContent(this.currentMarkdown, {
            contentType: 'markdown',
            emitUpdate: false
        });
        this.isApplyingExternalUpdate = false;
        this.refreshLineMap();
        this.refreshLinkDomState();
        this.normalizeLinkDisplayToHref();
        this.normalizeInternalResourceLinkLabels();

        if (emitChange) {
            this.emitChange();
        }
    }

    refreshDisplayState() {
        const selection = {
            from: this.editor.state.selection.from,
            to: this.editor.state.selection.to
        };

        this.clearSelectedImageNode();
        this.clearSelectedLink();

        this.isApplyingExternalUpdate = true;
        this.editor.commands.setContent(this.currentMarkdown, {
            contentType: 'markdown',
            emitUpdate: false
        });
        this.isApplyingExternalUpdate = false;

        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const from = clampNumber(selection.from, 1, maxPos);
        const to = clampNumber(selection.to, 1, maxPos);
        this.editor.chain().setTextSelection({ from, to }).run();
        this.refreshLineMap();
        this.refreshLinkDomState();
    }

    focus() {
        this.editor.commands.focus();
    }

    focusEndWithoutScroll() {
        this.editor.commands.focus('end', {
            scrollIntoView: false
        });
    }

    updateOptions(options = {}) {
        if (options.fontFamily) {
            this.host.style.setProperty('--wysiwyg-editor-font-family', options.fontFamily);
        }

        if (options.fontSize) {
            this.host.style.setProperty('--wysiwyg-editor-font-size', `${options.fontSize}px`);
        }
    }

    setEditable(editable) {
        const isEditable = Boolean(editable);
        this.editor.setEditable(isEditable);
        this.host.classList.toggle('is-readonly', !isEditable);
    }

    onDidChangeModelContent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    insertText(text) {
        if (!text) return;
        this.editor.chain().focus().insertContent(text).run();
    }

    insertMarkdown(markdown) {
        if (!markdown) return;
        this.editor.chain().focus().insertContent(markdown, { contentType: 'markdown' }).run();
    }

    insertLink(label, href, options = {}) {
        const displayLabel = String(label || '').trim();
        const targetHref = String(href || '').trim();
        const { insertTrailingParagraph = true } = options;

        if (!displayLabel || !targetHref) {
            return false;
        }

        const content = {
            type: 'text',
            text: displayLabel,
            marks: [{
                type: 'link',
                attrs: {
                    href: targetHref,
                    title: null
                }
            }]
        };

        const chain = this.editor.chain().focus().insertContent(content);

        if (insertTrailingParagraph) {
            chain.enter();
        }

        return chain.run();
    }

    toggleHeading(level) {
        const headingLevel = clampNumber(Number(level), 1, 6);
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleHeading({ level: headingLevel }).run();
    }

    toggleBulletList() {
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleBulletList().run();
    }

    toggleOrderedList() {
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleOrderedList().run();
    }

    toggleTaskList() {
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleTaskList().run();
    }

    toggleBold() {
        const selectionEmpty = this.editor.state.selection.empty;
        if (selectionEmpty) {
            return false;
        }

        const selectionEnd = this.editor.state.selection.to;
        const didRun = this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleBold().run();

        if (didRun) {
            this.editor.chain().focus(undefined, {
                scrollIntoView: false
            }).setTextSelection(selectionEnd).unsetBold().run();
            this.editor.view.dispatch(this.editor.state.tr.setStoredMarks([]));
        }

        return didRun;
    }

    toggleUnderline() {
        const selectionEmpty = this.editor.state.selection.empty;
        if (selectionEmpty) {
            return false;
        }

        const selectionEnd = this.editor.state.selection.to;
        const didRun = this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleUnderline().run();

        if (didRun) {
            this.editor.chain().focus(undefined, {
                scrollIntoView: false
            }).setTextSelection(selectionEnd).unsetUnderline().run();
            this.editor.view.dispatch(this.editor.state.tr.setStoredMarks([]));
        }

        return didRun;
    }

    toggleStrike() {
        const selectionEmpty = this.editor.state.selection.empty;
        if (selectionEmpty) {
            return false;
        }

        const selectionEnd = this.editor.state.selection.to;
        const didRun = this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).toggleStrike().run();

        if (didRun) {
            this.editor.chain().focus(undefined, {
                scrollIntoView: false
            }).setTextSelection(selectionEnd).unsetStrike().run();
            this.editor.view.dispatch(this.editor.state.tr.setStoredMarks([]));
        }

        return didRun;
    }

    getToolbarState() {
        return {
            headingLevel: [1, 2, 3, 4, 5, 6].find((level) => this.editor.isActive('heading', { level })) || 0,
            bulletList: this.editor.isActive('bulletList'),
            orderedList: this.editor.isActive('orderedList'),
            taskList: this.editor.isActive('taskList'),
            bold: this.editor.isActive('bold'),
            underline: this.editor.isActive('underline'),
            strike: this.editor.isActive('strike')
        };
    }

    handleTrailingBlankAreaClick(event) {
        const targetElement = getEventTargetElement(event.target);
        if (!targetElement) return false;
        if (targetElement.closest('[data-resize-container][data-node="image"]')) return false;
        if (targetElement.closest('a.kangaroo-link')) return false;

        const proseMirror = this.root.querySelector('.ProseMirror');
        if (!proseMirror) return false;
        if (targetElement !== this.host && targetElement !== this.root && targetElement !== proseMirror) {
            return false;
        }

        const contentBottom = this.getEditorContentBottom();
        if (!Number.isFinite(contentBottom) || event.clientY <= contentBottom + 6) {
            return false;
        }

        this.placeCursorOnTrailingBlankLine();
        return true;
    }

    getEditorContentBottom() {
        const proseMirror = this.root.querySelector('.ProseMirror');
        if (!proseMirror) return NaN;

        const lastChild = Array.from(proseMirror.children).reverse().find((node) => node instanceof HTMLElement);
        if (!lastChild) {
            return proseMirror.getBoundingClientRect().top;
        }

        return lastChild.getBoundingClientRect().bottom;
    }

    placeCursorOnTrailingBlankLine() {
        const { doc } = this.editor.state;
        const lastNode = doc.lastChild;
        const docEnd = doc.content.size;

        if (lastNode?.type?.name === 'paragraph' && !String(lastNode.textContent || '').trim()) {
            this.focusEndWithoutScroll();
            return;
        }

        this.editor.chain()
            .focus('end', { scrollIntoView: false })
            .insertContent({ type: 'paragraph' })
            .run();

        this.focusEndWithoutScroll();
    }

    getCurrentTextblockContext() {
        const { selection } = this.editor.state;
        const { $from } = selection;

        for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (!node?.isTextblock) continue;

            let insideTask = false;
            for (let parentDepth = depth; parentDepth >= 0; parentDepth--) {
                if ($from.node(parentDepth)?.type?.name === 'taskItem') {
                    insideTask = true;
                    break;
                }
            }

            return {
                depth,
                node,
                from: $from.before(depth),
                to: $from.after(depth),
                text: String(node.textContent || ''),
                isEmpty: !String(node.textContent || '').trim(),
                insideTask
            };
        }

        return null;
    }

    getSelectionLineRange() {
        const { from, to, empty } = this.editor.state.selection;
        const anchorLine = this.resolveLineFromPos(from)
            || this.getAnchorLineFromCursor();
        const effectiveTo = empty ? to : Math.max(from, to - 1);
        const focusLine = this.resolveLineFromPos(effectiveTo)
            || anchorLine;

        return {
            startLine: Math.min(anchorLine, focusLine),
            endLine: Math.max(anchorLine, focusLine)
        };
    }

    getTextblockOrderAtPos(pos) {
        if (typeof pos !== 'number') return null;

        let order = 0;
        let match = null;
        this.editor.state.doc.descendants((node, nodePos) => {
            if (!node?.isTextblock) {
                return true;
            }

            const from = nodePos + 1;
            const to = nodePos + Math.max(node.nodeSize - 1, 1);
            if (pos >= from && pos <= to) {
                match = order;
                return false;
            }

            order += 1;
            return true;
        });

        return match;
    }

    getCurrentTextblockOrder() {
        return this.getTextblockOrderAtPos(this.editor.state.selection.from);
    }

    jumpToTextblockOrder(order) {
        if (!Number.isInteger(order) || order < 0) {
            return false;
        }

        let currentOrder = 0;
        let targetPos = null;
        this.editor.state.doc.descendants((node, nodePos) => {
            if (!node?.isTextblock) {
                return true;
            }

            if (currentOrder === order) {
                targetPos = nodePos + 1;
                return false;
            }

            currentOrder += 1;
            return true;
        });

        if (typeof targetPos !== 'number') {
            return false;
        }

        this.editor.chain().focus().setTextSelection(targetPos).run();
        this.scrollPositionIntoView(targetPos);
        return true;
    }

    getLineText(lineNumber) {
        return this.currentMarkdown.split('\n')[lineNumber - 1] || '';
    }

    getTaskKindIndexForLine(lineNumber, markdown = this.currentMarkdown) {
        const lines = String(markdown || '').split('\n');
        let taskIndex = 0;

        for (let index = 0; index < lines.length; index++) {
            const isTaskLine = /^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/.test(lines[index]);
            if (!isTaskLine) continue;

            if (index + 1 === lineNumber) {
                return taskIndex;
            }

            taskIndex += 1;
        }

        return null;
    }

    getSelectedTextblockEntries() {
        const { from, to } = this.editor.state.selection;
        const entries = [];
        const seen = new Set();

        this.editor.state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node?.isTextblock) {
                return true;
            }

            const lineNumber = this.resolveLineFromPos(pos + 1);
            if (!lineNumber || seen.has(lineNumber)) {
                return true;
            }

            seen.add(lineNumber);
            entries.push({
                lineNumber,
                text: String(node.textContent || '')
            });
            return true;
        });

        return entries.sort((a, b) => a.lineNumber - b.lineNumber);
    }

    getSelectedTextblockLineNumbers() {
        return this.getSelectedTextblockEntries().map((entry) => entry.lineNumber);
    }

    replaceLines(startLine, endLine, newLines, options = {}) {
        const textblockOrder = Number.isInteger(options.textblockOrder)
            ? options.textblockOrder
            : this.getCurrentTextblockOrder();
        const lines = this.currentMarkdown.split('\n');
        const nextLines = [
            ...lines.slice(0, Math.max(startLine - 1, 0)),
            ...newLines,
            ...lines.slice(endLine)
        ];

        let nextMarkdown = nextLines.join('\n');
        if (this.currentMarkdown.endsWith('\n') && !nextMarkdown.endsWith('\n')) {
            nextMarkdown += '\n';
        }

        this.setValue(nextMarkdown, { emitChange: true });
        if (this.jumpToTextblockOrder(textblockOrder)) {
            return;
        }

        if (options.preferredKind === 'task') {
            const taskKindIndex = this.getTaskKindIndexForLine(startLine, nextMarkdown);
            if (Number.isInteger(taskKindIndex)) {
                this.jumpToAnchor('task', taskKindIndex, {
                    lineNumber: startLine,
                    preferredKind: 'task'
                });
                return;
            }
        }

        this.jumpToLine(startLine, {
            preferredText: options.preferredText ?? newLines[0] ?? '',
            preferredKind: options.preferredKind
        });
    }

    replaceSpecificLines(lineNumbers, getNextLine, options = {}) {
        const textblockOrder = Number.isInteger(options.textblockOrder)
            ? options.textblockOrder
            : this.getCurrentTextblockOrder();
        const uniqueLines = Array.from(new Set(lineNumbers.filter(Boolean))).sort((a, b) => a - b);
        if (!uniqueLines.length) {
            return false;
        }

        const lines = this.currentMarkdown.split('\n');
        let firstReplacement = '';
        for (const lineNumber of uniqueLines) {
            const index = lineNumber - 1;
            if (index < 0 || index >= lines.length) continue;
            const nextLine = getNextLine(lines[index], lineNumber);
            lines[index] = nextLine;
            if (!firstReplacement) {
                firstReplacement = nextLine;
            }
        }

        let nextMarkdown = lines.join('\n');
        if (this.currentMarkdown.endsWith('\n') && !nextMarkdown.endsWith('\n')) {
            nextMarkdown += '\n';
        }

        this.setValue(nextMarkdown, { emitChange: true });
        if (this.jumpToTextblockOrder(textblockOrder)) {
            return true;
        }

        if (options.preferredKind === 'task') {
            const taskKindIndex = this.getTaskKindIndexForLine(uniqueLines[0], nextMarkdown);
            if (Number.isInteger(taskKindIndex)) {
                this.jumpToAnchor('task', taskKindIndex, {
                    lineNumber: uniqueLines[0],
                    preferredKind: 'task'
                });
                return true;
            }
        }

        this.jumpToLine(uniqueLines[0], {
            preferredText: options.preferredText ?? firstReplacement,
            preferredKind: options.preferredKind
        });
        return true;
    }

    getAnchorLineFromCursor() {
        return this.resolveLineFromPos(this.editor.state.selection.from) || 1;
    }

    getAnchorLineFromViewport() {
        if (!this.lineBlocks.length) {
            return this.getAnchorLineFromCursor();
        }

        const hostRect = this.host.getBoundingClientRect();
        const anchorY = hostRect.top + Math.min(Math.max(this.host.clientHeight * 0.35, 40), this.host.clientHeight - 24);
        const match = this.lineBlocks.find((entry) => {
            const position = this.getEditorPositionForBlock(entry);
            if (typeof position !== 'number') return false;
            const rect = this.getCoordsForPosition(position);
            if (!rect) return false;
            return rect.bottom >= anchorY;
        });

        return match?.lineNumber || this.lineBlocks[this.lineBlocks.length - 1]?.lineNumber || 1;
    }

    jumpToLine(lineNumber, options = {}) {
        const block = this.findBlockForLine(lineNumber, options);
        if (!block) {
            this.focus();
            return;
        }

        const position = this.getEditorPositionForBlock(block);
        if (typeof position !== 'number') {
            this.focus();
            return;
        }

        this.editor.chain().focus().setTextSelection(position).run();
        this.scrollPositionIntoView(position);
    }

    jumpToAnchor(kind, kindIndex, options = {}) {
        const block = this.findBlockByKindIndex(kind, kindIndex, options);
        if (!block) {
            this.jumpToLine(options.lineNumber || 1, options);
            return;
        }

        const position = this.getEditorPositionForBlock(block);
        if (typeof position !== 'number') {
            this.focus();
            return;
        }

        this.editor.chain().focus().setTextSelection(position).run();
        this.scrollPositionIntoView(position);
    }

    highlightLine(lineNumber) {
        if (this.activeHighlightElement) {
            this.activeHighlightElement.classList.remove('wysiwyg-active-block');
        }

        const block = this.findBlockForLine(lineNumber);
        if (!block) return;

        const position = this.getEditorPositionForBlock(block);
        const blockNode = this.getHighlightNodeForPosition(position);
        if (!blockNode) return;

        this.activeHighlightElement = blockNode;
        blockNode.classList.add('wysiwyg-active-block');

        if (this.clearHighlightTimer) {
            window.clearTimeout(this.clearHighlightTimer);
        }

        this.clearHighlightTimer = window.setTimeout(() => {
            if (this.activeHighlightElement) {
                this.activeHighlightElement.classList.remove('wysiwyg-active-block');
            }
            this.activeHighlightElement = null;
        }, 1200);
    }

    getRootElement() {
        return this.host;
    }

    setBundlePath(bundlePath) {
        this.bundlePath = bundlePath ? path.resolve(String(bundlePath)) : null;
        this.refreshImages();
        this.refreshLinkDomState();
    }

    getModel() {
        return {
            getPositionAt: (offset) => getPositionAtOffset(this.currentMarkdown, offset)
        };
    }

    getSearchTargets() {
        return [
            ...this.docKindAnchors.heading,
            ...this.docKindAnchors.task,
            ...this.docKindAnchors.attachment,
            ...this.lineBlocks.filter((entry) => !entry.kind || !this.kindAnchors[entry.kind])
        ]
            .filter((entry) => entry.displayText)
            .map((entry) => ({
                lineNumber: entry.lineNumber,
                text: entry.displayText,
                kind: entry.kind || '',
                kindIndex: Number.isInteger(entry.kindIndex) ? entry.kindIndex : null
            }));
    }

    getSearchMatches(query, limit = 200) {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedQuery) {
            return [];
        }

        const matches = [];
        const pushMatches = (entryMatches = []) => {
            for (const match of entryMatches) {
                matches.push(match);
                if (matches.length >= limit) {
                    return false;
                }
            }

            return true;
        };

        let headingIndex = 0;
        let taskIndex = 0;
        let attachmentIndex = 0;
        const seenAttachmentKeys = new Set();

        this.editor.state.doc.descendants((node, pos) => {
            if (matches.length >= limit) {
                return false;
            }

            const type = node.type?.name;

            if (type === 'heading') {
                const nextMatches = buildTextSearchMatchesForNode(
                    node,
                    pos,
                    normalizedQuery,
                    {
                        kind: 'heading',
                        kindIndex: headingIndex,
                        kindLabel: '标题',
                        lineNumber: this.resolveLineFromPos(pos + 1) || 1
                    }
                );
                headingIndex += 1;
                pushMatches(nextMatches);
                return false;
            }

            if (type === 'taskItem') {
                const firstTextblock = findFirstTextblockInNode(node, pos);
                if (firstTextblock) {
                    const nextMatches = buildTextSearchMatchesForNode(
                        firstTextblock.node,
                        firstTextblock.pos,
                        normalizedQuery,
                        {
                            kind: 'task',
                            kindIndex: taskIndex,
                            kindLabel: '待办',
                            lineNumber: this.resolveLineFromPos(firstTextblock.pos) || 1
                        }
                    );
                    taskIndex += 1;
                    pushMatches(nextMatches);
                    return false;
                }

                taskIndex += 1;
                return false;
            }

            if (node.isTextblock) {
                const nextMatches = buildTextSearchMatchesForNode(
                    node,
                    pos,
                    normalizedQuery,
                    {
                        kind: 'text',
                        kindIndex: null,
                        kindLabel: '正文',
                        lineNumber: this.resolveLineFromPos(pos + 1) || 1
                    }
                );
                return pushMatches(nextMatches);
            }

            if (node.isText && node.marks?.length) {
                for (const mark of node.marks) {
                    const href = String(mark.attrs?.href || '');
                    if (!/attachments\//i.test(href)) continue;

                    const relativePath = normalizeLinkHref(href).replace(/^\.?\//, '');
                    const label = String(node.text || path.basename(relativePath)).trim();
                    const searchableText = `${label} ${relativePath}`.trim();
                    const normalizedText = searchableText.toLowerCase();
                    const matchIndex = normalizedText.indexOf(normalizedQuery);
                    if (matchIndex === -1) continue;

                    const attachmentKey = `${pos}:${relativePath}:${label}`;
                    if (seenAttachmentKeys.has(attachmentKey)) continue;
                    seenAttachmentKeys.add(attachmentKey);

                    matches.push({
                        kind: 'attachment',
                        kindLabel: '附件',
                        kindIndex: attachmentIndex++,
                        lineNumber: this.resolveLineFromPos(pos) || 1,
                        text: label || path.basename(relativePath),
                        meta: relativePath,
                        snippet: buildSearchSnippet(searchableText, matchIndex, matchIndex + normalizedQuery.length),
                        from: pos,
                        to: pos + node.nodeSize,
                        pos
                    });

                    if (matches.length >= limit) {
                        return false;
                    }
                }
            }

            return true;
        });

        return matches;
    }

    getTodoItems() {
        return this.docKindAnchors.task.map((entry) => ({
            lineNumber: entry.lineNumber || 1,
            checked: Boolean(entry.checked),
            text: entry.displayText || '',
            kindIndex: entry.kindIndex
        }));
    }

    setTaskCheckedByKindIndex(kindIndex, checked) {
        const index = Number(kindIndex);
        if (!Number.isInteger(index)) return false;

        const nextChecked = Boolean(checked);
        const lines = this.currentMarkdown.split('\n');
        let currentTaskIndex = 0;
        let didUpdate = false;

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
            const match = lines[lineIndex].match(/^(\s*)([-+*])\s+\[([ xX])\]\s*(.*)$/);
            if (!match) continue;

            if (currentTaskIndex === index) {
                if ((match[3] || '').toLowerCase() === (nextChecked ? 'x' : ' ')) {
                    return true;
                }

                lines[lineIndex] = `${match[1]}${match[2]} [${nextChecked ? 'x' : ' '}] ${match[4] || ''}`;
                didUpdate = true;
                break;
            }

            currentTaskIndex += 1;
        }

        if (!didUpdate) {
            return false;
        }

        let nextMarkdown = lines.join('\n');
        if (this.currentMarkdown.endsWith('\n') && !nextMarkdown.endsWith('\n')) {
            nextMarkdown += '\n';
        }

        this.setValue(nextMarkdown, { emitChange: true });
        return true;
    }

    getAttachmentReferences() {
        return this.docKindAnchors.attachment.map((entry) => {
            const relativePath = String(entry.relativePath || '').replace(/^\/+/, '');
            const fullRelativePath = relativePath.startsWith('attachments/')
                ? relativePath
                : path.join('attachments', relativePath);
            const absolutePath = this.bundlePath
                ? path.resolve(this.bundlePath, fullRelativePath)
                : path.resolve(fullRelativePath);

            let stat = null;
            try {
                stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
            } catch {
                stat = null;
            }

            return {
                label: entry.displayText || path.basename(relativePath),
                relativePath: fullRelativePath,
                absolutePath,
                lineNumber: entry.lineNumber || 1,
                exists: Boolean(stat),
                isDirectory: Boolean(stat && stat.isDirectory()),
                kindIndex: entry.kindIndex
            };
        });
    }

    jumpToSearchResult(result) {
        if (!result) return false;

        const from = typeof result.from === 'number' ? result.from : null;
        const to = typeof result.to === 'number' ? result.to : from;
        const pos = typeof result.pos === 'number' ? result.pos : from;

        if (from == null || to == null || pos == null) {
            return false;
        }

        this.editor.chain().focus().setTextSelection({ from, to }).run();
        this.scrollPositionIntoView(pos);
        return true;
    }

    toggleTodoSelection() {
        const currentBlock = this.getCurrentTextblockContext();
        if (currentBlock && this.editor.state.selection.empty) {
            return this.editor.chain().focus(undefined, {
                scrollIntoView: false
            }).toggleTaskList().run();
        }

        const { startLine, endLine } = this.getSelectionLineRange();
        if (!startLine || !endLine) {
            return false;
        }
        const selectedEntries = this.getSelectedTextblockEntries();
        if (selectedEntries.length) {
            const selectedLineNumbers = selectedEntries.map((entry) => entry.lineNumber);
            const allSelectedAreTasks = selectedLineNumbers.every((lineNumber) => isTodoMarkdownLine(this.getLineText(lineNumber)));
            const replacementLines = [];

            selectedEntries.forEach((entry, index) => {
                const currentLine = this.getLineText(entry.lineNumber);
                const nextLine = allSelectedAreTasks
                    ? stripTodoLineToParagraph(currentLine, entry.text)
                    : createTodoLineFromText(entry.text, false);

                if (allSelectedAreTasks && index > 0) {
                    replacementLines.push('');
                }
                replacementLines.push(nextLine);
            });

            this.replaceLines(
                selectedLineNumbers[0],
                selectedLineNumbers[selectedLineNumbers.length - 1],
                replacementLines,
                {
                    preferredKind: allSelectedAreTasks ? 'paragraph' : 'task',
                    preferredText: selectedEntries[0]?.text || '',
                    textblockOrder: this.getCurrentTextblockOrder()
                }
            );
            return true;
        }

        const nextLines = [];
        for (let lineNumber = startLine; lineNumber <= endLine; lineNumber++) {
            nextLines.push(normalizeTodoLine(this.getLineText(lineNumber), false));
        }

        this.replaceLines(startLine, endLine, nextLines, {
            preferredText: nextLines[0] || '',
            preferredKind: 'task',
            textblockOrder: this.getCurrentTextblockOrder()
        });
        return true;
    }

    getCurrentDropLocation() {
        return this.getDropLocationFromPos(this.editor.state.selection.from);
    }

    getDropLocation(clientX, clientY) {
        const position = this.editor.view.posAtCoords({ left: clientX, top: clientY });
        if (!position || typeof position.pos !== 'number') {
            return this.getCurrentDropLocation();
        }

        return this.getDropLocationFromPos(position.pos);
    }

    applyDropLocation(location) {
        if (!location || typeof location.pos !== 'number') return;
        this.editor.chain().focus().setTextSelection(location.pos).run();
    }

    syncMarkdown() {
        this.currentMarkdown = normalizeMarkdown(this.editor.getMarkdown());
    }

    emitChange() {
        for (const listener of this.listeners) {
            listener();
        }
    }

    scheduleMarkdownLinkConversion() {
        if (this.pendingMarkdownLinkConversion) return;
        this.pendingMarkdownLinkConversion = true;

        window.requestAnimationFrame(() => {
            this.pendingMarkdownLinkConversion = false;
            if (this.isApplyingExternalUpdate) return;
            this.convertMarkdownLinksInCurrentTextblock();
        });
    }

    scheduleRawLinkConversion() {
        if (this.pendingRawLinkConversion) return;
        this.pendingRawLinkConversion = true;

        window.requestAnimationFrame(() => {
            this.pendingRawLinkConversion = false;
            if (this.isApplyingExternalUpdate) return;
            this.convertRawLinksInCurrentTextblock();
        });
    }

    scheduleLinkHrefSync() {
        if (this.pendingLinkHrefSync) return;
        this.pendingLinkHrefSync = true;

        window.requestAnimationFrame(() => {
            this.pendingLinkHrefSync = false;
            if (this.isApplyingExternalUpdate) return;
            this.syncLinkHrefToVisibleText();
        });
    }

    convertMarkdownLinksInCurrentTextblock() {
        const context = this.getCurrentTextblockContext();
        if (!context || context.node?.type?.name === 'codeBlock') {
            return false;
        }

        const textStart = context.from + 1;
        const textEnd = Math.max(textStart, context.to - 1);
        const blockText = this.editor.state.doc.textBetween(textStart, textEnd, '\n', '\0');
        if (!blockText || !blockText.includes('](')) {
            return false;
        }

        const matches = [];
        const regex = /\[((?:\\.|[^\]])+?)\]\(([^)\n]+)\)/g;
        let match;
        while ((match = regex.exec(blockText)) !== null) {
            const label = String(match[1] || '').replace(/\\([\[\]\(\)\\])/g, '$1');
            const destination = parseMarkdownLinkDestination(match[2]);
            if (!label || !destination?.href) continue;

            matches.push({
                fullMatch: match[0],
                label,
                href: destination.href,
                title: destination.title,
                index: match.index
            });
        }

        if (!matches.length) {
            return false;
        }

        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) {
            return false;
        }

        let tr = this.editor.state.tr;
        let didChange = false;

        for (let index = matches.length - 1; index >= 0; index--) {
            const entry = matches[index];
            const from = textStart + entry.index;
            const to = from + entry.fullMatch.length;

            tr = tr.insertText(entry.label, from, to);
            tr = tr.addMark(
                from,
                from + entry.label.length,
                linkMark.create({
                    href: entry.href,
                    title: entry.title || null
                })
            );
            didChange = true;
        }

        if (!didChange) {
            return false;
        }

        this.editor.view.dispatch(tr);
        return true;
    }

    convertRawLinksInCurrentTextblock() {
        const context = this.getCurrentTextblockContext();
        if (!context || context.node?.type?.name === 'codeBlock') {
            return false;
        }

        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) {
            return false;
        }

        const textStart = context.from + 1;
        const textEnd = Math.max(textStart, context.to - 1);
        const blockText = this.editor.state.doc.textBetween(textStart, textEnd, '\n', '\0');
        if (!blockText) {
            return false;
        }

        const matches = [];
        const regex = /\b(?:https?:\/\/|file:\/\/|zotero:\/\/|mailto:)[^\s<>"']+/gi;
        let match;
        while ((match = regex.exec(blockText)) !== null) {
            const href = trimAutolinkHref(match[0]);
            if (!href) continue;

            const relativeOffset = match[0].indexOf(href);
            matches.push({
                href,
                from: textStart + match.index + relativeOffset,
                to: textStart + match.index + relativeOffset + href.length
            });
        }

        if (!matches.length) {
            return false;
        }

        let tr = this.editor.state.tr;
        let didChange = false;

        for (let index = matches.length - 1; index >= 0; index--) {
            const entry = matches[index];
            if (rangeHasMark(this.editor.state.doc, entry.from, entry.to, linkMark)) {
                continue;
            }

            tr = tr.addMark(
                entry.from,
                entry.to,
                linkMark.create({ href: entry.href, title: null })
            );
            didChange = true;
        }

        if (!didChange) {
            return false;
        }

        this.editor.view.dispatch(tr);
        return true;
    }

    normalizeLinkDisplayToHref() {
        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) return false;

        const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
        if (!ranges.length) return false;

        let tr = this.editor.state.tr;
        let didChange = false;

        for (let index = ranges.length - 1; index >= 0; index--) {
            const range = ranges[index];
            const href = String(range.attrs?.href || '').trim();
            const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (
                normalizedRelativeHref.startsWith('attachments/')
                || normalizedRelativeHref.startsWith('assets/')
            ) {
                continue;
            }
            if (!href || range.text === href) continue;

            tr = tr.insertText(href, range.from, range.to);
            tr = tr.addMark(
                range.from,
                range.from + href.length,
                linkMark.create({
                    ...range.attrs,
                    href
                })
            );
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    normalizeInternalResourceLinkLabels() {
        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) return false;

        const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
        if (!ranges.length) return false;

        let tr = this.editor.state.tr;
        let didChange = false;

        for (let index = ranges.length - 1; index >= 0; index--) {
            const range = ranges[index];
            const href = String(range.attrs?.href || '').trim();
            const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');

            if (
                !normalizedRelativeHref.startsWith('attachments/')
                && !normalizedRelativeHref.startsWith('assets/')
            ) {
                continue;
            }

            const preferredLabel = path.basename(normalizedRelativeHref) || normalizedRelativeHref;
            const normalizedText = String(range.text || '').trim();
            const looksLikePathLabel = !normalizedText
                || normalizeLinkHref(normalizedText).replace(/^\.?\//, '') === normalizedRelativeHref;

            if (!looksLikePathLabel || normalizedText === preferredLabel) {
                continue;
            }

            tr = tr.insertText(preferredLabel, range.from, range.to);
            tr = tr.addMark(
                range.from,
                range.from + preferredLabel.length,
                linkMark.create({
                    ...range.attrs,
                    href
                })
            );
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    syncLinkHrefToVisibleText() {
        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) return false;

        const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
        if (!ranges.length) return false;

        let tr = this.editor.state.tr;
        let didChange = false;

        for (let index = ranges.length - 1; index >= 0; index--) {
            const range = ranges[index];
            const text = String(range.text || '').trim();
            const href = String(range.attrs?.href || '').trim();
            if (!text || text === href) continue;
            if (!shouldSyncVisibleLinkTextToHref(href, text)) continue;

            tr = tr.removeMark(range.from, range.to, linkMark);
            tr = tr.addMark(
                range.from,
                range.to,
                linkMark.create({
                    ...range.attrs,
                    href: text
                })
            );
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    refreshLineMap() {
        const normalizedLines = this.currentMarkdown.split('\n').map(normalizeMarkdownLineForMatch);
        const semanticAnchors = buildMarkdownSemanticAnchors(this.currentMarkdown);
        this.docKindAnchors = buildDocKindAnchors(this.editor, semanticAnchors);
        const nextBlocks = [];
        let cursor = 0;
        const blocks = collectDocumentAnchors(this.editor);
        let headingIndex = 0;
        let taskIndex = 0;
        let attachmentIndex = 0;

        for (const block of blocks) {
            if (block.kind === 'heading') {
                block.kindIndex = headingIndex++;
            } else if (block.kind === 'task') {
                block.kindIndex = taskIndex++;
            } else if (block.kind === 'attachment') {
                block.kindIndex = attachmentIndex++;
            } else {
                block.kindIndex = null;
            }
        }

        let headingCursor = 0;
        let taskCursor = 0;
        let attachmentCursor = 0;

        for (const block of blocks) {
            const blockText = block.normalizedText;
            if (!blockText && block.isTextblock) {
                let emptyLineIndex = -1;
                for (let lineIndex = cursor; lineIndex < normalizedLines.length; lineIndex++) {
                    if (normalizedLines[lineIndex] === '') {
                        emptyLineIndex = lineIndex;
                        cursor = lineIndex + 1;
                        break;
                    }
                }

                if (emptyLineIndex !== -1) {
                    nextBlocks.push({
                        lineNumber: emptyLineIndex + 1,
                        normalizedText: blockText,
                        displayText: block.displayText,
                        pos: block.pos,
                        nodeSize: block.nodeSize,
                        isTextblock: block.isTextblock,
                        kind: block.kind,
                        level: block.level,
                        kindIndex: block.kindIndex
                    });
                }
                continue;
            }

            if (!blockText) continue;

            if (block.kind === 'heading') {
                const headingMatch = findNextHeadingSemanticAnchor(semanticAnchors.headings, headingCursor, block.level);
                if (headingMatch) {
                    headingCursor = headingMatch.nextIndex;
                    nextBlocks.push({
                        lineNumber: headingMatch.anchor.lineNumber,
                        normalizedText: blockText,
                        displayText: block.displayText,
                        pos: block.pos,
                        nodeSize: block.nodeSize,
                        isTextblock: block.isTextblock,
                        kind: block.kind,
                        level: block.level,
                        kindIndex: block.kindIndex
                    });
                    continue;
                }
            }

            if (block.kind === 'task') {
                const taskAnchor = semanticAnchors.tasks[taskCursor++];
                if (taskAnchor) {
                    nextBlocks.push({
                        lineNumber: taskAnchor.lineNumber,
                        normalizedText: blockText,
                        displayText: block.displayText,
                        pos: block.pos,
                        nodeSize: block.nodeSize,
                        isTextblock: block.isTextblock,
                        kind: block.kind,
                        kindIndex: block.kindIndex
                    });
                    continue;
                }
            }

            if (block.kind === 'attachment') {
                const attachmentAnchor = semanticAnchors.attachments[attachmentCursor++];
                if (attachmentAnchor) {
                    nextBlocks.push({
                        lineNumber: attachmentAnchor.lineNumber,
                        normalizedText: blockText,
                        displayText: block.displayText,
                        pos: block.pos,
                        nodeSize: block.nodeSize,
                        isTextblock: block.isTextblock,
                        kind: block.kind,
                        kindIndex: block.kindIndex
                    });
                    continue;
                }
            }

            let matchedIndex = -1;
            for (let lineIndex = cursor; lineIndex < normalizedLines.length; lineIndex++) {
                if (!normalizedLines[lineIndex]) continue;

                if (isBlockLineMatch(normalizedLines[lineIndex], blockText)) {
                    matchedIndex = lineIndex;
                    cursor = lineIndex + 1;
                    break;
                }
            }

            if (matchedIndex === -1) continue;

            nextBlocks.push({
                lineNumber: matchedIndex + 1,
                normalizedText: blockText,
                displayText: block.displayText,
                pos: block.pos,
                nodeSize: block.nodeSize,
                isTextblock: block.isTextblock,
                kind: block.kind,
                level: block.level,
                kindIndex: block.kindIndex
            });
        }

        this.lineBlocks = nextBlocks;
        this.kindAnchors = {
            heading: nextBlocks.filter((entry) => entry.kind === 'heading').sort((a, b) => a.kindIndex - b.kindIndex),
            task: nextBlocks.filter((entry) => entry.kind === 'task').sort((a, b) => a.kindIndex - b.kindIndex),
            attachment: nextBlocks.filter((entry) => entry.kind === 'attachment').sort((a, b) => a.kindIndex - b.kindIndex)
        };
    }

    resolveDisplaySource(src) {
        if (!src) return src;

        if (/^(data:|https?:|file:)/i.test(src)) {
            return src;
        }

        if (path.isAbsolute(src)) {
            return src;
        }

        if (!this.bundlePath) {
            return src;
        }

        return pathToFileURL(path.join(this.bundlePath, src)).href;
    }

    resolveLinkDisplayMeta(href) {
        return getLinkDisplayMeta(href, this.bundlePath);
    }

    refreshImages() {
        this.editor.view.dispatch(this.editor.state.tr);
    }

    refreshLinkDomState() {
        if (!this.root) return;

        const apply = () => {
            const links = Array.from(this.root.querySelectorAll('a[href]'));
            for (const link of links) {
                const href = String(link.getAttribute('href') || '');
                const displayMeta = this.resolveLinkDisplayMeta(href);
                link.classList.add('kangaroo-link');
                link.classList.remove(
                    'kangaroo-link-folder',
                    'kangaroo-link-file',
                    'kangaroo-link-link',
                    'kangaroo-link-anchor',
                    'kangaroo-link-missing',
                    'kangaroo-link-attachment-file',
                    'kangaroo-link-attachment-folder',
                    'kangaroo-link-attachment-missing'
                );
                if (displayMeta.kind) {
                    link.classList.add(`kangaroo-link-${displayMeta.kind}`);
                }
                link.setAttribute('data-link-kind', displayMeta.kind || 'link');
                link.setAttribute('data-link-icon', displayMeta.icon || '↗');
                link.setAttribute('data-link-badge', displayMeta.badge || '链接');
                link.setAttribute('title', displayMeta.title || href || '');
            }

            this.updateSelectedLinkOverlay();
        };

        window.requestAnimationFrame(apply);
    }

    getLinkInfoAtPoint(clientX, clientY) {
        const elementAtPoint = typeof document !== 'undefined'
            ? document.elementFromPoint(clientX, clientY)
            : null;
        const anchorElement = elementAtPoint?.closest?.('a.kangaroo-link') || null;
        if (anchorElement) {
            return this.getLinkInfoFromElement(anchorElement);
        }

        const position = this.editor.view.posAtCoords({ left: clientX, top: clientY });
        if (!position || typeof position.pos !== 'number') {
            return null;
        }

        return this.getLinkInfoAtPos(position.pos);
    }

    getLinkInfoFromElement(anchorElement) {
        if (!anchorElement) return null;

        const href = String(anchorElement.getAttribute('href') || '').trim();
        if (!href) return null;

        const textNodes = getTextNodesUnder(anchorElement);
        let from = null;
        let to = null;

        if (textNodes.length) {
            try {
                from = this.editor.view.posAtDOM(textNodes[0], 0);
                const lastTextNode = textNodes[textNodes.length - 1];
                to = this.editor.view.posAtDOM(lastTextNode, String(lastTextNode.textContent || '').length);
            } catch {
                from = null;
                to = null;
            }
        }

        if (typeof from !== 'number' || typeof to !== 'number' || to < from) {
            const fallback = this.getLinkInfoAtPos(this.editor.view.posAtCoords({
                left: anchorElement.getBoundingClientRect().left + 4,
                top: anchorElement.getBoundingClientRect().top + anchorElement.getBoundingClientRect().height / 2
            })?.pos || null);
            if (fallback) {
                return fallback;
            }

            return null;
        }

        return {
            from,
            to,
            href,
            text: String(anchorElement.textContent || '').trim(),
            displayMeta: this.resolveLinkDisplayMeta(href)
        };
    }

    getLinkInfoAtPos(pos) {
        const linkMarkType = this.editor.state.schema.marks.link;
        if (!linkMarkType || typeof pos !== 'number') {
            return null;
        }

        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const positions = [
            clampNumber(pos, 1, maxPos),
            clampNumber(pos - 1, 1, maxPos),
            clampNumber(pos + 1, 1, maxPos)
        ];

        for (const candidate of positions) {
            const range = getMarkRange(this.editor.state.doc.resolve(candidate), linkMarkType);
            if (!range) continue;

            const href = String(range.mark.attrs?.href || '');
            const displayMeta = this.resolveLinkDisplayMeta(href);
            return {
                from: range.from,
                to: range.to,
                href,
                text: this.editor.state.doc.textBetween(range.from, range.to, ' ').trim(),
                displayMeta
            };
        }

        return null;
    }

    selectLinkAtPoint(clientX, clientY) {
        const info = this.getLinkInfoAtPoint(clientX, clientY);
        if (!info) {
            this.clearSelectedLink();
            return null;
        }

        this.selectLink(info);
        return info;
    }

    selectLink(info) {
        if (!info?.href) {
            this.clearSelectedLink();
            return false;
        }

        this.clearSelectedImageNode();
        this.selectedLinkInfo = info;
        this.editor.chain().focus().setTextSelection({ from: info.from, to: info.to }).run();
        window.requestAnimationFrame(() => {
            this.applySelectedLinkElement();
            this.updateSelectedLinkOverlay();
        });
        return true;
    }

    applySelectedLinkElement() {
        this.clearSelectedLinkElement();
        if (!this.selectedLinkInfo) return;

        const anchor = this.findLinkElementAtPosition(this.selectedLinkInfo.from);
        if (!anchor) return;

        this.selectedLinkElement = anchor;
        anchor.classList.add('is-selected');
    }

    findLinkElementAtPosition(pos) {
        if (typeof pos !== 'number') return null;

        const positions = [pos, pos + 1, Math.max(pos - 1, 1)];
        for (const candidate of positions) {
            try {
                const domAtPos = this.editor.view.domAtPos(candidate);
                const element = domAtPos.node?.nodeType === Node.ELEMENT_NODE
                    ? domAtPos.node
                    : domAtPos.node?.parentElement;
                const anchor = element?.closest?.('a.kangaroo-link');
                if (anchor) {
                    return anchor;
                }
            } catch {
                continue;
            }
        }

        return null;
    }

    clearSelectedLinkElement() {
        if (this.selectedLinkElement?.classList) {
            this.selectedLinkElement.classList.remove('is-selected');
        }
        this.selectedLinkElement = null;
    }

    updateSelectedLinkOverlay() {
        if (!this.selectedLinkOverlay) return;
        const rect = this.getSelectedLinkRect();
        if (!rect) {
            this.selectedLinkOverlay.style.display = 'none';
            return;
        }

        const hostRect = this.host.getBoundingClientRect();
        this.selectedLinkOverlay.style.display = 'block';
        this.selectedLinkOverlay.style.left = `${rect.left - hostRect.left + this.host.scrollLeft - 3}px`;
        this.selectedLinkOverlay.style.top = `${rect.top - hostRect.top + this.host.scrollTop - 3}px`;
        this.selectedLinkOverlay.style.width = `${rect.width + 6}px`;
        this.selectedLinkOverlay.style.height = `${rect.height + 6}px`;
    }

    getSelectedLinkRect() {
        if (!this.selectedLinkInfo) return null;

        try {
            const fromDom = this.editor.view.domAtPos(this.selectedLinkInfo.from);
            const toDom = this.editor.view.domAtPos(this.selectedLinkInfo.to);
            if (!fromDom?.node || !toDom?.node) {
                return null;
            }

            const range = document.createRange();
            range.setStart(fromDom.node, fromDom.offset);
            range.setEnd(toDom.node, toDom.offset);
            const rect = range.getBoundingClientRect();
            if (rect && rect.width > 0 && rect.height > 0) {
                return rect;
            }
        } catch {
            // Fall through to anchor lookup.
        }

        const anchor = this.findLinkElementAtPosition(this.selectedLinkInfo.from);
        return anchor?.getBoundingClientRect?.() || null;
    }

    clearSelectedLink() {
        this.clearSelectedLinkElement();
        this.selectedLinkInfo = null;
        if (this.selectedLinkOverlay) {
            this.selectedLinkOverlay.style.display = 'none';
        }
    }

    syncSelectedLinkWithSelection() {
        if (!this.selectedLinkInfo) return;

        const { from, to } = this.editor.state.selection;
        const selectionInsideLink = from >= this.selectedLinkInfo.from && to <= this.selectedLinkInfo.to;
        if ((from === this.selectedLinkInfo.from && to === this.selectedLinkInfo.to) || selectionInsideLink) {
            this.applySelectedLinkElement();
            this.updateSelectedLinkOverlay();
            return;
        }

        this.clearSelectedLink();
    }

    getSelectedLinkInfo() {
        return this.selectedLinkInfo ? { ...this.selectedLinkInfo } : null;
    }

    deleteSelectedLink() {
        const selected = this.selectedLinkInfo;
        if (!selected) return false;

        const tr = this.editor.state.tr.delete(selected.from, selected.to).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedLink();
        this.focus();
        return true;
    }

    selectImageNode(nodeView) {
        if (this.selectedImageNodeView === nodeView) {
            return;
        }

        const pos = typeof nodeView?.getPos === 'function'
            ? nodeView.getPos()
            : null;
        if (typeof pos === 'number') {
            this.editor.chain().setNodeSelection(pos).focus(undefined, {
                scrollIntoView: false
            }).run();
        }

        if (this.selectedImageNodeView?.deselect) {
            this.selectedImageNodeView.deselect();
        }

        this.selectedImageNodeView = nodeView;
        this.selectedImageNodeView?.select?.();
    }

    clearSelectedImageNode() {
        if (this.selectedImageNodeView?.deselect) {
            this.selectedImageNodeView.deselect();
        }

        this.selectedImageNodeView = null;
    }

    deleteSelectedImageNode() {
        const selected = this.selectedImageNodeView;
        if (!selected) return false;

        const pos = selected.getPos?.();
        const node = selected.getNode?.();
        if (typeof pos !== 'number' || !node?.nodeSize) {
            this.clearSelectedImageNode();
            return false;
        }

        const tr = this.editor.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedImageNode();
        this.focus();
        return true;
    }

    resolveImagePath(src) {
        if (!src) return null;

        if (/^file:/i.test(src)) {
            try {
                return fileURLToPath(src);
            } catch {
                return null;
            }
        }

        if (/^(data:|https?:)/i.test(src)) {
            return null;
        }

        if (path.isAbsolute(src)) {
            return src;
        }

        if (!this.bundlePath) {
            return null;
        }

        return path.join(this.bundlePath, src);
    }

    getImageInfoFromNodeView(nodeView) {
        if (!nodeView) return null;

        const sourceSrc = String(nodeView.getSourceSrc?.() || '');
        const resolvedSrc = String(nodeView.getResolvedSrc?.() || '');
        const imagePath = this.resolveImagePath(sourceSrc) || this.resolveImagePath(resolvedSrc);

        return {
            nodeView,
            sourceSrc,
            resolvedSrc,
            imagePath,
            node: nodeView.getNode?.() || null,
            pos: typeof nodeView.getPos?.() === 'function' ? nodeView.getPos() : null,
            element: nodeView.getDom?.() || null,
            imageElement: nodeView.getImageElement?.() || null
        };
    }

    getImageInfoAtPoint(clientX, clientY) {
        if (typeof document === 'undefined') return null;

        const elementAtPoint = document.elementFromPoint(clientX, clientY);
        const container = elementAtPoint?.closest?.('[data-resize-container][data-node="image"]') || null;
        const nodeView = container?.__kangarooImageNodeView || null;
        if (!nodeView) {
            return null;
        }

        return this.getImageInfoFromNodeView(nodeView);
    }

    selectImage(imageInfo) {
        const nodeView = imageInfo?.nodeView || imageInfo;
        if (!nodeView) {
            this.clearSelectedImageNode();
            return false;
        }

        this.clearSelectedLink();
        this.selectImageNode(nodeView);
        this.editor.commands.focus(undefined, {
            scrollIntoView: false
        });
        return true;
    }

    resolveLineFromNode(node) {
        if (!node) return null;

        const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        const anchor = this.lineBlocks.find((entry) => {
            const anchorNode = this.getHighlightNodeForPosition(this.getEditorPositionForBlock(entry));
            return anchorNode && (anchorNode === element || anchorNode.contains?.(element));
        });
        return anchor?.lineNumber || null;
    }

    resolveLineFromPos(pos) {
        if (typeof pos !== 'number') return null;

        let best = null;

        for (const entry of this.lineBlocks) {
            const start = typeof entry.pos === 'number' ? entry.pos : null;
            const end = typeof entry.pos === 'number' && typeof entry.nodeSize === 'number'
                ? entry.pos + Math.max(entry.nodeSize, 1)
                : null;

            if (start == null || end == null) continue;

            if (pos >= start && pos <= end) {
                return entry.lineNumber || null;
            }

            if (start <= pos) {
                if (!best || start > best.pos) {
                    best = entry;
                }
            }
        }

        return best?.lineNumber || this.lineBlocks[0]?.lineNumber || null;
    }

    findBlockForLine(lineNumber, options = {}) {
        if (!this.lineBlocks.length) return null;

        if (options.preferredKind) {
            const sameKindBlocks = this.lineBlocks.filter((entry) => entry.kind === options.preferredKind);
            const exactKindMatch = sameKindBlocks.find((entry) => entry.lineNumber === lineNumber);
            if (exactKindMatch) {
                return exactKindMatch;
            }

            const preferredKindMatch = this.findBlockByPreferredText(options.preferredText, lineNumber, sameKindBlocks);
            if (preferredKindMatch) {
                return preferredKindMatch;
            }
        }

        const preferredBlock = this.findBlockByPreferredText(options.preferredText, lineNumber);
        if (preferredBlock) {
            return preferredBlock;
        }

        const targetText = this.getTargetTextForLine(lineNumber, options.preferredText);
        if (targetText) {
            const candidates = this.lineBlocks.filter((entry) => (
                isBlockLineMatch(targetText, entry.normalizedText)
                || isBlockLineMatch(entry.normalizedText, targetText)
            ));

            if (candidates.length) {
                candidates.sort((left, right) => {
                    const leftBefore = left.lineNumber <= lineNumber ? 0 : 1;
                    const rightBefore = right.lineNumber <= lineNumber ? 0 : 1;
                    if (leftBefore !== rightBefore) {
                        return leftBefore - rightBefore;
                    }

                    const distance = Math.abs(left.lineNumber - lineNumber) - Math.abs(right.lineNumber - lineNumber);
                    if (distance !== 0) {
                        return distance;
                    }

                    return left.lineNumber - right.lineNumber;
                });

                return candidates[0];
            }
        }

        const closest = this.lineBlocks.reduce((best, entry) => {
            if (!best) return entry;

            const nextDistance = Math.abs(entry.lineNumber - lineNumber);
            const bestDistance = Math.abs(best.lineNumber - lineNumber);
            if (nextDistance !== bestDistance) {
                return nextDistance < bestDistance ? entry : best;
            }

            return entry.lineNumber < best.lineNumber ? entry : best;
        }, null);

        return closest || this.lineBlocks[0];
    }

    findBlockByPreferredText(preferredText, lineNumber, anchors = this.lineBlocks) {
        const normalized = normalizeComparableText(preferredText);
        if (!normalized) return null;

        const exactMatches = anchors.filter((entry) => entry.normalizedText === normalized);
        if (exactMatches.length) {
            return findClosestAnchorByLine(exactMatches, lineNumber);
        }

        const containingMatches = anchors.filter((entry) => (
            normalized.length >= 4
            && (entry.normalizedText.includes(normalized) || normalized.includes(entry.normalizedText))
        ));
        if (containingMatches.length) {
            return findClosestAnchorByLine(containingMatches, lineNumber);
        }

        return null;
    }

    findBlockByKindIndex(kind, kindIndex, options = {}) {
        const index = Number(kindIndex);
        if (!kind || !Number.isInteger(index)) return null;

        const directKindAnchors = this.docKindAnchors[kind] || [];
        const directMatch = directKindAnchors.find((entry) => entry.kindIndex === index);
        if (directMatch) {
            return directMatch;
        }

        const sameKind = this.kindAnchors[kind] || this.lineBlocks.filter((entry) => entry.kind === kind);
        const byIndex = sameKind.find((entry) => entry.kindIndex === index);
        if (byIndex) {
            return byIndex;
        }

        return this.findBlockByPreferredText(options.preferredText, options.lineNumber || 1, sameKind);
    }

    getEditorPositionForBlock(block) {
        if (!block || typeof block.pos !== 'number') {
            return null;
        }

        if (block.isTextblock) {
            return Math.min(block.pos + 1, this.editor.state.doc.content.size);
        }

        return block.pos;
    }

    getDropLocationFromPos(pos) {
        const coordinates = this.editor.view.coordsAtPos(pos);
        const hostRect = this.host.getBoundingClientRect();
        const top = coordinates.top - hostRect.top + this.host.scrollTop;

        return {
            type: 'tiptap',
            pos,
            left: 12,
            top: Math.max(top, 0),
            height: 3,
            width: Math.max(this.host.clientWidth - 24, 24)
        };
    }

    getCoordsForPosition(position) {
        if (typeof position !== 'number') return null;

        try {
            return this.editor.view.coordsAtPos(position);
        } catch {
            return null;
        }
    }

    getHighlightNodeForPosition(position) {
        if (typeof position !== 'number') return null;

        try {
            const domAtPos = this.editor.view.domAtPos(position);
            const element = domAtPos.node?.nodeType === Node.ELEMENT_NODE
                ? domAtPos.node
                : domAtPos.node?.parentElement;

            return element?.closest?.(
                'h1, h2, h3, h4, h5, h6, p, pre, blockquote, li, [data-resize-container][data-node="image"]'
            ) || null;
        } catch {
            return null;
        }
    }

    scrollPositionIntoView(position) {
        const applyScroll = () => {
            const coords = this.getCoordsForPosition(position);
            if (!coords) return;

            const hostRect = this.host.getBoundingClientRect();
            const topPadding = Math.min(Math.max(this.host.clientHeight * 0.18, 48), 140);
            const targetScrollTop = Math.max(
                this.host.scrollTop + coords.top - hostRect.top - topPadding,
                0
            );
            this.host.scrollTop = targetScrollTop;
        };

        applyScroll();
        window.requestAnimationFrame(applyScroll);
    }

    getTargetTextForLine(lineNumber, preferredText = '') {
        const preferred = normalizeComparableText(preferredText);
        if (preferred) {
            return preferred;
        }

        const lines = this.currentMarkdown.split('\n');
        const indexes = [];
        const targetIndex = Math.max(Math.min(lineNumber - 1, lines.length - 1), 0);

        indexes.push(targetIndex);

        for (let distance = 1; distance <= 2; distance++) {
            if (targetIndex - distance >= 0) {
                indexes.push(targetIndex - distance);
            }
            if (targetIndex + distance < lines.length) {
                indexes.push(targetIndex + distance);
            }
        }

        for (const index of indexes) {
            const normalized = normalizeMarkdownLineForMatch(lines[index]);
            if (normalized) {
                return normalized;
            }
        }

        return '';
    }
}

function createWysiwygEditor(container, initialMarkdown) {
    return new KangarooWysiwygEditor(container, initialMarkdown);
}

function normalizeMarkdown(markdown) {
    return String(markdown || '').replace(/\r\n/g, '\n');
}

function escapeHtmlAttribute(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getLinkDisplayMeta(href, bundlePath = null) {
    const rawHref = normalizeLinkHref(href);
    if (!rawHref) {
        return {
            kind: 'link',
            icon: '↗',
            badge: '链接',
            title: ''
        };
    }

    if (/^(https?:|mailto:)/i.test(rawHref)) {
        return {
            kind: 'link',
            icon: '↗',
            badge: '链接',
            title: rawHref
        };
    }

    if (rawHref.startsWith('#')) {
        return {
            kind: 'link',
            icon: '§',
            badge: '锚点',
            title: rawHref
        };
    }

    const absolutePath = resolveLocalHref(rawHref, bundlePath);
    if (!absolutePath) {
        return {
            kind: 'link',
            icon: '↗',
            badge: '链接',
            title: rawHref
        };
    }

    try {
        if (fs.existsSync(absolutePath)) {
            const stat = fs.statSync(absolutePath);
            const isAttachment = /(?:^|\/)attachments\//i.test(rawHref);
            if (stat.isDirectory()) {
                return {
                    kind: isAttachment ? 'attachment-folder' : 'folder',
                    icon: '📁',
                    badge: '文件夹',
                    title: absolutePath
                };
            }

            return {
                kind: isAttachment ? 'attachment-file' : 'file',
                icon: '📄',
                badge: getFileTypeLabel(absolutePath),
                title: absolutePath
            };
        }
    } catch {
        return {
            kind: 'missing',
            icon: '⚠',
            badge: '缺失',
            title: rawHref
        };
    }

    return {
        kind: /attachments\//i.test(rawHref) ? 'attachment-missing' : 'missing',
        icon: '⚠',
        badge: /attachments\//i.test(rawHref) ? '缺失' : '链接',
        title: rawHref
    };
}

function resolveLocalHref(href, bundlePath = null) {
    const rawHref = normalizeLinkHref(href);
    if (!rawHref) return null;

    if (/^file:/i.test(rawHref)) {
        try {
            return fileURLToPath(rawHref);
        } catch {
            return null;
        }
    }

    if (/^(https?:|mailto:|#)/i.test(rawHref)) {
        return null;
    }

    if (path.isAbsolute(rawHref)) {
        return rawHref;
    }

    if (bundlePath) {
        return path.resolve(bundlePath, rawHref);
    }

    return path.resolve(rawHref);
}

function normalizeLinkHref(href) {
    const value = String(href || '').trim();
    if (!value) return '';

    try {
        return decodeURI(value);
    } catch {
        return value;
    }
}

function getFileTypeLabel(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (!extension) return '文件';

    if (['.pdf'].includes(extension)) return 'PDF';
    if (['.doc', '.docx', '.pages'].includes(extension)) return '文档';
    if (['.xls', '.xlsx', '.numbers'].includes(extension)) return '表格';
    if (['.ppt', '.pptx', '.key'].includes(extension)) return '演示';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic'].includes(extension)) return '图片';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(extension)) return '压缩包';
    if (['.md', '.markdown', '.txt', '.rtf'].includes(extension)) return '文本';

    return extension.slice(1).toUpperCase();
}

function collectDocumentAnchors(editor) {
    const anchors = [];

    editor.state.doc.descendants((node, pos) => {
        const type = node.type?.name;
        const isAnchor = node.isTextblock || type === 'image';
        if (!isAnchor) {
            return true;
        }

        const resolved = editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size));
        const kind = getAnchorKind(node, resolved);
        const normalizedText = type === 'image'
            ? normalizeComparableText((node.attrs?.alt || getPathTail(node.attrs?.src || '')).trim())
            : normalizeComparableText(node.textContent || '');

        if (!normalizedText) {
            return true;
        }

        anchors.push({
            pos,
            nodeSize: node.nodeSize,
            isTextblock: Boolean(node.isTextblock),
            displayText: type === 'image'
                ? (node.attrs?.alt || getPathTail(node.attrs?.src || '')).trim()
                : String(node.textContent || '').trim(),
            normalizedText,
            kind,
            level: type === 'heading' ? Number(node.attrs?.level || 1) : null
        });

        return true;
    });

    return anchors;
}

function buildDocKindAnchors(editor, semanticAnchors) {
    const anchors = {
        heading: [],
        task: [],
        attachment: []
    };
    let headingIndex = 0;
    let taskIndex = 0;
    let attachmentIndex = 0;
    const seenAttachmentKeys = new Set();

    editor.state.doc.descendants((node, pos) => {
        const type = node.type?.name;

        if (type === 'heading') {
            anchors.heading.push({
                kind: 'heading',
                kindIndex: headingIndex,
                pos,
                nodeSize: node.nodeSize,
                isTextblock: true,
                displayText: String(node.textContent || '').trim(),
                normalizedText: normalizeComparableText(node.textContent || ''),
                level: Number(node.attrs?.level || 1),
                lineNumber: semanticAnchors.headings[headingIndex]?.lineNumber || 1
            });
            headingIndex += 1;
            return true;
        }

        if (type === 'taskItem') {
            const taskAnchor = findTaskItemAnchor(node, pos, taskIndex, semanticAnchors.tasks[taskIndex]);
            if (taskAnchor) {
                taskAnchor.checked = Boolean(node.attrs?.checked);
                anchors.task.push(taskAnchor);
                taskIndex += 1;
            }
            return true;
        }

        if (node.isText && node.marks?.length) {
            for (const mark of node.marks) {
                const href = String(mark.attrs?.href || '');
                if (!/attachments\//i.test(href)) continue;

                const attachmentKey = `${pos}:${href}:${node.text || ''}`;
                if (seenAttachmentKeys.has(attachmentKey)) continue;
                seenAttachmentKeys.add(attachmentKey);

                anchors.attachment.push({
                    kind: 'attachment',
                    kindIndex: attachmentIndex,
                    pos,
                    nodeSize: node.nodeSize,
                    isTextblock: false,
                    displayText: String(node.text || path.basename(href)).trim(),
                    normalizedText: normalizeComparableText(node.text || path.basename(href)),
                    lineNumber: semanticAnchors.attachments[attachmentIndex]?.lineNumber || 1,
                    relativePath: normalizeLinkHref(href).replace(/^\.?\//, '')
                });
                attachmentIndex += 1;
            }
        }

        return true;
    });

    return anchors;
}

function findTaskItemAnchor(taskNode, taskPos, kindIndex, semanticAnchor) {
    const firstTextblock = findFirstTextblockInNode(taskNode, taskPos);

    if (!firstTextblock) {
        return null;
    }

    return {
        kind: 'task',
        kindIndex,
        taskItemPos: taskPos,
        pos: firstTextblock.pos,
        nodeSize: firstTextblock.node.nodeSize,
        isTextblock: true,
        displayText: String(firstTextblock.node.textContent || '').trim(),
        normalizedText: normalizeComparableText(firstTextblock.node.textContent || ''),
        lineNumber: semanticAnchor?.lineNumber || 1
    };
}

function findFirstTextblockInNode(node, basePos) {
    let firstTextblock = null;

    node.descendants((child, childPos) => {
        if (!firstTextblock && child.isTextblock) {
            firstTextblock = {
                pos: basePos + 1 + childPos,
                node: child
            };
            return false;
        }

        return true;
    });

    return firstTextblock;
}

function buildTextSearchMatchesForNode(node, basePos, normalizedQuery, baseMatch) {
    const { fullText, segments } = collectNodeTextSegments(node, basePos);
    if (!fullText || !segments.length) {
        return [];
    }

    const normalizedText = fullText.toLowerCase();
    const results = [];
    let searchFrom = 0;

    while (searchFrom <= normalizedText.length) {
        const matchIndex = normalizedText.indexOf(normalizedQuery, searchFrom);
        if (matchIndex === -1) break;

        const matchEnd = matchIndex + normalizedQuery.length;
        const from = getDocPositionForCharOffset(segments, matchIndex, false);
        const to = getDocPositionForCharOffset(segments, matchEnd, true);

        if (typeof from === 'number' && typeof to === 'number' && to >= from) {
            results.push({
                ...baseMatch,
                text: String(fullText).trim() || '(空行)',
                snippet: buildSearchSnippet(fullText, matchIndex, matchEnd),
                from,
                to,
                pos: from
            });
        }

        searchFrom = Math.max(matchEnd, matchIndex + 1);
    }

    return results;
}

function collectNodeTextSegments(node, basePos) {
    const segments = [];
    let fullText = '';

    node.descendants((child, childPos) => {
        if (!child.isText) {
            return true;
        }

        const text = String(child.text || '');
        if (!text) {
            return true;
        }

        const from = basePos + 1 + childPos;
        segments.push({
            from,
            to: from + text.length,
            startOffset: fullText.length,
            endOffset: fullText.length + text.length,
            text
        });
        fullText += text;
        return true;
    });

    return { fullText, segments };
}

function getDocPositionForCharOffset(segments, offset, isEnd) {
    if (!segments.length) return null;

    const safeOffset = Math.max(offset, 0);
    for (const segment of segments) {
        const segmentLength = segment.endOffset - segment.startOffset;
        if (safeOffset < segment.endOffset || (isEnd && safeOffset === segment.endOffset)) {
            const relativeOffset = Math.min(Math.max(safeOffset - segment.startOffset, 0), segmentLength);
            return segment.from + relativeOffset;
        }
    }

    const lastSegment = segments[segments.length - 1];
    return isEnd ? lastSegment.to : lastSegment.from;
}

function buildSearchSnippet(text, start, end, radius = 26) {
    const content = String(text || '');
    if (!content) return '';

    const sliceStart = Math.max(start - radius, 0);
    const sliceEnd = Math.min(end + radius, content.length);
    const prefix = sliceStart > 0 ? '…' : '';
    const suffix = sliceEnd < content.length ? '…' : '';
    return `${prefix}${content.slice(sliceStart, sliceEnd).replace(/\s+/g, ' ').trim()}${suffix}`;
}

function clampNumber(value, min, max) {
    return Math.min(Math.max(value, min), max);
}

function getEventTargetElement(target) {
    if (!target) return null;
    return target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement || null;
}

function getTextNodesUnder(element) {
    if (!element) return [];

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
            return String(node.textContent || '').trim()
                ? NodeFilter.FILTER_ACCEPT
                : NodeFilter.FILTER_REJECT;
        }
    });

    const nodes = [];
    let current = walker.nextNode();
    while (current) {
        nodes.push(current);
        current = walker.nextNode();
    }

    return nodes;
}

function normalizeMarkdownLineForMatch(line) {
    let text = String(line || '').trim();
    if (!text) return '';

    text = text.replace(/^#{1,6}\s+/, '');
    text = text.replace(/^>\s?/, '');
    text = text.replace(/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+/, '');
    text = text.replace(/^(?:[-+*]|\d+\.)\s+/, '');
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_, alt, src) => (alt || getPathTail(src)).trim());
    text = text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_, label, href) => (label || getPathTail(href)).trim());
    text = text.replace(/<img\b[^>]*alt\s*=\s*["']?([^"'>]*)["']?[^>]*src\s*=\s*["']?([^"'>\s]*)["']?[^>]*>/gi, (_, alt, src) => (alt || getPathTail(src)).trim());
    text = text.replace(/<[^>]+>/g, ' ');

    return normalizeComparableText(text);
}

function normalizeTodoLine(line, checked = false) {
    const taskMatch = String(line || '').match(/^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
        return `${taskMatch[1]}${taskMatch[3] || ''}`;
    }

    const bulletMatch = String(line || '').match(/^(\s*)(?:[-+*]|\d+\.)\s+(.*)$/);
    if (bulletMatch) {
        return `${bulletMatch[1]}- [${checked ? 'x' : ' '}] ${bulletMatch[2] || ''}`;
    }

    const indentMatch = String(line || '').match(/^(\s*)(.*)$/);
    const indent = indentMatch ? indentMatch[1] : '';
    const content = indentMatch ? indentMatch[2] : String(line || '');

    if (!content.trim()) {
        return `${indent}- [${checked ? 'x' : ' '}] `;
    }

    return `${indent}- [${checked ? 'x' : ' '}] ${content.trimStart()}`;
}

function normalizeTodoLineFromText(line, text, checked = false) {
    const currentLine = String(line || '');
    const visibleText = String(text || '').replace(/\s+/g, ' ').trim();
    const isTaskLine = /^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/.test(currentLine);

    if (isTaskLine) {
        return visibleText;
    }

    if (!visibleText) {
        return `- [${checked ? 'x' : ' '}] `;
    }

    return `- [${checked ? 'x' : ' '}] ${visibleText}`;
}

function createTodoLineFromText(text, checked = false) {
    const visibleText = String(text || '').replace(/\s+/g, ' ').trim();
    if (!visibleText) {
        return `- [${checked ? 'x' : ' '}] `;
    }
    return `- [${checked ? 'x' : ' '}] ${visibleText}`;
}

function stripTodoLineToParagraph(line, text) {
    const taskMatch = String(line || '').match(/^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/);
    if (taskMatch) {
        return String(taskMatch[3] || '').trim();
    }

    return String(text || '').replace(/\s+/g, ' ').trim();
}

function isTodoMarkdownLine(line) {
    return /^(\s*)[-+*]\s+\[([ xX])\]\s*(.*)$/.test(String(line || ''));
}

function normalizeComparableText(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function collectLinkMarkRanges(doc, linkMarkType) {
    const ranges = [];

    doc.descendants((node, pos) => {
        if (!node?.isText || !node.text || !node.marks?.length) {
            return true;
        }

        const linkMark = node.marks.find((mark) => mark.type === linkMarkType);
        if (!linkMark) {
            return true;
        }

        const from = pos;
        const to = pos + node.nodeSize;
        const previous = ranges[ranges.length - 1];

        if (
            previous
            && previous.to === from
            && String(previous.attrs?.href || '') === String(linkMark.attrs?.href || '')
            && String(previous.attrs?.title || '') === String(linkMark.attrs?.title || '')
        ) {
            previous.to = to;
            previous.text += node.text;
            return true;
        }

        ranges.push({
            from,
            to,
            text: node.text,
            attrs: { ...(linkMark.attrs || {}) }
        });
        return true;
    });

    return ranges;
}

function rangeHasMark(doc, from, to, markType) {
    let found = false;

    doc.nodesBetween(from, to, (node) => {
        if (!node?.isText || !node.marks?.length) {
            return true;
        }

        if (node.marks.some((mark) => mark.type === markType)) {
            found = true;
            return false;
        }

        return true;
    });

    return found;
}

function trimAutolinkHref(href) {
    let value = String(href || '').trim();
    if (!value) return '';

    while (/[),.;!?]$/.test(value)) {
        if (value.endsWith(')')) {
            const opens = (value.match(/\(/g) || []).length;
            const closes = (value.match(/\)/g) || []).length;
            if (closes <= opens) {
                break;
            }
        }
        value = value.slice(0, -1);
    }

    return value;
}

function shouldSyncVisibleLinkTextToHref(href, text) {
    const normalizedHref = String(href || '').trim();
    const normalizedText = String(text || '').trim();
    if (!normalizedHref || !normalizedText) return false;

    if (normalizedHref.startsWith('#')) return false;

    const normalizedRelativeHref = normalizeLinkHref(normalizedHref).replace(/^\.?\//, '');
    if (
        normalizedRelativeHref.startsWith('attachments/')
        || normalizedRelativeHref.startsWith('assets/')
    ) {
        return false;
    }

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(normalizedHref)) {
        return true;
    }

    if (normalizedHref.startsWith('~/') || path.isAbsolute(normalizedHref)) {
        return true;
    }

    return false;
}

function parseMarkdownLinkDestination(rawDestination) {
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

function getAnchorKind(node, resolvedPos) {
    const type = node.type?.name;
    if (type === 'heading') {
        return 'heading';
    }

    if (type === 'image') {
        return 'image';
    }

    if (resolvedPos) {
        for (let depth = resolvedPos.depth; depth >= 0; depth--) {
            if (resolvedPos.node(depth)?.type?.name === 'taskItem') {
                return 'task';
            }
        }
    }

    if (node.isTextblock && looksLikeAttachmentAnchor(node)) {
        return 'attachment';
    }

    return 'text';
}

function looksLikeAttachmentAnchor(node) {
    const text = String(node.textContent || '');
    if (/attachments\//i.test(text)) {
        return true;
    }

    let hasAttachmentMark = false;
    node.descendants((child) => {
        if (!child.isText || !child.marks?.length) {
            return true;
        }

        hasAttachmentMark = child.marks.some((mark) => {
            const href = mark.attrs?.href || '';
            return /attachments\//i.test(String(href));
        });

        return !hasAttachmentMark;
    });

    return hasAttachmentMark;
}

function buildMarkdownSemanticAnchors(markdown) {
    const lines = String(markdown || '').split('\n');
    const headings = [];
    const tasks = [];
    const attachments = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const lineNumber = index + 1;

        const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);
        if (headingMatch) {
            headings.push({
                lineNumber,
                level: headingMatch[1].length,
                text: normalizeComparableText(headingMatch[2])
            });
        }

        if (/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+/.test(line)) {
            tasks.push({
                lineNumber,
                text: normalizeMarkdownLineForMatch(line)
            });
        }
    }

    const attachmentRegex = /\[([^\]]*)\]\((?:\.?\/)?attachments\/([^)]+)\)/g;
    let match;
    while ((match = attachmentRegex.exec(markdown)) !== null) {
        attachments.push({
            lineNumber: getLineNumberAtOffset(markdown, match.index),
            text: normalizeComparableText(match[1] || getPathTail(match[2] || ''))
        });
    }

    return { headings, tasks, attachments };
}

function findNextHeadingSemanticAnchor(headings, startIndex, level) {
    for (let index = startIndex; index < headings.length; index++) {
        if (Number(headings[index].level) === Number(level)) {
            return {
                anchor: headings[index],
                nextIndex: index + 1
            };
        }
    }

    if (headings[startIndex]) {
        return {
            anchor: headings[startIndex],
            nextIndex: startIndex + 1
        };
    }

    return null;
}

function isBlockLineMatch(lineText, blockText) {
    if (!lineText || !blockText) return false;
    if (lineText === blockText) return true;

    const shorterLength = Math.min(lineText.length, blockText.length);
    if (shorterLength >= 6 && (lineText.includes(blockText) || blockText.includes(lineText))) {
        return true;
    }

    const lineTokens = lineText.split(' ').filter(Boolean);
    const blockTokens = blockText.split(' ').filter(Boolean);
    if (!lineTokens.length || !blockTokens.length) return false;

    const overlap = blockTokens.filter((token) => lineTokens.includes(token)).length;
    const shorterTokenCount = Math.min(lineTokens.length, blockTokens.length);
    if (shorterTokenCount >= 2 && overlap >= shorterTokenCount) return true;
    if (shorterTokenCount >= 3 && overlap >= shorterTokenCount - 1) return true;

    return false;
}

function findClosestAnchorByLine(anchors, lineNumber) {
    if (!anchors.length) return null;

    return anchors.reduce((best, entry) => {
        if (!best) return entry;

        const nextDistance = Math.abs(entry.lineNumber - lineNumber);
        const bestDistance = Math.abs(best.lineNumber - lineNumber);
        if (nextDistance !== bestDistance) {
            return nextDistance < bestDistance ? entry : best;
        }

        return entry.lineNumber < best.lineNumber ? entry : best;
    }, null);
}

function getPathTail(value) {
    const normalized = String(value || '').split(/[?#]/)[0].replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    return parts[parts.length - 1] || normalized;
}

function getPositionAtOffset(text, offset) {
    const safeOffset = Math.max(0, Math.min(Number(offset) || 0, String(text || '').length));
    const before = String(text || '').slice(0, safeOffset);
    const lines = before.split('\n');
    return {
        lineNumber: lines.length,
        column: (lines[lines.length - 1] || '').length + 1
    };
}

module.exports = {
    createWysiwygEditor
};
