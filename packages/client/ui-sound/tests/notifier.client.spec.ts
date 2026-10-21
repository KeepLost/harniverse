/**
 * The notification half of an alert: the platform permission lifecycle and
 * the system toast. Sounds ride the notification — unsupported or denied
 * Notifications silence the whole alert, and a visible focused tab
 * suppresses the toast while the sound still plays.
 */

import { describe, expect, it, vi } from 'vitest'
import { SoundNotifier, type NotificationFace, type NotificationPermissionState, type SoundAlertRequest } from '../src/client/notifier.ts'

/** Build one face double recording every call. */
function face(state: NotificationPermissionState, granted?: NotificationPermissionState): {
  face: NotificationFace
  requests: () => number
  shown: Array<{ title: string; body: string; onActivate: () => void }>
} {
  const state_ = { requests: 0, shown: [] as Array<{ title: string; body: string; onActivate: () => void }> }
  let permission = state
  return {
    face: {
      permission: () => permission,
      request: () => {
        state_.requests += 1
        const next = granted ?? 'granted'
        permission = next
        return Promise.resolve(next)
      },
      show: (title, body, onActivate) => { state_.shown.push({ title, body, onActivate }) },
    },
    requests: () => state_.requests,
    shown: state_.shown,
  }
}

/** One settled microtask turn so alert continuations run. */
const settle = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }

/** Build a minimal alert request recording ring invocations. */
function request(overrides: Partial<SoundAlertRequest> = {}): SoundAlertRequest & {
  rang: () => number
  presented: () => number
} {
  const state = { rang: 0, presented: 0 }
  return Object.assign({
    title: '任务完成',
    body: 'Refactor the parser',
    onActivate: vi.fn(),
    ring: () => { state.rang += 1 },
    arbitrate: (present: () => void) => { state.presented += 1; present() },
    ...overrides,
  }, { rang: () => state.rang, presented: () => state.presented })
}

describe('SoundNotifier', () => {
  it('stays fully silent without platform notifications', async () => {
    const notifier = new SoundNotifier({ notifications: undefined, alertable: () => false })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(alert.rang()).toBe(0)
    expect(alert.presented()).toBe(0)
  })

  it('rings and shows the toast once permission is already granted', async () => {
    const double = face('granted')
    const notifier = new SoundNotifier({ notifications: double.face, alertable: () => false })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(alert.rang()).toBe(1)
    expect(double.shown).toHaveLength(1)
    expect(double.shown[0]!.title).toBe('任务完成')
    expect(double.shown[0]!.body).toBe('Refactor the parser')
    double.shown[0]!.onActivate()
    expect(alert.onActivate).toHaveBeenCalled()
  })

  it('rings but suppresses the toast while the tab is visible and focused', async () => {
    const double = face('granted')
    const notifier = new SoundNotifier({ notifications: double.face, alertable: () => true })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(alert.rang()).toBe(1)
    expect(double.shown).toHaveLength(0)
  })

  it('stays silent on a settled denial without asking again', async () => {
    const double = face('denied')
    const notifier = new SoundNotifier({ notifications: double.face, alertable: () => false })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(alert.rang()).toBe(0)
    expect(double.shown).toHaveLength(0)
  })

  it('asks once on default, then rings and toasts after the grant', async () => {
    const double = face('default')
    const notifier = new SoundNotifier({ notifications: double.face, alertable: () => false })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(double.requests()).toBe(1)
    expect(alert.rang()).toBe(1)
    expect(double.shown).toHaveLength(1)
  })

  it('treats a rejected permission request as a denial', async () => {
    let requests = 0
    const double: NotificationFace = {
      permission: () => 'default',
      request: () => {
        requests += 1
        return Promise.reject(new Error('no gesture'))
      },
      show: () => { /* never reached */ },
    }
    const notifier = new SoundNotifier({ notifications: double, alertable: () => false })
    const alert = request()
    notifier.alert(alert)
    await settle()
    expect(requests).toBe(1)
    expect(alert.rang()).toBe(0)
    expect(alert.presented()).toBe(0)
  })

  it('shares one in-flight request across concurrent alerts', async () => {
    let release: ((state: NotificationPermissionState) => void) | undefined
    const double: NotificationFace = {
      permission: () => 'default',
      request: () => new Promise((resolve) => { release = resolve }),
      show: () => { /* recorded below */ },
    }
    const shown: number[] = []
    const notifier = new SoundNotifier({
      notifications: { ...double, show: () => { shown.push(1) } },
      alertable: () => false,
    })
    const first = request()
    const second = request()
    notifier.alert(first)
    notifier.alert(second)
    await settle()
    release?.('granted')
    await settle()
    expect(first.rang()).toBe(1)
    expect(second.rang()).toBe(1)
    expect(shown).toHaveLength(2)
  })

  it('presents the toast through the request arbitration', async () => {
    const double = face('granted')
    const notifier = new SoundNotifier({ notifications: double.face, alertable: () => false })
    const arbitrate = vi.fn((present: () => void) => { present() })
    const alert = request({ arbitrate })
    notifier.alert(alert)
    await settle()
    expect(arbitrate).toHaveBeenCalledTimes(1)
    expect(double.shown).toHaveLength(1)
  })
})
