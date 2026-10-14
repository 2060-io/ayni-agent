/**
 * Deployment values and secrets (spec reference-implementation-profile, "Container configuration").
 * Everything behavioral lives in the agent-pack (CORE-PACK-001); these are the deployment knobs.
 */

export interface Env {
  agentPackPath: string
  publicBaseUrl: string
  port: number
  logLevel: string
  nodeEnv: string

  vsAgentAdminUrl: string
  vsAgentEventsApiKey?: string
  userAgentGate?: 'required' | 'optional'
  walletLinkTemplate?: string
  /** development only: a DIDComm peer that presents no ECS-Badge becomes an unidentified Principal */
  devAllowUnidentifiedPrincipals: boolean

  sessionTokenSecret: string
  sessionIdleTimeoutSeconds?: number
  bindingExpirySeconds?: number
  credentialCheckTtlSeconds?: number
  aguiAllowedOrigins: string[]
  uploadMaxBytes?: number
  uploadTypes?: string[]

  store: 'postgres' | 'memory'
  databaseUrl?: string
  redisUrl?: string
  objectStore?: {
    endpoint: string
    bucket: string
    region: string
    accessKey: string
    secretKey: string
    forcePathStyle: boolean
  }
  presignedUrlTtlSeconds: number
  entryEncryptionKey: Buffer
  retentionHistoryDays: number
  retentionMediaGraceDays: number

  anchoringEnabled: boolean
  veranaRpcUrl?: string
  veranaApiUrl?: string
  veranaChainId?: string
  anchorSignerMnemonic?: string
  anchorAuthority?: string
  anchorBatchIntervalSeconds: number

  sttProvider?: string
  sttBaseUrl?: string
  sttApiKey?: string
  imageProvider?: string
  imageApiKey?: string
  visionUrl?: string
  webrtcServerUrl?: string
  faceMatchTimeoutSeconds: number

  statsEnabled: boolean
  statsSink: 'redis-stream' | 'http'
  statsHttpUrl?: string
}

function num(value: string | undefined, fallback?: number): number | undefined {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${value}"`)
  return n
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function list(value: string | undefined): string[] | undefined {
  if (!value) return undefined
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const missing: string[] = []
  const required = (name: string): string => {
    const value = source[name]
    if (!value) missing.push(name)
    return value ?? ''
  }

  const store = (source.STORE as Env['store']) ?? 'postgres'
  const env: Env = {
    agentPackPath: required('AGENT_PACK_PATH'),
    publicBaseUrl: required('PUBLIC_BASE_URL').replace(/\/+$/, ''),
    port: num(source.PORT, 3010) as number,
    logLevel: source.LOG_LEVEL ?? 'info',
    nodeEnv: source.NODE_ENV ?? 'development',

    vsAgentAdminUrl: (source.VS_AGENT_ADMIN_URL ?? '').replace(/\/+$/, ''),
    vsAgentEventsApiKey: source.VS_AGENT_EVENTS_API_KEY || undefined,
    userAgentGate: source.USER_AGENT_GATE as Env['userAgentGate'],
    walletLinkTemplate: source.WALLET_LINK_TEMPLATE || undefined,
    devAllowUnidentifiedPrincipals: bool(source.DEV_ALLOW_UNIDENTIFIED_PRINCIPALS, false),

    sessionTokenSecret: required('SESSION_TOKEN_SECRET'),
    sessionIdleTimeoutSeconds: num(source.SESSION_IDLE_TIMEOUT_SECONDS),
    bindingExpirySeconds: num(source.BINDING_EXPIRY_SECONDS),
    credentialCheckTtlSeconds: num(source.CREDENTIAL_CHECK_TTL_SECONDS),
    aguiAllowedOrigins: list(source.AGUI_ALLOWED_ORIGINS) ?? [],
    uploadMaxBytes: num(source.UPLOAD_MAX_BYTES),
    uploadTypes: list(source.UPLOAD_TYPES),

    store,
    databaseUrl: source.DATABASE_URL || undefined,
    redisUrl: source.REDIS_URL || undefined,
    objectStore: source.OBJECT_STORE_ENDPOINT
      ? {
          endpoint: source.OBJECT_STORE_ENDPOINT,
          bucket: required('OBJECT_STORE_BUCKET'),
          region: source.OBJECT_STORE_REGION || 'us-east-1',
          accessKey: required('OBJECT_STORE_ACCESS_KEY'),
          secretKey: required('OBJECT_STORE_SECRET_KEY'),
          forcePathStyle: bool(source.OBJECT_STORE_FORCE_PATH_STYLE, true),
        }
      : undefined,
    presignedUrlTtlSeconds: num(source.PRESIGNED_URL_TTL_SECONDS, 300) as number,
    entryEncryptionKey: Buffer.from(required('ENTRY_ENCRYPTION_KEY') || '00'.repeat(32), 'hex'),
    retentionHistoryDays: num(source.RETENTION_HISTORY_DAYS, 365) as number,
    retentionMediaGraceDays: num(source.RETENTION_MEDIA_GRACE_DAYS, 30) as number,

    anchoringEnabled: bool(source.ANCHORING_ENABLED, true),
    veranaRpcUrl: source.VERANA_RPC_URL || undefined,
    veranaApiUrl: (source.VERANA_API_URL || '').replace(/\/+$/, '') || undefined,
    veranaChainId: source.VERANA_CHAIN_ID || undefined,
    anchorSignerMnemonic: source.ANCHOR_SIGNER_MNEMONIC || undefined,
    anchorAuthority: source.ANCHOR_AUTHORITY || undefined,
    anchorBatchIntervalSeconds: num(source.ANCHOR_BATCH_INTERVAL_SECONDS, 600) as number,

    sttProvider: source.STT_PROVIDER || undefined,
    sttBaseUrl: source.STT_BASE_URL || undefined,
    sttApiKey: source.STT_API_KEY || undefined,
    imageProvider: source.IMAGE_PROVIDER || undefined,
    imageApiKey: source.IMAGE_API_KEY || undefined,
    visionUrl: source.VISION_URL || undefined,
    webrtcServerUrl: source.WEBRTC_SERVER_URL || undefined,
    faceMatchTimeoutSeconds: num(source.FACE_MATCH_TIMEOUT_SECONDS, 180) as number,

    statsEnabled: bool(source.STATS_ENABLED, false),
    statsSink: (source.STATS_SINK as Env['statsSink']) ?? 'redis-stream',
    statsHttpUrl: source.STATS_HTTP_URL || undefined,
  }

  if (store === 'postgres' && !env.databaseUrl) missing.push('DATABASE_URL')
  if (missing.length) throw new Error(`missing environment variables: ${missing.join(', ')}`)
  if (env.entryEncryptionKey.length !== 32) throw new Error('ENTRY_ENCRYPTION_KEY must be 32 bytes in hex')
  if (env.devAllowUnidentifiedPrincipals && env.nodeEnv === 'production') {
    throw new Error('DEV_ALLOW_UNIDENTIFIED_PRINCIPALS is refused in production')
  }
  return env
}
