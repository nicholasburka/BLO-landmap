import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueJsx from '@vitejs/plugin-vue-jsx'
import vueDevTools from 'vite-plugin-vue-devtools'
import path from 'path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [vue(), vueJsx(), vueDevTools()],
  base: '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@datasets': path.resolve(__dirname, './public/datasets')
    }
  },
  server: {
    fs: {
      allow: ['..']
    }
  },
  optimizeDeps: {
    include: ['mapbox-gl']
  },
  build: {
    rollupOptions: {
      output: {
        // Split the heavyweight third-party libs out of the app chunk so
        // app-code changes don't invalidate the (large, stable) vendor cache.
        manualChunks: {
          'mapbox-gl': ['mapbox-gl']
        }
      }
    }
  }
})
