import { describe, expect, it } from 'vitest'
import { invokeBinding, validateBindings } from '../src/bindings.ts'
import { PtcImage, PtcInspectableValue } from '@deepseek-ai/dsh-ptc-runtime'
import type { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { brandString } from '@deepseek-ai/dsh-brand'
import { decodePtcJsonWire, type PtcImageWire } from '../src/json-wire.ts'

describe('program binding invocation', () => {
  it('encodes images and plain members of a resolution through the image registrar', async () => {
    const registered: string[] = []
    const image = (value: PtcImage): PtcImageWire => {
      const wire: PtcImageWire = {
        kind: 'image', id: `img-${registered.length}`, attachmentId: value.attachment.attachmentId, path: value.path,
        width: value.attachment.width, height: value.attachment.height,
      }
      registered.push(wire.id)
      return wire
    }
    const photo = new PtcImage('/host/photo.png', {
      attachmentId: brandString<AttachmentId>('sha256:photo'), mediaType: 'image/png', bytes: 64, width: 8, height: 4,
    })
    const result = await invokeBinding(async () => ({ label: 'proof', meta: { kept: true }, photo }), null, image)
    expect(registered).toEqual(['img-0'])
    const decoded = decodePtcJsonWire(result.value, wire => wire.id) as { label: string; meta: { kept: boolean }; photo: unknown }
    expect(decoded.label).toBe('proof')
    expect(decoded.meta).toEqual({ kept: true })
    expect(decoded.photo).toBe('img-0')
  })

  it('keeps inspectable text and value apart from the encoded resolution', async () => {
    const result = await invokeBinding(async () => new PtcInspectableValue({ n: 1 }, 'the value'), null)
    expect(result.inspection).toBe('the value')
    expect(decodePtcJsonWire(result.value)).toEqual({ n: 1 })
  })
})

describe('program binding validation', () => {
  it.each(['$name', '', 'while', 'lambda', 'console'])('rejects unusable global %s', (global) => {
    expect(() => validateBindings({ program: '', bindings: [{ global, functions: {} }] })).toThrow()
  })
  it('rejects duplicated globals and accepts arbitrary own member names', () => {
    const functions = Object.create(null) as Record<string, () => Promise<string>>
    functions.__proto__ = async () => 'own'
    expect(validateBindings({ program: '', bindings: [{ global: 'tools', functions }] }).get('tools')?.functions).toBe(functions)
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions }, { global: 'tools', functions }] })).toThrow('duplicate')
  })
  it.each(['$name', 'while', 'console', 'tools'])('rejects invalid error class name %s', (name) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name, memberNameProperty: 'member' } }] })).toThrow()
  })
  it.each(['', 'name', '__member__'])('rejects invalid error member %s', (memberNameProperty) => {
    expect(() => validateBindings({ program: '', bindings: [{ global: 'tools', functions: {}, errorClass: { name: 'ToolError', memberNameProperty } }] })).toThrow()
  })
  it('rejects two injected constructors with the same name', () => {
    expect(() => validateBindings({ program: '', bindings: ['first', 'second'].map(global => ({ global, functions: {}, errorClass: { name: 'ToolError', memberNameProperty: 'member' } })) })).toThrow('duplicate')
  })
})
