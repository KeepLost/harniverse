import { useEffect, useState } from 'react'
import type { MachineTargetSource } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconGlobeOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './target-locales.ts'
import css from './MachineTarget.module.css'

/** The sidebar's machine identity and unconditional return action. */
export type MachineTargetInjected = {
  hooks: { machine: MachineTargetSource }
  nameOf: (id: string) => Promise<string | undefined>
  returnToHost: () => void | Promise<void>
}
export type MachineTargetProps = PropsRuntime<'sidebar.workspaces.machine'> & PropsLocale<typeof NS> & InjectFace<MachineTargetInjected>

export function MachineTarget({ wide, useMachine, nameOf, returnToHost, t }: MachineTargetProps) {
  const machine = useMachine(value => value)
  const [name, setName] = useState<{ id: string; value: string | undefined }>()
  useEffect(() => {
    if (machine.kind !== 'remote') return
    let active = true
    void nameOf(machine.id).then(
      (label) => { if (active) setName({ id: machine.id, value: label }) },
      () => { if (active) setName(undefined) },
    )
    return () => { active = false }
  }, [machine, nameOf])
  const label = machine.kind === 'host' ? t('host') : (name?.id === machine.id ? name.value : undefined) ?? machine.id
  const returnHost = (): void => {
    void Promise.resolve(returnToHost()).catch((error: unknown) => { console.error('machine return failed:', error) })
  }
  return <div className={css.root} aria-label={t('machine')}>
    <span className={css.icon} title={label}><IconGlobeOutline14 size={16} /></span>
    {wide && <span className={css.details}><span className={css.caption}>{t('machine')}</span><span className={css.name} title={label}>{label}</span></span>}
    {machine.kind === 'remote' && <button type="button" className={css.return} onClick={returnHost} title={t('returnHost')} aria-label={t('returnHost')}>
      <span aria-hidden="true">←</span>
      {wide && <span>{t('host')}</span>}
    </button>}
  </div>
}
