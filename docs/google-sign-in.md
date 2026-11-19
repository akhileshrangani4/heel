# Set up Google sign-in for heel

[README](../README.md) · [Using heel](using-heel.md) · [Running](running.md)

Gmail and Google Calendar accounts sign in to heel through your own Google OAuth client, so you need to create one first. Setting it up takes about 5 minutes, once, in the Google Cloud console. One client covers every Gmail and Calendar account you connect.

Why your own client: heel is self-hosted, so there is no shared heel app at Google. Your client is yours alone, and the tokens it gets stay in your heel's vault.

**You'll need:**

- heel installed and running (the [quick start](../README.md#quick-start)), with a passkey enrolled.
- The Google account you'll connect. A personal Gmail account works.
- The address you open heel's approval page at. That's `http://localhost:7301` unless you set `public_url` in `heel.yaml`.

**The short version:** create a Google Cloud project, turn on the Gmail API (and the Google Calendar API), set up the consent screen and add yourself as a test user, create a "Web application" client with heel's redirect URI, put the client ID in `heel.yaml` and the secret in a file, restart heel, then sign in from the Connections page.

## 1. Work out your redirect URI

Google sends you back to heel at this address after you sign in, and only to addresses you list on the client. heel builds it from `public_url`:

```
<public_url>/oauth/google/callback
```

| Your setup | Redirect URI |
| --- | --- |
| Default (no `public_url` set) | `http://localhost:7301/oauth/google/callback` |
| `public_url: https://heel.example.com` | `https://heel.example.com/oauth/google/callback` |
| Tailscale, `public_url: https://mybox.tail1234.ts.net` | `https://mybox.tail1234.ts.net/oauth/google/callback` |

- **It must match exactly:** scheme (`http` or `https`), host, and port. `localhost` and `127.0.0.1` are different addresses to Google.
- **Only the scheme, host and port of `public_url` count.** A path in it (`https://example.com/heel`) is dropped: the URI is `https://example.com/oauth/google/callback`.
- **It comes from `public_url`, not from `listen`.** If you moved the approval page off port 7301 with `listen.human`, set `public_url` to the new address too, or the redirect URI still says `localhost:7301`.
- **Google allows plain `http` only for `localhost` (or `127.0.0.1`).** Anywhere else, `public_url` must be `https://`, which heel requires anyway.
- **A client can list several redirect URIs.** Add both `http://localhost:7301/...` and your HTTPS address if you use both. If you change `public_url` later, add the new URI to the client.

## 2. Create a Google Cloud project

1. Open the [Google Cloud console](https://console.cloud.google.com/) and sign in. Any Google account works; it doesn't have to be the one you'll connect.
2. Go to **Menu > IAM & Admin > Create a Project**.
3. Enter a **Project name**, such as `heel`, and click **Create**.
4. Make sure the new project is selected in the project picker at the top of the console before you go on.

## 3. Turn on the Gmail API (and the Calendar API)

1. Go to **Menu > APIs & Services > Library**.
2. Search for **Gmail API**, open it, and click **Enable**.
3. To connect Google Calendar too, go back to the library, open **Google Calendar API**, and click **Enable**.

Without the API turned on, the sign-in fails at the last step: heel reads the account's address through it.

## 4. Set up the consent screen

This is the page Google shows when you sign in.

1. Go to **Menu > Google Auth platform > Branding**. If it says Google Auth platform isn't configured yet, click **Get started**.
2. **App information:** enter an **App name** (`heel` is fine) and a **User support email** (yours). Click **Next**.
3. **Audience:** choose who can sign in.
   - **External** for a personal Gmail account. Your app starts in **Testing**, where only test users you list can sign in.
   - **Internal** only if you have Google Workspace and every account you'll connect is in that same organization. Internal apps skip test users, the verification warning and the 7-day limit below.

   Click **Next**.
4. **Contact information:** enter your email address. Click **Next**.
5. **Finish:** agree to the Google API Services User Data Policy, click **Continue**, then **Create**.
6. **If you chose External, add yourself as a test user:** go to **Audience**, click **Add users** under **Test users**, enter the address of every Google account you'll connect, and click **Save**.

You don't need to add scopes under **Data Access**. heel asks for its scopes when you sign in.

### Testing mode signs you out after 7 days

While an External app is in **Testing**, Google lets its sign-ins last 7 days: the refresh token expires, heel marks the account **Needs sign-in**, and calls on it fail until you sign in again. Pick one:

- **Sign in again each week:** click **Sign in** next to the account on the Connections page. Nothing else changes.
- **Publish the app:** on the **Audience** page, click **Publish app** to move it to **In production**. Sign-ins then last until you revoke them (Google still ends one that goes unused for 6 months, or when you change the account's password). Google hasn't verified your app, so its sign-in shows an unverified-app warning (see [Troubleshooting](#google-says-it-hasnt-verified-the-app)), and an unverified app can sign in at most 100 accounts in all. For your own accounts, that's fine. You don't need Google's verification to use your own client.
- **Use Internal** if you have Google Workspace (above).

## 5. Create the OAuth client

1. Go to **Menu > Google Auth platform > Clients** and click **Create client**.
2. **Application type:** **Web application**. (Not "Desktop app": heel is a web server that Google redirects back to.)
3. **Name:** anything, such as `heel`. Only you see it.
4. **Authorized redirect URIs:** click **Add URI** and paste your redirect URI from [step 1](#1-work-out-your-redirect-uri), for example `http://localhost:7301/oauth/google/callback`. Leave **Authorized JavaScript origins** empty.
5. Click **Create**.
6. **Copy the Client ID and the Client secret now.** Google shows the secret only once, when you create the client: download the JSON or copy both values somewhere safe. Later, the console shows only the secret's last four characters. If you lose it, open the client and click **Add secret** to make a new one.

Google notes that changes to a client can take a few minutes to apply. If sign-in fails with `redirect_uri_mismatch` right after you add a URI, wait and try again.

## 6. Give heel the client

heel reads the client ID from `heel.yaml` and the secret from a file or an environment variable. There's no key for the secret in `heel.yaml`, so it never ends up in a config file you might share or commit.

**First, the secret.** Pick one:

- **A file (the default):** `$HEEL_HOME/google-client-secret`. It must be owned by the user heel runs as and readable only by it, or heel refuses to start. To write it without the secret landing in your shell history:
  ```sh
  printf 'Client secret: '; read -rs secret; echo
  (umask 077; printf '%s\n' "$secret" > "${HEEL_HOME:?set HEEL_HOME first}/google-client-secret"); unset secret
  ```
  Run it as the user that runs `heel serve` (not with `sudo`), in a shell where `HEEL_HOME` is set.
  To keep it somewhere else, set `client_secret_file` (relative paths are relative to `HEEL_HOME`).
- **The environment:** `HEEL_GOOGLE_CLIENT_SECRET`. It takes precedence over the file. Use it with a secrets manager or a container platform's secrets. In Docker, a file in the `heel-data` volume is better, since `docker inspect` shows environment variables. If your container is named `heel`, this writes it as the container's own user:
  ```sh
  docker exec -i heel sh -c 'umask 077; cat > /var/lib/heel/google-client-secret'   # paste the secret, then Ctrl-D
  ```

**Then the client ID.** Add this to `$HEEL_HOME/heel.yaml` (create the file if you don't have one):

```yaml
providers:
  google:
    client_id: 1234567890-abcdefg.apps.googleusercontent.com   # your Client ID
    # client_secret_file: google-client-secret                 # the default
```

Do the secret first: once `providers.google` is in `heel.yaml`, heel won't start without its secret, and stops with:

```
heel: no secret: set HEEL_GOOGLE_CLIENT_SECRET or create /Users/you/.heel/google-client-secret
```

**Restart heel** (stop `heel serve` and start it again). heel reads `providers` only when it starts.

## 7. Connect and sign in

1. Add the account, if you haven't already:
   ```sh
   heel connect gmail --as gmail-work               # or: heel connect google-calendar --as calendar
   ```
   heel prints `Next: sign in to it from the Connections page: http://localhost:7301/connections`. If you ran `heel connect gmail` before setting up the client, the account is already there: don't run it again (the alias is taken), just sign in.
2. Open the approval page at your `public_url` address, sign in with your passkey, and go to **Connections**.
3. Click **Sign in** next to the account. Google opens.
4. Choose the Google account to connect. If you see the unverified-app warning, that's expected for your own client: continue past it (see [Troubleshooting](#google-says-it-hasnt-verified-the-app)).
5. Allow every permission heel asks for, and continue.

**Success looks like this:** Google sends you back to Connections, which says **Signed in to gmail-work. Agents can use it now.**, and the account's state is **Ready**. heel records which mailbox (or calendar) the account is, and from then on refreshes its access by itself.

To connect another Gmail or Calendar account, run `heel connect` again with a new alias and sign in. The same client works for all of them. Add each account as a test user first if the app is in Testing.

## What heel asks Google for, and why

| Account | Scope | Why |
| --- | --- | --- |
| Gmail | `gmail.modify` | Read, search, label, send, and move mail to the trash. |
| Gmail | `gmail.settings.basic` | Filters. heel's rules decide whether an agent can make one. |
| Calendar | `calendar.events` | Read and edit events on calendars you can edit. |
| Calendar | `calendar.calendarlist.readonly` | List your calendars and find the primary one. |

- heel never asks for full mail access (`https://mail.google.com/`), so nothing it does can delete mail permanently: a delete is always a move to the trash.
- If you untick a permission on Google's page, heel refuses the sign-in when it can't work without it ("Tick every box"). Sign in again and allow everything.
- These are permissions for heel to hold. What an agent may actually do with them is up to your [rules](rules.md).
- Google classes the Gmail scopes as restricted. That's why a public app using them needs Google's verification, and why your own unpublished or unverified client shows warnings. It doesn't limit what you can do with your own accounts.

## Troubleshooting

### `Error 400: redirect_uri_mismatch`

The redirect URI heel sent isn't on the client. Compare the client's **Authorized redirect URIs** with [step 1](#1-work-out-your-redirect-uri), character for character:

- `http` vs `https`, `localhost` vs `127.0.0.1`, and the port.
- No trailing slash, and the path is exactly `/oauth/google/callback`.
- You changed `public_url` (or a tunnel gave you a new address) without adding the new URI.
- You added it a minute ago: wait a few minutes and try again.

### `Error 403: access_denied`, or "access blocked"

- **The app is in Testing and this Google account isn't a test user.** Add it under **Google Auth platform > Audience > Test users**, or publish the app.
- **You clicked Cancel** on Google's page. heel says "No code came back; the sign-in was cancelled." Click **Sign in** again.

### Google says it hasn't verified the app

Expected: it's your own client, and Google hasn't reviewed it. Check that the app name and support email are yours, then choose **Advanced** and continue to the app. Google's review is for apps offered to the public; you don't need it.

### The account says Needs sign-in again after a week

The app is in **Testing**, so Google expired the sign-in after 7 days. Click **Sign in** next to the account on Connections. To stop it happening, publish the app or use Internal: see [Testing mode signs you out after 7 days](#testing-mode-signs-you-out-after-7-days).

### "This account is alice@…; you signed in as bob@…"

You picked a different Google account than the one this alias was first signed in as. An alias always names one mailbox, so rules written for `gmail-work` never start applying to another one. Sign in again and choose the right account in Google's account chooser. To connect the other mailbox, give it its own alias: `heel connect gmail --as gmail-personal`.

### Connections still says "Needs your Google OAuth client"

heel hasn't loaded `providers.google`. Check the key is spelled as above in the `heel.yaml` heel actually reads (`$HEEL_HOME/heel.yaml`, or `HEEL_CONFIG`/`--config`), then restart heel.

### heel won't start after adding `providers.google`

- `no secret: set HEEL_GOOGLE_CLIENT_SECRET or create …`: write the secret file ([step 6](#6-give-heel-the-client)) or set the variable.
- `… is readable by other users; chmod 600 it`: run `chmod 600 "$HEEL_HOME/google-client-secret"`.
- `… can't be read by the user heel runs as` or `… must be owned by the user heel runs as`: the file was made by another user (with `sudo`, say). Delete it and write it again as the user that runs `heel serve`.

### "heel couldn't read the mailbox's address." or "heel couldn't read the primary calendar."

- **The Gmail API (or the Google Calendar API) isn't turned on** in this project: see [step 3](#3-turn-on-the-gmail-api-and-the-calendar-api). Turn it on, wait a minute, and sign in again.
- **For Calendar, you unticked the permission to see your list of calendars.** heel needs it to find your primary calendar. Sign in again and allow every permission.

### "Google didn't accept the sign-in."

Google refused heel's code exchange. Usually the client secret is wrong (a typo, or an old secret you've since replaced): write it again and restart heel. Check too that `client_id` is the client you added the redirect URI to.

### "Google sent no refresh token. Remove heel's access and try again."

Remove the app's access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions), then click **Sign in** again.

### Google sent me back to heel's sign-in page

The browser has no heel session at the redirect URI's address, usually because you opened heel at a different one (`127.0.0.1` when `public_url` says `localhost`). Sign in with your passkey and heel finishes the sign-in. Next time, open heel at exactly your `public_url` address.

## Outlook

Outlook accounts sign in the same way through a Microsoft app registration, configured as `providers.microsoft`. Its redirect URI is `public_url` + `/oauth/microsoft/callback`, and its secret is `$HEEL_HOME/microsoft-client-secret` or `HEEL_MICROSOFT_CLIENT_SECRET`. See [Configuration](running.md#configuration).
