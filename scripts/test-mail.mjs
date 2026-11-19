#!/usr/bin/env node
/**
 * Runs the email tests against a real SMTP server (tests/mail.test.ts, the part that MAILPIT_SMTP_URL enables): a
 * throwaway Mailpit in Docker, whose API the tests read the messages from, then removes it. `pnpm test:mail`;
 * MAILPIT_SMTP_URL and MAILPIT_API_URL, when set, name a server to use instead.
 */
import { execFileSync, spawnSync } from 'node:child_process'

const name = `ayni-agent-mail-test-${process.pid}`
const smtpPort = process.env.MAILPIT_SMTP_PORT ?? '51025'
const apiPort = process.env.MAILPIT_API_PORT ?? '58025'
let smtp = process.env.MAILPIT_SMTP_URL
let api = process.env.MAILPIT_API_URL
let started = false
try {
  if (!smtp || !api) {
    execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        name,
        '-p',
        `${smtpPort}:1025`,
        '-p',
        `${apiPort}:8025`,
        'axllent/mailpit:v1.32.0',
      ],
      { stdio: 'ignore' }
    )
    started = true
    smtp = `smtp://127.0.0.1:${smtpPort}`
    api = `http://127.0.0.1:${apiPort}`
    for (let i = 0; i < 60; i++) {
      const ready = spawnSync('curl', ['-sf', `${api}/api/v1/info`], { stdio: 'ignore' })
      if (ready.status === 0) break
      execFileSync('sleep', ['1'])
    }
  }
  const run = spawnSync('pnpm', ['exec', 'vitest', 'run', 'tests/mail.test.ts'], {
    stdio: 'inherit',
    env: { ...process.env, MAILPIT_SMTP_URL: smtp, MAILPIT_API_URL: api },
  })
  process.exitCode = run.status ?? 1
} finally {
  if (started) spawnSync('docker', ['stop', name], { stdio: 'ignore' })
}
