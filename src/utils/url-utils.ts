// URL normalization for the extension. The actual logic lives in the neutral
// `shared/url` module so the Obsidian plugin uses byte-for-byte the same rules
// (the normalized URL is the cross-surface key, so any divergence silently
// breaks matching). Kept as a thin re-export so existing extension imports of
// `./url-utils` keep working — and so background-only code can normalize URLs
// WITHOUT importing highlighter.ts (which drags highlighter-overlays and its
// top-level `window` listeners into the service worker and crashes it).

export { normalizeUrl, EPHEMERAL_PARAMS } from '../../shared/url';
