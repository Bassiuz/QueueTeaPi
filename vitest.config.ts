import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        // Two presentation layers are exempt, and nothing else:
        //   - the dashboard's inline HTML/CSS/JS template
        //   - the CLI entrypoint, which is argument plumbing over stdout,
        //     process signals and a live Firestore connection
        // The logic behind both lives in `QueueInspector` and `parseArgs`,
        // which are covered to 100%. `index.ts` only re-exports.
        'src/devtools/dashboard-page.ts',
        'src/cli/cli.ts',
        'src/index.ts',
      ],
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
})
