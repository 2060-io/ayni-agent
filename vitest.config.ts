import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    passWithNoTests: true,
    clearMocks: true,
    coverage: { provider: 'v8', reportsDirectory: './coverage', exclude: ['dist', 'node_modules', 'tests'] },
    include: ['tests/**/?(*.)+(spec|test).[tj]s?(x)', 'packages/*/tests/**/?(*.)+(spec|test).[tj]s?(x)'],
    root: './',
  },
})
