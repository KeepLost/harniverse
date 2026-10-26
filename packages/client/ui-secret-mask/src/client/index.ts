/**
 * Credential display masking for sent Web user text: one sent-user-text rule
 * and its run renderer, registered into the conversation seam. Masking changes
 * only the drawn text; the message text, copy actions, and model input keep
 * the original characters.
 *
 * @module @deepseek-ai/dsh-client-ui-secret-mask/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the conversation service face (ctx.conversation) this
// plugin registers its rule through — cross-plugin value imports are barred
// by the client bundle purity gate.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { createSecretRule } from './secret-rule.tsx'
import { en, NS, zh, type SecretMaskKey } from './locales.ts'

export { CredentialScanner } from './credential-scanner.ts'
export type { SecretRange } from './credential-scanner.ts'
export { formatTables } from './format-tables.ts'
export { createSecretRule } from './secret-rule.tsx'
export { SecretText } from './SecretText.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Accessible names of the control that reveals one masked credential. */
    'secretMask': SecretMaskKey
  }
}

/** Required services: the locale dictionaries and the conversation seam. */
export const inject = ['locale', 'conversation']

/**
 * Register the dictionaries and the credential matcher into the conversation's
 * sent-user-text seam.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-secret-mask: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.conversation.sentUserText.register(createSecretRule(t)), 'ui-secret-mask: sent-user-text rule')
}
