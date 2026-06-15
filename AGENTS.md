# AGENTS.md — Implemented Architecture & Features

This file is the single source of truth for what is **already implemented** in this fork: the
architecture and the shipped annotation/notes/sync features, at a high level. Update this file
whenever a feature is added or significantly changed (see maintenance rules in `CLAUDE.md`).

---

## 1. Project overview

Browser extension (Chrome MV3 / Firefox / Safari). Base product clips web pages to Obsidian.
This branch adds **live-webpage annotation** (highlights, comments, freehand drawing), a
**highlights dashboard**, **Google Drive sync**, and **YouTube video frame notes**.

- Language: TypeScript, SCSS. Bundled with webpack → `dist/`, `dist_firefox/`, `dist_safari/`.
- Manifests: `src/manifest.{chrome,firefox,safari}.json`. Permissions in use: `storage`,
  `unlimitedStorage`, `scripting`, `identity`, `alarms`, `commands`, `contextMenus`, `sidePanel`.
- Local feature commits are authored by `rehan` (see `git log --author=rehan`).

### Key files
| File | Role |
|------|------|
| `src/content.ts` | Page entry point. Inits highlighter+pencil, CSS injection, global keydown dispatch, exposes `window.__obsidianHighlighter` API bridge. |
| `src/utils/highlighter.ts` | Highlight CRUD, storage, anchoring, undo/redo, migrations, export grouping. |
| `src/utils/highlighter-overlays.ts` | Text/element rendering (CSS Custom Highlight API), color swatch menu, active-highlight emphasis. |
| `src/utils/comment-overlays.ts` | Comment card layout (left/right), threads, truncation, edit/save/delete, inline markdown. |
| `src/utils/pencil-overlays.ts` | Freehand SVG drawing, stroke storage, color switching, marquee select/delete. |
| `src/core/highlights.ts` | Highlights dashboard logic (sidebar tree, search, pagination, export/delete; folds in video annotations). |
| `src/highlights.html` | Dashboard page markup. |
| `src/utils/video/` | YouTube video notes: `youtube-detect` (player/SPA), `frame-capture` (canvas + screenshot fallback), `video-annotator` (in-page frame/draw overlay), `video-markup` (draw renderer), `video-storage`, `video-notes`, `video-transcript` (caption-track fetch/parse), `video-transcript-panel` (the `T` transcript-annotation panel), `video-comments` (per-video conversation comment panel). |
| `src/core/video-highlights.ts` | Dashboard render path for video frame cards + timestamped notes. |
| `src/utils/sync-engine.ts` | 3-way merge sync state machine, tombstones, push/pull. |
| `src/utils/google-drive.ts` | Google Drive REST + OAuth (implicit grant), appdata file. |
| `src/managers/sync-settings.ts` | Settings UI for connect/disconnect/"Sync now". |
| `src/background.ts` | Message routing, `open_dashboard`, sync alarms + debounced push. |
| `src/types/types.ts` | Shared data types. |

---

## 2. Data model

All annotation data lives in `browser.storage.local`, keyed by **normalized URL** (hash + ephemeral
tracking params like `utm_*`, `fbclid`, `_ga` stripped).

### Highlights — key `highlights`: `Record<normalizedUrl, StoredData>`
- `StoredData` = `{ url, title, highlights: AnyHighlightData[] }`
- `TextHighlightData` = `{ type:'text', id, xpath, startOffset, endOffset, content, notes[], color, groupId, updatedAt }`
- `ElementHighlightData` = `{ type:'element', id, xpath, content, notes[], color, groupId, updatedAt }`
- **Anchoring**: text → XPath + char offsets; element → XPath only. No fuzzy fallback — if the page
  shifts and XPath breaks, the highlight silently drops. *(known fragility — candidate for improvement)*
- **Comments** stored inline in `notes[]` as strings tagged with creation/edit timestamps, which act
  as stable IDs for sync merge.
- `groupId` links multi-block highlights (one selection spanning blocks → one highlight per block).
- `color` ∈ {yellow, red, green}. `updatedAt` drives sync conflict resolution.

### Drawings — key `drawings`: `Record<normalizedUrl, { url, strokes: PencilStroke[] }>`
- `PencilStroke` = `{ id, color, width, points:[x,y,x,y,...], updatedAt? }` (flattened document coords).

### Domains — key `domains`: `Record<hostname, DomainSettings>` (custom site name, etc.)

### Video annotations — key `video_annotations`: `Record<normalizedUrl, VideoAnnotationData>`
- Kept separate from `highlights`/`drawings` so the dashboard routes them to their own card
  renderer and the (large) captured frames never bloat the highlight/sync payloads.
- `VideoAnnotationData` = `{ url, videoId, title?, items: VideoItem[] }`.
- `VideoItem` = `{ id, kind:'frame'|'note'|'transcript', videoTime, frame?:{dataUrl,w,h}, markup?, notes[], updatedAt }`.
- **Transcript items** add `{ timeEnd, quote, color, anchor:{startCue,startOffset,endCue,endOffset} }`. `videoTime`
  holds the range start (so the existing time-sort/timeline keep working); `anchor` re-paints the
  highlight against the immutable caption track on reopen (cue index + char offset — no XPath).
- `markup` = `{ strokes, lines, texts }` with all coords **normalized 0..1** of the frame, so they
  repaint correctly over the saved image at any size.
- `notes[]` reuse the same `<!--timestamp--><!--edited-->` chat-message format as highlight comments.
- Frames are downscaled JPEG (~1280px) and stay **local-only** (not pushed through Drive sync).

### Sync state
- Local base snapshot: `sync_snapshot` (for 3-way reconcile).
- Drive file: `clipper-sync.json` in `drive.appdata` (hidden, app-scoped).
- `SyncFile` = `{ version:1, highlights, drawings, tombstones:{highlights,drawings,comments} }`.

---

## 3. Implemented features

### 3.1 Text highlighting (Marker)
- **`H`** toggles highlighter mode.
- Smart cursor: hovering an annotation/comment card disables the highlighter (reverts to normal
  cursor) to avoid accidental highlights; restores on leave.
- Selecting text shows a floating **color-swatch popup** (circular swatches above the selection).
  Picking a color recolors the whole linked group.
- **`Ctrl`+highlight** → creates the highlight and immediately opens a new comment box for it.
- Works inside code blocks and stays clear of images during navigation.
- Undo/redo: `Ctrl+Z` / `Ctrl+Shift+Z`. `Esc` exits mode.

### 3.2 Commenting & annotation system
- Comments render as floating **cards on the left or right** of the viewport based on available space;
  if neither fits, body padding nudges content inward. Cards stack top-to-bottom without overlap.
- **`Ctrl`+click** an existing highlight opens its comment bar for typing.
- **Threaded replies**: a reply bar at the bottom of each card adds replies to the thread.
- **Smart truncation**: replies longer than 3 lines collapse; 4th line fades/blurs out.
- **Expandable**: clicking a truncated reply expands just that one (double-click → edit mode).
- Inline markdown in editor: `Ctrl+B` / `Ctrl+I` wrap selection. Auto-saves on click-outside.

### 3.3 Pencil tool (freehand drawing)
- **`P`** activates pencil. Strokes drawn on a full-document SVG overlay.
- **`1` / `2` / `3`** switch between 3 predefined colors; the on-screen nib recolors to match.
- **Selector**: holding **`Ctrl`** (with pencil or normal cursor) turns the cursor into a marquee
  selector. Drag to select strokes, **`Delete`** to remove. Selector ignores text highlights.
- Pencil and highlighter are mutually exclusive (entering one exits the other).

### 3.4 Highlights dashboard
- **`Alt+E`** opens `highlights.html` in a new tab (content → `open_dashboard` → background creates tab).
- **Website directory** sidebar: domains → pages tree, favicons, highlight-count badges, collapsible.
- **Dual search**: (1) website search filters domains by hostname/custom name; (2) global search does
  full-text search across highlight content, comments/replies, and URLs.
- **Navigation**: in the website list, normal click opens that site's saved highlights *inside* the
  dashboard; **`Ctrl`+click** opens the real website in a new tab. In the highlights panel, clicking a
  page title opens the real website in a new tab. Navigation levels: all → domain → page, with breadcrumbs.
- Export (JSON/Markdown) and delete, scoped to all / domain / page.

### 3.5 Google Drive sync
- Google OAuth via `browser.identity`; connect/disconnect from settings.
- Syncs `highlights` + `drawings` as a single `clipper-sync.json` in an app-scoped Drive folder.
- **3-way merge** (base snapshot vs local vs remote): newest edit wins per item; comments from both
  devices are kept; deletions tracked as **tombstones** so they don't resurrect.
- **Push**: automatic shortly after a change. **Pull**: periodic + on startup. **"Sync now"** button
  forces an immediate reconcile and shows last-synced time / errors. See `GOOGLE_DRIVE_SYNC.md`.

### 3.6 YouTube video frame notes (lectures)
- On a YouTube watch page, **`S`** captures the current frame: the video pauses, the frame freezes
  full-size, and a small draw toolbar appears (freehand pencil, straight **line** that snaps to 45°
  with **Shift**, click-to-place **text**, color swatches). A hint line reads `Enter save · C comment · Esc cancel`.
- **`Enter`** saves the frame (with its markup) and resumes; **`C`** saves and advances to the comment
  step; **`Esc`** discards.
- **Comment step**: the frame animates to a reduced size on the left and a fixed-width **slate chat
  panel** docks on the right (read-only frame). A "reply here" box posts messages (newest at bottom,
  long ones collapse after ~3 lines). One chat thread per frame. **`Esc`** closes and resumes.
- **`N`** = comment-only: pauses, captures the timestamp, opens the chat panel directly (no image).
- Capture uses a canvas draw with a background `captureVisibleTab` screenshot fallback. The overlay
  scopes itself to the `<video>`'s rect and mounts into the fullscreen element, so it works in and out
  of fullscreen. Markup participates in an in-overlay undo (`Ctrl+Z`).
- Saved items appear in the dashboard as a per-video section in video-time order: frame cards (markup
  repainted on top, `M:SS` badge linking to the moment, chat thread beneath) and frameless notes.
- Keys (`S`/`N`) and the on/off toggle are configurable under Highlighter settings.

### 3.7 YouTube transcript annotation (`T`)
- On a watch page, **`T`** pauses the video and docks a scrollable transcript panel on the right,
  auto-scrolled to a fixed **30s** behind the current moment (the spoken cue is marked). The transcript
  comes from YouTube's own caption track (player response → `captionTracks` → `&fmt=json3`); a small
  **language picker** appears when >1 track exists (auto-picks English, then UI language, then first;
  the choice is remembered for the current video session only). **No captions → a toast, feature does
  nothing.**
- Selecting transcript text shows the familiar **color-swatch popup** (yellow/red/green) plus a
  **Comment** button. Each highlight derives its `M:SS–M:SS` range from the covered cues and is stored
  as a `kind:'transcript'` item. Multiple highlights per session; **all** of the video's saved
  transcript highlights are repainted inline while scrolling. **Double-click** a highlight (or the
  popup's **Comment**) opens the comment panel for it. `Esc` saves and resumes.
- **Per-video conversation comment panel** (`video-comments.ts`): the comment panel is now a scrollable
  stack of **grouped thread cards** — one card = one annotation's anchor (transcript quote + range chip,
  a modest frame thumbnail, or a note timestamp) + all its replies — with the focused thread expanded
  and its reply box active (the transcript quote pinned above the input, WhatsApp-style). It loads
  **every** item for the video, so it doubles as the full comment history. The frame (`S`→`C`) and
  comment-only (`N`) flows now open this same panel (the frame draw step is unchanged); `Esc` from it
  returns to the transcript panel when opened from there, otherwise resumes the video.
- Dashboard renders transcript items as a colored quote block + `M:SS–M:SS` badge, in video-time order
  alongside frame/note cards. Transcript items, like frames, stay **local-only** (not Drive-synced).

### 3.8 Keyboard shortcut reference
| Key | Action |
|-----|--------|
| `H` | Toggle highlighter |
| `P` | Toggle pencil |
| `1` / `2` / `3` | Change pencil (or active highlight) color |
| `Ctrl` (hold) | Selector tool (select/delete pencil strokes) |
| `Ctrl`+highlight | Highlight + open new comment box |
| `Ctrl`+click (highlight) | Open that highlight's comment bar |
| `Ctrl`+`Z` / `Ctrl`+`Shift`+`Z` | Undo / redo highlight |
| `Esc` | Exit highlighter mode |
| `Alt`+`E` | Open Highlights Dashboard |
| `S` (YouTube watch) | Capture frame + draw |
| `N` (YouTube watch) | Comment-only (frameless, timestamped) |
| `T` (YouTube watch) | Transcript annotation panel (highlight spoken lines) |
| `Enter` / `C` / `Esc` (capture overlay) | Save · save+comment · cancel |
| `Ctrl`+click (dashboard list) | Open the real website in a new tab |
| `Ctrl`+`B` / `Ctrl`+`I` (editor) | Bold / italic markdown |

---

## 4. Conventions & gotchas for implementers
- Match surrounding code style (naming, comment density, idioms). TS + SCSS.
- All annotation data is keyed by **normalized URL** — reuse the existing normalizer; don't re-derive.
- Comment IDs = inline HTML-comment timestamps; preserve them or sync merge breaks.
- Highlight anchoring is XPath+offset with no fuzzy fallback — be careful editing anchoring logic.
- `content.ts` owns the single highlighter instance; reader mode delegates via
  `window.__obsidianHighlighter`. Don't instantiate a second copy.
- Sync conflict resolution depends on `updatedAt` being stamped on change — keep stamping it.
- After changes, rebuild for the target browser (webpack) and reload the unpacked extension.
