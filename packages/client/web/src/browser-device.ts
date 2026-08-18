/** Browser-held non-exportable device key and IndexedDB persistence. */

export interface BrowserDevice {
  name: string
  kind: 'device' | 'temporary'
  privateKey: CryptoKey
  enrollmentId?: string
  grantId?: string
}

function base64url(bytes: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

/**
 * Generate one P-256 key pair with a non-exportable private key.
 * @returns the browser-held private key and base64url SPKI public key.
 */
export async function generateBrowserDeviceKey(): Promise<{ privateKey: CryptoKey; publicKey: string }> {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  )
  return {
    privateKey: pair.privateKey,
    publicKey: base64url(await crypto.subtle.exportKey('spki', pair.publicKey)),
  }
}

/**
 * Sign the exact UTF-8 challenge payload as IEEE-P1363 ECDSA bytes.
 * @param privateKey - non-exportable P-256 signing key.
 * @param payload - exact Provider challenge payload.
 * @returns the base64url IEEE-P1363 signature.
 */
export async function signBrowserChallenge(privateKey: CryptoKey, payload: string): Promise<string> {
  return base64url(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(payload),
  ))
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('dsh-authentication', 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('devices')) request.result.createObjectStore('devices')
    }
    request.onsuccess = () => { resolve(request.result) }
    request.onerror = () => { reject(request.error ?? new Error('IndexedDB unavailable')) }
  })
}

/**
 * Read the one trusted personal-device record, when present.
 * @returns the persisted device or `undefined` before enrollment.
 */
export async function readBrowserDevice(): Promise<BrowserDevice | undefined> {
  const db = await database()
  try {
    return await new Promise((resolve, reject) => {
      const request = db.transaction('devices').objectStore('devices').get('primary')
      request.onsuccess = () => { resolve(request.result as BrowserDevice | undefined) }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB read failed')) }
    })
  } finally {
    db.close()
  }
}

/**
 * Persist one trusted personal-device key and its enrollment state.
 * @param device - trusted personal-device record.
 */
export async function writeBrowserDevice(device: BrowserDevice): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction('devices', 'readwrite').objectStore('devices').put(device, 'primary')
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB write failed')) }
    })
  } finally {
    db.close()
  }
}

/** Remove a revoked or unusable personal-device key. */
export async function clearBrowserDevice(): Promise<void> {
  const db = await database()
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction('devices', 'readwrite').objectStore('devices').delete('primary')
      request.onsuccess = () => { resolve() }
      request.onerror = () => { reject(request.error ?? new Error('IndexedDB delete failed')) }
    })
  } finally {
    db.close()
  }
}
