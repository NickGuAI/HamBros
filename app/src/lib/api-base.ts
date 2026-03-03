/**
 * API base URL for fetch and WebSocket. When running in Capacitor (bundled),
 * the app loads from capacitor://localhost so relative URLs fail. We must
 * use the production server URL.
 */
const PRODUCTION_API_BASE = import.meta.env.VITE_APP_URL ?? ''

export function isCapacitorNative(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return typeof cap?.isNativePlatform === 'function' && cap.isNativePlatform()
}

export function getApiBase(): string {
  return isCapacitorNative() ? PRODUCTION_API_BASE : ''
}

export function getWsBase(): string {
  const base = getApiBase()
  if (!base) return ''
  return base.startsWith('https:') ? base.replace(/^https:/, 'wss:') : base.replace(/^http:/, 'ws:')
}

export function getFullUrl(path: string): string {
  return path.startsWith('http') ? path : `${getApiBase()}${path}`
}
