/**
 * The `secret` sent-user-text rule. A value is recognized by its published
 * format alone: provider key and token prefixes, JSON Web Tokens, private key
 * blocks, and the password of an address that carries credentials. Free-form
 * passwords and `name=value` assignments have no such format and stay plain.
 * The formats live in [credential-formats.ts](./credential-formats.ts);
 * scanning lives in [credential-scanner.ts](./credential-scanner.ts).
 */
import type { ComponentType } from 'react'
import type { SentUserTextRule, SentUserTextRunProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CredentialScanner } from './credential-scanner.ts'
import { formatTables } from './format-tables.ts'
import { SecretText } from './SecretText.tsx'
import type { SecretMaskKey } from './locales.ts'

/**
 * Create the credential matcher over the conversation's sent-user-text seam.
 * Each instance owns a scanner whose memo holds the last queried text until a
 * query for another text.
 * @param t - locale seat for the reveal control's accessible name.
 * @returns the `secret` rule.
 */
export function createSecretRule(t: (key: SecretMaskKey) => string): SentUserTextRule {
  const scanner = new CredentialScanner(formatTables())
  const Render: ComponentType<SentUserTextRunProps> = props => (
    <SecretText raw={props.raw} interactive={props.interactive} data={props.data} t={t} />
  )
  return {
    id: 'secret',
    nextMatch: (text, from) => {
      const match = scanner.match(text, from)
      return match === undefined ? undefined : { start: match.start, end: match.end, data: { masked: match.masked } }
    },
    Render,
  }
}
