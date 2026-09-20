import { defineConfig } from 'rolldown'
import { dts } from 'rolldown-plugin-dts'

export default defineConfig({
  input: {
    cli: './src/cli.ts',
    index: './src/index.ts',
    'test-events': './src/test-events.ts',
    util: './src/util.ts',
    'edit/index': './src/edit/index.ts'
  },
  external: /^node:/,
  plugins: [dts()],
  output: { cleanDir: true, dir: './dist/', format: 'esm' }
})
