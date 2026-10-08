import { fileURLToPath } from 'node:url'
import { mergeConfig, defineConfig, configDefaults } from 'vitest/config'
import viteConfig from './vite.config'

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      // P9-6b: unmount what each test mounted, so a component's own cleanup
      // runs and its timers do not fire into the next test. See the file.
      setupFiles: ['src/testing/vitestSetup.ts'],
      // server/ has its own vitest config (node environment) — run via
      // `npm test` inside server/. Keeping it out of the jsdom run.
      exclude: [...configDefaults.exclude, 'e2e/**', 'server/**'],
      root: fileURLToPath(new URL('./', import.meta.url))
    }
  })
)
