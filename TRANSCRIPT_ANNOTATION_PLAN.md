# Plan — Live YouTube Transcript Annotation (`T`)

Status: **design approved, not yet implemented.** This document is the agreed design for a new
live-YouTube feature: annotating the *spoken* transcript of a lecture (highlight the lines being
said, optionally comment), as a sibling to the existing frame capture (`S`) and comment-only (`N`)
flows. Update this file as the design evolves; fold the final feature summary into `AGENTS.md` once
shipped.

---

## 1. Goal & motivating use case

While watching a lecture on YouTube (fullscreen or windowed), the user often hears a line worth
keeping — *with nothing visually interesting on screen*. Today the only options are a screenshot
(`S`) or a frameless timestamp note (`N`). Neither captures **what was said**.

New flow: press **`T`** → a transcript panel opens on the right, scrolled to ~30s behind the current
playback position. The user highlights the line(s) of interest using the same highlight UX already
built for live pages, optionally adds a comment, and the annotation is stored with its automatically
derived timestamp range and the quoted text.

Key principles carried over from the existing design:
- Reuse what already exists: the live-page highlight swatch UX, the YouTube comment panel, the
  video-annotation storage + dashboard render path, the fullscreen-aware overlay mounting, and the
  keyboard-shielding machinery in `video-annotator.ts`.
- Stay local-only, like all other video annotations (frames/notes are not pushed through Drive sync;
  transcript items follow the same rule).

---

## 2. Decisions locked in (from design Q&A)

| # | Decision |
|---|----------|
| 1 | **Surface:** live `youtube.com/watch` page only (fullscreen + windowed). Not reader mode. |
| 2 | **Trigger:** `T` key (configurable like `S`/`N`). Pressing `T` **pauses** the video and opens the transcript panel. |
| 3 | **Transcript source:** fetch YouTube's own caption track (player response → `captionTracks[].baseUrl` + `&fmt=json3`). If the video has **no transcript**, `T` shows a toast and does nothing (feature disabled for that video). |
| 4 | **Panel scope:** scrollable **full** transcript, auto-scrolled to **a fixed 30s** behind current time on open; user can scroll anywhere to refine. |
| 4a | **Track selection:** auto-pick **English by default** (then the user's UI language, then first track). A picker lets the user switch language; the chosen track is remembered for the **rest of the current video session** (in-memory, not persisted across page loads / sessions). |
| 5 | **Selection:** reuse the live-page highlight tool + color-swatch popup (yellow/red/green, recolor). |
| 6 | **Multiple per session:** user can make many highlights/comments in one `T` session. |
| 7 | **Comment trigger:** **both** — a "Comment" button in the swatch popup (fresh highlight) **and** double-click on any highlight (new or existing). |
| 8 | **Comment panel model:** evolve into a **per-video conversation** — a scrollable stack of **grouped thread cards** (one card = one annotation = its anchor + all its replies), focused thread expanded with reply box, scrolled to the active one. Mirrors the dashboard's grouping. |
| 9 | **Storage:** new `VideoItem` kind `'transcript'` in `video_annotations` (range + quoted text + color + anchor + `notes[]`). Dashboard renders it as a per-video card in video-time order. |
| 10 | **Inline persistence:** while scrolling the transcript panel, **all** of the video's saved transcript highlights (from any time, any session) are painted inline. |
| 11 | **Escape semantics:** Esc in the comment panel returns to the transcript panel; Esc again in the transcript panel saves everything and resumes the video. |

---

## 3. UX flow

### 3.1 Opening
- On a watch page, **`T`** → `prepareSession()`-style setup: pause video, record `videoTime`,
  `videoId`, `watchUrl`, fullscreen state; lock Escape if fullscreen (reuse existing helpers).
- Acquire the transcript (see §4). If unavailable → toast "No transcript for this video", abort.
- Build the **transcript panel** docked on the right (reuse overlay mounting / `positionRoot` /
  fullscreen mount target). Render the full transcript as paragraphs; auto-scroll so the line ~30s
  before `videoTime` is near the top, with the line at `videoTime` clearly marked (a "you are here"
  marker, reusing the active-line idea from `reader-transcript.ts`).
- Paint all previously-saved transcript highlights for this video inline (see §6.3).

### 3.2 Highlighting
- Selecting text in the panel shows the existing **color-swatch popup**. Picking a color creates a
  transcript highlight (default yellow); the popup also carries a **"Comment"** button (decision #7).
- A highlight's **time range** is derived from the caption cues it covers: `timeStart` = start of the
  first covered cue, `timeEnd` = end of the last covered cue. The **quoted text** is the exact
  selected substring.
- Multiple highlights can be made in one session; each is its own annotation/thread.

### 3.3 Commenting
- "Comment" button (fresh highlight) **or** double-click (any highlight) → open the **comment panel**
  (per-video conversation, §5), focused on that highlight's thread with the reply box active and the
  quoted transcript pinned above the input.
- Esc in the comment panel → return to the transcript panel (highlights from this session still
  present and painted).
- Repeat for other highlights.

### 3.4 Exiting
- Esc in the transcript panel (when no comment panel is open) → persist everything, tear down, resume
  the video if it was playing.
- The `✕` close buttons behave the same as Esc for their respective panels.

---

## 4. Transcript acquisition

A new module, e.g. `src/utils/video/youtube-transcript.ts`:

- Read `ytInitialPlayerResponse` from the page (already present on the watch page; fall back to a
  `<script>`/`window` scrape, or `ytcfg`/innertube if needed) →
  `captions.playerCaptionsTracklistRenderer.captionTracks[]`.
- **Track selection (decision #4a):** auto-pick order = non-ASR **English** → user's UI language →
  first available track. Expose the track list so the panel can show a small language **picker**;
  when the user switches, remember that `videoId → languageCode` choice **in memory for the current
  video session only** (cleared on page reload / videoId change — not persisted to settings). Fetch
  the chosen `baseUrl + "&fmt=json3"` and parse into normalized cues: `Cue = { index, start, dur,
  text }` (seconds).
- Cache fetched cues per `(videoId, languageCode)` for the session so reopening `T` or switching back
  is instant. Handle SPA navigation (videoId change) by invalidating both the cue cache and the
  remembered track choice — reuse `youtube-detect`'s SPA awareness.
- **Failure handling:** no `captionTracks`, fetch error, or empty parse → return `null`; caller shows
  the "no transcript" toast and aborts (decision #3).
- **Paragraph grouping:** auto-captions arrive as many tiny, overlapping cues. Group consecutive cues
  into readable paragraphs using sentence/pause boundaries (port the sentence-boundary helpers from
  `reader-transcript.ts` — `isSentBoundary`, CJK-aware — rather than re-inventing). Each paragraph
  retains the underlying cue spans so selection → time range still resolves per cue.

---

## 5. Comment panel — per-video conversation (the redesign)

Today (`video-annotator.ts`) the panel is bound to a single `item` and renders only `item.notes`.
We generalize it to a **per-video conversation** while preserving per-annotation grouping.

### 5.1 Structure
- The panel renders a scrollable, video-time-ordered list of **thread cards**, one per `VideoItem`
  that has comments (or is the freshly-focused one). A thread card = one group:
  - **Anchor header** (kind-specific):
    - `transcript` → colored quote block of the highlighted text + `M:SS–M:SS` range chip (chip
      seeks the player on click); color matches the highlight.
    - `frame` → frame thumbnail (larger when this thread is focused) + `M:SS` chip.
    - `note` → `M:SS` timestamp chip.
  - **Messages**: the existing bubble rendering (markdown via `renderNoteHtml`, "Show more" collapse,
    newest at bottom).
- The **focused** thread is expanded and shows the **reply box** with the anchor quote pinned above
  it (WhatsApp/Instagram reply affordance). Non-focused threads render compact/collapsed.
- Opening from any entry point (`S`, `N`, `T`-comment button, double-click, dashboard) sets the
  focused thread, scrolls it into view, and focuses its input.

### 5.2 Reply binding
- `postMessage()` appends to the **focused** thread's `item.notes` (not a single global `item`), then
  persists via `upsertVideoItem` / `updateVideoItemNotes`. The quote stays attached because it *is*
  the thread's anchor — stored on the item, shown in the card header, and persisted with the replies.

### 5.3 Migration of existing flows
- The `S` draw overlay (frame freeze + draw tools) is **unchanged**. Only its comment step now opens
  the conversation panel focused on the new frame's thread (frame shown prominently in that thread's
  header instead of the old big-left layout). `N` likewise opens the conversation focused on the new
  note. This is the one area that touches shipped behavior — call it out in review.
- Keep `renderNoteHtml`, `parseVideoNote`, `makeVideoNote`, collapse logic, and markdown editor
  shortcuts as-is.

---

## 6. Data model & persistence

### 6.1 New `VideoItem` kind
Extend `VideoItem` in `video-storage.ts`:

```ts
kind: 'frame' | 'note' | 'transcript';
// transcript-only fields:
timeStart?: number;     // = videoTime (reuse existing field as the range start; keeps time-sort working)
timeEnd?: number;       // end of last covered cue
quote?: string;         // exact highlighted transcript text
color?: VideoColor;     // highlight color (yellow|red|green)
anchor?: {              // for re-painting the highlight inline on reopen
  startCue: number; startOffset: number;
  endCue: number;   endOffset: number;
};
```
- `videoTime` continues to hold the range start so the existing `items.sort((a,b)=>a.videoTime-...)`
  ordering and dashboard timeline keep working with no change.
- Storage helpers (`upsertVideoItem`, `updateVideoItemNotes`, `removeVideoItem`) are reused as-is.

### 6.2 Anchoring
- Highlights are anchored by **cue index + char offset** within the cue text (`anchor` above), which
  is stable per video (cues come from the immutable caption track). On reopening `T`, re-resolve each
  saved transcript item against the freshly-fetched cues to paint it — no fragile XPath, unlike page
  highlights.

### 6.3 Inline rendering of existing highlights
- After rendering the transcript paragraphs, walk all `kind:'transcript'` items for the video and
  paint each `anchor` span in its `color`. Reuse the CSS Custom Highlight API styling already used by
  the page highlighter for visual consistency (yellow/red/green).
- These inline marks are clickable (double-click → comment thread) and visually distinct from the
  current-session, not-yet-saved selection.

### 6.4 New-highlight visual layer (decision rationale)
- We do **not** route transcript highlights through the page-highlight store (`highlights.ts`): that
  store anchors via XPath to the live page DOM and would entangle two stores and break on the
  panel's transient DOM. Instead we build a small transcript-scoped highlight layer that **reuses the
  swatch popup UI/CSS and the CSS Custom Highlight styling**, but stores into `video_annotations`
  keyed by cue+offset. Keeps both stores clean.

---

## 7. Dashboard rendering

- In `src/core/video-highlights.ts`, add a card variant for `kind:'transcript'`: a colored quote
  block of `quote`, a `M:SS–M:SS` range badge linking to the moment, and the comment thread beneath —
  same card family as frame/note, slotted into the existing per-video, time-ordered section.
- Export (JSON/Markdown) includes transcript items with their range + quote + replies.

---

## 8. Keyboard, focus & fullscreen

- Reuse `video-annotator.ts`'s `window`-capture `keydown` shielding so the panel's typing/keys don't
  leak to YouTube's shortcuts (Space, etc.), in windowed and fullscreen modes.
- Reuse `lockEscape()` / fullscreen mount target / `positionRoot` so the panel works in and out of
  fullscreen exactly like the frame overlay.
- Escape stack: comment panel open → Esc returns to transcript panel; transcript panel only → Esc
  saves + resumes. Track a simple "return target" so the comment panel knows whether it was opened
  from a `T` session (return to transcript) vs standalone `S`/`N`/dashboard (tear down/resume).
- `T` key + on/off toggle configurable under Highlighter settings, alongside `S`/`N`.

---

## 9. Edge cases & risks

- **No / ASR-only captions:** disable with toast (decision #3). ASR captions are noisy and
  over-segmented → paragraph grouping (§4) matters.
- **Non-English / multiple tracks:** pick sensibly; consider a future track-picker (out of scope v1).
- **Caption fetch CORS/format drift:** YouTube may change endpoints; isolate fetch+parse in one
  module so it's easy to repair. Fail soft to the toast.
- **SPA navigation** mid-session: invalidate transcript cache on videoId change.
- **Selection spanning paragraph/cue boundaries:** offsets must map back to cue indices correctly.
- **Migration risk:** the comment-panel generalization is the only change to already-shipped `S`/`N`
  behavior — verify those flows still work after the refactor.
- **Sync:** transcript items stay local-only (consistent with frames/notes); confirm they are not
  pushed through Drive sync.

---

## 10. Files (new & touched)

**New**
- `src/utils/video/youtube-transcript.ts` — fetch/parse/cache caption track → cues; paragraph grouping.
- `src/utils/video/transcript-panel.ts` — the right-side transcript panel: render, scroll-to-30s,
  selection → swatch → highlight, inline repaint of saved highlights, double-click → comment.
- SCSS for the transcript panel (alongside existing `ob-vid-*` styles).

**Touched**
- `src/utils/video/video-storage.ts` — extend `VideoItem` (kind + transcript fields); helpers reused.
- `src/utils/video/video-annotator.ts` — generalize comment panel to per-video conversation; add a
  "return target"; wire the transcript-comment entry points.
- `src/utils/video/video-notes.ts` — anchor-header rendering helpers if needed (reuse rendering).
- `src/content.ts` — register the `T` key, lazy-load the transcript panel module.
- `src/core/video-highlights.ts` + `src/highlights.html`/SCSS — dashboard card variant for transcript.
- Settings UI (`settings.html` + highlighter settings manager) — `T` key + on/off toggle.
- `AGENTS.md` — document the feature once shipped; add `T` to the shortcut table.

---

## 11. Build & verification

- Per repo convention, rebuild after changes: `npm run build:chrome` (and the other targets when
  shipping). Reload the unpacked extension.
- Manual verification (use the `verify`/`run` flow): lecture with captions — `T` opens panel at ~30s
  back; highlight a line (color swatch works); comment button + double-click both open the right
  thread; multiple highlights in one session; Esc returns then saves+resumes; reopen `T` shows saved
  highlights inline; dashboard shows transcript cards with range + quote + thread; video with no
  captions shows the toast; fullscreen and windowed both work.

---

## 12. Open questions (for review, not blocking the plan)

Resolved:
- **Track selection** — auto-pick English by default with an in-panel picker; remember the choice for
  the current video session only (decisions #4a / §4).
- **"30s behind"** — fixed at 30s (decision #4).

Still open:
- Should the focused frame thread keep a *large* preview (closer to today's big-left frame) or a
  modest thumbnail? Affects how much the shipped `S` comment UX changes.
