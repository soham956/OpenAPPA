# Drive setup

Clearance works in one Google Drive folder (the **root**) and the three subfolders it creates there: `Legal`, `Accounting` and `High Risk`. It never reads or changes anything outside that tree.

Everything below lives at the **repo root** (one level above `clearance/`). Both `.env` and `secrets/` are git-ignored, so never commit either.

## 1. The folder

1. Create an empty folder in Drive, in My Drive or a Shared Drive.
2. Open it. The folder ID is the last part of the URL: `https://drive.google.com/drive/folders/<FOLDER_ID>`.
3. In the repo-root `.env`, set `GDRIVE_ROOT_FOLDER_ID=<FOLDER_ID>`.

## 2. Choose the auth mode

You choose the mode with `GDRIVE_AUTH` in `.env`. Switching needs no code change.

### `GDRIVE_AUTH=oauth` (default)

1. In Google Cloud Console, enable the **Google Drive API** for the project.
2. Set the OAuth consent screen to **Internal** (Workspace), or to External with yourself as a test user.
3. Go to **Credentials**, then **Create credentials**, then **OAuth client ID**, and choose **Desktop app**. Download the JSON.
4. Save it as `secrets/gdrive-oauth-client.json`. Its top-level key must be `installed`. A "Web application" client is refused.
5. From `clearance/`, run `npm run drive:check` once. This is the only command that opens the browser:
   - It starts a one-off server on `http://127.0.0.1:<random port>`. It prints `Sign in to Google Drive in your browser. If it does not open, visit:` followed by the consent URL, and opens your default browser.
   - Sign in, and allow **See, edit, create and delete all of your Google Drive files** (scope `https://www.googleapis.com/auth/drive`).
   - The browser then shows `Clearance is signed in to Google Drive. You can close this tab.` The terminal shows `Saved the Drive token to …/secrets/gdrive-token.json.`, then the check output.
   - If you don't finish within 5 minutes, the command stops with `Timed out waiting for Google sign-in in the browser.`
6. Later runs use the cached token (`secrets/gdrive-token.json`, mode 600) and need no browser. When the token is refreshed, the new one is written back to that file.

Every other command (`npm start`, `reset`, `drop`) refuses to run without the token and tells you to run `npm run drive:check`. To sign in again, delete `secrets/gdrive-token.json` and run `drive:check`.

The redirect URI is `http://127.0.0.1:<port>`. Google accepts any loopback port for Desktop-app clients, so you don't need to register one.

### `GDRIVE_AUTH=service-account`

1. Create a service account, then add a key and choose JSON. Save the key as `secrets/gdrive-sa.json`.
2. Share the root folder with the service account's `client_email`, as **Editor**. For a Shared Drive, add the account as a member instead.
3. Run `npm run drive:check`. No browser is involved.

A service account in My Drive has no storage quota of its own, so uploads (`reset`, `drop`) may fail. Use a Shared Drive, or use `oauth`.

## 3. Check

```
npm run drive:check
```

This command lists the files in the root and creates `Legal/`, `Accounting/` and `High Risk/` if they are missing. Running it again changes nothing. It ends with `drive:check OK`.

## Errors

| Message | Fix |
|---|---|
| `GDRIVE_ROOT_FOLDER_ID is not set` | Set it in the repo-root `.env` (step 1). |
| `OAuth client JSON not found at …` | Save the Desktop-app JSON as `secrets/gdrive-oauth-client.json`. |
| `… is not a Desktop-app OAuth client` | Create a **Desktop app** client, not a Web application client. |
| `No Drive OAuth token at …` | Run `npm run drive:check` once and sign in. |
| `The Drive token at … is not valid JSON` | Delete `secrets/gdrive-token.json` and run `drive:check` again. |
| `Service account key not found at …` | Save the key as `secrets/gdrive-sa.json`, or switch to `GDRIVE_AUTH=oauth`. |
| `Google sign-in was not completed: access_denied` | Run `drive:check` again and choose Allow. |
