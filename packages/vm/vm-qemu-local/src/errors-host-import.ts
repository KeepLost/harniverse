/**
 * Errors of the boot-time host workspace import.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

/** Raised when the host workspace exceeds the import bound; names both sizes and the remedies. */
export class HostWorkspaceTooLargeError extends Error {
  /** The host directory that was walked. */
  readonly root: string
  /** The summed file bytes observed when the bound tripped. */
  readonly bytes: number
  /** The bound that tripped. */
  readonly maxBytes: number

  constructor(root: string, bytes: number, maxBytes: number) {
    super(
      `vm-qemu-local: the host workspace ${root} carries ${bytes} bytes, over the ${maxBytes}-byte import bound; `
        + 'raise $DSH_VM_IMPORT_MAX_BYTES (or the provider\'s workspaceImport.maxBytes), or compose the local family',
    )
    this.name = 'HostWorkspaceTooLargeError'
    this.root = root
    this.bytes = bytes
    this.maxBytes = maxBytes
  }
}
