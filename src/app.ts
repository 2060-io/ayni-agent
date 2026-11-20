/** Composition root: configuration, persistence, models, core, channels, jobs. */

import { resolve as resolvePath } from 'node:path'
import { DESCRIPTOR_PATH, DID_SERVICE_TYPE } from '@ayni.org/ayni-agui-profile'
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
import { CredentialDefinitions } from './channels/didcomm/credentialDefinitions.js'
import { CredentialOffers } from './channels/didcomm/credentialOffers.js'
import { DidcommEvents } from './channels/didcomm/events.js'
import { actorIdentityOf, IdentityFlow, TrustResolver } from './channels/didcomm/identity.js'
import { IdentityRequests } from './channels/didcomm/identityRequests.js'
import { PeerProfiles } from './channels/didcomm/peerProfiles.js'
import { PeerStatusNotifier } from './channels/didcomm/peerStatus.js'
import { CredentialRevocations } from './channels/didcomm/revocations.js'
import { VsAgentClient } from './channels/didcomm/vsAgentClient.js'
import { type Env, loadEnv } from './config/env.js'
import { catalogWarnings, evidenceWarnings, loadPack } from './config/pack.js'
import {
  type AgentPack,
  admitsUnidentified,
  challengeTypesOf,
  directoryReadsDocuments,
  featuresOf,
  sourcesOfType,
} from './config/packTypes.js'
import { AyniAgent } from './core/agent.js'
import { ChallengeService } from './core/challenges.js'
import { CapabilityRouter } from './core/channel.js'
import { ContextAssembler } from './core/context.js'
import { UserDirectory } from './core/directory.js'
import { DirectoryClaims } from './core/directoryClaims.js'
import { documentOutcomeForModel } from './core/document.js'
import { EmailChecks } from './core/emailCheck.js'
import { EvidenceService } from './core/evidence.js'
import { FlowService } from './core/flows.js'
import { InvitationService } from './core/invitations.js'
import { IssuanceService, subjectIdKey } from './core/issuance.js'
import { Orchestrator } from './core/orchestrator.js'
import { HomeOrganization } from './core/organization.js'
import { TrustGraph } from './core/organizations.js'
import { PeopleService } from './core/people.js'
import { PrincipalService } from './core/principals.js'
import { PROMPT_ADDON_VERSION } from './core/promptAddon.js'
import { LANGUAGE_PREFERENCE, ServiceLanguage } from './core/serviceLanguage.js'
import { SessionService } from './core/sessions.js'
import { SpaceService } from './core/spaces.js'
import { SpaceToolService } from './core/spaceTools.js'
import { cardCapable, ToolGate } from './core/toolGate.js'
import { AnchoringService, VeranaLedgerWriter } from './integrity/anchoring.js'
import { createChatModel, createEmbeddings } from './llm/index.js'
import { createImageGenerators } from './media/imageGen.js'
import { MemoryObjectStore, type ObjectStore, S3ObjectStore } from './media/objectStore.js'
import { MediaService } from './media/service.js'
import { createTranscriber } from './media/stt.js'
import { createImageDescriber } from './media/vision.js'
import { createEntryCrypto } from './memory/crypto.js'
import { RagService } from './memory/rag.js'
import { storeShapeFaults } from './memory/scope.js'
import { MemoryService } from './memory/service.js'
import { buildAdmin } from './platform/admin.js'
import { createMailer, type Mailer } from './platform/mail.js'
import { RetentionService } from './platform/retention.js'
import { HttpStats, NoopStats, RedisStreamStats, type StatsSink, StoreStats } from './platform/stats.js'
import { ApprovalService, displayName as displayNameOf, sealedApprovals } from './policy/approvals.js'
import { MEMORY_SCHEMA_VERSION } from './store/migrations.js'
import { createStore } from './store/postgres.js'
import { BundledToolSource } from './tools/bundled.js'
import { ToolCatalog } from './tools/catalog.js'
import { HttpToolSource } from './tools/http.js'
import { createMcpSources, DEFAULT_IDLE_SECONDS } from './tools/mcp.js'
import { ToolRegistry } from './tools/registry.js'
import { schedule } from './util/async.js'
import { createLogger, type Logger } from './util/logger.js'

/** how long the runs whose turn is over are given to end their responses when the process stops */
const RUNS_END_WITHIN_MS = 2000

export interface RunningAgent {
  app: FastifyInstance
  /** the admin interface (D78), when ADMIN_PORT is not 0; never exposed */
  admin?: FastifyInstance
  agent: AyniAgent
  /** the retention job (PRIV-RETN, decision 60), for the tests that run it */
  retention: RetentionService
  /** the session streams of the AG-UI channel, for the tests that read what a session received */
  streams: SessionStreams
  stop(): Promise<void>
}

export async function buildAgent(
  env: Env = loadEnv(),
  logger: Logger = createLogger(env.logLevel),
  hooks: {
    /** the lock on the store is lost while the process runs; it ends the process when not given */
    storeLost?: (error?: Error) => void
    /** how long the turns in progress are given to end when the process stops */
    drainMs?: number
    /** the email of the agent, in place of the SMTP server of `MAIL_HOST` (the tests read what it sends) */
    mailer?: Mailer
    /** how the trust graph is asked, in place of the network (the tests answer it) */
    graphFetch?: typeof fetch
  } = {}
): Promise<RunningAgent> {
  const { pack, dir: packDir } = loadPack(env.agentPackPath)
  if (env.userAgentGate) pack.identity.userAgentGate = env.userAgentGate
  if (env.appLinkBase)
    pack.channels = { ...pack.channels, agui: { ...pack.channels?.agui, appLinkBase: env.appLinkBase } }
  if (env.unidentifiedPeers)
    logger.warn(
      'UNIDENTIFIED_PEERS is no longer read: who enters unidentified follows from identity.authentication of the agent-pack (D53)'
    )
  // who enters unidentified follows from the authentication alone, and is said at start-up (IDENT-RES-007)
  if (admitsUnidentified(pack))
    logger.warn(
      pack.identity.authentication?.length
        ? 'identity: the authentication lets guests in: user agents enter unidentified until they authenticate (D53, D72)'
        : 'identity: the agent-pack names no authentication schema: every user agent enters unidentified (D53)'
    )
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
  const crypto = createEntryCrypto(env.entryEncryptionKey)
  // the arguments of an approval, and the action its card shows, are kept sealed (INTX-APPR-014, D77)
  store.approvals = sealedApprovals(store.approvals, crypto)
  // the tool catalog: what each source answers to the four questions (D96); what it leaves to the operator is said
  const catalog = new ToolCatalog(pack)
  for (const warning of catalogWarnings(pack)) logger.warn(`agent-pack: ${warning}`)
  // the user directory (D79, IDENT-ROLE-012): read before anything else, and a file that does not validate stops the
  // start, naming the entry and the field (IDENT-DIR-001)
  const directoryFile = pack.identity.directory?.file
  const directory = directoryFile
    ? new UserDirectory(
        resolvePath(packDir, directoryFile),
        { roles: Object.keys(pack.identity.roles ?? {}), passport: directoryReadsDocuments(pack) },
        store.kv,
        store.adminAudit,
        crypto,
        logger
      )
    : undefined
  directory?.open()
  // one agent process at a time on a store (PLAT-DEPLOY-004): this one waits here until the one before is gone
  const releaseStore = await store.exclusive({
    onWaiting: () => logger.info('another agent process serves this store: waiting for it to end'),
    onLost:
      hooks.storeLost ??
      ((err) => {
        // it holds the store no more and another process may: it must not go on
        logger.fatal({ err }, 'the lock on the store is lost: the process ends')
        process.exit(1)
      }),
  })
  await store.init()
  // every store a retrieval reads holds the columns its predicate compares, or the agent does not start (PRIV-SCOPE-003)
  const shapeFaults = storeShapeFaults()
  if (shapeFaults.length)
    throw new Error(`the stores do not hold what the scope predicate needs: ${shapeFaults.join('; ')}`)
  const llm = createChatModel(pack.llm)
  const embeddings = createEmbeddings(pack.embeddings)
  const memory = new MemoryService(store, crypto, embeddings, pack, logger)
  const evidence = new EvidenceService(store, pack, crypto, logger)
  for (const warning of evidenceWarnings(pack)) logger.warn(`agent-pack: ${warning} (PRIV-EVID-006)`)
  // email: the email code and the invitations of other organizations, only through the deployment's SMTP server
  const mailer = hooks.mailer ?? createMailer(env.mail, logger)
  for (const warning of mailWarnings(pack, !!mailer, !!env.veranaGraphUrl)) logger.warn(warning)
  const s3 = env.objectStore ? new S3ObjectStore(env.objectStore, crypto) : undefined
  const objects: ObjectStore = s3 ?? new MemoryObjectStore(crypto)
  if (!s3) logger.warn('OBJECT_STORE_ENDPOINT not set: media objects are kept in memory (development only)')
  else
    await s3
      .init()
      .then(() => logger.info({ bucket: env.objectStore?.bucket }, 'object store ready'))
      .catch((err: unknown) => logger.error({ err }, 'object store unavailable: media uploads will fail until it is'))

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
  // the context of a turn: the window in steps, the sealed summary, the figure of a conversation (D74, D75)
  const context = new ContextAssembler(pack, llm, memory, store.kv, crypto, stats, logger)

  const router = new CapabilityRouter(store, logger)
  const vsAgent = new VsAgentClient(env.vsAgentAdminUrl, logger)
  const resolver = new TrustResolver(env.veranaApiUrl, logger)
  // home is the agent's own organization and no other (IDENT-ROLE-011): the one of its own Organization
  // credential, read through the DID the DIDComm agent reports, else the one the pack names
  let ownDid: string | undefined
  const home = new HomeOrganization(async () => {
    const candidates = [ownDid, pack.identity.homeBackingIdentity].filter(
      (d, i, all): d is string => !!d && !d.startsWith('did:example:') && all.indexOf(d) === i
    )
    for (const candidate of candidates) {
      const organization = resolver.organizationOf(await resolver.resolve(candidate))
      if (organization) return organization
    }
    return null
  }, logger)
  const principals = new PrincipalService(store, pack, resolver, logger, env.credentialCheckTtlSeconds, home)
  const mediaLinks = new MediaLinks(env.presignedUrlTtlSeconds * 1000)
  const peerProfiles = new PeerProfiles(store.kv, logger)
  const didcomm = new DidcommAdapter(
    vsAgent,
    env.publicBaseUrl,
    mediaLinks,
    env.webrtcServerUrl ?? pack.media?.faceVerification?.webrtcServerUrl,
    peerProfiles,
    logger
  )
  const streams = new SessionStreams(store, logger)
  const agui = new AgUiAdapter(streams)
  const a2a = new A2aAdapter()
  router.register(didcomm)
  router.register(agui)
  router.register(a2a)

  let aguiRoutes: AgUiRoutes | undefined
  let gateRef: ToolGate | undefined
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
      onConversationChanged: async (conversation) => {
        await aguiRoutes?.announceConversation(conversation)
        // archived or closed for good: its allowances end (TOOL-CALL-006)
        if (conversation.state !== 'active') await gateRef?.endConversationAllowances(conversation.id)
      },
    },
    logger,
    crypto,
    {
      idleTimeoutSeconds: env.sessionIdleTimeoutSeconds,
      bindingExpirySeconds: env.bindingExpirySeconds,
      grantExpirySeconds: env.grantExpirySeconds,
    }
  )

  // spaces (SPACE-CONV-001, PROF-CONV-011): a new conversation goes to the space asked when its Principal may use it, else Personal
  const spaces = new SpaceService(store, pack, crypto, logger, env.retentionHistoryDays)
  sessions.chooseSpace = (principal, requested) => spaces.spaceForNewConversation(principal, requested)

  // a message the agent adds outside a turn counts as unread until a device reports it viewed (IDENT-SESS-017)
  router.onAgentMessage = (session) => sessions.agentMessageAdded(session)
  // a conversation that loses an entry loses its summary and recomputes its last text (PRIV-ERASE-005)
  memory.hooks.conversationErased = async (conversationId) => {
    await context.discardSummary(conversationId)
    await sessions.refreshPreview(conversationId)
  }
  const sealed = await sessions.sealPlainConversations()
  if (sealed) logger.info({ sealed }, 'conversation titles and previews sealed (D77)')
  const resealed = await memory.sealPlainAttachments()
  if (resealed) logger.info({ resealed }, 'attachment texts and names sealed with their entries (D77)')
  const plainMemory = await memory.sealPlainNotesAndPreferences()
  if (plainMemory.notes || plainMemory.preferences)
    logger.info(plainMemory, 'working-memory notes and preferences sealed (D77)')

  let agentRef: AyniAgent | undefined
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
  const flows = new FlowService(vsAgent, memory, router, store.kv, logger)
  didcomm.setFlows(flows)

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
  registry.add(new HttpToolSource(sourcesOfType(pack, 'http')))
  let orchestratorRef: Orchestrator | undefined
  let identityRequestsRef: IdentityRequests | undefined
  let issuanceRef: IssuanceService | undefined
  let emailChecksRef: EmailChecks | undefined
  registry.add(
    new BundledToolSource({
      pack,
      store,
      memory,
      evidence,
      requestIdentity: async (principal, by) => (await identityRequestsRef?.request(principal, by)) ?? 'unavailable',
      issuance: () => issuanceRef,
      requestPresentation: async (principal, entry) =>
        (await identityRequestsRef?.present(principal, entry, 'model')) ?? 'unavailable',
      media,
      rag,
      stats,
      setReactionPolicy: (sid, policy) => orchestratorRef?.setReactionPolicy(sid, policy),
      emailChecks: () => emailChecksRef,
    })
  )
  for (const source of createMcpSources(
    sourcesOfType(pack, 'mcp'),
    logger,
    env.toolConnectionIdleSeconds ?? DEFAULT_IDLE_SECONDS
  ))
    registry.add(source, false)

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
    logger,
    context
  )
  orchestratorRef = orchestrator

  // the tools of the spaces (D98) and what a call needs, with the record of each call (D99, D100)
  const spaceTools = new SpaceToolService(
    store,
    pack,
    catalog,
    crypto,
    spaces,
    registry,
    challenges,
    logger,
    env.toolChangeConfirmationSeconds ?? 300
  )
  const gate = new ToolGate({
    pack,
    store,
    catalog,
    registry,
    spaces,
    spaceTools,
    approvals,
    memory,
    principals,
    challenges,
    stats,
    logger,
  })
  orchestrator.gate = gate
  gateRef = gate
  orchestrator.spaceById = (spaceId) => spaces.find(spaceId)
  approvals.spaceOwners = async (spaceId) => (await spaces.find(spaceId))?.ownerIds ?? []
  challenges.onSettled = (record) => spaceTools.settle(record)
  spaces.onCreated = (space) => spaceTools.onCreated(space)
  spaces.onOwnerChanged = (space) => spaceTools.onOwnerChanged(space)
  memory.hooks.approvalsErased = (records) => gate.onTurnErased(records)
  spaceTools.hooks = {
    accountEnded: (spaceId, sourceId) => registry.closeAccount(sourceId, spaceId),
    endAllowances: (spaceId, sourceId) => gate.endAllowancesFor(spaceId, sourceId),
    nameOf: async (principalId) => {
      const principal = await principals.get(principalId)
      return principal ? displayNameOf(principal) : ''
    },
    announce: async (space, value) => aguiRoutes?.announceSpaceTools(space, value),
  }
  gate.hooks = {
    onApprovalPending: async (session, _principal, record, entry) => {
      await router.deliver(session, { kind: 'approval', entry, approval: record })
    },
    onCredentialInvalid: (principal) => agentRef?.onCredentialInvalid(principal) ?? Promise.resolve(),
    // a card is asked only of the sessions of a client of profile 3.4 or later (TOOL-CALL-005, PROF-SESS-016)
    cardSessions: async (conversationId) => {
      const conversation = await sessions.conversationById(conversationId)
      if (!conversation) return []
      return (await sessions.sessionsOfConversation(conversation)).filter((s) => cardCapable(s.client.profileVersion))
    },
    toConversation: async (conversationId, events) => aguiRoutes?.announceToConversation(conversationId, events),
    deliver: async (session, entry) => {
      await router.deliver(session, { kind: 'text', entry })
    },
  }

  const agent = new AyniAgent({
    env,
    pack,
    store,
    memory,
    context,
    spaces,
    media,
    rag,
    principals,
    evidence,
    sessions,
    router,
    registry,
    approvals,
    challenges,
    flows,
    orchestrator,
    llm,
    stats,
    logger,
  })
  agentRef = agent
  agent.gate = gate
  agent.spaceTools = spaceTools
  agent.catalog = catalog
  // the notes the model reads and writes are those of the space of the conversation (MEM-SPACE-001), and a space may
  // not allow the model this agent uses (SPACE-CONV-004)
  orchestrator.spaceOf = (session, principal) => agent.spaceOfSession(session, principal)
  orchestrator.providerRefusal = (_session, principal, spaceId) => spaces.providerRefusal(principal, spaceId)
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
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['authorization', 'content-type', 'last-event-id', 'accept'],
    exposedHeaders: ['retry-after'],
  })
  const uploadMax = env.uploadMaxBytes ?? pack.channels?.agui?.uploads?.maxBytes ?? 26214400
  await app.register(multipart, { limits: { fileSize: uploadMax, files: 1 } })

  let did = 'did:unknown'
  try {
    const info = await vsAgent.info()
    did = info.did
    ownDid = did
    agent.did = did
    flows.setAgentDid(did)
    logger.info({ did, vsAgent: info.version }, 'DIDComm agent reachable (IDENT-SELF-001)')
  } catch (error) {
    logger.error(
      { err: error, url: env.vsAgentAdminUrl },
      'DIDComm agent not reachable; binding and trust-bound events are unavailable until it is'
    )
  }

  aguiRoutes = new AgUiRoutes(agent, agui, streams, logger)
  // the admin interface (D78): erasure, legal hold, the auditor's reads; served by start() on the loopback
  const admin =
    env.adminPort === 0
      ? undefined
      : buildAdmin({
          store,
          memory,
          evidence,
          logger,
          token: env.adminToken,
          announceErased: (principalId, conversationId, ids, clientIds) =>
            aguiRoutes?.announceErased(principalId, conversationId, ids, clientIds) ?? Promise.resolve(),
        })
  aguiRoutes.register(app, did)
  // what the person sends during a turn waits in the store and is answered next (D63): its devices are told what
  // waits, and the turn the agent starts for it goes to their streams
  agent.waitingChanged = (session) => {
    if (session.channelType !== 'ag-ui') return
    void (async () => {
      for (const each of [session, ...(await sessions.conversationPeers(session))]) await agui.pushState(each)
    })().catch((err) => logger.debug({ err, sessionId: session.id }, 'waiting messages not announced'))
  }
  // a message deleted while its reply is written stops that reply first (PRIV-ERASE-011)
  agent.cancelTurns = (key) => aguiRoutes?.cancelConversation(key) ?? 0
  agent.queuedRun = (session) => {
    if (session.channelType !== 'ag-ui' || !aguiRoutes) throw new Error('no channel shows this conversation')
    return aguiRoutes.queuedRun(session)
  }
  // the spaces follow their templates: the sources they add by themselves, those no longer named leave (TOOL-SPACE-011)
  await spaceTools.align()
  // what a restart left waiting is answered now
  await agent.resumeWaiting()
  if (did !== 'did:unknown') await declareAgUiService(vsAgent, did, env.publicBaseUrl, logger)
  const identity = new IdentityFlow(pack, vsAgent, resolver, env.devAllowUnidentifiedPrincipals, logger)
  identity.setFlows(flows)
  // each peer is told where it stands with the agent (D71); the descriptor declares it once the DIDComm agent
  // is known to speak the protocol (PROF-DESC-007)
  const peerStatus = new PeerStatusNotifier(pack, vsAgent, peerProfiles, logger)
  agent.peerStatus = peerStatus
  void peerStatus.supported()
  // the authentication asked on demand, by the model's tool or the person's menu item (IDENT-RES-015)
  identityRequestsRef = new IdentityRequests(
    pack,
    {
      authenticate: (connectionId, peerId, flowMode, userAgentVerified) =>
        identity.authenticate(connectionId, peerId, flowMode, userAgentVerified),
      isFlowCapable: (connectionId) => peerProfiles.isFlowCapable(connectionId),
      onIdentityPresented: async (connectionId, facts) => {
        const result = await agent.onIdentityPresented(connectionId, facts)
        // a person identified after connect is told so (IDENT-STAT-005)
        if (result.principal) await peerStatus.resolved(connectionId, result.principal)
        return result
      },
      present: (connectionId, name, entry, flowMode) => identity.present(connectionId, name, entry, flowMode),
      record: async (principal, input) => {
        const record = await evidence.record(principal, input)
        // a credential the agent issues by itself may now be complete (INTX-ISSUE-008)
        agent.issueAutomatically(principal)
        return record
      },
    },
    logger
  )
  agent.identityRequests = identityRequestsRef
  // credential issuance: the claims come from the sources of the profile, the offer goes to the Principal's wallet
  const credentialOffers = new CredentialOffers(vsAgent, flows, (c) => peerProfiles.isFlowCapable(c), logger)
  agent.credentialOffers = credentialOffers
  const credentialDefinitions = new CredentialDefinitions(vsAgent, logger)
  // the registry and the index of each credential issued under a revocable definition, and its revocation (decision 61)
  const credentialRevocations = new CredentialRevocations(
    vsAgent,
    store.kv,
    (definition) => credentialDefinitions.supportsRevocation(definition),
    logger
  )
  // the people of the user directory: who holds an entry, what a reload changes, the picker and the admin view
  const people = new PeopleService({
    pack,
    store,
    directory,
    principals,
    evidence,
    spaces,
    revocations: credentialRevocations,
    homeKey: () => home.key(),
    endAccess: (principal) => agent.onCredentialInvalid(principal),
    logger,
  })
  agent.people = people
  // the service's own sentences in the person's language: translated with no context by a model the space of the
  // conversation allows, kept by sentence and language (decision 64, INTX-AUTH-020..022)
  const serviceLanguage = new ServiceLanguage({
    store,
    llm,
    pack,
    stats,
    logger,
    preferredLanguage: (principal, session) => memory.preferenceOf(principal, session, LANGUAGE_PREFERENCE),
    modelAllowed: async (principal, session) =>
      !(await spaces.providerRefusal(principal, await agent.spaceOfSession(session, principal))),
  })
  agent.serviceLanguage = serviceLanguage
  // the email code of a badge from the directory, served by the code in the conversation (D89, INTX-AUTH-011..015)
  const emailChecks = new EmailChecks({
    store,
    memory,
    evidence,
    crypto,
    pack,
    directory,
    mailer,
    organizationName: async () => (await home.name()) ?? undefined,
    language: serviceLanguage,
    deliver: async (sessionId, entry) => {
      const session = await sessions.get(sessionId)
      if (session) await agent.deliverToConversation(session, entry)
    },
    passed: (record) => agent.continueIssuance(record),
    logger,
  })
  agent.emailChecks = emailChecks
  emailChecksRef = emailChecks
  await emailChecks.resume()
  // the claims of a badge from the directory: the entry the person's evidence finds (D88, INTX-ISSUE-021)
  const directoryClaims = directory ? new DirectoryClaims(directory, evidence, logger, emailChecks) : undefined
  // people of other organizations, invited by email and bound by their badge (D90, SPACE-INV)
  const graph = new TrustGraph(env.veranaGraphUrl, logger, hooks.graphFetch)
  const invitations = new InvitationService({
    pack,
    store,
    spaces,
    evidence,
    graph,
    mailer,
    home: async () => ({ key: await home.key(), name: await home.name() }),
    agentDid: () => agent.did,
    appLinkBase: pack.channels?.agui?.appLinkBase,
    nameOf: (principal) =>
      (principal.directoryEntryId ? directory?.view(principal.directoryEntryId)?.name : undefined) ??
      agent.principalDisplay(principal).displayName,
    isLive: async (principal) => !!(await router.capabilitySession(principal)),
    reveal: (principal) => identityRequestsRef?.reveal(principal) ?? Promise.resolve(),
    logger,
  })
  agent.invitations = invitations
  spaces.outsiders = invitations
  if (directory) principals.directory = people
  // a rule space reads the department and the groups of the entry a Principal holds, and nothing else (SPACE-MEMB-001)
  spaces.directory = (principal) => people.factsOf(principal)
  if (directory) spaces.people = directory
  issuanceRef = new IssuanceService(
    pack,
    evidence,
    {
      offer: (input) => credentialOffers.offer(input),
      definitionFor: (schema, options) => credentialDefinitions.forSchema(schema, options),
      allocateRevocation: (definition) => credentialRevocations.allocate(definition),
      // the actor the issued identity credential identifies once presented: the home organization, the schema and the
      // subject key (D59), of which its record keeps a keyed index (IDENT-ROLE-012)
      holderOf: async (_name, profile, claims) => {
        const authentication = pack.identity.authentication?.[0]
        const schema = profile.credential.jsonSchemaCredentialId
        if (!authentication || !schema || schema !== authentication.credential.jsonSchemaCredentialId) return undefined
        const subject = authentication.subjectKey.map((attribute) => claims[attribute])
        if (subject.some((value) => !value)) return undefined
        const key = await home.key()
        return key ? actorIdentityOf(key, schema, subject as string[]) : undefined
      },
      issued: async (principal, record, holder) => {
        await people.onIssued(principal, record, holder)
        // issuing identifies nobody (IDENT-RES-017): a guest who just received the badge that authenticates is asked to
        // present it, and holds its entry once it has (IDENT-DIR-006)
        const authentication = pack.identity.authentication?.[0]?.credential.jsonSchemaCredentialId
        const profile = pack.issuance?.[record.entry.replace(/^issuance:/, '')]
        if (
          !principal.identityCredentialRef &&
          record.directoryEntryId &&
          authentication &&
          profile?.credential.jsonSchemaCredentialId === authentication
        )
          void identityRequestsRef
            ?.request(principal, 'person')
            .then((outcome) =>
              logger.info({ principalId: principal.id, outcome }, 'asked to present the badge just issued')
            )
            .catch((err) => logger.warn({ err, principalId: principal.id }, 'the badge just issued was not asked for'))
      },
      // a field of the person's entry of the user directory, found from their evidence (INTX-ISSUE-021)
      ...(directoryClaims
        ? { record: (principal, name, profile, source) => directoryClaims.resolve(principal, name, profile, source) }
        : {}),
      emailCheck: emailChecks,
      challenge: async (principal, session, policy, purpose) => {
        const { outcome, record } = await challenges.run({
          principal,
          originSession: session,
          toolName: 'issue_credential',
          policy,
          purpose,
        })
        if (outcome === 'completed' || outcome === 'degraded') return { passed: true }
        // a document read says why it did not pass, in words and with nothing of the document (INTX-AUTH-010)
        const why = typeof record?.details?.reason === 'string' ? record.details.reason : outcome
        return { passed: false, reason: policy.type === 'document' ? documentOutcomeForModel(why) : undefined }
      },
    },
    logger,
    subjectIdKey(env.entryEncryptionKey)
  )
  agent.issuance = issuanceRef
  // the definitions of the profiles that name a schema: found or created now, and again at the first issuance
  // when the DIDComm agent was out of reach; the agent serves meanwhile (INTX-ISSUE-017)
  void issuanceRef.prepare().catch((err) => logger.warn({ err }, 'issuance profiles not prepared'))
  const didcommEvents = new DidcommEvents(
    agent,
    vsAgent,
    identity,
    didcomm,
    peerProfiles,
    env.vsAgentEventsApiKey,
    logger
  )
  didcommEvents.register(app)
  agent.rebindOffer = (session, principal) => didcommEvents.offerRebind(session, principal)
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
    spaces,
    env.retentionMediaGraceDays,
    logger,
    evidence
  )
  const onJobError = (name: string, error: unknown) => logger.error({ err: error, job: name }, 'job failed')
  const stops = [
    schedule('reap-sessions', 30_000, async () => void (await sessions.reap()), onJobError),
    schedule('expire-approvals', 60_000, async () => void (await approvals.expirePending()), onJobError),
    // a change of a space's tools whose phone never answered is dropped as expired (TOOL-SPACE-008)
    schedule('expire-tool-changes', 30_000, async () => void (await spaceTools.expirePending()), onJobError),
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
  if (directory) {
    // what the file changed since the agent last loaded it, removals while it was down included, is recorded and acted
    // on now; then every change of the file while it runs (IDENT-ROLE-013)
    await people.apply(await directory.settle())
    directory.onReload(async (reload) => void (await people.apply(reload)))
    directory.watch((env.directoryPollSeconds ?? 10) * 1000)
    stops.push(() => directory.stop())
    // a revocation the DIDComm agent could not make is made again (D91)
    stops.push(schedule('directory-revocations', 60_000, () => people.retry(), onJobError))
  } else await people.reconcile()

  return {
    app,
    admin,
    agent,
    retention,
    streams,
    stop: async () => {
      // no turn starts any more; those in progress end, or are cut when their time is over (PLAT-DEPLOY-004)
      await agent.shutdown(hooks.drainMs)
      emailChecks.stop()
      mailer?.close?.()
      // the turns are over: their runs are given a moment to tell their clients so, before anything is closed
      await aguiRoutes?.quiet(RUNS_END_WITHIN_MS)
      for (const stop of stops) stop()
      // the streams of the devices stay open for as long as they are served: they are closed, not waited for
      app.server.closeAllConnections()
      await app.close()
      await admin?.close()
      await registry.close()
      await redis?.quit().catch(() => undefined)
      // the last thing but one: from here the next process may take the store
      await releaseStore()
      await store.close()
    },
  }
}

/**
 * What the email and the invitations of other organizations need, said at start (PLAT-MAIL-001, SPACE-INV-004): the
 * issuance profiles and the templates an absent SMTP server disables, an authentication that does not keep the email
 * invitations bind with, a trust graph to find organizations in.
 */
export function mailWarnings(pack: AgentPack, smtp: boolean, graph: boolean): string[] {
  const warnings: string[] = []
  const profiles = Object.entries(pack.issuance ?? {})
    .filter(([, p]) => challengeTypesOf(p).includes('email'))
    .map(([name]) => name)
  const lists = (pack.spaces?.templates ?? []).filter((t) => t.membership.mode === 'list').map((t) => t.id)
  if (!smtp && (profiles.length || lists.length))
    warnings.push(
      `email: MAIL_HOST and MAIL_FROM_ADDRESS are not both set: the email code is disabled for the issuance profiles [${profiles.join(', ')}] and the invitations of other organizations for the templates [${lists.join(', ')}] (PLAT-MAIL-001)`
    )
  if (lists.length) {
    const authentication = pack.identity.authentication?.[0]
    const asks = !!authentication && (!authentication.attributes || authentication.attributes.includes('email'))
    const stores = !!authentication?.store?.attributes.includes('email')
    if (!asks || !stores)
      warnings.push(
        `invitations: the templates [${lists.join(', ')}] keep lists, and identity.authentication does not both ask for and store email: a person already authenticated is asked again for their badge before an invitation binds (SPACE-INV-004)`
      )
    if (!graph)
      warnings.push(
        `invitations: VERANA_GRAPH_URL is not set: no organization is found in the trust graph, so nobody of another organization can be invited to the templates [${lists.join(', ')}] (SPACE-INV-001)`
      )
  }
  return warnings
}

export async function start(): Promise<RunningAgent> {
  const env = loadEnv()
  const logger = createLogger(env.logLevel)
  const running = await buildAgent(env, logger)
  await running.app.listen({ port: env.port, host: '0.0.0.0' })
  logger.info({ port: env.port, publicBaseUrl: env.publicBaseUrl }, 'ayni-agent listening')
  // the admin interface listens on the loopback only: an operator reaches it with a port-forward (D78)
  if (running.admin && env.adminPort) {
    await running.admin.listen({ port: env.adminPort, host: '127.0.0.1' })
    logger.info({ port: env.adminPort }, 'admin interface listening on the loopback')
  }
  return running
}

/**
 * The AG-UI descriptor is a service of the agent's DID Document (IDENT-SELF-005): wallets, the
 * directory and the UI discover the agent through it. Declared through the VS Agent, idempotently.
 */
async function declareAgUiService(
  vsAgent: VsAgentClient,
  did: string,
  publicBaseUrl: string,
  logger: Logger
): Promise<void> {
  const serviceEndpoint = `${publicBaseUrl.replace(/\/+$/, '')}${DESCRIPTOR_PATH}`
  try {
    const { items } = await vsAgent.listServiceEndpoints()
    let existing = items.find((s) => s.type === DID_SERVICE_TYPE)
    // an entry declared under the former product name is retyped rather than duplicated
    const legacy = items.find((s) => s.type === 'HologramAgUI')
    if (!existing && legacy) {
      existing = await vsAgent.updateServiceEndpoint(legacy.id, { type: DID_SERVICE_TYPE, serviceEndpoint })
      logger.info({ did, serviceEndpoint }, 'AG-UI descriptor service renamed in the DID Document')
    }
    if (!existing) {
      await vsAgent.addServiceEndpoint({ type: DID_SERVICE_TYPE, serviceEndpoint, id: '#ayni-agui' })
      logger.info({ did, serviceEndpoint }, 'AG-UI descriptor declared in the DID Document (IDENT-SELF-005)')
    } else if (existing.serviceEndpoint !== serviceEndpoint) {
      await vsAgent.updateServiceEndpoint(existing.id, { serviceEndpoint })
      logger.info({ did, serviceEndpoint }, 'AG-UI descriptor service updated in the DID Document')
    }
  } catch (error) {
    logger.warn({ err: error }, 'could not declare the AG-UI descriptor in the DID Document')
  }
}
