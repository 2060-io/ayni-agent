import { loadPack, PackError } from '../config/pack.js'

const [, , path, ...assignments] = process.argv
if (!path) {
  process.stderr.write('usage: validate-pack <pack dir> [VAR=value ...]\n')
  process.exit(2)
}
const env: Record<string, string | undefined> = { ...process.env }
for (const a of assignments) {
  const [k, ...rest] = a.split('=')
  env[k] = rest.join('=')
}
try {
  const { pack, file } = loadPack(path, env)
  process.stdout.write(`${file}: valid (agent ${pack.metadata.id}, schema ${pack.schemaVersion})\n`)
} catch (error) {
  process.stderr.write(`${error instanceof PackError ? error.message : String(error)}\n`)
  process.exit(1)
}
