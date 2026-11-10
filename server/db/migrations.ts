/**
 * Ordered schema migrations. Never edit a shipped migration — append a new one.
 * Columns ending in `_enc` hold AES-256-GCM ciphertext (see server/lib/crypto.ts and
 * ENCRYPTED_COLUMNS in server/db/index.ts).
 */
export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: 'initial schema',
    sql: `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  is_secret INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE admin_user (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT
);

CREATE TABLE profiles (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('s2s', 'user')),
  client_id TEXT NOT NULL,
  client_secret_enc TEXT,
  account_id TEXT,
  webhook_secret_enc TEXT,
  use_pkce INTEGER NOT NULL DEFAULT 0,
  auto_refresh INTEGER NOT NULL DEFAULT 1,
  scopes_requested TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE authorizations (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('s2s', 'user')),
  zoom_user_id TEXT,
  zoom_email TEXT,
  zoom_name TEXT,
  zoom_account_id TEXT,
  scopes TEXT,
  api_url TEXT,
  access_token_enc TEXT,
  refresh_token_enc TEXT,
  access_expires_at INTEGER,
  issued_at INTEGER,
  last_refreshed_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'failed', 'revoked', 'superseded')),
  status_detail TEXT,
  used_pkce INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  refresh_lease_until INTEGER,
  refresh_lease_owner TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX authorizations_profile ON authorizations(profile_id, status);

CREATE TABLE oauth_pending (
  state_hash TEXT PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  verifier_enc TEXT,
  redirect_uri TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE token_events (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
  authorization_id INTEGER,
  at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  grant_type TEXT,
  http_status INTEGER,
  error_code TEXT,
  error_message TEXT,
  detail TEXT,
  api_call_id INTEGER
);
CREATE INDEX token_events_profile ON token_events(profile_id, at DESC);

CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  postman_id TEXT,
  description TEXT,
  variables_enc TEXT,
  source_hash TEXT,
  request_count INTEGER NOT NULL DEFAULT 0,
  imported_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE collection_folders (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  parent_id INTEGER REFERENCES collection_folders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL
);
CREATE INDEX collection_folders_coll ON collection_folders(collection_id);

CREATE TABLE collection_requests (
  id INTEGER PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  folder_id INTEGER REFERENCES collection_folders(id) ON DELETE SET NULL,
  match_key TEXT NOT NULL,
  postman_id TEXT,
  name TEXT NOT NULL,
  method TEXT NOT NULL,
  url_raw TEXT NOT NULL,
  path_template TEXT NOT NULL,
  definition TEXT NOT NULL,
  description TEXT,
  sort INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (collection_id, match_key)
);

CREATE TABLE environments (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  postman_id TEXT,
  values_enc TEXT,
  imported_at INTEGER NOT NULL
);

CREATE TABLE saved_requests (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  collection_request_id INTEGER REFERENCES collection_requests(id) ON DELETE SET NULL,
  match_key TEXT,
  profile_id INTEGER REFERENCES profiles(id) ON DELETE SET NULL,
  authorization_id INTEGER REFERENCES authorizations(id) ON DELETE SET NULL,
  request TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE api_calls (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('api', 'token')),
  profile_id INTEGER,
  authorization_id INTEGER,
  auth_type TEXT,
  grant_type TEXT,
  method TEXT NOT NULL,
  url TEXT NOT NULL,
  host TEXT,
  path TEXT,
  endpoint TEXT,
  collection_request_id INTEGER,
  saved_request_id INTEGER,
  query TEXT,
  req_headers TEXT,
  req_body TEXT,
  status INTEGER,
  status_class TEXT,
  resp_headers TEXT,
  resp_body TEXT,
  resp_body_truncated INTEGER NOT NULL DEFAULT 0,
  resp_size INTEGER,
  resp_content_type TEXT,
  duration_ms REAL,
  error TEXT,
  tracking_id TEXT,
  zoom_error_code TEXT,
  zoom_error_message TEXT,
  rl_category TEXT,
  rl_type TEXT,
  rl_limit INTEGER,
  rl_remaining INTEGER,
  rl_reset TEXT,
  retry_after TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  retry_of INTEGER,
  replay_of INTEGER,
  redirects TEXT
);
CREATE INDEX api_calls_ts ON api_calls(ts);
CREATE INDEX api_calls_profile_ts ON api_calls(profile_id, ts);
CREATE INDEX api_calls_status_ts ON api_calls(status, ts);
CREATE INDEX api_calls_cat_ts ON api_calls(category, ts);
CREATE INDEX api_calls_endpoint ON api_calls(endpoint);
CREATE INDEX api_calls_method ON api_calls(method);
CREATE INDEX api_calls_duration ON api_calls(duration_ms);

CREATE VIRTUAL TABLE api_calls_fts USING fts5(
  url, req_headers, req_body, resp_headers, resp_body,
  content='', contentless_delete=1, tokenize="unicode61 tokenchars '_'"
);

CREATE TABLE webhooks (
  id INTEGER PRIMARY KEY,
  received_at INTEGER NOT NULL,
  profile_id INTEGER,
  slug TEXT,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  remote_ip TEXT,
  event TEXT,
  event_ts INTEGER,
  account_id TEXT,
  signature TEXT NOT NULL,
  request_ts TEXT,
  is_validation INTEGER NOT NULL DEFAULT 0,
  duplicate_of INTEGER,
  duplicate_kind TEXT,
  body_hash TEXT,
  tracking_id TEXT,
  req_headers TEXT,
  raw_body BLOB,
  raw_redacted INTEGER NOT NULL DEFAULT 0,
  payload TEXT,
  response_status INTEGER NOT NULL,
  response_body TEXT,
  error TEXT,
  handle_ms REAL
);
CREATE INDEX webhooks_received ON webhooks(received_at);
CREATE INDEX webhooks_profile_received ON webhooks(profile_id, received_at);
CREATE INDEX webhooks_event ON webhooks(event, received_at);
CREATE INDEX webhooks_signature ON webhooks(signature, received_at);
CREATE INDEX webhooks_body_hash ON webhooks(profile_id, body_hash);
CREATE INDEX webhooks_event_ts ON webhooks(profile_id, event, event_ts);

CREATE VIRTUAL TABLE webhooks_fts USING fts5(
  event, path, headers, body,
  content='', contentless_delete=1, tokenize="unicode61 tokenchars '_'"
);

CREATE TABLE saved_filters (
  id INTEGER PRIMARY KEY,
  view TEXT NOT NULL CHECK (view IN ('calls', 'webhooks')),
  name TEXT NOT NULL,
  filter TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (view, name)
);

CREATE TABLE tunnel_history (
  id INTEGER PRIMARY KEY,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER,
  url TEXT NOT NULL,
  reserved_domain TEXT
);
`,
  },
  {
    version: 2,
    name: 'composite indexes for category-scoped report sorting and summaries',
    sql: `
CREATE INDEX api_calls_cat_duration ON api_calls(category, duration_ms);
CREATE INDEX api_calls_cat_status ON api_calls(category, status);
CREATE INDEX api_calls_cat_endpoint ON api_calls(category, method, endpoint);
CREATE INDEX api_calls_cat_class ON api_calls(category, status_class);
CREATE INDEX api_calls_retry ON api_calls(retry_of) WHERE retry_of IS NOT NULL;
CREATE INDEX api_calls_rl ON api_calls(rl_category, rl_type, profile_id) WHERE rl_category IS NOT NULL;
CREATE INDEX webhooks_response ON webhooks(response_status);
CREATE INDEX webhooks_duplicate ON webhooks(duplicate_of) WHERE duplicate_of IS NOT NULL;
CREATE INDEX webhooks_handle ON webhooks(handle_ms);
DROP INDEX api_calls_duration;
DROP INDEX api_calls_method;
`,
  },
];
