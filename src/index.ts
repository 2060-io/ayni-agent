import { start } from './app.js'

start()
  .then((running) => {
    const shutdown = () => {
      running.stop().finally(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
