/** Connection selection only; the Host serves the authenticated business application. */
const desktop = window.harniverseDesktop
const copy = window.harniverseShellCopy
const status = document.getElementById('status')
const local = document.getElementById('local')
const url = document.getElementById('host-url')
const connect = document.getElementById('connect')
const disconnect = document.getElementById('disconnect')
let busy = false

// The preload publishes the locale-picked copy table; the English markup is
// its fallback. Placeholders ride their own attribute (textContent cannot set them).
if (copy !== undefined) {
  document.documentElement.lang = copy.htmlLang
  for (const element of document.querySelectorAll('[data-shell]')) {
    const value = copy[element.dataset.shell]
    if (typeof value === 'string') element.textContent = value
  }
  for (const element of document.querySelectorAll('[data-shell-placeholder]')) {
    const value = copy[element.dataset.shellPlaceholder]
    if (typeof value === 'string') element.setAttribute('placeholder', value)
  }
}

async function refresh() {
  const state = await desktop.state()
  const attached = state.profile !== undefined
  local.disabled = busy || attached
  url.disabled = busy || attached
  connect.disabled = busy || attached
  disconnect.disabled = busy || !attached
  status.textContent = state.message ?? (attached
    ? (state.phase === 'connecting' ? copy.connectingTo : copy.connectedTo)
        .replace('{target}', state.ownership === 'owned' ? copy.localHostTarget : state.profile.url)
    : copy.noHost)
}

async function run(action) {
  if (busy) return
  busy = true
  local.disabled = url.disabled = connect.disabled = disconnect.disabled = true
  status.textContent = copy.working
  let failure
  try { await action() } catch (error) { failure = error instanceof Error ? error.message : copy.operationFailed }
  finally {
    busy = false
    await refresh()
    if (failure !== undefined) status.textContent = failure
  }
}

if (desktop === undefined) {
  // The preload itself did not run, so no picked copy exists either.
  status.textContent = 'The desktop bridge is unavailable. Reopen dsh-harniverse.'
} else {
  local.addEventListener('click', () => { void run(() => desktop.connect({ kind: 'local' })) })
  document.getElementById('existing').addEventListener('submit', event => {
    event.preventDefault()
    void run(() => desktop.connect({ kind: 'existingHost', url: url.value }))
  })
  disconnect.addEventListener('click', () => { void run(() => desktop.disconnect()) })
  document.getElementById('quit').addEventListener('click', () => { void desktop.quit() })
  void refresh().catch(() => { status.textContent = copy.statusUnavailable })
}
