/** Composition root: configuration, persistence, models, core, channels, jobs. */
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import Fastify, { type FastifyInstance } from 'fastify'
import { Redis } from 'ioredis'
import { A2aAdapter, A2aRoutes } from './channels/a2a/routes.js'
import { AgUiAdapter } from './channels/agui/adapter.js'
import { AgUiRoutes } from './channels/agui/routes.js'
import { SessionStreams } from './channels/agui/streams.js'
import { DidcommAdapter, MediaLinks } from './channels/didcomm/adapter.js'
import { registerDidcommCallbacks } from './channels/didcomm/callbacks.js'
import { DidcommEvents } from './channels/didcomm/events.js'
import { IdentityFlow, TrustResolver } from './channels/didcomm/identity.js'
import { VsAgentClient } from './channels/didcomm/vsAgentClient.js'
import { type Env, loadEnv } from './config/env.js'
import { loadPack } from './config/pack.js'
import { featuresOf } from './config/packTypes.js'
import { HologramAgent } from './core/agent.js'
import { ChallengeService } from './core/challenges.js'
import { CapabilityRouter } from './core/channel.js'
import { Orchestrator } from './core/orchestrator.js'
import { PrincipalService } from './core/principals.js'
import { PROMPT_ADDON_VERSION } from './core/promptAddon.js'
import { SessionService } from './core/sessions.js'
import { AnchoringService, VeranaLedgerWriter } from './integrity/anchoring.js'
import { createChatModel, createEmbeddings } from './llm/index.js'
import { createImageGenerators } from './media/imageGen.js'
import { MemoryObjectStore, type ObjectStore, S3ObjectStore } from './media/objectStore.js'
import { MediaService } from './media/service.js'
import { createTranscriber } from './media/stt.js'
import { createImageDescriber } from './media/vision.js'
import { createEntryCrypto } from './memory/crypto.js'
import { RagService } from './memory/rag.js'
import { MemoryService } from './memory/service.js'
import { RetentionService } from './platform/retention.js'
import { HttpStats, NoopStats, RedisStreamStats, type StatsSink, StoreStats } from './platform/stats.js'
import { ApprovalService } from './policy/approvals.js'
import { MEMORY_SCHEMA_VERSION } from './store/migrations.js'
import { createStore } from './store/postgres.js'
import { BundledToolSource } from './tools/bundled.js'
import { HttpToolSource } from './tools/http.js'
import { createMcpSources } from './tools/mcp.js'
import { ToolRegistry } from './tools/registry.js'
import { schedule } from './util/async.js'
import { createLogger, type Logger } from './util/logger.js'

export interface RunningAgent {
  app: FastifyInstance
  agent: HologramAgent
  stop(): Promise<void>
}

export async function buildAgent(
  env: Env = loadEnv(),
  logger: Logger = createLogger(env.logLevel)
): Promise<RunningAgent> {
  const { pack, dir: packDir } = loadPack(env.agentPackPath)
  if (env.userAgentGate) pack.identity.userAgentGate = env.userAgentGate
  const features = featuresOf(pack)
  logger.info(
    {
      agent: pack.metadata.id,
      schema: pack.schemaVersion,
      memorySchema: MEMORY_SCHEMA_VERSION,
      promptAddon: PROMPT_ADDON_VERSION,
    },
    'agent-pack loaded (CORE-VER-001)'
  )

  const store = createStore(env.store, env.databaseUrl)
  await store.init()
  const crypto = createEntryCrypto(env.entryEncryptionKey)
  const llm = createChatModel(pack.llm)
  const embeddings = createEmbeddings(pack.embeddings)
  const memory = new MemoryService(store, crypto, embeddings, pack, logger)
  const objects: ObjectStore = env.objectStore
    ? new S3ObjectStore(env.objectStore, crypto)
    : new MemoryObjectStore(crypto)
  if (!env.objectStore)
    logger.warn('OBJECT_STORE_ENDPOINT not set: media objects are kept in memory (development only)')

  const redis = env.redisUrl ? new Redis(env.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 }) : undefined
  if (redis) await redis.connect().catch((err) => logger.warn({ err }, 'redis unavailable'))
  let stats: StatsSink = new NoopStats()
  if (env.statsEnabled || pack.statistics?.enabled) {
    const sink = pack.statistics?.sink ?? env.statsSink
    if (sink === 'http' && (pack.statistics?.httpUrl ?? env.statsHttpUrl))
      stats = new HttpStats(String(pack.statistics?.httpUrl ?? env.statsHttpUrl), logger)
    else if (redis) stats = new RedisStreamStats(redis, store, logger)
    else stats = new StoreStats(store, logger)
  }

  const router = new CapabilityRouter(store, logger)
  const vsAgent = new VsAgentClient(env.vsAgentAdminUrl, logger)
  const resolver = new TrustResolver(env.veranaApiUrl, logger)
  const principals = new PrincipalService(store, pack, resolver, logger, env.credentialCheckTtlSeconds)
  const mediaLinks = new MediaLinks(env.presignedUrlTtlSeconds * 1000)
  const didcomm = new DidcommAdapter(
    vsAgent,
    env.publicBaseUrl,
    mediaLinks,
    env.webrtcServerUrl ?? pack.media?.faceVerification?.webrtcServerUrl,
    logger
  )
  const streams = new SessionStreams(store, logger)
  const agui = new AgUiAdapter(streams)
  const a2a = new A2aAdapter()
  router.register(didcomm)
  router.register(agui)
  router.register(a2a)

  let aguiRoutes: AgUiRoutes | undefined
  const sessions = new SessionService(
    store,
    pack,
    env.sessionTokenSecret,
    didcomm,
    {
      onBound: async (session) => {
        if (session.channelType === 'ag-ui') await aguiRoutes?.announceBound(session)
      },
      onClosed: async (session) => {
        if (session.channelType === 'ag-ui') await aguiRoutes?.announceState(session)
      },
      onBindingRefreshed: async () => {},
    },
    logger,
    { idleTimeoutSeconds: env.sessionIdleTimeoutSeconds, bindingExpirySeconds: env.bindingExpirySeconds }
  )

  let agentRef: HologramAgent | undefined
  const approvals = new ApprovalService(store, pack, {
    onChange: (record, change) => agentRef?.onApprovalChange(record, change) ?? Promise.resolve(),
  })
  const challenges = new ChallengeService(
    store,
    pack,
    router,
    logger,
    pack.media?.faceVerification?.timeoutSeconds ?? env.faceMatchTimeoutSeconds
  )
  challenges.setChannelOps(didcomm)

  const media = new MediaService(
    pack,
    store,
    objects,
    memory,
    router,
    createTranscriber(pack),
    createImageDescriber(pack, llm),
    createImageGenerators(pack),
    logger
  )
  const rag = features.rag && pack.rag ? new RagService(pack, packDir, store, embeddings, memory, logger) : undefined

  const registry = new ToolRegistry(logger)
  registry.add(new HttpToolSource(pack.tools?.http ?? [], pack.tools?.access))
  let orchestratorRef: Orchestrator | undefined
  registry.add(
    new BundledToolSource({
      pack,
      store,
      memory,
      media,
      rag,
      stats,
      setReactionPolicy: (sid, policy) => orchestratorRef?.setReactionPolicy(sid, policy),
    })
  )
  for (const source of createMcpSources(pack.mcp?.servers ?? [], logger)) registry.add(source, false)

  const orchestrator = new Orchestrator(
    pack,
    llm,
    memory,
    principals,
    registry,
    approvals,
    challenges,
    objects,
    stats,
    {
      onCredentialInvalid: (principal) => agentRef?.onCredentialInvalid(principal) ?? Promise.resolve(),
      onApprovalPending: async (session, _principal, record, entry) => {
        await router.deliver(session, { kind: 'approval', entry, approval: record })
      },
    },
    logger
  )
  orchestratorRef = orchestrator

  const agent = new HologramAgent({
    env,
    pack,
    store,
    memory,
    media,
    rag,
    principals,
    sessions,
    router,
    registry,
    approvals,
    challenges,
    orchestrator,
    llm,
    stats,
    logger,
  })
  agentRef = agent
  didcomm.attach(agent)
  agui.attach(agent)

  // ---- HTTP ------------------------------------------------------------------------------------
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: true })
  const allowedOrigins = env.aguiAllowedOrigins.length
    ? env.aguiAllowedOrigins
    : (pack.channels?.agui?.allowedOrigins ?? [])
  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')),
    credentials: true,
    allowedHeaders: ['authorization', 'content-type', 'last-event-id', 'accept'],
    exposedHeaders: ['retry-after'],
  })
  const uploadMax = env.uploadMaxBytes ?? pack.channels?.agui?.uploads?.maxBytes ?? 26214400
  await app.register(multipart, { limits: { fileSize: uploadMax, files: 1 } })

  let did = 'did:unknown'
  try {
    const info = await vsAgent.info()
    did = info.did
    logger.info({ did, vsAgent: info.version }, 'DIDComm agent reachable (IDENT-SELF-001)')
  } catch (error) {
    logger.error(
      { err: error, url: env.vsAgentAdminUrl },
      'DIDComm agent not reachable; binding and trust-bound events are unavailable until it is'
    )
  }

  aguiRoutes = new AgUiRoutes(agent, agui, streams, logger)
  aguiRoutes.register(app, did)
  const identity = new IdentityFlow(pack, vsAgent, resolver, env.devAllowUnidentifiedPrincipals, logger)
  new DidcommEvents(agent, vsAgent, identity, didcomm, env.vsAgentEventsApiKey, logger).register(app)
  registerDidcommCallbacks(app, agent, mediaLinks, logger)
  if (pack.channels?.a2a?.enabled) new A2aRoutes(agent, a2a, logger).register(app, did)

  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    const ready = await vsAgent.ready().catch(() => false)
    return reply
      .code(ready ? 200 : 503)
      .send({ status: ready ? 'ok' : 'degraded', did, agent: pack.metadata.id, memorySchema: MEMORY_SCHEMA_VERSION })
  })
  // PLAT-STATS-001: the query API (inside the deployment, like the Admin API it mirrors)
  app.get('/stats', async (request, reply) => {
    const q = request.query as {
      from?: string
      to?: string
      statClass?: string
      granularity?: 'hour' | 'day' | 'month'
    }
    if (!q.from || !q.to) return reply.code(400).send({ error: 'bad-request', message: 'from and to are required' })
    return store.stats.query({ from: q.from, to: q.to, statClass: q.statClass, granularity: q.granularity ?? 'day' })
  })
  app.get('/integrity/anchors', async () => store.anchors.list())

  // ---- jobs ------------------------------------------------------------------------------------
  const anchoringEnabled = env.anchoringEnabled && features.anchoring && pack.integrity?.anchoring?.enabled !== false
  let ledger: VeranaLedgerWriter | undefined
  if (anchoringEnabled && env.veranaRpcUrl && env.anchorSignerMnemonic) {
    const authority =
      env.anchorAuthority ??
      (await resolver
        .resolve(did)
        .then((r) => (r as { corporation?: { policyAddress?: string } }).corporation?.policyAddress)
        .catch(() => undefined))
    if (authority) ledger = new VeranaLedgerWriter(env.veranaRpcUrl, env.anchorSignerMnemonic, authority)
    else
      logger.warn(
        'anchoring enabled but no authority (ANCHOR_AUTHORITY or the agent corporation policy address) is known'
      )
  } else if (anchoringEnabled)
    logger.warn(
      'anchoring enabled but VERANA_RPC_URL or ANCHOR_SIGNER_MNEMONIC is missing: batches are recorded locally and queued'
    )
  const anchoring = new AnchoringService(store, ledger, pack.integrity?.anchoring?.maxBatchEntries ?? 1000, logger)
  const retention = new RetentionService(
    store,
    memory,
    env.objectStore ? objects : undefined,
    env.retentionHistoryDays,
    env.retentionMediaGraceDays,
    logger
  )
  const onJobError = (name: string, error: unknown) => logger.error({ err: error, job: name }, 'job failed')
  const stops = [
    schedule('reap-sessions', 30_000, async () => void (await sessions.reap()), onJobError),
    schedule('expire-approvals', 60_000, async () => void (await approvals.expirePending()), onJobError),
    schedule('retention', 6 * 3_600_000, () => retention.tick(), onJobError),
  ]
  if (anchoringEnabled)
    stops.push(
      schedule(
        'anchoring',
        (pack.integrity?.anchoring?.batchIntervalSeconds ?? env.anchorBatchIntervalSeconds) * 1000,
        () => anchoring.tick(),
        onJobError
      )
    )
  if (stats instanceof RedisStreamStats)
    stops.push(schedule('stats-drain', 15_000, async () => void (await stats.drain()), onJobError))
  if (rag) {
    rag.ingestAll().catch((err) => logger.error({ err }, 'rag ingestion failed'))
    const every = rag.refreshIntervalMs()
    if (every) stops.push(schedule('rag-refresh', every, () => rag.ingestAll(), onJobError))
  }

  return {
    app,
    agent,
    stop: async () => {
      for (const stop of stops) stop()
      await app.close()
      await registry.close()
      await redis?.quit().catch(() => undefined)
      await store.close()
    },
  }
}

export async function start(): Promise<RunningAgent> {
  const env = loadEnv()
  const logger = createLogger(env.logLevel)
  const running = await buildAgent(env, logger)
  await running.app.listen({ port: env.port, host: '0.0.0.0' })
  logger.info({ port: env.port, publicBaseUrl: env.publicBaseUrl }, 'hologram-agent listening')
  return running
}
