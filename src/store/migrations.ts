/** Memory schema versions (CORE-VER-001/002). Each migration is applied once, in order. */
export const MEMORY_SCHEMA_VERSION = '3.2.0'

export const MIGRATIONS: { version: string; sql: string }[] = [
  {
    version: '3.0.0',
    sql: `
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  actor_identity TEXT NOT NULL UNIQUE,
  capability_channel_id TEXT,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS principals_channel ON principals (capability_channel_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  principal_id TEXT,
  channel_type TEXT NOT NULL,
  external_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  token_hash TEXT,
  nonce TEXT,
  out_of_band_id TEXT,
  question_connection_id TEXT,
  question_thread_id TEXT,
  stream_cursor BIGINT NOT NULL DEFAULT 0,
  last_activity_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_principal ON sessions (principal_id, state);
CREATE INDEX IF NOT EXISTS sessions_token ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_nonce ON sessions (nonce);
CREATE INDEX IF NOT EXISTS sessions_oob ON sessions (out_of_band_id);
CREATE INDEX IF NOT EXISTS sessions_external ON sessions (channel_type, external_ref);
CREATE INDEX IF NOT EXISTS sessions_question ON sessions (question_connection_id, question_thread_id);

-- The canonical memory unit (MEM-ENTRY-001). Classification columns are indexed (PRIV-SCOPE-005).
-- No purpose or lawful-basis column exists (D18, D43).
CREATE TABLE IF NOT EXISTS entries (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  principal_id TEXT,
  role TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('text','voice','media','tool-call','approval','refusal','auth-challenge','reaction','state-update')),
  completion TEXT NOT NULL DEFAULT 'complete',
  visibility TEXT NOT NULL CHECK (visibility IN ('session-private','principal-private','organization-shared','partner-shared','public')),
  state TEXT NOT NULL CHECK (state IN ('active','archived','legal-hold','crypto-erased','deleted')),
  backing_identity_id TEXT,
  language TEXT NOT NULL,
  content_digest TEXT NOT NULL,
  enc_key_ref TEXT,
  cipher BYTEA,
  text_preview TEXT NOT NULL DEFAULT '',
  external_id TEXT,
  initiated_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  anchor_batch_id TEXT,
  embedding vector,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_session ON entries (session_id, initiated_at DESC);
CREATE INDEX IF NOT EXISTS entries_scope ON entries (state, visibility, session_id, principal_id, backing_identity_id);
CREATE INDEX IF NOT EXISTS entries_anchor ON entries (anchor_batch_id) WHERE anchor_batch_id IS NULL;
CREATE INDEX IF NOT EXISTS entries_external ON entries (session_id, external_id);
CREATE INDEX IF NOT EXISTS entries_created ON entries (state, created_at);

CREATE TABLE IF NOT EXISTS working_memory (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS working_memory_principal ON working_memory (principal_id);

CREATE TABLE IF NOT EXISTS preferences (
  principal_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (principal_id, key)
);

CREATE TABLE IF NOT EXISTS credential_presentations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS credentials_principal ON credential_presentations (principal_id);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  eligible_roles TEXT[] NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS approvals_status ON approvals (status);

CREATE TABLE IF NOT EXISTS elevation_grants (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_principal ON elevation_grants (principal_id, expires_at);

CREATE TABLE IF NOT EXISTS auth_challenges (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  outcome TEXT NOT NULL,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_access_log (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);

-- never deleted (INTEG-ANCHOR-004)
CREATE TABLE IF NOT EXISTS digest_anchors (
  batch_id TEXT PRIMARY KEY,
  anchored_at TIMESTAMPTZ,
  data JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS rag_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  visibility TEXT NOT NULL,
  state TEXT NOT NULL,
  position INT NOT NULL,
  embedding vector,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS rag_source ON rag_chunks (source_id);
CREATE INDEX IF NOT EXISTS rag_scope ON rag_chunks (state, visibility);

CREATE TABLE IF NOT EXISTS stat_events (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  stat_class TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  dimensions JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS stats_ts ON stat_events (stat_class, ts);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`,
  },
  {
    version: '3.1.0',
    sql: `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS conversations_principal ON conversations (principal_id, state, last_activity_at DESC);
`,
  },
  {
    // v4: a flow of the flow profile is one entry updated in place at its close (D55, INTX-FLOW-002)
    version: '3.2.0',
    sql: `
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_source_type_check;
ALTER TABLE entries ADD CONSTRAINT entries_source_type_check
  CHECK (source_type IN ('text','voice','media','tool-call','approval','refusal','auth-challenge','reaction','state-update','flow'));
`,
  },
]
