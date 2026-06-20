const fs = require('fs');

let driveTs = fs.readFileSync('clipper-annotations-plugin/src/drive.ts', 'utf8');

driveTs = driveTs.replace(
` * Auth uses Google's **OAuth 2.0 Device Authorization flow** (the "TV & limited
 * input" grant): the plugin shows a short code + URL, the user approves in any
 * browser, and the plugin polls for tokens. This needs no redirect URI, no local
 * server, and works on desktop *and* mobile — unlike the extension's
 * \`browser.identity\` flow, which isn't available in Obsidian.`,
` * Auth uses Google's **OAuth 2.0 Authorization Code flow** (Desktop app):
 * The plugin opens the browser for authorization, the user approves, and the
 * browser redirects to a local dead-end URL (127.0.0.1). The user copies that
 * URL and pastes it back into the plugin to complete the login. This works
 * on both desktop and mobile without requiring a local HTTP server.`);

driveTs = driveTs.replace(
` * SETUP (one-time, by the user): in the same Google Cloud project as the
 * extension, create an OAuth client of type **"TV and Limited Input devices"**,
 * enable the Drive API, and add the drive.appdata scope. Paste that client id
 * (and the limited-input client secret — not confidential for installed apps)`,
` * SETUP (one-time, by the user): in the same Google Cloud project as the
 * extension, create an OAuth client of type **"Desktop app"**, enable the
 * Drive API, and add the drive.appdata scope. Paste that client id
 * (and the desktop client secret — not confidential for installed apps)`);

driveTs = driveTs.replace(`const DEVICE_CODE_ENDPOINT = 'https://oauth2.googleapis.com/device/code';`, `const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';`);

driveTs = driveTs.replace(
`export interface DeviceCode {
	device_code: string;
	user_code: string;
	verification_url: string;
	interval: number;
	expires_in: number;
}`,
`export interface AuthCodeRequest {
	authUrl: string;
	codeVerifier: string;
}`);

driveTs = driveTs.replace(
`	// --- device-flow auth ----------------------------------------------------

	/** Step 1: request a device + user code to display to the user. */
	async requestDeviceCode(): Promise<DeviceCode> {
		const res = await requestUrl({
			url: DEVICE_CODE_ENDPOINT,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: form({ client_id: this.clientId, scope: SCOPE }),
			throw: false,
		});
		if (res.status >= 400) throw new Error(\`Device code request failed (\${res.status}): \${res.text.slice(0, 200)}\`);
		return res.json as DeviceCode;
	}

	/**
	 * Step 2: poll until the user approves (or it times out). Resolves once tokens
	 * are stored. \`onTick\` lets the UI keep the modal responsive.
	 */
	async pollForTokens(device: DeviceCode, onTick?: () => boolean): Promise<void> {
		const deadline = Date.now() + device.expires_in * 1000;
		let interval = Math.max(device.interval || 5, 1);
		// eslint-disable-next-line no-constant-condition
		while (Date.now() < deadline) {
			if (onTick && onTick() === false) throw new Error('Authorization cancelled.');
			await sleep(interval * 1000);
			const res = await requestUrl({
				url: TOKEN_ENDPOINT,
				method: 'POST',
				contentType: 'application/x-www-form-urlencoded',
				body: form({
					client_id: this.clientId,
					client_secret: this.clientSecret,
					device_code: device.device_code,
					grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
				}),
				throw: false,
			});
			const data = res.json as Record<string, string | number>;
			if (res.status < 400 && data.access_token) {
				await this.auth.setTokens({
					accessToken: data.access_token as string,
					refreshToken: data.refresh_token as string | undefined,
					expiresAt: Date.now() + ((data.expires_in as number) - 60) * 1000,
				});
				return;
			}
			const err = data.error as string | undefined;
			if (err === 'authorization_pending') continue;
			if (err === 'slow_down') {
				interval += 5;
				continue;
			}
			throw new Error(\`Authorization failed: \${err || res.status}\`);
		}
		throw new Error('Authorization timed out. Please try again.');
	}`,
`	// --- manual auth-code flow -----------------------------------------------

	private async generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
		const array = new Uint8Array(32);
		window.crypto.getRandomValues(array);
		const verifier = btoa(String.fromCharCode(...array)).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
		const buffer = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
		const challenge = btoa(String.fromCharCode(...new Uint8Array(buffer))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
		return { codeVerifier: verifier, codeChallenge: challenge };
	}

	/** Step 1: Generate the auth URL for the user to open. */
	async requestAuthCode(): Promise<AuthCodeRequest> {
		const { codeVerifier, codeChallenge } = await this.generatePkce();
		const params = new URLSearchParams({
			client_id: this.clientId,
			redirect_uri: 'http://127.0.0.1',
			response_type: 'code',
			scope: SCOPE,
			code_challenge: codeChallenge,
			code_challenge_method: 'S256',
			access_type: 'offline',
			prompt: 'consent'
		});
		return { authUrl: \`\${AUTH_ENDPOINT}?\${params.toString()}\`, codeVerifier };
	}

	/** Step 2: Exchange the pasted code for tokens. */
	async exchangeCode(code: string, codeVerifier: string): Promise<void> {
		const res = await requestUrl({
			url: TOKEN_ENDPOINT,
			method: 'POST',
			contentType: 'application/x-www-form-urlencoded',
			body: form({
				client_id: this.clientId,
				client_secret: this.clientSecret,
				code,
				code_verifier: codeVerifier,
				redirect_uri: 'http://127.0.0.1',
				grant_type: 'authorization_code',
			}),
			throw: false,
		});
		if (res.status >= 400) throw new Error(\`Code exchange failed (\${res.status}): \${res.text.slice(0, 200)}\`);
		const data = res.json as Record<string, string | number>;
		if (data.access_token) {
			await this.auth.setTokens({
				accessToken: data.access_token as string,
				refreshToken: data.refresh_token as string | undefined,
				expiresAt: Date.now() + ((data.expires_in as number) - 60) * 1000,
			});
		} else {
			throw new Error('No access token returned.');
		}
	}`);

fs.writeFileSync('clipper-annotations-plugin/src/drive.ts', driveTs);

let mainTs = fs.readFileSync('clipper-annotations-plugin/src/main.ts', 'utf8');

mainTs = mainTs.replace(
`import { DriveClient, ConflictError, type DeviceCode, type DriveAuthStore, type DriveTokens } from './drive';`,
`import { DriveClient, ConflictError, type AuthCodeRequest, type DriveAuthStore, type DriveTokens } from './drive';`
);

mainTs = mainTs.replace(
`	async connectDrive(): Promise<void> {
		const drive = this.driveClient();
		if (!drive.isConfigured()) {
			new Notice('Add your Google OAuth client id in settings first.');
			return;
		}
		try {
			const device = await drive.requestDeviceCode();
			const modal = new DeviceCodeModal(this.app, device);
			modal.open();
			try {
				await drive.pollForTokens(device, () => !modal.cancelled);
				new Notice('Connected to Google Drive.');
				await this.syncNow(true);
			} finally {
				modal.close();
			}
		} catch (err) {
			new Notice(\`Drive connect failed: \${err instanceof Error ? err.message : String(err)}\`);
		}
	}`,
`	async connectDrive(): Promise<void> {
		const drive = this.driveClient();
		if (!drive.isConfigured()) {
			new Notice('Add your Google OAuth client id in settings first.');
			return;
		}
		try {
			const req = await drive.requestAuthCode();
			const modal = new AuthCodeModal(this.app, req.authUrl, async (code) => {
				try {
					await drive.exchangeCode(code, req.codeVerifier);
					new Notice('Connected to Google Drive.');
					await this.syncNow(true);
				} catch (err) {
					new Notice(\`Drive connect failed: \${err instanceof Error ? err.message : String(err)}\`);
				}
			});
			modal.open();
		} catch (err) {
			new Notice(\`Drive connect failed: \${err instanceof Error ? err.message : String(err)}\`);
		}
	}`
);

mainTs = mainTs.replace(
`/** Shows the device + user code while the plugin polls Google for approval. */
class DeviceCodeModal extends Modal {
	cancelled = false;
	private device: DeviceCode;

	constructor(app: import('obsidian').App, device: DeviceCode) {
		super(app);
		this.device = device;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Connect Google Drive' });
		contentEl.createEl('p', { text: 'Open this URL and enter the code to authorize:' });
		const url = this.device.verification_url;
		contentEl.createEl('a', { text: url, href: url, attr: { target: '_blank' } });
		const code = contentEl.createEl('div', { text: this.device.user_code });
		code.style.fontSize = '1.8em';
		code.style.fontWeight = '700';
		code.style.letterSpacing = '0.15em';
		code.style.margin = '14px 0';
		contentEl.createEl('p', {
			cls: 'setting-item-description',
			text: 'Waiting for approval… this dialog closes automatically once you confirm.',
		});
	}

	onClose(): void {
		this.cancelled = true;
		this.contentEl.empty();
	}
}`,
`/** Asks the user to paste the redirect URL or auth code. */
class AuthCodeModal extends Modal {
	private authUrl: string;
	private onSubmit: (code: string) => void;

	constructor(app: import('obsidian').App, authUrl: string, onSubmit: (code: string) => void) {
		super(app);
		this.authUrl = authUrl;
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Connect Google Drive' });
		
		const p1 = contentEl.createEl('p', { text: '1. Open this authorization link in your browser:' });
		p1.style.marginBottom = '4px';
		const link = contentEl.createEl('a', { text: 'Click here to authorize with Google', href: this.authUrl, attr: { target: '_blank' } });
		link.style.display = 'block';
		link.style.marginBottom = '16px';

		const p2 = contentEl.createEl('p', { text: '2. After you approve, your browser will redirect to a page that says "Site can\\'t be reached" (127.0.0.1). That is normal!' });
		p2.style.marginBottom = '8px';

		const p3 = contentEl.createEl('p', { text: '3. Copy the ENTIRE URL from your browser\\'s address bar and paste it below:' });
		p3.style.marginBottom = '8px';

		const input = contentEl.createEl('input', { type: 'text', placeholder: 'http://127.0.0.1/?code=4/0A...' });
		input.style.width = '100%';
		input.style.marginBottom = '16px';

		const btn = contentEl.createEl('button', { text: 'Connect', cls: 'mod-cta' });
		btn.onclick = () => {
			const val = input.value.trim();
			let code = val;
			try {
				if (val.startsWith('http')) {
					const url = new URL(val);
					code = url.searchParams.get('code') || val;
				}
			} catch { /* ignore */ }
			
			if (!code) return;
			this.onSubmit(code);
			this.close();
		};
	}

	onClose(): void {
		this.contentEl.empty();
	}
}`
);

fs.writeFileSync('clipper-annotations-plugin/src/main.ts', mainTs);

