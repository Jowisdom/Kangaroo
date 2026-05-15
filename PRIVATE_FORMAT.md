# Kangaroo Private Format Draft

## Goal

Kangaroo's internal format should preserve editor structure directly, instead of reconstructing it from Markdown text.
This is meant to fix line drift, cursor boundary issues, and block-level editing problems around tasks, attachments,
PDFs, and videos.

## File Extension

- Primary package: `.kangaroo`
- Optional compatibility export: `.md`
- Legacy import: `.textbundle`

## Package Layout

The private format is a package directory with a small manifest and structured document data.

```text
My Note.kangaroo/
  manifest.json
  document.json
  assets/
  attachments/
  recovery/
```

### `manifest.json`

Minimal metadata for opening and compatibility.

```json
{
  "format": "kangaroo",
  "formatVersion": 1,
  "appVersion": "1.0.3",
  "documentId": "8f3b8d6e-3b3f-4c5a-8d0a-51f8c0a2b19f",
  "title": "Untitled",
  "createdAt": "2026-04-30T00:00:00.000Z",
  "updatedAt": "2026-04-30T00:00:00.000Z",
  "defaultLanguage": "markdown",
  "rootBlockId": "root"
}
```

### `document.json`

The real source of truth. In the first implementation pass, this is the editor's structured TipTap / ProseMirror JSON document, not raw Markdown text.
Task, attachment, PDF, video, and image blocks should carry stable `id` attributes so the editor can anchor selection and block identity without guessing from Markdown text.

```json
{
  "type": "doc",
  "version": 1,
  "blocks": [
    {
      "id": "b1",
      "type": "paragraph",
      "children": [
        { "type": "text", "text": "Hello", "marks": [] }
      ]
    }
  ]
}
```

## Block Model

Supported block types:

- `paragraph`
- `heading`
- `task`
- `attachment`
- `pdf`
- `video`
- `image`
- `blockquote`
- `codeBlock`
- `list`
- `listItem`

Each block should carry:

- `id`: stable UUID or ULID
- `type`
- `attrs`: type-specific attributes
- `children`: nested blocks or inline content
- `source`: optional original Markdown source for round-trip fidelity

## Inline Model

Inline content should be explicit, not inferred from rendered HTML.

Supported inline items:

- `text`
- `link`
- `code`
- `strong`
- `em`
- `strike`
- `hardBreak`
- `inlineAttachmentRef`

## Task Model

Tasks should not depend on parsing `- [ ]` from raw text during editing.

Example:

```json
{
  "id": "task-1",
  "type": "task",
  "checked": false,
  "headingLevel": 0,
  "children": [
    {
      "type": "paragraph",
      "children": [
        { "type": "text", "text": "Write the draft" }
      ]
    }
  ]
}
```

This gives the editor stable anchors for:

- cursor before checkbox
- cursor after checkbox
- cursor at block start/end
- line-level mapping

## Attachment Model

Attachments should be represented as block nodes with immutable identity.

```json
{
  "id": "att-1",
  "type": "attachment",
  "href": "attachments/spec.pdf",
  "label": "spec.pdf",
  "title": null,
  "identity": "sha1-or-uuid",
  "kind": "pdf"
}
```

Recommended attachment `kind` values:

- `file`
- `folder`
- `image`
- `video`
- `pdf`
- `missing`

## Line Mapping Rules

The editor should stop deriving line positions from reconstructed Markdown.
Instead:

1. Every block gets a stable `id`.
2. Every block keeps a source order index.
3. Every render line maps to a block or inline boundary directly.
4. Empty lines become explicit block separators.

This avoids:

- task lines jumping upward after blank lines
- attachment cards losing left/right caret positions
- selection drift when a block changes size

## Markdown Compatibility

Markdown stays as an import/export format, not the storage format.

### Import

- Parse Markdown into the block tree.
- Generate stable ids.
- Keep original markdown snippets in `source` when useful for round-trip fidelity.

### Export

- Serialize the block tree back to Markdown.
- Preserve task state, headings, attachment links, titles, and PDF width tags.
- If exact Markdown reconstruction is impossible, prefer deterministic canonical output.

## Legacy Migration Strategy

Existing bundles can be migrated in-place or lazily.

Recommended path:

1. Open legacy `.textbundle` or `.kangaroo` package.
2. Parse `text.md` into `document.json`.
3. Write `manifest.json`.
4. Keep `text.md` as an export cache initially.
5. On save, update `document.json` first, then regenerate `text.md` if compatibility export is enabled.

## Save Strategy

Two save modes:

- `internal save`: persist `document.json` and manifest only
- `compat save`: persist `document.json` plus regenerated Markdown export

For the current app, `compat save` is the pragmatic choice.
That keeps the bundle usable if the Markdown file is inspected outside Kangaroo.

## Cursor and Selection

Cursor locations should be anchored to structural positions:

- before block
- inside block start
- inside block end
- after block
- before/after inline atom

This is the part that fixes the current task and attachment boundary issues.

## Why This Helps

This format removes the current dependence on:

- `currentMarkdown.split('\n')`
- fuzzy line re-matching
- block re-discovery by text similarity
- atom block guesswork for attachments

That is the main reason your current editor drifts under blank lines and block widgets.

## Recommended Next Step

Keep Markdown as the compatibility surface, but move the editor's authoritative model to this private tree.
Do not try to make Markdown itself behave like a structural document store.
