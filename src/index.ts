import { start } from './app.js'

/** the turns in progress get 20 seconds of it (`AyniAgent.shutdown`) */
const STOP_WITHIN_MS = 27_000

start()
  .then((running) => {
    let stopping = false
    const shutdown = () => {
      if (stopping) return
      stopping = true
      // whatever keeps the process from ending, it ends: the lock on the store goes with it, and the next process
      // starts (PLAT-DEPLOY-004). Under the 30 seconds an orchestrator gives before it kills.
      setTimeout(() => process.exit(0), STOP_WITHIN_MS).unref()
      running.stop().finally(() => process.exit(0))
    }
    process.on('SIGINT', shutdown)
    process.on('SIGTERM', shutdown)
  })
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    process.exit(1)
  })
