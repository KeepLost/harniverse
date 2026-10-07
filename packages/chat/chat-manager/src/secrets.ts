/**
 * Bot secrets in the credential store. Every secret field of a managed bot is
 * one credential named `DSH_CHAT_BOT_<BOT ID>_<FIELD>` in upper case; the
 * registry holds only the field keys, and no function here returns a value to
 * a caller that would put it on the wire.
 * @module @deepseek-ai/dsh-chat-manager/secrets
 */

import { credentialRef, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ChatBotSecretView } from './types.ts'

/** A secret shorter than this shows no tail: four characters would expose too large a share of it. */
const MIN_TAIL_SECRET_LENGTH = 16

/**
 * Credential name holding one secret field of one bot.
 * @param botId - registry bot id.
 * @param field - descriptor field key.
 * @returns the credential reference name.
 */
export function secretRef(botId: string, field: string): string {
  return `DSH_CHAT_BOT_${botId.toUpperCase()}_${field.toUpperCase()}`
}

/**
 * Credential names of a bot's secret fields.
 * @param botId - registry bot id.
 * @param keys - secret field keys.
 * @returns the reference name by field key, in the shape `ChatManagedBot.secretRefs` expects.
 */
export function secretRefs(botId: string, keys: readonly string[]): Record<string, string> {
  return Object.fromEntries(keys.map(key => [key, secretRef(botId, key)]))
}

/**
 * Store every secret of a bot, all or nothing: a failed write unsets the ones already stored.
 * @param credentials - credential provider.
 * @param botId - registry bot id.
 * @param secrets - typed secret values by field key.
 */
export async function storeSecrets(
  credentials: CredentialProvider,
  botId: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const stored: string[] = []
  try {
    for (const [key, value] of Object.entries(secrets)) {
      await credentials.set(credentialRef(secretRef(botId, key)), value)
      stored.push(key)
    }
  } catch (error) {
    await removeSecrets(credentials, botId, stored)
    throw error
  }
}

/**
 * Delete a bot's stored secrets; an absent credential is a no-op.
 * @param credentials - credential provider.
 * @param botId - registry bot id.
 * @param keys - secret field keys.
 */
export async function removeSecrets(credentials: CredentialProvider, botId: string, keys: readonly string[]): Promise<void> {
  for (const key of keys) await credentials.unset(credentialRef(secretRef(botId, key)))
}

/**
 * Resolve a bot's stored secrets for a platform probe.
 * @param credentials - credential provider.
 * @param botId - registry bot id.
 * @param keys - secret field keys.
 * @returns the values of the keys that are configured; a missing credential is simply absent.
 */
export async function readSecrets(
  credentials: CredentialProvider,
  botId: string,
  keys: readonly string[],
): Promise<Record<string, string>> {
  const values: Record<string, string> = {}
  for (const key of keys) {
    const resolved = await credentials.resolve(credentialRef(secretRef(botId, key)))
    if (resolved !== undefined) values[key] = resolved.value
  }
  return values
}

/**
 * The wire view of one secret: whether it is stored, and the last four characters of a long one.
 * @param value - the stored value, or undefined when unset.
 * @returns the configured flag and tail.
 */
export function secretView(value: string | undefined): ChatBotSecretView {
  if (value === undefined) return { configured: false, tail: '' }
  return { configured: true, tail: value.length >= MIN_TAIL_SECRET_LENGTH ? value.slice(-4) : '' }
}
