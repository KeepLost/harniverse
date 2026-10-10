/**
 * The shell backdrop contribution: the user's wallpaper (blurred, under a
 * legibility veil) or, without one, the active skin's own gradient. It renders
 * nothing when neither applies — including whenever the operating system asks
 * for opaque rendering, in which case the view reports no backdrop at all.
 * The wallpaper's object URL is held for exactly as long as the layer is
 * mounted on that wallpaper.
 */
import type { CSSProperties } from 'react'
import type { SkinBackground } from '@deepseek-ai/dsh-api-remotes/client'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkinHooks } from './faces.ts'
import { gradientCss } from './gradient.ts'
import { assertNever } from './never.ts'
import { useWallpaperUrl } from './useWallpaperUrl.ts'
import css from './Backdrop.module.css'

/** Injected business face of the backdrop. */
export interface BackdropInjected {
  hooks: SkinHooks
  /** Take a reference on a wallpaper's object URL. */
  acquireWallpaper: (hash: string) => Promise<string | undefined>
  /** Drop a reference taken by `acquireWallpaper`. */
  releaseWallpaper: (hash: string) => void
}

/** Full component props. */
export type BackdropProps = PropsRuntime<'shell.backdrop'> & InjectFace<BackdropInjected>

/** The wallpaper layer: image under blur, then the veil. */
function WallpaperLayer(props: {
  hash: string
  blur: number
  acquire: BackdropInjected['acquireWallpaper']
  release: BackdropInjected['releaseWallpaper']
}) {
  const url = useWallpaperUrl(props.hash, props.acquire, props.release)
  const style = { '--dsh-skin-blur': `${String(props.blur)}px`, ...url === undefined ? {} : { '--dsh-skin-image': `url("${url}")` } }
  return (
    <div className={css.backdrop} style={style as CSSProperties} data-backdrop="wallpaper">
      {url === undefined ? null : <div className={css.image} />}
      <div className={css.veil} />
    </div>
  )
}

/** The gradient layer of a skin that ships its own background. */
function GradientLayer({ background }: { background: SkinBackground }) {
  const image = gradientCss(background)
  return (
    <div className={css.backdrop} style={{ '--dsh-skin-image': image } as CSSProperties} data-backdrop="gradient">
      <div className={css.image} />
    </div>
  )
}

/**
 * Render the backdrop.
 * @param props - composed slot props.
 * @returns the layer element, or null when nothing paints behind the frame.
 */
export function Backdrop({ useSkin, acquireWallpaper, releaseWallpaper }: BackdropProps) {
  const backdrop = useSkin(view => view.backdrop)
  switch (backdrop.kind) {
    case 'wallpaper':
      return <WallpaperLayer hash={backdrop.hash} blur={backdrop.blur} acquire={acquireWallpaper} release={releaseWallpaper} />
    case 'gradient': return <GradientLayer background={backdrop.background} />
    case 'none': return null
    /* v8 ignore next -- closed backdrop union */
    default: return assertNever(backdrop)
  }
}
