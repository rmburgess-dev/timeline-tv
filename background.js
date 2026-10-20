/* background.js - the add-on's only background work.
 *
 * Exists so the keyboard command can drive the content script. Keeping it this
 * small means MV3 event-page semantics are trivial: no timers, no retained state,
 * nothing to lose when the page is suspended.
 */
'use strict'

const api = globalThis.browser ?? globalThis.chrome

api.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-slideshow') return
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) return
    await api.tabs.sendMessage(tab.id, { type: 'tt:toggle' })
  } catch {
    // No content script on this tab (not x.com, or the page predates the install).
  }
})
