import { describe, expect, it } from 'vitest'

import {
  DEFAULT_INVITE_CODE_LENGTH,
  INVITE_CODE_ALPHABET,
  MAX_INVITE_CODE_LENGTH,
  MIN_INVITE_CODE_LENGTH,
  generateInviteCode,
  inviteCodeSchema,
  normalizeInviteCode,
} from './invite-code.js'

describe('Crockford Base-32 Invite Codes (T11 §5.2, §9)', () => {
  describe('normalizeInviteCode', () => {
    it('normalises lowercase to uppercase', () => {
      expect(normalizeInviteCode('k4m9qr7xz2ab8hjt')).toBe('K4M9QR7XZ2AB8HJT')
    })

    it('strips leading, trailing, and embedded whitespace', () => {
      expect(normalizeInviteCode('  k4m9 qr7x \n z2ab\t8hjt  ')).toBe('K4M9QR7XZ2AB8HJT')
    })

    it('folds excluded look-alike characters (I, L -> 1; O -> 0; U -> V)', () => {
      // i -> 1, l -> 1, o -> 0, u -> V
      expect(normalizeInviteCode('ilouILOU')).toBe('110V110V')
      expect(normalizeInviteCode('k4m9qr7xilou')).toBe('K4M9QR7X110V')
    })

    it('rejects non-alphabet characters', () => {
      expect(() => normalizeInviteCode('k4m9-qr7x-ilou')).toThrow()
      expect(() => normalizeInviteCode('k4m9!qr7xz2ab8hjt')).toThrow()
      expect(() => normalizeInviteCode('k4m9@qr7xz2ab8hjt')).toThrow()
      expect(() => normalizeInviteCode('k4m9#qr7xz2ab8hjt')).toThrow()
      expect(() => normalizeInviteCode('k4m9?qr7xz2ab8hjt')).toThrow()
      expect(() => normalizeInviteCode('')).toThrow()
      expect(() => normalizeInviteCode('   ')).toThrow()
    })
  })

  describe('inviteCodeSchema', () => {
    it('accepts and normalises a valid 16-character code', () => {
      const result = inviteCodeSchema.parse('k4m9qr7xz2ab8hjt')
      expect(result).toBe('K4M9QR7XZ2AB8HJT')
      expect(result.length).toBe(16)
    })

    it('accepts and normalises a valid 20-character code', () => {
      const result = inviteCodeSchema.parse('  k4m9qr7xz2ab8hjtc5vn  ')
      expect(result).toBe('K4M9QR7XZ2AB8HJTC5VN')
      expect(result.length).toBe(20)
    })

    it('accepts a valid 32-character code', () => {
      const code32 = 'K4M9QR7XZ2AB8HJTC5VNWY0PD3E6FGRS'
      expect(inviteCodeSchema.parse(code32)).toBe(code32)
    })

    it('rejects a code shorter than 16 characters', () => {
      expect(() => inviteCodeSchema.parse('K4M9QR7XZ2AB8HJ')).toThrow()
    })

    it('rejects a code longer than 32 characters', () => {
      expect(() => inviteCodeSchema.parse('K4M9QR7XZ2AB8HJTC5VNWY0PD3E6FGRS1')).toThrow()
    })

    it('rejects a code containing invalid characters', () => {
      expect(() => inviteCodeSchema.parse('K4M9QR7XZ2AB8HJT$')).toThrow()
    })
  })

  describe('generateInviteCode', () => {
    it('generates a 20-character code by default', () => {
      const code = generateInviteCode()
      expect(code.length).toBe(DEFAULT_INVITE_CODE_LENGTH)
      expect(code.length).toBe(20)
    })

    it('generates codes of requested length within bounds [16, 32]', () => {
      expect(generateInviteCode(MIN_INVITE_CODE_LENGTH).length).toBe(16)
      expect(generateInviteCode(24).length).toBe(24)
      expect(generateInviteCode(MAX_INVITE_CODE_LENGTH).length).toBe(32)
    })

    it('throws if requested length is outside bounds', () => {
      expect(() => generateInviteCode(15)).toThrow()
      expect(() => generateInviteCode(33)).toThrow()
      expect(() => generateInviteCode(0)).toThrow()
      expect(() => generateInviteCode(-1)).toThrow()
    })

    it('never contains excluded characters I, L, O, or U', () => {
      for (let i = 0; i < 50; i += 1) {
        const code = generateInviteCode()
        expect(code).not.toMatch(/[ILOU]/)
      }
    })

    it('only contains characters from INVITE_CODE_ALPHABET', () => {
      const alphabetSet = new Set(INVITE_CODE_ALPHABET.split(''))
      for (let i = 0; i < 50; i += 1) {
        const code = generateInviteCode()
        for (const char of code) {
          expect(alphabetSet.has(char)).toBe(true)
        }
      }
    })

    it('generates distinct codes across successive calls', () => {
      const codes = new Set(Array.from({ length: 20 }, () => generateInviteCode()))
      expect(codes.size).toBe(20)
    })
  })
})
