import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    // Declarations come from `tsc -p tsconfig.build.json` instead, so the
    // types are emitted by the same compiler that typechecks the source.
    dts: false,
    clean: true,
    sourcemap: true,
    target: 'node18',
  },
  {
    entry: { cli: 'src/cli/cli.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    sourcemap: false,
    target: 'node18',
    banner: { js: '#!/usr/bin/env node' },
  },
])
