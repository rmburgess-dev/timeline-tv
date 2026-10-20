/* popup.js - options UI and the start/stop control.
 *
 * Two details worth keeping:
 *   - tabs.sendMessage rejects when no content script is listening, so the
 *     "not on x.com" case is just a caught rejection rather than a lastError probe.
 *   - storage.sync can be unavailable (private window, sync disabled). Options are
 *     treated as best-effort: the popup still sends the live values to the content
 *     script, so the slideshow behaves correctly even if nothing was persisted.
 */
'use strict'

const api = globalThis.browser ?? globalThis.chrome

const DEFAULTS = { includeImages: false, imageSeconds: 3, columns: 3 }

// Above three streams at once, most GPUs run out of concurrent decode sessions and fall back
// to software decoding - which is the one thing no add-on code can fix. The popup says so once
// the choice is made, instead of leaving it to be discovered as stutter.
const BUSY_COLUMNS = 3

const ui = {
  toggle: document.getElementById('toggle'),
  columns: document.getElementById('columns'),
  columnHint: document.getElementById('columnHint'),
  includeImages: document.getElementById('includeImages'),
  imageSeconds: document.getElementById('imageSeconds'),
  secondsRow: document.getElementById('secondsRow'),
  version: document.getElementById('version'),
  status: document.getElementById('status')
}

/** The version this popup was loaded from - i.e. the add-on that is actually installed. */
function ownVersion() {
  try {
    return api.runtime?.getManifest?.()?.version ?? ''
  } catch {
    return ''
  }
}

function setStatus(message, isError = false) {
  ui.status.textContent = message
  ui.status.classList.toggle('error', isError)
}

function syncSecondsVisibility() {
  ui.secondsRow.hidden = !ui.includeImages.checked
}

function syncColumnHint() {
  if (ui.columnHint) ui.columnHint.hidden = Number(ui.columns.value) <= BUSY_COLUMNS
}

function readForm() {
  return {
    columns: Number(ui.columns.value) || 1,
    includeImages: ui.includeImages.checked,
    imageSeconds: Number(ui.imageSeconds.value) || DEFAULTS.imageSeconds
  }
}

function paintToggle(active) {
  ui.toggle.textContent = active ? 'Stop slideshow' : 'Start slideshow'
  ui.toggle.classList.toggle('stop', Boolean(active))
}

async function loadOptions() {
  let stored = DEFAULTS
  try {
    stored = await api.storage.sync.get(DEFAULTS)
  } catch {
    // fall back to defaults; the form still works for this session
  }
  ui.columns.value = String(stored.columns || DEFAULTS.columns)
  ui.includeImages.checked = Boolean(stored.includeImages)
  ui.imageSeconds.value = String(stored.imageSeconds || DEFAULTS.imageSeconds)
  syncSecondsVisibility()
  syncColumnHint()
}

async function saveOptions() {
  try {
    await api.storage.sync.set(readForm())
  } catch {
    setStatus('Settings could not be saved, but they will still apply now.')
  }
}

async function activeTab() {
  const tabs = await api.tabs.query({ active: true, currentWindow: true })
  const tab = tabs?.[0]
  if (!tab?.id) throw new Error('No active tab.')
  return tab
}

async function send(type) {
  const tab = await activeTab()
  return api.tabs.sendMessage(tab.id, { type, options: readForm() })
}

async function refreshState() {
  try {
    const state = await send('tt:state')
    paintToggle(state?.active)
    // A content script is injected once per page load and never hot-reloads, so after an
    // update every open tab keeps running the previous code - which looks exactly like a fix
    // that did not work. Say it plainly instead of letting it be discovered.
    const tabVersion = state?.version || ''
    const stale = Boolean(tabVersion) && Boolean(ownVersion()) && tabVersion !== ownVersion()
    if (state?.active) {
      const columns = Number(state.columns) || 1
      setStatus(
        state.count
          ? `Running ${columns} column${columns === 1 ? '' : 's'} over ${state.count} item${state.count === 1 ? '' : 's'}.`
          : 'Slideshow running.'
      )
    }
    if (stale) {
      setStatus(`This tab is still running ${tabVersion}; reload it to finish updating to ${ownVersion()}.`, true)
    }
  } catch {
    paintToggle(false)
    setStatus('Open x.com (or twitter.com) in this tab to start.', true)
  }
}

ui.columns.addEventListener('change', () => {
  syncColumnHint()
  saveOptions()
})

ui.includeImages.addEventListener('change', () => {
  syncSecondsVisibility()
  saveOptions()
})

ui.imageSeconds.addEventListener('change', saveOptions)

ui.toggle.addEventListener('click', async () => {
  ui.toggle.disabled = true
  setStatus('Working…')
  try {
    const result = await send('tt:toggle')
    const active = Boolean(result?.active)
    paintToggle(active)
    setStatus(result?.message ?? (active ? 'Slideshow started.' : 'Slideshow closed.'), !result?.ok)
  } catch {
    paintToggle(false)
    setStatus('This tab is not x.com, or the page needs a reload.', true)
  } finally {
    ui.toggle.disabled = false
  }
})

function paintVersion() {
  const version = ownVersion()
  if (ui.version) ui.version.textContent = version ? `v${version}` : ''
}

loadOptions().then(() => {
  paintVersion()
  return refreshState()
})
