export type AllowedCorsOrigins = Set<string> | null

export function parseAllowedCorsOrigins(raw: string | undefined): AllowedCorsOrigins {
  const value = raw?.trim()
  if (!value) {
    // Unset means open by default so local dev and direct browser clients work.
    return null
  }

  const origins = new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )

  return origins.has('*') || origins.size === 0 ? null : origins
}

export function isCorsOriginAllowed(
  origin: string | undefined,
  allowedOrigins: AllowedCorsOrigins,
): boolean {
  if (!origin) {
    return true
  }

  if (allowedOrigins === null) {
    return true
  }

  return allowedOrigins.has(origin)
}
