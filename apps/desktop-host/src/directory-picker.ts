/** Native directory-picker Provider; the owned parent renders and settles the dialog. */
import { Service, type Context } from '@deepseek-ai/cordis'
import DirectoryPicker, { type DirectoryPickerNativeCapability } from '@deepseek-ai/dsh-host-directory-picker'

declare module '@deepseek-ai/cordis' {
  interface Context { desktopShell: CallbackDesktopShell }
}

/** Callback Provider installed by the private process entry. */
export class CallbackDesktopShell extends Service {
  constructor(ctx: Context, private callback: (signal: AbortSignal) => Promise<string | null>) { super(ctx, 'desktopShell') }
  pickDirectory(signal: AbortSignal): Promise<string | null> { return this.callback(signal) }
}

/** Existing directory-picker Definition remains the business-facing capability. */
export default class DesktopDirectoryPicker extends DirectoryPicker {
  static inject = ['desktopShell']
  private readonly native: DirectoryPickerNativeCapability
  constructor(ctx: Context) {
    super(ctx)
    const lifetime = new AbortController()
    ctx.effect(() => () => { lifetime.abort(new Error('Desktop directory picker disposed.')) })
    this.native = { kind: 'native', pick: signal => ctx.desktopShell.pickDirectory(AbortSignal.any([signal, lifetime.signal])) }
  }
  override capability(): DirectoryPickerNativeCapability { return this.native }
}
