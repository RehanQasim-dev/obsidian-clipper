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
| `src/utils/sync-engine.ts` | 3-way merge sync state machine, tombstones, push/pull (highlights, drawings, video). |
| `src/utils/google-drive.ts` | Google Drive REST + OAuth (implicit grant), appdata file + binary blobs. |
| `src/managers/sync-settings.ts` | Settings UI for connect/disconnect/"Sync now". |
| `src/utils/obsidian-rest.ts` | Local REST API client (config, ping, note/binary PUT/GET). |
| `src/utils/obsidian-export.ts` | Pure serializers: annotations → Markdown (managed region, `<mark>` colors, callouts). |
| `src/utils/obsidian-sync.ts` | Obsidian push orchestrator: dirty queue, offline-aware flush, path map, CSS snippet. |
| `src/managers/obsidian-sync-settings.ts` | Settings UI for the Obsidian REST sync. |
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
- **Portable anchor** (`anchor?`): in addition to XPath, each highlight now carries a cross-surface
  anchor (`shared/anchor.ts`) — a universal **text-quote** (`quote` + prefix/suffix context +
  occurrence) plus an optional **structural** anchor tagged with the `surface` ('web' | 'obsidian') it
  was captured on. Stamped at creation (surface 'web') and backfilled for old highlights. Lets a
  highlight be re-found on the rendered Obsidian note, not just the live DOM. See §5.
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
- Frames are downscaled JPEG (~1280px). The frame **metadata + markup + notes + transcript items
  are Drive-synced**; the JPEG itself is stored as a **separate Drive appData blob** (referenced by
  `frame.driveId`) and never inlined into `clipper-sync.json`, so the merge payload stays small.
  `frame.dataUrl` is local-only and lazily re-downloaded from the blob on devices that lack it.

### Sync state
- Local base snapshot: `sync_snapshot` (for 3-way reconcile).
- Drive file: `clipper-sync.json` in `drive.appdata` (hidden, app-scoped); frame JPEGs live beside it
  as separate `frame-<itemId>.jpg` appData blobs.
- `SyncFile` = `{ version:1, highlights, drawings, videoAnnotations, tombstones:{highlights,drawings,comments,videoItems} }`.

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
- **Diagrams**: A "Add Diagram" button in the comment editor opens a dedicated, isolated Excalidraw window. Drawing a diagram and saving it generates an image that renders directly inline within the comment list. Clicking the image reopens the Excalidraw editor to resume editing. Diagram data (scene JSON and image data URL) is stored in `browser.storage.local` under the `diagrams` key.
- **Grouped highlights are one annotation on the live page**: a multi-block selection (e.g. several
  bullet points sharing a `groupId`) shows a **single comment box / thread** anchored to the group's
  first piece — comments save to that representative, and edit/delete map the flattened thread index
  back to the piece that owns each note. Hover-emphasis lights up **all** pieces of the group at once.

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
- Syncs `highlights` + `drawings` + `video_annotations` (transcript items, notes, frame markup) as a
  single `clipper-sync.json` in an app-scoped Drive folder; frame images sync as separate appData blobs.
- **3-way merge** (base snapshot vs local vs remote): newest edit wins per item; comments from both
  devices are kept; deletions tracked as **tombstones** so they don't resurrect.
- **Push**: automatic shortly after a change. **Pull**: periodic + on startup. **"Sync now"** button
  forces an immediate reconcile and shows last-synced time / errors. See `GOOGLE_DRIVE_SYNC.md`.

### 3.6 YouTube video frame notes (lectures)
- On a YouTube watch page, **`S`** captures the current frame and the video pauses. The draw step is a
  full **Excalidraw** editor hosted in an iframe (`src/video-excalidraw.tsx` / `.html`), with a native
  top toolbar and a custom bottom **properties bar** (color/fill/stroke/opacity, cycled by keyboard).
- **Layout**: the iframe covers the video's content rect; the paused video behind is **dimmed** and the
  captured frame is placed as a centred card in the **region between a reserved top band and bottom band**,
  so the toolbar and properties bar never overlap the drawing. The frame is positioned by explicit
  zoom/scroll (not `scrollToContent`/`fitToViewport`) so it lands deterministically.
- **Performance**: the Excalidraw iframe is created **once per watch-page session and pooled** — warmed on
  load / `yt-navigate-finish`, parented to the player container (which YouTube fullscreens, so it never
  needs reparenting). Each `S` resets the scene and feeds the new frame via `INIT_FRAME`; the iframe stays
  hidden until it posts `FRAME_RENDERED`, so no blank canvas flashes.
- **`Enter`** saves the frame (Excalidraw exports a baked composite back to `item.frame.dataUrl`) and
  resumes; **`C`/`N`** saves and advances to the comment step; **`Esc`** discards. Host-side keys are
  forwarded to the iframe (`TRIGGER_SAVE`/`COMMENT`/`DISCARD`) so save always runs through the export.
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
  alongside frame/note cards. Transcript items and frames are **Drive-synced** (see §2 / §3.5).

### 3.8 Obsidian sync (Local REST API)
- **Separate pipeline from Drive sync** (Drive = device↔device data backup; this = formatted notes out).
- Transport: the **Local REST API** community plugin over its **insecure HTTP server** (`http://127.0.0.1:27123`)
  — the HTTPS server's self-signed cert can't be validated by an extension `fetch`. User enables that
  server, pastes the API key + base folder in Settings → Sync → Obsidian sync.
- **Two notes per page/video** at `<folder>/<hostname>/`:
  1. **Source note** (`<title>.md`): The immutable page text the plugin renders and anchors against. It carries the `source:` URL frontmatter and NO callouts. Written once.
  2. **Comments note** (`<title>.comments.md`): A human-readable mirror of the annotations. Our content is wrapped in a `%% clipper:start/end %%` **managed region** so re-syncs never clobber the user's own edits; frontmatter (`clip_source`, `domain`, `type`, `captured`, `tags`) is written on create. Regenerated every sync.
- **Format:** each annotation in the comments note is a **semantic callout** carrying its highlight color as callout metadata —
  `clip-hl` (text), `clip-img` (image), `clip-transcript`, `clip-frame`, `clip-note`, with comments as a
  nested `clip-reply` callout. Body is real Markdown (callouts/embeds/`<mark>`) so Obsidian features keep
  working. A grouped selection made **entirely of list items** renders as a real Markdown bullet list
  (one `- ` per `<li>`) inside the callout; other groups stay single inline-marked. **Image** highlights
  embed the resolved remote URL at a capped width (`![alt|480](src)`); YouTube
  items render in video-time order with `M:SS` deep links (`&t=Ns`), frames embed `![[youtube-<videoId>-<itemId>.jpg|480]]`
  with the JPEG PUT to `<folder>/Attachments/`.
- **Themes:** a selectable note style (`cards` = cards + side-by-side media/comments; `document` = minimal
  typographic). The same body renders both ways — frontmatter `cssclasses: [clip, clip-<theme>]` picks the
  theme and a versioned CSS snippet (`obsidian-export.CLIP_CSS`, pushed to `.obsidian/snippets/`) does the
  styling (mono metadata, accent-by-color, the flex split). Switch theme + "Sync all now" to restyle.
- **Triggers:** live on change (per-page/video changes enqueue their URL; ~3 s debounced flush — short so it
  fires before the MV3 service worker idles out, which would otherwise drop the timer) + a manual
  **"Sync all now"** button. **Offline-safe:** if Obsidian/the plugin is unreachable the queue is kept and
  retried on the sync alarm (5 min) and on startup, so pending changes flush automatically once it's back.

### 3.9 Keyboard shortcut reference
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

---

## 5. Cross-surface anchoring & the Obsidian companion plugin

A separate **Obsidian plugin** (`clipper-annotations-plugin/`, id `clipper-annotations`, esbuild →
`main.js`) lets you highlight/comment on clipped **source notes in reading view**, with a docked,
linked comments panel — the same swatch popup, colors, and in-context keys (`1`/`2`/`3`, `c`, `Esc`)
as the live-page highlighter, but comments live in a separate panel. It is a **distinct codebase**;
the extension and plugin share logic only through a neutral top-level **`shared/`** folder (neither
imports the other's `src/`).

- **Image annotations (cross-surface):** an image highlight is an `ElementHighlightData`
  (`type:'element'`) carrying the `<img>` in `content`. Its cross-surface bridge is an **image anchor**
  (`anchor.image = { src, alt }`) — the image-equivalent of the text-quote anchor — resolved by
  `resolveImageElement` (exact src → host+path → filename match), so the *same image* is found on the
  live page and in the rendered note regardless of relative/absolute/CDN differences. **No Google Drive
  download** is needed (the image is just a remote URL, present in both the highlight `content` and the
  note's `![](src)`); only YouTube *frame captures* (binary JPEG blobs) use Drive. The extension stamps
  `anchor.image` at creation and paints Obsidian-origin image highlights by matching the page `<img>`
  when xpath fails. The **plugin** treats these as first-class `kind:'image'` annotations: the panel
  shows an image-preview card with its comment thread below, the matching note image gets a colored
  **outline** (hover/click ↔ card), and clicking any note image opens the swatch to create a new image
  annotation. Image annotations + their comments sync bidirectionally just like text (mapped ↔ the
  `type:'element'` highlight in `sync.ts`; ones with no resolvable image are still preserved verbatim).

- **`shared/anchor.ts`** — the dual anchor model (text-quote + per-surface XPath) and the resolver
  (XPath-when-native → text-quote fallback → "unplaced", never silently dropped). The text-quote
  fallback is **whitespace-insensitive** (`findTextQuoteRange`: exact `indexOf` first, then a
  collapsed-whitespace match that reports the real span) — required because Obsidian's rendered
  Markdown is single-spaced while a live web page's text nodes carry raw newlines, indentation, and
  non-breaking spaces; an exact match would never bridge that gap, so highlights made in Obsidian
  wouldn't paint on the live page. Operates on a `RangeLike`; pure + unit-tested (`shared/anchor.test.ts`).
- **`shared/merge.ts`** — the pure 3-way `clipper-sync.json` merge (newest-wins, tombstones, comment
  merge), unit-tested (`shared/merge.test.ts`). **Both** the extension's `sync-engine.ts` and the
  plugin's `sync.ts` import these merge functions, so there is a single implementation of the
  conflict-resolution logic (`sync-engine.ts` keeps only its orchestrator, storage types, and
  frame-stripping; the structurally-identical storage types stay declared locally).
- **Full page source → Obsidian:** the extension captures the readable page as Markdown
  (`page-source-capture.ts`, Defuddle) on first save and temporarily stores it under `page_sources`.
  The Obsidian sync writes it below the managed region on note creation (immutable; re-syncs never
  touch it), so the plugin has content to render and re-anchor against. Once successfully synced to Obsidian,
  the stored page source is automatically deleted from local storage to conserve space.
- **Bidirectional Drive sync:** the plugin is a second client of the same Drive `clipper-sync.json`
  via Google's **device-authorization OAuth** flow (`drive.ts`, no redirect/server, works on mobile);
  `sync.ts` maps annotations ↔ the highlight shape, merges via `shared/merge`, and passes the
  extension's drawings/video (and unrenderable highlights) through untouched so nothing is lost.

- **Reading-view painting (plugin):** Obsidian renders reading view progressively and **virtualizes**
  off-screen sections, so a single post-open repaint paints nothing (text not yet in the DOM) or only
  the top of the note. The plugin therefore watches the preview root with a **`MutationObserver`** and
  repaints highlights (rAF-coalesced, panel untouched) whenever sections render in/out — so highlights
  appear the instant their text exists, on open and on scroll. `resolveAnchor` takes an optional cached
  `rootText` so a full repaint walks the preview text once, not once per annotation.

- **Live-page painting of cross-surface highlights:** the painter (`renderTextHighlight`) resolves a
  text highlight's range with the native xpath+offset path for web-origin highlights, then **falls
  back to `resolveAnchor(anchor, document.body, 'web')`** (text-quote) when that fails — which is what
  makes a highlight *created in Obsidian* (no web xpath) actually paint on the live page, and also
  rescues web highlights whose page shifted. `applyHighlights` no longer gates text highlights on the
  xpath resolving.

**Remaining caveats & checks:**
- The plugin's Drive device-flow OAuth (`drive.ts`) is correct by construction but unverified end-to-end (needs a "TV/Limited Input" Google client + the Obsidian runtime).
- **Vault Gitignore:** For the plugin to work without the extension being open, it acts as a standalone Drive client. This means it stores its own Google login refresh token in `.../.obsidian/plugins/clipper-annotations/data.json` inside the user's vault. If the user uses `obsidian-git` or otherwise version-controls their vault, they **must** add that `data.json` file to their vault's `.gitignore` so the token never gets committed.
