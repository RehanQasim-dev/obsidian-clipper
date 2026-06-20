import { App, PluginSettingTab, Setting } from 'obsidian';
import type ClipperAnnotationsPlugin from './main';
import type { HighlightColor } from './store';

export interface ClipperAnnotationSettings {
	/** Open the comments panel automatically when a clipped note is in reading view. */
	autoOpenPanel: boolean;
	/** Color used by the "Comment" action and as the initial swatch default. */
	defaultColor: HighlightColor;
	/** Comma-separated frontmatter keys to read the source URL from, in priority order. */
	sourceKeys: string;
	/** Google OAuth client id (type "TV and Limited Input devices") for Drive sync. */
	driveClientId: string;
	/** The limited-input client secret (not confidential for installed apps). */
	driveClientSecret: string;
}

export const DEFAULT_SETTINGS: ClipperAnnotationSettings = {
	autoOpenPanel: true,
	defaultColor: 'yellow',
	sourceKeys: 'source, url',
	driveClientId: '',
	driveClientSecret: '',
};

export class ClipperSettingTab extends PluginSettingTab {
	plugin: ClipperAnnotationsPlugin;

	constructor(app: App, plugin: ClipperAnnotationsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName('Auto-open comments panel')
			.setDesc('Open the comments panel automatically when a clipped source note is shown in reading view.')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.autoOpenPanel).onChange(async (v) => {
					this.plugin.settings.autoOpenPanel = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Default highlight color')
			.setDesc('Color used by the "Comment" shortcut.')
			.addDropdown((d) =>
				d
					.addOptions({ yellow: 'Yellow', red: 'Red', green: 'Green' })
					.setValue(this.plugin.settings.defaultColor)
					.onChange(async (v) => {
						this.plugin.settings.defaultColor = v as HighlightColor;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName('Source URL frontmatter keys')
			.setDesc('Comma-separated frontmatter keys to read the page URL from, highest priority first.')
			.addText((t) =>
				t.setValue(this.plugin.settings.sourceKeys).onChange(async (v) => {
					this.plugin.settings.sourceKeys = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName('Google Drive sync').setHeading();
		containerEl.createEl('p', {
			cls: 'setting-item-description',
			text:
				'Shares the same clipper-sync.json as the Web Clipper extension, so highlights and comments round-trip between live web pages and notes. Create an OAuth client of type "TV and Limited Input devices" in the same Google Cloud project, then paste its id and secret below and use "Connect".',
		});

		new Setting(containerEl)
			.setName('OAuth client id')
			.addText((t) =>
				t.setValue(this.plugin.settings.driveClientId).onChange(async (v) => {
					this.plugin.settings.driveClientId = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('OAuth client secret')
			.addText((t) => {
				t.inputEl.type = 'password';
				t.setValue(this.plugin.settings.driveClientSecret).onChange(async (v) => {
					this.plugin.settings.driveClientSecret = v;
					await this.plugin.saveSettings();
				});
			});

		const status = this.plugin.driveConnected() ? 'Connected' : 'Not connected';
		new Setting(containerEl)
			.setName('Connection')
			.setDesc(status)
			.addButton((b) =>
				b.setButtonText(this.plugin.driveConnected() ? 'Reconnect' : 'Connect').onClick(async () => {
					await this.plugin.connectDrive();
					this.display();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText('Sync now')
					.setCta()
					.onClick(() => this.plugin.syncNow(true)),
			)
			.addExtraButton((b) =>
				b
					.setIcon('log-out')
					.setTooltip('Disconnect')
					.onClick(async () => {
						await this.plugin.disconnectDrive();
						this.display();
					}),
			);

		const syncDesc = document.createDocumentFragment();
		syncDesc.append(
			'It automatically runs this two-way sync on these occasions:',
			syncDesc.createEl('br'),
			'1. On Startup: The moment you open the Obsidian app.',
			syncDesc.createEl('br'),
			'2. On Window Focus: Whenever you click back into the Obsidian window after using another app (like your browser).',
			syncDesc.createEl('br'),
			'3. Every 60 Seconds: In the background automatically while Obsidian is open.',
			syncDesc.createEl('br'),
			'4. Manually: Whenever you click the "Sync now" button.'
		);

		new Setting(containerEl)
			.setName('Sync schedule')
			.setDesc(syncDesc);
	}
}
