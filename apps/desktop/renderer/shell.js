/** Connection selection only; the Host serves the authenticated business application. */
const desktop = window.harniverseDesktop
const status = document.getElementById('status')
const local = document.getElementById('local')
const url = document.getElementById('host-url')
const connect = document.getElementById('connect')
const disconnect = document.getElementById('disconnect')
let busy = false

async function refresh() {
  const state = await desktop.state()
  const attached = state.profile !== undefined
  local.disabled = busy || attached
  url.disabled = busy || attached
  connect.disabled = busy || attached
  disconnect.disabled = busy || !attached
  status.textContent = state.message ?? (attached
    ? `${state.phase === 'connecting' ? 'Connecting to' : 'Connected to'} ${state.ownership === 'owned' ? 'the local Host' : state.profile.url}.`
    : 'No Host is connected.')
}

async function run(action) {
  if (busy) return
  busy = true
  local.disabled = url.disabled = connect.disabled = disconnect.disabled = true
  status.textContent = 'Working…'
  let failure
  try { await action() } catch (error) { failure = error instanceof Error ? error.message : 'The operation failed.' }
  finally {
    busy = false
    await refresh()
    if (failure !== undefined) status.textContent = failure
  }
}

if (desktop === undefined) {
  status.textContent = 'The desktop bridge is unavailable. Reopen dsh-harniverse.'
} else {
  local.addEventListener('click', () => { void run(() => desktop.connect({ kind: 'local' })) })
  document.getElementById('existing').addEventListener('submit', event => {
    event.preventDefault()
    void run(() => desktop.connect({ kind: 'existingHost', url: url.value }))
  })
  disconnect.addEventListener('click', () => { void run(() => desktop.disconnect()) })
  document.getElementById('quit').addEventListener('click', () => { void desktop.quit() })
  void refresh().catch(() => { status.textContent = 'Connection status is unavailable. Use the application menu to quit.' })
}
