import { describe, expect, it } from 'vitest'

import { isLostClaimError } from '../src/firestore/precondition.js'

describe('isLostClaimError', () => {
  it.each([
    ['a failed precondition', 9],
    ['a missing document', 5],
    ['an aborted write', 10],
  ])('recognises %s by numeric code', (_label, code) => {
    expect(isLostClaimError(Object.assign(new Error('x'), { code }))).toBe(true)
  })

  it.each(['FAILED_PRECONDITION', 'NOT_FOUND', 'ABORTED', 'not_found'])(
    'recognises the status name %s',
    (code) => {
      expect(isLostClaimError(Object.assign(new Error('x'), { code }))).toBe(
        true,
      )
    },
  )

  it('does not swallow a permission error', () => {
    expect(isLostClaimError(Object.assign(new Error('denied'), { code: 7 }))).toBe(
      false,
    )
  })

  it('does not swallow an unrecognised status name', () => {
    expect(
      isLostClaimError(Object.assign(new Error('x'), { code: 'UNAVAILABLE' })),
    ).toBe(false)
  })

  it('does not swallow an error with no code at all', () => {
    expect(isLostClaimError(new Error('network went away'))).toBe(false)
  })

  it('does not swallow an error whose code is some other type', () => {
    expect(
      isLostClaimError(Object.assign(new Error('x'), { code: { nested: 9 } })),
    ).toBe(false)
  })

  it.each([null, undefined, 'a string', 42])(
    'says no for the non-object %p',
    (value) => {
      expect(isLostClaimError(value)).toBe(false)
    },
  )
})
