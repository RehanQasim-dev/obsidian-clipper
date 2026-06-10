# Google Drive Sync — Setup

This fork can sync your highlights, comments, and pencil drawings to your **own**
Google Drive, so annotations follow you across browsers and machines. Data lives in
a hidden, app-only folder (`appDataFolder`) — it never clutters your normal Drive.

You only need to do this **once**. It's free.

## 1. Create a Google Cloud project + enable the Drive API

1. Go to <https://console.cloud.google.com/> and create a new project (any name).
2. **APIs & Services → Library** → search **Google Drive API** → **Enable**.

## 2. Configure the OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External** → Create.
3. Fill in app name + your email where required. Save.
4. **Audience / Test users**: add your own Google account email as a **Test user**.
   (Personal use stays in "testing" mode — no Google verification needed.)
5. Scopes: you don't need to add any here; the extension requests
   `drive.appdata` at sign-in.

## 3. Create the OAuth Client ID

1. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Under **Authorized redirect URIs**, add the redirect URI(s) for the browsers
   you'll use:
   - **Chrome** (this build uses a fixed extension id):
     `https://cgldpjhhpjhpcfbnnbgdkfmimkchihie.chromiumapp.org/`
   - **Firefox**: load the extension, open the background console, and copy the
     line `[Obsidian Clipper sync] OAuth redirect URI to register: ...`, then add
     that value here too.
4. Create, then copy the **Client ID** (looks like
   `1234567890-abcdef….apps.googleusercontent.com`).

> The Chrome redirect URI above is fixed because `src/manifest.chrome.json`
> includes a `key`, which pins the extension id to
> `cgldpjhhpjhpcfbnnbgdkfmimkchihie` on every machine. You do **not** need the
> generated private key for unpacked installs — the public `key` in the manifest
> is enough.

## 4. Paste the Client ID into the extension

Open `src/utils/google-drive.ts` and set:

```ts
export const GOOGLE_CLIENT_ID = '<your-client-id>.apps.googleusercontent.com';
```

Then rebuild:

```bash
npm run build:chrome   # and/or: npm run build:firefox
```

Load the build unpacked (`dist/` for Chrome, `dist_firefox/` for Firefox).

## 5. Connect

Open the extension **Settings → Sync → Connect Google Drive**, approve the consent
window, and you're done. Annotations now push automatically (debounced) and pull on
a timer / page focus; there's also a **Sync now** button.

Repeat step 5 on every other browser/machine (same Client ID, same Google account).

## How conflicts are resolved

- New comments added on two devices → **both** are kept.
- The same comment/highlight/drawing edited on two devices → the **most recent edit
  wins** (by timestamp).
- Deletions stick (tombstones), so deleting on one device won't be undone by another.

## Notes & limits

- Scope `drive.appdata` only — the extension can never see your other Drive files.
- Nothing secret ships in the extension (implicit OAuth grant, no client secret).
- Safari support for the OAuth flow is unreliable; Chrome and Firefox are the
  supported targets.
