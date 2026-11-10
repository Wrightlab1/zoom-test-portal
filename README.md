# Zoom Test Portal

A self-hosted, single-user portal for testing the Zoom REST API and Zoom webhooks:

- **Profiles** for each Zoom Marketplace app: Server-to-Server OAuth or General (user OAuth), several authorized Zoom users per app.
- **Tokens**: S2S `account_credentials` with caching and re-request; user OAuth authorization code flow with `state`, optional PKCE (S256), automatic rotation-safe refresh, revoke, and masked reveal/copy.
- **ngrok** started from inside the app (official SDK), pointed only at the public listener. The portal shows the exact Marketplace values and warns when an unreserved URL changes.
- **API explorer** over an imported Postman collection (Collection v2.1) and environment, plus ad hoc requests, saved requests, re-run from logs, and copy as curl.
- **Webhook receiver**: one path per profile, raw-byte HMAC verification, signed URL validation, replay window, and duplicate flags, shown live in the UI.
- **Reports** over every API call, token call and webhook: filters, full-text search, summaries, CSV/JSON export, and retention.

---

## Contents

1. [How it is put together](#how-it-is-put-together)
2. [First run](#first-run)
3. [The master key: where it lives, backing it up](#the-master-key)
4. [Configuration](#configuration)
5. [ngrok](#ngrok)
6. [Creating the Zoom apps (which value goes where)](#creating-the-zoom-apps)
7. [Importing Zoom's Postman collection](#importing-zooms-postman-collection)
8. [Using the explorer](#using-the-explorer)
9. [Webhooks](#webhooks)
10. [Reports and logs](#reports-and-logs)
11. [Backup and restore](#backup-and-restore)
12. [Docker](#docker)
13. [Development and tests (mock Zoom)](#development-and-tests)
14. [Checklist: verify against your real Zoom account](#checklist-verify-against-your-real-zoom-account)
15. [Troubleshooting](#troubleshooting)
16. [Security model](#security-model)

---

## How it is put together

```
                 your browser (same machine)
                          │  http://127.0.0.1:4800
                          ▼
   ┌───────────────────────────────────────────┐
   │ ADMIN listener 127.0.0.1:4800             │  login + CSRF + Host check
   │   UI, /api/*  (profiles, tokens, explorer,│
   │   reports, settings, SSE live stream)     │
   └───────────────────────────────────────────┘
                 │ all Zoom calls made by the backend (allowlisted hosts only)
                 ▼
          zoom.us / api*.zoom.us

   Zoom ──HTTPS──► ngrok ──► ┌──────────────────────────────────────┐
                             │ PUBLIC listener 127.0.0.1:4801        │
                             │   GET  /oauth/callback/{profile-slug} │
                             │   POST /webhooks/zoom/{profile-slug}  │
                             │   everything else → 404               │
                             └──────────────────────────────────────┘
```

- The tunnel forwards **only** to the public listener. The admin UI and API are on a different port and cannot be reached through ngrok.
- The browser never talks to Zoom. The backend attaches bearer tokens and logs every call in one place.
- Storage is one SQLite file (WAL mode, FTS5 for search). All SQL lives in `server/db/`, so moving to Postgres later means changing one layer.

---

## First run

Requirements: **Node.js 22.12+**. An ngrok account is optional for local-only use.

```bash
npm ci
npm run build
npm start            # built app: http://127.0.0.1:4800
# or, for development with hot reload:
npm run dev          # UI at http://127.0.0.1:5173 (proxies to the API on :4800)
```

On first start the console prints two boxes:

1. **A new master key was generated** at `~/.config/zoom-test-portal/master.key`. Back it up now (see below).
2. **A setup code**. Open the portal, enter the setup code, and choose an admin password (12+ characters). The setup code stops another local process or tab from claiming the first password.

The admin password is stored as an argon2id hash. To reset it, stop the portal and run `npm run reset-password`.

---

## The master key

Every client secret, webhook secret token, access token, refresh token, PKCE verifier, environment value and the ngrok authtoken is encrypted with **AES-256-GCM** before it is written to the database. The key never goes in the database or the repository.

| Source (first match wins) | Notes |
|---|---|
| `ZTP_MASTER_KEY` env var | base64 (or hex) of 32 bytes |
| `ZTP_KEY_FILE` | path to a key file |
| default: `~/.config/zoom-test-portal/master.key` | created on first run, mode `0600`, directory `0700` |

Rules the portal enforces:

- **First run** (no database yet): a missing key is generated.
- **Database exists, key missing**: the portal refuses to start and tells you where it looked.
- **Wrong key**: the portal refuses to start and prints the fingerprint the database expects next to the one you supplied. A check value stored in the database must decrypt with the key.
- **Key file readable by group or other users**: the portal refuses to start (`chmod 600` fixes it).
- It never falls back to plaintext.

**Back it up.** Copy the key file (or its contents) into a password manager. Without it the database is unreadable, and that is by design.

**Rotate it.** Stop the portal, then run:

```bash
npm run rotate-key
```

This backs up the database, re-encrypts every secret in one transaction, writes the new key file, and keeps the old key as `master.key.old-<timestamp>`. Delete the old key and the backup once the new key is backed up. If your key comes from `ZTP_MASTER_KEY`, the command prints the new value for you to put in place. It refuses to run while the portal is running.

---

## Configuration

Environment variables (or a `.env` file in the project root; see `.env.example`):

| Variable | Default | Meaning |
|---|---|---|
| `ZTP_DATA_DIR` | `./data` | Database location (`portal.db`). Git-ignored. |
| `ZTP_KEY_FILE` | `~/.config/zoom-test-portal/master.key` | Master key file |
| `ZTP_MASTER_KEY` | — | Master key value; overrides the file |
| `ZTP_ADMIN_HOST` / `ZTP_ADMIN_PORT` | `127.0.0.1` / `4800` | Admin listener |
| `ZTP_ADMIN_ALLOW_NON_LOOPBACK` | `0` | Must be `1` to bind the admin listener to a non-loopback address. A warning is printed at startup. |
| `ZTP_ADMIN_ALLOWED_HOSTS` | — | Extra `Host` header values the admin listener accepts (needed if you browse to it by another name) |
| `ZTP_PUBLIC_HOST` / `ZTP_PUBLIC_PORT` | `127.0.0.1` / `4801` | Public listener (the tunnel target) |
| `ZTP_LOG_LEVEL` | `info` | `silent`, `warn`, `info`, `debug` |

Everything else is set in the UI under **Settings**:

- outbound allowlist
- Zoom OAuth/API base URLs
- webhook replay tolerance
- log retention and stored body size
- refresh lead time
- public base URL override
- ngrok authtoken, reserved domain and autostart (on the **Tunnel & URLs** page)

---

## ngrok

1. Copy your authtoken from the [ngrok dashboard](https://dashboard.ngrok.com/get-started/your-authtoken).
2. Under **Tunnel & URLs → ngrok settings**, paste the authtoken. It is stored encrypted.
3. In the same section, set your **reserved domain**, e.g. `your-name.ngrok-free.app`, hostname only.
4. Click **Start tunnel**. Optionally tick "Start the tunnel when the portal starts".

With a reserved domain the URL is stable, so you paste the Marketplace values once. Without one, ngrok gives you a new URL on every start. The portal then shows a warning that lists each Marketplace field that needs the new value, until you click **I've updated the Marketplace**.

The OAuth redirect URI is always built from the current public URL. A pending authorization remembers the exact redirect URI it was started with, so the authorize request and the code exchange always agree.

---

## Creating the Zoom apps

Create one portal **profile** per Marketplace app. The profile's **slug** appears in its URLs. The **Tunnel & URLs** page and the profile page show the exact values with copy buttons. Below, `https://YOUR-DOMAIN` stands for your ngrok domain and `SLUG` for the profile slug.

> Marketplace screens get renamed from time to time. The field names below are the ones in use when this was written; if a label differs, look for the equivalent field.

### Server-to-Server OAuth app

1. Go to [marketplace.zoom.us](https://marketplace.zoom.us/) → **Develop → Build App → Server-to-Server OAuth App**.
2. Copy these from **App Credentials** into a new portal profile (type *Server-to-Server OAuth*):

   | Marketplace (App Credentials) | Portal profile field |
   |---|---|
   | Account ID | Account ID |
   | Client ID | Client ID |
   | Client Secret | Client secret |

3. Under **Scopes**, add what you want to call. For a first test, `user:read:user:admin` (granular) or `user:read:admin` (classic) is enough for `GET /users`.
4. Optional, for webhooks: under **Feature → General Features → Event Subscriptions**, add a subscription:

   | Marketplace field | Value |
   |---|---|
   | Event notification endpoint URL | `https://YOUR-DOMAIN/webhooks/zoom/SLUG` |
   | Secret Token (shown on the same page) | paste into the profile's **Webhook secret token** |

   Pick your events, then click **Validate**. The portal answers the signed `endpoint.url_validation` challenge.

5. Under **Activation**, activate the app.
6. In the portal, open the profile and click **Get new token**. You should see the scopes, `api_url` and the expiry countdown.

Note: S2S tokens must not use the `me` keyword. Call `/users/{userId or email}` instead; the explorer warns if you forget.

### General app (user OAuth)

1. **Develop → Build App → General App**. Choose *User-managed* to test as individual users, or *Admin-managed* for account-level scopes.
2. Create a portal profile (type *General app (user OAuth)*). Copy over:

   | Marketplace (Basic Information → App Credentials) | Portal profile field |
   |---|---|
   | Client ID | Client ID |
   | Client Secret | Client secret |

3. In **Basic Information → OAuth Information**:

   | Marketplace field | Value |
   |---|---|
   | OAuth Redirect URL | `https://YOUR-DOMAIN/oauth/callback/SLUG` |
   | OAuth Allow List | the same URL |

   It must match exactly, including scheme and path, with no trailing slash. A mismatch is Zoom error **4709**.

4. Under **Scopes**, add scopes; `user:read:user` is enough for `/users/me`. If you change scopes later, re-authorize.
5. Optional webhooks: **Features → Access** shows the **Secret Token**; paste it into the profile's **Webhook secret token**. Enable **Event Subscription** and set:

   | Marketplace field | Value |
   |---|---|
   | Event notification endpoint URL | `https://YOUR-DOMAIN/webhooks/zoom/SLUG` |

   Then click **Validate**.

6. Optional: tick **Use PKCE (S256)** on the profile to test the PKCE variant.
7. In the portal, click **Authorize…**. A new tab opens Zoom's consent page; after you approve, Zoom redirects to the portal's callback. The profile page updates live.

How authorizations behave:

- Each Zoom user you authorize as becomes its own **authorization**, labelled from `/v2/users/me`.
- If the **same** user authorizes the **same** app again, Zoom invalidates the earlier tokens (error 4741). The portal marks the old authorization *superseded* instead of letting it fail later. This also applies across profiles that share a client ID.

---

## Importing Zoom's Postman collection

1. Open Zoom's public Postman workspace, linked from [developers.zoom.us](https://developers.zoom.us/) (API reference → Postman); the workspace is `postman.com/zoom-developer`. Fork the collection you want (e.g. *Zoom Meeting API*) into your workspace.
2. In Postman, open the collection's **⋯** menu → **Export** → **Collection v2.1** → Export. This saves a `.json` file.
3. Optional: export an environment from the same menu.
4. In the portal, go to **API explorer → Import** and choose the file. The portal tells collections and environments apart automatically.

**Re-importing** a newer export updates the same collection in place. Requests are matched on *method + path template*, so changed definitions update, new endpoints are added and removed ones are deleted. **Saved requests are never discarded**:

- If an endpoint they came from disappears, they are marked *orphaned* and keep working.
- They re-link automatically if the endpoint returns in a later import.

Collection auth blocks (`{{bearerToken}}` and the like) are ignored; the backend attaches the profile's token.

---

## Using the explorer

- **Variables**:
  - `{{baseUrl}}` always resolves to the selected authorization's `api_url` + `/v2`, so regional accounts work automatically.
  - Other `{{vars}}` come from the collection, then the selected environment. Postman's `{{$guid}}`, `{{$timestamp}}`, `{{$isoTimestamp}}` and `{{$randomInt}}` are supported.
  - Unresolved variables are reported.
- **Path variables**: `:meetingId` and similar get their own fields. **Auto** encoding double-encodes values that start with `/` or contain `//`, as Zoom requires for meeting UUIDs; you can force single or double encoding.
- **Auth**:
  - *Bearer (profile)* attaches the token server-side and ignores any `Authorization` header you typed.
  - *None* sends exactly your headers, which is useful for negative tests.
- **401 handling**: if Zoom says the token **expired**, the portal refreshes once (user OAuth) or re-requests (S2S) and retries once. Both attempts are logged and linked. "Invalid access token" is not retried.
- **Response panel**: status, duration, size, `X-RateLimit-*` (category, type, remaining/limit, `Retry-After`), the **tracking ID** with copy, and a collapsible JSON body.
- **Shortcuts**: `⌘/Ctrl+Enter` sends; `/` focuses the collection search.
- **curl**: the default copy uses `$ZOOM_ACCESS_TOKEN`. **+token** includes the live token, after a confirmation.
- **Allowlist**: requests (and every redirect hop) may only go to hosts in **Settings → Outbound allowlist**. The default list is `zoom.us`, `api.zoom.us` and the regional `api-*.zoom.us` hosts. The Authorization header is never forwarded to a different host on redirect.

---

## Webhooks

Each profile listens at `https://YOUR-DOMAIN/webhooks/zoom/SLUG`. For every request the portal:

1. Captures the **raw body bytes** before any parsing.
2. Verifies `x-zm-signature` = `v0=` + HMAC-SHA256(secret token, `v0:{x-zm-request-timestamp}:{raw body}`), with a constant-time compare.
3. Rejects timestamps outside the **replay tolerance** (Settings; default 300 s).
4. Answers `endpoint.url_validation` with `{plainToken, encryptedToken}`, but **only when the validation request itself is correctly signed**. Otherwise the endpoint would be an HMAC oracle that could forge signatures.
5. Responds `200` to valid events and `401` to failed verification. Unknown slugs get `404`, other methods `405`, and malformed JSON with a valid signature `400`.
6. **Records everything**, including failures: headers (redacted), the exact raw body, the parsed payload, the verification result, what it answered, and its handling time.
7. Flags **duplicates** without hiding them: *identical body* (a retry) or *same event + event_ts*.

The answer is computed and stored synchronously (well under a millisecond on typical hardware), so Zoom gets a fast 2xx. The Webhooks view updates live.

Send test webhooks without Zoom:

```bash
npm run mock:webhook -- --url http://127.0.0.1:4801/webhooks/zoom/SLUG --secret 'the secret token' --suite
```

`--suite` runs these cases and checks the responses:

- a valid event
- signed and unsigned URL validation
- the wrong secret
- a missing signature
- a stale timestamp
- a body tampered after signing
- a retry

Individual flags: `--validation`, `--bad-signature`, `--no-signature`, `--stale 600`, `--tamper`, `--duplicate 3`, `--event recording.completed`.

---

## Reports and logs

**API calls** and **Webhooks** each have:

- **Filters**: date range (last hour / 24 h / 7 d / 30 d / all / custom), profile, method, status class or exact status, endpoint, event resource, event name, verification result, the status the portal returned, duplicates and validations.
- **Full-text search** across URLs, headers and bodies (SQLite FTS5).
- **Server-side paging and sorting** on every column.
- **Summaries**:
  - totals, error rate and latency p50/p90/p95/p99
  - calls vs failures over time, failures by status, top endpoints
  - **rate-limit usage by category** (Light / Medium / Heavy / Resource-intensive) from the latest headers; limits are shared by every app on the account
  - for webhooks: verification results and duplicate counts
- **Row detail**: full request and response or full webhook, related attempts (retry, re-run, other deliveries), re-run, open in explorer, copy curl.
- **Saved filters** and **CSV / JSON export** of the current filtered set. Exports contain only redacted data, and CSV cells are protected against spreadsheet formula injection.

Token endpoint calls are their own category, with credentials, codes, verifiers and tokens redacted. Each profile also has a token event history (issued, refreshed, revoked, failed with Zoom's error, superseded).

**Retention**: Settings → Logs → *Retention (days)* purges older call and webhook logs every 6 hours. It is off by default (0). *Purge now* deletes on demand.

**Scale**: the test suite seeds 200,000 calls and 100,000 webhooks. On a laptop:

- paging, sorting, filtering and search take about 1–90 ms
- sorting by URL takes about 450 ms
- the unfiltered all-time call summary takes about 1.3 s; with the default 7-day range it takes about 30 ms

---

## Backup and restore

What to back up:

- **The database**: `data/portal.db`, or `ZTP_DATA_DIR`.
- **The master key**: keep it separately from the database. A database backup without the key is useless, and a key stored next to the database protects nothing.

Back up the database while the portal is running (online, consistent):

```bash
sqlite3 data/portal.db ".backup 'portal-backup-$(date +%F).db'"
```

Or stop the portal and copy `portal.db` together with any `portal.db-wal` and `portal.db-shm` files.

To restore:

1. Stop the portal.
2. Put the backup at `data/portal.db` and remove any stale `-wal` and `-shm` files.
3. Make the matching key available (`ZTP_KEY_FILE` or `ZTP_MASTER_KEY`).
4. Start the portal. If the key doesn't match, it refuses to start and shows both fingerprints.

---

## Docker

```bash
docker compose up --build
```

- **Admin port**: published only on the host's `127.0.0.1:4800`. Inside the container the admin listener binds `0.0.0.0`; the Dockerfile sets the explicit opt-in, and the startup warning about it is expected.
- **Public listener**: stays on the container's loopback. Only the in-process ngrok tunnel connects to it, so it is never published.
- **Volumes**: `./data` holds the database and `./secrets` holds `master.key`. Both are git-ignored. Back up `./secrets/master.key` separately.

---

## Development and tests

```bash
npm run dev          # API (tsx watch) + Vite UI with HMR
npm test             # vitest: unit + end-to-end against the mock Zoom server
npm run typecheck
```

**Mock Zoom server** (`npm run mock:zoom`, port 4900) implements:

- `/oauth/authorize`: exact redirect match, `state` passthrough, PKCE challenge, a user picker via `?mock_user=`
- `/oauth/token`:
  - `account_credentials`, `authorization_code` (5-minute single-use codes, redirect and PKCE checks), `refresh_token` (rotation: the old token dies immediately; optional delay to test races) and `client_credentials`
  - Zoom-shaped errors
- `/oauth/revoke`, and re-authorization that invalidates a user's earlier tokens (4741)
- `/v2/users/me`, paginated `/v2/users` (57 users), `/v2/past_meetings/{uuid}` (requires double encoding), `/v2/ratelimit-test` (429), and a redirecting download
- `X-RateLimit-*` and `x-zm-trackingid` on every response
- test controls: `POST /__mock/expire`, `/__mock/config`, `GET /__mock/stats`

To point the portal at the mock:

1. Settings → add `http://127.0.0.1:4900` to the allowlist.
2. Set the OAuth and API base URLs to `http://127.0.0.1:4900`.
3. Set the public base URL override to `http://127.0.0.1:4801`.
4. Use the credentials the mock prints. They are fake.

The tests cover:

| Area | What is checked |
|---|---|
| Encryption | round trip, wrong key, tampering, AAD binding, key file permissions, rotation |
| Webhook signatures | raw-byte HMAC (including re-serialization and invalid-UTF-8 cases), URL validation |
| Refresh | 12 concurrent 401-triggered refreshes produce exactly one token call; serialized forced refreshes |
| Redaction | headers, JSON, form bodies, URLs, and registered secret values in free text |
| Postman parser | a realistic Zoom-shaped fixture |
| Allowlist | allowed and blocked hosts, wildcards, explicit http entries |
| User OAuth | state replay and forgery, PKCE enforcement, supersession |
| Explorer | pagination, double encoding, 429, retries, redirects, curl, replay |
| Reports | filters, search, export, retention, scale |
| Admin protection | session, CSRF, Origin, Host, and that the public listener exposes nothing else |

---

## Checklist: verify against your real Zoom account

Work through this once with real credentials. Each step says what "pass" looks like.

**Setup**

- [ ] Start the portal. Back up `~/.config/zoom-test-portal/master.key`. Set the admin password using the setup code.
- [ ] Tunnel & URLs: save the ngrok authtoken and reserved domain, then **Start tunnel**. *Pass: state `running` with your domain.*
- [ ] From another network (e.g. your phone), open `https://YOUR-DOMAIN/`. *Pass: plain `404 Not Found`. The admin UI is not reachable.*
- [ ] Open `https://YOUR-DOMAIN/api/profiles`. *Pass: `404`.*

**Server-to-Server**

- [ ] Create the S2S profile (Account ID, Client ID, secret). Click **Get new token**. *Pass:*
  - *status active, the expiry counts down from about 60 m*
  - *scopes are listed*
  - *`api_url` is shown (e.g. `https://api.zoom.us`)*
- [ ] Token events show `issued`. API calls → *Token endpoint* shows the call with `Authorization: Basic [REDACTED]…` and `access_token` redacted in the body.
- [ ] Explorer: S2S profile, `GET {{baseUrl}}/users?page_size=1`. *Pass:*
  - *200*
  - *the tracking ID is shown*
  - *`X-RateLimit-Category` and remaining/limit badges appear*
- [ ] Follow `next_page_token` by adding it as a query param. *Pass: the next page.*
- [ ] Temporarily set a wrong client secret and click Get new token. *Pass: the `failed` event shows Zoom's error (`invalid_client`). Restore the secret.*

**User OAuth**

- [ ] Create the General-app profile. Paste the redirect URL into **OAuth Redirect URL** and **OAuth Allow List** exactly.
- [ ] Click **Authorize…** and approve. *Pass: the tab says "Authorized as <you>"; the profile shows the authorization with your email, scopes, `api_url` and expiry.*
- [ ] Explorer: `GET {{baseUrl}}/users/me` with that authorization. *Pass: 200, your user.*
- [ ] Click **Refresh now**. *Pass:*
  - *a `refreshed` event appears*
  - *the refresh-token hint (last 4 characters) changes*
  - *the next call still works, proving the rotated token was stored*
- [ ] Authorize again as the **same** user. *Pass: the old authorization becomes `superseded`; the new one works.*
- [ ] Optional: authorize as a **second** Zoom user. *Pass: two active authorizations.*
- [ ] Tick **Use PKCE**, then authorize again. *Pass: works; the authorization shows a `PKCE` badge.*
- [ ] Open a consent link, wait more than 5 minutes before approving (or reuse a callback URL). *Pass: a clear error page and a `failed` event (e.g. code expired / invalid state).*
- [ ] Click **Revoke**. *Pass: status `revoked`; an API call with it now fails.*

**Webhooks**

- [ ] Paste the profile's webhook URL and the Marketplace **Secret Token** (into the profile), then click **Validate** in the Marketplace. *Pass:*
  - *the Marketplace accepts the URL*
  - *the Webhooks view shows `endpoint.url_validation` as ✓ Verified, answered 200*
  - *if Zoom's validation request is unsigned you'd see `Unsigned / 401`; report it, see [Troubleshooting](#troubleshooting)*
- [ ] Subscribe to an easy event (e.g. *User Activity → User has signed in*, or *Meeting has started*) and trigger it. *Pass:*
  - *it appears live*
  - *verification ✓*
  - *raw body, headers (including `x-zm-trackingid`) and parsed payload are shown*
- [ ] Change the profile's webhook secret to a wrong value and trigger again. *Pass:*
  - *the row shows ✕ Bad signature, answered 401*
  - *Zoom retries; the retries appear flagged `dup of #…`*
  - *Restore the secret afterwards.*
- [ ] Compare with Zoom's own view: the Marketplace app's **Event logs** should show the same deliveries and status codes.

**Reports**

- [ ] API calls: filter by status 401, search for a tracking ID, export CSV. *Pass: the export opens and contains no tokens or secrets (search the file for the first characters of a revealed token).*

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Zoom **4709** Redirect URI mismatch | Marketplace OAuth Redirect URL / Allow List not identical to the portal's value (scheme, host, path, trailing slash). The URL changed without a reserved domain: see the warning banner. |
| **4702/4704** invalid client | Wrong client ID or secret, or S2S credentials used for a General app (or vice versa). |
| **4733 / 4734** code expired / invalid | Consent took longer than 5 minutes, or the callback was replayed. Authorize again. |
| **4741** token revoked | The same user re-authorized (the old authorization is shown as superseded). Use the newest one. |
| `400 Invalid Token!` on refresh | The refresh token was already rotated or revoked; the authorization is marked *failed*. Authorize again. |
| `401 Access token is expired.` | Handled automatically: refresh plus one retry. Both attempts are in the log. |
| `does not contain scopes` / 4711 | Add the scope in the Marketplace, then re-authorize. |
| `/users/me` fails on S2S | S2S tokens can't use `me`; use a user ID or email. |
| Webhook **Bad signature** | Wrong secret token on the profile (it is the event subscription *Secret Token*, not the client secret), or a proxy altered the body. |
| Webhook **Stale** | Clock skew between your machine and Zoom, or a replay. Check system time, or raise the tolerance. |
| Marketplace "Validate" fails | Check the Webhooks view: the validation request and the portal's answer are recorded. If it shows *Unsigned*, Zoom sent an unsigned validation (see note below). |
| "Blocked by outbound allowlist" | The URL or a redirect hop isn't a Zoom host. Add it in Settings if intended. |
| Portal refuses to start: key | See [The master key](#the-master-key). The message names the path it looked for and the expected fingerprint. |

Note on signed URL validation: Zoom's documented behaviour is to send `x-zm-signature` on validation requests too, and the portal requires it, for the security reason given in [Webhooks](#webhooks). This could only be tested against the mock. If your real account ever shows an *Unsigned* validation, that is the one behaviour to revisit.

---

## Security model

- **Two listeners**:
  - The public one serves only the OAuth callback and webhook paths; everything else gets a bare 404.
  - The admin one binds loopback by default. Binding it elsewhere needs `ZTP_ADMIN_ALLOW_NON_LOOPBACK=1` and prints a warning.
  - Admin requests with an unexpected `Host` header get a 421, which defeats DNS rebinding.
- **Admin authentication**:
  - Login is required even on localhost; the password is an argon2id hash.
  - Session cookies are `HttpOnly; SameSite=Strict`, with server-side sessions and 12 h idle / 7 day maximum lifetimes.
  - Every state-changing request needs the CSRF token header and an allowed Origin.
  - Repeated failed logins trigger a progressive lockout.
- **Secrets at rest**:
  - Encrypted with AES-256-GCM. The associated data names the column, so a value can't be moved to another column undetected.
  - The key lives outside the database and the repository, and the portal refuses to start without it.
- **Secrets never reach logs or the browser**:
  - `Authorization`, cookies, token fields, client secrets, codes and verifiers are redacted before any log write or export.
  - Every stored secret value is also registered with a scrubber that replaces it anywhere it appears, including application logs.
  - The admin API returns token values only through the explicit **Reveal** action. Secret form fields are write-only and show the last 4 characters.
- **Outbound**: requests go only to an editable host allowlist, checked on every redirect hop. Credentials are never sent across hosts.
- **Repository hygiene**: `.env`, key files, `data/`, `secrets/` and database files are git-ignored from the first commit. Fixtures and the mock use obviously fake values.
