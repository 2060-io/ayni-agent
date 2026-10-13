/** Declarative HTTP tools (TOOL-HTTP-001). Credentials come from the pack (deployment-held, TOOL-ACCESS-001). */
import type { HttpToolDef, ToolAccess } from '../config/packTypes.js'
import type { ToolSource, ToolSpec } from './types.js'

export function fillTemplate(template: string, args: Record<string, unknown>, encode: (v: string) => string): string {
  return template.replace(/\{([A-Za-z0-9_.-]+)\}/g, (_m, key: string) => {
    const value = args[key]
    return value === undefined || value === null
      ? ''
      : encode(typeof value === 'object' ? JSON.stringify(value) : String(value))
  })
}

export function httpToolSpec(def: HttpToolDef, access: ToolAccess | undefined): ToolSpec {
  return {
    key: `http:${def.name}`,
    name: def.name,
    description: def.description,
    parameters: def.parameters ?? { type: 'object', properties: {} },
    access,
    stepLabel: def.description.split(/[.:\n]/)[0].slice(0, 60),
    async invoke(args, ctx) {
      const url = fillTemplate(def.url, args, encodeURIComponent)
      const hasBody = def.method !== 'GET' && def.method !== 'DELETE'
      const body = hasBody
        ? def.bodyTemplate
          ? fillTemplate(def.bodyTemplate, args, (v) => v)
          : JSON.stringify(args)
        : undefined
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
  public constructor(
    private readonly defs: HttpToolDef[],
    private readonly access: ToolAccess | undefined
  ) {}
  public async list(): Promise<ToolSpec[]> {
    return this.defs.map((d) => httpToolSpec(d, this.access))
  }
}
