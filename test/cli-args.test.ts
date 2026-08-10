import { describe, expect, it } from 'vitest'

import { numberFlag, parseArgs, stringFlag } from '../src/cli/args.js'

describe('parseArgs', () => {
  it('defaults to help when nothing is passed', () => {
    expect(parseArgs([])).toEqual({
      command: 'help',
      positionals: [],
      flags: {},
    })
  })

  it('reads the command and its positionals', () => {
    expect(parseArgs(['show', 'event-1'])).toMatchObject({
      command: 'show',
      positionals: ['event-1'],
    })
  })

  it('reads --flag value', () => {
    expect(parseArgs(['list', '--status', 'dead']).flags).toEqual({
      status: 'dead',
    })
  })

  it('reads --flag=value', () => {
    expect(parseArgs(['list', '--status=dead']).flags).toEqual({
      status: 'dead',
    })
  })

  it('reads an empty --flag= as an empty string', () => {
    expect(parseArgs(['list', '--status=']).flags).toEqual({ status: '' })
  })

  it('treats a bare flag as true', () => {
    expect(parseArgs(['stats', '--json']).flags).toEqual({ json: true })
  })

  it('treats a flag followed by another flag as true', () => {
    expect(parseArgs(['stats', '--json', '--read-only']).flags).toEqual({
      json: true,
      'read-only': true,
    })
  })

  it('keeps positionals and flags apart, in any order', () => {
    expect(parseArgs(['replay', '--limit', '5', 'event-1'])).toEqual({
      command: 'replay',
      positionals: ['event-1'],
      flags: { limit: '5' },
    })
  })
})

describe('stringFlag', () => {
  it('returns a string value', () => {
    expect(stringFlag({ status: 'dead' }, 'status')).toBe('dead')
  })

  it('returns undefined for a bare flag or a missing one', () => {
    expect(stringFlag({ json: true }, 'json')).toBeUndefined()
    expect(stringFlag({}, 'status')).toBeUndefined()
  })
})

describe('numberFlag', () => {
  it('parses a positive integer', () => {
    expect(numberFlag({ limit: '25' }, 'limit', 10)).toBe(25)
  })

  it.each([
    ['a missing flag', {}],
    ['a non-numeric value', { limit: 'lots' }],
    ['zero', { limit: '0' }],
    ['a negative number', { limit: '-3' }],
    ['a bare flag', { limit: true }],
  ])('falls back for %s', (_label, flags) => {
    expect(numberFlag(flags, 'limit', 10)).toBe(10)
  })
})
