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
          { src: 'favicon.jpg', sizes: '192x192', type: 'image/jpeg' },
          { src: 'favicon.jpg', sizes: '512x512', type: 'image/jpeg' }
        ]
      },
      workbox: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        // Exclude the worklet from SW precache (it must be loaded by AudioContext directly)
        globPatterns: ['**/*.{js,css,html,ico,png,svg,jpg,jpeg,woff2,wasm}'],
        globIgnores: ['**/audio-processor.worklet.js'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/tfhub\.dev\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tfjs-models-cache',
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/storage\.googleapis\.com\/tfjs-models\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'tfjs-models-storage-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: /^https:\/\/.*\.supabase\.co\/storage\/v1\/object\/(public|authenticated)\/anomaly-patterns\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'supabase-patterns-cache',
              expiration: { maxEntries: 100, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  base: '/',
  resolve: {
    alias: { '@': resolve(__dirname, 'src') }
  },
  define: {
    // Ensures __DEV__ guard in audioMatchingEngine is tree-shaken in production
    __DEV__: JSON.stringify(process.env.NODE_ENV !== 'production'),
  },
  server: {
    host: true,
    port: 5173,
    strictPort: true,
    headers: {
      // Required for SharedArrayBuffer / Atomics (AudioWorklet cross-origin isolation)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    }
  },
  worker: {
    // Emit workers as ES modules so they can use import syntax
    format: 'es',
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // TF.js into its own chunk (~3MB) — loaded lazily only when ML mode activated
          if (id.includes('@tensorflow')) return 'tfjs';
          // Supabase SDK
          if (id.includes('@supabase')) return 'supabase';
          // All Radix UI primitives together
          if (id.includes('@radix-ui')) return 'radix';
          // Framer Motion
          if (id.includes('framer-motion')) return 'framer-motion';
          // Recharts (charting)
          if (id.includes('recharts') || id.includes('d3-')) return 'charts';
          // PDF generation
          if (id.includes('jspdf')) return 'pdf';
        }
      }
    }
  }
})
