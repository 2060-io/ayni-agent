#!/usr/bin/env node
/**
 * Runs the tests of the reference relational store (tests/postgres.test.ts) against a throwaway PostgreSQL with
 * pgvector in Docker, then removes it. `pnpm test:postgres`; PG_TEST_URL, when set, names a server to use instead.
 */
import { execFileSync, spawnSync } from 'node:child_process'

const name = `ayni-agent-pg-test-${process.pid}`
const port = process.env.PG_TEST_PORT ?? '55439'
let url = process.env.PG_TEST_URL
let started = false
try {
  if (!url) {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-e',
        'POSTGRES_PASSWORD=postgres',
        '-p',
        `${port}:5432`,
        'pgvector/pgvector:pg16',
      ],
      {
        stdio: 'ignore',
      }
    )
    started = true
    for (let i = 0; i < 60; i++) {
      const ready = spawnSync('docker', ['exec', name, 'pg_isready', '-U', 'postgres'], { stdio: 'ignore' })
      if (ready.status === 0) break
      execFileSync('sleep', ['1'])
    }
    url = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`
  }
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tests/postgres.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, PG_TEST_URL: url },
  })
  process.exitCode = run.status ?? 1
} finally {
  if (started) spawnSync('docker', ['stop', name], { stdio: 'ignore' })
}
