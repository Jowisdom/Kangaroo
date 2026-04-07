const fs = require('fs');
const { nativeImage } = require('electron');
const { Editor, Extension, Node: TiptapNode, mergeAttributes, getMarkRange } = require('@tiptap/core');
const { StarterKit } = require('@tiptap/starter-kit');
const { Underline } = require('@tiptap/extension-underline');
const { Link } = require('@tiptap/extension-link');
const { Image } = require('@tiptap/extension-image');
const { TaskList, TaskItem } = require('@tiptap/extension-list');
const { Markdown } = require('@tiptap/markdown');
const { Plugin, Selection } = require('@tiptap/pm/state');
const path = require('path');
const { pathToFileURL, fileURLToPath } = require('url');
const { Slice } = require('@tiptap/pm/model');

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
            'data-kangaroo-path': displayMeta.absolutePath || '',
            title: HTMLAttributes?.title || displayMeta.title || href || ''
        }), 0];
    },
    addCommands() {
        return {
            insertKangarooLink: (label, href, options = {}) => ({ chain }) => {
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

                const commandChain = chain().focus(undefined, {
                    scrollIntoView: false
                }).insertContent(content);

                if (insertTrailingParagraph) {
                    commandChain.enter();
                }

                return commandChain.run();
            },
            insertAbsolutePathLink: (absolutePath, options = {}) => ({ commands }) => {
                const normalizedPath = String(absolutePath || '').trim();
                if (!normalizedPath) {
                    return false;
                }

                return commands.insertKangarooLink(normalizedPath, pathToFileURL(normalizedPath).href, options);
            }
        };
    }
});

const KangarooTaskItem = TaskItem.extend({
    addAttributes() {
        return {
            ...(this.parent?.() || {}),
            headingLevel: {
                default: 0,
                parseHTML: (element) => clampNumber(Number(element.getAttribute('data-heading-level') || 0), 0, 6),
                renderHTML: (attributes) => {
                    const level = clampNumber(Number(attributes?.headingLevel || 0), 0, 6);
                    return level > 0 ? { 'data-heading-level': String(level) } : {};
                }
            }
        };
    }
});

const ResizableImage = Image.extend({
    inline() {
        return true;
    },
    group() {
        return 'inline';
    },
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
        let absolutePath = '';

        if (/^file:/i.test(String(resolvedSrc || ''))) {
            try {
                absolutePath = fileURLToPath(resolvedSrc);
            } catch {
                absolutePath = '';
            }
        }

        return ['img', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
            src: resolvedSrc,
            'data-kangaroo-path': absolutePath
        })];
    },
    renderMarkdown(node) {
        const src = node.attrs?.src || '';
        const alt = node.attrs?.alt || '';
        const title = node.attrs?.title || '';
        const width = node.attrs?.width;

        if (width) {
            const attributes = [`src="${escapeHtmlAttribute(src)}"`];

            if (alt) attributes.push(`alt="${escapeHtmlAttribute(alt)}"`);
            if (title) attributes.push(`title="${escapeHtmlAttribute(title)}"`);
            if (width) attributes.push(`width="${escapeHtmlAttribute(String(width))}"`);

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

            const container = document.createElement('span');
            container.dataset.resizeContainer = '';
            container.dataset.node = this.name;

            const wrapper = document.createElement('span');
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

                if (width > 0) {
                    el.style.width = `${width}px`;
                } else {
                    el.style.width = '';
                }

                if (width > 0) {
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
                let nextHeight = Math.max(1, Math.round(startHeight + deltaY));

                if (alwaysPreserveAspectRatio && aspectRatio > 0) {
                    nextHeight = Math.max(1, Math.round(nextWidth / aspectRatio));
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
                const scrollHost = this.editor?.storage?.kangarooWysiwygInstance?.host || editor.view.dom.parentElement || null;
                const previousScrollTop = scrollHost ? scrollHost.scrollTop : 0;
                const previousScrollLeft = scrollHost ? scrollHost.scrollLeft : 0;
                const tr = editor.state.tr.setNodeMarkup(pos, undefined, {
                    ...currentNode.attrs,
                    width: appliedWidth,
                    height: null
                });
                editor.view.dispatch(tr);
                if (scrollHost) {
                    scrollHost.scrollTop = previousScrollTop;
                    scrollHost.scrollLeft = previousScrollLeft;
                }
                applyNodeSelection(true);
            };

            el.draggable = false;
            el.addEventListener('click', (event) => {
                if (event.button !== 0) return;
                if (this.editor?.storage?.kangarooWysiwygInstance?.shouldSuppressClickSelection?.()) {
                    return;
                }
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
                    return event.target === handle;
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

const KangarooImage = ResizableImage.extend({
    addCommands() {
        const parentCommands = this.parent?.() || {};
        return {
            ...parentCommands,
            insertKangarooImage: (src, options = {}) => ({ chain }) => {
                const targetSrc = String(src || '').trim();
                if (!targetSrc) {
                    return false;
                }

                const {
                    alt = 'image',
                    title = null,
                    width = null,
                    height = null,
                    insertTrailingParagraph = false
                } = options;

                const attrs = {
                    src: targetSrc,
                    alt,
                    title
                };

                if (width) attrs.width = width;
                if (height) attrs.height = height;

                const commandChain = chain().focus(undefined, {
                    scrollIntoView: false
                }).insertContent({
                    type: 'paragraph',
                    content: [{
                        type: this.name,
                        attrs
                    }]
                });

                if (insertTrailingParagraph) {
                    commandChain.enter();
                }

                return commandChain.run();
            }
        };
    }
});

const KangarooAttachment = TiptapNode.create({
    name: 'kangarooAttachment',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    defining: true,
    isolating: true,

    addOptions() {
        return {
            resolveDisplayMeta: null
        };
    },

    addAttributes() {
        return {
            href: {
                default: ''
            },
            label: {
                default: ''
            },
            title: {
                default: null
            },
            identity: {
                default: null
            },
            width: {
                default: 560
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-kangaroo-attachment]',
                getAttrs: (element) => {
                    const href = String(element.getAttribute('data-href') || '').trim();
                    const label = String(element.getAttribute('data-label') || element.textContent || '').trim();
                    const rawTitle = String(element.getAttribute('title') || '').trim() || null;
                    const identity = parseAttachmentIdentityFromTitle(rawTitle);
                    const title = stripAttachmentIdentityFromTitle(rawTitle);
                    if (!href) {
                        return false;
                    }

                    return { href, label, title, identity };
                }
            }
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const href = String(HTMLAttributes?.href || '').trim();
        const label = getAttachmentDisplayLabel(href, HTMLAttributes?.label);
        const displayMeta = this.options.resolveDisplayMeta
            ? this.options.resolveDisplayMeta(href)
            : getLinkDisplayMeta(href);

        return ['span', mergeAttributes(HTMLAttributes, {
            'data-kangaroo-attachment': '',
            'data-href': href,
            'data-label': label,
            'data-link-kind': displayMeta.kind || 'attachment-file',
            'data-kangaroo-path': displayMeta.absolutePath || '',
            title: stripAttachmentIdentityFromTitle(HTMLAttributes?.title || null) || displayMeta.title || href || '',
            class: `kangaroo-attachment-card kangaroo-attachment-${displayMeta.kind || 'attachment-file'}`
        }),
            ['span', { 'data-kangaroo-attachment-wrapper': '', class: 'kangaroo-attachment-shell' },
                ['span', { class: 'kangaroo-attachment-inner' },
                    ['span', { class: 'kangaroo-attachment-icon', 'aria-hidden': 'true' }, displayMeta.icon || '📄'],
                    ['span', { class: 'kangaroo-attachment-label' }, label],
                    ['span', { class: 'kangaroo-attachment-badge', 'aria-hidden': 'true' }, displayMeta.badge || '文件']
                ]
            ]
        ];
    },

    renderText({ node }) {
        return getAttachmentDisplayLabel(node.attrs?.href || '', node.attrs?.label || '');
    },

    renderMarkdown(node) {
        const href = serializeMarkdownHref(node.attrs?.href || '');
        const label = String(node.attrs?.label || '').trim() || decodeLinkLabelFromHref(href);
        const title = mergeAttachmentIdentityIntoTitle(node.attrs?.title || null, node.attrs?.identity || null);
        if (!href) return label;
        return title
            ? `[${escapeMarkdownLinkLabel(label)}](${href} "${escapeMarkdownTitle(title)}")`
            : `[${escapeMarkdownLinkLabel(label)}](${href})`;
    },

    addCommands() {
        return {
            insertAttachmentLink: (relativePath, options = {}) => ({ chain }) => {
                const normalizedRelativePath = normalizeLinkHref(relativePath);
                if (!normalizedRelativePath) {
                    return false;
                }

                const label = String(options.label || '').trim() || decodeLinkLabelFromHref(normalizedRelativePath);
                const title = options.title || null;
                const identity = options.identity || null;
                const { insertTrailingParagraph = true } = options;

                const commandChain = chain().focus(undefined, {
                    scrollIntoView: false
                }).insertContent({
                    type: this.name,
                    attrs: {
                        href: normalizedRelativePath,
                        label,
                        title,
                        identity
                    }
                });

                if (insertTrailingParagraph) {
                    commandChain.enter();
                }

                return commandChain.run();
            }
        };
    },

    addNodeView() {
        return ({ node, getPos }) => {
            const container = document.createElement('span');
            container.dataset.kangarooAttachment = '';
            container.contentEditable = 'false';
            container.draggable = false;

            const wrapper = document.createElement('span');
            wrapper.dataset.kangarooAttachmentWrapper = '';
            wrapper.contentEditable = 'false';
            wrapper.className = 'kangaroo-attachment-shell';

            const inner = document.createElement('span');
            inner.className = 'kangaroo-attachment-inner';
            inner.contentEditable = 'false';

            const icon = document.createElement('span');
            icon.className = 'kangaroo-attachment-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.contentEditable = 'false';

            const label = document.createElement('span');
            label.className = 'kangaroo-attachment-label';
            label.contentEditable = 'false';

            const badge = document.createElement('span');
            badge.className = 'kangaroo-attachment-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.contentEditable = 'false';

            inner.appendChild(icon);
            inner.appendChild(label);
            inner.appendChild(badge);
            wrapper.appendChild(inner);
            container.appendChild(wrapper);

            const syncNodeState = (updatedNode = node) => {
                const href = String(updatedNode.attrs?.href || '').trim();
                const displayLabel = getAttachmentDisplayLabel(href, updatedNode.attrs?.label || '');
                const displayMeta = this.options.resolveDisplayMeta
                    ? this.options.resolveDisplayMeta(href)
                    : getLinkDisplayMeta(href);

                container.className = `kangaroo-attachment-card kangaroo-attachment-${displayMeta.kind || 'attachment-file'}`;
                container.setAttribute('data-href', href);
                container.setAttribute('data-label', displayLabel);
                container.setAttribute('data-link-kind', displayMeta.kind || 'attachment-file');
                container.setAttribute('data-kangaroo-path', displayMeta.absolutePath || '');
                container.setAttribute('title', stripAttachmentIdentityFromTitle(updatedNode.attrs?.title || null) || displayMeta.title || href || '');

                icon.textContent = displayMeta.icon || '📄';
                label.textContent = displayLabel;
                badge.textContent = displayMeta.badge || '文件';
            };

            const nodeViewApi = {
                dom: container,
                update: (updatedNode) => {
                    if (updatedNode.type.name !== this.name) {
                        return false;
                    }
                    node = updatedNode;
                    syncNodeState(updatedNode);
                    return true;
                },
                selectNode: () => {
                    container.classList.add('ProseMirror-selectednode', 'is-selected');
                },
                deselectNode: () => {
                    container.classList.remove('ProseMirror-selectednode', 'is-selected');
                },
                getPos,
                getNode: () => node,
                getHref: () => String(node.attrs?.href || ''),
                getLabel: () => String(node.attrs?.label || ''),
                getDom: () => container,
                getInfo: () => {
                    const href = String(node.attrs?.href || '').trim();
                    const displayMeta = this.options.resolveDisplayMeta
                        ? this.options.resolveDisplayMeta(href)
                        : getLinkDisplayMeta(href);

                    return {
                        pos: typeof getPos === 'function' ? getPos() : null,
                        node,
                        nodeView: nodeViewApi,
                        element: container,
                        cardKind: 'attachment',
                        absolutePath: displayMeta.absolutePath || '',
                        href,
                        text: getAttachmentDisplayLabel(href, node.attrs?.label || ''),
                        displayMeta
                    };
                }
            };

            container.__kangarooAttachmentNodeView = nodeViewApi;
            syncNodeState(node);

            const getInstance = () => this.editor?.storage?.kangarooWysiwygInstance || null;

            container.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                const instance = getInstance();
                if (!instance || instance.shouldSuppressClickSelection?.()) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectAttachmentNode(nodeViewApi);
                instance.editor.commands.focus(undefined, {
                    scrollIntoView: false
                });
            }, true);

            container.addEventListener('dblclick', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectAttachmentNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onOpen;
                if (typeof handler === 'function') {
                    handler(nodeViewApi.getInfo());
                }
            }, true);

            container.addEventListener('contextmenu', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectAttachmentNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onContextMenu;
                if (typeof handler === 'function') {
                    handler(event, nodeViewApi.getInfo());
                }
            }, true);

            return {
                ...nodeViewApi,
                stopEvent: (event) => {
                    const target = getEventTargetElement(event?.target);
                    if (target?.closest?.('.attachment-inline-rename-input')) {
                        return true;
                    }
                    if (!target?.closest?.('[data-kangaroo-attachment]')) {
                        return false;
                    }

                    return ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'].includes(event.type);
                },
                destroy: () => {
                    delete container.__kangarooAttachmentNodeView;
                    if (this.editor?.storage?.kangarooWysiwygInstance?.selectedAttachmentNodeView === nodeViewApi) {
                        this.editor.storage.kangarooWysiwygInstance.clearSelectedAttachmentNode();
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

const KangarooVideo = TiptapNode.create({
    name: 'kangarooVideo',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    defining: true,
    isolating: true,

    addOptions() {
        return {
            resolveSrc: null,
            resolveDisplayMeta: null
        };
    },

    addAttributes() {
        return {
            href: {
                default: ''
            },
            label: {
                default: ''
            },
            title: {
                default: null
            },
            identity: {
                default: null
            },
            width: {
                default: 560
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-kangaroo-video]',
                getAttrs: (element) => {
                    const href = String(element.getAttribute('data-href') || '').trim();
                    const label = String(element.getAttribute('data-label') || '').trim();
                    const rawTitle = String(element.getAttribute('title') || '').trim() || null;
                    const identity = parseAttachmentIdentityFromTitle(rawTitle);
                    const width = parsePdfWidthFromTitle(rawTitle, 560);
                    const title = stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(rawTitle));
                    if (!href) {
                        return false;
                    }

                    return { href, label, title, identity, width };
                }
            }
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const href = String(HTMLAttributes?.href || '').trim();
        const label = getAttachmentDisplayLabel(href, HTMLAttributes?.label);
        const displayMeta = this.options.resolveDisplayMeta
            ? this.options.resolveDisplayMeta(href)
            : getLinkDisplayMeta(href);
        const resolvedSrc = this.options.resolveSrc
            ? this.options.resolveSrc(href)
            : href;
        const markdownTitle = mergeAttachmentIdentityIntoTitle(HTMLAttributes?.title || null, HTMLAttributes?.identity || null);

        return ['span', mergeAttributes(HTMLAttributes, {
            'data-kangaroo-video': '',
            'data-href': href,
            'data-label': label,
            'data-link-kind': displayMeta.kind || 'attachment-video',
            'data-kangaroo-path': displayMeta.absolutePath || '',
            title: stripAttachmentIdentityFromTitle(markdownTitle) || displayMeta.title || href || '',
            class: `kangaroo-video-card kangaroo-video-${displayMeta.kind || 'attachment-video'}`
        }),
            ['span', { class: 'kangaroo-video-shell', 'data-kangaroo-video-shell': '' },
                ['span', { class: 'kangaroo-video-header', 'data-kangaroo-video-header': '' },
                    ['span', { class: 'kangaroo-video-icon', 'aria-hidden': 'true' }, displayMeta.icon || '🎬'],
                    ['span', { class: 'kangaroo-video-label' }, label],
                    ['span', { class: 'kangaroo-video-badge', 'aria-hidden': 'true' }, displayMeta.badge || '视频']
                ],
                ['span', { class: 'kangaroo-video-player', 'data-kangaroo-video-player': '' },
                    ['video', {
                        controls: 'true',
                        preload: 'metadata',
                        src: resolvedSrc,
                        'data-kangaroo-video-element': ''
                    }]
                ]
            ]
        ];
    },

    renderText({ node }) {
        return getAttachmentDisplayLabel(node.attrs?.href || '', node.attrs?.label || '');
    },

    renderMarkdown(node) {
        const href = serializeMarkdownHref(node.attrs?.href || '');
        const label = String(node.attrs?.label || '').trim() || decodeLinkLabelFromHref(href);
        const title = mergeAttachmentIdentityIntoTitle(node.attrs?.title || null, node.attrs?.identity || null);
        if (!href) return label;
        return title
            ? `[${escapeMarkdownLinkLabel(label)}](${href} "${escapeMarkdownTitle(title)}")`
            : `[${escapeMarkdownLinkLabel(label)}](${href})`;
    },

    addCommands() {
        return {
            insertVideoAttachment: (relativePath, options = {}) => ({ chain }) => {
                const normalizedRelativePath = normalizeLinkHref(relativePath);
                if (!normalizedRelativePath) {
                    return false;
                }

                const label = String(options.label || '').trim() || decodeLinkLabelFromHref(normalizedRelativePath);
                const title = options.title || null;
                const identity = options.identity || null;
                const { insertTrailingParagraph = true } = options;

                const commandChain = chain().focus(undefined, {
                    scrollIntoView: false
                }).insertContent({
                    type: this.name,
                    attrs: {
                        href: normalizedRelativePath,
                        label,
                        title,
                        identity
                    }
                });

                if (insertTrailingParagraph) {
                    commandChain.enter();
                }

                return commandChain.run();
            }
        };
    },

    addNodeView() {
        return ({ node, getPos }) => {
            const container = document.createElement('span');
            container.dataset.kangarooVideo = '';
            container.contentEditable = 'false';
            container.draggable = false;

            const shell = document.createElement('span');
            shell.className = 'kangaroo-video-shell';
            shell.dataset.kangarooVideoShell = '';

            const header = document.createElement('span');
            header.className = 'kangaroo-video-header';
            header.dataset.kangarooVideoHeader = '';
            header.contentEditable = 'false';

            const icon = document.createElement('span');
            icon.className = 'kangaroo-video-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.contentEditable = 'false';

            const label = document.createElement('span');
            label.className = 'kangaroo-video-label';
            label.contentEditable = 'false';

            const badge = document.createElement('span');
            badge.className = 'kangaroo-video-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.contentEditable = 'false';

            const player = document.createElement('span');
            player.className = 'kangaroo-video-player';
            player.dataset.kangarooVideoPlayer = '';
            player.contentEditable = 'false';

            const video = document.createElement('video');
            video.controls = true;
            video.preload = 'metadata';
            video.dataset.kangarooVideoElement = '';
            video.contentEditable = 'false';
            video.draggable = false;
            video.setAttribute('playsinline', 'true');

            header.appendChild(icon);
            header.appendChild(label);
            header.appendChild(badge);
            player.appendChild(video);
            shell.appendChild(header);
            shell.appendChild(player);
            container.appendChild(shell);

            const syncNodeState = (updatedNode = node) => {
                const href = String(updatedNode.attrs?.href || '').trim();
                const displayLabel = getAttachmentDisplayLabel(href, updatedNode.attrs?.label || '');
                const displayMeta = this.options.resolveDisplayMeta
                    ? this.options.resolveDisplayMeta(href)
                    : getLinkDisplayMeta(href);
                const resolvedSrc = this.options.resolveSrc
                    ? this.options.resolveSrc(href)
                    : href;

                container.className = `kangaroo-video-card kangaroo-video-${displayMeta.kind || 'attachment-video'}`;
                container.setAttribute('data-href', href);
                container.setAttribute('data-label', displayLabel);
                container.setAttribute('data-link-kind', displayMeta.kind || 'attachment-video');
                container.setAttribute('data-kangaroo-path', displayMeta.absolutePath || '');
                container.setAttribute('title', stripAttachmentIdentityFromTitle(updatedNode.attrs?.title || null) || displayMeta.title || href || '');

                icon.textContent = displayMeta.icon || '🎬';
                label.textContent = displayLabel;
                badge.textContent = displayMeta.badge || '视频';
                if (video.getAttribute('src') !== String(resolvedSrc || '')) {
                    video.setAttribute('src', resolvedSrc || '');
                    video.src = resolvedSrc || '';
                }
            };

            const nodeViewApi = {
                dom: container,
                update: (updatedNode) => {
                    if (updatedNode.type.name !== this.name) {
                        return false;
                    }
                    node = updatedNode;
                    syncNodeState(updatedNode);
                    return true;
                },
                selectNode: () => {
                    container.classList.add('ProseMirror-selectednode', 'is-selected');
                },
                deselectNode: () => {
                    container.classList.remove('ProseMirror-selectednode', 'is-selected');
                },
                getPos,
                getNode: () => node,
                getHref: () => String(node.attrs?.href || ''),
                getLabel: () => String(node.attrs?.label || ''),
                getDom: () => container,
                getVideoElement: () => video,
                getInfo: () => {
                    const href = String(node.attrs?.href || '').trim();
                    const displayMeta = this.options.resolveDisplayMeta
                        ? this.options.resolveDisplayMeta(href)
                        : getLinkDisplayMeta(href);

                    return {
                        pos: typeof getPos === 'function' ? getPos() : null,
                        node,
                        nodeView: nodeViewApi,
                        element: container,
                        cardKind: 'video',
                        absolutePath: displayMeta.absolutePath || '',
                        href,
                        text: getAttachmentDisplayLabel(href, node.attrs?.label || ''),
                        displayMeta,
                        videoElement: video
                    };
                }
            };

            container.__kangarooVideoNodeView = nodeViewApi;
            syncNodeState(node);

            const getInstance = () => this.editor?.storage?.kangarooWysiwygInstance || null;

            container.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                const instance = getInstance();
                if (!instance || instance.shouldSuppressClickSelection?.()) {
                    return;
                }

                const target = getEventTargetElement(event.target);
                if (target?.closest?.('[data-kangaroo-video-player]')) {
                    return;
                }

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectVideoNode(nodeViewApi);
                instance.editor.commands.focus(undefined, {
                    scrollIntoView: false
                });
            }, true);

            container.addEventListener('dblclick', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectVideoNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onOpen;
                if (typeof handler === 'function') {
                    handler(nodeViewApi.getInfo());
                }
            }, true);

            container.addEventListener('contextmenu', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectVideoNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onContextMenu;
                if (typeof handler === 'function') {
                    handler(event, nodeViewApi.getInfo());
                }
            }, true);

            return {
                ...nodeViewApi,
                stopEvent: (event) => {
                    const target = getEventTargetElement(event?.target);
                    if (!target?.closest?.('[data-kangaroo-video]')) {
                        return false;
                    }

                    if (target.closest?.('[data-kangaroo-video-player]')) {
                        return true;
                    }

                    return ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'].includes(event.type);
                },
                destroy: () => {
                    delete container.__kangarooVideoNodeView;
                    if (this.editor?.storage?.kangarooWysiwygInstance?.selectedVideoNodeView === nodeViewApi) {
                        this.editor.storage.kangarooWysiwygInstance.clearSelectedVideoNode();
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

const KangarooMarkdownPasteBehavior = Extension.create({
    name: 'kangarooMarkdownPasteBehavior',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    handlePaste: (view, event) => {
                        if (event.defaultPrevented) {
                            return false;
                        }

                        const instance = this.editor?.storage?.kangarooWysiwygInstance;
                        const clipboardData = event.clipboardData;
                        if (!instance || !clipboardData) {
                            return false;
                        }

                        const hasFiles = Array.from(clipboardData.files || []).length > 0;
                        const hasHtml = Boolean(clipboardData.getData('text/html'));
                        const rawText = String(clipboardData.getData('text/plain') || '');

                        if (hasFiles || hasHtml || !rawText.trim()) {
                            return false;
                        }

                        if (!shouldInterpretPastedTextAsMarkdown(rawText)) {
                            return false;
                        }

                        event.preventDefault();
                        instance.editor.chain().focus(undefined, {
                            scrollIntoView: false
                        }).insertContent(normalizePastedMarkdown(rawText), {
                            contentType: 'markdown'
                        }).run();
                        instance.normalizeTaskHeadingNodesFromText();
                        instance.syncMarkdown();
                        instance.refreshLineMap?.();
                        instance.emitChange?.();
                        return true;
                    }
                }
            })
        ];
    }
});

const KangarooAssetKeyboardBehavior = Extension.create({
    name: 'kangarooAssetKeyboardBehavior',
    addKeyboardShortcuts() {
        const getInstance = () => this.editor?.storage?.kangarooWysiwygInstance || null;

        return {
            Backspace: () => {
                const instance = getInstance();
                if (!instance) return false;

                if (instance.preventImageBackspaceFromTrailingEmptyLine()) {
                    return true;
                }

                if (instance.selectedImageNodeView) {
                    return instance.deleteSelectedImageNode();
                }

                if (instance.selectedPdfNodeView) {
                    return instance.deleteSelectedPdfNode();
                }

                if (instance.selectedVideoNodeView) {
                    return instance.deleteSelectedVideoNode();
                }

                if (instance.selectedAttachmentNodeView) {
                    return instance.deleteSelectedAttachmentNode();
                }

                if (instance.selectedLinkInfo) {
                    return instance.deleteSelectedLink();
                }

                return false;
            },
            Delete: () => {
                const instance = getInstance();
                if (!instance) return false;

                if (instance.selectedImageNodeView) {
                    return instance.deleteSelectedImageNode();
                }

                if (instance.selectedPdfNodeView) {
                    return instance.deleteSelectedPdfNode();
                }

                if (instance.selectedVideoNodeView) {
                    return instance.deleteSelectedVideoNode();
                }

                if (instance.selectedAttachmentNodeView) {
                    return instance.deleteSelectedAttachmentNode();
                }

                if (instance.selectedLinkInfo) {
                    return instance.deleteSelectedLink();
                }

                return false;
            }
        };
    }
});

const KangarooAttachmentClickBehavior = Extension.create({
    name: 'kangarooAttachmentClickBehavior',
    addProseMirrorPlugins() {
        return [
            new Plugin({
                props: {
                    handleClick: (view, pos, event) => {
                        if (event.button !== 0) {
                            return false;
                        }

                        const instance = this.editor?.storage?.kangarooWysiwygInstance;
                        if (!instance || instance.shouldSuppressClickSelection?.()) {
                            return false;
                        }

                        const targetElement = getEventTargetElement(event.target);
                        if (targetElement?.closest?.('[data-resize-handle]')) {
                            return false;
                        }

                        const selection = window.getSelection?.();
                        if (selection && String(selection).trim()) {
                            return false;
                        }

                        const attachmentInfo = instance.getAttachmentInfoAtPoint(event.clientX, event.clientY);
                        if (!attachmentInfo) {
                            return false;
                        }

                        event.preventDefault();
                        instance.selectAttachment(attachmentInfo);
                        return true;
                    }
                }
            })
        ];
    }
});

const KangarooAttachmentInteractionBehavior = Extension.create({
    name: 'kangarooAttachmentInteractionBehavior',
    addProseMirrorPlugins() {
        const getAttachmentInfoAtEvent = (event) => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return null;

            const attachmentInfo = instance.getAttachmentInfoAtPoint(event.clientX, event.clientY);
            if (!attachmentInfo) return null;

            return { instance, attachmentInfo };
        };

        return [
            new Plugin({
                props: {
                    handleDOMEvents: {
                        dblclick: (view, event) => {
                            const info = getAttachmentInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectAttachment(info.attachmentInfo);
                            const handler = info.instance.attachmentInteractionHandlers?.onOpen;
                            if (typeof handler === 'function') {
                                handler(info.attachmentInfo);
                            }
                            return true;
                        },
                        contextmenu: (view, event) => {
                            const info = getAttachmentInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectAttachment(info.attachmentInfo);
                            const handler = info.instance.attachmentInteractionHandlers?.onContextMenu;
                            if (typeof handler === 'function') {
                                handler(event, info.attachmentInfo);
                            }
                            return true;
                        }
                    }
                }
            })
        ];
    }
});

const KangarooLinkDisplayBehavior = Extension.create({
    name: 'kangarooLinkDisplayBehavior',
    addProseMirrorPlugins() {
        let rafId = null;

        const scheduleRefresh = () => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                instance.refreshLinkDomState();
            });
        };

        return [
            new Plugin({
                view: () => {
                    scheduleRefresh();
                    return {
                        update: () => {
                            scheduleRefresh();
                        },
                        destroy: () => {
                            if (rafId != null) {
                                window.cancelAnimationFrame(rafId);
                                rafId = null;
                            }
                        }
                    };
                }
            })
        ];
    }
});

const KangarooLinkNormalizationBehavior = Extension.create({
    name: 'kangarooLinkNormalizationBehavior',
    addProseMirrorPlugins() {
        let rafId = null;

        const scheduleNormalize = () => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                if (instance.isApplyingExternalUpdate) return;
                instance.scheduleRawLinkConversion();
                instance.scheduleLinkHrefSync();
                instance.normalizeLinkDisplayToHref();
                instance.normalizeInternalResourceLinkLabels();
                instance.runSafeNodeNormalizers();
            });
        };

        return [
            new Plugin({
                view: () => {
                    scheduleNormalize();
                    return {
                        update: () => {
                            scheduleNormalize();
                        },
                        destroy: () => {
                            if (rafId != null) {
                                window.cancelAnimationFrame(rafId);
                                rafId = null;
                            }
                        }
                    };
                }
            })
        ];
    }
});

const KangarooImageInteractionBehavior = Extension.create({
    name: 'kangarooImageInteractionBehavior',
    addProseMirrorPlugins() {
        const getImageInfoAtEvent = (event) => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return null;

            const imageInfo = instance.getImageInfoAtPoint(event.clientX, event.clientY);
            if (!imageInfo?.imagePath) {
                return null;
            }

            return { instance, imageInfo };
        };

        return [
            new Plugin({
                props: {
                    handleDOMEvents: {
                        click: (view, event) => {
                            if (event.button !== 0) return false;

                            const info = getImageInfoAtEvent(event);
                            if (!info) return false;
                            if (info.instance.shouldSuppressClickSelection?.()) return false;

                            const targetElement = getEventTargetElement(event.target);
                            if (targetElement?.closest?.('[data-resize-handle]')) {
                                return false;
                            }

                            const selection = window.getSelection?.();
                            if (selection && String(selection).trim()) {
                                return false;
                            }

                            info.instance.selectImage(info.imageInfo);
                            const handler = info.instance.imageInteractionHandlers?.onSelect;
                            if (typeof handler === 'function') {
                                handler(info.imageInfo);
                            }
                            return false;
                        },
                        dblclick: (view, event) => {
                            const info = getImageInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectImage(info.imageInfo);
                            const handler = info.instance.imageInteractionHandlers?.onOpen;
                            if (typeof handler === 'function') {
                                handler(info.imageInfo);
                            }
                            return true;
                        },
                        contextmenu: (view, event) => {
                            const info = getImageInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectImage(info.imageInfo);
                            const handler = info.instance.imageInteractionHandlers?.onContextMenu;
                            if (typeof handler === 'function') {
                                handler(event, info.imageInfo);
                            }
                            return true;
                        }
                    }
                }
            })
        ];
    }
});

const KangarooImageDisplayBehavior = Extension.create({
    name: 'kangarooImageDisplayBehavior',
    addProseMirrorPlugins() {
        let rafId = null;

        const scheduleRefresh = () => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                instance.refreshImages();
                instance.refreshRangeSelectionHighlights();
            });
        };

        return [
            new Plugin({
                view: () => {
                    scheduleRefresh();
                    return {
                        update: () => {
                            scheduleRefresh();
                        },
                        destroy: () => {
                            if (rafId != null) {
                                window.cancelAnimationFrame(rafId);
                                rafId = null;
                            }
                        }
                    };
                }
            })
        ];
    }
});

const KangarooVideoDisplayBehavior = Extension.create({
    name: 'kangarooVideoDisplayBehavior',
    addProseMirrorPlugins() {
        let rafId = null;

        const scheduleRefresh = () => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                instance.refreshVideos?.();
            });
        };

        return [
            new Plugin({
                view: () => {
                    scheduleRefresh();
                    return {
                        update: () => {
                            scheduleRefresh();
                        },
                        destroy: () => {
                            if (rafId != null) {
                                window.cancelAnimationFrame(rafId);
                                rafId = null;
                            }
                        }
                    };
                }
            })
        ];
    }
});

const KangarooPdf = TiptapNode.create({
    name: 'kangarooPdf',
    inline: true,
    group: 'inline',
    atom: true,
    selectable: true,
    defining: true,
    isolating: true,

    addOptions() {
        return {
            resolveSrc: null,
            resolveDisplayMeta: null
        };
    },

    addAttributes() {
        return {
            href: {
                default: ''
            },
            label: {
                default: ''
            },
            title: {
                default: null
            },
            identity: {
                default: null
            },
            width: {
                default: 560
            }
        };
    },

    parseHTML() {
        return [
            {
                tag: 'span[data-kangaroo-pdf]',
                getAttrs: (element) => {
                    const href = String(element.getAttribute('data-href') || '').trim();
                    const label = String(element.getAttribute('data-label') || '').trim();
                    const rawTitle = String(element.getAttribute('title') || '').trim() || null;
                    const identity = parseAttachmentIdentityFromTitle(rawTitle);
                    const width = parsePdfWidthFromTitle(rawTitle, 560);
                    const title = stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(rawTitle));
                    if (!href) {
                        return false;
                    }

                    return { href, label, title, identity, width };
                }
            }
        ];
    },

    renderHTML({ HTMLAttributes }) {
        const href = String(HTMLAttributes?.href || '').trim();
        const label = getAttachmentDisplayLabel(href, HTMLAttributes?.label);
        const width = clampPdfPreviewWidth(HTMLAttributes?.width);
        const displayMeta = this.options.resolveDisplayMeta
            ? this.options.resolveDisplayMeta(href)
            : getLinkDisplayMeta(href);
        const resolvedSrc = this.options.resolveSrc
            ? this.options.resolveSrc(href)
            : href;
        const markdownTitle = mergePdfWidthIntoTitle(
            mergeAttachmentIdentityIntoTitle(HTMLAttributes?.title || null, HTMLAttributes?.identity || null),
            width
        );

        return ['span', mergeAttributes(HTMLAttributes, {
            'data-kangaroo-pdf': '',
            'data-href': href,
            'data-label': label,
            'data-link-kind': displayMeta.kind || 'attachment-pdf',
            'data-kangaroo-path': displayMeta.absolutePath || '',
            title: stripPdfWidthFromTitle(markdownTitle) || displayMeta.title || href || '',
            style: `--kangaroo-pdf-width:${width}px;`,
            class: `kangaroo-pdf-card kangaroo-pdf-${displayMeta.kind || 'attachment-pdf'}`
        }),
            ['span', { class: 'kangaroo-pdf-shell', 'data-kangaroo-pdf-shell': '' },
                ['span', { class: 'kangaroo-pdf-header', 'data-kangaroo-pdf-header': '' },
                    ['span', { class: 'kangaroo-pdf-icon', 'aria-hidden': 'true' }, displayMeta.icon || '📕'],
                    ['span', { class: 'kangaroo-pdf-label' }, label],
                    ['span', { class: 'kangaroo-pdf-badge', 'aria-hidden': 'true' }, displayMeta.badge || 'PDF']
                ],
                ['span', { class: 'kangaroo-pdf-viewer', 'data-kangaroo-pdf-viewer': '' },
                    ['img', {
                        src: '',
                        alt: label,
                        loading: 'lazy',
                        draggable: 'false',
                        'data-kangaroo-pdf-element': ''
                    }],
                    ['span', { class: 'kangaroo-pdf-resize-handle', 'data-kangaroo-pdf-resize-handle': '', 'aria-hidden': 'true' }]
                ]
            ]
        ];
    },

    renderText({ node }) {
        return getAttachmentDisplayLabel(node.attrs?.href || '', node.attrs?.label || '');
    },

    renderMarkdown(node) {
        const href = serializeMarkdownHref(node.attrs?.href || '');
        const label = String(node.attrs?.label || '').trim() || decodeLinkLabelFromHref(href);
        const title = mergePdfWidthIntoTitle(
            mergeAttachmentIdentityIntoTitle(node.attrs?.title || null, node.attrs?.identity || null),
            node.attrs?.width
        );
        if (!href) return label;
        return title
            ? `[${escapeMarkdownLinkLabel(label)}](${href} "${escapeMarkdownTitle(title)}")`
            : `[${escapeMarkdownLinkLabel(label)}](${href})`;
    },

    addCommands() {
        return {
            insertPdfAttachment: (relativePath, options = {}) => ({ chain }) => {
                const normalizedRelativePath = normalizeLinkHref(relativePath);
                if (!normalizedRelativePath) {
                    return false;
                }

                const label = String(options.label || '').trim() || decodeLinkLabelFromHref(normalizedRelativePath);
                const title = options.title || null;
                const identity = options.identity || null;
                const width = clampPdfPreviewWidth(options.width);
                const { insertTrailingParagraph = true } = options;

                const commandChain = chain().focus(undefined, {
                    scrollIntoView: false
                }).insertContent({
                    type: this.name,
                    attrs: {
                        href: normalizedRelativePath,
                        label,
                        title,
                        identity,
                        width
                    }
                });

                if (insertTrailingParagraph) {
                    commandChain.enter();
                }

                return commandChain.run();
            }
        };
    },

    addNodeView() {
        return ({ node, getPos }) => {
            const container = document.createElement('span');
            container.dataset.kangarooPdf = '';
            container.contentEditable = 'false';
            container.draggable = false;

            const shell = document.createElement('span');
            shell.className = 'kangaroo-pdf-shell';
            shell.dataset.kangarooPdfShell = '';

            const header = document.createElement('span');
            header.className = 'kangaroo-pdf-header';
            header.dataset.kangarooPdfHeader = '';
            header.contentEditable = 'false';

            const icon = document.createElement('span');
            icon.className = 'kangaroo-pdf-icon';
            icon.setAttribute('aria-hidden', 'true');
            icon.contentEditable = 'false';

            const label = document.createElement('span');
            label.className = 'kangaroo-pdf-label';
            label.contentEditable = 'false';

            const badge = document.createElement('span');
            badge.className = 'kangaroo-pdf-badge';
            badge.setAttribute('aria-hidden', 'true');
            badge.contentEditable = 'false';

            const viewer = document.createElement('span');
            viewer.className = 'kangaroo-pdf-viewer';
            viewer.dataset.kangarooPdfViewer = '';
            viewer.contentEditable = 'false';

            const previewImage = document.createElement('img');
            previewImage.dataset.kangarooPdfElement = '';
            previewImage.loading = 'lazy';
            previewImage.alt = '';
            previewImage.draggable = false;
            previewImage.contentEditable = 'false';

            header.appendChild(icon);
            header.appendChild(label);
            header.appendChild(badge);
            viewer.appendChild(previewImage);
            const resizeHandle = document.createElement('span');
            resizeHandle.className = 'kangaroo-pdf-resize-handle';
            resizeHandle.dataset.kangarooPdfResizeHandle = '';
            resizeHandle.contentEditable = 'false';
            shell.appendChild(header);
            shell.appendChild(viewer);
            container.appendChild(shell);
            container.appendChild(resizeHandle);

            let previewRequestId = 0;
            let lastPreviewKey = '';

            const syncPreviewImage = async (resolvedSrc, displayLabel) => {
                const nextPreviewKey = `${String(resolvedSrc || '')}::${String(displayLabel || '')}`;
                if (nextPreviewKey === lastPreviewKey && previewImage.getAttribute('src')) {
                    previewImage.alt = displayLabel || 'PDF';
                    return;
                }

                const requestId = ++previewRequestId;
                lastPreviewKey = nextPreviewKey;
                previewImage.alt = displayLabel || 'PDF';
                container.classList.add('is-loading');

                const previewDataUrl = await buildPdfPreviewDataUrl(resolvedSrc);
                if (requestId !== previewRequestId) {
                    return;
                }

                if (previewDataUrl) {
                    if (previewImage.getAttribute('src') !== previewDataUrl) {
                        previewImage.src = previewDataUrl;
                    }
                    previewImage.style.display = 'block';
                    viewer.removeAttribute('data-pdf-fallback');
                } else {
                    previewImage.removeAttribute('src');
                    previewImage.style.display = 'none';
                    viewer.setAttribute('data-pdf-fallback', displayLabel || 'PDF');
                }

                container.classList.remove('is-loading');
            };

            const syncNodeState = (updatedNode = node) => {
                const href = String(updatedNode.attrs?.href || '').trim();
                const displayLabel = getAttachmentDisplayLabel(href, updatedNode.attrs?.label || '');
                const width = clampPdfPreviewWidth(updatedNode.attrs?.width);
                const displayMeta = this.options.resolveDisplayMeta
                    ? this.options.resolveDisplayMeta(href)
                    : getLinkDisplayMeta(href);
                const resolvedSrc = this.options.resolveSrc
                    ? this.options.resolveSrc(href)
                    : href;

                container.className = `kangaroo-pdf-card kangaroo-pdf-${displayMeta.kind || 'attachment-pdf'}`;
                container.setAttribute('data-href', href);
                container.setAttribute('data-label', displayLabel);
                container.setAttribute('data-link-kind', displayMeta.kind || 'attachment-pdf');
                container.setAttribute('data-kangaroo-path', displayMeta.absolutePath || '');
                container.setAttribute('title', stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(updatedNode.attrs?.title || null)) || displayMeta.title || href || '');
                container.style.setProperty('--kangaroo-pdf-width', `${width}px`);
                container.style.width = `${width}px`;

                icon.textContent = displayMeta.icon || '📕';
                label.textContent = displayLabel;
                badge.textContent = displayMeta.badge || 'PDF';
                syncPreviewImage(resolvedSrc, displayLabel);
            };

            const nodeViewApi = {
                dom: container,
                update: (updatedNode) => {
                    if (updatedNode.type.name !== this.name) {
                        return false;
                    }
                    node = updatedNode;
                    syncNodeState(updatedNode);
                    return true;
                },
                selectNode: () => {
                    container.classList.add('ProseMirror-selectednode', 'is-selected');
                },
                deselectNode: () => {
                    container.classList.remove('ProseMirror-selectednode', 'is-selected');
                },
                getPos,
                getNode: () => node,
                getHref: () => String(node.attrs?.href || ''),
                getLabel: () => String(node.attrs?.label || ''),
                getDom: () => container,
                getFrameElement: () => previewImage,
                getInfo: () => {
                    const href = String(node.attrs?.href || '').trim();
                    const displayMeta = this.options.resolveDisplayMeta
                        ? this.options.resolveDisplayMeta(href)
                        : getLinkDisplayMeta(href);

                    return {
                        pos: typeof getPos === 'function' ? getPos() : null,
                        node,
                        nodeView: nodeViewApi,
                        element: container,
                        cardKind: 'pdf',
                        absolutePath: displayMeta.absolutePath || '',
                        href,
                        text: getAttachmentDisplayLabel(href, node.attrs?.label || ''),
                        displayMeta,
                        frameElement: previewImage
                    };
                }
            };

            container.__kangarooPdfNodeView = nodeViewApi;
            syncNodeState(node);

            const getInstance = () => this.editor?.storage?.kangarooWysiwygInstance || null;
            let resizeState = null;

            const applyPreviewWidth = (nextWidth) => {
                const width = clampPdfPreviewWidth(nextWidth);
                container.style.setProperty('--kangaroo-pdf-width', `${width}px`);
                container.style.width = `${width}px`;
                return width;
            };

            const updateNodeWidth = (nextWidth) => {
                const pos = typeof getPos === 'function' ? getPos() : null;
                if (typeof pos !== 'number') return;
                const width = clampPdfPreviewWidth(nextWidth);
                const instance = getInstance();
                const currentNode = this.editor.state.doc.nodeAt(pos);
                if (!currentNode || currentNode.type?.name !== this.name) {
                    return;
                }

                this.editor.chain().setNodeSelection(pos).focus(undefined, {
                    scrollIntoView: false
                }).run();

                const attrs = {
                    ...currentNode.attrs,
                    width
                };
                this.editor.view.dispatch(
                    this.editor.state.tr.setNodeMarkup(pos, undefined, attrs)
                );

                if (instance) {
                    const didRewriteMarkdown = instance.updatePdfWidthInCurrentMarkdown(
                        currentNode.attrs?.href || '',
                        width,
                        currentNode.attrs?.identity || null
                    );
                    if (!didRewriteMarkdown) {
                        instance.syncMarkdown();
                    }
                    instance.refreshLineMap();
                    instance.emitChange();
                }
                if (typeof window.__kangarooPersistActiveTabState === 'function') {
                    window.__kangarooPersistActiveTabState(instance?.getValue?.() || null);
                }
            };

            container.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                const instance = getInstance();
                if (!instance || instance.shouldSuppressClickSelection?.()) {
                    return;
                }

                const target = getEventTargetElement(event.target);
                if (target?.closest?.('[data-kangaroo-pdf-resize-handle]')) {
                    return;
                }
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectPdfNode(nodeViewApi);
                instance.editor.commands.focus(undefined, {
                    scrollIntoView: false
                });
            }, true);

            container.addEventListener('dblclick', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectPdfNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onOpen;
                if (typeof handler === 'function') {
                    handler(nodeViewApi.getInfo());
                }
            }, true);

            container.addEventListener('contextmenu', (event) => {
                const instance = getInstance();
                if (!instance) return;

                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                instance.selectPdfNode(nodeViewApi);
                const handler = instance.attachmentInteractionHandlers?.onContextMenu;
                if (typeof handler === 'function') {
                    handler(event, nodeViewApi.getInfo());
                }
            }, true);

            resizeHandle.addEventListener('mousedown', (event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                event.stopPropagation();
                event.stopImmediatePropagation?.();
                const instance = getInstance();
                instance?.selectPdfNode?.(nodeViewApi);

                 document.body.style.cursor = 'nwse-resize';

                resizeState = {
                    startX: event.clientX,
                    startWidth: clampPdfPreviewWidth(node.attrs?.width),
                    currentWidth: clampPdfPreviewWidth(node.attrs?.width)
                };

                const handleMove = (moveEvent) => {
                    if (!resizeState) return;
                    moveEvent.preventDefault();
                    const deltaX = moveEvent.clientX - resizeState.startX;
                    resizeState.currentWidth = applyPreviewWidth(resizeState.startWidth + deltaX);
                };

                const handleUp = () => {
                    if (resizeState) {
                        updateNodeWidth(resizeState.currentWidth);
                    }
                    resizeState = null;
                    document.body.style.cursor = '';
                    window.removeEventListener('mousemove', handleMove, true);
                    window.removeEventListener('mouseup', handleUp, true);
                };

                window.addEventListener('mousemove', handleMove, true);
                window.addEventListener('mouseup', handleUp, true);
            }, true);

            return {
                ...nodeViewApi,
                stopEvent: (event) => {
                    const target = getEventTargetElement(event?.target);
                    if (!target?.closest?.('[data-kangaroo-pdf]')) {
                        return false;
                    }

                    if (target.closest?.('[data-kangaroo-pdf-viewer]')) {
                        return true;
                    }

                    return ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu'].includes(event.type);
                },
                destroy: () => {
                    delete container.__kangarooPdfNodeView;
                    if (this.editor?.storage?.kangarooWysiwygInstance?.selectedPdfNodeView === nodeViewApi) {
                        this.editor.storage.kangarooWysiwygInstance.clearSelectedPdfNode();
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

const KangarooPdfDisplayBehavior = Extension.create({
    name: 'kangarooPdfDisplayBehavior',
    addProseMirrorPlugins() {
        let rafId = null;

        const scheduleRefresh = () => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return;
            if (rafId != null) {
                window.cancelAnimationFrame(rafId);
            }
            rafId = window.requestAnimationFrame(() => {
                rafId = null;
                instance.refreshPdfs?.();
            });
        };

        return [
            new Plugin({
                view: () => {
                    scheduleRefresh();
                    return {
                        update: () => {
                            scheduleRefresh();
                        },
                        destroy: () => {
                            if (rafId != null) {
                                window.cancelAnimationFrame(rafId);
                                rafId = null;
                            }
                        }
                    };
                }
            })
        ];
    }
});

const KangarooGeneralLinkInteractionBehavior = Extension.create({
    name: 'kangarooGeneralLinkInteractionBehavior',
    addProseMirrorPlugins() {
        const getLinkInfoAtEvent = (event) => {
            const instance = this.editor?.storage?.kangarooWysiwygInstance;
            if (!instance) return null;

            const linkInfo = instance.getLinkInfoAtPoint(event.clientX, event.clientY);
            if (!linkInfo) return null;

            const kind = String(linkInfo.displayMeta?.kind || '');
            const isAttachmentCard = kind === 'attachment-file' || kind === 'attachment-folder' || kind === 'attachment-missing';
            if (isAttachmentCard) {
                return null;
            }

            return { instance, linkInfo };
        };

        return [
            new Plugin({
                props: {
                    handleDOMEvents: {
                        dblclick: (view, event) => {
                            const info = getLinkInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectLink(info.linkInfo);
                            const handler = info.instance.linkInteractionHandlers?.onOpen;
                            if (typeof handler === 'function') {
                                handler(info.linkInfo);
                            }
                            return true;
                        },
                        contextmenu: (view, event) => {
                            const info = getLinkInfoAtEvent(event);
                            if (!info) return false;

                            event.preventDefault();
                            event.stopPropagation();
                            info.instance.selectLink(info.linkInfo);
                            const handler = info.instance.linkInteractionHandlers?.onContextMenu;
                            if (typeof handler === 'function') {
                                handler(event, info.linkInfo);
                            }
                            return true;
                        }
                    }
                }
            })
        ];
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
        this.selectedPdfNodeView = null;
        this.selectedVideoNodeView = null;
        this.selectedLinkInfo = null;
        this.selectedLinkElement = null;
        this.selectedLinkOverlay = null;
        this.attachmentInteractionHandlers = {
            onOpen: null,
            onContextMenu: null
        };
        this.imageInteractionHandlers = {
            onSelect: null,
            onOpen: null,
            onContextMenu: null
        };
        this.linkInteractionHandlers = {
            onOpen: null,
            onContextMenu: null
        };
        this.deleteInteractionHandlers = {
            onBeforeDelete: null
        };
        this.pointerInteraction = {
            active: false,
            moved: false,
            startX: 0,
            startY: 0,
            suppressClickUntil: 0
        };
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
        this.selectedAttachmentNodeView = null;

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
                KangarooMarkdownPasteBehavior,
                KangarooAssetKeyboardBehavior,
                KangarooLinkDisplayBehavior,
                KangarooLinkNormalizationBehavior,
                KangarooImageDisplayBehavior,
                KangarooPdfDisplayBehavior,
                KangarooVideoDisplayBehavior,
                KangarooImageInteractionBehavior,
                KangarooGeneralLinkInteractionBehavior,
                KangarooLink.configure({
                    autolink: true,
                    linkOnPaste: true,
                    protocols: ['http', 'https', 'file', 'mailto', 'zotero'],
                    resolveDisplayMeta: (href) => this.resolveLinkDisplayMeta(href)
                }),
                KangarooAttachment.configure({
                    resolveDisplayMeta: (href) => this.resolveLinkDisplayMeta(href)
                }),
                KangarooPdf.configure({
                    resolveDisplayMeta: (href) => this.resolveLinkDisplayMeta(href),
                    resolveSrc: (href) => this.resolveDisplaySource(href)
                }),
                KangarooVideo.configure({
                    resolveDisplayMeta: (href) => this.resolveLinkDisplayMeta(href),
                    resolveSrc: (href) => this.resolveDisplaySource(href)
                }),
                TaskList,
                KangarooTaskItem.configure({
                    nested: true
                }),
                KangarooImage.configure({
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
                }
            },
            onCreate: () => {
                this.normalizeTaskHeadingNodesFromText();
                this.syncMarkdown();
                this.refreshLineMap();
                this.refreshRangeSelectionHighlights();
            },
            onSelectionUpdate: () => {
                this.refreshLineMap();
                this.syncSelectedLinkWithSelection();
                this.refreshRangeSelectionHighlights();
            },
            onUpdate: () => {
                if (this.isApplyingExternalUpdate) return;
                if (this.normalizeTaskHeadingNodesFromText()) {
                    return;
                }
                this.syncMarkdown();
                this.refreshLineMap();
                this.refreshRangeSelectionHighlights();
                this.emitChange();
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

            if (targetElement?.closest?.('[data-kangaroo-attachment]')) {
                return;
            }

            if (targetElement?.closest?.('[data-kangaroo-pdf]')) {
                return;
            }

            if (targetElement?.closest?.('[data-kangaroo-video]')) {
                return;
            }

            this.clearSelectedImageNode();
            this.clearSelectedPdfNode();
            this.clearSelectedVideoNode();
            this.clearSelectedAttachmentNode();
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
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();
        this.editor.destroy();
    }

    getValue() {
        return this.currentMarkdown;
    }

    getLiveMarkdownSnapshot() {
        try {
            return normalizeMarkdown(this.editor?.getMarkdown?.() || this.currentMarkdown);
        } catch {
            return this.currentMarkdown;
        }
    }

    getSelectionSnapshot() {
        const selection = this.editor?.state?.selection;
        if (!selection) return null;
        return {
            from: selection.from,
            to: selection.to
        };
    }

    restoreSelectionSnapshot(snapshot, options = {}) {
        if (!snapshot || !this.editor?.state?.doc) return false;
        const { scrollIntoView = false } = options;
        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const from = clampNumber(snapshot.from, 1, maxPos);
        const to = clampNumber(snapshot.to, 1, maxPos);

        try {
            this.editor
                .chain()
                .focus(undefined, { scrollIntoView })
                .setTextSelection({ from, to })
                .run();
            return true;
        } catch {
            return false;
        }
    }

    setValue(markdown, options = {}) {
        const { emitChange = false } = options;
        this.currentMarkdown = normalizeMarkdown(markdown);
        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();
        clearBrowserSelection();
        this.isApplyingExternalUpdate = true;
        this.editor.commands.setContent(this.currentMarkdown, {
            contentType: 'markdown',
            emitUpdate: false
        });
        this.normalizeTaskHeadingNodesFromText();
        const {
            didRepair,
            didNormalizeAttachment,
            didNormalizePdf,
            didNormalizeVideo
        } = this.runSafeNodeNormalizers();
        this.isApplyingExternalUpdate = false;
        if (didRepair || didNormalizeAttachment || didNormalizePdf || didNormalizeVideo) {
            this.syncMarkdown();
        }
        resetEditorSelectionToDocumentStart(this.editor);
        this.refreshLineMap();
        this.refreshLinkDomState();
        this.refreshAttachmentNodeLabels();
        this.refreshRangeSelectionHighlights();

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
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();

        this.isApplyingExternalUpdate = true;
        this.editor.commands.setContent(this.currentMarkdown, {
            contentType: 'markdown',
            emitUpdate: false
        });
        this.normalizeTaskHeadingNodesFromText();
        const {
            didRepair,
            didNormalizeAttachment,
            didNormalizePdf,
            didNormalizeVideo
        } = this.runSafeNodeNormalizers();
        const didChange = didRepair || didNormalizeAttachment || didNormalizePdf || didNormalizeVideo;
        this.isApplyingExternalUpdate = false;
        if (didChange) {
            this.syncMarkdown();
        }

        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const from = clampNumber(selection.from, 1, maxPos);
        const to = clampNumber(selection.to, 1, maxPos);
        this.editor.chain().setTextSelection({ from, to }).run();
        this.refreshLineMap();
        this.refreshLinkDomState();
        this.refreshAttachmentNodeLabels();
        this.refreshRangeSelectionHighlights();
        return didChange;
    }

    runSafeNodeNormalizers() {
        const safeRun = (fn, label) => {
            try {
                return Boolean(fn.call(this));
            } catch (error) {
                console.warn(`[Kangaroo] 跳过 ${label} 归一化：`, error);
                return false;
            }
        };

        return {
            didRepair: safeRun(this.repairAttachmentReferencesByIdentity, '附件引用修复'),
            didNormalizeAttachment: safeRun(this.normalizeAttachmentNodes, '附件节点'),
            didNormalizePdf: safeRun(this.normalizePdfNodes, 'PDF 节点'),
            didNormalizeVideo: safeRun(this.normalizeVideoNodes, '视频节点')
        };
    }

    updateAttachmentReferencesAfterRename(oldAbsolutePath, newAbsolutePath) {
        const previousAbsolutePath = path.resolve(String(oldAbsolutePath || ''));
        const nextAbsolutePath = path.resolve(String(newAbsolutePath || ''));
        if (!this.bundlePath || !previousAbsolutePath || !nextAbsolutePath) {
            return false;
        }

        const oldRelativeHref = normalizeLinkHref(path.relative(this.bundlePath, previousAbsolutePath));
        const nextRelativeHref = normalizeLinkHref(path.relative(this.bundlePath, nextAbsolutePath));
        if (!oldRelativeHref || !nextRelativeHref) {
            return false;
        }

        const previousIdentity = getAttachmentIdentityFromPath(previousAbsolutePath);
        const nextIdentity = getAttachmentIdentityFromPath(nextAbsolutePath) || previousIdentity;
        const nextLabel = safeDecodeUri(path.basename(nextRelativeHref)) || decodeLinkLabelFromHref(nextRelativeHref);

        const shouldMatchAttachmentRef = (href, title = null, identityAttr = null) => {
            const normalizedHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (!normalizedHref.startsWith('attachments/')) {
                return false;
            }

            const resolvedAbsolutePath = this.resolveAttachmentAbsolutePath(normalizedHref);
            const effectiveIdentity = identityAttr || parseAttachmentIdentityFromTitle(title) || (resolvedAbsolutePath ? getAttachmentIdentityFromPath(resolvedAbsolutePath) : null);

            return normalizedHref === oldRelativeHref
                || resolvedAbsolutePath === previousAbsolutePath
                || (Boolean(previousIdentity) && effectiveIdentity === previousIdentity);
        };

        const buildNextTitle = (title, identity, width = null) => {
            let nextTitle = mergeAttachmentIdentityIntoTitle(stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(title || null)), identity);
            if (width != null) {
                nextTitle = mergePdfWidthIntoTitle(nextTitle, width);
            }
            return nextTitle;
        };

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
        let didChange = false;
        const linkMark = this.editor.state.schema.marks.link;

        if (linkMark) {
            const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
            for (let index = ranges.length - 1; index >= 0; index--) {
                const range = ranges[index];
                if (!shouldMatchAttachmentRef(range.attrs?.href || '', range.attrs?.title || null, null)) {
                    continue;
                }

                const nextTitle = buildNextTitle(range.attrs?.title || null, nextIdentity, isPdfAttachmentHref(nextRelativeHref) ? parsePdfWidthFromTitle(range.attrs?.title || null, 560) : null);
                tr = tr.insertText(nextLabel, range.from, range.to);
                tr = tr.addMark(
                    range.from,
                    range.from + nextLabel.length,
                    linkMark.create({
                        ...range.attrs,
                        href: nextRelativeHref,
                        title: nextTitle
                    })
                );
                didChange = true;
            }
        }

        this.editor.state.doc.descendants((node, pos) => {
            const typeName = node?.type?.name;
            if (!['kangarooAttachment', 'kangarooVideo', 'kangarooPdf'].includes(typeName)) {
                return true;
            }

            if (!shouldMatchAttachmentRef(node.attrs?.href || '', node.attrs?.title || null, node.attrs?.identity || null)) {
                return true;
            }

            const nextAttrs = {
                ...node.attrs,
                href: nextRelativeHref,
                label: nextLabel,
                title: buildNextTitle(node.attrs?.title || null, nextIdentity, typeName === 'kangarooPdf' ? clampPdfPreviewWidth(node.attrs?.width) : null),
                identity: nextIdentity
            };

            tr = tr.setNodeMarkup(pos, undefined, nextAttrs);
            didChange = true;
            return true;
        });

        if (!didChange) {
            return false;
        }

        this.editor.view.dispatch(tr);
        this.syncMarkdown();
        this.refreshLineMap();
        this.refreshLinkDomState();
        this.refreshAttachmentNodeLabels();
        this.refreshRangeSelectionHighlights();
        return true;
    }

    updatePdfWidthInCurrentMarkdown(href, width, identity = null) {
        const normalizedTargetHref = normalizeLinkHref(href).replace(/^\.?\//, '');
        if (!normalizedTargetHref || !isPdfAttachmentHref(normalizedTargetHref)) {
            return false;
        }

        const targetIdentity = String(identity || '').trim();
        const nextWidth = clampPdfPreviewWidth(width);
        const attachmentRegex = /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?(attachments\/(?:<[^>]+>|[^)\s]+))(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;

        let didChange = false;
        const nextMarkdown = this.currentMarkdown.replace(attachmentRegex, (fullMatch, rawLabel, rawHref, rawTitle = '') => {
            const normalizedHref = normalizeLinkHref(String(rawHref || '').replace(/^<|>$/g, '')).replace(/^\.?\//, '');
            if (normalizedHref !== normalizedTargetHref || !isPdfAttachmentHref(normalizedHref)) {
                return fullMatch;
            }

            const currentIdentity = parseAttachmentIdentityFromTitle(rawTitle || '');
            if (targetIdentity && currentIdentity && currentIdentity !== targetIdentity) {
                return fullMatch;
            }

            const nextTitle = mergePdfWidthIntoTitle(
                mergeAttachmentIdentityIntoTitle(
                    stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(rawTitle || '')),
                    targetIdentity || currentIdentity || null
                ),
                nextWidth
            );

            didChange = true;
            return `[${rawLabel}](${serializeMarkdownHref(normalizedHref)} "${escapeMarkdownTitle(nextTitle)}")`;
        });

        if (!didChange) {
            return false;
        }

        this.currentMarkdown = normalizeMarkdown(nextMarkdown);
        return true;
    }

    focus() {
        this.editor.commands.focus();
    }

    beginPointerInteraction(clientX, clientY) {
        this.pointerInteraction.active = true;
        this.pointerInteraction.moved = false;
        this.pointerInteraction.startX = Number(clientX) || 0;
        this.pointerInteraction.startY = Number(clientY) || 0;
    }

    trackPointerInteraction(clientX, clientY) {
        if (!this.pointerInteraction.active) return;
        const deltaX = Math.abs((Number(clientX) || 0) - this.pointerInteraction.startX);
        const deltaY = Math.abs((Number(clientY) || 0) - this.pointerInteraction.startY);
        if (deltaX >= 4 || deltaY >= 4) {
            this.pointerInteraction.moved = true;
        }
    }

    endPointerInteraction() {
        if (this.pointerInteraction.active && this.pointerInteraction.moved) {
            this.pointerInteraction.suppressClickUntil = Date.now() + 180;
        }
        this.pointerInteraction.active = false;
        this.pointerInteraction.moved = false;
    }

    shouldSuppressClickSelection() {
        return Date.now() <= this.pointerInteraction.suppressClickUntil;
    }

    preventImageBackspaceFromTrailingEmptyLine() {
        const { selection } = this.editor.state;
        if (!selection?.empty || selection?.node) return false;

        const { $from } = selection;
        const currentParent = $from.parent;
        if (!currentParent?.isTextblock) return false;

        if (isImageContainerNode(currentParent) && $from.parentOffset >= currentParent.content.size) {
            const currentParentStart = $from.before($from.depth);
            return this.selectImageNodeAtDocPos(findLastImageNodePos(currentParent, currentParentStart));
        }

        if (String(currentParent.textContent || '').trim()) {
            return false;
        }

        if ($from.depth <= 0) {
            return false;
        }

        const parentContainer = $from.node($from.depth - 1);
        const indexInContainer = $from.index($from.depth - 1);
        if (indexInContainer <= 0) {
            return false;
        }

        let previousSibling = null;
        let previousSiblingStart = null;
        let probeStart = $from.before($from.depth);

        for (let index = indexInContainer - 1; index >= 0; index--) {
            const sibling = parentContainer.child(index);
            probeStart -= sibling.nodeSize;

            if (isEffectivelyEmptyTextblockNode(sibling)) {
                continue;
            }

            previousSibling = sibling;
            previousSiblingStart = probeStart;
            break;
        }

        if (typeof previousSiblingStart !== 'number') {
            return false;
        }

        if (!isImageContainerNode(previousSibling)) {
            return false;
        }

        return this.moveCursorToEndOfNode(previousSibling, previousSiblingStart);
    }

    selectImageNodeAtDocPos(pos) {
        if (typeof pos !== 'number' || !Number.isFinite(pos)) {
            return false;
        }

        try {
            this.editor.chain().setNodeSelection(pos).focus(undefined, {
                scrollIntoView: false
            }).run();
            return this.editor.state.selection?.node?.type?.name === 'image';
        } catch {
            return false;
        }
    }

    moveCursorToEndOfNode(node, startPos) {
        if (!node || typeof startPos !== 'number' || !Number.isFinite(startPos)) {
            return false;
        }

        try {
            const targetPos = startPos + Math.max(node.nodeSize - 1, 1);
            this.editor.chain().setTextSelection(targetPos).focus(undefined, {
                scrollIntoView: false
            }).run();
            return this.editor.state.selection?.empty === true;
        } catch {
            return false;
        }
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

    setAttachmentInteractionHandlers(handlers = {}) {
        this.attachmentInteractionHandlers = {
            onOpen: typeof handlers.onOpen === 'function' ? handlers.onOpen : null,
            onContextMenu: typeof handlers.onContextMenu === 'function' ? handlers.onContextMenu : null
        };
    }

    setImageInteractionHandlers(handlers = {}) {
        this.imageInteractionHandlers = {
            onSelect: typeof handlers.onSelect === 'function' ? handlers.onSelect : null,
            onOpen: typeof handlers.onOpen === 'function' ? handlers.onOpen : null,
            onContextMenu: typeof handlers.onContextMenu === 'function' ? handlers.onContextMenu : null
        };
    }

    setLinkInteractionHandlers(handlers = {}) {
        this.linkInteractionHandlers = {
            onOpen: typeof handlers.onOpen === 'function' ? handlers.onOpen : null,
            onContextMenu: typeof handlers.onContextMenu === 'function' ? handlers.onContextMenu : null
        };
    }

    setDeleteInteractionHandlers(handlers = {}) {
        this.deleteInteractionHandlers = {
            onBeforeDelete: typeof handlers.onBeforeDelete === 'function' ? handlers.onBeforeDelete : null
        };
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
        this.normalizeTaskHeadingNodesFromText();
        this.syncMarkdown();
        this.refreshLineMap();
        this.emitChange();
    }

    insertHtml(html) {
        if (!html) return false;
        return this.editor.chain().focus().insertContent(html).run();
    }

    insertSliceJson(sliceJson) {
        if (!sliceJson) return false;

        try {
            const slice = Slice.fromJSON(this.editor.state.schema, sliceJson);
            const tr = this.editor.state.tr.replaceSelection(slice);
            this.editor.view.dispatch(tr);
            this.focus();
            return true;
        } catch {
            return false;
        }
    }

    insertImage(src, options = {}) {
        if (typeof this.editor.commands.insertKangarooImage === 'function') {
            return this.editor.commands.insertKangarooImage(src, options);
        }

        const targetSrc = String(src || '').trim();
        if (!targetSrc) return false;

        const chain = this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).insertContent({
            type: 'paragraph',
            content: [{
                type: 'image',
                attrs: {
                    src: targetSrc,
                    alt: options.alt || 'image',
                    title: options.title || null
                }
            }]
        });

        if (options.insertTrailingParagraph) {
            chain.enter();
        }

        return chain.run();
    }

    insertLink(label, href, options = {}) {
        if (typeof this.editor.commands.insertKangarooLink === 'function') {
            return this.editor.commands.insertKangarooLink(label, href, options);
        }

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

    insertAttachmentLink(relativePath, options = {}) {
        if (typeof this.editor.commands.insertAttachmentLink === 'function') {
            return this.editor.commands.insertAttachmentLink(relativePath, options);
        }

        const normalizedRelativePath = normalizeLinkHref(relativePath);
        if (!normalizedRelativePath) {
            return false;
        }

        const label = decodeLinkLabelFromHref(normalizedRelativePath);
        return this.insertLink(label, normalizedRelativePath, options);
    }

    insertVideoAttachment(relativePath, options = {}) {
        if (typeof this.editor.commands.insertAttachmentLink === 'function') {
            return this.editor.commands.insertAttachmentLink(relativePath, options);
        }

        return this.insertAttachmentLink(relativePath, options);
    }

    insertPdfAttachment(relativePath, options = {}) {
        if (typeof this.editor.commands.insertPdfAttachment === 'function') {
            return this.editor.commands.insertPdfAttachment(relativePath, options);
        }

        return this.insertAttachmentLink(relativePath, options);
    }

    insertAbsolutePathLink(absolutePath, options = {}) {
        if (typeof this.editor.commands.insertAbsolutePathLink === 'function') {
            return this.editor.commands.insertAbsolutePathLink(absolutePath, options);
        }

        const normalizedPath = String(absolutePath || '').trim();
        if (!normalizedPath) {
            return false;
        }

        const href = pathToFileURL(normalizedPath).href;
        return this.insertLink(normalizedPath, href, options);
    }

    getTaskItemContext() {
        const { $from } = this.editor.state.selection;
        for (let depth = $from.depth; depth >= 0; depth--) {
            const node = $from.node(depth);
            if (node?.type?.name === 'taskItem') {
                return {
                    depth,
                    node,
                    pos: $from.before(depth)
                };
            }
        }

        return null;
    }

    setTaskItemHeadingLevel(level) {
        const context = this.getTaskItemContext();
        if (!context) return false;

        const nextLevel = clampNumber(Number(level || 0), 0, 6);
        const currentLevel = clampNumber(Number(context.node.attrs?.headingLevel || 0), 0, 6);
        const resolvedLevel = currentLevel === nextLevel ? 0 : nextLevel;

        const tr = this.editor.state.tr.setNodeMarkup(context.pos, undefined, {
            ...context.node.attrs,
            headingLevel: resolvedLevel
        });

        this.editor.view.dispatch(tr);
        this.syncMarkdown();
        this.refreshLineMap();
        this.emitChange();
        return true;
    }

    toggleHeading(level) {
        const headingLevel = clampNumber(Number(level), 1, 6);
        if (this.getTaskItemContext()) {
            return this.setTaskItemHeadingLevel(headingLevel);
        }

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

    undo() {
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).undo().run();
    }

    redo() {
        return this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).redo().run();
    }

    getToolbarState() {
        const taskContext = this.getTaskItemContext();
        const taskHeadingLevel = clampNumber(Number(taskContext?.node?.attrs?.headingLevel || 0), 0, 6);
        return {
            canUndo: this.editor.can().chain().focus(undefined, { scrollIntoView: false }).undo().run(),
            canRedo: this.editor.can().chain().focus(undefined, { scrollIntoView: false }).redo().run(),
            headingLevel: taskHeadingLevel || [1, 2, 3, 4, 5, 6].find((level) => this.editor.isActive('heading', { level })) || 0,
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
        if (targetElement.closest('[data-kangaroo-attachment]')) return false;

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
        const restoreByTextblockOrder = options.restoreByTextblockOrder !== false;
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
        if (restoreByTextblockOrder && this.jumpToTextblockOrder(textblockOrder)) {
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
        const restoreByTextblockOrder = options.restoreByTextblockOrder !== false;
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
        if (restoreByTextblockOrder && this.jumpToTextblockOrder(textblockOrder)) {
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
                    const taskHeadingLevel = clampNumber(Number(node.attrs?.headingLevel || 0), 0, 6);
                    const nextMatches = buildTextSearchMatchesForNode(
                        firstTextblock.node,
                        firstTextblock.pos,
                        normalizedQuery,
                        {
                            kind: taskHeadingLevel > 0 ? 'heading' : 'task',
                            kindIndex: taskIndex,
                            kindLabel: taskHeadingLevel > 0 ? '标题' : '待办',
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
            const headingLevel = currentBlock.node?.type?.name === 'heading'
                ? clampNumber(Number(currentBlock.node.attrs?.level || 0), 0, 6)
                : 0;
            const didToggle = this.editor.chain().focus(undefined, {
                scrollIntoView: false
            }).toggleTaskList().run();
            if (didToggle && headingLevel > 0) {
                this.setTaskItemHeadingLevel(headingLevel);
            }
            return didToggle;
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
                const parsedHeading = parseAnyHeadingMarkdownLine(currentLine);
                const displayText = parsedHeading
                    ? `${'#'.repeat(parsedHeading.level)} ${entry.text}`.trim()
                    : entry.text;
                const nextLine = allSelectedAreTasks
                    ? stripTodoLineToParagraph(currentLine, entry.text)
                    : createTodoLineFromText(displayText, false);

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
                    textblockOrder: this.getCurrentTextblockOrder(),
                    restoreByTextblockOrder: false
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
            textblockOrder: this.getCurrentTextblockOrder(),
            restoreByTextblockOrder: false
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

    normalizeTaskHeadingNodesFromText() {
        if (!this.editor || this.isApplyingTaskHeadingNormalization) {
            return false;
        }

        const updates = [];
        this.editor.state.doc.descendants((node, pos) => {
            if (node?.type?.name !== 'taskItem') {
                return true;
            }

            let firstTextblock = null;
            let firstTextblockPos = null;
            node.forEach((child, offset) => {
                if (firstTextblock || !child?.isTextblock) return;
                firstTextblock = child;
                firstTextblockPos = pos + 1 + offset;
            });

            if (!firstTextblock || typeof firstTextblockPos !== 'number') {
                return true;
            }

            const parsedHeading = parseTaskHeadingText(firstTextblock.textContent || '');
            if (!parsedHeading) {
                return true;
            }

            updates.push({
                taskPos: pos,
                taskNode: node,
                textblockPos: firstTextblockPos,
                textContentSize: firstTextblock.content.size,
                headingLevel: parsedHeading.level,
                nextText: parsedHeading.text
            });
            return true;
        });

        if (!updates.length) {
            return false;
        }

        this.isApplyingTaskHeadingNormalization = true;
        try {
            let tr = this.editor.state.tr;
            updates.sort((a, b) => b.taskPos - a.taskPos).forEach((entry) => {
                tr = tr.setNodeMarkup(entry.taskPos, undefined, {
                    ...entry.taskNode.attrs,
                    headingLevel: entry.headingLevel
                });
                const textFrom = entry.textblockPos + 1;
                const textTo = textFrom + entry.textContentSize;
                tr = tr.insertText(entry.nextText, textFrom, textTo);
            });
            this.editor.view.dispatch(tr);
            return true;
        } finally {
            this.isApplyingTaskHeadingNormalization = false;
        }
    }

    collectTaskHeadingLevels() {
        const levels = [];
        this.editor.state.doc.descendants((node) => {
            if (node?.type?.name === 'taskItem') {
                levels.push(clampNumber(Number(node.attrs?.headingLevel || 0), 0, 6));
            }
            return true;
        });
        return levels;
    }

    syncMarkdown() {
        this.currentMarkdown = applyTaskHeadingLevelsToMarkdown(
            normalizeMarkdown(this.editor.getMarkdown()),
            this.collectTaskHeadingLevels()
        );
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

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
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

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
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

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
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

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
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

    normalizeVideoNodes() {
        let tr = this.editor.state.tr.setMeta('addToHistory', false);
        let didChange = false;

        const linkMark = this.editor.state.schema.marks.link;
        if (linkMark) {
            const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
            for (let index = ranges.length - 1; index >= 0; index--) {
                const range = ranges[index];
                const href = String(range.attrs?.href || '').trim();
                const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
                if (!normalizedRelativeHref.startsWith('attachments/') || !isVideoAttachmentHref(normalizedRelativeHref)) {
                    continue;
                }

                const label = getAttachmentDisplayLabel(normalizedRelativeHref, range.text || '');
                const identity = parseAttachmentIdentityFromTitle(range.attrs?.title || null);
                const title = stripAttachmentIdentityFromTitle(range.attrs?.title || null);
                tr = tr.replaceRangeWith(range.from, range.to, this.editor.state.schema.nodes.kangarooAttachment.create({
                    href: normalizedRelativeHref,
                    label,
                    title,
                    identity
                }));
                didChange = true;
            }
        }

        const videoAttachmentNodes = [];
        this.editor.state.doc.descendants((node, pos) => {
            if (node?.type?.name !== 'kangarooVideo') {
                return true;
            }

            const href = String(node.attrs?.href || '').trim();
            const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (!normalizedRelativeHref.startsWith('attachments/') || !isVideoAttachmentHref(normalizedRelativeHref)) {
                return true;
            }

            videoAttachmentNodes.push({
                pos,
                node,
                href: normalizedRelativeHref
            });
            return true;
        });

        for (let index = videoAttachmentNodes.length - 1; index >= 0; index--) {
            const entry = videoAttachmentNodes[index];
            tr = tr.replaceRangeWith(
                entry.pos,
                entry.pos + entry.node.nodeSize,
                this.editor.state.schema.nodes.kangarooAttachment.create({
                    href: entry.href,
                    label: getAttachmentDisplayLabel(entry.href, entry.node.attrs?.label || ''),
                    title: entry.node.attrs?.title || null,
                    identity: entry.node.attrs?.identity || parseAttachmentIdentityFromTitle(entry.node.attrs?.title || null)
                })
            );
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    normalizePdfNodes() {
        let tr = this.editor.state.tr.setMeta('addToHistory', false);
        let didChange = false;
        const pdfWidthEntries = collectPdfWidthMetadata(this.currentMarkdown);
        const resolveStoredPdfWidth = (href, title, identity, fallback = 560) => {
            const parsedWidth = parsePdfWidthFromTitle(title || null, null);
            if (parsedWidth != null) {
                return parsedWidth;
            }

            const normalizedHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            const normalizedIdentity = String(identity || '').trim() || null;
            const match = pdfWidthEntries.find((entry) => {
                if (!entry || entry.width == null) return false;
                if (normalizedIdentity && entry.identity && entry.identity === normalizedIdentity) {
                    return true;
                }
                return entry.href === normalizedHref;
            });

            return match?.width != null ? clampPdfPreviewWidth(match.width) : fallback;
        };

        const linkMark = this.editor.state.schema.marks.link;
        if (linkMark) {
            const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
            for (let index = ranges.length - 1; index >= 0; index--) {
                const range = ranges[index];
                const href = String(range.attrs?.href || '').trim();
                const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
                if (!normalizedRelativeHref.startsWith('attachments/') || !isPdfAttachmentHref(normalizedRelativeHref)) {
                    continue;
                }

                const label = getAttachmentDisplayLabel(normalizedRelativeHref, range.text || '');
                const identity = parseAttachmentIdentityFromTitle(range.attrs?.title || null);
                const width = resolveStoredPdfWidth(normalizedRelativeHref, range.attrs?.title || null, identity, 560);
                const title = stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(range.attrs?.title || null));
                tr = tr.replaceRangeWith(range.from, range.to, this.editor.state.schema.nodes.kangarooPdf.create({
                    href: normalizedRelativeHref,
                    label,
                    title,
                    identity,
                    width
                }));
                didChange = true;
            }
        }

        const pdfAttachmentNodes = [];
        this.editor.state.doc.descendants((node, pos) => {
            if (node?.type?.name !== 'kangarooAttachment') {
                return true;
            }

            const href = String(node.attrs?.href || '').trim();
            const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (!normalizedRelativeHref.startsWith('attachments/') || !isPdfAttachmentHref(normalizedRelativeHref)) {
                return true;
            }

            pdfAttachmentNodes.push({
                pos,
                node,
                href: normalizedRelativeHref
            });
            return true;
        });

        for (let index = pdfAttachmentNodes.length - 1; index >= 0; index--) {
            const entry = pdfAttachmentNodes[index];
            tr = tr.replaceRangeWith(
                entry.pos,
                entry.pos + entry.node.nodeSize,
                this.editor.state.schema.nodes.kangarooPdf.create({
                    href: entry.href,
                    label: getAttachmentDisplayLabel(entry.href, entry.node.attrs?.label || ''),
                    title: stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(entry.node.attrs?.title || null)),
                    identity: entry.node.attrs?.identity || parseAttachmentIdentityFromTitle(entry.node.attrs?.title || null),
                    width: resolveStoredPdfWidth(
                        entry.href,
                        entry.node.attrs?.title || null,
                        entry.node.attrs?.identity || parseAttachmentIdentityFromTitle(entry.node.attrs?.title || null),
                        560
                    )
                })
            );
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    normalizeAttachmentNodes() {
        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) return false;

        const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
        if (!ranges.length) return false;

        let tr = this.editor.state.tr.setMeta('addToHistory', false);
        let didChange = false;

        for (let index = ranges.length - 1; index >= 0; index--) {
            const range = ranges[index];
            const href = String(range.attrs?.href || '').trim();
            const normalizedRelativeHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (!normalizedRelativeHref.startsWith('attachments/') || isPdfAttachmentHref(normalizedRelativeHref)) {
                continue;
            }

            const label = getAttachmentDisplayLabel(normalizedRelativeHref, range.text || '');
            tr = tr.replaceRangeWith(range.from, range.to, this.editor.state.schema.nodes.kangarooAttachment.create({
                href: normalizedRelativeHref,
                label,
                title: stripAttachmentIdentityFromTitle(range.attrs?.title || null),
                identity: parseAttachmentIdentityFromTitle(range.attrs?.title || null)
            }));
            didChange = true;
        }

        if (!didChange) return false;

        this.editor.view.dispatch(tr);
        return true;
    }

    findAttachmentRelativePathByIdentity(identity) {
        if (!this.bundlePath || !identity) {
            return '';
        }

        const attachmentsDir = path.join(this.bundlePath, 'attachments');
        if (!fs.existsSync(attachmentsDir)) {
            return '';
        }

        const stack = [attachmentsDir];
        while (stack.length) {
            const currentDir = stack.pop();
            let entryNames = [];

            try {
                entryNames = fs.readdirSync(currentDir);
            } catch {
                entryNames = [];
            }

            for (const entryName of entryNames) {
                const absolutePath = path.join(currentDir, entryName);
                let stat = null;
                try {
                    stat = fs.statSync(absolutePath);
                } catch {
                    stat = null;
                }

                if (!stat) continue;

                if (getAttachmentIdentityFromPath(absolutePath) === identity) {
                    return normalizeLinkHref(path.relative(this.bundlePath, absolutePath));
                }

                if (stat.isDirectory()) {
                    stack.push(absolutePath);
                }
            }
        }

        return '';
    }

    repairAttachmentReferencesByIdentity() {
        let tr = this.editor.state.tr.setMeta('addToHistory', false);
        let didChange = false;

        const buildTitle = (title, identity, width = null) => {
            let nextTitle = mergeAttachmentIdentityIntoTitle(title, identity);
            if (width != null) {
                nextTitle = mergePdfWidthIntoTitle(nextTitle, width);
            }
            return nextTitle;
        };

        const getAttachmentMeta = (href, title, identityAttr = null, width = null) => {
            const normalizedHref = normalizeLinkHref(href).replace(/^\.?\//, '');
            if (!normalizedHref.startsWith('attachments/')) {
                return null;
            }

            const absolutePath = this.resolveAttachmentAbsolutePath(normalizedHref);
            const effectiveIdentity = identityAttr || parseAttachmentIdentityFromTitle(title) || (absolutePath ? getAttachmentIdentityFromPath(absolutePath) : null);
            let repairedHref = normalizedHref;

            if (!absolutePath || !fs.existsSync(absolutePath)) {
                repairedHref = this.findAttachmentRelativePathByIdentity(effectiveIdentity).replace(/^\.?\//, '');
                if (!repairedHref) {
                    return null;
                }
            }

            const repairedAbsolutePath = this.resolveAttachmentAbsolutePath(repairedHref);
            const repairedIdentity = effectiveIdentity || (repairedAbsolutePath ? getAttachmentIdentityFromPath(repairedAbsolutePath) : null);
            const cleanedTitle = stripAttachmentIdentityFromTitle(stripPdfWidthFromTitle(title || null));
            const nextTitle = buildTitle(cleanedTitle, repairedIdentity, width);
            const nextLabel = safeDecodeUri(path.basename(repairedHref)) || decodeLinkLabelFromHref(repairedHref);

            return {
                href: repairedHref,
                label: nextLabel,
                title: nextTitle,
                identity: repairedIdentity,
                width
            };
        };

        const linkMark = this.editor.state.schema.marks.link;
        if (linkMark) {
            const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
            for (let index = ranges.length - 1; index >= 0; index--) {
                const range = ranges[index];
                const meta = getAttachmentMeta(range.attrs?.href || '', range.attrs?.title || null, null, null);
                if (!meta) continue;

                if (meta.href !== String(range.attrs?.href || '').trim() || meta.title !== (range.attrs?.title || null)) {
                    tr = tr.removeMark(range.from, range.to, linkMark);
                    tr = tr.addMark(
                        range.from,
                        range.to,
                        linkMark.create({
                            ...range.attrs,
                            href: meta.href,
                            title: meta.title
                        })
                    );
                    didChange = true;
                }
            }
        }

        this.editor.state.doc.descendants((node, pos) => {
            const typeName = node?.type?.name;
            if (!['kangarooAttachment', 'kangarooVideo', 'kangarooPdf'].includes(typeName)) {
                return true;
            }

            const width = typeName === 'kangarooPdf' ? clampPdfPreviewWidth(node.attrs?.width) : null;
            const meta = getAttachmentMeta(node.attrs?.href || '', node.attrs?.title || null, node.attrs?.identity || null, width);
            if (!meta) {
                return true;
            }

            const nextAttrs = {
                ...node.attrs,
                href: meta.href,
                label: meta.label,
                title: meta.title,
                identity: meta.identity
            };

            if (typeName === 'kangarooPdf') {
                nextAttrs.width = width;
            }

            const hasChanged = Object.keys(nextAttrs).some((key) => nextAttrs[key] !== node.attrs?.[key]);
            if (hasChanged) {
                tr = tr.setNodeMarkup(pos, undefined, nextAttrs);
                didChange = true;
            }

            return true;
        });

        if (!didChange) {
            return false;
        }

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
        const decodedSrc = normalizeLinkHref(src);

        if (/^(data:|https?:|file:)/i.test(decodedSrc)) {
            return decodedSrc;
        }

        if (path.isAbsolute(decodedSrc)) {
            return decodedSrc;
        }

        if (!this.bundlePath) {
            return decodedSrc;
        }

        return pathToFileURL(path.join(this.bundlePath, decodedSrc)).href;
    }

    resolveLinkDisplayMeta(href) {
        return getLinkDisplayMeta(href, this.bundlePath);
    }

    refreshImages() {
        this.editor.view.dispatch(this.editor.state.tr);
    }

    refreshVideos() {
        this.editor.view.dispatch(this.editor.state.tr);
    }

    refreshPdfs() {}

    refreshAttachmentNodeLabels() {
        if (!this.root) return;

        const refreshNode = (selector, labelSelector) => {
            const elements = Array.from(this.root.querySelectorAll(selector));
            for (const element of elements) {
                const href = String(element.getAttribute('data-href') || '').trim();
                if (!href) continue;
                const nextLabel = getAttachmentDisplayLabel(href, element.getAttribute('data-label') || '');
                element.setAttribute('data-label', nextLabel);
                const labelElement = element.querySelector(labelSelector);
                if (labelElement) {
                    labelElement.textContent = nextLabel;
                }
                const mediaElement = element.querySelector('[data-kangaroo-pdf-element], [data-kangaroo-video-element]');
                if (mediaElement) {
                    mediaElement.setAttribute('alt', nextLabel);
                }
            }
        };

        refreshNode('[data-kangaroo-attachment]', '.kangaroo-attachment-label');
        refreshNode('[data-kangaroo-video]', '.kangaroo-video-label');
        refreshNode('[data-kangaroo-pdf]', '.kangaroo-pdf-label');
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
                    'kangaroo-link-attachment-pdf',
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
            this.refreshAttachmentNodeLabels();
        };

        window.requestAnimationFrame(apply);
    }

    refreshRangeSelectionHighlights() {
        const rootElement = this.root?.querySelector?.('.ProseMirror') || this.root;
        if (!rootElement) return;

        for (const element of Array.from(rootElement.querySelectorAll('.is-range-selected'))) {
            element.classList.remove('is-range-selected');
        }

        const { selection } = this.editor.state;
        if (!selection || selection.empty) {
            return;
        }

        if (selection.node?.type?.name === 'image' || selection.node?.type?.name === 'kangarooAttachment' || selection.node?.type?.name === 'kangarooVideo' || selection.node?.type?.name === 'kangarooPdf') {
            return;
        }

        const from = Math.min(selection.from, selection.to);
        const to = Math.max(selection.from, selection.to);

        const linkMark = this.editor.state.schema.marks.link;
        if (linkMark) {
            const ranges = collectLinkMarkRanges(this.editor.state.doc, linkMark);
            for (const range of ranges) {
                if (range.to <= from || range.from >= to) continue;
                const anchor = this.findLinkElementAtPosition(range.from);
                if (anchor) {
                    anchor.classList.add('is-range-selected');
                }
            }
        }

        this.editor.state.doc.nodesBetween(from, to, (node, pos) => {
            if (node?.type?.name !== 'kangarooAttachment' && node?.type?.name !== 'kangarooVideo' && node?.type?.name !== 'kangarooPdf') {
                return true;
            }

            const domNode = this.editor.view.nodeDOM(pos);
            if (domNode?.classList) {
                domNode.classList.add('is-range-selected');
            }
            return true;
        });

        const browserSelection = window.getSelection?.();
        const selectionRects = [];
        if (browserSelection && browserSelection.rangeCount > 0) {
            for (let index = 0; index < browserSelection.rangeCount; index++) {
                const range = browserSelection.getRangeAt(index);
                selectionRects.push(...Array.from(range.getClientRects()));
                const bounds = range.getBoundingClientRect();
                if (bounds && bounds.width >= 0 && bounds.height >= 0) {
                    selectionRects.push(bounds);
                }
            }
        }

        for (const container of Array.from(rootElement.querySelectorAll('[data-resize-container][data-node="image"]'))) {
            const imageRect = container.getBoundingClientRect();
            const imageParagraph = container.parentElement?.classList?.contains('ProseMirror')
                ? null
                : container.parentElement;
            const intersectsEditorSelection = intersectsEditorSelectionWithDomNode(this.editor.view, container, from, to, 1)
                || (imageParagraph
                    ? intersectsEditorSelectionWithDomNode(this.editor.view, imageParagraph, from, to, 1)
                    : false);
            const intersectsSelection = selectionRects.some((rect) => rectsOverlapWithTolerance(rect, imageRect, 6));
            const intersectsBrowserRange = browserSelection && browserSelection.rangeCount > 0
                ? Array.from({ length: browserSelection.rangeCount }).some((_, index) => {
                    try {
                        const range = browserSelection.getRangeAt(index);
                        return range.intersectsNode(container)
                            || (imageParagraph ? range.intersectsNode(imageParagraph) : false)
                            || rangeContainsOrTouchesNode(range, container);
                    } catch {
                        return false;
                    }
                })
                : false;
            if (intersectsEditorSelection || intersectsSelection || intersectsBrowserRange) {
                container.classList.add('is-range-selected');
            }
        }
    }

    getCurrentTextblockElement() {
        const pos = this.editor?.state?.selection?.from;
        if (typeof pos !== 'number') return null;

        try {
            const domAtPos = this.editor.view.domAtPos(pos);
            let element = domAtPos.node?.nodeType === Node.ELEMENT_NODE
                ? domAtPos.node
                : domAtPos.node?.parentElement;

            while (element && element !== this.root) {
                if (element.parentElement?.classList?.contains('ProseMirror')) {
                    return element;
                }
                element = element.parentElement;
            }
        } catch {
            return null;
        }

        return null;
    }

    getCurrentDomTextblockElement() {
        const browserSelection = window.getSelection?.();
        const anchorNode = browserSelection?.anchorNode;
        if (!anchorNode) return null;

        let element = anchorNode.nodeType === Node.ELEMENT_NODE
            ? anchorNode
            : anchorNode.parentElement;

        while (element && element !== this.root) {
            if (element.parentElement?.classList?.contains('ProseMirror')) {
                return element;
            }
            element = element.parentElement;
        }

        return null;
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

    getAttachmentInfoAtPoint(clientX, clientY) {
        const elementAtPoint = typeof document !== 'undefined'
            ? document.elementFromPoint(clientX, clientY)
            : null;
        const attachmentElement = elementAtPoint?.closest?.('[data-kangaroo-attachment]') || null;
        if (attachmentElement) {
            return this.getAttachmentInfoFromElement(attachmentElement);
        }

        const position = this.editor.view.posAtCoords({ left: clientX, top: clientY });
        if (!position || typeof position.pos !== 'number') {
            return null;
        }

        return this.getAttachmentInfoAtPos(position.pos);
    }

    getAttachmentInfoFromElement(element) {
        const nodeView = element?.__kangarooAttachmentNodeView || null;
        if (nodeView?.getInfo) {
            return {
                ...nodeView.getInfo(),
                element: nodeView.getDom?.() || element
            };
        }

        const href = String(element?.getAttribute?.('data-href') || '').trim();
        if (!href) return null;

        const label = String(element?.getAttribute?.('data-label') || element?.textContent || '').trim();
        const displayMeta = this.resolveLinkDisplayMeta(href);

        return {
            pos: null,
            node: null,
            href,
            text: label,
            displayMeta,
            element
        };
    }

    getAttachmentInfoAtPos(pos) {
        if (typeof pos !== 'number') {
            return null;
        }

        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const positions = [
            clampNumber(pos, 1, maxPos),
            clampNumber(pos - 1, 1, maxPos),
            clampNumber(pos + 1, 1, maxPos)
        ];

        for (const candidate of positions) {
            const resolvedPos = this.editor.state.doc.resolve(candidate);
            const candidatesToCheck = [
                { node: resolvedPos.nodeAfter, pos: candidate },
                {
                    node: resolvedPos.nodeBefore,
                    pos: resolvedPos.nodeBefore ? candidate - resolvedPos.nodeBefore.nodeSize : null
                }
            ];

            for (const candidateInfo of candidatesToCheck) {
                const node = candidateInfo.node;
                const nodePos = candidateInfo.pos;
                if (node?.type?.name !== 'kangarooAttachment' || typeof nodePos !== 'number') {
                    continue;
                }

                const href = String(node.attrs?.href || '').trim();
                return {
                    pos: nodePos,
                    node,
                    href,
                    text: String(node.attrs?.label || '').trim() || decodeLinkLabelFromHref(href),
                    displayMeta: this.resolveLinkDisplayMeta(href)
                };
            }
        }

        return null;
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

    selectLink(info, options = {}) {
        if (!info?.href) {
            this.clearSelectedLink();
            return false;
        }

        const { preserveSelection = false } = options;
        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.selectedLinkInfo = info;
        if (!preserveSelection) {
            this.editor.chain().focus().setTextSelection({ from: info.from, to: info.to }).run();
        }
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

    selectAttachment(info) {
        if (!info?.href) {
            return false;
        }

        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();

        const nodeView = info?.nodeView
            || info?.element?.__kangarooAttachmentNodeView
            || this.getAttachmentInfoAtPoint(
                (info.element?.getBoundingClientRect?.().left || 0) + 4,
                (info.element?.getBoundingClientRect?.().top || 0) + 4
            )?.nodeView;

        if (!nodeView) {
            return false;
        }

        this.selectAttachmentNode(nodeView);
        this.editor.commands.focus(undefined, {
            scrollIntoView: false
        });

        return true;
    }

    selectAttachmentNode(nodeView) {
        if (this.selectedAttachmentNodeView === nodeView) {
            return;
        }

        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedLink();

        const pos = typeof nodeView?.getPos === 'function'
            ? nodeView.getPos()
            : null;
        if (typeof pos === 'number') {
            this.editor.chain().setNodeSelection(pos).focus(undefined, {
                scrollIntoView: false
            }).run();
        }

        if (this.selectedAttachmentNodeView?.deselect) {
            this.selectedAttachmentNodeView.deselect();
        }

        this.selectedAttachmentNodeView = nodeView;
        this.selectedAttachmentNodeView?.select?.();
    }

    clearSelectedAttachmentNode() {
        if (this.selectedAttachmentNodeView?.deselect) {
            this.selectedAttachmentNodeView.deselect();
        }

        this.selectedAttachmentNodeView = null;
    }

    clearCustomSelections() {
        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();
    }

    placeCaretFromPoint(clientX, clientY) {
        const location = this.editor.view.posAtCoords({
            left: clientX,
            top: clientY
        });
        if (!location || typeof location.pos !== 'number') {
            return false;
        }

        this.clearCustomSelections();
        this.editor.chain().focus(undefined, {
            scrollIntoView: false
        }).setTextSelection(location.pos).run();
        clearBrowserSelection();
        return true;
    }

    deleteSelectedAttachmentNode() {
        const selected = this.selectedAttachmentNodeView;
        if (!selected) {
            return false;
        }

        const pos = selected.getPos?.();
        const node = selected.getNode?.();
        if (typeof pos !== 'number' || !node?.nodeSize) {
            this.clearSelectedAttachmentNode();
            return false;
        }

        this.deleteInteractionHandlers?.onBeforeDelete?.({
            type: 'attachment',
            info: selected.getInfo?.() || null
        });
        const tr = this.editor.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedAttachmentNode();
        this.focus();
        return true;
    }

    deleteSelectedPdfNode() {
        const selected = this.selectedPdfNodeView;
        if (!selected) {
            return false;
        }

        const pos = selected.getPos?.();
        const node = selected.getNode?.();
        if (typeof pos !== 'number' || !node?.nodeSize) {
            this.clearSelectedPdfNode();
            return false;
        }

        this.deleteInteractionHandlers?.onBeforeDelete?.({
            type: 'pdf',
            info: selected.getInfo?.() || null
        });
        const tr = this.editor.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedPdfNode();
        this.focus();
        return true;
    }

    deleteSelectedVideoNode() {
        const selected = this.selectedVideoNodeView;
        if (!selected) {
            return false;
        }

        const pos = selected.getPos?.();
        const node = selected.getNode?.();
        if (typeof pos !== 'number' || !node?.nodeSize) {
            this.clearSelectedVideoNode();
            return false;
        }

        this.deleteInteractionHandlers?.onBeforeDelete?.({
            type: 'video',
            info: selected.getInfo?.() || null
        });
        const tr = this.editor.state.tr.delete(pos, pos + node.nodeSize).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedVideoNode();
        this.focus();
        return true;
    }

    getSelectedLinkInfo() {
        return this.selectedLinkInfo ? { ...this.selectedLinkInfo } : null;
    }

    deleteSelectedLink() {
        if (this.deleteSelectedAttachmentNode()) {
            return true;
        }

        if (this.deleteSelectedPdfNode()) {
            return true;
        }

        if (this.deleteSelectedVideoNode()) {
            return true;
        }

        const selected = this.selectedLinkInfo;
        if (!selected) return false;

        this.deleteInteractionHandlers?.onBeforeDelete?.({
            type: 'link',
            info: selected
        });
        const tr = this.editor.state.tr.delete(selected.from, selected.to).scrollIntoView();
        this.editor.view.dispatch(tr);
        this.clearSelectedLink();
        this.focus();
        return true;
    }

    restoreDeletedAssetSnapshot(snapshot) {
        if (!snapshot?.nodeJSON || !this.editor?.state?.doc) {
            return false;
        }

        try {
            const node = this.editor.schema.nodeFromJSON(snapshot.nodeJSON);
            const maxPos = this.editor.state.doc.content.size;
            const insertPos = Math.max(0, Math.min(Number(snapshot.pos) || 0, maxPos));
            const tr = this.editor.state.tr.insert(insertPos, node).scrollIntoView();
            this.editor.view.dispatch(tr);
            this.focus();
            return true;
        } catch {
            return false;
        }
    }

    selectImageNode(nodeView) {
        if (this.selectedImageNodeView === nodeView) {
            return;
        }

        this.clearSelectedPdfNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
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

    selectPdfNode(nodeView) {
        if (this.selectedPdfNodeView === nodeView) {
            return;
        }

        this.clearSelectedImageNode();
        this.clearSelectedVideoNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();

        const pos = typeof nodeView?.getPos === 'function'
            ? nodeView.getPos()
            : null;
        if (typeof pos === 'number') {
            this.editor.chain().setNodeSelection(pos).focus(undefined, {
                scrollIntoView: false
            }).run();
        }

        if (this.selectedPdfNodeView?.deselect) {
            this.selectedPdfNodeView.deselect();
        }

        this.selectedPdfNodeView = nodeView;
        this.selectedPdfNodeView?.select?.();
    }

    clearSelectedPdfNode() {
        if (this.selectedPdfNodeView?.deselect) {
            this.selectedPdfNodeView.deselect();
        }

        this.selectedPdfNodeView = null;
    }

    selectVideoNode(nodeView) {
        if (this.selectedVideoNodeView === nodeView) {
            return;
        }

        this.clearSelectedImageNode();
        this.clearSelectedPdfNode();
        this.clearSelectedAttachmentNode();
        this.clearSelectedLink();

        const pos = typeof nodeView?.getPos === 'function'
            ? nodeView.getPos()
            : null;
        if (typeof pos === 'number') {
            this.editor.chain().setNodeSelection(pos).focus(undefined, {
                scrollIntoView: false
            }).run();
        }

        if (this.selectedVideoNodeView?.deselect) {
            this.selectedVideoNodeView.deselect();
        }

        this.selectedVideoNodeView = nodeView;
        this.selectedVideoNodeView?.select?.();
    }

    clearSelectedVideoNode() {
        if (this.selectedVideoNodeView?.deselect) {
            this.selectedVideoNodeView.deselect();
        }

        this.selectedVideoNodeView = null;
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
        const decodedSrc = normalizeLinkHref(src);

        if (/^file:/i.test(decodedSrc)) {
            try {
                return fileURLToPath(decodedSrc);
            } catch {
                return null;
            }
        }

        if (/^(data:|https?:)/i.test(decodedSrc)) {
            return null;
        }

        if (path.isAbsolute(decodedSrc)) {
            return decodedSrc;
        }

        if (!this.bundlePath) {
            return null;
        }

        return path.join(this.bundlePath, decodedSrc);
    }

    resolveAttachmentAbsolutePath(href) {
        if (!href) return null;

        const decodedHref = normalizeLinkHref(href);
        if (!decodedHref || !decodedHref.replace(/^\.?\//, '').startsWith('attachments/')) {
            return null;
        }

        if (!this.bundlePath) {
            return null;
        }

        return path.join(this.bundlePath, decodedHref);
    }

    getVideoInfoFromNodeView(nodeView) {
        if (!nodeView) return null;

        const href = String(nodeView.getHref?.() || '');
        const videoPath = this.resolveAttachmentAbsolutePath(href);

        return {
            nodeView,
            href,
            videoPath,
            node: nodeView.getNode?.() || null,
            pos: typeof nodeView.getPos?.() === 'function' ? nodeView.getPos() : null,
            element: nodeView.getDom?.() || null,
            videoElement: nodeView.getVideoElement?.() || null,
            text: String(nodeView.getLabel?.() || '').trim() || decodeLinkLabelFromHref(href),
            displayMeta: this.resolveLinkDisplayMeta(href)
        };
    }

    getVideoInfoAtPoint(clientX, clientY) {
        if (typeof document === 'undefined') return null;

        const elementAtPoint = document.elementFromPoint(clientX, clientY);
        const container = elementAtPoint?.closest?.('[data-kangaroo-video]') || null;
        const nodeView = container?.__kangarooVideoNodeView || null;
        if (!nodeView) {
            return null;
        }

        return this.getVideoInfoFromNodeView(nodeView);
    }

    getPdfInfoFromNodeView(nodeView) {
        if (!nodeView) return null;

        const href = String(nodeView.getHref?.() || '');
        const pdfPath = this.resolveAttachmentAbsolutePath(href);

        return {
            nodeView,
            href,
            pdfPath,
            node: nodeView.getNode?.() || null,
            pos: typeof nodeView.getPos?.() === 'function' ? nodeView.getPos() : null,
            element: nodeView.getDom?.() || null,
            frameElement: nodeView.getFrameElement?.() || null,
            text: String(nodeView.getLabel?.() || '').trim() || decodeLinkLabelFromHref(href),
            displayMeta: this.resolveLinkDisplayMeta(href)
        };
    }

    getPdfInfoAtPoint(clientX, clientY) {
        if (typeof document === 'undefined') return null;

        const elementAtPoint = document.elementFromPoint(clientX, clientY);
        const container = elementAtPoint?.closest?.('[data-kangaroo-pdf]') || null;
        const nodeView = container?.__kangarooPdfNodeView || null;
        if (!nodeView) {
            return null;
        }

        return this.getPdfInfoFromNodeView(nodeView);
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

class SimpleTiptapKangarooEditor {
    constructor(container, initialMarkdown = '') {
        this.container = container;
        this.listeners = new Set();
        this.currentMarkdown = normalizeMarkdown(initialMarkdown);
        this.bundlePath = null;
        this.attachmentInteractionHandlers = { onOpen: null, onContextMenu: null };
        this.imageInteractionHandlers = { onSelect: null, onOpen: null, onContextMenu: null };
        this.linkInteractionHandlers = { onOpen: null, onContextMenu: null };

        container.innerHTML = '';

        this.host = document.createElement('div');
        this.host.className = 'wysiwyg-editor-host simple-tiptap-editor-host';

        this.root = document.createElement('div');
        this.root.className = 'wysiwyg-editor-root simple-tiptap-editor-root';
        this.host.appendChild(this.root);
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
                Link.configure({
                    openOnClick: false,
                    autolink: true,
                    linkOnPaste: true,
                    protocols: ['http', 'https', 'file', 'mailto', 'zotero']
                }),
                KangarooImage.configure({
                    resolveSrc: (src) => this.resolveDisplaySource(src),
                    resize: {
                        enabled: false
                    }
                }),
                TaskList,
                TaskItem.configure({
                    nested: true
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
                    class: 'kangaroo-prosemirror simple-tiptap-prosemirror'
                }
            },
            onCreate: () => {
                this.syncMarkdown();
            },
            onSelectionUpdate: () => {
                this.emitSelectionChange();
            },
            onUpdate: () => {
                this.syncMarkdown();
                this.emitChange();
            }
        });
    }

    destroy() {
        this.editor.destroy();
    }

    syncMarkdown() {
        this.currentMarkdown = normalizeMarkdown(this.editor.getMarkdown());
    }

    emitChange() {
        for (const listener of this.listeners) {
            try {
                listener();
            } catch {
                // no-op
            }
        }
    }

    emitSelectionChange() {
        for (const listener of this.listeners) {
            try {
                listener({ selectionOnly: true });
            } catch {
                // no-op
            }
        }
    }

    getRootElement() {
        return this.host;
    }

    onDidChangeModelContent(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    getValue() {
        return this.currentMarkdown;
    }

    getLiveMarkdownSnapshot() {
        try {
            return normalizeMarkdown(this.editor?.getMarkdown?.() || this.currentMarkdown);
        } catch {
            return this.currentMarkdown;
        }
    }

    getSelectionSnapshot() {
        const selection = this.editor?.state?.selection;
        if (!selection) return null;
        return {
            from: selection.from,
            to: selection.to
        };
    }

    restoreSelectionSnapshot(snapshot, options = {}) {
        if (!snapshot || !this.editor?.state?.doc) return false;
        const { scrollIntoView = false } = options;
        const maxPos = Math.max(this.editor.state.doc.content.size, 1);
        const from = clampNumber(snapshot.from, 1, maxPos);
        const to = clampNumber(snapshot.to, 1, maxPos);

        try {
            this.editor
                .chain()
                .focus(undefined, { scrollIntoView })
                .setTextSelection({ from, to })
                .run();
            return true;
        } catch {
            return false;
        }
    }

    setValue(markdown, options = {}) {
        this.currentMarkdown = normalizeMarkdown(markdown);
        clearBrowserSelection();
        this.editor.commands.setContent(this.currentMarkdown, {
            contentType: 'markdown',
            emitUpdate: false
        });
        resetEditorSelectionToDocumentStart(this.editor);
        this.syncMarkdown();
        if (options.emitChange) {
            this.emitChange();
        }
    }

    refreshDisplayState() {
        this.setValue(this.currentMarkdown, { emitChange: false });
    }

    refreshImages() {}
    refreshLinkDomState() {}
    refreshRangeSelectionHighlights() {}

    focus() {
        this.editor.commands.focus(undefined, { scrollIntoView: false });
    }

    setEditable(editable) {
        this.editor.setEditable(Boolean(editable));
        this.host.classList.toggle('is-readonly', !editable);
    }

    setBundlePath(bundlePath) {
        this.bundlePath = bundlePath ? path.resolve(String(bundlePath)) : null;
    }

    updateOptions(options = {}) {
        if (options.fontFamily) {
            this.host.style.setProperty('--wysiwyg-editor-font-family', options.fontFamily);
        }
        if (options.fontSize) {
            this.host.style.setProperty('--wysiwyg-editor-font-size', `${options.fontSize}px`);
        }
    }

    getModel() {
        return {
            getPositionAt: (offset) => getPositionAtOffset(this.currentMarkdown, offset)
        };
    }

    insertText(text) {
        if (!text) return;
        this.editor.chain().focus(undefined, { scrollIntoView: false }).insertContent(text).run();
    }

    insertMarkdown(markdown) {
        if (!markdown) return;
        this.editor.chain().focus(undefined, { scrollIntoView: false }).insertContent(markdown, { contentType: 'markdown' }).run();
    }

    insertHtml(html) {
        if (!html) return false;
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).insertContent(html).run();
    }

    insertSliceJson(sliceJson) {
        if (!sliceJson) return false;
        try {
            const slice = Slice.fromJSON(this.editor.state.schema, sliceJson);
            const tr = this.editor.state.tr.replaceSelection(slice);
            this.editor.view.dispatch(tr);
            this.focus();
            return true;
        } catch {
            return false;
        }
    }

    insertImage(src, options = {}) {
        const targetSrc = String(src || '').trim();
        if (!targetSrc) return false;
        const chain = this.editor.chain().focus(undefined, { scrollIntoView: false }).insertContent({
            type: 'paragraph',
            content: [{
                type: 'image',
                attrs: {
                    src: targetSrc,
                    alt: options.alt || 'image',
                    title: options.title || null
                }
            }]
        });
        if (options.insertTrailingParagraph) {
            chain.enter();
        }
        return chain.run();
    }

    insertLink(label, href, options = {}) {
        const displayLabel = String(label || '').trim();
        const targetHref = String(href || '').trim();
        if (!displayLabel || !targetHref) {
            return false;
        }

        const chain = this.editor.chain().focus(undefined, { scrollIntoView: false }).insertContent({
            type: 'text',
            text: displayLabel,
            marks: [{
                type: 'link',
                attrs: { href: targetHref, title: options.title || null }
            }]
        });

        if (options.insertTrailingParagraph) {
            chain.enter();
        }

        return chain.run();
    }

    insertAttachmentLink(relativePath, options = {}) {
        const normalizedRelativePath = normalizeLinkHref(relativePath);
        if (!normalizedRelativePath) return false;
        const label = String(options.label || '').trim() || decodeLinkLabelFromHref(normalizedRelativePath);
        return this.insertLink(label, normalizedRelativePath, options);
    }

    insertAbsolutePathLink(absolutePath, options = {}) {
        const normalizedPath = String(absolutePath || '').trim();
        if (!normalizedPath) return false;
        return this.insertLink(normalizedPath, pathToFileURL(normalizedPath).href, options);
    }

    toggleHeading(level) {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleHeading({ level: clampNumber(Number(level), 1, 6) }).run();
    }

    toggleBulletList() {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleBulletList().run();
    }

    toggleOrderedList() {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleOrderedList().run();
    }

    toggleTaskList() {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleTaskList().run();
    }

    toggleBold() {
        if (this.editor.state.selection.empty) return false;
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleBold().run();
    }

    toggleUnderline() {
        if (this.editor.state.selection.empty) return false;
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleUnderline().run();
    }

    toggleStrike() {
        if (this.editor.state.selection.empty) return false;
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).toggleStrike().run();
    }

    undo() {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).undo().run();
    }

    redo() {
        return this.editor.chain().focus(undefined, { scrollIntoView: false }).redo().run();
    }

    getToolbarState() {
        return {
            canUndo: this.editor.can().chain().focus(undefined, { scrollIntoView: false }).undo().run(),
            canRedo: this.editor.can().chain().focus(undefined, { scrollIntoView: false }).redo().run(),
            headingLevel: [1, 2, 3, 4, 5, 6].find((level) => this.editor.isActive('heading', { level })) || 0,
            bulletList: this.editor.isActive('bulletList'),
            orderedList: this.editor.isActive('orderedList'),
            taskList: this.editor.isActive('taskList'),
            bold: this.editor.isActive('bold'),
            underline: this.editor.isActive('underline'),
            strike: this.editor.isActive('strike')
        };
    }

    toggleTodoSelection() {
        return this.toggleTaskList();
    }

    getAnchorLineFromCursor() {
        const order = this.getCurrentTextblockOrder();
        return Number.isInteger(order) ? order + 1 : 1;
    }

    getAnchorLineFromViewport() {
        return this.getAnchorLineFromCursor();
    }

    getCurrentTextblockOrder() {
        const currentPos = this.editor.state.selection.from;
        let order = 0;
        let found = null;

        this.editor.state.doc.descendants((node, pos) => {
            if (!node?.isTextblock) {
                return true;
            }

            const from = pos + 1;
            const to = pos + Math.max(node.nodeSize - 1, 1);
            if (currentPos >= from && currentPos <= to) {
                found = order;
                return false;
            }

            order += 1;
            return true;
        });

        return found;
    }

    jumpToTextblockOrder(order) {
        if (!Number.isInteger(order) || order < 0) return false;

        let currentOrder = 0;
        let targetPos = null;
        this.editor.state.doc.descendants((node, pos) => {
            if (!node?.isTextblock) {
                return true;
            }

            if (currentOrder === order) {
                targetPos = pos + 1;
                return false;
            }

            currentOrder += 1;
            return true;
        });

        if (typeof targetPos !== 'number') {
            return false;
        }

        this.editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(targetPos).run();
        return true;
    }

    jumpToLine(lineNumber) {
        return this.jumpToTextblockOrder(Math.max(0, Number(lineNumber || 1) - 1));
    }

    jumpToAnchor(kind, kindIndex) {
        return this.jumpToLine(Number(kindIndex || 0) + 1);
    }

    highlightLine() {}

    getSearchMatches(query, limit = 200) {
        const normalizedQuery = String(query || '').trim().toLowerCase();
        if (!normalizedQuery) return [];

        const lines = this.currentMarkdown.split('\n');
        const matches = [];

        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            const normalizedLine = line.toLowerCase();
            const matchIndex = normalizedLine.indexOf(normalizedQuery);
            if (matchIndex === -1) continue;

            let kind = 'text';
            let kindLabel = '正文';
            const parsedHeading = parseAnyHeadingMarkdownLine(line);
            if (parsedHeading) {
                kind = 'heading';
                kindLabel = '标题';
            } else if (/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+/.test(line)) {
                kind = 'task';
                kindLabel = '待办';
            } else if (/attachments\//i.test(line)) {
                kind = 'attachment';
                kindLabel = '附件';
            }

            matches.push({
                kind,
                kindLabel,
                kindIndex: null,
                lineNumber: index + 1,
                text: parsedHeading ? parsedHeading.text : line.trim(),
                meta: '',
                snippet: buildSearchSnippet(line, matchIndex, matchIndex + normalizedQuery.length),
                from: null,
                to: null,
                pos: null
            });

            if (matches.length >= limit) break;
        }

        return matches;
    }

    jumpToSearchResult(result) {
        if (!result) return false;
        return this.jumpToLine(result.lineNumber || 1);
    }

    getTodoItems() {
        const todos = [];
        const lines = this.currentMarkdown.split('\n');
        let kindIndex = 0;
        for (let index = 0; index < lines.length; index++) {
            const match = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+\[([ xX])\]\s*(.*)$/);
            if (!match) continue;
            const parsedHeading = parseTaskHeadingText(match[4] || '');
            todos.push({
                lineNumber: index + 1,
                checked: String(match[3] || '').toLowerCase() === 'x',
                text: parsedHeading ? parsedHeading.text : String(match[4] || '').trim(),
                kindIndex: kindIndex++
            });
        }
        return todos;
    }

    setTaskCheckedByKindIndex(kindIndex, checked) {
        const targetIndex = Number(kindIndex);
        if (!Number.isInteger(targetIndex)) return false;

        const lines = this.currentMarkdown.split('\n');
        let currentIndex = 0;
        let changed = false;

        for (let index = 0; index < lines.length; index++) {
            const match = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+\[([ xX])\]\s*(.*)$/);
            if (!match) continue;

            if (currentIndex === targetIndex) {
                lines[index] = `${match[1]}${match[2]} [${checked ? 'x' : ' '}] ${match[4] || ''}`;
                changed = true;
                break;
            }

            currentIndex += 1;
        }

        if (!changed) return false;
        this.setValue(lines.join('\n'), { emitChange: true });
        return true;
    }

    getAttachmentReferences() {
        const references = [];
        const regex = /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?attachments\/(<[^>]+>|[^)\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\)/g;
        let match;
        while ((match = regex.exec(this.currentMarkdown)) !== null) {
            const relativePath = `attachments/${String(match[2] || '').replace(/^<|>$/g, '')}`;
            const absolutePath = this.bundlePath
                ? path.resolve(this.bundlePath, normalizeLinkHref(relativePath))
                : path.resolve(normalizeLinkHref(relativePath));
            let stat = null;
            try {
                stat = fs.existsSync(absolutePath) ? fs.statSync(absolutePath) : null;
            } catch {
                stat = null;
            }

            references.push({
                label: String(unescapeMarkdownLinkLabel(match[1] || '') || path.basename(String(match[2] || '').replace(/^<|>$/g, ''))).trim(),
                relativePath,
                absolutePath,
                lineNumber: getLineNumberAtOffset(this.currentMarkdown, match.index),
                exists: Boolean(stat),
                isDirectory: Boolean(stat && stat.isDirectory()),
                kindIndex: references.length
            });
        }
        return references;
    }

    setAttachmentInteractionHandlers(handlers = {}) {
        this.attachmentInteractionHandlers = handlers;
    }

    setImageInteractionHandlers(handlers = {}) {
        this.imageInteractionHandlers = handlers;
    }

    setLinkInteractionHandlers(handlers = {}) {
        this.linkInteractionHandlers = handlers;
    }

    beginPointerInteraction() {}
    trackPointerInteraction() {}
    endPointerInteraction() {}
    shouldSuppressClickSelection() { return false; }
    preventImageBackspaceFromTrailingEmptyLine() { return false; }

    resolveLinkDisplayMeta(href) {
        return getLinkDisplayMeta(href, this.bundlePath);
    }

    resolveDisplaySource(src) {
        if (!src) return src;
        const decodedSrc = normalizeLinkHref(src);
        if (/^(data:|https?:|file:)/i.test(decodedSrc)) {
            return decodedSrc;
        }
        if (path.isAbsolute(decodedSrc)) {
            return decodedSrc;
        }
        if (!this.bundlePath) {
            return decodedSrc;
        }
        return pathToFileURL(path.join(this.bundlePath, decodedSrc)).href;
    }

    resolveImagePath(src) {
        if (!src) return null;
        const decodedSrc = normalizeLinkHref(src);
        if (/^file:/i.test(decodedSrc)) {
            try {
                return fileURLToPath(decodedSrc);
            } catch {
                return null;
            }
        }
        if (/^(data:|https?:)/i.test(decodedSrc)) {
            return null;
        }
        if (path.isAbsolute(decodedSrc)) {
            return decodedSrc;
        }
        if (!this.bundlePath) {
            return null;
        }
        return path.join(this.bundlePath, decodedSrc);
    }

    resolveAttachmentAbsolutePath(href) {
        if (!href || !this.bundlePath) return null;
        const decodedHref = normalizeLinkHref(href);
        if (!decodedHref.replace(/^\.?\//, '').startsWith('attachments/')) return null;
        return path.join(this.bundlePath, decodedHref);
    }

    getSelectedLinkInfo() {
        return null;
    }

    deleteSelectedLink() {
        const { selection } = this.editor.state;
        if (!selection.empty) {
            const tr = this.editor.state.tr.delete(selection.from, selection.to);
            this.editor.view.dispatch(tr);
            return true;
        }

        const linkMark = this.editor.state.schema.marks.link;
        if (!linkMark) return false;
        const range = getMarkRange(this.editor.state.doc.resolve(selection.from), linkMark);
        if (!range) return false;
        const tr = this.editor.state.tr.delete(range.from, range.to);
        this.editor.view.dispatch(tr);
        return true;
    }

    getDropLocation(clientX, clientY) {
        const pos = this.editor.view.posAtCoords({ left: clientX, top: clientY })?.pos;
        if (typeof pos !== 'number') return null;
        return this.getDropLocationFromPos(pos);
    }

    getCurrentDropLocation() {
        return this.getDropLocationFromPos(this.editor.state.selection.from);
    }

    getDropLocationFromPos(pos) {
        const coordinates = this.editor.view.coordsAtPos(pos);
        const hostRect = this.host.getBoundingClientRect();
        return {
            type: 'tiptap',
            pos,
            left: 12,
            top: Math.max(coordinates.top - hostRect.top + this.host.scrollTop, 0),
            height: 3,
            width: Math.max(this.host.clientWidth - 24, 24)
        };
    }

    applyDropLocation(location) {
        if (!location || typeof location.pos !== 'number') return;
        this.editor.chain().focus(undefined, { scrollIntoView: false }).setTextSelection(location.pos).run();
    }
}

function createWysiwygEditor(container, initialMarkdown) {
    return new KangarooWysiwygEditor(container, initialMarkdown);
}

function stripMarkdownAngleBrackets(value) {
    const normalized = String(value || '').trim();
    if (normalized.startsWith('<') && normalized.endsWith('>')) {
        return normalized.slice(1, -1).trim();
    }
    return normalized;
}

function canonicalizeMarkdownDestination(rawDestination) {
    const original = String(rawDestination || '').trim();
    const parsed = parseMarkdownLinkDestination(original);
    if (!parsed?.href) return original;

    const href = stripMarkdownAngleBrackets(parsed.href);
    if (!href) return original;

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(href) || href.startsWith('#')) {
        return original;
    }

    const normalizedHref = /\s/.test(href) ? `<${href}>` : href;
    return parsed.title
        ? `${normalizedHref} "${escapeMarkdownTitle(parsed.title)}"`
        : normalizedHref;
}

function canonicalizeMarkdownResourceLinks(markdown) {
    let nextMarkdown = String(markdown || '');
    const markdownImageRegex = /!\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;
    const markdownLinkRegex = /(^|[^!])\[([^\]]*)\]\(((?:<[^>]+>|[^()\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?)\)/g;

    nextMarkdown = nextMarkdown.replace(markdownImageRegex, (match, alt, destination) => {
        return `![${alt}](${canonicalizeMarkdownDestination(destination)})`;
    });

    nextMarkdown = nextMarkdown.replace(markdownLinkRegex, (match, prefix, label, destination) => {
        return `${prefix}[${label}](${canonicalizeMarkdownDestination(destination)})`;
    });

    return nextMarkdown;
}

function normalizeMarkdown(markdown) {
    return canonicalizeMarkdownResourceLinks(String(markdown || '').replace(/\r\n/g, '\n'));
}

function normalizePastedMarkdown(markdown) {
    return normalizeMarkdown(markdown).replace(/\u00a0/g, ' ');
}

function shouldInterpretPastedTextAsMarkdown(text) {
    const normalized = normalizePastedMarkdown(text).trim();
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
            title: '',
            absolutePath: ''
        };
    }

    if (/^(https?:|mailto:)/i.test(rawHref)) {
        return {
            kind: 'link',
            icon: '↗',
            badge: '链接',
            title: rawHref,
            absolutePath: ''
        };
    }

    if (rawHref.startsWith('#')) {
        return {
            kind: 'link',
            icon: '§',
            badge: '锚点',
            title: rawHref,
            absolutePath: ''
        };
    }

    const absolutePath = resolveLocalHref(rawHref, bundlePath);
    if (!absolutePath) {
        return {
            kind: 'link',
            icon: '↗',
            badge: '链接',
            title: rawHref,
            absolutePath: ''
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
                    title: absolutePath,
                    absolutePath
                };
            }

            if (isAttachment && isPdfAttachmentHref(rawHref)) {
                return {
                    kind: 'attachment-pdf',
                    icon: '📕',
                    badge: 'PDF',
                    title: absolutePath,
                    absolutePath
                };
            }

            return {
                kind: isAttachment ? 'attachment-file' : 'file',
                icon: '📄',
                badge: getFileTypeLabel(absolutePath),
                title: absolutePath,
                absolutePath
            };
        }
    } catch {
        return {
            kind: 'missing',
            icon: '⚠',
            badge: '缺失',
            title: rawHref,
            absolutePath: ''
        };
    }

    return {
        kind: /attachments\//i.test(rawHref) ? 'attachment-missing' : 'missing',
        icon: '⚠',
        badge: /attachments\//i.test(rawHref) ? '缺失' : '链接',
        title: rawHref,
        absolutePath: ''
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
    const value = stripMarkdownAngleBrackets(String(href || '').trim());
    if (!value) return '';

    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/i.test(value)) {
        try {
            return decodeURI(value);
        } catch {
            return value;
        }
    }

    return value
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

function serializeMarkdownHref(href) {
    const normalized = String(href || '').trim();
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

function escapeMarkdownLinkLabel(text) {
    return String(text || '').replace(/([\\\[\]])/g, '\\$1');
}

function escapeMarkdownTitle(text) {
    return String(text || '').replace(/(["\\])/g, '\\$1');
}

function clampPdfPreviewWidth(value) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return 560;
    }

    return Math.max(260, Math.min(960, Math.round(numeric)));
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
        return null;
    }

    return null;
}

function parseAttachmentIdentityFromTitle(title) {
    const match = String(title || '').match(/\[kangaroo-attachment-id=([^\]]+)\]/i);
    return match?.[1]?.trim() || null;
}

function stripAttachmentIdentityFromTitle(title) {
    const stripped = String(title || '').replace(/\s*\[kangaroo-attachment-id=[^\]]+\]\s*/ig, ' ').trim();
    return stripped || null;
}

function mergeAttachmentIdentityIntoTitle(title, identity) {
    const cleanTitle = stripAttachmentIdentityFromTitle(title);
    const cleanIdentity = String(identity || '').trim();
    if (!cleanIdentity) {
        return cleanTitle;
    }

    const idTag = `[kangaroo-attachment-id=${cleanIdentity}]`;
    return cleanTitle ? `${cleanTitle} ${idTag}` : idTag;
}

function getAttachmentDisplayLabel(href, fallbackLabel = '') {
    const normalizedHref = normalizeLinkHref(href);
    const basename = safeDecodeUri(path.basename(normalizedHref || ''));
    return basename || String(fallbackLabel || '').trim() || decodeLinkLabelFromHref(normalizedHref);
}

function parsePdfWidthFromTitle(title, fallback = null) {
    const match = String(title || '').match(/(?:^|\s)\[kangaroo-pdf-width=(\d+)\]\s*$/i);
    return match ? clampPdfPreviewWidth(Number(match[1])) : fallback;
}

function stripPdfWidthFromTitle(title) {
    const stripped = String(title || '').replace(/\s*\[kangaroo-pdf-width=\d+\]\s*/ig, ' ').trim();
    return stripped || null;
}

function mergePdfWidthIntoTitle(title, width) {
    const cleanTitle = stripPdfWidthFromTitle(title);
    const widthTag = `[kangaroo-pdf-width=${clampPdfPreviewWidth(width)}]`;
    return cleanTitle ? `${cleanTitle} ${widthTag}` : widthTag;
}

function collectPdfWidthMetadata(markdown) {
    const entries = [];
    const attachmentRegex = /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?(attachments\/(?:<[^>]+>|[^)\s]+))(?:\s+"((?:[^"\\]|\\.)*)")?\)/g;
    let match;

    while ((match = attachmentRegex.exec(String(markdown || ''))) !== null) {
        const rawHref = String(match[2] || '').replace(/^<|>$/g, '');
        const normalizedHref = normalizeLinkHref(rawHref).replace(/^\.?\//, '');
        if (!isPdfAttachmentHref(normalizedHref)) {
            continue;
        }

        const rawTitle = String(match[3] || '');
        entries.push({
            href: normalizedHref,
            identity: parseAttachmentIdentityFromTitle(rawTitle),
            width: parsePdfWidthFromTitle(rawTitle, null)
        });
    }

    return entries;
}

function buildPdfPreviewSrc(src) {
    const normalized = String(src || '').trim();
    if (!normalized) return '';

    const [base, hash = ''] = normalized.split('#');
    const existingParams = new URLSearchParams(hash.replace(/^#/, ''));
    existingParams.set('page', '1');
    existingParams.set('view', 'FitH');
    existingParams.set('toolbar', '0');
    existingParams.set('navpanes', '0');
    existingParams.set('scrollbar', '0');
    existingParams.set('zoom', 'page-fit');
    return `${base}#${existingParams.toString()}`;
}

async function buildPdfPreviewDataUrl(src) {
    const normalized = String(src || '').trim();
    if (!normalized) return '';

    let filePath = '';
    try {
        if (/^file:/i.test(normalized)) {
            filePath = fileURLToPath(normalized);
        } else if (path.isAbsolute(normalized)) {
            filePath = normalized;
        }
    } catch {
        filePath = '';
    }

    if (!filePath || !fs.existsSync(filePath)) {
        return '';
    }

    try {
        if (typeof nativeImage.createThumbnailFromPath === 'function') {
            const thumbnail = await nativeImage.createThumbnailFromPath(filePath, {
                width: 1200,
                height: Math.round(1200 * 1.4142)
            });
            if (thumbnail && !thumbnail.isEmpty()) {
                return thumbnail.toDataURL();
            }
        }
    } catch {
        // Fallback below.
    }

    try {
        const fallback = nativeImage.createFromPath(filePath);
        if (fallback && !fallback.isEmpty()) {
            return fallback.toDataURL();
        }
    } catch {
        return '';
    }

    return '';
}

function decodeLinkLabelFromHref(href) {
    const normalized = normalizeLinkHref(href);
    if (!normalized) return '';
    return getPathTail(normalized);
}

function getFileTypeLabel(filePath) {
    const extension = path.extname(String(filePath || '')).toLowerCase();
    if (!extension) return '文件';

    if (['.pdf'].includes(extension)) return 'PDF';
    if (['.doc', '.docx', '.pages'].includes(extension)) return '文档';
    if (['.xls', '.xlsx', '.numbers'].includes(extension)) return '表格';
    if (['.ppt', '.pptx', '.key'].includes(extension)) return '演示';
    if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.heic'].includes(extension)) return '图片';
    if (['.mp4', '.mov', '.m4v', '.webm', '.ogv', '.avi', '.mkv'].includes(extension)) return '视频';
    if (['.zip', '.rar', '.7z', '.tar', '.gz'].includes(extension)) return '压缩包';
    if (['.md', '.markdown', '.txt', '.rtf'].includes(extension)) return '文本';

    return extension.slice(1).toUpperCase();
}

function isVideoAttachmentHref(href) {
    const normalizedHref = normalizeLinkHref(href).replace(/^\.?\//, '');
    if (!normalizedHref.startsWith('attachments/')) {
        return false;
    }

    return /\.(mp4|mov|m4v|webm|ogv|avi|mkv)$/i.test(normalizedHref);
}

function isPdfAttachmentHref(href) {
    const normalizedHref = normalizeLinkHref(href).replace(/^\.?\//, '');
    if (!normalizedHref.startsWith('attachments/')) {
        return false;
    }

    return /\.pdf$/i.test(normalizedHref);
}

function collectDocumentAnchors(editor) {
    const anchors = [];

    editor.state.doc.descendants((node, pos) => {
        const type = node.type?.name;
        const isAnchor = node.isTextblock || type === 'image' || type === 'kangarooAttachment' || type === 'kangarooVideo' || type === 'kangarooPdf';
        if (!isAnchor) {
            return true;
        }

        const resolved = editor.state.doc.resolve(Math.min(pos + 1, editor.state.doc.content.size));
        const kind = getAnchorKind(node, resolved);
        const normalizedText = type === 'image'
            ? normalizeComparableText((node.attrs?.alt || getPathTail(node.attrs?.src || '')).trim())
            : type === 'kangarooAttachment'
                ? normalizeComparableText((node.attrs?.label || getPathTail(node.attrs?.href || '')).trim())
                : type === 'kangarooVideo'
                    ? normalizeComparableText((node.attrs?.label || getPathTail(node.attrs?.href || '')).trim())
                : type === 'kangarooPdf'
                    ? normalizeComparableText((node.attrs?.label || getPathTail(node.attrs?.href || '')).trim())
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
                : type === 'kangarooAttachment'
                    ? String(node.attrs?.label || getPathTail(node.attrs?.href || '')).trim()
                    : type === 'kangarooVideo'
                        ? String(node.attrs?.label || getPathTail(node.attrs?.href || '')).trim()
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

        if (type === 'kangarooAttachment' || type === 'kangarooVideo' || type === 'kangarooPdf') {
            const href = String(node.attrs?.href || '');
            anchors.attachment.push({
                kind: 'attachment',
                kindIndex: attachmentIndex,
                pos,
                nodeSize: node.nodeSize,
                isTextblock: false,
                displayText: String(node.attrs?.label || path.basename(href)).trim(),
                normalizedText: normalizeComparableText(node.attrs?.label || path.basename(href)),
                lineNumber: semanticAnchors.attachments[attachmentIndex]?.lineNumber || 1,
                relativePath: normalizeLinkHref(href).replace(/^\.?\//, '')
            });
            attachmentIndex += 1;
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

function clearBrowserSelection() {
    try {
        window.getSelection?.()?.removeAllRanges?.();
    } catch {
        // no-op
    }
}

function resetEditorSelectionToDocumentStart(editor) {
    const view = editor?.view;
    const state = editor?.state;
    if (!view || !state?.doc) return;

    try {
        const tr = state.tr.setSelection(Selection.atStart(state.doc));
        view.dispatch(tr);
    } catch {
        // no-op
    }
}

function getEventTargetElement(target) {
    if (!target) return null;
    return target.nodeType === Node.ELEMENT_NODE ? target : target.parentElement || null;
}

function rectsOverlapWithTolerance(a, b, tolerance = 0) {
    if (!a || !b) return false;
    return !(
        a.right < b.left - tolerance
        || a.left > b.right + tolerance
        || a.bottom < b.top - tolerance
        || a.top > b.bottom + tolerance
    );
}

function rangeContainsOrTouchesNode(range, node) {
    if (!range || !node || typeof document === 'undefined') return false;

    try {
        const nodeRange = document.createRange();
        nodeRange.selectNode(node);

        return !(
            range.compareBoundaryPoints(Range.END_TO_START, nodeRange) < 0
            || range.compareBoundaryPoints(Range.START_TO_END, nodeRange) > 0
        );
    } catch {
        return false;
    }
}

function selectionEndpointInsideNode(selection, node) {
    if (!selection || !(node instanceof Node)) {
        return false;
    }

    const endpoints = [selection.anchorNode, selection.focusNode];
    return endpoints.some((endpoint) => endpoint instanceof Node && (endpoint === node || node.contains(endpoint)));
}

function intersectsEditorSelectionWithDomNode(view, element, from, to, tolerance = 0) {
    if (!view || !(element instanceof HTMLElement) || typeof from !== 'number' || typeof to !== 'number') {
        return false;
    }

    const range = getDomNodeDocumentRange(view, element);
    if (!range) {
        return false;
    }

    return !(to < range.from - tolerance || from > range.to + tolerance);
}

function getDomNodeDocumentRange(view, element) {
    if (!view || !(element instanceof HTMLElement)) {
        return null;
    }

    try {
        const textNodes = getTextNodesUnder(element);
        if (textNodes.length) {
            const firstTextNode = textNodes[0];
            const lastTextNode = textNodes[textNodes.length - 1];
            const from = view.posAtDOM(firstTextNode, 0);
            const to = view.posAtDOM(lastTextNode, String(lastTextNode.textContent || '').length);
            if (typeof from === 'number' && typeof to === 'number') {
                return {
                    from: Math.min(from, to),
                    to: Math.max(from, to)
                };
            }
        }

        const from = view.posAtDOM(element, 0);
        const to = view.posAtDOM(element, element.childNodes.length);
        if (typeof from === 'number' && typeof to === 'number') {
            return {
                from: Math.min(from, to),
                to: Math.max(from, to)
            };
        }
    } catch {
        return null;
    }

    return null;
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

function parseTaskHeadingText(text) {
    const rawText = String(text || '');
    const match = rawText.match(/^\s*(#{1,6})\s+(.+?)\s*$/);
    if (!match) return null;

    return {
        level: clampNumber(match[1].length, 1, 6),
        text: String(match[2] || '').trim()
    };
}

function parseTodoHeadingMarkdownLine(line) {
    const match = String(line || '').match(/^(\s*)([-+*]|\d+\.)\s+\[([ xX])\]\s+(#{1,6})\s+(.+?)\s*$/);
    if (!match) return null;

    return {
        indent: match[1] || '',
        bullet: match[2] || '-',
        checked: String(match[3] || '').toLowerCase() === 'x',
        level: clampNumber((match[4] || '').length, 1, 6),
        text: String(match[5] || '').trim()
    };
}

function parseAnyHeadingMarkdownLine(line) {
    const todoHeading = parseTodoHeadingMarkdownLine(line);
    if (todoHeading) {
        return {
            level: todoHeading.level,
            text: todoHeading.text,
            task: true
        };
    }

    const headingMatch = String(line || '').match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!headingMatch) return null;

    return {
        level: clampNumber((headingMatch[1] || '').length, 1, 6),
        text: String(headingMatch[2] || '').trim(),
        task: false
    };
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

function applyTaskHeadingLevelsToMarkdown(markdown, headingLevels = []) {
    const lines = String(markdown || '').split('\n');
    let taskIndex = 0;

    for (let index = 0; index < lines.length; index++) {
        const match = lines[index].match(/^(\s*)([-+*]|\d+\.)\s+\[([ xX])\]\s*(.*)$/);
        if (!match) continue;

        const headingLevel = clampNumber(Number(headingLevels[taskIndex] || 0), 0, 6);
        let taskText = String(match[4] || '').trim();
        const existingHeading = parseTaskHeadingText(taskText);
        if (headingLevel > 0) {
            if (existingHeading) {
                taskText = existingHeading.text;
            }
            taskText = `${'#'.repeat(headingLevel)} ${taskText}`.trim();
        }

        lines[index] = `${match[1]}${match[2]} [${match[3]}] ${taskText}`.trimEnd();
        taskIndex += 1;
    }

    return lines.join('\n');
}

function isImageMarkdownLine(line) {
    const text = String(line || '').trim();
    if (!text) return false;
    return /^!\[[^\]]*\]\([^)]+\)$/.test(text) || /^<img\b[^>]*>/i.test(text);
}

function isImageContainerNode(node) {
    if (!node) return false;
    if (node.type?.name === 'image') return true;
    if (!node.isTextblock && !node.content) return false;

    let hasImage = false;
    let hasOtherVisibleContent = false;

    node.forEach?.((child) => {
        if (child.type?.name === 'image') {
            hasImage = true;
            return;
        }

        if (child.isText && String(child.text || '').trim()) {
            hasOtherVisibleContent = true;
            return;
        }

        if (child.type?.name !== 'hardBreak') {
            hasOtherVisibleContent = true;
        }
    });

    return hasImage && !hasOtherVisibleContent;
}

function isEffectivelyEmptyTextblockNode(node) {
    if (!node?.isTextblock) {
        return false;
    }

    if (isImageContainerNode(node)) {
        return false;
    }

    return !String(node.textContent || '').trim();
}

function getAdjacentProseMirrorTextblock(element, direction = 1) {
    if (!(element instanceof HTMLElement)) {
        return null;
    }

    let current = direction < 0 ? element.previousElementSibling : element.nextElementSibling;
    while (current instanceof HTMLElement) {
        if (current.parentElement?.classList?.contains('ProseMirror')) {
            return current;
        }
        current = direction < 0 ? current.previousElementSibling : current.nextElementSibling;
    }

    return null;
}

function isEffectivelyEmptyDomTextblock(element) {
    if (!(element instanceof HTMLElement)) {
        return false;
    }

    if (!element.parentElement?.classList?.contains('ProseMirror')) {
        return false;
    }

    if (element.querySelector?.('[data-resize-container][data-node="image"]')) {
        return false;
    }

    return !String(element.textContent || '').trim();
}

function findLastImageNodePos(node, startPos) {
    if (!node || typeof startPos !== 'number') {
        return null;
    }

    if (node.type?.name === 'image') {
        return startPos;
    }

    if (!node.content?.childCount) {
        return null;
    }

    let offset = node.content.size;
    for (let index = node.childCount - 1; index >= 0; index--) {
        const child = node.child(index);
        offset -= child.nodeSize;
        const childPos = startPos + 1 + offset;
        const match = findLastImageNodePos(child, childPos);
        if (typeof match === 'number') {
            return match;
        }
    }

    return null;
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

    if (type === 'kangarooAttachment' || type === 'kangarooVideo' || type === 'kangarooPdf') {
        return 'attachment';
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
    if (node?.type?.name === 'kangarooAttachment' || node?.type?.name === 'kangarooVideo' || node?.type?.name === 'kangarooPdf') {
        return true;
    }

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

        const headingMatch = parseAnyHeadingMarkdownLine(line);
        if (headingMatch) {
            headings.push({
                lineNumber,
                level: headingMatch.level,
                text: normalizeComparableText(headingMatch.text)
            });
        }

        if (/^(?:[-+*]|\d+\.)\s+\[[ xX]\]\s+/.test(line)) {
            tasks.push({
                lineNumber,
                text: normalizeMarkdownLineForMatch(line)
            });
        }
    }

    const attachmentRegex = /\[((?:\\.|[^\]])*)\]\((?:\.?\/)?attachments\/(<[^>]+>|[^)\s]+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'))?\)/g;
    let match;
    while ((match = attachmentRegex.exec(markdown)) !== null) {
        const rawRelativePath = String(match[2] || '').replace(/^<|>$/g, '');
        attachments.push({
            lineNumber: getLineNumberAtOffset(markdown, match.index),
            text: normalizeComparableText(unescapeMarkdownLinkLabel(match[1] || '') || getPathTail(rawRelativePath))
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
