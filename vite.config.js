import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { VitePWA } from 'vite-plugin-pwa'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Force new service worker to activate immediately — no waiting for tabs to close
      injectRegister: 'auto',
      manifest: {
        name: 'Vroomie Predictive Diagnostics',
        short_name: 'Vroomie',
        description: 'Advanced Audio Anomaly Detection & ML Monitoring',
        theme_color: '#121212',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'portrait',
        icons: [
          {
            src: 'favicon.jpg',
            sizes: '192x192',
            type: 'image/jpeg'
          },
          {
            src: 'favicon.jpg',
            sizes: '512x512',
            type: 'image/jpeg'
          }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Skip waiting forces the new SW to take control immediately on next load
        skipWaiting: true,
        clientsClaim: true,
        // Purge old caches from previous builds automatically
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,woff2,wasm}'],
        runtimeCaching: [
          {
            // Cache TFJS models explicitly for offline AI prediction
            urlPattern: /^https:\/\/tfhub\.dev\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tfjs-models-cache',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 60 * 60 * 24 * 365 // 1 year
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          },
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/tfjs-models\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tfjs-models-storage-cache',
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60 * 60 * 24 * 365
              },
              cacheableResponse: {
                statuses: [0, 200]
              }
            }
          }
        ]
      }
    })
  ],
  base: '/',
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src')
    }
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true
  },
  build: {
    outDir: 'dist'
  }
})
