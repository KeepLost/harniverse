// Shared shell-fixture seam for the file-upload dep: a never-settling upload
// no spec drives, plus fixed notice strings. Specs that exercise the upload
// lifecycle build their own controllable transport inline.

import type { SessionInputDeps } from '../src/client/input/facade.ts'

/** Idle file-upload dep for shell fixtures whose specs never touch files. */
export const stubFileUploads: SessionInputDeps['fileUploads'] = {
  upload: () => new Promise(() => {}),
  errorText: () => 'upload failed',
  inFlightNotice: () => 'files are still uploading',
  unsupportedNotice: token => `${token} does not accept file attachments`,
}
