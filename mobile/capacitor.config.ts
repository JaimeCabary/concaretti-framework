import type { CapacitorConfig } from '@capacitor/cli'

/**
 * The mobile shell points at the same `frontend/dist` the web build produces —
 * there is no mobile-specific bundle to keep in sync.
 *
 * `androidScheme: 'https'` makes the webview origin `https://localhost`, which
 * is in the backend's CORS allow-list. Leaving it as `http` would silently break
 * credentialed requests, and the role cookie is what carries authorisation.
 */
const config: CapacitorConfig = {
  appId: 'app.concaretti.light',
  appName: 'Concaretti',
  webDir: '../frontend/dist',
  android: {
    // Cleartext is needed only because the dev backend is plain HTTP on the LAN.
    // A real deployment would terminate TLS and this should go back to false.
    allowMixedContent: true,
    // Matches --color-void and the manifest, so the webview does not paint one
    // frame of white (or black) before the app's own field takes over.
    backgroundColor: '#fffbf0ff',
  },
  server: {
    androidScheme: 'https',
  },
}

export default config
