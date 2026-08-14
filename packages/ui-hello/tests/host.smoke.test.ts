import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

describe('@auto-coding/ui-hello Node half', () => {
  it('applies as a no-op host plugin', () => {
    expect(() => apply()).not.toThrow()
  })
})
