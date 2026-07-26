import type { QuestArtifactType } from './quest-store.js'

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

export function isValidQuestArtifactHref(type: QuestArtifactType, href: string): boolean {
  const trimmedHref = href.trim()
  if (type === 'file') {
    return trimmedHref.length > 0
  }

  let parsed: URL
  try {
    parsed = new URL(trimmedHref)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }
  if (type === 'url') {
    return true
  }
  if (!GITHUB_HOSTS.has(parsed.hostname.toLowerCase())) {
    return false
  }

  const [owner, repo, resource, number, ...remainder] = parsed.pathname
    .split('/')
    .filter(Boolean)
  if (!owner || !repo || remainder.length > 0 || !/^[1-9]\d*$/u.test(number ?? '')) {
    return false
  }

  return type === 'github_issue'
    ? resource === 'issues'
    : resource === 'pull'
}
