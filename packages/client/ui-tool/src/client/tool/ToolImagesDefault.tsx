/** Shipped occupant of the details result-image seat: the model-side gallery. */
import type { ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolImagesOwnerProps } from '../contract/slots.ts'
import { ToolResultImages } from './components/ToolResultImages.tsx'

/** Render the shared model-side result gallery over the owner share. */
export function ToolImagesDefault(
  { images, load, t }: ToolImagesOwnerProps & { t: TranslateNS<'conversation'> },
): ReactNode {
  return <ToolResultImages images={images} loadModelImage={load} t={t} />
}
