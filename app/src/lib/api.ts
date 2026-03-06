import { getApiBase } from './api-base'

type AccessTokenResolver = () => Promise<string | null>

let accessTokenResolver: AccessTokenResolver | null = null

export function setAccessTokenResolver(resolver: AccessTokenResolver | null): void {
  accessTokenResolver = resolver
}

function shouldInjectBearerToken(headers: Headers): boolean {
  return (
    !headers.has('authorization') &&
    !headers.has('x-hammurabi-api-key') &&
    !headers.has('x-api-key')
  )
}

export async function buildRequestHeaders(headersInit?: HeadersInit): Promise<Headers> {
  const headers = new Headers(headersInit)
  if (!accessTokenResolver || !shouldInjectBearerToken(headers)) {
    return headers
  }

  try {
    const token = await accessTokenResolver()
    if (token) {
      headers.set('authorization', `Bearer ${token}`)
    }
  } catch {
    // If token retrieval fails we still allow explicit API key requests.
  }

  return headers
}

export async function getAccessToken(): Promise<string | null> {
  if (!accessTokenResolver) {
    return null
  }

  try {
    return await accessTokenResolver()
  } catch {
    return null
  }
}

export async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = await buildRequestHeaders(init?.headers)
  const url = path.startsWith('http') ? path : `${getApiBase()}${path}`
  const response = await fetch(url, {
    ...init,
    headers,
  })
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Request failed (${response.status}): ${body}`)
  }
  return (await response.json()) as T
}
