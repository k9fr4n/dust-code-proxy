import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { jsonSchemaToZod, toolResultToText, coerceToolInput } from './tools.js'

describe('jsonSchemaToZod', () => {
  it('maps an object schema with properties and required', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        command: { type: 'string', description: 'the command' },
        timeout: { type: 'integer' },
      },
      required: ['command'],
    })
    expect(schema.safeParse({ command: 'ls', timeout: 5 }).success).toBe(true)
    expect(schema.safeParse({ timeout: 5 }).success).toBe(false) // command required
    expect(schema.safeParse({ command: 'ls' }).success).toBe(true) // timeout optional
  })

  it('maps primitives', () => {
    expect(jsonSchemaToZod({ type: 'string' }).safeParse('x').success).toBe(true)
    expect(jsonSchemaToZod({ type: 'number' }).safeParse(1).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(1).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(1.5).success).toBe(false)
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true)
    expect(jsonSchemaToZod({ type: 'null' }).safeParse(null).success).toBe(true)
  })

  it('maps enum to a zod enum', () => {
    const schema = jsonSchemaToZod({ type: 'string', enum: ['a', 'b'] })
    expect(schema.safeParse('a').success).toBe(true)
    expect(schema.safeParse('c').success).toBe(false)
  })

  it('maps array with items', () => {
    const schema = jsonSchemaToZod({ type: 'array', items: { type: 'string' } })
    expect(schema.safeParse(['a', 'b']).success).toBe(true)
    expect(schema.safeParse([1]).success).toBe(false)
  })

  it('maps anyOf to a union', () => {
    const schema = jsonSchemaToZod({
      anyOf: [{ type: 'string' }, { type: 'number' }],
    })
    expect(schema.safeParse('x').success).toBe(true)
    expect(schema.safeParse(3).success).toBe(true)
    expect(schema.safeParse(false).success).toBe(false)
  })

  it('treats absent required as all-optional', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: { text: { type: 'string' } },
    })
    expect(schema.safeParse({}).success).toBe(true)
    expect(schema.safeParse({ text: 'x' }).success).toBe(true)
  })

  it('falls back to a loose record for missing type/properties', () => {
    const schema = jsonSchemaToZod({})
    expect(schema.safeParse({ anything: true }).success).toBe(true)
    expect(schema.safeParse(null).success).toBe(false)
  })

  it('handles undefined schema', () => {
    const schema = jsonSchemaToZod(undefined)
    expect(schema.safeParse({ a: 1 }).success).toBe(true)
  })

  it('returns a z.ZodTypeAny-compatible value', () => {
    const schema = jsonSchemaToZod({ type: 'object', properties: {} })
    expect(schema).toBeInstanceOf(z.ZodType)
  })
})

describe('toolResultToText', () => {
  it('passes strings through', () => {
    expect(toolResultToText('done')).toBe('done')
  })

  it('joins text blocks from an array', () => {
    expect(toolResultToText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe(
      'a\nb',
    )
  })

  it('stringifies non-text blocks', () => {
    expect(toolResultToText([{ type: 'image' }])).toBe('{"type":"image"}')
  })

  it('stringifies primitives and null', () => {
    expect(toolResultToText(null)).toBe('""')
    expect(toolResultToText(42)).toBe('42')
  })
})

describe('coerceToolInput', () => {
  const bashSchema = {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout: { type: 'number' },
      run_in_background: { type: 'boolean' },
    },
  }

  it('leaves well-typed input untouched', () => {
    expect(coerceToolInput({ command: 'ls' }, bashSchema)).toEqual({ command: 'ls' })
  })

  it('coerces a non-string command into a string', () => {
    expect(coerceToolInput({ command: 42 }, bashSchema)).toEqual({ command: '42' })
    expect(coerceToolInput({ command: { cmd: 'ls' } }, bashSchema)).toEqual({
      command: '{"cmd":"ls"}',
    })
    expect(coerceToolInput({ command: ['ls', '-la'] }, bashSchema)).toEqual({
      command: '["ls","-la"]',
    })
  })

  it('leaves non-string fields and unknown keys alone', () => {
    expect(coerceToolInput({ command: 'ls', timeout: 5, extra: { a: 1 } }, bashSchema)).toEqual({
      command: 'ls',
      timeout: 5,
      extra: { a: 1 },
    })
  })

  it('passes through when there is no string-typed schema', () => {
    expect(coerceToolInput({ command: 42 }, { type: 'object' })).toEqual({ command: 42 })
    expect(coerceToolInput({ command: 42 }, undefined)).toEqual({ command: 42 })
  })
})
