import { describe, expect, it } from 'vitest'
import { sanitizeUiProfile } from '../commander-profile.js'

describe('sanitizeUiProfile', () => {
  it('accepts valid profile fields', () => {
    expect(
      sanitizeUiProfile({
        borderColor: '#1a1a1a',
        accentColor: 'rgb(10, 20, 30)',
        speakingTone: 'Dry wit, concise.',
        avatar: '.memory/avatar.png',
      }),
    ).toEqual({
      borderColor: '#1a1a1a',
      accentColor: 'rgb(10, 20, 30)',
      speakingTone: 'Dry wit, concise.',
      avatar: '.memory/avatar.png',
    })
  })

  it('rejects path traversal in avatar', () => {
    expect(
      sanitizeUiProfile({
        avatar: '../../../etc/passwd',
      }),
    ).toEqual(null)
  })

  it('rejects absurd border colors', () => {
    expect(
      sanitizeUiProfile({
        borderColor: 'url(javascript:alert(1))',
      }),
    ).toEqual(null)
  })
})
