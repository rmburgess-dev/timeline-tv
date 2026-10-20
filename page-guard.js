/* page-guard.js — Chrome main-world guard.
 *
 * Firefox content scripts can reach the page's JavaScript view of a DOM node through
 * wrappedJSObject and replace pause()/load()/remove() on it. Chrome content scripts run in an
 * isolated world with separate wrappers, so the page would never see those replacements.
 * Chrome's fix is a content script in the MAIN world: this file, injected at document_start.
 *
 * It wraps the page's own prototype methods and asks one question on every call: is this
 * element marked as a player the overlay is showing? The isolated content script sets
 * data-tt-player while the element is mounted and removes it when the player is handed back.
 * Calls for every other element go straight through to the original implementation.
 *
 * This file is packaged for Chrome only. Firefox uses the wrappedJSObject guard in content.js.
 */
(() => {
  'use strict'

  const FLAG = 'ttGuardBridge'
  const MARKER = 'data-tt-player'

  if (window.__timelineTvGuardInstalled) return

  const mark = () => {
    try {
      if (document.documentElement) document.documentElement.dataset[FLAG] = '1'
    } catch {
      /* ignore: the content script will fall back to the keep-alive */
    }
  }
  mark()
  if (!document.documentElement) {
    document.addEventListener('DOMContentLoaded', mark, { once: true })
  }

  const media = HTMLMediaElement.prototype
  const element = Element.prototype
  const node = Node.prototype
  const nativePause = media.pause
  const nativeLoad = media.load
  const nativeRemove = element.remove
  const nativeRemoveChild = node.removeChild
  const marked = (candidate) => Boolean(candidate?.hasAttribute?.(MARKER))

  media.pause = function pause(...args) {
    if (marked(this)) return
    return nativePause.apply(this, args)
  }
  media.load = function load(...args) {
    if (marked(this)) return
    return nativeLoad.apply(this, args)
  }
  element.remove = function remove(...args) {
    if (marked(this)) return
    return nativeRemove.apply(this, args)
  }
  node.removeChild = function removeChild(child, ...args) {
    // The DOM contract says removeChild returns the removed node. Blocking the removal while
    // keeping that contract means page code that chains on the return value does not throw.
    if (marked(child)) return child
    return nativeRemoveChild.call(this, child, ...args)
  }

  window.__timelineTvGuardInstalled = true
})()
