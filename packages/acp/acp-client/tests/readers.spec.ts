/**
 * The readers behind the session options and the questions: every malformed
 * shape reads as absent instead of failing, and a well-formed one keeps
 * exactly the fields the protocol defines.
 */
import { describe, expect, it } from 'vitest'
import { readConfigOption, readConfigOptions, readSessionModes } from '../src/options.ts'
import { readQuestion } from '../src/question.ts'

describe('option readers', () => {
  it('reads no modes from a value that carries none', () => {
    expect(readSessionModes(undefined)).toBeUndefined()
    expect(readSessionModes('x')).toBeUndefined()
    expect(readSessionModes({ currentModeId: 'a' })).toBeUndefined()
    expect(readSessionModes({ availableModes: [] })).toBeUndefined()
    expect(readSessionModes({ currentModeId: 7, availableModes: [] })).toBeUndefined()
  })

  it('skips a malformed mode and keeps a description', () => {
    expect(readSessionModes({
      currentModeId: 'plan',
      availableModes: ['x', { id: 'a' }, { name: 'No id' }, { id: 'plan', name: 'Plan', description: 3 }, { id: 'code', name: 'Code', description: 'Write code' }],
    })).toEqual({
      current: 'plan',
      available: [{ id: 'plan', name: 'Plan' }, { id: 'code', name: 'Code', description: 'Write code' }],
    })
  })

  it('reads no option list from a value that is no list', () => {
    expect(readConfigOptions(undefined)).toBeUndefined()
    expect(readConfigOptions({})).toBeUndefined()
    expect(readConfigOptions(['x', 7, null])).toEqual([])
  })

  it('leaves out an option without an id or a name', () => {
    expect(readConfigOption('x')).toBeUndefined()
    expect(readConfigOption({ name: 'No id' })).toBeUndefined()
    expect(readConfigOption({ id: 'no-name' })).toBeUndefined()
  })

  it('infers the type from the current value when the agent declared none, and refuses a mismatch', () => {
    expect(readConfigOption({ id: 'model', name: 'Model', currentValue: 'opus', options: [] }))
      .toEqual({ id: 'model', name: 'Model', type: 'select', currentValue: 'opus', options: [] })
    expect(readConfigOption({ id: 'model', name: 'Model', currentValue: 'opus' })).toBeUndefined()
    expect(readConfigOption({ id: 'flag', name: 'Flag', currentValue: false }))
      .toEqual({ id: 'flag', name: 'Flag', type: 'boolean', currentValue: false })
    expect(readConfigOption({ id: 'x', name: 'X', type: 'boolean', currentValue: 'yes' })).toBeUndefined()
    expect(readConfigOption({ id: 'x', name: 'X', type: 'select', currentValue: true })).toBeUndefined()
    expect(readConfigOption({ id: 'x', name: 'X', type: 'datetime', currentValue: 'now' })).toBeUndefined()
    expect(readConfigOption({ id: 'x', name: 'X', currentValue: null })).toBeUndefined()
  })

  it('reads a select without choices as no option, and drops malformed choices', () => {
    expect(readConfigOption({ id: 'x', name: 'X', type: 'select', currentValue: 'a', options: 'x' })).toBeUndefined()
    expect(readConfigOption({ id: 'x', name: 'X', type: 'select', currentValue: 'a', options: ['x', 7] }))
      .toEqual({ id: 'x', name: 'X', type: 'select', currentValue: 'a', options: [] })
    expect(readConfigOption({
      configId: 'x',
      name: 'X',
      description: 'Pick',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A', description: 'First' },
        { value: 7, name: 'Bad' },
        { name: 'No value' },
        { options: [{ value: 'c', name: 'C' }] },
        { group: 'g', options: [{ value: 'd', name: 'D' }, 'x'] },
        { group: 'g', name: 'First', options: [{ value: 'd', name: 'D' }, 'x', { value: 7, name: 'Bad' }] },
        { group: 'g', name: 'Later', options: [{ value: 'e', name: 'E' }] },
      ],
    })).toEqual({
      id: 'x',
      name: 'X',
      description: 'Pick',
      category: 'model',
      type: 'select',
      currentValue: 'a',
      options: [
        { value: 'a', name: 'A', description: 'First' },
        { value: 'd', name: 'D', group: 'First' },
        { value: 'e', name: 'E', group: 'Later' },
      ],
    })
  })
})

describe('readQuestion', () => {
  const signal = new AbortController().signal

  it('reads a free-text answer where the choices are not a list of strings', () => {
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'string', enum: 'x' } } } }, signal))
      .toMatchObject({ kind: 'form', request: { fields: [{ type: 'text', name: 'a' }] } })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'string', enum: [1, 2] } } } }, signal))
      .toMatchObject({ kind: 'form', request: { fields: [{ type: 'text', name: 'a' }] } })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'string', oneOf: [{ const: 'x' }, 'y'] } } } }, signal))
      .toMatchObject({ kind: 'form', request: { fields: [{ type: 'text', name: 'a' }] } })
  })

  it('keeps a choice description and a field label', () => {
    expect(readQuestion({
      mode: 'form',
      message: '?',
      requestedSchema: { properties: { a: { type: 'string', title: 'Pick', oneOf: [{ const: 'x', title: 'X', description: 'The x' }] } } },
    }, signal)).toEqual({
      kind: 'form',
      request: {
        message: '?',
        fields: [{ type: 'choice', name: 'a', label: 'Pick', required: false, options: [{ value: 'x', label: 'X', description: 'The x' }], multi: false }],
        signal,
      },
    })
  })

  it('reports a field it cannot express, or a schema it cannot read, as unsupported', () => {
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: 'x' } } }, signal)).toEqual({ kind: 'unsupported' })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'array', items: 'x' } } } }, signal)).toEqual({ kind: 'unsupported' })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'array', items: { enum: [1] } } } } }, signal)).toEqual({ kind: 'unsupported' })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'array' } } } }, signal)).toEqual({ kind: 'unsupported' })
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { a: { type: 'object' } } } }, signal)).toEqual({ kind: 'unsupported' })
  })

  it('reads a number and a whole-number field alike', () => {
    expect(readQuestion({ mode: 'form', message: '?', requestedSchema: { properties: { n: { type: 'number' }, i: { type: 'integer' } } } }, signal))
      .toMatchObject({ kind: 'form', request: { fields: [{ type: 'number', name: 'n' }, { type: 'number', name: 'i' }] } })
  })
})
