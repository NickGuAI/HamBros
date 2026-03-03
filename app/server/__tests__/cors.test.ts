import { describe, expect, it } from 'vitest'
import { isCorsOriginAllowed, parseAllowedCorsOrigins } from '../cors'

describe('parseAllowedCorsOrigins', () => {
  it('allows all origins when unset', () => {
    expect(parseAllowedCorsOrigins(undefined)).toBeNull()
    expect(parseAllowedCorsOrigins('')).toBeNull()
    expect(parseAllowedCorsOrigins('   ')).toBeNull()
  })

  it('parses a comma-separated allowlist', () => {
    const allowed = parseAllowedCorsOrigins(
      'http://localhost:5173, https://hammurabi.internal',
    )

    expect(allowed).toEqual(
      new Set(['http://localhost:5173', 'https://hammurabi.internal']),
    )
  })

  it('treats wildcard as allow all', () => {
    expect(parseAllowedCorsOrigins('*')).toBeNull()
    expect(parseAllowedCorsOrigins('https://example.com, *')).toBeNull()
  })
})

describe('isCorsOriginAllowed', () => {
  it('allows requests without an origin header', () => {
    const allowed = parseAllowedCorsOrigins('https://example.com')
    expect(isCorsOriginAllowed(undefined, allowed)).toBe(true)
  })

  it('allows any origin when allowlist is unset', () => {
    expect(isCorsOriginAllowed('https://random-site.dev', null)).toBe(true)
  })

  it('checks allowlisted origins when configured', () => {
    const allowed = parseAllowedCorsOrigins(
      'http://localhost:5173,https://hammurabi.internal',
    )

    expect(isCorsOriginAllowed('http://localhost:5173', allowed)).toBe(true)
    expect(isCorsOriginAllowed('https://hammurabi.internal', allowed)).toBe(true)
    expect(isCorsOriginAllowed('https://blocked.example', allowed)).toBe(false)
  })
})
