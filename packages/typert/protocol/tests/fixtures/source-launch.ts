import { Context } from '@deepseek-ai/cordis'
import {
  TypertRemoteService,
  Remote,
  RemoteScope,
  remoteMethods,
} from '@deepseek-ai/dsh-typert-protocol'

class Goals extends TypertRemoteService {
  constructor(ctx: Context) {
    super(ctx, 'goals')
  }

  @Remote({ requiredCapability: 'harniverse.observe' })
  create(value: string): string {
    return value
  }

  @RemoteScope('agent', { requiredCapability: 'harniverse.operate' })
  scoped(value: string): string {
    return value
  }
}

const methods = remoteMethods(new Goals(new Context()))
const actual = JSON.stringify(methods)
const expected = JSON.stringify([
  { method: 'create', invocation: { kind: 'direct' }, requiredCapability: 'harniverse.observe' },
  { method: 'scoped', invocation: { kind: 'context', context: 'agent' }, requiredCapability: 'harniverse.operate' },
])
if (actual !== expected) throw new Error(`unexpected Remote declarations: ${actual}`)
process.stdout.write(actual)
