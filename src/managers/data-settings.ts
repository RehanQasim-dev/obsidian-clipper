import browser from '../utils/browser-polyfill';

// Settings UI for the destructive data wipes (Settings → Data). The actual work
// runs in the background service worker (Drive API / storage.local / IndexedDB);
// this module only confirms intent and sends the message.

function confirmPhrase(phrase: string): boolean {
	const typed = window.prompt(
		`This permanently deletes data and cannot be undone.\n\nType "${phrase}" to confirm:`,
	);
	return typed?.trim().toLowerCase() === phrase.toLowerCase();
}

export function initializeDataSettings(): void {
	const driveBtn = document.getElementById('wipe-drive-btn') as HTMLButtonElement | null;
	const localBtn = document.getElementById('wipe-local-btn') as HTMLButtonElement | null;
	const statusEl = document.getElementById('wipe-status');
	if (!driveBtn || !localBtn || !statusEl) return;

	const setStatus = (msg: string, isError = false): void => {
		statusEl.textContent = msg;
		statusEl.style.color = isError ? 'var(--text-error, #c0392b)' : '';
	};

	async function wipe(btn: HTMLButtonElement, action: string, phrase: string, working: string, done: string): Promise<void> {
		if (!confirmPhrase(phrase)) { setStatus('Cancelled.'); return; }
		const original = btn.textContent;
		btn.disabled = true;
		btn.textContent = working;
		setStatus(working);
		try {
			const res = (await browser.runtime.sendMessage({ action })) as { success?: boolean; count?: number; error?: string } | undefined;
			if (res?.success) {
				const n = res.count ?? 0;
				setStatus(`${done} — ${n} item${n === 1 ? '' : 's'} removed.`);
			} else {
				setStatus(`Error: ${res?.error || 'unknown error'}`, true);
			}
		} catch (err) {
			setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
		} finally {
			btn.disabled = false;
			btn.textContent = original;
		}
	}

	driveBtn.addEventListener('click', () => wipe(driveBtn, 'wipeDriveData', 'delete drive data', 'Deleting Drive data…', 'Google Drive data deleted'));
	localBtn.addEventListener('click', () => wipe(localBtn, 'wipeLocalData', 'delete local data', 'Deleting local data…', 'Local data deleted'));
}
