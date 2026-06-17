import browser from '../utils/browser-polyfill';

// Settings UI for Obsidian (Local REST API) sync. All real work happens in the
// background service worker (obsidian-sync / obsidian-rest); this module reads/
// writes config and reflects status.

interface ObsidianConfig {
	enabled: boolean;
	baseUrl: string;
	apiKey: string;
	folder: string;
	theme: 'cards' | 'document';
}
interface ObsidianStatus {
	enabled: boolean;
	syncing?: boolean;
	offline?: boolean;
	lastSyncedAt?: number;
	lastError?: string;
	pending: number;
}
interface ObsidianResponse {
	success: boolean;
	error?: string;
	config: ObsidianConfig;
	status: ObsidianStatus;
	test?: { ok: boolean; message: string };
}

async function send(action: string, extra: Record<string, unknown> = {}): Promise<ObsidianResponse> {
	return (await browser.runtime.sendMessage({ action, ...extra })) as ObsidianResponse;
}

function formatWhen(ts?: number): string {
	if (!ts) return '';
	const d = new Date(ts);
	return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

export async function initializeObsidianSyncSettings(): Promise<void> {
	const enabledEl = document.getElementById('obsidian-sync-enabled') as HTMLInputElement | null;
	const baseUrlEl = document.getElementById('obsidian-sync-baseurl') as HTMLInputElement | null;
	const apiKeyEl = document.getElementById('obsidian-sync-apikey') as HTMLInputElement | null;
	const folderEl = document.getElementById('obsidian-sync-folder') as HTMLInputElement | null;
	const themeEl = document.getElementById('obsidian-sync-theme') as HTMLSelectElement | null;
	const testBtn = document.getElementById('obsidian-sync-test-btn') as HTMLButtonElement | null;
	const syncAllBtn = document.getElementById('obsidian-sync-all-btn') as HTMLButtonElement | null;
	const statusEl = document.getElementById('obsidian-sync-status');
	if (!enabledEl || !baseUrlEl || !apiKeyEl || !folderEl || !themeEl || !testBtn || !syncAllBtn || !statusEl) return;

	function renderStatus(res: ObsidianResponse): void {
		if (res.test) {
			statusEl!.textContent = res.test.message;
			return;
		}
		const s = res.status;
		const pend = s.pending > 0 ? ` (${s.pending} pending)` : '';
		if (res.error) statusEl!.textContent = `Error: ${res.error}`;
		else if (s.syncing) statusEl!.textContent = 'Syncing…';
		else if (s.lastError) statusEl!.textContent = `Error${pend}: ${s.lastError}`;
		else if (s.offline && s.pending > 0) statusEl!.textContent = `Obsidian not reachable — ${s.pending} queued, will retry.`;
		else if (s.pending > 0) statusEl!.textContent = `${s.pending} pending…`;
		else if (s.lastSyncedAt) statusEl!.textContent = `Last synced: ${formatWhen(s.lastSyncedAt)}`;
		else statusEl!.textContent = s.enabled ? 'Enabled.' : 'Disabled.';
	}

	function applyConfig(cfg: ObsidianConfig): void {
		enabledEl!.checked = cfg.enabled;
		baseUrlEl!.value = cfg.baseUrl;
		apiKeyEl!.value = cfg.apiKey;
		folderEl!.value = cfg.folder;
		themeEl!.value = cfg.theme || 'cards';
	}

	async function saveConfig(): Promise<void> {
		const res = await send('obsidianSetConfig', {
			config: {
				enabled: enabledEl!.checked,
				baseUrl: baseUrlEl!.value.trim(),
				apiKey: apiKeyEl!.value.trim(),
				folder: folderEl!.value.trim() || 'Clippings',
				theme: (themeEl!.value === 'document' ? 'document' : 'cards'),
			},
		});
		renderStatus(res);
	}

	enabledEl.addEventListener('change', saveConfig);
	themeEl.addEventListener('change', saveConfig);
	for (const el of [baseUrlEl, apiKeyEl, folderEl]) el.addEventListener('change', saveConfig);

	testBtn.addEventListener('click', async () => {
		await saveConfig();
		statusEl!.textContent = 'Testing…';
		renderStatus(await send('obsidianTest'));
	});

	syncAllBtn.addEventListener('click', async () => {
		await saveConfig();
		statusEl!.textContent = 'Syncing all…';
		renderStatus(await send('obsidianSyncAll'));
	});

	const init = await send('obsidianGetConfig');
	applyConfig(init.config);
	renderStatus(init);
}
