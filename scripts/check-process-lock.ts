/**
 * The lock of the agent process on its store (PLAT-DEPLOY-004), against a real PostgreSQL: takes it and holds it
 * until the process is killed. Run it twice to see the second wait for the first, and the server give the lock
 * when the first is killed; restart the database to see the holder told that it lost it.
 *
 *   DATABASE_URL=postgres://… pnpm exec tsx scripts/check-process-lock.ts <name>
 */
import pg from 'pg'
import { holdProcessLock } from '../src/store/processLock.js'

const name = process.argv[2] ?? 'process'
const say = (what: string) => process.stdout.write(`${new Date().toISOString().slice(11, 23)} ${name}: ${what}\n`)
const connection = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
})

holdProcessLock(connection, {
  onWaiting: () => say('waiting: another process holds the lock'),
  onLost: (error) => {
    say(`lost${error ? `: ${error.message}` : ''}`)
    process.exit(1)
  },
  checkEveryMs: 2000,
  checkWithinMs: 1000,
})
  .then((release) => {
    say('held')
    process.on('SIGTERM', () => {
      void release().then(() => {
        say('given back')
        process.exit(0)
      })
    })
    setInterval(() => undefined, 60_000)
  })
  .catch((error: Error) => {
    say(`failed: ${error.message}`)
    process.exit(1)
  })
