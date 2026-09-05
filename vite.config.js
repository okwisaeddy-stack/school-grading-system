import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Lets the service worker run under `vite dev` too, not just a built
      // preview — makes it much faster to test offline behavior locally.
      devOptions: { enabled: true, type: 'module' },
      manifest: {
        name: 'Paul Wanjigi Alpine — Records',
        short_name: 'PWA Records',
        description: 'Grading and report card system for Paul Wanjigi Alpine High School',
        theme_color: '#2C3E37',
        background_color: '#F7F5EF',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // App-shell fallback so a hard refresh while offline still renders
        // the app instead of a browser "no internet" page.
        navigateFallback: '/index.html',
        runtimeCaching: [
          {
            // Supabase table reads AND rpc calls (compute_cohort_rankings
            // etc.) both live under /rest/v1/, so one rule covers both.
            // NetworkFirst = use live data when online, fall back to the
            // last-seen response when offline. Only GET requests are
            // intercepted by default, so marks/report saves (POST/PATCH)
            // are never silently "faked" while offline.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'supabase-data-cache',
              networkTimeoutSeconds: 5,
              cacheableResponse: { statuses: [0, 200] },
              expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 7 },
            },
          },
        ],
      },
    }),
  ],
})