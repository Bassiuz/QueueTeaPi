import { describe, expect, it } from 'vitest'

import {
  ConfigurationError,
  HandlerTimeoutError,
  PermanentError,
  QueueTeaPiError,
  UnregisteredHandlerError,
} from '../src/errors.js'

describe('every error is a QueueTeaPiError', () => {
  it.each([
    new PermanentError('x'),
    new HandlerTimeoutError('orders', 'placed', 1),
    new UnregisteredHandlerError('orders', 'placed'),
    new ConfigurationError('x'),
  ])('%s', (error) => {
    expect(error).toBeInstanceOf(QueueTeaPiError)
    expect(error).toBeInstanceOf(Error)
  })
})

describe('names', () => {
  it('each error reports its own class name', () => {
    expect(new PermanentError('x').name).toBe('PermanentError')
    expect(new ConfigurationError('x').name).toBe('ConfigurationError')
    expect(new QueueTeaPiError('x').name).toBe('QueueTeaPiError')
  })
})

describe('PermanentError', () => {
  it('carries a cause when given one', () => {
    const cause = new Error('underlying')
    expect(new PermanentError('wrapped', { cause }).cause).toBe(cause)
  })

  it('leaves cause unset when no options are passed', () => {
    expect(new PermanentError('bare').cause).toBeUndefined()
  })
})

describe('HandlerTimeoutError', () => {
  it('says which handler ran long, and for how long it was allowed', () => {
    const error = new HandlerTimeoutError('orders', 'placed', 60_000)

    expect(error.topic).toBe('orders')
    expect(error.eventName).toBe('placed')
    expect(error.timeoutMs).toBe(60_000)
    expect(error.message).toBe(
      'Handler for "orders/placed" did not settle within 60000ms.',
    )
  })
})

describe('UnregisteredHandlerError', () => {
  it('tells you exactly how to fix it', () => {
    const error = new UnregisteredHandlerError('orders', 'placed')

    expect(error.message).toContain(
      'queue.handlers.register("orders", "placed", handler)',
    )
  })
})
