import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.hambros.app',
  appName: 'HamBros',
  webDir: 'dist',
  // Bundled mode: app loads from built assets. API/WebSocket use getApiBase/getWsBase
  // to target VITE_APP_URL when Capacitor.isNativePlatform().
  ios: {
    contentInset: 'automatic',
  },
}

export default config
