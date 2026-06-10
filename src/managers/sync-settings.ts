import browser from '../utils/browser-polyfill';
import { getMessage } from '../utils/i18n';

// Settings UI for Google Drive annotation sync. All real work happens in the
// background service worker (sync-engine / google-drive); this module only sends
// it messages and reflects status in the DOM.

interface SyncStatus {
	connected: boolean;
	lastSyncedAt?: number;
	lastError?: string;
	syncing?: boolean;
}
interface SyncResponse {
	success: boolean;
	error?: string;
	status: SyncStatus;
	configured: boolean;
	redirectUrl: string;
}

async function send(action: string): Promise<SyncResponse> {
	return (await browser.runtime.sendMessage({ action })) as SyncResponse;
}

function formatLastSynced(ts?: number): string {
	if (!ts) return '';
	const d = new Date(ts);
	return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export async function initializeSyncSettings(): Promise<void> {
	const connectBtn = document.getElementById('sync-connect-btn') as HTMLButtonElement | null;
	const disconnectBtn = document.getElementById('sync-disconnect-btn') as HTMLButtonElement | null;
	const syncNowBtn = document.getElementById('sync-now-btn') as HTMLButtonElement | null;
	const statusEl = document.getElementById('sync-status');
	const setupNote = document.getElementById('sync-setup-note');
	const redirectEl = document.getElementById('sync-redirect-uri');
	if (!connectBtn || !disconnectBtn || !syncNowBtn || !statusEl) return;

	function render(res: SyncResponse): void {
		const { status, configured, redirectUrl } = res;

		if (setupNote) setupNote.style.display = configured ? 'none' : '';
		if (redirectEl) redirectEl.textContent = redirectUrl || '';

		connectBtn!.disabled = !configured;
		connectBtn!.style.display = status.connected ? 'none' : '';
		disconnectBtn!.style.display = status.connected ? '' : 'none';
		syncNowBtn!.style.display = status.connected ? '' : 'none';

		if (!configured) {
			statusEl!.textContent = getMessage('syncNotConfigured') || 'Sync is not configured in this build.';
			return;
		}
		if (res.error) {
			statusEl!.textContent = `${getMessage('syncError') || 'Sync error'}: ${res.error}`;
		} else if (status.syncing) {
			statusEl!.textContent = getMessage('syncInProgress') || 'Syncing…';
		} else if (status.connected) {
			const when = formatLastSynced(status.lastSyncedAt);
			statusEl!.textContent = when
				? `${getMessage('syncLastSynced') || 'Last synced'}: ${when}`
				: getMessage('syncConnected') || 'Connected.';
		} else {
			statusEl!.textContent = getMessage('syncNotConnected') || 'Not connected.';
		}
	}

	async function refresh(): Promise<void> {
		try {
			render(await send('syncStatus'));
		} catch (err) {
			statusEl!.textContent = err instanceof Error ? err.message : String(err);
		}
	}

	function withBusy(btn: HTMLButtonElement, action: string): void {
		btn.addEventListener('click', async () => {
			const original = btn.textContent;
			btn.disabled = true;
			btn.textContent = getMessage('syncInProgress') || 'Working…';
			try {
				render(await send(action));
			} catch (err) {
				statusEl!.textContent = err instanceof Error ? err.message : String(err);
			} finally {
				btn.textContent = original;
				btn.disabled = false;
			}
		});
	}

	withBusy(connectBtn, 'syncConnect');
	withBusy(disconnectBtn, 'syncDisconnect');
	withBusy(syncNowBtn, 'syncNow');

	await refresh();
}
