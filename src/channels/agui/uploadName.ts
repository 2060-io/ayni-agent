/**
 * The name of an uploaded file (PROF-HIST-008). A multipart part names its file in a header that platforms do
 * not write alike: a browser writes the name as it is, React Native writes it percent-encoded, and nothing tells
 * an encoded name from one that holds a percent sign. A client may therefore give the name in a text field
 * `filename` before the part `file`: when it is there and not empty it is the name, otherwise the part's is.
 * The route names the file once its bytes are read, so a field that comes after the file is taken as well.
 */

/** What `@fastify/multipart` gives of the part `file`: its declared name, and the fields read before it. */
export interface UploadedPart {
  filename?: string
  fields?: Record<string, unknown>
}

const MAX_LENGTH = 255

/** A name as a person wrote it, with nothing of a path and no control character; undefined when nothing is left. */
export function cleanFileName(name: string | undefined): string | undefined {
  if (!name) return undefined
  const last = name.split(/[/\\]/).pop() ?? ''
  const clean = [...last]
    .filter((c) => c >= ' ' && c !== '\u007f')
    .join('')
    .trim()
    .slice(0, MAX_LENGTH)
  return clean || undefined
}

/** The text of a multipart field, when it is one. */
function fieldText(field: unknown): string | undefined {
  const one = Array.isArray(field) ? field[0] : field
  if (!one || typeof one !== 'object') return undefined
  const { type, value } = one as { type?: unknown; value?: unknown }
  return type === 'field' && typeof value === 'string' ? value : undefined
}

/** The name an upload is kept under: the `filename` field when the client sent one, else the part's own. */
export function uploadName(part: UploadedPart): string | undefined {
  return cleanFileName(fieldText(part.fields?.filename)) ?? part.filename
}
