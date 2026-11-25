/** Memory schema versions (CORE-VER-001/002). Each migration is applied once, in order. */
export const MEMORY_SCHEMA_VERSION = '3.14.0'

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
  {
    // evidence: what the agent verified about a Principal, audit fields in the clear, values sealed (D67, PRIV-EVID).
    // The table of credential presentations it replaces was never written to.
    version: '3.3.0',
    sql: `
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('active','archived','legal-hold','crypto-erased')),
  verified_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ,
  data JSONB NOT NULL,
  cipher BYTEA
);
CREATE INDEX IF NOT EXISTS evidence_principal ON evidence (principal_id, verified_at);
CREATE INDEX IF NOT EXISTS evidence_expiry ON evidence (expires_at) WHERE state = 'active';
DROP TABLE IF EXISTS credential_presentations;
`,
  },
  {
    // D76: an entry carries its conversation, and `conversation-private` replaces `session-private`; working memory,
    // preferences and documents are read through the one predicate, compiled for each (PRIV-SCOPE-003). D77: no
    // preview of an entry in the clear. D78: the record of every call to the admin interface.
    version: '3.4.0',
    sql: `
ALTER TABLE entries ADD COLUMN IF NOT EXISTS conversation_id TEXT;
UPDATE entries e SET conversation_id = COALESCE(s.data->>'conversationId', s.data->>'rootSessionId', e.session_id)
  FROM sessions s WHERE s.id = e.session_id AND e.conversation_id IS NULL;
UPDATE entries SET conversation_id = session_id WHERE conversation_id IS NULL;
ALTER TABLE entries ALTER COLUMN conversation_id SET NOT NULL;
ALTER TABLE entries DROP CONSTRAINT IF EXISTS entries_visibility_check;
UPDATE entries SET visibility = 'conversation-private' WHERE visibility = 'session-private';
ALTER TABLE entries ADD CONSTRAINT entries_visibility_check
  CHECK (visibility IN ('conversation-private','principal-private','organization-shared','partner-shared','public'));
DROP INDEX IF EXISTS entries_scope;
CREATE INDEX IF NOT EXISTS entries_scope ON entries (state, visibility, conversation_id, principal_id, backing_identity_id);
CREATE INDEX IF NOT EXISTS entries_conversation ON entries (conversation_id, initiated_at DESC, id DESC);
ALTER TABLE entries DROP COLUMN IF EXISTS text_preview;

ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'principal-private';
ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';
UPDATE working_memory SET state = COALESCE(data->>'state', 'active'), visibility = COALESCE(data->>'visibility', 'principal-private');
CREATE INDEX IF NOT EXISTS working_memory_scope ON working_memory (state, visibility, principal_id);

ALTER TABLE preferences ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'principal-private';
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS state TEXT NOT NULL DEFAULT 'active';
CREATE INDEX IF NOT EXISTS preferences_scope ON preferences (state, visibility, principal_id);

ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS backing_identity_id TEXT;
DROP INDEX IF EXISTS rag_scope;
CREATE INDEX IF NOT EXISTS rag_scope ON rag_chunks (state, visibility, backing_identity_id);

CREATE TABLE IF NOT EXISTS admin_audit (
  id TEXT PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_audit_ts ON admin_audit (ts DESC);
`,
  },
  {
    // D77: a preference keeps its name and value only as ciphertext under a key of its own, found by a keyed index
    // of its name (working-memory notes keep theirs in `data`, which needs no column)
    version: '3.5.0',
    sql: `
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS enc_key_ref TEXT;
ALTER TABLE preferences ADD COLUMN IF NOT EXISTS cipher BYTEA;
`,
  },
  {
    // decision 60 (SPACE-DEF, SPACE-CONV-001, MEM-SPACE-001): spaces, their members and what was done in them; a space's title, purpose and brief and a member's
    // email are sealed in `data`, which keeps in the clear only what the lists and the membership need. Every
    // conversation and every note belongs to a space: those of an earlier version to the Personal space of their
    // Principal. A conversation its author shares with its space carries the time it was shared
    version: '3.6.0',
    sql: `
CREATE TABLE IF NOT EXISTS spaces (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('team','organization')),
  template_id TEXT NOT NULL,
  membership_mode TEXT NOT NULL CHECK (membership_mode IN ('rule','list')),
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS spaces_agent ON spaces (agent_id, created_at);

CREATE TABLE IF NOT EXISTS space_members (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  principal_id TEXT,
  directory_id TEXT,
  organization_key TEXT,
  email_index TEXT,
  state TEXT NOT NULL CHECK (state IN ('invited','active','left')),
  role TEXT NOT NULL CHECK (role IN ('owner','member','guest')),
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS space_members_space ON space_members (space_id, created_at);
CREATE INDEX IF NOT EXISTS space_members_principal ON space_members (principal_id);
CREATE INDEX IF NOT EXISTS space_members_invitee ON space_members (organization_key, email_index);

CREATE TABLE IF NOT EXISTS space_activity (
  seq BIGSERIAL PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  space_id TEXT NOT NULL,
  at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS space_activity_space ON space_activity (space_id, at DESC, seq DESC);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS space_id TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS shared_at TIMESTAMPTZ;
UPDATE conversations SET space_id = COALESCE(data->>'spaceId', 'personal:' || principal_id) WHERE space_id IS NULL;
UPDATE conversations SET data = jsonb_set(data, '{spaceId}', to_jsonb(space_id)) WHERE data->>'spaceId' IS NULL;
ALTER TABLE conversations ALTER COLUMN space_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_space ON conversations (space_id, last_activity_at DESC);

-- every entry carries the space of its conversation (SPACE-CONV-001); the retention of a space reads it (PRIV-RETN-008)
ALTER TABLE entries ADD COLUMN IF NOT EXISTS space_id TEXT;
UPDATE entries e SET space_id = c.space_id FROM conversations c WHERE c.id = e.conversation_id AND e.space_id IS NULL;
UPDATE entries SET space_id = 'personal:' || principal_id WHERE space_id IS NULL AND principal_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entries_space_retention ON entries (space_id, state, created_at);

ALTER TABLE working_memory ADD COLUMN IF NOT EXISTS space_id TEXT;
UPDATE working_memory SET space_id = COALESCE(data->>'spaceId', 'personal:' || principal_id) WHERE space_id IS NULL;
UPDATE working_memory SET data = jsonb_set(data, '{spaceId}', to_jsonb(space_id)) WHERE data->>'spaceId' IS NULL;
ALTER TABLE working_memory ALTER COLUMN space_id SET NOT NULL;
DROP INDEX IF EXISTS working_memory_scope;
CREATE INDEX IF NOT EXISTS working_memory_scope ON working_memory (state, visibility, principal_id, space_id);
`,
  },
  {
    // decision 61 (IDENT-DIR-006, IDENT-ROLE-012/013, D91): an issuance record names, in its audit fields, the entry of the
    // user directory its claims came from and a keyed index of the actor its identity credential identifies; both are
    // columns, so that a removal from the directory finds what to revoke and a presented badge finds its entry. The
    // members of a space are found by their entry, and a reload's changes are listed from the admin audit, newest first
    // (IDENT-DIR-009): its rows get the order they were written in
    version: '3.7.0',
    sql: `
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS directory_entry_id TEXT;
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS holder_index TEXT;
CREATE INDEX IF NOT EXISTS evidence_directory_entry ON evidence (directory_entry_id) WHERE directory_entry_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_holder ON evidence (holder_index) WHERE holder_index IS NOT NULL;

CREATE INDEX IF NOT EXISTS space_members_directory ON space_members (directory_id) WHERE directory_id IS NOT NULL;

ALTER TABLE admin_audit ADD COLUMN IF NOT EXISTS seq BIGSERIAL;
CREATE INDEX IF NOT EXISTS admin_audit_action ON admin_audit (action, ts DESC, seq DESC);
`,
  },
  {
    // decision 64 (INTX-AUTH-021): the sentences of the service translated by the model, kept by the digest of the
    // English sentence and the language, so that a sentence costs one call per language. A sentence of the service holds
    // no personal data (no address, no code, nothing a person typed): it is kept in the clear, with no retention
    version: '3.8.0',
    sql: `
CREATE TABLE IF NOT EXISTS translations (
  digest TEXT NOT NULL,
  language TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (digest, language)
);
`,
  },
  {
    // tools, phase 1 (ayni-spec D97 to D100): the sources of each space and their state (TOOL-SPACE-001); the space's account
    // of a source, its token only as ciphertext under a key of the row, which deleting the row destroys (TOOL-ACCESS-004);
    // the allowances of a conversation (TOOL-CALL-006); the record of each call the model asks for, kept indefinitely and
    // holding no argument, result or account value (TOOL-PROV-004)
    version: '3.9.0',
    sql: `
CREATE TABLE IF NOT EXISTS space_tools (
  space_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  data JSONB NOT NULL,
  PRIMARY KEY (space_id, source_id)
);

CREATE TABLE IF NOT EXISTS space_accounts (
  space_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  enc_key_ref TEXT NOT NULL,
  cipher BYTEA NOT NULL,
  set_at TIMESTAMPTZ NOT NULL,
  set_by TEXT NOT NULL,
  PRIMARY KEY (space_id, source_id)
);

CREATE TABLE IF NOT EXISTS tool_allowances (
  approval_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  space_id TEXT,
  source_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_allowances_conversation ON tool_allowances (conversation_id);
CREATE INDEX IF NOT EXISTS tool_allowances_space_source ON tool_allowances (space_id, source_id);

CREATE TABLE IF NOT EXISTS tool_calls (
  id TEXT PRIMARY KEY,
  at TIMESTAMPTZ NOT NULL,
  principal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_principal ON tool_calls (principal_id, at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_space ON tool_calls (space_id, at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_conversation ON tool_calls (conversation_id, at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_source ON tool_calls (source_id, at DESC);
`,
  },
  {
    // tools, phase 2 (ayni-spec D104 to D110): the key of each person who connects an account, wrapped by the master key,
    // whose deletion makes every account of theirs unreadable (D106, PRIV-ERASE-013); each person's own accounts, their
    // tokens or values and their label only as ciphertext under a key of the row wrapped by the person's key, one per
    // (person, source, value of its binding) (TOOL-ACCESS-009, TOOL-CONN-002); the sign-ins in the browser, found by a
    // digest of their state, single use (TOOL-OAUTH-005); the agent's clients at the authorization servers (TOOL-OAUTH-003)
    version: '3.10.0',
    sql: `
CREATE TABLE IF NOT EXISTS person_keys (
  principal_id TEXT PRIMARY KEY,
  wrapped_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS personal_accounts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  binding_value TEXT NOT NULL DEFAULT '',
  binding_label TEXT,
  method TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  more_access BOOLEAN NOT NULL DEFAULT false,
  enc_key_ref TEXT NOT NULL,
  cipher BYTEA NOT NULL,
  label_cipher BYTEA,
  pack_digest TEXT NOT NULL,
  scopes_digest TEXT NOT NULL,
  connected_at TIMESTAMPTZ NOT NULL,
  refreshed_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  UNIQUE (principal_id, source_id, binding_value)
);
CREATE INDEX IF NOT EXISTS personal_accounts_principal ON personal_accounts (principal_id);

CREATE TABLE IF NOT EXISTS oauth_attempts (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  state_hash TEXT NOT NULL UNIQUE,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_attempts_principal ON oauth_attempts (principal_id);

CREATE TABLE IF NOT EXISTS oauth_clients (
  ref TEXT PRIMARY KEY,
  data JSONB NOT NULL
);
`,
  },
  {
    // a device secret is handed to its client once and only its hash is kept (D51, IDENT-DEV-001): the secrets an
    // earlier version left on the session records are erased
    version: '3.11.0',
    sql: `
UPDATE sessions SET data = data - 'deviceSecret' - 'deviceSecretAt' WHERE data ? 'deviceSecret' OR data ? 'deviceSecretAt';
`,
  },
  {
    // space governance (ayni-spec D135 to D142): one owner of a space, the first of its owners, and no list of them; an
    // approval of a tool of a space waits under a policy (its owner, required, one approval, attested, own confirmation:
    // what the owner's approval was), no longer `ownerApproval`; the notices of a space's governance, each in one
    // person's Notifications, waiting until `resolved_at` for the kinds that wait
    version: '3.12.0',
    sql: `
UPDATE spaces SET data = (data - 'ownerIds') || jsonb_build_object('ownerPrincipalId', data->'ownerIds'->0)
  WHERE data ? 'ownerIds' AND jsonb_array_length(data->'ownerIds') > 0;
UPDATE spaces SET data = data - 'ownerIds' WHERE data ? 'ownerIds';
UPDATE approvals SET data = (data - 'ownerApproval') || jsonb_build_object('spacePolicy', jsonb_build_object(
    'approvers', jsonb_build_array(jsonb_build_object('kind', 'owner', 'required', true)),
    'threshold', 1, 'refusal', 'any', 'attested', true, 'whenApproverAsks', 'own-confirmation'))
  WHERE data->>'ownerApproval' = 'true';
UPDATE approvals SET data = data - 'ownerApproval' WHERE data ? 'ownerApproval';

CREATE TABLE IF NOT EXISTS governance_notices (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('owner-changed','policy-attention','no-approver','space-without-owner')),
  at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS governance_notices_principal ON governance_notices (principal_id, at DESC);
CREATE INDEX IF NOT EXISTS governance_notices_space ON governance_notices (space_id, kind) WHERE resolved_at IS NULL;
`,
  },
  {
    // a badge is offered only on a connection that holds none still valid, and issued again there on the holder's
    // request after the one of that connection is revoked (IDENT-AUTH-016, INTX-ISSUE-022, D156): an issuance record
    // names the connection it was offered on in a column, so that what a wallet was issued is found whatever Principal
    // the connection belongs to
    version: '3.13.0',
    sql: `
ALTER TABLE evidence ADD COLUMN IF NOT EXISTS issued_on TEXT;
UPDATE evidence SET issued_on = data->>'connectionRef'
  WHERE data->>'kind' = 'issuance' AND issued_on IS NULL AND data->>'connectionRef' IS NOT NULL;
CREATE INDEX IF NOT EXISTS evidence_issued_on ON evidence (issued_on, verified_at) WHERE issued_on IS NOT NULL;
`,
  },
  {
    // a badge is held by the person, not by a connection (IDENT-AUTH-016, D156 as amended): what a Principal was issued
    // is found by the Principal (evidence_principal), and the column of the connection an issuance was offered on, which
    // the record still names, is read no more
    version: '3.14.0',
    sql: `
DROP INDEX IF EXISTS evidence_issued_on;
ALTER TABLE evidence DROP COLUMN IF EXISTS issued_on;
`,
  },
]
