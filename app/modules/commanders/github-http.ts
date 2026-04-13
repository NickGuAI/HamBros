export function parseRepoFullName(repo: string): { owner: string; name: string } | null {
  const [owner, name] = repo.split('/')
  if (!owner || !name) {
    return null
  }

  return { owner, name }
}

export function resolveGitHubToken(explicit?: string): string | null {
  const token = explicit ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (!token || !token.trim()) {
    return null
  }

  return token.trim()
}

export function buildGitHubHeaders(token: string | null): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'hammurabi-commanders',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

export async function readGitHubError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string }
    if (payload?.message && payload.message.trim()) {
      return payload.message
    }
  } catch {
    // Fall through to status text.
  }

  return response.statusText || 'GitHub API request failed'
}
