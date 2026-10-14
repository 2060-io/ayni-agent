/**
 * The platform-authored system-prompt add-on (CORE-PROMPT-001..004, architecture 14.1): separate from
 * the persona prompt, feature-gated, versioned, token-conscious.
 */
import type { Features } from '../config/packTypes.js'
import { estimateTokens } from '../util/tokens.js'

export const PROMPT_ADDON_VERSION = '3.0.0'
export const PROMPT_ADDON_TOKEN_BUDGET = 500

export interface AddonContext {
  features: Features
  agentLanguage: string
  hasTools: boolean
  hasRequestableTools: boolean
  challengesConfigured: boolean
}

export function renderPromptAddon(ctx: AddonContext): string {
  const lines: string[] = [
    `[Platform rules v${PROMPT_ADDON_VERSION}]`,
    `Answer in the agent language (${ctx.agentLanguage}) unless the person clearly writes in another language.`,
    'Your memory of past conversations is scope-limited: a fact you cannot find may be out of scope for this person rather than absent. Never claim certainty about what you do not see.',
  ]
  if (ctx.features.workingMemory) {
    lines.push(
      'Working memory: durable notes about this person that you curate with the working_memory tool. Add a note when you learn a stable fact or preference worth keeping, update or remove notes that became wrong. The person cannot read these notes; never quote them as a list.'
    )
  }
  if (ctx.features.preferences) {
    lines.push(
      'Preferences (language, formatting, style) are stored with principal_preferences and loaded every turn; set them when the person states one.'
    )
  }
  if (ctx.features.credentialTool)
    lines.push(
      'principal_credentials lists the verified credentials the person presented; treat them as verified facts.'
    )
  if (ctx.features.semanticRecall)
    lines.push('Relevant earlier messages and notes may be supplied as context; cite them in your own words.')
  if (ctx.features.rag)
    lines.push('knowledge_search retrieves passages from the configured documents; prefer them to guessing.')
  if (ctx.hasTools) {
    lines.push(
      'Tools: only the tools listed are available to this person. Some tools require a human approval or an identity check that the system performs before the tool runs; you are only told the outcome. Never promise an action before its tool succeeded.'
    )
  }
  if (ctx.hasRequestableTools && ctx.features.elevation) {
    lines.push(
      'If a task needs an access the person does not have, say so and tell them they may request an elevation with a purpose and a justification of their own; never choose the purpose or write the justification for them.'
    )
  }
  if (ctx.challengesConfigured)
    lines.push(
      "Identity checks (device confirmation, face check, document read) are triggered by the system on the person's phone; never ask the person to perform one yourself."
    )
  if (ctx.features.reactions)
    lines.push(
      'You may set how to treat reactions to a reply with set_reaction_policy (notify, historize, or notify on given emojis). Default: historize.'
    )
  if (ctx.features.imageGeneration)
    lines.push(
      'generate_image creates an image in the background; tell the person it is on its way, the image arrives as a separate message.'
    )
  return lines.join('\n')
}

export function addonTokenCount(text: string): number {
  return estimateTokens(text)
}
