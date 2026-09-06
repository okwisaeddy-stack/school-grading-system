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
            // Profile/role lookups must always be live — never served from
            // cache, even briefly. A stale cached response here can put
            // someone in the wrong part of the app (e.g. showing a Bursar
            // their old role) until the next successful network fetch
            // overwrites it, which is a correctness problem, not just a
            // freshness one. NetworkOnly = always hit the network; if it's
            // offline, the request just fails (the app already shows a
            // loading/blank state in that case) rather than silently
            // returning outdated identity data.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/profiles'),
            handler: 'NetworkOnly',
          },
          {
            // Everything else under /rest/v1/ (marks, students, exams,
            // rpc calls like compute_cohort_rankings, etc.) is fine to
            // briefly serve from cache when offline or on a slow network —
            // NetworkFirst = use live data when online, fall back to the
            // last-seen response only if the network doesn't respond within
            // networkTimeoutSeconds. Only GET requests are intercepted by
            // default, so marks/report saves (POST/PATCH) are never
            // silently "faked" while offline.
            urlPattern: ({ url }) =>
              url.hostname.endsWith('.supabase.co') && url.pathname.startsWith('/rest/v1/') &&
              !url.pathname.startsWith('/rest/v1/profiles'),
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