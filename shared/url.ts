// Canonical URL normalization shared by EVERY client (browser extension +
// Obsidian plugin). The normalized URL is the only key linking a note to its
// annotations, so all clients MUST compute it identically — historically the
// extension and the plugin had divergent copies (different param sets, one
// stripped trailing slashes and one didn't), which silently produced different
// keys for the same page and made annotations fail to match.
//
// This module is the single source of truth. It is intentionally dependency-free
// (no DOM, no extension globals) so it can be bundled into the service worker,
// the content script, and the Obsidian plugin alike.
//
// NOTE: the rules here match the browser extension's long-standing behavior
// (KEEP trailing slash, strip the ephemeral params below) so that existing
// stored highlights keep their keys; the plugin conforms to this.

export const EPHEMERAL_PARAMS = new Set([
	't',           // YouTube timestamp
	'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', // UTM tracking
	'ref', 'ref_src', 'source', 'src',   // Referral
	'fbclid', 'gclid', 'dclid', 'msclkid', 'twclid', // Ad click IDs
	'mc_cid', 'mc_eid',       // Mailchimp
	'_ga', '_gl',             // Google Analytics
	'si',                     // YouTube share tracking
]);

export function normalizeUrl(url: string): string {
	try {
		const parsed = new URL(url);
		// Strip fragment identifiers — highlights on /page#section should
		// match /page (fixes #652).
		parsed.hash = '';
		const params = new URLSearchParams(parsed.search);
		for (const key of [...params.keys()]) {
			if (EPHEMERAL_PARAMS.has(key)) {
				params.delete(key);
			}
		}
		parsed.search = params.toString();
		return parsed.toString();
	} catch {
		return url;
	}
}
