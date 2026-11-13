/**
 * The pinned asset release: one GitHub Release holds the built kernel,
 * initramfs, and host wrapper next to an `assets-manifest.sha256` in
 * `sha256sum` format. This module pins WHERE it lives and WHAT its manifest
 * must hash to; `ensureAssets` enforces the chain.
 * @module @deepseek-ai/dsh-vm-qemu-local
 */

/** Environment variable overriding the release base URL; blank disables downloading. */
export const ASSETS_URL_ENV = 'DSH_VM_ASSETS_URL'
/** Filename of the `sha256sum`-format manifest inside the release. */
export const ASSETS_MANIFEST_NAME = 'assets-manifest.sha256'
/** Base URL of the pinned asset release; bumps together with {@link ASSETS_MANIFEST_SHA256}. */
export const ASSETS_RELEASE_BASE_URL = 'https://github.com/KeepLost/harniverse/releases/download/vm-assets-v1/'
/** SHA-256 of the pinned release's manifest bytes; bumps together with {@link ASSETS_RELEASE_BASE_URL}. */
export const ASSETS_MANIFEST_SHA256 = 'd33d990585c82282a42e6c1d7daa218f0eb47c34dcac215e26949e7b28021309'
