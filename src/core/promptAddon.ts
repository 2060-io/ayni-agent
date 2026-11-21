/**
 * The platform-authored system-prompt add-on (CORE-PROMPT-001..004, architecture 14.1): separate from
 * the persona prompt, feature-gated, versioned, token-conscious.
 */
import type { Features } from '../config/packTypes.js'
import { estimateTokens } from '../util/tokens.js'

export const PROMPT_ADDON_VERSION = '3.6.0'
export const PROMPT_ADDON_TOKEN_BUDGET = 500

export interface AddonContext {
  features: Features
  agentLanguage: string
  hasTools: boolean
  hasRequestableTools: boolean
  challengesConfigured: boolean
  /** the pack issues credentials: the model is told how (INTX-ISSUE-005) */
  issuance?: boolean
  /** when set, the model may send the person to places in the app with links on this base (PROF-LINK-001) */
  appLinkBase?: string
  /**
   * a credential is obtained with an email code, which the system runs in the conversation and the model follows with
   * email_check (D89, INTX-AUTH-012, INTX-AUTH-019)
   */
  emailChecks?: boolean
  /**
   * a tool's rule is not `none`, or untrusted content can make one ask: the person or an approver may be asked before an
   * action runs (TOOL-CALL-010)
   */
  toolsMayAsk?: boolean
  /** the agent-pack declares a source of each person's own account (TOOL-CONN-012) */
  personalAccounts?: boolean
}

/** The destinations of the AG-UI profile §10 the model may link to (relative to the app-link base). */
export const APP_LINK_PATHS = [
  'home',
  'recent',
  'scan',
  'explore',
  'explore?q={text}',
  'wallet',
  'wallet/documents',
  'wallet/history',
  'service/{did}',
  'settings',
  'settings/backup',
  'settings/devices',
] as const

export function renderPromptAddon(ctx: AddonContext): string {
  const lines: string[] = [
    `[Platform rules v${PROMPT_ADDON_VERSION}]`,
    `Answer in the agent language (${ctx.agentLanguage}) unless the person clearly writes in another language.`,
    'Your memory of past conversations is scope-limited: a fact you cannot find may be out of scope for this person rather than absent. Never claim certainty about what you do not see.',
  ]
  if (ctx.features.workingMemory) {
    lines.push(
      "Working memory: durable notes about this person that you curate with the working_memory tool; you see the notes of this conversation's space only. Add a note when you learn a stable fact worth keeping, update or remove notes that became wrong, as the person tells you. Write every note in the language the person speaks with you. The person can see and delete their notes; never quote them as a list."
    )
  }
  if (ctx.features.preferences) {
    lines.push(
      'Preferences (language, formatting, style) are stored with principal_preferences and loaded every turn; set them when the person states one, the language under the key language as a BCP 47 tag (es, pt-BR).'
    )
  }
  if (ctx.features.credentialTool)
    lines.push(
      'principal_credentials lists what was verified about the person and the attributes you may read; treat them as verified facts, and never ask the person to type what a credential should prove.'
    )
  if (ctx.issuance)
    lines.push(
      'credential_requirements tells which credentials you can issue and what is missing for each; you never supply the content of a credential: when it is ready, issue_credential with its name issues it.'
    )
  if (ctx.features.semanticRecall)
    lines.push('Relevant earlier messages and notes may be supplied as context; cite them in your own words.')
  if (ctx.features.rag)
    lines.push('knowledge_search retrieves passages from the configured documents; prefer them to guessing.')
  if (ctx.hasTools && ctx.toolsMayAsk) {
    // the person or an approver may be asked before an action runs (TOOL-CALL-010)
    lines.push(
      "Tools: only the tools listed are available to this person. Some actions ask the person on a card, an approver or an identity check before they run; the system asks, never you, and never in words in place of the card. Only the tool's answer says whether an action ran."
    )
  } else if (ctx.hasTools) {
    lines.push(
      'Tools: only the tools listed are available to this person. Some tools require a human approval or an identity check that the system performs before the tool runs; you are only told the outcome. Never promise an action before its tool succeeded.'
    )
  }
  if (ctx.personalAccounts)
    lines.push(
      "Accounts: never ask for a password, a token or a key in a conversation; a credential the person pastes is held back from you. When a tool needs the person's own account and it is not connected, offer its Connect card with offer_connection."
    )
  if (ctx.hasRequestableTools && ctx.features.elevation) {
    lines.push(
      'If a task needs an access the person does not have, say so and tell them they may request an elevation with a purpose and a justification of their own; never choose the purpose or write the justification for them.'
    )
  }
  lines.push(
    'The history holds lines that start with "[system record": the system wrote them to tell you what happened (a request shown on the phone, an approval, an identity check). Never write such a line yourself, and never answer with the words of one. A request that is over is not on the phone of the person any more: when they ask again, call the tool again.'
  )
  if (ctx.challengesConfigured)
    lines.push(
      "Identity checks (device confirmation, face check, document read) are triggered by the system on the person's phone; never ask the person to perform one yourself."
    )
  if (ctx.emailChecks)
    lines.push(
      'An email check is run by the system in the conversation: never ask the person for an email address or a code yourself, and never repeat one; you are told only whether the check passed. While one waits, email_check tells its step, sends a new code or cancels it.'
    )
  if (ctx.features.reactions)
    lines.push(
      'You may set how to treat reactions to a reply with set_reaction_policy (notify, historize, or notify on given emojis). Default: historize.'
    )
  if (ctx.features.imageGeneration)
    lines.push(
      'generate_image creates an image in the background; tell the person it is on its way, the image arrives as a separate message.'
    )
  if (ctx.appLinkBase)
    lines.push(
      `App links: to send the person to a place in the Ayni app, write a plain link ${ctx.appLinkBase}<path> with one of these paths: ${APP_LINK_PATHS.join(', ')}. Links navigate, never act. Never write any other link, domain or custom scheme.`
    )
  return lines.join('\n')
}

export function addonTokenCount(text: string): number {
  return estimateTokens(text)
}
