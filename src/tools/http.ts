/**
 * Declarative HTTP tools (TOOL-HTTP-001): the sources of `type: http` of `tools.sources`, each one tool named by its
 * source's id (D101, TOOL-CAT-001). The credentials of an `agent` account come from the source's headers, placeholders of
 * the deployment's environment (TOOL-ACCESS-002); a `space` account is the token the owner of a space set, sent in the
 * header `account.apply` names, after its prefix (TOOL-ACCESS-005).
 */
import type { HttpSource } from '../config/packTypes.js'
import type { ToolSource, ToolSpec } from './types.js'

export function fillTemplate(template: string, args: Record<string, unknown>, encode: (v: string) => string): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, key: string) => {
    const value = args[key]
    return value === undefined || value === null
      ? ''
      : encode(typeof value === 'object' ? JSON.stringify(value) : String(value))
  })
}

export function httpToolSpec(id: string, def: HttpSource): ToolSpec {
  return {
    key: `http:${id}`,
    name: id,
    source: id,
    rawName: id,
    description: def.description,
    parameters: def.parameters ?? { type: 'object', properties: {} },
    // the tier model of its source (D101)
    access: def.access,
    // a step label names no tool (PROF-TOOL-013): the source's title, when the pack gives one
    stepLabel: def.title ? `Using ${def.title}` : 'Working',
    async invoke(args, ctx) {
      const url = fillTemplate(def.url, args, encodeURIComponent)
      const hasBody = def.method !== 'GET' && def.method !== 'DELETE'
      const body = hasBody
        ? def.bodyTemplate
          ? fillTemplate(def.bodyTemplate, args, (v) => v)
          : JSON.stringify(args)
        : undefined
      const account = ctx.account
      if (def.account?.kind === 'space' && !account?.token)
        return { content: 'The account of this space is not set.', isError: true }
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), (def.timeoutSeconds ?? 30) * 1000)
      const onAbort = () => controller.abort()
      ctx.signal?.addEventListener('abort', onAbort)
      try {
        const response = await fetch(url, {
          method: def.method,
          headers: {
            accept: 'application/json',
            ...(hasBody ? { 'content-type': 'application/json' } : {}),
            ...(def.headers ?? {}),
            // the space's account, as `account.apply` says, and nowhere else (TOOL-ACCESS-005)
            ...(account?.token && account.header
              ? { [account.header]: `${account.prefix ?? ''}${account.token}` }
              : {}),
          },
          body,
          signal: controller.signal,
        })
        const text = await response.text()
        return { content: text.slice(0, 20000), isError: !response.ok, data: { status: response.status } }
      } catch (error) {
        return { content: `request failed: ${error instanceof Error ? error.message : String(error)}`, isError: true }
      } finally {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
      }
    },
  }
}

export class HttpToolSource implements ToolSource {
  public readonly id = 'http'
  /** the HTTP tools, each with its source's id */
  public constructor(private readonly defs: [string, HttpSource][]) {}
  public async list(): Promise<ToolSpec[]> {
    return this.defs.map(([id, def]) => httpToolSpec(id, def))
  }
}
