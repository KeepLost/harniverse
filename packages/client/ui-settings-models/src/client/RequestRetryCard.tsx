/**
 * The Model Profiles (模型方案) section's request-retry card: one
 * always-visible trio — retry count plus first/max retry waits in seconds —
 * standing in for the global model-request retry posture OpenCode exposes.
 * The engine seam is per-provider (`retryPolicy` under each provider
 * profile; the dsh-llm-retry executor refuses a plugin-level policy), so the
 * card fans the typed policy out to every provider row whose settings schema
 * declares `retryPolicy`: one `settings.mutate` per namespace, `unset` ops
 * when every field is cleared, and a `normal`-mode policy with both waits
 * named in milliseconds otherwise, its cap raised to at least the first
 * wait. Providers that disagree today are reported as mixed and overwritten
 * together; a provider added later keeps the engine defaults until the card
 * is saved again.
 */

import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { IApiClient, SettingsNamespaceView, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { nodeAtPath, getPath, rehydrateSchema } from '@deepseek-ai/dsh-client-schema-form'
import type { SchemaNode } from '@deepseek-ai/dsh-client-schema-form'
import { messageOf } from './store.ts'
import type { en } from './locales.ts'
import styles from './ModelsSection.module.css'

/**
 * dsh-llm retry-policy defaults, mirrored for placeholders and for
 * normalizing a write that names only some fields (retry-policy.ts owns the
 * real resolution; these are its stable display-side constants).
 */
const RETRY_DEFAULTS = { maxRetries: 2, initialDelayMs: 500, maxDelayMs: 10_000 } as const
/** One scheduled retry wait cannot exceed the engine timer ceiling, in seconds. */
const RETRY_WAIT_MAX_SECONDS = 2_147_483

/** The three retry fields as raw input text; empty means "not overridden". */
export interface RetryRaw {
  readonly count: string
  readonly interval: string
  readonly cap: string
}

/** A fan-out destination: one provider profile the card may write to. */
export interface RetryTarget {
  /** Namespace holding the profile. */
  readonly ns: string
  /** Profile path inside the namespace. */
  readonly path: readonly string[]
  /** Namespace revision the write must be expected against. */
  readonly revision: number
  /** The stored user-layer profile subtree, for readback. */
  readonly profile: unknown
}

function numberAt(source: unknown, key: string): number | undefined {
  const value = getPath(source, [key])
  return typeof value === 'number' ? value : undefined
}

/**
 * The retry policy a resolved profile carries, if any. Both adapter families
 * embed `retryPolicy` at the profile root in config shape (`backoff` nested);
 * a policy without `backoff` still names its waits flat nowhere, so the waits
 * read falls back to the policy object itself.
 */
export function retryPartsOf(profile: unknown): {
  maxRetries: number | undefined
  initialDelayMs: number | undefined
  maxDelayMs: number | undefined
} {
  const policy = getPath(profile, ['retryPolicy'])
  if (typeof policy !== 'object' || policy === null) {
    return { maxRetries: undefined, initialDelayMs: undefined, maxDelayMs: undefined }
  }
  const backoff = getPath(policy, ['backoff'])
  const waits = typeof backoff === 'object' && backoff !== null ? backoff : policy
  return {
    maxRetries: numberAt(policy, 'maxRetries'),
    initialDelayMs: numberAt(waits, 'initialDelayMs'),
    maxDelayMs: numberAt(waits, 'maxDelayMs'),
  }
}

/** The raw fields a stored policy reads back as (waits shown in seconds). */
export function retryRawOf(parts: {
  maxRetries: number | undefined
  initialDelayMs: number | undefined
  maxDelayMs: number | undefined
}): RetryRaw {
  return {
    count: parts.maxRetries === undefined ? '' : String(parts.maxRetries),
    interval: parts.initialDelayMs === undefined ? '' : String(parts.initialDelayMs / 1000),
    cap: parts.maxDelayMs === undefined ? '' : String(parts.maxDelayMs / 1000),
  }
}

/**
 * The first invalid-retry message key, or undefined when the raw fields can
 * be written. Counts are non-negative safe integers; waits are positive
 * finite seconds no larger than the engine timer ceiling.
 */
export function retryFailureOf(raw: RetryRaw): 'retryCountInvalid' | 'retryIntervalInvalid' | 'retryIntervalOrder' | undefined {
  if (raw.count !== '' && (!/^\d+$/.test(raw.count) || !Number.isSafeInteger(Number(raw.count)))) {
    return 'retryCountInvalid'
  }
  const badWait = (text: string): boolean => {
    if (text === '') return false
    const value = Number(text)
    return !Number.isFinite(value) || value <= 0 || value > RETRY_WAIT_MAX_SECONDS
  }
  if (badWait(raw.interval) || badWait(raw.cap)) return 'retryIntervalInvalid'
  const interval = raw.interval === '' ? undefined : Number(raw.interval)
  const cap = raw.cap === '' ? undefined : Number(raw.cap)
  if (interval !== undefined && cap !== undefined && interval > cap) return 'retryIntervalOrder'
  return undefined
}

/**
 * The shared policy the raw fields produce: every field cleared unsets the
 * override everywhere; otherwise a `normal`-mode policy whose backoff always
 * names both waits in milliseconds — a field left empty takes the engine
 * default, and the cap is raised to at least the first wait so the stored
 * profile can never violate the engine's initial<=max invariant.
 */
/** The stored shape a saved trio writes. */
export interface SharedRetryPolicy {
  mode: 'normal'
  maxRetries?: number
  backoff: { initialDelayMs: number; maxDelayMs: number }
}

export function retryValueOf(raw: RetryRaw): { kind: 'unset' } | { kind: 'set'; value: SharedRetryPolicy } {
  if (raw.count === '' && raw.interval === '' && raw.cap === '') return { kind: 'unset' }
  const initialMs = raw.interval === '' ? RETRY_DEFAULTS.initialDelayMs : Number(raw.interval) * 1000
  const cappedMs = raw.cap === '' ? RETRY_DEFAULTS.maxDelayMs : Number(raw.cap) * 1000
  return {
    kind: 'set',
    value: {
      mode: 'normal',
      ...(raw.count === '' ? {} : { maxRetries: Number(raw.count) }),
      backoff: { initialDelayMs: initialMs, maxDelayMs: Math.max(cappedMs, initialMs) },
    },
  }
}

/**
 * Resolve the fan-out destinations from the page's provider rows: every row
 * whose namespace is loaded and whose schema node at the row's settings path
 * declares `retryPolicy` (this is what keeps the fan-out to provider families
 * that own a retry policy, and drops rows addressing unresolvable paths).
 * @param rows - the page's provider rows.
 * @param namespaces - the loaded namespace views by name.
 * @returns the writable destinations, in row order.
 */
export function retryTargetsOf(
  rows: ReadonlyArray<{ settingsNs: string; settingsPath: readonly string[] }>,
  namespaces: ReadonlyMap<string, SettingsNamespaceView>,
): RetryTarget[] {
  const roots = new Map<string, SchemaNode>()
  return rows.flatMap((row) => {
    if (row.settingsNs === '') return []
    const namespace = namespaces.get(row.settingsNs)
    if (namespace === undefined) return []
    let root = roots.get(namespace.ns)
    if (root === undefined) {
      root = rehydrateSchema(namespace.schema)
      roots.set(namespace.ns, root)
    }
    const node = nodeAtPath(root, row.settingsPath)
    if (node?.type !== 'object' || (node.dict as Record<string, SchemaNode> | undefined)?.retryPolicy === undefined) {
      return []
    }
    return [{
      ns: namespace.ns,
      path: row.settingsPath,
      revision: namespace.revision,
      profile: getPath(namespace.user, row.settingsPath),
    }]
  })
}

/** Props of {@link RequestRetryCard}. */
export interface RequestRetryCardProps {
  /** The page's provider rows (the fan-out candidates). */
  rows: ReadonlyArray<{ settingsNs: string; settingsPath: readonly string[] }>
  /** Loaded settings namespace views by name. */
  namespaces: ReadonlyMap<string, SettingsNamespaceView>
  /** Whether settings are writable (a read-only provider disables the card). */
  writable: boolean
  /** Wire face for the settings writes. */
  api: Pick<IApiClient, 'settings'>
  /** Shared mirror write fencing and successful-response fold. */
  writeFence: () => number
  isCurrent: (fence: number) => boolean
  acceptSettingsView: (view: SettingsNamespaceView, fence: number, authentication?: unknown) => boolean
  /** Section copy. */
  t: (key: keyof typeof en) => string
}

/**
 * Render the Models page's request-retry card.
 * @param props - the fan-out candidates plus wire faces and copy.
 * @returns the card, or null while no provider owns a retry policy.
 */
export function RequestRetryCard(props: RequestRetryCardProps): ReactNode {
  const { api, t } = props
  const targets = useMemo(
    () => retryTargetsOf(props.rows, props.namespaces),
    [props.rows, props.namespaces],
  )
  const derived = useMemo(() => {
    const parts = targets.map(target => retryPartsOf(target.profile))
    const keyOf = (value: RetryRaw): string => `${value.count}|${value.interval}|${value.cap}`
    const raws = parts.map(part => retryRawOf(part))
    const uniform = raws.length === 0
      || raws.every(raw => keyOf(raw) === keyOf(raws[0] as RetryRaw))
    return {
      raw: uniform ? raws[0] ?? { count: '', interval: '', cap: '' } : { count: '', interval: '', cap: '' },
      mixed: !uniform,
    }
  }, [targets])
  const [retryRaw, setRetryRaw] = useState<RetryRaw>(derived.raw)
  // Fields follow the stored policy until the user types; after a save the
  // refreshed view flows back through this same sync.
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (dirty) return
    setRetryRaw(current => (current === derived.raw
      || (current.count === derived.raw.count
        && current.interval === derived.raw.interval
        && current.cap === derived.raw.cap)) ? current : derived.raw)
  }, [derived, dirty])
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [appliedCount, setAppliedCount] = useState<number | undefined>(undefined)
  const retryFailure = retryFailureOf(retryRaw)
  const retryValue = retryValueOf(retryRaw)
  const disabled = !props.writable || busy

  /**
   * The fan-out write: one mutate per namespace, its ops carrying the same
   * shared policy to every destination profile. A conflict or rejection on
   * any namespace stops the sweep with the failure shown — the namespaces
   * already written keep their applied policy.
   */
  const apply = async (): Promise<void> => {
    const fence = props.writeFence()
    setBusy(true)
    setFailure(undefined)
    try {
      const byNs = new Map<string, { revision: number; paths: (readonly string[])[] }>()
      for (const target of targets) {
        const group = byNs.get(target.ns)
        if (group === undefined) byNs.set(target.ns, { revision: target.revision, paths: [target.path] })
        else group.paths.push(target.path)
      }
      for (const [nsName, group] of byNs) {
        const ops: SettingsPathOpView[] = group.paths.map(path => retryValue.kind === 'unset'
          ? { op: 'unset' as const, path: [...path, 'retryPolicy'] }
          : { op: 'set' as const, path: [...path, 'retryPolicy'], value: retryValue.value })
        const response = await api.settings.mutate({ ns: nsName, ops, expectedRevision: group.revision })
        if (!response.result.ok) {
          if (props.isCurrent(fence)) {
            setFailure(response.result.error.code === 'settings-conflict'
              ? t('conflict')
              : response.result.error.message)
          }
          return
        }
        if (!props.acceptSettingsView(response.result.value, fence, response.authentication)) return
      }
      if (props.isCurrent(fence)) {
        setAppliedCount(targets.length)
        setDirty(false)
      }
    } catch (error) {
      // A transport failure (disconnect, a request the host refuses) rejects
      // rather than answering; without this the card would stay busy forever
      // with no error shown.
      if (props.isCurrent(fence)) setFailure(messageOf(error))
    } finally {
      if (props.isCurrent(fence)) setBusy(false)
    }
  }

  if (targets.length === 0) return null

  return (
    <div className={styles['policyCard']}>
      <h3 className={styles['policyTitle']}>{t('retryTitle')}</h3>
      <p className={styles['policyHint']}>{t('retryHint')}</p>
      {derived.mixed ? <p className={styles['policyHint']}>{t('retryMixed')}</p> : null}
      <div className={styles['retryRow']}>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('retryCount')}</span>
          <input
            className={styles['input']}
            type="text"
            inputMode="numeric"
            value={retryRaw.count}
            placeholder={String(RETRY_DEFAULTS.maxRetries)}
            aria-label={t('retryCount')}
            aria-invalid={retryFailure === 'retryCountInvalid'}
            disabled={disabled}
            onChange={(event) => {
              setDirty(true)
              setRetryRaw({ ...retryRaw, count: event.target.value })
            }}
          />
        </div>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('retryInterval')}</span>
          <input
            className={styles['input']}
            type="text"
            inputMode="decimal"
            value={retryRaw.interval}
            placeholder={String(RETRY_DEFAULTS.initialDelayMs / 1000)}
            aria-label={t('retryInterval')}
            aria-invalid={retryFailure === 'retryIntervalInvalid' || retryFailure === 'retryIntervalOrder'}
            disabled={disabled}
            onChange={(event) => {
              setDirty(true)
              setRetryRaw({ ...retryRaw, interval: event.target.value })
            }}
          />
        </div>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('retryCap')}</span>
          <input
            className={styles['input']}
            type="text"
            inputMode="decimal"
            value={retryRaw.cap}
            placeholder={String(RETRY_DEFAULTS.maxDelayMs / 1000)}
            aria-label={t('retryCap')}
            aria-invalid={retryFailure === 'retryIntervalOrder'}
            disabled={disabled}
            onChange={(event) => {
              setDirty(true)
              setRetryRaw({ ...retryRaw, cap: event.target.value })
            }}
          />
        </div>
        <button
          type="button"
          className={styles['primaryButton']}
          disabled={disabled || retryFailure !== undefined}
          onClick={() => { void apply() }}
        >
          {busy ? t('retryApplying') : t('retryApply')}
        </button>
      </div>
      {retryFailure === undefined ? null : <p className={styles['error']}>{t(retryFailure)}</p>}
      {failure === undefined ? null : <p className={styles['error']}>{failure}</p>}
      {appliedCount === undefined
        ? null
        : (
          <p className={styles['savedNotice']} role="status" aria-live="polite">
            {t('retryApplied').replace('{count}', () => String(appliedCount))}
          </p>
        )}
    </div>
  )
}
