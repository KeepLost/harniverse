/**
 * The browser-notification half of an alert: the platform permission
 * lifecycle plus the system toast. Sounds ride the notification — an
 * unsupported or denied Notifications API silences the whole alert, and a
 * visible focused tab suppresses the toast while the sound still plays.
 */

/** One platform permission state. */
export type NotificationPermissionState = 'default' | 'granted' | 'denied'

/** Structural face over the platform Notification API (feature-detected). */
export interface NotificationFace {
  /** The settled permission without prompting. */
  permission(): NotificationPermissionState
  /** Ask the user; resolves the new state and never rejects. */
  request(): Promise<NotificationPermissionState>
  /** Present one system toast; `onActivate` runs when the user opens it. */
  show(title: string, body: string, onActivate: () => void): void
}

/** Constructor-injectable capabilities. */
export interface SoundNotifierDeps {
  /** Platform notifications; undefined support mutes the whole alert. */
  readonly notifications: NotificationFace | undefined
  /** True while this tab is visible and focused (a toast would be redundant). */
  readonly alertable: () => boolean
}

/** One alert handed to the notifier. */
export interface SoundAlertRequest {
  /** Toast title (the localized event label). */
  readonly title: string
  /** Toast body (the session's display title; may be empty). */
  readonly body: string
  /** Runs when the user activates the toast. */
  readonly onActivate: () => void
  /** Plays the alert sound once permission is granted. */
  readonly ring: () => void
}

/**
 * One tab's notification gate and toast presenter.
 */
export class SoundNotifier {
  private pending: Promise<NotificationPermissionState> | undefined

  /**
   * @param deps - the platform notification face and the focused-tab probe.
   */
  constructor(private readonly deps: SoundNotifierDeps) {}

  /**
   * Deliver one alert: gate the whole alert on the platform permission,
   * ring, then present the toast unless this tab is being looked at.
   *
   * @param request - the alert's copy, activation, and sound.
   */
  alert(request: SoundAlertRequest): void {
    const face = this.deps.notifications
    if (face === undefined) return
    void this.permission(face).then((state) => {
      if (state !== 'granted') return
      request.ring()
      if (this.deps.alertable()) return
      face.show(request.title, request.body, request.onActivate)
    })
  }

  /**
   * Resolve the permission state, sharing one in-flight prompt across
   * concurrent alerts.
   *
   * @param face - the platform notification face.
   * @returns the settled permission state; a rejected prompt reads as denied.
   */
  private permission(face: NotificationFace): Promise<NotificationPermissionState> {
    const settled = face.permission()
    if (settled !== 'default') return Promise.resolve(settled)
    this.pending ??= face.request()
      .catch(() => 'denied' as const)
      .finally(() => { this.pending = undefined })
    return this.pending
  }
}
