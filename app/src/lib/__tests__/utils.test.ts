import { describe, it, expect } from 'vitest'
import { timeAgo, formatCost, formatTokens, cn } from '@/lib/utils'

describe('timeAgo', () => {
  it('formats seconds', () => {
    const d = new Date(Date.now() - 30000).toISOString()
    expect(timeAgo(d)).toBe('30s ago')
  })

  it('formats minutes', () => {
    const d = new Date(Date.now() - 5 * 60000).toISOString()
    expect(timeAgo(d)).toBe('5m ago')
  })

  it('formats hours', () => {
    const d = new Date(Date.now() - 3 * 3600000).toISOString()
    expect(timeAgo(d)).toBe('3h ago')
  })

  it('formats days', () => {
    const d = new Date(Date.now() - 2 * 86400000).toISOString()
    expect(timeAgo(d)).toBe('2d ago')
  })
})

describe('formatCost', () => {
  it('formats to two decimal places with dollar sign', () => {
    expect(formatCost(1.5)).toBe('$1.50')
    expect(formatCost(0)).toBe('$0.00')
    expect(formatCost(12.345)).toBe('$12.35')
  })
})

describe('formatTokens', () => {
  it('formats small numbers as-is', () => {
    expect(formatTokens(500)).toBe('500')
  })

  it('formats thousands with K', () => {
    expect(formatTokens(45000)).toBe('45.0K')
  })

  it('formats millions with M', () => {
    expect(formatTokens(1500000)).toBe('1.5M')
  })
})

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b', 'c')).toBe('a b c')
  })

  it('filters falsy values', () => {
    expect(cn('a', false, null, undefined, 'b')).toBe('a b')
  })
})
