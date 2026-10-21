/*!
 * Timeline TV — content script
 *
 * Plays the videos (and optionally the images) already present in the X/Twitter
 * timeline as a full-window slideshow, in one to N simultaneous columns.
 *
 * Independent implementation. Architectural notes:
 *
 *   - The overlay lives in a Shadow DOM styled by a constructable stylesheet, so no
 *     CSS is injected into the page and the site's style-src policy is irrelevant.
 *   - Media is played from the page's own <video> element, which is MOVED into a
 *     tile and moved back to its exact original position afterwards. X serves video
 *     via MSE and blob: URLs, so re-loading the URL in a fresh element would not work.
 *   - A Lane owns one column: its mounted element, its history, its timers, and its
 *     own mute state. Every lane restores independently; teardown restores all.
 *   - Columns play independently and pull the next item from one shared queue when
 *     they finish, so several videos run at once.
 *   - Audio is per column. Every column can be muted individually, and the bar has a
 *     master mute. Playback starts silent because Firefox only allows audible
 *     autoplay after a gesture inside the page, so unmuting is an explicit click.
 *   - X pauses players it does not consider primary, so a column plays in a player the page
 *     cannot reach: either an element of our own, or X's own element with a pause()/load()
 *     guard installed in the PAGE's compartment. A guard written from the content script
 *     cannot work - a DOM node has one JavaScript reflection per compartment and Xray vision
 *     keeps the two apart - which is why the guard is installed through wrappedJSObject and
 *     then proved from the page's side. The keep-alive is the last line of defence.
 *
 * Runs as an IIFE: no globals are added to the page.
 */
(() => {
  'use strict'

  const api = globalThis.browser ?? globalThis.chrome

  const HOST_ID = 'timeline-tv-host'
  // The widest grid the overlay lays out. The popup offers exactly this many choices, and the
  // suite fails if the two ever drift apart, so the cap is one number in two places.
  const MAX_COLUMNS = 8
  const DEFAULTS = { includeImages: false, imageSeconds: 3, columns: 3 }
  const SKIP_LIMIT = 6
// How often a paused-but-should-be-playing column may be resumed. Frequent enough to
// keep several tiles alive, slow enough that it never becomes a play/pause storm.
const RESUME_INTERVAL_MS = 250
// A paused clip is NEVER skipped for taking too long - a slow buffer must not cost the
// viewer the rest of the video. The one time-based escape is an element that has lost its
// media entirely (readyState 0 = it holds no data), which cannot recover by waiting.
const DEAD_ADVANCE_MS = 20000
// How many times in a row a column may try to pick a clip back up after the page removed
// its player. A page that replaces players continuously must not become an endless mount.
const REROUTE_LIMIT = 3
// How close to the end of its own duration counts as "this clip is over".
//
// `ended` alone is not enough. X's player pauses a clip a fraction before its end and shows its
// own replay button, so on those players `ended` never becomes true - and because the add-on
// only ever advanced on `ended`, that column sat on the last frame of video 60 while the queue
// ran on to 92. Position is the honest signal, and 200ms of slack is cheaper than a dead tile.
const CLIP_END_SLACK_S = 0.2
// A column that already has data but has not moved for this long will not start on its own:
// one more play() first, then it takes the next clip. Deliberately measured from readyState
// HAVE_FUTURE_DATA so a column that is merely buffering keeps its clip, however slow it is.
const STALL_NUDGE_MS = 4000
// How long a player that has the data may sit still before the column gives up on it. Long
// enough that a slow decoder, a backgrounded tab or a network hiccup cannot cost the rest of a
// clip; only a player that has genuinely stopped is stepped over.
const STALL_ADVANCE_MS = 30000
// An empty column asks the queue again this often. Refilling used to depend on the page
// mutating the DOM, so a column could sit empty with ninety items still queued behind it.
const IDLE_PULL_MS = 1000
// Optimistic discovery: while columns are still empty the add-on scrolls looking for more clips,
// at most this often, and stops after this many rounds that find nothing. An optimistic search
// must not become a page that scrolls forever underneath a grid it cannot fill. The cadence is
// deliberately gentle: scrolling moves the timeline under clips that are already playing, so a
// round is three screens rather than a burst, and four empty rounds are needed before the end
// note is believable.
const TOPUP_INTERVAL_MS = 3500
const TOPUP_SCROLLS = 3
const TOPUP_DRY_ROUNDS = 4
// How long a finished clip keeps its last frame while the next one is looked for.
//
// Emptying the tile the moment a clip ended made every normal advance flash "No more videos"
// while the next clip was still being fetched, and made a single drained queue look like the
// end of the timeline even though the search was still running. The finished player is paused
// in place instead; it is only taken down when a replacement is mounted, or after this long
// with the queue drained and every search exhausted.
const NO_MORE_GRACE_MS = 12000
// A borrowed player can arrive already parked at the end of the timeline's own playback.
// The seek to zero is best-effort, so do not retire a just-mounted clip before giving that
// state a moment to clear. This is deliberately short: a stale end that cannot be recovered
// should still give the column its next clip rather than freeze it forever.
const MOUNT_END_GUARD_MS = 2000
// How far apart two columns may start a player.
//
// Starting eight players in one tick means eight media pipelines, eight decoders and eight sets
// of segment requests arriving together - the first columns stutter while the last are still
// initialising, and the wall takes longer to appear than if the columns were started a beat
// apart. Mounting is therefore serialised: one column per MOUNT_STAGGER_MS, for the initial
// fill and for several columns finishing at the same moment. A clip ending on its own is never
// delayed by it, because the gate only compares against the last player that actually started.
const MOUNT_STAGGER_MS = 1000

  // ------------------------------------------------------------------ utils ---

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n)

  /** Parse a computed rgb()/rgba()/hex colour into [r, g, b, a], or null. */
  function parseColor(value) {
    if (!value) return null
    const rgb = /^rgba?\(([^)]+)\)$/i.exec(String(value).trim())
    if (rgb) {
      const parts = rgb[1].split(',').map((part) => parseFloat(part))
      if (parts.length < 3 || parts.some((part) => !Number.isFinite(part))) return null
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1]
    }
    const hex = /^#([0-9a-f]{3,8})$/i.exec(String(value).trim())
    if (!hex) return null
    const digits = hex[1]
    if (digits.length === 3 || digits.length === 4) {
      return [
        parseInt(digits[0] + digits[0], 16),
        parseInt(digits[1] + digits[1], 16),
        parseInt(digits[2] + digits[2], 16),
        digits.length === 4 ? parseInt(digits[3] + digits[3], 16) / 255 : 1
      ]
    }
    if (digits.length === 6 || digits.length === 8) {
      return [
        parseInt(digits.slice(0, 2), 16),
        parseInt(digits.slice(2, 4), 16),
        parseInt(digits.slice(4, 6), 16),
        digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1
      ]
    }
    return null
  }

  function visibleColor(value) {
    const color = parseColor(value)
    return Boolean(color && color[3] > 0.05)
  }

  /** Rough perceived brightness, used only to choose light or dark form controls. */
  function colorIsLight(value) {
    const color = parseColor(value)
    if (!color) return false
    return (0.2126 * color[0] + 0.7152 * color[1] + 0.0722 * color[2]) / 255 > 0.55
  }

  function setHostVar(host, name, value) {
    try {
      if (value) host.style.setProperty(name, value)
      else if (typeof host.style.removeProperty === 'function') host.style.removeProperty(name)
    } catch {
      /* a host that cannot take a variable keeps the CSS fallback */
    }
  }

  function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '--:--'
    const total = Math.floor(seconds)
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
  }

  function formatRate(rate) {
    return `${Number.isInteger(rate) ? rate : rate.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}x`
  }

  function tweetPermalink(article) {
    const anchor = article.querySelector('a[href*="/status/"]')
    if (!anchor) return null
    const href = anchor.getAttribute('href')
    if (!href) return null
    try {
      const url = new URL(href, location.href)
      const match = url.pathname.match(/^(\/[^/]+\/status\/\d+)/)
      return match ? match[1] : url.pathname
    } catch {
      return null
    }
  }

  // Fallback identity for an <article> when no permalink can be derived, so dedupe
  // keys never collide across different tweets.
  const articleIds = new WeakMap()
  let nextArticleId = 0
  function articleToken(article) {
    let id = articleIds.get(article)
    if (!id) {
      id = ++nextArticleId
      articleIds.set(article, id)
    }
    return id
  }

  function videoSource(video) {
    const direct = video.currentSrc || video.getAttribute('src') || ''
    if (direct) return direct
    for (const source of video.querySelectorAll('source')) {
      const src = source.getAttribute('src')
      if (src) return src
    }
    return ''
  }

  /**
   * True when a media source can be loaded into an element of our own.
   *
   * A blob: URL is an MSE handle owned by the element X created; a plain https source can be
   * played by anyone. That difference is the whole trick: playing it in our own element means
   * X holds no reference to it and cannot pause it.
   */
  function directSource(src) {
    return typeof src === 'string' && /^https:\/\//i.test(src) && !src.startsWith('blob:')
  }

  // ------------------------------------------------------------- page guard ---

  /**
   * The page's own JavaScript view of a DOM node, or null when this build exposes none.
   *
   * A DOM node has one JavaScript reflection per compartment, and Xray vision means a
   * content script always reads and writes ITS OWN reflection - never the page's. So
   * `element.pause = () => {}` set from here is invisible to the page's code, which is why
   * X could keep pausing a "guarded" column. `wrappedJSObject` is the only way to reach the
   * page's reflection, and it is therefore the only place a guard can do any good.
   */
  function pageView(node) {
    try {
      const view = node?.wrappedJSObject
      return view && typeof view === 'object' && typeof view.pause === 'function' ? view : null
    } catch {
      return null
    }
  }

  /**
   * Define a function of ours on an object in the page's scope.
   *
   * exportFunction() is the documented way to hand page code a content-script function, so
   * it is preferred; a plain assignment covers builds and objects where it does not apply.
   */
  function defineForPage(view, name, fn) {
    try {
      if (typeof exportFunction === 'function') exportFunction(fn, view, { defineAs: name })
      else view[name] = fn
      return true
    } catch {
      try {
        view[name] = fn
        return true
      } catch {
        return false
      }
    }
  }

  /**
   * Ask the page to leave the player it lent us alone: install no-op pause() and load() in
   * the page's own reflection of the element.
   *
   * X's player manager pauses players it does not consider primary, and it does so while they
   * are still buffering - which is why reacting to `pause` events could never keep three
   * columns alive. X also frees a player it is finished with by calling load(), which throws
   * away the buffer and leaves the tile frozen on one frame, and it may remove a player it is
   * virtualising away. All three are blocked for the same reason. Every blocked call is
   * counted, so the diagnostics can report whether the guard is doing any work rather than
   * whether it exists.
   */
  function installGuard(element) {
    const guard = { installed: false, verified: false, blocked: 0, view: null, restore: null }
    const view = pageView(element)
    // Chrome has isolated worlds rather than Firefox's Xray vision, so wrappedJSObject does not
    // exist there. page-guard.js runs in the page's own world and blocks the page's calls for
    // elements carrying this marker; it advertises itself on <html> at document_start.
    const bridge = document.documentElement?.dataset?.ttGuardBridge === '1'
    if (!view && bridge) {
      try {
        element.setAttribute('data-tt-player', '1')
      } catch {
        /* a host that cannot take the marker is treated as unguarded */
      }
      const marked = element.getAttribute?.('data-tt-player') === '1'
      return {
        installed: marked,
        verified: marked,
        blocked: 0,
        view: null,
        restore: null,
        bridge: true,
        element
      }
    }
    if (!view) return guard

    const blockedPause = function () {
      guard.blocked += 1
    }
    const blockedLoad = function () {
      guard.blocked += 1
    }
    const blockedRemove = function () {
      guard.blocked += 1
    }
    // X's player manager also tears a virtualised player down with remove(). If that lands on
    // the element we are showing, the tile goes dead mid-clip and the column has to skip; block
    // it for the same reason as load().
    const fields = [
      ['pause', blockedPause],
      ['load', blockedLoad],
      ['remove', blockedRemove]
    ]
    const restore = {}
    for (const [name, replacement] of fields) {
      try {
        restore[name] = {
          had: Object.prototype.hasOwnProperty.call(view, name),
          previous: view[name]
        }
      } catch {
        restore[name] = { had: false, previous: undefined }
      }
      if (!defineForPage(view, name, replacement)) {
        // All of them have to land, or none does. A partial install could never be released
        // (releaseGuard only runs for a complete install) and would leave X's player unable to
        // pause, load or remove after the overlay closed.
        for (const [installed] of fields) {
          if (installed === name) break
          const saved = restore[installed]
          restorePageField(view, installed, saved.had, saved.previous)
        }
        return guard
      }
    }

    guard.installed = true
    guard.view = view
    guard.restore = restore
    return guard
  }

  /** Put one field of the page's view back exactly as it was, independently of the other. */
  function restorePageField(view, name, had, previous) {
    try {
      if (had) view[name] = previous
      else delete view[name]
    } catch {
      /* A field that cannot be restored is left alone rather than half-restored. */
    }
  }

  /** Take the guard back off, so the timeline gets its own player back unstoppable-free. */
  function releaseGuard(guard) {
    if (guard?.bridge) {
      guard.installed = false
      guard.verified = false
      try {
        guard.element?.removeAttribute?.('data-tt-player')
      } catch {
        /* ignore */
      }
      guard.element = null
      return
    }
    if (!guard?.installed) return
    const view = guard.view
    const restore = guard.restore
    guard.installed = false
    guard.verified = false
    guard.view = null
    guard.restore = null
    if (!view || !restore) return
    for (const [name, saved] of Object.entries(restore)) {
      restorePageField(view, name, saved.had, saved.previous)
    }
  }

  /**
   * Exercise the guard once, through the page's own view, and report whether it held.
   *
   * The call goes to whatever the page's reflection holds under `pause`: our guard if it was
   * installed where the page will look, the native implementation if not. A mount always
   * restarts its clip paused, so a failed probe costs nothing - and it turns "can the page
   * still stop this column?", which has been answered by guesswork three times, into a fact.
   */
  function probeGuard(guard) {
    // The Chrome bridge works at the prototype level in the page's world; there is no page
    // reflection to call back through, but its presence and the element marker are the proof.
    if (guard?.bridge) return Boolean(guard.verified)
    if (!guard?.installed) return false
    const before = guard.blocked
    try {
      guard.view.pause()
    } catch {
      return false
    }
    guard.verified = guard.blocked > before
    guard.blocked = 0
    return guard.verified
  }

  function largeImageUrl(raw) {
    if (!raw) return null
    let url
    try {
      url = new URL(raw, location.href)
    } catch {
      return null
    }
    if (!/(^|\.)twimg\.com$/.test(url.hostname)) return null
    if (!url.pathname.includes('/media/')) return null
    url.searchParams.set('name', 'large')
    return url.toString()
  }

  // ------------------------------------------------------------- collection ---

  class Collector {
    constructor(getSettings) {
      this.getSettings = getSettings
      this.items = []
      this.keys = new Set()
      this.seenElements = new WeakSet()
    }

    reset() {
      this.items = []
      this.keys = new Set()
      this.seenElements = new WeakSet()
    }

    /** @returns {number} how many new items were appended */
    collect() {
      const settings = this.getSettings()
      const added = []
      for (const article of document.querySelectorAll('article')) {
        if (article.closest(`#${HOST_ID}`)) continue
        const permalink = tweetPermalink(article)

        const videos = article.querySelectorAll('video')
        for (let i = 0; i < videos.length; i++) {
          const item = this.videoItem(article, videos[i], permalink, i)
          if (item) added.push(item)
        }

        if (settings.includeImages) {
          const images = article.querySelectorAll('img[src*="twimg.com"]')
          for (let i = 0; i < images.length; i++) {
            const item = this.imageItem(article, images[i], permalink, i)
            if (item) added.push(item)
          }
        }
      }
      if (added.length) this.items.push(...added)
      return added.length
    }

    videoItem(article, element, permalink, slot) {
      if (this.seenElements.has(element)) return null
      const src = videoSource(element)
      if (!src && element.readyState < 1) return null
      const key = `${permalink ?? `article${articleToken(article)}`}#video${slot}`
      if (this.keys.has(key)) return null
      this.keys.add(key)
      this.seenElements.add(element)
      return { kind: 'video', element, article, permalink, src, key }
    }

    imageItem(article, element, permalink, slot) {
      if (this.seenElements.has(element)) return null
      const src = largeImageUrl(element.currentSrc || element.getAttribute('src'))
      if (!src) return null
      const key = `${permalink ?? `article${articleToken(article)}`}#image${slot}`
      if (this.keys.has(key)) return null
      this.keys.add(key)
      this.seenElements.add(element)
      return { kind: 'image', element, article, permalink, src, key }
    }
  }

  // ------------------------------------------------------------------ icons ---

  const ICON = {
    prev: '<path d="M18 5.5v13L8.5 12z"/><rect x="5" y="5.5" width="2.2" height="13" rx="1.1"/>',
    next: '<path d="M6 5.5v13L15.5 12z"/><rect x="16.8" y="5.5" width="2.2" height="13" rx="1.1"/>',
    play: '<path d="M8 5.2v13.6L19 12z"/>',
    pause: '<rect x="7" y="5.2" width="3.6" height="13.6" rx="1.2"/><rect x="13.4" y="5.2" width="3.6" height="13.6" rx="1.2"/>',
    volume: '<path d="M4 9.4h3.2L11.6 6v12L7.2 14.6H4z"/><path d="M14.6 9.1a4.2 4.2 0 010 5.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
    // A speaker with two arcs: audibility for the whole grid, not for one column.
    soundAll: '<path d="M4 9.4h3.2L11.6 6v12L7.2 14.6H4z"/><path d="M14.6 9.1a4.2 4.2 0 010 5.8M17.8 6.6a7.8 7.8 0 010 10.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
    mute: '<path d="M4 9.4h3.2L11.6 6v12L7.2 14.6H4z"/><path d="M15 9.6l4.4 4.8M19.4 9.6L15 14.4" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>'
  }

  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    .wrap {
      /* Follow X's current theme tokens. X sets these on :root/[data-theme]; they inherit
         through the shadow boundary, so a theme or accent change needs no work here. The
         fallback chain keeps the overlay legible on builds that expose none of them. */
      --tt-bg: var(--tt-page-bg, var(--x-bg-primary, #000));
      --tt-text: var(--tt-page-text, var(--x-fg-primary, #e7e9ea));
      --tt-panel: var(--tt-page-panel, var(--x-bg-secondary, color-mix(in srgb, var(--tt-bg) 94%, var(--tt-text))));
      --tt-muted: var(--tt-page-muted, var(--x-fg-secondary, color-mix(in srgb, var(--tt-text) 62%, transparent)));
      --tt-border: var(--tt-page-border, var(--x-border-normal, color-mix(in srgb, var(--tt-text) 15%, transparent)));
      --tt-hover: var(--tt-page-hover, var(--x-bg-quaternary, color-mix(in srgb, var(--tt-text) 10%, transparent)));
      --tt-track: var(--tt-page-hover, var(--x-bg-quaternary, color-mix(in srgb, var(--tt-text) 20%, transparent)));
      --tt-sheet: var(--tt-page-sheet, var(--x-bg-modal, color-mix(in srgb, var(--tt-bg) 94%, var(--tt-text))));
      --tt-accent: var(--tt-page-accent, var(--x-fg-brand, #1d9bf0));
      position: fixed; inset: 0; z-index: 2147483000;
      display: flex; flex-direction: column; background: var(--tt-bg);
      font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
      color: var(--tt-text);
    }
    .grid {
      position: relative; flex: 1 1 auto; min-height: 0; display: grid; gap: 4px;
      grid-template-columns: repeat(var(--cols, 1), minmax(0, 1fr)); background: var(--tt-bg);
    }
    .tile {
      position: relative; overflow: hidden; background: #000; cursor: pointer;
      /* Tile chrome sits over video, so it keeps a dark-on-media palette regardless of theme. */
      color: #fff;
      outline: 2px solid transparent; outline-offset: -2px;
      /* Isolate each tile's layout/paint: with several decoders running, unrelated
         page or sibling changes must not force a re-layout of every tile. */
      contain: layout paint style;
    }
    .tile.is-active { outline-color: var(--tt-accent); }
    .tile-stage {
      position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    }
    .tile-stage > video, .tile-stage > img {
      width: 100%; height: 100%; max-width: 100%; max-height: 100%;
      object-fit: contain; background: #000; display: block;
    }
    .tile-stage > img { user-select: none; }
    .tile-foot {
      position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
      display: flex; align-items: center; gap: 7px; padding: 5px 8px 6px;
      background: linear-gradient(to top, rgba(0,0,0,.72), rgba(0,0,0,0));
      pointer-events: none; opacity: .92;
    }
    .tile-idx {
      font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
      min-width: 18px; text-align: center; color: #cbd6de;
    }
    .tile.is-active .tile-idx { color: #fff; }
    .tile-bar {
      flex: 1 1 auto; height: 3px; border-radius: 999px;
      background: rgba(255,255,255,.22); overflow: hidden;
    }
    .tile.is-waiting .tile-fill { background: var(--x-fg-warning, #e0a03a); }
    .tile-fill {
      height: 100%; width: 100%; background: var(--tt-accent); border-radius: 999px;
      /* scaleX instead of width: transform is composited, width forces layout. */
      transform: scaleX(0); transform-origin: left center; will-change: transform;
    }
    .tile-mute {
      pointer-events: auto; padding: 2px; border-radius: 6px; line-height: 0;
      color: #cbd6de; background: rgba(0,0,0,.35);
    }
    .tile-mute:hover { background: rgba(255,255,255,.2); color: #fff; }
    .tile-mute svg { width: 14px; height: 14px; fill: currentColor; }
    .tile.is-muted .tile-mute { color: #7d8f9b; }
    .tile-note {
      position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
      padding: 12px; text-align: center; font-size: 12px; color: #8fa3b0;
      background: rgba(0,0,0,.55);
    }
    .tile.is-empty .tile-note { display: flex; }
    /* Between clips there is nothing to say: the column is waiting its turn in the fill queue,
       which is not the same thing as the queue being empty. */
    .tile.is-empty.is-pending .tile-note { display: none; }
    .bar {
      flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
      padding: 8px 14px; background: var(--tt-panel);
      border-top: 1px solid var(--tt-border);
    }
    .group { display: flex; align-items: center; gap: 4px; }
    .group.audio { margin-left: auto; }
    button {
      appearance: none; border: 0; background: transparent; color: inherit;
      cursor: pointer; display: inline-flex; align-items: center; justify-content: center;
      border-radius: 999px; padding: 6px; line-height: 0;
      transition: background .15s ease, color .15s ease, opacity .15s ease;
    }
    button:hover { background: var(--tt-hover); }
    button:focus-visible { outline: 2px solid var(--tt-accent); outline-offset: 1px; }
    button svg { width: 19px; height: 19px; fill: currentColor; pointer-events: none; }
    button.wide svg { width: 21px; height: 21px; }
    #tt-close {
      position: absolute; top: 12px; right: 14px; z-index: 3;
      width: 34px; height: 34px; border: 1px solid rgba(255,255,255,.35);
      /* No backdrop-filter: blurring a backdrop that contains playing video forces
         the compositor to re-blur on every frame. */
      background: #0f1419; color: #fff;
      font-size: 15px; line-height: 1; opacity: .9;
    }
    #tt-close:hover { opacity: 1; background: #272c30; }
    .count {
      font-variant-numeric: tabular-nums; opacity: .82; white-space: nowrap;
      min-width: 52px; text-align: center;
    }
    #tt-volume { width: 74px; accent-color: var(--tt-accent); cursor: pointer; }
    #tt-mute { width: 31px; height: 31px; }
    #tt-unmute { width: 31px; height: 31px; color: var(--tt-muted); }
    /* Filled green when every column is already audible, so the button doubles as the answer
       to "can I hear all of them right now?" without clicking it. */
    #tt-unmute.is-on { color: var(--x-fg-success, #00ba7c); }
    .pill {
      min-width: 44px; height: 26px; padding: 0 8px; border-radius: 7px;
      background: var(--tt-hover); font-size: 11.5px; font-weight: 600;
    }
    .pill:hover { background: var(--tt-track); }
    .menu {
      position: absolute; right: 14px; bottom: 58px; z-index: 4;
      display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px;
      padding: 6px; min-width: 208px; border-radius: 12px;
      background: var(--tt-sheet); border: 1px solid var(--tt-border);
      box-shadow: 0 14px 34px rgba(0,0,0,.55);
    }
    .menu[hidden] { display: none; }
    .menu button {
      justify-content: flex-start; padding: 7px 9px; border-radius: 8px;
      font-size: 12px; font-weight: 600; line-height: 1.2;
    }
    .menu button[data-on] {
      background: color-mix(in srgb, var(--tt-accent) 22%, transparent);
      color: var(--tt-text);
    }
    .toast {
      position: absolute; left: 50%; bottom: 70px; transform: translateX(-50%);
      z-index: 5; padding: 7px 14px; border-radius: 999px; pointer-events: none;
      background: var(--tt-panel); border: 1px solid var(--tt-border); color: var(--tt-text);
      opacity: 0; transition: opacity .2s ease; white-space: nowrap;
    }
    .toast.show { opacity: 1; }
  `

  const MARKUP = `
    <div class="wrap">
      <button id="tt-close" title="Close (Esc)" aria-label="Close">&#10005;</button>
      <div class="grid" id="tt-grid"></div>
      <div class="bar">
        <div class="group">
          <button id="tt-prev" class="wide" title="Previous in focused tile (Left arrow)" aria-label="Previous">${svg('prev')}</button>
          <button id="tt-play" class="wide" title="Play/Pause focused tile (Space)" aria-label="Play or pause">${svg('pause')}</button>
          <button id="tt-next" class="wide" title="Next video into the oldest column (Right arrow)" aria-label="Next">${svg('next')}</button>
        </div>
        <div class="group audio">
          <button id="tt-mute" title="Mute / unmute every column" aria-label="Mute all">${svg('mute')}</button>
          <input id="tt-volume" type="range" min="0" max="1" step="0.05" value="0" title="Volume (Up/Down)" aria-label="Volume" />
          <button id="tt-unmute" title="Unmute every column at once (U)" aria-label="Unmute every column">${svg('soundAll')}</button>
          <button id="tt-rate" class="pill" title="Playback speed">1x</button>
        </div>
        <span class="count" id="tt-count">&ndash;/&ndash;</span>
      </div>
      <div class="menu" id="tt-menu" hidden></div>
      <div class="toast" id="tt-toast"></div>
    </div>
  `

  const RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3]
  const VOLUME_STEP = 0.05

  // ------------------------------------------------------------------- lane ---

  /** One column: the media mounted in it, its history, its timers, its mute state. */
  class Lane {
    constructor(slot, refs) {
      this.slot = slot
      this.refs = refs
      this.index = -1
      this.mounted = null // { element, parent, next, restore }
      this.image = null
      this.handlers = null
      this.history = []
      this.historyPos = -1
      this.totalMs = 0
      this.leftMs = 0
      this.startedAt = 0
      this.timer = null
      this.ticker = null
      this.userPaused = false
      this.resumes = 0
      this.lastResumeAt = 0
      this.stalledSince = 0
      this.nativePause = null
      this.nativeLoad = null
      this.guard = null
      this.reroutes = 0
      this.nudged = false
      this.lastPullAt = 0
      this.retriedError = false
      this.errorResetTimer = null
      this.lastTime = 0
      this.lastFrames = 0
      this.stallRestarts = 0
      this.advancing = false
      // True between a clip ending and the next one being mounted. The spent player stays in
      // the tile, paused on its last frame, so an ordinary advance never shows an empty tile.
      this.finished = false
      this.finishedAt = 0
      // A reused page player may already be at the end of its previous playback. Track that
      // separately from a real finish so the first paint cannot skip the new clip.
      this.mountedAt = 0
      this.mountTime = 0
      this.endedBeforeMount = false
      this.sawProgress = false
      this.endRechecked = false
      // Why and where the last clip was retired. Shift+D reports it, so "it switched before
      // the end" can be answered with a reason instead of a guess.
      this.lastAdvance = null
      // Last ratio written to this tile's progress fill, so a frozen tile stops re-invalidating
      // style on every 200 ms paint.
      this.paintedRatio = -1
      // Columns start silent: audible autoplay needs a gesture inside the page.
      // This flag is per column and survives the lane pulling new videos.
      this.muted = true
    }

    get idle() {
      return this.index < 0
    }

    get video() {
      return this.mounted?.element?.tagName === 'VIDEO' ? this.mounted.element : null
    }
  }

  // -------------------------------------------------------------- slideshow ---

  class Slideshow {
    constructor(getSettings) {
      this.getSettings = getSettings
      this.collector = new Collector(getSettings)
      this.active = false
      this.columns = 1
      this.lanes = []
      this.nextIndex = 0
      this.focusSlot = 0
      this.pinned = false
      this.rate = 1
      this.masterMuted = true
      this.volume = 0.5
      this.skips = 0
      this.host = null
      this.ui = {}
      this.observer = null
      this.themeObserver = null
      this.collectTimer = null
      this.paintTimer = null
      this.toastTimer = null
      this.loadToken = 0
      // Optimistic discovery state: when it last scrolled for clips, whether it is mid-search,
      // and how many consecutive searches have come back empty.
      this.lastTopUpAt = 0
      this.topUpRunning = false
      this.dryTopUps = 0
      // How many items were present at the last paint. New material resets the discovery
      // budget even when it arrived through X's own DOM updates rather than a gather() round.
      this.itemsSeen = 0

      this.onKeyDown = this.onKeyDown.bind(this)
      this.onVisibilityChange = this.onVisibilityChange.bind(this)
    }

    get items() {
      return this.collector.items
    }

    laneAt(slot) {
      return this.lanes[slot] ?? null
    }

    get focusedLane() {
      return this.laneAt(this.focusSlot)
    }

    // -- lifecycle ------------------------------------------------------------

    async start() {
      if (this.active) return { ok: true, message: 'Slideshow is already open.', count: this.items.length }
      const settings = this.getSettings()
      this.columns = clamp(Number(settings.columns) || 1, 1, MAX_COLUMNS)

      this.collector.reset()
      this.collector.collect()
      if (!this.items.length) {
        for (let attempt = 0; attempt < 3 && !this.items.length; attempt++) {
          window.scrollBy(0, Math.round(window.innerHeight * 0.85))
          await sleep(450 + attempt * 250)
          this.collector.collect()
        }
      }
      if (!this.items.length) {
        return {
          ok: false,
          message: settings.includeImages
            ? 'No videos or images found nearby. Scroll the timeline a little and try again.'
            : 'No videos found nearby. Scroll the timeline a little and try again.'
        }
      }

      this.build()
      this.active = true
      this.startWatching()

      this.nextIndex = 0
      // One column starts immediately: the wall appears with something already playing, and a
      // timeline where nothing can be played still fails right here rather than a second later.
      // The rest follow one per MOUNT_STAGGER_MS through tryFillLane().
      const first = this.lanes[0]
      const started = Boolean(first) && this.pullInto(first)
      if (!started) {
        this.teardown()
        return { ok: false, message: 'Found media, but none of it could be played.' }
      }
      const planned = Math.min(this.columns, this.items.length)

      this.focusSlot = this.newestSlot()
      this.pinned = false
      this.paintFocus()
      this.applyAudio()
      this.refreshChrome()

      return {
        ok: true,
        message:
          this.columns === 1
            ? `Playing ${this.items.length} item${this.items.length === 1 ? '' : 's'}.`
            : `Filling ${planned} column${planned === 1 ? '' : 's'} over ${this.items.length} item${this.items.length === 1 ? '' : 's'}.`,
        count: this.items.length,
        columns: this.columns,
        // Columns this run will fill, not the number already mounted: the grid fills one column
        // at a time, so at this instant only the first is playing.
        playing: planned
      }
    }

    stop() {
      if (!this.active) return { ok: true, active: false, message: 'Slideshow is not running.' }
      this.teardown()
      return { ok: true, active: false, message: 'Slideshow closed.' }
    }

    /** Every exit route lands here: all lanes unmounted and restored. */
    teardown() {
      this.active = false
      this.loadToken++
      for (const lane of this.lanes) this.unmountLane(lane, { keepHistory: false })
      this.stopWatching()
      clearTimeout(this.toastTimer)
      this.toastTimer = null
      document.removeEventListener('keydown', this.onKeyDown, true)
      if (this.host) {
        this.host.remove()
        this.host = null
      }
      this.ui = {}
      this.lanes = []
      this.pinned = false
      this.focusSlot = 0
      this.nextIndex = 0
      this.skips = 0
      this.topUpRunning = false
      this.dryTopUps = 0
      this.itemsSeen = 0
      this.collector.reset()
    }

    startWatching() {
      // Scanning the whole timeline is the most expensive thing this script does, so
      // only scan when the result could be useful: a column is idle, or the queue is
      // nearly drained. Before this, a full rescans ran every 1.5s during playback.
      // Throttle, not debounce. X mutates the DOM constantly (timers, counters, live
      // badges), and a clearTimeout/setTimeout pair per mutation is pure churn while
      // several decoders are already running. One pending timer is enough.
      this.observer = new MutationObserver(() => {
        if (this.collectTimer) return
        this.collectTimer = setTimeout(() => {
          this.collectTimer = null
          if (!this.active || !this.needsMoreItems()) return
          this.collector.collect()
          this.fillIdleLanes()
          this.refreshChrome()
        }, 2000)
      })
      this.observer.observe(document.body, { childList: true, subtree: true })
      // Theme and accent live on <html>/<body> as data-theme, data-accent, classes or inline
      // style. Watching those attributes is enough to follow a switch without polling styles.
      this.themeObserver = new MutationObserver(() => this.syncTheme())
      const themeAttributes = ['data-theme', 'data-accent', 'data-high-contrast', 'class', 'style']
      this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: themeAttributes })
      if (document.body) {
        this.themeObserver.observe(document.body, { attributes: true, attributeFilter: themeAttributes })
      }
      this.syncTheme()
      this.paintTimer = setInterval(() => this.paintAll(), 200)
      document.addEventListener('visibilitychange', this.onVisibilityChange)
    }

    stopWatching() {
      this.observer?.disconnect()
      this.observer = null
      this.themeObserver?.disconnect()
      this.themeObserver = null
      document.removeEventListener('visibilitychange', this.onVisibilityChange)
      clearTimeout(this.collectTimer)
      this.collectTimer = null
      clearInterval(this.paintTimer)
      this.paintTimer = null
    }

    /**
     * A hidden tab can make the paint timer (and therefore the stall bookkeeping) skip for
     * minutes. On return, that gap must not be mistaken for a frozen player: reset the clocks
     * and start watching again from where each clip actually is.
     */
    onVisibilityChange() {
      if (document.hidden) return
      for (const lane of this.lanes) {
        lane.stalledSince = 0
        lane.nudged = false
        lane.lastResumeAt = 0
        const element = lane.video
        if (element) lane.lastTime = element.currentTime
      }
      this.syncTheme()
    }

    /**
     * Follow X's current theme.
     *
     * X applies `data-theme` (light/dark), `data-accent` and the `--x-*` palette tokens to
     * <html>, and the tokens inherit through the shadow boundary, so the overlay's own CSS can
     * use them directly. Copying the attributes to the overlay host as well means the tokens
     * still apply when a build puts them on <body> rather than :root. The sampled page colours
     * are a fallback for older markup that has no tokens; they also follow a Dim-style palette
     * that keeps `data-theme=dark` but uses a lighter background.
     */
    syncTheme() {
      const host = this.host
      if (!host) return
      const root = document.documentElement
      const body = document.body
      // X normally puts the theme on :root, but a build that scopes it to a wrapper still
      // exposes the same data-theme attribute and computed tokens there. Skip our own host:
      // it carries a copy of the attribute and must never become the source of truth.
      let themeRoot = root
      try {
        for (const node of document.querySelectorAll('[data-theme]')) {
          if (node !== host) {
            themeRoot = node
            break
          }
        }
      } catch {
        themeRoot = root
      }
      const theme =
        root?.dataset?.theme ||
        body?.dataset?.theme ||
        themeRoot?.dataset?.theme ||
        (root?.classList?.contains('light-theme') || body?.classList?.contains('light-theme') ? 'light' : '') ||
        (root?.classList?.contains('dark-theme') || body?.classList?.contains('dark-theme') ? 'dark' : '') ||
        (root?.classList?.contains('LightsOut') || body?.classList?.contains('LightsOut') ? 'dark' : '')
      const accent = root?.dataset?.accent || body?.dataset?.accent || themeRoot?.dataset?.accent || ''
      const contrast = root?.dataset?.highContrast || body?.dataset?.highContrast || themeRoot?.dataset?.highContrast || ''

      const copy = (name, value) => {
        try {
          if (value) host.setAttribute(name, value)
          else host.removeAttribute(name)
        } catch {
          /* ignore */
        }
      }
      copy('data-theme', theme)
      copy('data-accent', accent)
      copy('data-high-contrast', contrast)
      host.style.colorScheme = theme === 'light' || theme === 'dark' ? theme : 'inherit'

      let bodyStyle = null
      let rootStyle = null
      let themeStyle = null
      try {
        if (typeof getComputedStyle === 'function') {
          bodyStyle = body ? getComputedStyle(body) : null
          rootStyle = getComputedStyle(root)
          themeStyle = themeRoot && themeRoot !== root ? getComputedStyle(themeRoot) : null
        }
      } catch {
        bodyStyle = null
      }
      const token = (name) => {
        try {
          return String(
            bodyStyle?.getPropertyValue?.(name) ||
              themeStyle?.getPropertyValue?.(name) ||
              rootStyle?.getPropertyValue?.(name) ||
              ''
          ).trim()
        } catch {
          return ''
        }
      }
      // Only bridge values that are already concrete colours. A computed custom property can
      // still read as `var(--x-white)`; handing that to the shadow would depend on every part of
      // X's palette being inherited, which is exactly what the CSS --x-* chain already assumes.
      const colorToken = (name) => {
        const value = token(name)
        return parseColor(value) ? value : ''
      }
      // Bridge X's tokens to the host explicitly. Reading them from computed style covers a
      // build that defines them on <body> (where they would not inherit into a shadow host
      // parented to <html>); CSS keeps the --x-* chain as the normal path.
      const page = {
        '--tt-page-bg': colorToken('--x-bg-primary'),
        '--tt-page-panel': colorToken('--x-bg-secondary'),
        '--tt-page-text': colorToken('--x-fg-primary'),
        '--tt-page-muted': colorToken('--x-fg-secondary'),
        '--tt-page-border': colorToken('--x-border-normal'),
        '--tt-page-hover': colorToken('--x-bg-quaternary'),
        '--tt-page-sheet': colorToken('--x-bg-modal'),
        '--tt-page-accent': colorToken('--x-fg-brand')
      }
      let background = bodyStyle?.backgroundColor || ''
      let foreground = bodyStyle?.color || ''
      if (!visibleColor(background)) background = themeStyle?.backgroundColor || ''
      if (!visibleColor(foreground)) foreground = themeStyle?.color || ''
      if (!visibleColor(background)) background = rootStyle?.backgroundColor || ''
      if (!visibleColor(foreground)) foreground = rootStyle?.color || ''
      if (!visibleColor(background) && (theme === 'light' || theme === 'dark')) {
        background = theme === 'light' ? '#ffffff' : '#000000'
      }
      if (!visibleColor(foreground) && (theme === 'light' || theme === 'dark')) {
        foreground = theme === 'light' ? '#0f1419' : '#e7e9ea'
      }
      if (!page['--tt-page-bg'] && visibleColor(background)) page['--tt-page-bg'] = background
      if (!page['--tt-page-text'] && visibleColor(foreground)) page['--tt-page-text'] = foreground
      for (const [name, value] of Object.entries(page)) setHostVar(host, name, value)
      if (theme !== 'light' && theme !== 'dark' && visibleColor(background)) {
        host.style.colorScheme = colorIsLight(background) ? 'light' : 'dark'
      }
    }

    /** True when more media would actually be used. */
    needsMoreItems() {
      if (this.lanes.some((lane) => lane.idle || lane.finished)) return true
      return this.nextIndex >= this.items.length - 1
    }

    /** One shared repaint for every tile plus the focused bar. */
    paintAll() {
      if (!this.active || document.hidden) return
      // Any genuinely new item means the timeline has not stopped producing clips. Reset the
      // "nothing came back" budget before checking finished lanes, so a lane cannot display
      // "No more videos" in the same tick that X added more material.
      if (this.items.length > this.itemsSeen) {
        this.itemsSeen = this.items.length
        this.dryTopUps = 0
      }
      const now = performance.now()
      for (const lane of this.lanes) {
        // A finished clip is holding its last frame until a replacement is ready. It is not
        // "waiting" (that amber marker means the page paused a live player), and moving on is
        // the staggered fill's job. The tile is only emptied once the grace period is up.
        if (lane.finished) {
          const held = lane.video
          if (held && held.isConnected === false) {
            // The page took the borrowed player back while we held it: there is no frame left
            // to show, so let the normal fill take over on the next tick.
            this.unmountLane(lane, { keepHistory: true })
            this.showLaneEmpty(lane)
            continue
          }
          // The page may try to start a player it thinks is primary. The held frame is not
          // playing anything any more, so keep it parked.
          if (held && !held.paused) {
            try {
              if (lane.nativePause) lane.nativePause()
              else held.pause()
            } catch {
              /* ignore */
            }
          }
          this.tryFillLane(lane, now)
          if (lane.finished) this.checkFinishedLane(lane, now)
          this.paintLaneProgress(lane)
          continue
        }
        const element = lane.video
        // X replaces and removes players as the timeline virtualises. A detached <video> still
        // accepts play() and still reports a currentTime, so without this check the tile shows
        // one frozen frame forever while the keep-alive pushes a player that no longer has a
        // surface - which looks exactly like the pause fight the keep-alive exists to fix.
        if (element && element.isConnected === false) {
          this.rerouteLane(lane)
          continue
        }
        // A column whose player has stopped is visibly marked, so a pause caused by the page
        // looks like a pause rather than a silent stall. Marked from the state this tick
        // started in, before anything below has a chance to recover it.
        if (lane.refs?.tile) {
          const waiting = Boolean(element) && element.paused && !lane.userPaused && !element.ended && !lane.idle
          lane.refs.tile.classList.toggle('is-waiting', waiting)
        }
        if (element) this.watchPlayer(lane, element, now)
        else if (lane.idle) this.tryFillLane(lane, now)
        this.paintLaneProgress(lane)
      }
      this.keepAlive(now)
      this.topUpLanes(now)
    }

    /**
     * Take a clip out of the queue when one is ready.
     *
     * `pullInto` checks playability before it unmounts anything, so a lane that is holding the
     * last frame of the previous clip keeps that frame while unplayable queue entries are
     * walked over. A lane with nothing mounted and nothing queued updates its "waiting"/"no more"
     * note; a finished lane just keeps holding.
     */
    tryFillLane(lane, now) {
      if (lane.advancing) return false
      if (now - (lane.lastPullAt || 0) < IDLE_PULL_MS) return false
      if (now - (this.lastMountAt || 0) < MOUNT_STAGGER_MS) return false
      if (this.nextIndex >= this.items.length) {
        if (!lane.finished) this.showLaneEmpty(lane)
        return false
      }
      lane.lastPullAt = now
      if (this.pullInto(lane)) {
        this.refreshChrome()
        return true
      }
      // Everything left in the queue turned out to be unplayable. An empty lane says it is
      // waiting; a finished lane keeps the frame it already has.
      if (!lane.finished) this.showLaneEmpty(lane)
      this.refreshChrome()
      return false
    }

    /**
     * The last frame has been held long enough, with the queue drained and no search running.
     * Only now is "No more videos" true, and only now does the spent player go back to X.
     */
    checkFinishedLane(lane, now) {
      if (!lane.finished || lane.advancing) return
      if (this.nextIndex < this.items.length) return
      if (this.topUpRunning) return
      // Do not call the timeline empty while the optimistic search still has rounds left to
      // spend. The grace period is a floor, not a substitute for actually looking.
      if (this.dryTopUps < TOPUP_DRY_ROUNDS) return
      if (now - (lane.finishedAt || 0) < NO_MORE_GRACE_MS) return
      this.unmountLane(lane, { keepHistory: true })
      this.showLaneEmpty(lane)
      this.refreshChrome()
    }

    /**
     * Keep looking for clips while columns are still empty.
     *
     * Discovery used to stop at "the collected count grew", which is the right rule for a queue
     * and the wrong one for a grid. Eight columns over a timeline where videos are far apart
     * filled the two that were found, and the other six waited - nothing was scrolling to look
     * for the rest, because the only paths that scrolled were a drained queue after a clip ended
     * and a manual Next. This keeps scrolling, bounded, until every column has a clip or the
     * timeline genuinely stops producing them.
     */
    topUpLanes(now) {
      if (!this.active || this.topUpRunning) return
      if (this.dryTopUps >= TOPUP_DRY_ROUNDS) return
      // One scroll at a time: an advance in flight is already moving the page.
      if (this.lanes.some((lane) => lane.advancing)) return
      const empty = this.lanes.filter((lane) => lane.idle || lane.finished).length
      if (!empty) return
      // While items are still unclaimed the fill queue has something to do; scrolling would only
      // pull the timeline out from under the clips being collected.
      if (this.nextIndex < this.items.length) return
      if (now - (this.lastTopUpAt || 0) < TOPUP_INTERVAL_MS) return

      this.lastTopUpAt = now
      this.topUpRunning = true
      this.gather(this.items.length + empty)
        .then((grew) => {
          if (grew) this.dryTopUps = 0
          else this.dryTopUps += 1
        })
        .catch(() => {
          /* a search that throws is no worse than one that found nothing */
        })
        .finally(() => {
          this.topUpRunning = false
        })
    }

    /**
     * Scroll until `target` items are collected, or the timeline stops producing them.
     *
     * Separate from loadMore(), which stops at the first new item: that is right when one column
     * is waiting for anything at all to play, and useless when six columns are waiting for six.
     */
    async gather(target) {
      const before = this.items.length
      for (let attempt = 0; attempt < TOPUP_SCROLLS; attempt++) {
        if (!this.active) return false
        this.collector.collect()
        if (this.items.length >= target) return true
        window.scrollBy(0, Math.round(window.innerHeight * 0.8))
        await sleep(400 + attempt * 150)
        if (!this.active) return false
        this.collector.collect()
        if (this.items.length >= target) return true
      }
      // Reaching target is ideal, but growth is what proves the timeline is still producing.
      // The old return value was "filled the whole target", which counted a round that found
      // one or two new clips as dry; three sparse-but-productive rounds then stopped discovery
      // while the grid was still half empty and made every finished column say "No more videos".
      return this.items.length > before
    }

    /**
     * Is this column's clip finished?
     *
     * `ended` is what this used to ask, and it is not reliable for the players X hands over: a
     * player that pauses a fraction before its own end never sets it, so the column stayed on
     * its last frame while everything around it moved on. Position within the clip is a fact
     * that does not depend on which player is playing it.
     */
    clipIsOver(lane, element) {
      if (lane.userPaused) return false
      const duration = element.duration
      const hasDuration = Number.isFinite(duration) && duration > 0
      if (element.ended) {
        // A borrowed player can arrive with a stale `ended` flag from the page's previous use
        // of it. Trust it only when the playhead is actually at the end; otherwise the first
        // paint tick would switch away before the clip had played at all.
        return hasDuration ? element.currentTime >= duration - Math.max(CLIP_END_SLACK_S, 1) : true
      }
      // A duration that is missing or implausibly short (X reports one while the media source
      // is still setting up) must not make "currentTime >= duration - slack" true at position
      // zero. Very short real clips still finish through `ended`.
      if (!hasDuration || duration <= 1) return false
      // Only trust the position when the player has actually stopped. A still-playing video
      // whose reported duration is short (a stale or provisional duration on X's MSE player)
      // would otherwise be retired while it is visibly still playing.
      if (!element.paused) return false
      return element.currentTime >= duration - CLIP_END_SLACK_S
    }

    /**
     * Per-tick judgement of one column's player: is the clip over, and is the player moving?
     *
     * Progress, not `paused`, is what decides. A player can claim to be playing while it is
     * frozen - end of stream, a decoder that stopped, an element whose media never arrived -
     * and it can be paused at the end of its clip with `ended` unset. Both looked identical to
     * "waiting for the next video" and both left a tile on the same frame indefinitely.
     *
     * The one thing that must not be conflated with either: a player the PAGE keeps pausing.
     * That is the keep-alive's job, it is making progress at its own pace, and advancing would
     * throw away the rest of a clip for no reason - so any resume this tick's stall has needed
     * vetoes moving on. Slow buffering (below HAVE_FUTURE_DATA) is left alone entirely, which
     * is the rule this add-on has already paid for twice.
     */
    watchPlayer(lane, element, now) {
      if (lane.advancing || lane.finished) return
      // A reused page player can arrive already ended, or seek-to-zero can be refused while
      // the element still reports the old end. Do not spend the new clip on that first tick:
      // retry the seek and play first. This is the "switches before it reaches the end" path.
      if (lane.endedBeforeMount && !lane.sawProgress && now - (lane.mountedAt || 0) < MOUNT_END_GUARD_MS) {
        const duration = element.duration
        const atEnd =
          element.ended ||
          (Number.isFinite(duration) && duration > 1 && element.currentTime >= duration - 1)
        if (atEnd) {
          if (!lane.endRechecked) {
            lane.endRechecked = true
            try {
              element.currentTime = 0
            } catch {
              /* the player may refuse the seek; play() is still worth one attempt */
            }
          }
          this.tryPlay(lane, 2)
          return
        }
      }
      if (this.clipIsOver(lane, element)) {
        this.onLaneEnded(lane.slot, 'measured')
        return
      }
      if (lane.userPaused) return
      // A stale ended flag is not a finish (see clipIsOver). play() is what clears it.
      if (element.ended) {
        this.tryPlay(lane, 1)
        return
      }

      // Decoded frames are progress too. If a player reports frames moving while currentTime
      // is stuck, it is not frozen; switching away would cut a playing clip short.
      const quality = element.getVideoPlaybackQuality?.()
      const frames = quality ? quality.totalVideoFrames : 0
      const framesAdvanced = frames > lane.lastFrames
      lane.lastFrames = frames
      if (element.currentTime < lane.lastTime - 0.01) {
        // The seek to the start of a borrowed player landed after the first paint. Treat the
        // backward jump as a fresh baseline; otherwise the watchdog would wait for the new
        // clip to pass the old clip's final position before it saw any progress.
        lane.lastTime = element.currentTime
        lane.stalledSince = 0
        lane.resumes = 0
        lane.nudged = false
        lane.stallRestarts = 0
        lane.sawProgress = true
        return
      }
      if (element.currentTime > lane.lastTime + 0.01 || framesAdvanced) {
        // Real progress: reset the stall bookkeeping, the resume budget and the restart budget.
        if (element.currentTime > lane.mountTime + 0.05 || framesAdvanced) lane.sawProgress = true
        lane.lastTime = Math.max(lane.lastTime, element.currentTime)
        lane.resumes = 0
        lane.stalledSince = 0
        lane.nudged = false
        lane.stallRestarts = 0
        return
      }
      if (!lane.stalledSince) {
        lane.stalledSince = now
        return
      }
      const stalledFor = now - lane.stalledSince
      // No media at all cannot recover by waiting, whichever way play() left it.
      if (element.readyState === 0) {
        if (stalledFor > DEAD_ADVANCE_MS) this.onLaneEnded(lane.slot, 'dead-media')
        return
      }
      // Still fetching, seeking or holding only some data: this is buffering, not a dead
      // player. Keep the clip however long it takes.
      if (element.seeking || element.networkState === 2 || element.readyState < 4) return
      // The page is pausing this player and the keep-alive is putting it back: it is alive,
      // just interrupted. Wait for it rather than spending the clip.
      if (lane.resumes > 0) return
      if (!lane.nudged && stalledFor > STALL_NUDGE_MS) {
        lane.nudged = true
        this.tryPlay(lane, 1)
        return
      }
      if (stalledFor > STALL_ADVANCE_MS) {
        // A player that has genuinely stopped is more likely to recover by being remounted
        // than by being replaced with a different clip. Restart the same clip once; only if it
        // freezes again does the column take the next one.
        if (lane.stallRestarts < 1) {
          lane.stallRestarts += 1
          if (this.mountLane(lane, lane.index, 'none')) return
          if (lane.idle) return
        }
        this.onLaneEnded(lane.slot, 'stalled')
      }
    }

    /**
     * The element a lane was playing has left the document: pick the same clip up again if
     * the timeline still has it, and take the next one if it does not.
     *
     * Capped so a lane cannot thrash: the count is reset by a mount that works, so it bounds
     * consecutive failures rather than how often the page may replace a player.
     */
    rerouteLane(lane) {
      if (lane.advancing) return
      lane.reroutes += 1
      if (lane.reroutes <= REROUTE_LIMIT && this.mountLane(lane, lane.index, 'none')) return
      lane.reroutes = 0
      if (!this.pullInto(lane)) {
        // The lane may still reference the player the page removed. Retire it so the next
        // paint tick sees an empty lane rather than a detached element again.
        this.unmountLane(lane, { keepHistory: true })
        this.showLaneEmpty(lane)
      }
      this.refreshChrome()
    }

    // -- queue ----------------------------------------------------------------

    /** Next unassigned queue position, or null when the queue is drained. */
    takeIndex() {
      if (this.nextIndex >= this.items.length) return null
      return this.nextIndex++
    }

    newestSlot() {
      let best = this.focusSlot
      let bestIndex = -1
      for (const lane of this.lanes) {
        if (lane.index > bestIndex) {
          bestIndex = lane.index
          best = lane.slot
        }
      }
      return best
    }

    /** Give every column that needs a clip a chance at the queue, one stagger window at a time. */
    fillIdleLanes() {
      const now = performance.now()
      for (const lane of this.lanes) {
        if (!lane.idle && !lane.finished) continue
        this.tryFillLane(lane, now)
      }
    }

    // -- DOM ------------------------------------------------------------------

    build() {
      const host = document.createElement('div')
      host.id = HOST_ID
      host.setAttribute('style', 'all: initial; position: fixed; inset: 0; z-index: 2147483000;')
      const shadow = host.attachShadow({ mode: 'open' })

      try {
        const sheet = new CSSStyleSheet()
        sheet.replaceSync(STYLE)
        shadow.adoptedStyleSheets = [sheet]
      } catch {
        const style = document.createElement('style')
        style.textContent = STYLE
        shadow.append(style)
      }

      const holder = document.createElement('div')
      holder.innerHTML = MARKUP
      shadow.append(holder.firstElementChild)

      const $ = (id) => shadow.getElementById(id)
      this.ui = {
        shadow,
        close: $('tt-close'),
        grid: $('tt-grid'),
        prev: $('tt-prev'),
        play: $('tt-play'),
        next: $('tt-next'),
        mute: $('tt-mute'),
        volume: $('tt-volume'),
        unmute: $('tt-unmute'),
        rate: $('tt-rate'),
        menu: $('tt-menu'),
        count: $('tt-count'),
        toast: $('tt-toast')
      }

      this.host = host
      this.ui.grid.style.setProperty('--cols', String(this.columns))
      document.documentElement.append(host)
      this.syncTheme()

      this.lanes = []
      for (let slot = 0; slot < this.columns; slot++) {
        this.lanes.push(new Lane(slot, this.buildTile(slot)))
      }
      // Every tile starts empty, and none of them claims the timeline is exhausted: while the
      // grid is filling, a column with no clip yet is waiting, not finished.
      for (const lane of this.lanes) this.showLaneEmpty(lane)

      this.bindUi()
      this.buildRateMenu()
      document.addEventListener('keydown', this.onKeyDown, true)
      this.applyAudio()
    }

    buildTile(slot) {
      const tile = document.createElement('div')
      // Starts pending, not finished: until a clip is handed to this column there is nothing to
      // report, and "No more videos" on seven tiles while the grid fills would be a lie.
      tile.className = 'tile is-empty is-muted is-pending'
      tile.setAttribute('data-slot', String(slot))
      tile.innerHTML =
        '<div class="tile-stage"></div>' +
        '<div class="tile-foot">' +
        '<span class="tile-idx">-</span>' +
        '<div class="tile-bar"><div class="tile-fill"></div></div>' +
        `<button class="tile-mute" title="Mute or unmute this column" aria-label="Mute this column">${svg('mute')}</button>` +
        '</div>' +
        '<div class="tile-note"></div>'

      const mute = tile.querySelector('.tile-mute')
      mute.addEventListener('click', (event) => {
        event.stopPropagation()
        this.toggleLaneMute(slot)
      })
      tile.addEventListener('click', () => this.onTileClick(slot))
      this.ui.grid.append(tile)

      return {
        tile,
        stage: tile.querySelector('.tile-stage'),
        fill: tile.querySelector('.tile-fill'),
        badge: tile.querySelector('.tile-idx'),
        note: tile.querySelector('.tile-note'),
        mute
      }
    }

    bindUi() {
      const ui = this.ui
      ui.close.addEventListener('click', () => this.stop())
      ui.prev.addEventListener('click', () => this.prevItem())
      ui.next.addEventListener('click', () => this.nextItem())
      ui.play.addEventListener('click', () => this.togglePlay())

      ui.volume.addEventListener('input', () => {
        const value = clamp(parseFloat(ui.volume.value) || 0, 0, 1)
        this.volume = value
        if (value > 0) this.masterMuted = false
        this.applyAudio()
      })
      ui.mute.addEventListener('click', () => {
        this.masterMuted = !this.masterMuted
        if (!this.masterMuted && this.volume === 0) {
          this.volume = 0.5
          ui.volume.value = '0.5'
        }
        this.applyAudio()
      })
      ui.unmute.addEventListener('click', () => this.unmuteAll())

      ui.rate.addEventListener('click', (event) => {
        event.stopPropagation()
        ui.menu.hidden = !ui.menu.hidden
      })
      ui.shadow.addEventListener('click', (event) => {
        if (!ui.menu.hidden && !ui.menu.contains(event.target) && event.target !== ui.rate) {
          ui.menu.hidden = true
        }
      })
    }

    buildRateMenu() {
      const menu = this.ui.menu
      menu.replaceChildren()
      for (const rate of RATES) {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('data-rate', String(rate))
        button.textContent = formatRate(rate)
        button.addEventListener('click', () => {
          this.setRate(rate)
          menu.hidden = true
        })
        menu.append(button)
      }
      this.refreshRateUi()
    }

    toast(message) {
      const node = this.ui.toast
      if (!node) return
      node.textContent = message
      node.classList.add('show')
      clearTimeout(this.toastTimer)
      this.toastTimer = setTimeout(() => node.classList.remove('show'), 1400)
    }

    // -- focus ----------------------------------------------------------------

    onTileClick(slot) {
      const lane = this.laneAt(slot)
      if (!lane) return
      if (this.focusSlot === slot && this.pinned) {
        this.toggleLanePlayback(lane)
        return
      }
      this.focusSlot = slot
      this.pinned = true
      this.paintFocus()
      this.refreshChrome()
    }

    paintFocus() {
      for (const lane of this.lanes) {
        lane.refs.tile.classList.toggle('is-active', lane.slot === this.focusSlot)
      }
    }

    // -- mounting -------------------------------------------------------------

    videoElementFor(item) {
      if (item.element?.isConnected) return item.element
      const article = this.articleFor(item)
      if (!article) return null
      const video = article.querySelector('video')
      if (video) item.element = video
      return video
    }

    articleFor(item) {
      if (item.article?.isConnected) return item.article
      if (!item.permalink) return null
      for (const article of document.querySelectorAll('article')) {
        if (tweetPermalink(article) === item.permalink) {
          item.article = article
          return article
        }
      }
      return null
    }

    /**
     * Mount an item into a lane.
     * @param mode 'push' records history (forward), 'back' keeps history (prev), 'none' skips
     */
    mountLane(lane, index, mode = 'push') {
      const item = this.items[index]
      if (!item) return false
      this.unmountLane(lane, { keepHistory: true })
      // Set the mount epoch before any handler or play() can run. mountVideo fills in the
      // seek/ended details before it attaches listeners; otherwise a synchronous stale
      // `ended` could retire the clip before the lane knew it had just mounted.
      lane.mountedAt = performance.now()
      lane.mountTime = 0
      lane.endedBeforeMount = false
      lane.sawProgress = false
      lane.endRechecked = false
      const ok = item.kind === 'video' ? this.mountVideo(lane, item) : this.mountImage(lane, item)
      if (!ok) {
        this.showLaneEmpty(lane)
        return false
      }
      lane.index = index
      lane.stalledSince = 0
      lane.reroutes = 0
      // A new clip starts its own clock. Without this the watchdog compared the new player's
      // currentTime against the previous clip's, and advanced a healthy clip as "stalled".
      lane.lastTime = lane.mountTime
      lane.lastFrames = 0
      lane.nudged = false
      // A mount ends the "holding the last frame" state and inherits no retry budget from the
      // previous clip: a fresh source deserves its own first-error retry.
      lane.finished = false
      lane.finishedAt = 0
      lane.lastAdvance = null
      lane.paintedRatio = -1
      lane.retriedError = false
      clearTimeout(lane.errorResetTimer)
      lane.errorResetTimer = null
      // A successful mount ends the run of unplayable/erroring items that `skips` counts.
      this.skips = 0
      // The grid's stagger runs from the last player that actually started.
      this.lastMountAt = performance.now()
      if (mode === 'push') {
        // A clip taken from the queue gets its own restart budget; a remount of the same
        // clip (reroute or stall recovery) must keep the one it has already spent.
        lane.stallRestarts = 0
        lane.history = lane.history.slice(0, lane.historyPos + 1)
        lane.history.push(index)
        lane.historyPos = lane.history.length - 1
      }
      lane.refs.tile.classList.remove('is-empty')
      lane.refs.tile.classList.remove('is-pending')
      this.paintLane(lane)
      if (!this.pinned) {
        this.focusSlot = this.newestSlot()
        this.paintFocus()
      }
      this.applyAudio()
      this.refreshChrome()
      return true
    }

    /**
     * Mount a clip into a lane.
     *
     * A tweet that exposes a real https source is played in OUR OWN <video> element. X holds
     * no reference to that element, so its per-page "only one playing video" manager cannot
     * pause it - the same reason two browser tabs can each play a video at once.
     *
     * A blob: (MSE) source can only be played by the element X created, so that element is
     * moved into the tile instead and its pause()/load() are neutered while it is there.
     * The moved path below is unchanged by this.
     */
    mountVideo(lane, item) {
      if (directSource(item.src) && this.mountOwnVideo(lane, item)) return true
      return this.mountMovedVideo(lane, item)
    }

    mountOwnVideo(lane, item) {
      const element = document.createElement('video')
      element.className = 'tt-own-video'
      element.setAttribute('playsinline', '')
      element.setAttribute('preload', 'auto')
      element.setAttribute('src', item.src)

      lane.mounted = { element, own: true, parent: null, next: null, restore: null }
      lane.nativePause = null
      lane.nativeLoad = null
      lane.userPaused = false
      lane.mountTime = element.currentTime
      lane.endedBeforeMount = false
      lane.sawProgress = false
      lane.endRechecked = false

      lane.refs.stage.replaceChildren(element)

      lane.handlers = {
        ended: () => this.onLaneEnded(lane.slot, 'event'),
        error: () => this.onLaneError(lane.slot),
        seeking: () => this.paintLaneProgress(lane)
      }
      for (const [type, handler] of Object.entries(lane.handlers)) {
        element.addEventListener(type, handler)
      }

      element.playbackRate = this.rate
      this.applyAudioToLane(lane)
      this.tryPlay(lane, 3)
      return true
    }

    mountMovedVideo(lane, item) {
      const element = this.videoElementFor(item)
      if (!element || !element.parentNode) return false

      // Capture the element's own pause/load before any guard goes in above them. Xray vision
      // makes this read the native implementation, which is exactly what the add-on needs to
      // keep driving the player itself.
      lane.nativePause = element.pause.bind(element)
      lane.nativeLoad = typeof element.load === 'function' ? element.load.bind(element) : null
      try {
        lane.nativePause()
      } catch {
        /* detached elements can throw; there is nothing to recover */
      }

      lane.mounted = {
        element,
        parent: element.parentNode,
        next: element.nextSibling,
        restore: {
          muted: element.muted,
          volume: element.volume,
          rate: element.playbackRate,
          controls: element.controls,
          // We clear loop while the clip is in the overlay; a tweet player that was looping
          // must get that back when it returns to the timeline.
          loop: element.loop
        }
      }
      lane.userPaused = false

      element.controls = false
      element.loop = false
      element.classList.add('tt-moved')

      // The page owns this element, so the page can stop it. The guard goes into the page's
      // own compartment and is then proved from that side: a guard the page cannot see is
      // exactly the bug that made several columns keep pausing, and it looked healthy from
      // here for three releases.
      lane.guard = installGuard(element)
      if (!probeGuard(lane.guard)) this.noteUnguarded()
      // Start the clip from its beginning. A borrowed player may also arrive with a stale
      // `ended` flag from the timeline's own use of it; seeking to zero clears that, so the
      // new clip is not mistaken for a finished one on the first paint.
      try {
        element.currentTime = 0
      } catch {
        /* a live player may refuse the seek; the mount guard gives it a chance to recover */
      }
      lane.mountTime = element.currentTime
      const mountDuration = element.duration
      lane.endedBeforeMount = Boolean(
        element.ended ||
          (Number.isFinite(mountDuration) && mountDuration > 1 && element.currentTime >= mountDuration - 1)
      )
      lane.sawProgress = false
      lane.endRechecked = false
      lane.refs.stage.replaceChildren(element)

      // Only events that change behaviour are bound. Progress painting is driven by
      // one shared timer, so three videos don't each force layout on every
      // timeupdate (which fires ~4x/second per element).
      lane.handlers = {
        ended: () => this.onLaneEnded(lane.slot, 'event'),
        error: () => this.onLaneError(lane.slot),
        seeking: () => this.paintLaneProgress(lane)
      }
      for (const [type, handler] of Object.entries(lane.handlers)) {
        element.addEventListener(type, handler)
      }

      element.playbackRate = this.rate
      this.applyAudioToLane(lane)
      this.tryPlay(lane, 3)
      return true
    }

    mountImage(lane, item) {
      const img = document.createElement('img')
      img.className = 'tt-tile-image'
      img.setAttribute('src', item.src)
      img.setAttribute('alt', 'Tweet image')
      img.draggable = false
      lane.mounted = null
      lane.image = img
      lane.refs.stage.replaceChildren(img)

      const seconds = clamp(Number(this.getSettings().imageSeconds) || 3, 1, 60)
      lane.totalMs = Math.round(seconds * 1000)
      lane.leftMs = lane.totalMs
      lane.startedAt = performance.now()
      lane.userPaused = false
      this.restartLaneTimer(lane)
      return true
    }

    unmountLane(lane, { keepHistory = false } = {}) {
      this.stopLaneTimers(lane)
      this.detachLaneHandlers(lane)
      clearTimeout(lane.errorResetTimer)
      lane.errorResetTimer = null

      const mounted = lane.mounted
      lane.mounted = null
      lane.image = null
      lane.userPaused = false
      lane.finished = false
      lane.finishedAt = 0
      lane.retriedError = false
      lane.paintedRatio = -1

      if (mounted?.element) {
        const { element, parent, next, restore } = mounted
        try {
          if (lane.nativePause) lane.nativePause()
          else element.pause()
        } catch {
          /* ignore */
        }
        // Hand the element back with the guard it arrived with. The page's own view is
        // restored too: leaving it unstoppable would break the timeline after a close.
        releaseGuard(lane.guard)
        lane.guard = null
        lane.nativePause = null
        lane.nativeLoad = null
        element.classList.remove('tt-moved')
        if (restore) {
          try {
            element.muted = restore.muted
            element.volume = restore.volume
            element.playbackRate = restore.rate
            element.controls = restore.controls
            element.loop = restore.loop
          } catch {
            /* ignore */
          }
        }
        // Put the timeline element back exactly as we found it.
        if (lane.refs.stage && element.parentNode === lane.refs.stage) {
          if (parent?.isConnected) {
            if (next?.parentNode === parent) parent.insertBefore(element, next)
            else parent.append(element)
          }
        }
      }
      if (lane.refs.stage) lane.refs.stage.replaceChildren()
      if (!keepHistory) {
        lane.history = []
        lane.historyPos = -1
      }
      lane.index = -1
      lane.handlers = null
    }

    detachLaneHandlers(lane) {
      const element = lane.mounted?.element
      if (!element || !lane.handlers) return
      for (const [type, handler] of Object.entries(lane.handlers)) {
        element.removeEventListener(type, handler)
      }
    }

    showLaneEmpty(lane) {
      lane.refs.tile.classList.add('is-empty')
      lane.refs.stage.replaceChildren()
      lane.refs.badge.textContent = '-'
      lane.refs.fill.style.transform = 'scaleX(0)'
      lane.paintedRatio = 0
      // "No more videos" is only honest once the queue really is empty AND the optimistic
      // search has given up. While it is still scrolling, or has rounds left to spend, the
      // column is waiting for a clip, not announcing the end of the timeline.
      const searching = this.topUpRunning || this.dryTopUps < TOPUP_DRY_ROUNDS
      const pending = this.nextIndex < this.items.length || searching
      lane.refs.tile.classList.toggle('is-pending', pending)
      if (lane.refs.note) lane.refs.note.textContent = pending ? '' : 'No more videos'
    }

    // -- lane events ----------------------------------------------------------

    async onLaneEnded(slot, reason = 'measured') {
      const lane = this.laneAt(slot)
      if (!lane || lane.idle || !this.active) return
      // A user-paused clip stays held even if the page reports an end; resuming is the
      // viewer's decision, not a reason to pull a different clip into the column.
      if (lane.userPaused) return
      // `ended`, the clip's position and the stall watchdog can all notice the same finish.
      if (lane.advancing || lane.finished) return
      // A player that arrived at the end of its previous playback can emit `ended` (or look
      // ended to the position check) before the seek to zero has taken effect. Give it one
      // retry instead of spending the clip instantly.
      const now = performance.now()
      const element = lane.video
      if (lane.endedBeforeMount && !lane.sawProgress && lane.mountedAt && now - lane.mountedAt < MOUNT_END_GUARD_MS) {
        if (!lane.endRechecked && element) {
          lane.endRechecked = true
          try {
            element.currentTime = 0
          } catch {
            /* the seek may be refused; tryPlay() is still worth one attempt */
          }
        }
        this.tryPlay(lane, 2)
        return
      }
      lane.advancing = true
      lane.stalledSince = 0
      try {
        const retiring = lane.video
        lane.lastAdvance = {
          reason,
          at: retiring ? Math.round(retiring.currentTime * 10) / 10 : null,
          duration:
            retiring && Number.isFinite(retiring.duration) ? Math.round(retiring.duration * 10) / 10 : null
        }
        // Hold the last frame instead of emptying the tile. The player stays mounted (and is
        // put back when the next clip replaces it, or when the grace period expires), so an
        // ordinary advance never flashes "No more videos" while the next clip is being fetched.
        lane.finished = true
        lane.finishedAt = performance.now()
        // It is parked on purpose now, not stalled: clear the amber waiting marker, and stop
        // an image's progress ticker (it has nothing left to count).
        lane.refs?.tile?.classList.remove('is-waiting')
        if (lane.image) this.stopLaneTimers(lane)
        const element = lane.video
        if (element) {
          try {
            if (lane.nativePause) lane.nativePause()
            else element.pause()
          } catch {
            /* a player that cannot pause is still leaving the tile shortly */
          }
        }
        this.refreshChrome()
      } catch (error) {
        // Called from a timer and from event handlers, so an error here would otherwise become
        // an unhandled rejection and leave the column exactly as stuck as the bug.
        console.warn('[timeline-tv] advancing a column failed:', error?.message ?? error)
      } finally {
        lane.advancing = false
      }
    }

    /**
     * Give a lane the next item that can actually be played.
     *
     * A queue entry can become unplayable between collection and use: X unloads
     * tweets, re-renders them, or the element goes away while we were playing
     * something else. Consuming that entry and giving up would leave the column
     * showing "No more videos" even though the queue still has items, so walk
     * forward until something mounts.
     *
     * Playability is checked BEFORE mountLane(), because mounting always unmounts the current
     * clip first. A lane that is holding the last frame of the previous clip must not lose it
     * to a queue entry that turns out to have no player any more.
     *
     * @returns {boolean} false only when the queue is genuinely drained
     */
    pullInto(lane) {
      for (let attempt = 0; attempt <= SKIP_LIMIT; attempt++) {
        const index = this.takeIndex()
        if (index == null) return false
        const item = this.items[index]
        if (!this.itemCanMount(item)) continue
        if (this.mountLane(lane, index, 'push')) return true
      }
      return false
    }

    /** Would mounting this item put something in the tile, without touching the lane? */
    itemCanMount(item) {
      if (!item) return false
      if (item.kind === 'image') return true
      if (directSource(item.src)) return true
      const element = this.videoElementFor(item)
      return Boolean(element && element.parentNode)
    }

    /**
     * Say it once, and only once: when the page's own view cannot be guarded, this column can
     * still be paused by X and the keep-alive is the only thing holding it up. That is worth
     * one honest line, not an interruption every time a column changes clip.
     */
    noteUnguarded() {
      this.unguarded = (this.unguarded ?? 0) + 1
      if (this.unguarded > 1) return
      console.warn('[timeline-tv] could not guard the page player; falling back to the keep-alive')
      this.toast('X can still pause these players — Shift+D for details')
    }

    /**
     * Keeps a column playing when something outside this add-on pauses it.
     *
     * X pauses players it does not consider primary, and it does so while the element
     * is still buffering - so reacting to the `pause` event and bailing when
     * networkState was LOADING skipped almost every real case, which left only one
     * column running. Equally, resuming on *every* pause event produced a tight
     * play/pause loop, which is what made the audio stutter.
     *
     * The paint loop therefore re-checks state instead of reacting to events: if a lane
     * should be playing but is paused, resume it, at most once per RESUME_INTERVAL_MS.
     * Gentle, sustained, and it never gives up.
     *
     * Deliberately no "paused too long, move on" rule in here: that was abandoning clips
     * mid-way whenever X paused or slowed a player. Moving on from a player that cannot play is
     * watchPlayer's job, and it only does it for an element that is not buffering.
     */
    keepAlive(now) {
      for (const lane of this.lanes) {
        if (lane.idle || lane.finished || lane.userPaused || lane.advancing) continue
        const element = lane.video
        if (!element || element.ended || !element.paused) continue

        if (!lane.stalledSince) lane.stalledSince = now
        if (now - (lane.lastResumeAt || 0) < RESUME_INTERVAL_MS) continue

        lane.lastResumeAt = now
        lane.resumes += 1
        element.play().catch(() => {})
        // The page may have muted the player while pausing it. Put our own audio state back,
        // or a column the viewer unmuted comes back silent.
        this.applyAudioToLane(lane)
      }
    }

    onLaneError(slot) {
      const lane = this.laneAt(slot)
      if (!lane || lane.idle || lane.finished) return
      // MEDIA_ERR_ABORTED: the page aborted its own request (common when X reuses a player it
      // just removed). The source is not broken, and treating it as one skipped the clip.
      if (lane.video?.error?.code === 1) return

      // A media error is usually transient, so reload and try again rather than dropping
      // the clip. The flag is per lane: a single shared flag meant one column's error made
      // every other column skip its clip immediately.
      if (!lane.retriedError) {
        lane.retriedError = true
        clearTimeout(lane.errorResetTimer)
        lane.errorResetTimer = setTimeout(() => {
          lane.retriedError = false
          lane.errorResetTimer = null
        }, 5000)
        if (lane.nativeLoad) lane.nativeLoad()
        else if (lane.mounted?.own) {
          // Our own element has no guard in the way; load() is the retry.
          try {
            lane.video?.load()
          } catch {
            /* a broken source is stepped over below if the reload did not help */
          }
        }
        this.tryPlay(lane, 2)
        return
      }

      // Failed again after a reload, so this source really is broken.
      lane.retriedError = false
      this.skips++
      if (this.skips > SKIP_LIMIT) {
        // Do not leave the broken player on screen after the cap: the column has nothing
        // playable to show and should say so rather than freeze silently.
        this.skips = 0
        this.unmountLane(lane, { keepHistory: true })
        this.showLaneEmpty(lane)
        return
      }
      if (!this.pullInto(lane)) {
        // pullInto() only replaces the player when it finds a playable item. If it did not,
        // the errored element is still mounted; retire it before showing an empty tile.
        this.unmountLane(lane, { keepHistory: true })
        this.showLaneEmpty(lane)
      }
    }

    tryPlay(lane, retries = 2) {
      const element = lane.video
      if (!element) return
      let promise
      try {
        promise = element.play()
      } catch {
        return
      }
      if (!promise?.catch) return
      promise.catch((error) => {
        if (retries > 0) {
          setTimeout(() => this.tryPlay(lane, retries - 1), 130)
          return
        }
        console.warn('[timeline-tv] playback blocked:', error?.message ?? error)
      })
    }

    async loadMore(token) {
      const before = this.items.length
      for (let attempt = 0; attempt < 3; attempt++) {
        if (!this.active || token !== this.loadToken) return false
        this.collector.collect()
        if (this.items.length > before) {
          // The timeline produced something, so the optimistic search gets its budget back.
          this.dryTopUps = 0
          return true
        }
        window.scrollBy(0, Math.round(window.innerHeight * 0.8))
        await sleep(500 + attempt * 250)
        if (!this.active || token !== this.loadToken) return false
        this.collector.collect()
        if (this.items.length > before) {
          this.dryTopUps = 0
          return true
        }
      }
      return false
    }

    // -- navigation -----------------------------------------------------------

    /**
     * The column showing the clip that started longest ago. Queue positions are claimed
     * in order, so the lowest index is the oldest clip on screen.
     */
    oldestLane() {
      let oldest = null
      for (const lane of this.lanes) {
        if (lane.idle) continue
        if (!oldest || lane.index < oldest.index) oldest = lane
      }
      return oldest
    }

    /**
     * Next advances the OLDEST column rather than the focused one, and focuses whatever it
     * advanced. Because the advanced column then holds the newest index, repeated presses
     * rotate through the columns in order.
     */
    async nextItem() {
      if (!this.active) return
      const lane = this.oldestLane() || this.focusedLane
      if (!lane) return
      this.focusSlot = lane.slot
      this.paintFocus()
      if (this.pullInto(lane)) {
        this.refreshChrome()
        return
      }
      const token = ++this.loadToken
      const grew = await this.loadMore(token)
      if (!this.active || token !== this.loadToken) return
      if (!grew || !this.pullInto(lane)) this.toast('End of the timeline')
    }

    prevItem() {
      const lane = this.focusedLane
      if (!lane || !this.active) return
      if (lane.historyPos <= 0) {
        this.toast('Nothing before this')
        return
      }
      const target = lane.history[lane.historyPos - 1]
      if (target == null) return
      this.unmountLane(lane, { keepHistory: true })
      if (this.mountLane(lane, target, 'none')) {
        lane.historyPos -= 1
        this.paintLane(lane)
      }
    }

    togglePlay() {
      const lane = this.focusedLane
      if (lane) this.toggleLanePlayback(lane)
    }

    toggleLanePlayback(lane) {
      if (!lane) return
      // A finished clip is parked on its last frame waiting for the next one. Play/pause has
      // nothing to act on until the fill replaces it.
      if (lane.finished) return
      if (lane.image) {
        lane.userPaused = !lane.userPaused
        if (lane.userPaused) {
          this.freezeLaneTimer(lane)
        } else {
          lane.startedAt = performance.now()
          this.restartLaneTimer(lane)
        }
        this.refreshChrome()
        return
      }
      const element = lane.video
      if (!element) return
      if (element.paused) {
        lane.userPaused = false
        element.play().catch(() => {})
      } else {
        lane.userPaused = true
        if (lane.nativePause) lane.nativePause()
        else element.pause()
      }
      this.refreshChrome()
    }

    // -- per-lane timers ------------------------------------------------------

    restartLaneTimer(lane) {
      this.stopLaneTimers(lane)
      lane.ticker = setInterval(() => {
        this.paintLaneProgress(lane)
      }, 100)
      lane.timer = setTimeout(() => {
        if (!lane.userPaused) this.onLaneEnded(lane.slot, 'image-timer')
      }, Math.max(150, lane.leftMs))
    }

    freezeLaneTimer(lane) {
      lane.leftMs = Math.max(0, lane.leftMs - (performance.now() - lane.startedAt))
      this.stopLaneTimers(lane)
      this.paintLaneProgress(lane)
    }

    stopLaneTimers(lane) {
      clearInterval(lane.ticker)
      clearTimeout(lane.timer)
      lane.ticker = null
      lane.timer = null
    }

    // -- audio ----------------------------------------------------------------

    /**
     * Up/Down change the one volume shared by every column. Adjusting the volume is also an
     * explicit unmute, so the keys always produce the level the toast reports; reaching zero
     * leaves the master muted rather than silently at 0 with a misleading speaker icon.
     */
    adjustVolume(delta) {
      if (!this.active) return
      const current = clamp(Number(this.volume) || 0, 0, 1)
      const next = clamp(Math.round((current + delta) * 100) / 100, 0, 1)
      this.volume = next
      this.masterMuted = next === 0
      // The initial state is every column muted plus the master. A volume key is an explicit
      // "make this audible" gesture, so clear that all-muted default; if the viewer has left
      // some columns audible, keep their per-column choices intact.
      if (next > 0 && this.lanes.length && this.lanes.every((lane) => lane.muted)) {
        for (const lane of this.lanes) lane.muted = false
      }
      this.applyAudio()
      this.toast(next === 0 ? 'Muted' : `Volume ${Math.round(next * 100)}%`)
    }

    /** Master mute applies on top of each column's own mute flag. */
    applyAudio() {
      for (const lane of this.lanes) {
        this.applyAudioToLane(lane)
        this.paintLaneMute(lane)
      }
      this.refreshAudioUi()
    }

    applyAudioToLane(lane) {
      const element = lane.video
      if (!element) return
      const silent = this.masterMuted || lane.muted || this.volume === 0
      try {
        element.muted = silent
        element.volume = silent ? 0 : clamp(this.volume, 0, 1)
      } catch {
        /* ignore */
      }
    }

    /**
     * Resume a column after a gesture that lifts autoplay blocking.
     *
     * A paused image is driven by its own timeout, not by the element's play(), so clearing
     * userPaused alone left it frozen with no timer to finish it. Restarting that timer is
     * the image equivalent of calling play().
     */
    resumeLane(lane) {
      if (!lane || lane.idle || lane.finished) return
      if (lane.image) {
        if (!lane.userPaused) return
        lane.userPaused = false
        lane.startedAt = performance.now()
        this.restartLaneTimer(lane)
        return
      }
      lane.userPaused = false
      this.tryPlay(lane, 2)
    }

    toggleLaneMute(slot) {
      const lane = this.laneAt(slot)
      if (!lane) return
      lane.muted = !lane.muted
      if (!lane.muted) {
        // Unmuting is a gesture inside the page, which also lifts autoplay blocking.
        this.masterMuted = false
        if (this.volume === 0) this.volume = 0.5
        this.resumeLane(lane)
      }
      this.applyAudio()
      this.toast(`Column ${slot + 1} ${lane.muted ? 'muted' : 'unmuted'}`)
    }

    /**
     * Make every column audible in one action.
     *
     * Each column carries its own mute flag, and the master mute only clears its own - so with
     * eight columns, hearing them all meant clicking eight speakers. This clears both, picks a
     * usable volume if the slider had been pulled to zero, and resumes the columns: unmuting is
     * a gesture inside the page, which is also what lets Firefox start audible playback at all.
     */
    unmuteAll() {
      if (!this.lanes.length) return
      this.masterMuted = false
      if (this.volume === 0) this.volume = 0.5
      let audible = 0
      for (const lane of this.lanes) {
        lane.muted = false
        if (lane.idle) continue
        audible += 1
        this.resumeLane(lane)
      }
      this.applyAudio()
      if (!audible) this.toast('Nothing to unmute yet')
      else if (audible === this.lanes.length) this.toast(`${audible} columns audible`)
      else this.toast(`${audible} of ${this.lanes.length} columns audible`)
    }

    paintLaneMute(lane) {
      const refs = lane.refs
      if (!refs?.mute) return
      refs.tile.classList.toggle('is-muted', lane.muted)
      refs.mute.innerHTML = svg(lane.muted ? 'mute' : 'volume')
      refs.mute.setAttribute('aria-label', lane.muted ? 'Unmute this column' : 'Mute this column')
    }

    setRate(rate) {
      this.rate = clamp(rate, 0.25, 3)
      for (const lane of this.lanes) {
        const element = lane.video
        if (!element) continue
        try {
          element.playbackRate = this.rate
        } catch {
          /* ignore */
        }
      }
      this.refreshRateUi()
      this.toast(`${formatRate(this.rate)} speed`)
    }

    // -- rendering ------------------------------------------------------------

    paintLane(lane) {
      const refs = lane.refs
      if (!refs) return
      refs.badge.textContent = lane.index >= 0 ? String(lane.index + 1) : '-'
      refs.tile.classList.toggle('is-empty', lane.idle)
      this.paintLaneMute(lane)
      this.paintLaneProgress(lane)
    }

    paintLaneProgress(lane) {
      const refs = lane.refs
      if (!refs) return
      let ratio = 0
      if (lane.finished) {
        // The player is parked at the end of its own clip; show it as complete while the next
        // one is looked for, not as a tile that has lost its progress.
        ratio = 1
      } else if (lane.image && lane.totalMs > 0) {
        const left = lane.userPaused
          ? lane.leftMs
          : Math.max(0, lane.leftMs - (performance.now() - lane.startedAt))
        ratio = clamp((lane.totalMs - left) / lane.totalMs, 0, 1)
      } else {
        const element = lane.video
        if (element) {
          const duration = element.duration
          ratio = Number.isFinite(duration) && duration > 0 ? clamp(element.currentTime / duration, 0, 1) : 0
        }
      }
      // Don't rewrite an unchanged transform five times a second on every tile: a frozen or
      // idle tile should cost nothing at all.
      if (ratio === lane.paintedRatio) return
      lane.paintedRatio = ratio
      refs.fill.style.transform = `scaleX(${ratio})`
    }

    refreshChrome() {
      this.refreshPlayUi()
      this.refreshAudioUi()
      this.refreshCount()
    }

    refreshPlayUi() {
      if (!this.ui.play) return
      const lane = this.focusedLane
      const element = lane?.video
      const isPaused = lane?.image ? lane.userPaused : !element || element.paused
      this.ui.play.innerHTML = svg(isPaused ? 'play' : 'pause')
      this.ui.play.setAttribute('aria-label', isPaused ? 'Play' : 'Pause')
    }

    refreshAudioUi() {
      if (!this.ui.mute) return
      const silent = this.masterMuted || this.volume === 0
      this.ui.mute.innerHTML = svg(silent ? 'mute' : 'volume')
      this.ui.mute.setAttribute('aria-label', silent ? 'Unmute every column' : 'Mute every column')
      if (this.ui.volume) this.ui.volume.value = String(silent ? 0 : this.volume)

      // The bulk control reports as well as acts: lit means every column is already audible,
      // so nobody has to click it twice to find out what state the grid is in.
      if (this.ui.unmute) {
        const allAudible = this.lanes.length > 0 && !silent && this.lanes.every((lane) => !lane.muted)
        this.ui.unmute.classList.toggle('is-on', allAudible)
        this.ui.unmute.setAttribute('aria-label', allAudible ? 'Every column is audible' : 'Unmute every column')
        this.ui.unmute.setAttribute('aria-pressed', String(allAudible))
      }
    }

    refreshRateUi() {
      if (!this.ui.rate) return
      this.ui.rate.textContent = formatRate(this.rate)
      for (const button of this.ui.menu?.querySelectorAll('button') ?? []) {
        if (Number(button.getAttribute('data-rate')) === this.rate) button.setAttribute('data-on', '1')
        else button.removeAttribute('data-on')
      }
    }

    refreshCount() {
      if (!this.ui.count) return
      const total = this.items.length
      const lane = this.focusedLane
      const position = lane && lane.index >= 0 ? lane.index + 1 : 0
      this.ui.count.textContent = total ? `${position || '-'}/${total}` : '-/-'
    }

    /**
     * Per-column playback health. droppedVideoFrames is the honest measure of whether
     * the compositor is keeping up; resumes shows whether this add-on has to fight X for
     * control of a player.
     */
    diagnostics() {
      if (!this.active) return []
      return this.lanes.map((lane) => {
        const element = lane.video
        const quality = element?.getVideoPlaybackQuality?.()
        return {
          slot: lane.slot,
          index: lane.index,
          focused: lane.slot === this.focusSlot,
          muted: lane.muted,
          paused: element ? element.paused : null,
          ended: element ? Boolean(element.ended) : null,
          readyState: element?.readyState ?? null,
          networkState: element?.networkState ?? null,
          seeking: element ? Boolean(element.seeking) : null,
          currentTime: element ? Math.round(element.currentTime * 10) / 10 : null,
          duration:
            element && Number.isFinite(element.duration) ? Math.round(element.duration * 10) / 10 : null,
          resolution: element ? `${element.videoWidth || 0}x${element.videoHeight || 0}` : null,
          // 'own' means the page holds no reference to this player at all. 'moved' means the
          // page owns it, so the guard in the page's compartment is what keeps it playing.
          source: lane.image ? 'image' : lane.mounted?.own ? 'own' : element ? 'moved' : null,
          guard: lane.guard
            ? lane.guard.verified
              ? 'page'
              : lane.guard.installed
                ? 'unverified'
                : 'not-reached'
            : null,
          blockedPauses: lane.guard?.blocked ?? 0,
          connected: element ? element.isConnected !== false : null,
          // True while the tile is deliberately holding its last frame, waiting for the next
          // clip or for the "no more videos" grace period to expire.
          finished: lane.finished,
          // { reason, at, duration } for the clip that just left this column. A reason other
          // than 'event'/'measured' explains why a clip was retired before its end.
          lastAdvance: lane.lastAdvance,
          reroutes: lane.reroutes,
          stallRestarts: lane.stallRestarts,
          resumes: lane.resumes,
          droppedFrames: quality ? quality.droppedVideoFrames : null,
          totalFrames: quality ? quality.totalVideoFrames : null
        }
      })
    }

    /**
     * Asks the browser whether the focused stream is being hardware decoded.
     *
     * powerEfficient === true is the browser saying "this decode runs on dedicated video
     * hardware". If it is false, the lag is a software-decode problem and no add-on code
     * can fix it - the fix is Firefox's media.hardware-video-decoding prefs or the GPU.
     */
    async decodeCapabilities() {
      if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) return null
      const element = this.focusedLane?.video
      if (!element) return null
      const width = element.videoWidth || 1280
      const height = element.videoHeight || 720
      try {
        const info = await navigator.mediaCapabilities.decodingInfo({
          type: 'file',
          video: {
            contentType: 'video/mp4; codecs="avc1.640028"',
            width,
            height,
            bitrate: 4_000_000,
            framerate: 30
          }
        })
        return {
          supported: info.supported,
          smooth: info.smooth,
          powerEfficient: info.powerEfficient,
          resolution: `${width}x${height}`
        }
      } catch {
        return null
      }
    }

    /** Shift+D: one line the user can act on. */
    async reportHealth() {
      const lanes = this.diagnostics()
      if (!lanes.length) {
        this.toast('No columns playing')
        return
      }
      const dropped = lanes.reduce((sum, lane) => sum + (lane.droppedFrames ?? 0), 0)
      const total = lanes.reduce((sum, lane) => sum + (lane.totalFrames ?? 0), 0)
      const pct = total > 0 ? Math.round((dropped / total) * 100) : 0
      const resumeTotal = lanes.reduce((sum, lane) => sum + (lane.resumes ?? 0), 0)
      // The line that answers "is the page still able to stop a column?" without anyone having
      // to read a console: whether each borrowed player is guarded where the page can see it,
      // and how many pause/load calls the guard has already swallowed.
      const borrowed = lanes.filter((lane) => lane.source === 'moved')
      const guarded = borrowed.filter((lane) => lane.guard === 'page')
      const blocked = lanes.reduce((sum, lane) => sum + (lane.blockedPauses ?? 0), 0)
      const guard =
        borrowed.length === 0
          ? 'own players'
          : guarded.length === borrowed.length
            ? `guarded ${blocked}`
            : `UNGUARDED ${borrowed.length - guarded.length}`
      const decode = await this.decodeCapabilities()
      const accel = decode ? (decode.powerEfficient ? 'HW decode' : 'SOFTWARE decode') : 'decode unknown'
      // Reasons other than the player saying it ended / the playhead reaching the end. If this
      // climbs while clips still had time left, the column was retired by the watchdog.
      const early = lanes.filter(
        (lane) => lane.lastAdvance && !['event', 'measured', 'image-timer'].includes(lane.lastAdvance.reason)
      ).length
      this.toast(
        `${lanes.length} cols · ${pct}% dropped · ${guard} · ${resumeTotal} resumes · ${accel}` +
          (early ? ` · ${early} retired early` : '')
      )
      console.log('[timeline-tv] playback health', {
        lanes,
        decode,
        search: {
          items: this.items.length,
          nextIndex: this.nextIndex,
          dryTopUps: this.dryTopUps,
          topUpRunning: this.topUpRunning,
          itemsSeen: this.itemsSeen
        }
      })
    }

    // -- keyboard -------------------------------------------------------------

    onKeyDown(event) {
      if (!this.active) return
      if (event.altKey || event.ctrlKey || event.metaKey) return
      const target = event.composedPath?.()[0]
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? '')) return
      // X's composer is a contenteditable div, not an input. Without this, starting the overlay
      // with the composer focused turned typed letters and Space into player shortcuts.
      if (target?.isContentEditable || target?.closest?.('[contenteditable="true"], [contenteditable=""]')) return
      if (event.isComposing) return

      // Shift+D reports playback health, which is how you tell "decoder is saturated"
      // apart from "X keeps pausing a background player".
      if (event.shiftKey && event.key.toLowerCase() === 'd') {
        this.reportHealth()
        event.preventDefault()
        event.stopPropagation()
        return
      }

      switch (event.key) {
        case 'Escape':
          this.stop()
          break
        case 'ArrowLeft':
          this.prevItem()
          break
        case 'ArrowRight':
          this.nextItem()
          break
        case 'ArrowUp':
          this.adjustVolume(VOLUME_STEP)
          break
        case 'ArrowDown':
          this.adjustVolume(-VOLUME_STEP)
          break
        case ' ':
        case 'k':
          this.togglePlay()
          break
        case 'm':
          this.masterMuted = !this.masterMuted
          this.applyAudio()
          break
        case 'u':
          this.unmuteAll()
          break
        case 'Tab':
          // Move the focused tile without leaving the overlay.
          if (this.lanes.length > 1) {
            const step = event.shiftKey ? -1 : 1
            this.focusSlot = (this.focusSlot + step + this.lanes.length) % this.lanes.length
            this.pinned = true
            this.paintFocus()
            this.refreshChrome()
            break
          }
          return
        default:
          return
      }
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // --------------------------------------------------------------- messaging ---

  let settings = { ...DEFAULTS }
  let current = null
  // The in-flight start() promise, if one is running. A toggle that arrives while the overlay
  // is still being built joins it instead of creating a second overlay.
  let starting = null

  /**
   * The version of the add-on this script was loaded from.
   *
   * Read once and cached: it cannot change while this copy of the code is running, and that is
   * the point - it tells the popup whether the tab is still on an older injection.
   */
  let cachedVersion = null
  function extensionVersion() {
    if (cachedVersion === null) {
      try {
        cachedVersion = api.runtime?.getManifest?.()?.version ?? ''
      } catch {
        cachedVersion = ''
      }
    }
    return cachedVersion
  }

  async function loadSettings() {
    try {
      const stored = await api.storage.sync.get(DEFAULTS)
      settings = {
        includeImages: Boolean(stored.includeImages),
        imageSeconds: clamp(Number(stored.imageSeconds) || DEFAULTS.imageSeconds, 1, 60),
        columns: clamp(Number(stored.columns) || DEFAULTS.columns, 1, MAX_COLUMNS)
      }
    } catch {
      settings = { ...DEFAULTS }
    }
    return settings
  }

  function getSettings() {
    return settings
  }

  async function toggle(options) {
    if (options) {
      settings = {
        includeImages: Boolean(options.includeImages ?? settings.includeImages),
        imageSeconds: clamp(Number(options.imageSeconds) || settings.imageSeconds, 1, 60),
        columns: clamp(Number(options.columns) || settings.columns, 1, MAX_COLUMNS)
      }
    } else if (!current?.active) {
      // A stopped overlay leaves `current` pointing at it. Reload rather than trusting the
      // settings this content script read at page load, which may have changed in the popup.
      await loadSettings()
    }

    if (current?.active) {
      const result = current.stop()
      current = null
      return result
    }
    // Starting is asynchronous (it may scroll to find media), and `current` is only assigned
    // when it finishes. A second toggle in that window used to build a second overlay.
    if (starting) return starting
    const show = new Slideshow(getSettings)
    starting = (async () => {
      const result = await show.start()
      if (result.ok) {
        current = show
        return { ...result, active: true }
      }
      current = null
      return { ...result, active: false }
    })()
    try {
      return await starting
    } finally {
      starting = null
    }
  }

  api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return false
    const respond = (promise) => {
      promise
        .then((value) => sendResponse(value))
        .catch((error) => sendResponse({ ok: false, message: String(error?.message ?? error) }))
      return true
    }
    switch (message.type) {
      case 'tt:toggle':
        return respond(toggle(message.options))
      case 'tt:start':
        if (current?.active) {
          return respond(Promise.resolve({ ok: true, active: true, message: 'Slideshow is already open.' }))
        }
        return respond(toggle(message.options))
      case 'tt:stop':
        return respond(
          (async () => {
            // Stop can arrive while start() is still looking for media. Let it finish opening
            // and then close it, rather than reporting "not running" and leaving it open.
            if (starting) {
              try {
                await starting
              } catch {
                /* a failed start has nothing to stop */
              }
            }
            const result = current ? current.stop() : { ok: true, active: false, message: 'Slideshow is not running.' }
            current = null
            return result
          })()
        )
      case 'tt:state':
        return respond(
          Promise.resolve({
            ok: true,
            active: Boolean(current?.active),
            count: current?.items.length ?? 0,
            columns: current?.columns ?? 0,
            // The running copy of this script, which is not necessarily the installed add-on:
            // a content script is injected at page load and never hot-reloads, so an updated
            // add-on leaves every open tab on the old code until it is reloaded. The popup
            // compares this with its own version instead of leaving it to be guessed at.
            version: extensionVersion()
          })
        )
      case 'tt:diagnostics':
        return respond(
          (async () => ({
            ok: true,
            lanes: current?.diagnostics() ?? [],
            decode: current ? await current.decodeCapabilities() : null
          }))()
        )
      default:
        return false
    }
  })

  loadSettings()

  window.addEventListener('pagehide', () => current?.teardown(), { capture: true })
})()
