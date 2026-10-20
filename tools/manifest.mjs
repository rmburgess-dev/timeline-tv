// manifest.mjs — the Firefox manifest and the Chrome transform in one place.
//
// The two browsers share almost everything, but their MV3 background declarations are
// different: Firefox runs an event page from background.scripts, while Chrome requires a
// service worker. Chrome also needs a MAIN-world content script for the page guard, because
// its content scripts cannot touch the page's JavaScript wrappers the way Firefox's can.
//
// tools/package.mjs uses these functions to build both archives; tools/test.mjs uses them to
// check that neither target references a file the other one drops.

import fs from 'node:fs'
import path from 'node:path'

/** Chrome's MAIN-world content_scripts support shipped in Chrome 111. */
export const CHROME_MIN_VERSION = '111'

/**
 * The Chrome manifest for a given Firefox manifest.
 *
 * `activeTab` is added because the popup and the keyboard command both act on the tab the
 * user just invoked the extension on; it lets tabs.sendMessage reach the content script
 * without asking for standing host permissions on every x.com page.
 */
export function chromeManifest(base) {
  const chrome = JSON.parse(JSON.stringify(base))
  delete chrome.browser_specific_settings
  delete chrome.author
  if (chrome.action) delete chrome.action.default_area

  chrome.minimum_chrome_version = CHROME_MIN_VERSION
  chrome.permissions = [...new Set([...(base.permissions ?? []), 'activeTab'])]
  chrome.background = { service_worker: 'background.js' }

  const matches = (base.content_scripts ?? []).flatMap((script) => script.matches ?? [])
  chrome.content_scripts = [
    {
      matches,
      js: ['content.js'],
      run_at: 'document_idle'
    },
    {
      matches,
      // Chrome runs this in the page's own JavaScript world. content.js runs in the isolated
      // world and marks the elements the overlay is showing; page-guard.js blocks the page's
      // pause()/load()/remove() for exactly those elements.
      js: ['page-guard.js'],
      run_at: 'document_start',
      world: 'MAIN'
    }
  ]
  return chrome
}

export function readFirefoxManifest(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'))
}
