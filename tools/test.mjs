// test.mjs — verification harness for Timeline TV.
//
// There is no jsdom available here, so this file ships a small but real DOM:
// a nested HTML parser, a selector engine, events, Shadow DOM, and media stubs.
// The content script is then run inside a Node VM and driven through its public
// message API, which is the surface the popup and the keyboard command use.
//
//   node tools/test.mjs .
//
// Sections:
//   T1  syntax + MV3 CSP safety for every JS file
//   T2  Firefox and Chrome MV3 manifests, permissions, referenced files, popup markup
//   T2b Chrome MAIN-world page guard behaviour
//   T3  markup <-> JS contract: every element the content script looks up exists
//   T4  collection: videos, per-tweet slots, images, unplayable skips, dedupe
//   T5  lifecycle: open, media moves into the shadow overlay, restore on close
//   T6  keyboard + message API (toggle / state / stop), and no leaked timers
//   T7  background command wiring
//   T8  icon files are real PNGs at the declared sizes

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import { chromeManifest, CHROME_MIN_VERSION } from './manifest.mjs'

const ROOT = process.argv[2] || '.'
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8')

let passed = 0
const failures = []
const ok = (cond, label, detail) => {
  if (cond) {
    passed++
    console.log(`  PASS  ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL  ${label}${detail ? `\n          -> ${detail}` : ''}`)
  }
}
const eq = (a, b, label) => ok(a === b, label, `expected ${show(b)}, got ${show(a)}`)

/** Safe rendering for assertion details (DOM nodes are circular). */
function show(value) {
  if (value === null || value === undefined) return String(value)
  if (typeof value === 'object') {
    if (value.tagName) return `<${String(value.tagName).toLowerCase()}${value.id ? `#${value.id}` : ''}>`
    try {
      return JSON.stringify(value)
    } catch {
      return '[object]'
    }
  }
  return JSON.stringify(value)
}
const section = (t) => console.log(`\n== ${t} ==`)
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')

// ------------------------------------------------------------- HTML parsing ---

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', '!doctype'])

function decodeEntities(text) {
  return text
    .replace(/&ndash;/g, '\u2013')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&times;/g, '\u00d7')
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", nbsp: '\u00a0' }[e]))
}

/** Parse an attribute string into a plain object. */
function parseAttrs(source) {
  const attrs = {}
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g
  let m
  while ((m = re.exec(source))) {
    const value = m[2] ?? m[3] ?? m[4]
    attrs[m[1].toLowerCase()] = value === undefined ? '' : decodeEntities(value)
  }
  return attrs
}

/** Build a node tree from HTML text. Good enough for the markup this add-on uses. */
function parseHtml(html, makeElement) {
  const root = { children: [] }
  const stack = [{ node: root }]
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z!][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g
  let m
  while ((m = re.exec(html))) {
    const top = stack[stack.length - 1].node
    if (m[5] !== undefined) {
      const text = decodeEntities(m[5])
      if (text.trim()) {
        top.text = (top.text ?? '') + text
      }
      continue
    }
    if (m[2] === undefined) continue // comment
    const closing = m[1] === '/'
    const tag = m[2].toLowerCase()
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].node.tagName?.toLowerCase() === tag) {
          stack.length = i
          break
        }
      }
      continue
    }
    const el = makeElement(tag)
    const attrs = parseAttrs(m[3] || '')
    for (const [k, v] of Object.entries(attrs)) {
      el.attrs.set(k, v)
      if (k === 'id') el.id = v
      if (k === 'class') el.classList.add(...v.split(/\s+/).filter(Boolean))
      if (k.startsWith('data-')) el.dataset[k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v
      if (k === 'hidden') el.hidden = true
      if (k === 'value') el.value = v
      if (k === 'title') el.title = v
    }
    top.children.push(el)
    el.parentNode = top === root ? null : top
    if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push({ node: el })
  }
  return root.children
}

// ---------------------------------------------------------- selector engine ---

function parseSimple(selector) {
  const parts = { tag: null, id: null, classes: [], attrs: [] }
  let i = 0
  const tag = /^[a-zA-Z][\w-]*/.exec(selector)
  if (tag) {
    parts.tag = tag[0].toLowerCase()
    i = tag[0].length
  }
  while (i < selector.length) {
    const rest = selector.slice(i)
    if (rest[0] === '#') {
      const m = /^#([\w-]+)/.exec(rest)
      if (!m) return null
      parts.id = m[1]
      i += m[0].length
    } else if (rest[0] === '.') {
      const m = /^\.([\w-]+)/.exec(rest)
      if (!m) return null
      parts.classes.push(m[1])
      i += m[0].length
    } else if (rest[0] === '[') {
      const m = /^\[\s*([\w-]+)\s*(?:([*^$~|]?=)\s*(?:"([^"]*)"|'([^']*)'|([^\]\s]*)))?\s*\]/.exec(rest)
      if (!m) return null
      parts.attrs.push({ name: m[1], op: m[2] || null, value: m[3] ?? m[4] ?? m[5] ?? null })
      i += m[0].length
    } else {
      return null
    }
  }
  return parts
}

function matchSimple(node, simple) {
  const parts = parseSimple(simple)
  if (!parts || !node.tagName) return false
  if (parts.tag && node.tagName.toLowerCase() !== parts.tag) return false
  if (parts.id && node.id !== parts.id) return false
  for (const c of parts.classes) if (!node.classList.contains(c)) return false
  for (const a of parts.attrs) {
    const value = node.attrs.has(a.name) ? node.attrs.get(a.name) : undefined
    if (value === undefined) return false
    if (a.op === '*=' && !String(value).includes(a.value)) return false
    if (a.op === '=' && String(value) !== a.value) return false
  }
  return true
}

function matches(node, selector) {
  return selector.split(',').some((group) => {
    const parts = group.trim().split(/\s+(?![^\[]*\])/).filter(Boolean)
    if (!parts.length) return false
    if (!matchSimple(node, parts[parts.length - 1])) return false
    let cur = node.parentNode
    for (let i = parts.length - 2; i >= 0; i--) {
      let found = false
      while (cur) {
        if (matchSimple(cur, parts[i])) {
          found = true
          cur = cur.parentNode
          break
        }
        cur = cur.parentNode
      }
      if (!found) return false
    }
    return true
  })
}

// --------------------------------------------------------------------- DOM ----

/**
 * The page's own JavaScript reflection of a node.
 *
 * A real DOM node has one JavaScript reflection per compartment, and Firefox's Xray vision
 * keeps a content script's reflection and the page's completely apart: a property written
 * from a content script is invisible to page code and vice versa. Modelling that is what
 * lets the suite test the thing that actually broke - a guard must be installed on the
 * PAGE's view or it does nothing. `wrappedJSObject` is that view, so it has a property
 * store of its own and falls back to the element's methods when nothing was installed.
 */
function pageViewFor(el) {
  if (el._pageView) return el._pageView
  const own = new Map()
  el._pageView = new Proxy(
    {},
    {
      get(_target, prop) {
        if (own.has(prop)) return own.get(prop)
        // Native DOM state is shared between compartments, a content script's own expandos are
        // not - so the page's view reads the prototype's implementation and never an override
        // the add-on wrote on the element from its own side of the wall.
        const native = Object.getOwnPropertyDescriptor(El.prototype, prop)
        if (native?.value && typeof native.value === 'function') return native.value.bind(el)
        const value = el[prop]
        return typeof value === 'function' ? value.bind(el) : value
      },
      set(_target, prop, value) {
        own.set(prop, value)
        return true
      },
      has: (_target, prop) => own.has(prop) || prop in el,
      deleteProperty(_target, prop) {
        return own.delete(prop)
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (!own.has(prop)) return undefined
        return { value: own.get(prop), writable: true, enumerable: true, configurable: true }
      },
      ownKeys: () => [...own.keys()]
    }
  )
  return el._pageView
}

class El {
  constructor(tagName) {
    this.tagName = String(tagName).toUpperCase()
    this.children = []
    this.parentNode = null
    this.attrs = new Map()
    this.dataset = {}
    this.style = {
      setProperty(name, value) {
        this[name] = String(value)
      }
    }
    this.id = ''
    this.hidden = false
    this.text = ''
    this.value = ''
    this.title = ''
    this._listeners = new Map()
    this._shadow = null
    this._html = ''
    const classes = new Set()
    this.classList = {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, force) => {
        const on = force === undefined ? !classes.has(c) : Boolean(force)
        if (on) classes.add(c)
        else classes.delete(c)
        return on
      },
      get size() {
        return classes.size
      },
      clear: () => classes.clear(),
      all: () => [...classes]
    }
    // media defaults
    this.src = ''
    this.currentSrc = ''
    this.duration = NaN
    this.currentTime = 0
    this.readyState = 0
    this.paused = true
    this.ended = false
    this.muted = false
    this.volume = 1
    this.playbackRate = 1
    this.loop = false
    this.controls = false
    this.playCalls = 0
    this.pauseCalls = 0
    this.loadCalls = 0
    this.playbackQuality = { droppedVideoFrames: 0, totalVideoFrames: 0 }
    this.getVideoPlaybackQuality = () => this.playbackQuality
  }

  get parentElement() {
    return this.parentNode
  }

  get isConnected() {
    let cur = this
    while (cur) {
      if (cur.tagName === '#DOCUMENT') return true
      // Shadow content is connected whenever its host is. Modelling a shadow root as
      // attached to nothing made every element inside the overlay look detached, which
      // silently broke any code that checks isConnected.
      if (cur.tagName === '#SHADOW' && cur.host) {
        cur = cur.host
        continue
      }
      cur = cur.parentNode
    }
    return false
  }

  /** The page's own view of this node - the side X's code reads and writes. */
  get wrappedJSObject() {
    return pageViewFor(this)
  }

  get nextSibling() {
    if (!this.parentNode) return null
    const siblings = this.parentNode.children
    const index = siblings.indexOf(this)
    return index >= 0 ? siblings[index + 1] ?? null : null
  }

  get firstElementChild() {
    return this.children[0] ?? null
  }

  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('')
    return this.text
  }

  set textContent(value) {
    this.text = String(value)
    this.children = []
  }

  get innerHTML() {
    return this._html
  }

  set innerHTML(html) {
    this._html = String(html)
    this.children = []
    for (const child of parseHtml(this._html, (tag) => new El(tag))) {
      child.parentNode = this
      this.children.push(child)
    }
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value))
    if (name === 'id') this.id = String(value)
  }

  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null
  }

  removeAttribute(name) {
    this.attrs.delete(name)
  }

  attachShadow() {
    const shadow = new El('#shadow')
    shadow.host = this
    this._shadow = shadow
    return shadow
  }

  get shadowRoot() {
    return this._shadow
  }

  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    this.children.push(child)
    return child
  }

  append(...nodes) {
    nodes.forEach((n) => this.appendChild(n))
  }

  replaceChildren(...nodes) {
    for (const child of [...this.children]) this.removeChild(child)
    this.append(...nodes)
  }

  insertBefore(child, reference) {
    if (child.parentNode) child.parentNode.removeChild(child)
    child.parentNode = this
    const index = this.children.indexOf(reference)
    if (index < 0) this.children.push(child)
    else this.children.splice(index, 0, child)
    return child
  }

  removeChild(child) {
    const index = this.children.indexOf(child)
    if (index >= 0) this.children.splice(index, 1)
    child.parentNode = null
    return child
  }

  remove() {
    if (this.parentNode) this.parentNode.removeChild(this)
  }

  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set())
    this._listeners.get(type).add(fn)
  }

  removeEventListener(type, fn) {
    this._listeners.get(type)?.delete(fn)
  }

  listenerCount(type) {
    return this._listeners.get(type)?.size ?? 0
  }

  dispatch(type, event = {}) {
    const handlers = [...(this._listeners.get(type) ?? [])]
    const payload = {
      type,
      target: this,
      preventDefault() {},
      stopPropagation() {},
      composedPath: () => [this],
      ...event
    }
    for (const fn of handlers) fn(payload)
    return handlers.length
  }

  click() {
    this.dispatch('click', {})
  }

  walk(fn) {
    for (const child of [...this.children]) {
      fn(child)
      child.walk(fn)
    }
  }

  querySelectorAll(selector) {
    const out = []
    this.walk((node) => {
      if (matches(node, selector)) out.push(node)
    })
    return out
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }

  getElementById(id) {
    return this.querySelector(`#${id}`)
  }

  closest(selector) {
    let cur = this
    while (cur) {
      if (matches(cur, selector)) return cur
      cur = cur.parentNode
    }
    return null
  }

  contains(node) {
    if (node === this) return true
    return this.children.some((c) => c.contains(node))
  }

  getBoundingClientRect() {
    return { top: 100, left: 100, right: 500, bottom: 400, width: 400, height: 300 }
  }

  play() {
    this.playCalls++
    // A real element with no media at all cannot start; play() rejects. Modelling that
    // is what lets the "dead media" path be tested honestly.
    if (this.readyState === 0) return Promise.reject(new Error('NotSupportedError: no media'))
    this.paused = false
    return Promise.resolve()
  }

  pause() {
    this.pauseCalls++
    this.paused = true
  }

  load() {
    this.loadCalls++
  }

  scrollIntoView() {}
  scrollBy() {}
}

// In a real DOM, assigning .src / .href also reflects into the attribute, which is
// what attribute selectors such as img[src*="twimg.com"] match against. .className
// is the same string as .classList, so it must stay in sync too.
for (const reflected of ['src', 'href']) {
  Object.defineProperty(El.prototype, reflected, {
    get() {
      return this.attrs.get(reflected) ?? ''
    },
    set(value) {
      this.attrs.set(reflected, String(value))
    }
  })
}

Object.defineProperty(El.prototype, 'className', {
  get() {
    return this.classList.all().join(' ')
  },
  set(value) {
    this.classList.clear()
    for (const name of String(value).split(/\s+/).filter(Boolean)) this.classList.add(name)
  }
})

function makeDocument() {  const document = new El('#document')
  const html = document.appendChild(new El('html'))
  const body = html.appendChild(new El('body'))
  document.body = body
  document.documentElement = html
  document.createElement = (tag) => new El(tag)
  document.querySelectorAll = (sel) => html.querySelectorAll(sel)
  document.querySelector = (sel) => html.querySelector(sel)
  document.getElementById = (id) => html.querySelector(`#${id}`)
  document.contains = (node) => node === document || html.contains(node)
  return document
}

// ------------------------------------------------------- load the add-on ----

function loadContent({ withStyleSheet = true, hardwareDecode = true } = {}) {
  const document = makeDocument()
  const listeners = []
  const warnings = []
  const intervals = new Map()
  const timeouts = new Map()
  let nextTimer = 0
  // Simulated clock offset, so time-based logic is testable without real waiting.
  let clockOffset = 0

  const storage = {}
  let scrollCalls = 0
  const scrollHooks = []
  const api = {
    runtime: {
      onMessage: { addListener: (fn) => listeners.push(fn) },
      // The content script reports the version it was loaded from, so the popup can tell when a
      // tab is still running an older injection. A deliberately odd number makes it obvious
      // when the value in a response came from here.
      getManifest: () => ({ version: '9.9.9-test' })
    },
    storage: {
      sync: {
        get: async (defaults) => ({ ...defaults, ...storage }),
        set: async (values) => Object.assign(storage, values)
      }
    }
  }

  const context = {
    document,
    console: { log() {}, info() {}, warn: (...a) => warnings.push(a.join(' ')), error: (...a) => warnings.push(a.join(' ')) },
    window: {
      innerHeight: 900,
      // Scrolling is how the add-on asks X to load more of the timeline, so the harness models it
      // as an event tests can respond to (by adding tweets) and count.
      scrollBy: () => {
        scrollCalls += 1
        for (const fn of scrollHooks) fn(scrollCalls)
      },
      addEventListener() {},
      removeEventListener() {}
    },
    performance: { now: () => Date.now() + clockOffset },
    location: { href: 'https://x.com/home', origin: 'https://x.com' },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    // Timers are tracked so leaks are detectable, but short delays (the sleep()
    // calls inside the content script) really do fire so async paths can settle.
    // Long delays stay pending, which keeps image/poll timers out of the way.
    setTimeout: (fn, ms) => {
      const id = ++nextTimer
      const delay = Number(ms) || 0
      if (delay <= 1500) {
        const real = setTimeout(() => {
          timeouts.delete(id)
          fn()
        }, Math.min(delay, 5))
        timeouts.set(id, { ms: delay, real })
      } else {
        timeouts.set(id, { ms: delay, real: null })
      }
      return id
    },
    clearTimeout: (id) => {
      const record = timeouts.get(id)
      if (record?.real) clearTimeout(record.real)
      timeouts.delete(id)
    },
    setInterval: (fn, ms) => {
      const id = ++nextTimer
      const real = setInterval(fn, 1e9)
      real.unref?.()
      intervals.set(id, { ms, real, fn })
      return id
    },
    clearInterval: (id) => {
      const record = intervals.get(id)
      if (record?.real) clearInterval(record.real)
      intervals.delete(id)
    },
    // Stand-in for the real decode-capability probe: powerEfficient is how the browser
    // reports that a stream is decoded on dedicated video hardware.
    navigator: {
      mediaCapabilities: {
        decodingInfo: async (config) => ({
          supported: true,
          smooth: true,
          powerEfficient: hardwareDecode,
          _config: config
        })
      }
    },
    URL
  }
  if (withStyleSheet) {
    context.CSSStyleSheet = class {
      replaceSync(css) {
        this.css = css
      }
    }
  }
  context.globalThis = context
  context.browser = api

  vm.createContext(context)
  new vm.Script(read('content.js'), { filename: 'content.js' }).runInContext(context)

  /** Drive the message API exactly the way the popup and background script do. */
  const send = (message) =>
    new Promise((resolve, reject) => {
      const listener = listeners[0]
      if (!listener) return reject(new Error('no message listener registered'))
      let settled = false
      const respond = (value) => {
        settled = true
        resolve(value)
      }
      let kept
      try {
        kept = listener(message, {}, respond)
      } catch (error) {
        return reject(error)
      }
      if (settled) return
      if (kept !== true) resolve(undefined)
    })

  // Drive the add-on's own timers on demand (the paint loop) without waiting for real time,
  // so periodic behaviour is testable.
  const tick = () => {
    for (const record of [...intervals.values()]) record.fn()
  }

  /** Move the simulated clock forward, so time-based rules can be exercised instantly. */
  const advance = (ms) => {
    clockOffset += ms
  }

  return {
    document,
    listeners,
    send,
    tick,
    advance,
    warnings,
    intervals,
    timeouts,
    storage,
    api,
    /** React to the add-on scrolling the timeline, the way X loads more tweets. */
    onScroll: (fn) => scrollHooks.push(fn),
    scrolls: () => scrollCalls
  }
}

// ------------------------------------------------------------------- fixtures

// `source` picks which playback strategy a clip exercises:
//   'blob'   - only X's element can play it, so it gets moved into the tile (the default,
//              so the existing suite keeps covering the hard path)
//   'direct' - a plain https MP4, so the add-on can use an element of its own
function addTweet(document, { status, videos = 0, images = [], videoReady = true, source = 'blob' }) {
  const article = document.createElement('article')
  const link = document.createElement('a')
  link.setAttribute('href', `/someone/status/${status}`)
  article.appendChild(link)

  const created = { videos: [], images: [] }
  for (let i = 0; i < videos; i++) {
    const video = document.createElement('video')
    if (videoReady) {
      video.src =
        source === 'direct'
          ? `https://video.twimg.com/ext_tw_video/${status}/${i}.mp4`
          : `blob:https://x.com/${status}-${i}`
      video.currentSrc = video.src
      video.duration = 20
      video.readyState = 4
    } else {
      // A player that has not resolved a source yet: no src, no metadata.
      video.readyState = 0
    }
    article.appendChild(video)
    created.videos.push(video)
  }
  for (const src of images) {
    const img = document.createElement('img')
    img.src = src
    article.appendChild(img)
    created.images.push(img)
  }
  document.body.appendChild(article)
  return { article, ...created }
}

// Wait for async continuations to run. (The first parameter used to be a stray
// `handler` argument, which silently made every settle(700) wait only 30ms.)
const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Let one staggered mount happen.
 *
 * Columns are started one at a time, MOUNT_STAGGER_MS apart, so that eight players never ask X
 * for their media in the same tick. That is the add-on's real behaviour, so a test that wants a
 * full grid moves the simulated clock instead of assuming the fill happened synchronously. The
 * first tick is where a column notices its clip is over; the second, one stagger window later,
 * is where the fill queue gives it the next one.
 */
const stagger = (app) => {
  app.tick()
  app.advance(1100)
  app.tick()
}

const fillGrid = (app, columns = 2) => {
  for (let i = 1; i < columns; i++) stagger(app)
}

// ============================================================ T1: syntax ====
section('T1  syntax + MV3 CSP safety')
const jsFiles = fs.readdirSync(ROOT).filter((f) => f.endsWith('.js'))
ok(jsFiles.length >= 3, 'add-on ships its JS files', jsFiles.join(', '))
for (const file of jsFiles) {
  const code = read(file)
  try {
    new vm.Script(code, { filename: file })
    ok(true, `${file} parses`)
  } catch (error) {
    ok(false, `${file} parses`, error.message)
  }
  ok(!/\beval\s*\(|\bnew\s+Function\s*\(/.test(code), `${file} avoids eval/Function`)
}
const contentCode = stripComments(read('content.js'))
ok(!/\bchrome\s*\./.test(contentCode), 'content.js has no bare chrome.* calls')
ok(/\bglobalThis\.browser\s*\?\?\s*globalThis\.chrome/.test(contentCode), 'content.js picks browser.* with a chrome fallback')
ok(!/innerHTML\s*=\s*(MARKUP|`[^`]*<)/.test(contentCode.replace(/holder\.innerHTML = MARKUP/, '')), 'no ad-hoc innerHTML of untrusted strings')

// ========================================================== T2: manifest ====
section('T2  Firefox MV3 manifest')
const manifest = JSON.parse(read('manifest.json'))
eq(manifest.manifest_version, 3, 'manifest_version is 3')
// The packaged artifact is named from one of these and installed by the other, so a release
// that bumps only one of them installs as the old version and never upgrades.
const pkgVersion = JSON.parse(read('package.json')).version
eq(manifest.version, pkgVersion, 'manifest and package.json agree on the version')
ok(/^\d+\.\d+\.\d+$/.test(manifest.version), 'version is a plain x.y.z', manifest.version)
const gecko = manifest.browser_specific_settings?.gecko
// MDN allows either an email-like ID or a GUID; the GUID form keeps the manifest
// free of a real contact address.
const geckoId = gecko?.id
const geckoIdValid =
  typeof geckoId === 'string' &&
  (/^[^@\s]+@[^@\s]+$/.test(geckoId) || /^\{[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}$/.test(geckoId))
ok(geckoIdValid, 'gecko.id is present and valid', JSON.stringify(geckoId))
ok(parseFloat(gecko?.strict_min_version ?? '0') >= 109, 'strict_min_version >= 109 for MV3 action')
const geckoKnown = new Set(['id', 'strict_min_version', 'strict_max_version', 'update_url', 'data_collection_permissions'])
const unknownGecko = Object.keys(gecko ?? {}).filter((k) => !geckoKnown.has(k))
ok(unknownGecko.length === 0, 'no unknown browser_specific_settings keys', JSON.stringify(unknownGecko))

// A typo in a top-level key is silently ignored by Firefox and looks like a broken
// feature, so keep the key set inside the documented vocabulary.
const knownTopLevel = new Set([
  'manifest_version', 'name', 'short_name', 'version', 'version_name', 'description', 'author',
  'homepage_url', 'icons', 'action', 'background', 'commands', 'content_scripts', 'permissions',
  'host_permissions', 'optional_permissions', 'browser_specific_settings', 'applications',
  'default_locale', 'options_ui', 'web_accessible_resources', 'content_security_policy',
  'incognito', 'theme', 'chrome_url_overrides', 'omnibox', 'protocol_handlers', 'storage',
  'update_url', 'offline_enabled', 'sidebar_action', 'devtools_page'
])
const unknownTopLevel = Object.keys(manifest).filter((k) => !knownTopLevel.has(k))
ok(unknownTopLevel.length === 0, 'no unknown top-level manifest keys', JSON.stringify(unknownTopLevel))

eq(manifest.action?.default_popup, 'popup.html', 'popup wired to the toolbar button')
ok(['navbar', 'menupanel', 'tabstrip', 'personaltoolbar'].includes(manifest.action?.default_area), 'default_area pins the button to the toolbar')
eq(manifest.action?.default_title, manifest.name, 'button tooltip matches the add-on name')

const referenced = [
  manifest.action?.default_popup,
  ...Object.values(manifest.action?.default_icon ?? {}),
  ...Object.values(manifest.icons ?? {}),
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  ...(manifest.background?.scripts ?? [])
].filter(Boolean)
for (const file of referenced) ok(fs.existsSync(path.join(ROOT, file)), `referenced file exists: ${file}`)

ok(manifest.content_scripts?.length === 1, 'exactly one content script entry')
const matches_ = manifest.content_scripts?.[0]?.matches ?? []
ok(matches_.includes('https://x.com/*') && matches_.includes('https://twitter.com/*'), 'content script covers x.com and twitter.com', JSON.stringify(matches_))
ok((manifest.permissions ?? []).length === 1 && manifest.permissions[0] === 'storage', 'only the storage permission is requested', JSON.stringify(manifest.permissions))
ok(!('host_permissions' in manifest), 'no host_permissions needed (no network access requested)')
ok(Array.isArray(manifest.background?.scripts) && manifest.background.scripts.length > 0, 'background script declared for the keyboard command')
ok(manifest.commands?.['toggle-slideshow']?.suggested_key?.default === 'Alt+Shift+S', 'keyboard command has a default shortcut')

// The Chrome target differs where MV3 requires it: a service worker instead of an event page,
// no Firefox-only keys, and a MAIN-world page guard because Chrome content scripts cannot
// replace the page's own wrappers. Everything else must be the same product.
const chrome = chromeManifest(manifest)
eq(chrome.manifest_version, 3, 'the Chrome manifest is MV3')
eq(chrome.version, manifest.version, 'Firefox and Chrome package the same version')
eq(chrome.name, manifest.name, 'and the same name')
eq(chrome.background?.service_worker, 'background.js', 'Chrome uses an MV3 service worker')
ok(!('scripts' in (chrome.background ?? {})), 'and not the Firefox event-page form')
ok(!('browser_specific_settings' in chrome), 'the Chrome manifest drops Firefox-specific settings')
ok(!('author' in chrome), 'and the non-standard author key')
ok(!('default_area' in (chrome.action ?? {})), 'and the Firefox-only action.default_area')
eq(chrome.minimum_chrome_version, CHROME_MIN_VERSION, 'Chrome declares the MAIN-world minimum')
ok(chrome.permissions?.includes('storage'), 'Chrome keeps storage')
ok(chrome.permissions?.includes('activeTab'), 'and uses activeTab for tab messaging')
ok(!('host_permissions' in chrome), 'without standing host permissions')
const chromeMatches = (chrome.content_scripts ?? []).flatMap((cs) => cs.matches ?? [])
ok(
  chromeMatches.includes('https://x.com/*') && chromeMatches.includes('https://twitter.com/*'),
  'Chrome content scripts cover x.com and twitter.com'
)
const bridgeScript = (chrome.content_scripts ?? []).find((cs) => (cs.js ?? []).includes('page-guard.js'))
ok(Boolean(bridgeScript), 'the Chrome manifest ships the page guard')
eq(bridgeScript?.world, 'MAIN', 'the page guard runs in the page world')
eq(bridgeScript?.run_at, 'document_start', 'before the page gets a chance to install its player manager')
const isolatedScript = (chrome.content_scripts ?? []).find((cs) => (cs.js ?? []).includes('content.js'))
ok(Boolean(isolatedScript) && isolatedScript.run_at === 'document_idle', 'the main content script still runs isolated at idle')
for (const file of [
  chrome.action?.default_popup,
  ...Object.values(chrome.action?.default_icon ?? {}),
  ...Object.values(chrome.icons ?? {}),
  ...(chrome.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
  chrome.background?.service_worker
].filter(Boolean)) {
  ok(fs.existsSync(path.join(ROOT, file)), `Chrome references an existing file: ${file}`)
}
ok(fs.existsSync(path.join(ROOT, 'page-guard.js')), 'page-guard.js exists at the package root')

// popup markup is CSP-clean and its ids line up with popup.js
const popupHtml = read('popup.html')
ok(!/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/i.test(popupHtml), 'no inline <script> in popup.html')
ok(!/\son(click|change|load|input|submit)\s*=/i.test(popupHtml), 'no inline event-handler attributes in popup.html')
const popupJsCode = stripComments(read('popup.js'))
const htmlIds = new Set([...popupHtml.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
const jsIds = [...popupJsCode.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1])
ok(jsIds.length > 0, 'popup.js looks up elements by id', `${jsIds.length} ids`)
for (const id of jsIds) ok(htmlIds.has(id), `popup.js getElementById("${id}") exists in popup.html`)
ok(!/chrome\.runtime\.lastError/.test(popupJsCode), 'popup.js relies on promise rejection, not lastError')
ok(/getManifest/.test(popupJsCode) && /\.version/.test(popupJsCode), 'the popup knows which build it is')
ok(
  /state\?\.version/.test(popupJsCode) && /reload it to finish updating/i.test(popupJsCode),
  'and says so when a tab is still running an older content script'
)

// The popup is the only place the column count is chosen, so it must offer exactly what the
// content script can lay out: a lower cap makes part of the add-on unreachable, a higher one
// makes the user's choice silently clamp back down.
const layoutCap = Number(read('content.js').match(/const MAX_COLUMNS = (\d+)/)?.[1])
const columnsBlock = popupHtml.match(/<select id="columns">([\s\S]*?)<\/select>/)?.[1] ?? ''
const columnChoices = [...columnsBlock.matchAll(/value="(\d+)"/g)].map((m) => Number(m[1]))
eq(columnChoices.join(','), '1,2,3,4,5,6,7,8', 'the popup offers one to eight columns')
eq(Math.max(...columnChoices), layoutCap, 'the popup offers exactly as many columns as the overlay can lay out')
const popupDefault = Number(popupJsCode.match(/const DEFAULTS = \{[^}]*columns:\s*(\d+)/)?.[1])
const overlayDefault = Number(read('content.js').match(/const DEFAULTS = \{[^}]*columns:\s*(\d+)/)?.[1])
eq(popupDefault, overlayDefault, 'the popup and the overlay agree on the default column count')
ok(
  /id="columnHint"[^>]*\bhidden\b/.test(popupHtml),
  'the decode-session hint is hidden until the choice passes three columns'
)
ok(/BUSY_COLUMNS = 3/.test(popupJsCode), 'and it comes back once four or more streams are asked for')

// X's primary action is the white button with black text; a close/stop action is the inverse.
const popupCss = read('popup.css')
ok(
  /\.primary\s*\{[^}]*background:\s*#eff3f4[^}]*color:\s*#0f1419/s.test(popupCss),
  'the Start button is X white with black text'
)
ok(
  /\.primary\.stop\s*\{[^}]*background:\s*#0f1419[^}]*color:\s*#ffffff/s.test(popupCss),
  'the Stop button is X black with white text'
)
ok(/border-radius:\s*9999px/.test(popupCss), 'the action uses X pill shape')

// ============================================== T2b: Chrome page guard ======
section('T2b  Chrome MAIN-world page guard')
{
  // Chrome content scripts cannot replace the page's wrappers from the isolated world. The
  // MAIN-world guard wraps the page prototypes and blocks calls only for marked players.
  const calls = { pause: 0, load: 0, remove: 0, removeChild: 0 }
  class FakeMedia {
    constructor(marked) {
      this.marked = marked
    }

    hasAttribute(name) {
      return name === 'data-tt-player' && this.marked
    }

    pause() {
      calls.pause += 1
    }

    load() {
      calls.load += 1
    }
  }
  class FakeElement {
    constructor(marked) {
      this.marked = marked
    }

    hasAttribute(name) {
      return name === 'data-tt-player' && this.marked
    }

    remove() {
      calls.remove += 1
    }
  }
  class FakeNode {}
  FakeNode.prototype.removeChild = function removeChild(child) {
    calls.removeChild += 1
    return child
  }

  const document = { documentElement: { dataset: {} } }
  const window = {}
  const context = { window, document, HTMLMediaElement: FakeMedia, Element: FakeElement, Node: FakeNode, console }
  vm.createContext(context)
  new vm.Script(read('page-guard.js'), { filename: 'page-guard.js' }).runInContext(context)
  eq(document.documentElement.dataset.ttGuardBridge, '1', 'the bridge advertises itself on <html>')

  const guarded = new FakeMedia(true)
  const normal = new FakeMedia(false)
  guarded.pause()
  normal.pause()
  eq(calls.pause, 1, 'a marked player cannot be paused by the page')
  guarded.load()
  normal.load()
  eq(calls.load, 1, 'a marked player cannot be reloaded by the page')
  const guardedElement = new FakeElement(true)
  const normalElement = new FakeElement(false)
  guardedElement.remove()
  normalElement.remove()
  eq(calls.remove, 1, 'a marked player cannot be removed from the overlay')
  const parent = new FakeNode()
  const markedChild = new FakeElement(true)
  const normalChild = new FakeElement(false)
  eq(parent.removeChild(markedChild), markedChild, 'removeChild still returns the child it refused to remove')
  parent.removeChild(normalChild)
  eq(calls.removeChild, 1, 'and ordinary removals still go through')

  // Injecting the file twice must not stack a second wrapper on every call.
  new vm.Script(read('page-guard.js'), { filename: 'page-guard.js' }).runInContext(context)
  normal.pause()
  eq(calls.pause, 2, 'a second injection is a no-op')
}

// ===================================================== T3: markup contract ====
section('T3  content.js <-> overlay markup contract')
const markupMatch = read('content.js').match(/const MARKUP = `([\s\S]*?)`/)
ok(Boolean(markupMatch), 'overlay markup template found')
const markup = markupMatch ? markupMatch[1] : ''
const markupIds = new Set([...markup.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]))
const shadowLookups = [...new Set([...read('content.js').matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))]
ok(shadowLookups.length >= 10, 'content.js resolves overlay elements by id', `${shadowLookups.length} lookups`)
const missingInMarkup = shadowLookups.filter((id) => !markupIds.has(id))
ok(missingInMarkup.length === 0, 'every id content.js looks up exists in the markup', JSON.stringify(missingInMarkup))
const markupClasses = new Set([...markup.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)))
const cssSelectors = [...new Set([...read('content.js').matchAll(/\.([a-z][\w-]*)\s*[{,]/g)].map((m) => m[1]))]
const cssInMarkup = ['wrap', 'grid', 'tile', 'tile-stage', 'tile-foot', 'tile-idx', 'tile-bar', 'tile-fill', 'tile-mute', 'tile-note', 'bar', 'group', 'progress', 'progress-fill', 'time', 'count', 'pill', 'menu', 'toast']
const unknownClasses = cssInMarkup.filter((c) => !markupClasses.has(c) && !read('content.js').includes(`.${c} {`))
ok(unknownClasses.length === 0, 'CSS class vocabulary matches the markup', JSON.stringify(unknownClasses))
const cssIds = new Set([...read('content.js').matchAll(/#(tt-[\w-]+)/g)].map((m) => m[1]))
ok(cssIds.size > 3, 'overlay CSS targets elements by id', `${cssIds.size} ids`)
const missingCssIds = [...cssIds].filter((id) => !markupIds.has(id))
ok(missingCssIds.length === 0, 'every #id targeted by the overlay CSS exists in the markup', JSON.stringify(missingCssIds))
ok(cssSelectors.length > 5, 'styles are defined in the content script', `${cssSelectors.length} selectors`)

// The social proxy buttons are deliberately gone: X's like/repost/bookmark controls are
// per-tweet and the overlay can show several tweets at once, so a bar-level proxy acted on
// whichever tweet happened to be focused and was wrong for every other column.
ok(!/\btt-(like|repost|bookmark)\b/.test(markup), 'no like/repost/bookmark proxy buttons in the bar')
ok(!/\.social\b/.test(contentCode), 'and no social-control CSS left behind')

// The overlay has to follow X's current theme. X exposes its palette as --x-* custom
// properties on :root; they inherit through the shadow boundary. The fallback chain keeps
// the overlay legible when a build exposes none of them.
ok(/var\(--x-bg-primary/.test(contentCode), 'the overlay follows X background tokens')
ok(/var\(--x-fg-brand/.test(contentCode), 'the overlay follows the X accent token')
ok(/var\(--x-fg-primary/.test(contentCode) && /var\(--x-fg-secondary/.test(contentCode), 'and its text tokens')
ok(/--tt-page-bg/.test(contentCode) && /getComputedStyle/.test(contentCode), 'with a sampled page palette as a fallback')
ok(/data-theme/.test(contentCode) && /data-accent/.test(contentCode), 'and watches X theme and accent attributes')

// The ui handle object is built from $('id') lookups, then every control is reached
// as ui.<name>. A renamed key (a bulk rename turning `progress:` into `progrett:`)
// is invisible to the markup contract but crashes bindUi() at runtime.
const declaredUi = new Set([...read('content.js').matchAll(/(\w+): \$\('/g)].map((m) => m[1]))
declaredUi.add('shadow')
ok(declaredUi.size > 12, 'ui handle object declares its controls', `${declaredUi.size} keys`)
const usedUi = new Set([...read('content.js').matchAll(/\bui\.(\w+)/g)].map((m) => m[1]))
ok(usedUi.size > 10, 'content.js uses the ui handles', `${usedUi.size} referenced`)
const undeclaredUi = [...usedUi].filter((name) => !declaredUi.has(name))
ok(undeclaredUi.length === 0, 'every ui.<name> referenced is declared in the ui object', JSON.stringify(undeclaredUi))

// Regression guards for compositor cost. These were real stutter sources: a blurred
// backdrop over playing video forces a re-blur every frame, and animating progress by
// width forces layout on every tick.
const contentForPerf = read('content.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1')
ok(!/backdrop-filter/.test(contentForPerf), 'no backdrop-filter over playing video')
ok(!/\.style\.width\s*=/.test(contentForPerf), 'progress uses transforms, not width (no per-tick layout)')
ok(/scaleX\(/.test(contentForPerf), 'progress bars are painted with scaleX')
ok(/contain:\s*layout paint/.test(contentForPerf), 'tiles isolate their own layout and paint')

// ======================================================== T4: collection ====
section('T4  collection')
{
  const app = loadContent()
  addTweet(app.document, { status: '111', videos: 1 })
  addTweet(app.document, { status: '222', videos: 2 }) // a tweet with two videos
  addTweet(app.document, { status: '333', videoReady: false, videos: 1 }) // no source yet
  let response = await app.send({ type: 'tt:toggle', options: { includeImages: false, imageSeconds: 3 } })
  ok(response?.ok === true, 'toggle starts the slideshow', JSON.stringify(response))
  eq(response?.count, 3, 'counts 1 + 2 videos and skips the unplayable one')
  await app.send({ type: 'tt:stop' })
}
{
  const app = loadContent()
  addTweet(app.document, { status: '444', images: ['https://pbs.twimg.com/media/AAA?name=small', 'https://pbs.twimg.com/profile_images/bbb/x.jpg'] })
  const response = await app.send({ type: 'tt:toggle', options: { includeImages: true, imageSeconds: 2 } })
  eq(response?.count, 1, 'collects the /media/ image and ignores the avatar')
  await app.send({ type: 'tt:stop' })
}
{
  const app = loadContent()
  const response = await app.send({ type: 'tt:toggle', options: { includeImages: false, imageSeconds: 3 } })
  ok(response?.ok === false, 'empty timeline reports failure rather than opening an empty overlay', JSON.stringify(response))
  ok(/no videos/i.test(response?.message ?? ''), 'failure message is actionable', JSON.stringify(response?.message))
  eq(app.document.querySelector('#timeline-tv-host'), null, 'no overlay is created on an empty timeline')
}
{
  const app = loadContent()
  addTweet(app.document, { status: '555', images: ['https://pbs.twimg.com/media/CCC?name=small'] })
  const response = await app.send({ type: 'tt:toggle', options: { includeImages: false, imageSeconds: 3 } })
  eq(response?.count, undefined, 'images are excluded unless the option is on')
  ok(response?.ok === false, 'image-only timeline with includeImages off reports failure')
  await app.send({ type: 'tt:stop' })
}

// ========================================================= T5: lifecycle ====
section('T5  single-column lifecycle and media restore')
{
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '777', videos: 1 })
  const video = tweet.videos[0]
  const originalIndex = tweet.article.children.indexOf(video)
  const originalSrc = video.src
  video.muted = false
  video.volume = 0.8
  video.playbackRate = 1.25

  const response = await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  ok(response?.ok === true, 'slideshow opens')
  eq(response?.playing, 1, 'single column mounts exactly one video')

  const host = app.document.querySelector('#timeline-tv-host')
  ok(Boolean(host), 'shadow host is mounted on the document')
  const grid = host?.shadowRoot?.querySelector('#tt-grid')
  ok(Boolean(grid), 'grid exists inside the shadow root')
  eq(grid?.style['--cols'], '1', 'grid is laid out as a single column')
  const tileStage = grid?.querySelector('.tile')?.querySelector('.tile-stage')
  ok(tileStage?.children[0] === video, 'the timeline <video> was moved into the tile (blob-safe playback)')
  ok(video.playCalls > 0, 'playback was started', `playCalls=${video.playCalls}`)
  ok(video.classList.contains('tt-moved'), 'the moved element is tagged for styling')
  eq(video.currentTime, 0, 'playback restarts from the beginning')
  ok(video.listenerCount('ended') === 1, 'ended listener bound')
  ok(video.listenerCount('error') === 1, 'error listener bound')
  eq(video.muted, true, 'playback starts muted so autoplay is permitted')

  const menu = host?.shadowRoot?.querySelector('#tt-menu')
  ok((menu?.querySelectorAll('button')?.length ?? 0) === 10, 'speed menu lists 10 rates')
  menu.querySelectorAll('button').find((b) => b.getAttribute('data-rate') === '2')?.click()
  eq(video.playbackRate, 2, 'choosing 2x sets playbackRate on the timeline element')

  await app.send({ type: 'tt:stop' })
  eq(app.document.querySelector('#timeline-tv-host'), null, 'host removed on stop')
  ok(tweet.article.children[originalIndex] === video, 'video restored to its exact original position')
  eq(video.src, originalSrc, 'video keeps its source after close')
  eq(video.muted, false, "the element's original muted state is restored")
  eq(video.volume, 0.8, "the element's original volume is restored")
  eq(video.playbackRate, 1.25, "the element's original playback rate is restored")
  eq(video.listenerCount('ended'), 0, 'media listeners unbound on close')
  ok(!video.classList.contains('tt-moved'), 'marker class removed')
  eq(app.intervals.size, 0, 'no interval left running', `${app.intervals.size} alive`)
}
{
  // Escape closes, and the fallback <style> path works when CSSStyleSheet is missing
  const app = loadContent({ withStyleSheet: false })
  const tweet = addTweet(app.document, { status: '888', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  ok(Boolean(app.document.querySelector('#timeline-tv-host')), 'overlay opens without constructable stylesheets')
  app.document.dispatch('keydown', { key: 'Escape' })
  eq(app.document.querySelector('#timeline-tv-host'), null, 'Escape closes the overlay')
  ok(tweet.article.children.includes(tweet.videos[0]), 'Escape restores the video to the tweet')
  eq(app.intervals.size, 0, 'no interval left running after Escape')
}

// ================================================ T5a: own-element playback ====
section('T5a  a plain https clip plays in an element of our own')
{
  // The point of this change: X holds no reference to our element, so its player manager
  // cannot pause it - which is what makes several columns behave like separate tabs.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '9901', videos: 1, source: 'direct' })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = host.shadowRoot.querySelector('.tile-stage').children[0]

  ok(staged && staged !== tweet.videos[0], 'the clip plays in an element of our own, not in X player')
  eq(staged?.tagName, 'VIDEO', 'our element is a video')
  eq(staged?.getAttribute('src'), tweet.videos[0].src, 'and it points at the same media url')
  ok(tweet.article.children.includes(tweet.videos[0]), "the tweet's own player is left untouched in the timeline")
  ok(!tweet.videos[0].classList.contains('tt-moved'), 'the tweet player was never reparented')

  await app.send({ type: 'tt:stop' })
  ok(tweet.article.children.includes(tweet.videos[0]), 'and it is still untouched after close')
}
{
  // A blob: source cannot leave X's element, so that path must be completely unaffected.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '9902', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  eq(
    host.shadowRoot.querySelector('.tile-stage').children[0],
    tweet.videos[0],
    'a blob source still moves the tweet player into the tile'
  )
  await app.send({ type: 'tt:stop' })
  ok(tweet.article.children.includes(tweet.videos[0]), 'and it is restored on close')
}

{
  // A source that errors in our own element must be reloaded before the clip is given up:
  // the retry path used to call only the page player's captured load(), which does not exist
  // for an element we created ourselves.
  const app = loadContent()
  addTweet(app.document, { status: '9903', videos: 1, source: 'direct' })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const own = host.shadowRoot.querySelector('.tile-stage').children[0]
  own.dispatch('error', {})
  await settle(30)
  ok(own.loadCalls > 0, 'an errored own-element clip is reloaded, not dropped on its first error')
  await app.send({ type: 'tt:stop' })
}

// ======================================================= T5b: multi-column ===
section('T5b  multi-column playback, auto-pull, per-column audio')
{
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 5; i++) {
    const tweet = addTweet(app.document, { status: String(2000 + i), videos: 1 })
    tweets.push({
      article: tweet.article,
      video: tweet.videos[0],
      index: tweet.article.children.indexOf(tweet.videos[0]),
      srcBefore: tweet.videos[0].src
    })
  }

  const response = await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  ok(response?.ok === true, 'multi-column slideshow opens', JSON.stringify(response))
  eq(response?.columns, 3, 'three columns configured')
  eq(response?.playing, 3, 'three videos are mounted at the same time')

  const host = app.document.querySelector('#timeline-tv-host')
  const shadow = host.shadowRoot
  eq(shadow.querySelector('#tt-grid')?.style['--cols'], '3', 'grid is laid out as three columns')
  const tiles = shadow.querySelectorAll('.tile')
  eq(tiles.length, 3, 'three tiles exist')
  const staged = tiles.map((tile) => tile.querySelector('.tile-stage').children[0])
  ok(staged.every((el) => el && el.tagName === 'VIDEO'), 'every tile holds a video')
  eq(new Set(staged).size, 3, 'the three tiles hold three distinct videos')
  ok(staged.every((video) => video.playCalls > 0), 'all three are playing simultaneously')
  ok(staged.every((video) => video.muted === true), 'every column starts muted')
  ok(
    tweets.slice(3).every((t) => t.article.children.includes(t.video)),
    'the fourth and fifth videos are still waiting in the timeline'
  )

  // A column finishes: it must pull the next item from the shared queue.
  const finished = staged[0]
  finished.dispatch('ended', {})
  await settle()
  stagger(app)
  const afterPull = tiles.map((tile) => tile.querySelector('.tile-stage').children[0])
  eq(afterPull.length, 3, 'the freed column is immediately refilled')
  ok(tweets[0].article.children[tweets[0].index] === tweets[0].video, 'the finished video went back to its tweet')
  ok(afterPull.includes(tweets[3].video), 'the next video in line was pulled into the freed column')
  ok(afterPull.filter(Boolean).length === 3, 'all three tiles are populated again')

  // Per-column audio: unmuting one tile must not unmute the others.
  const muteButton = tiles[0].querySelector('.tile-mute')
  ok(Boolean(muteButton), 'each tile has its own mute control')
  const laneVideo = tiles[0].querySelector('.tile-stage').children[0]
  muteButton.click()
  eq(laneVideo.muted, false, 'unmuting a column lets that column make sound')
  eq(laneVideo.volume, 0.5, 'the unmuted column uses the master volume')
  const others = [tiles[1], tiles[2]].map((tile) => tile.querySelector('.tile-stage').children[0])
  ok(others.every((video) => video.muted === true), 'the other columns stay muted')

  // Master mute sits on top of the per-column flags.
  shadow.querySelector('#tt-mute').click()
  eq(laneVideo.muted, true, 'master mute silences the unmuted column')
  ok(others.every((video) => video.muted === true), 'master mute silences the muted columns too')
  shadow.querySelector('#tt-mute').click()
  eq(laneVideo.muted, false, 'master unmute restores the per-column state')
  ok(others.every((video) => video.muted === true), 'still only the chosen column is audible')

  // Tab moves the focused tile; the focused tile is the one the bar controls.
  shadow.querySelector('#tt-mute').click() // silence everything again for the focus tests
  app.document.dispatch('keydown', { key: 'Tab' })
  await settle()
  const activeTiles = tiles.filter((tile) => tile.classList.contains('is-active'))
  eq(activeTiles.length, 1, 'exactly one tile is focused at a time')

  await app.send({ type: 'tt:stop' })
  eq(app.document.querySelector('#timeline-tv-host'), null, 'host removed on stop')
  ok(
    tweets.every((t) => t.article.children[t.index] === t.video),
    'every moved video returned to its exact original position, across all columns'
  )
  ok(tweets.every((t) => t.video.src === t.srcBefore), 'no video lost its source')
  ok(tweets.every((t) => t.video.listenerCount('ended') === 0), 'handlers unbound on every video')
  eq(app.intervals.size, 0, 'no timers left running after a multi-column close')
}
{
  // Larger grids must already work: every column the popup offers has to be layable out.
  const app = loadContent()
  for (let i = 0; i < 8; i++) addTweet(app.document, { status: String(3000 + i), videos: 1 })
  const response = await app.send({ type: 'tt:toggle', options: { columns: 8, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 8)
  ok(response?.ok === true, 'an eight-column grid starts')
  eq(response?.columns, 8, 'the column count is not clamped below the UI maximum')
  eq(response?.playing, 8, 'eight videos mount at once')
  await app.send({ type: 'tt:stop' })
  eq(app.intervals.size, 0, 'eight-column teardown leaves no timers')
}
{
  // A drained queue leaves empty columns rather than crashing.
  const app = loadContent()
  addTweet(app.document, { status: '4001', videos: 1 })
  const response = await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  eq(response?.playing, 1, 'only one column fills when only one video exists')
  const host = app.document.querySelector('#timeline-tv-host')
  const tiles = host.shadowRoot.querySelectorAll('.tile')
  eq(tiles.filter((tile) => tile.classList.contains('is-empty')).length, 2, 'the other columns show as empty')
  await app.send({ type: 'tt:stop' })
}

{
  // Everything the overlay changes on a borrowed player has to be put back. `loop` was the
  // one property it cleared but never captured, so a looping tweet player stayed unlooped
  // after the overlay closed.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '3009', videos: 1 })
  const video = tweet.videos[0]
  video.loop = true
  video.controls = true
  video.playbackRate = 1.75
  video.volume = 0.65
  video.muted = false

  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  eq(host.shadowRoot.querySelector('.tile-stage').children[0], video, 'the tweet player is in the overlay')
  eq(video.loop, false, 'the overlay plays the clip once')

  await app.send({ type: 'tt:stop' })
  ok(tweet.article.children.includes(video), 'the player is back in its tweet')
  eq(video.loop, true, 'a looping player is put back looping')
  eq(video.controls, true, 'its controls are put back')
  eq(video.playbackRate, 1.75, 'its playback rate is put back')
  eq(video.volume, 0.65, 'its volume is put back')
  eq(video.muted, false, 'its muted state is put back')
}
{
  // The overlay mirrors X's theme markers onto its host, so X's own --x-* tokens apply to
  // the shadow UI even on a build that defines them below :root.
  const app = loadContent()
  app.document.documentElement.dataset.theme = 'light'
  app.document.documentElement.dataset.accent = 'yellow500'
  addTweet(app.document, { status: '3010', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  eq(host.getAttribute('data-theme'), 'light', 'the overlay host carries X light theme')
  eq(host.getAttribute('data-accent'), 'yellow500', 'and the chosen X accent')
  eq(host.style.colorScheme, 'light', 'form controls follow the light theme')
  eq(host.style['--tt-page-bg'], '#ffffff', 'the sampled light background is exposed to the shadow CSS')
  eq(host.style['--tt-page-text'], '#0f1419', 'and the matching light text colour')
  await app.send({ type: 'tt:stop' })
}
{
  // The old LightsOut class is still honoured when no data-theme is present.
  const app = loadContent()
  app.document.body.classList.add('LightsOut')
  addTweet(app.document, { status: '3011', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  eq(host.getAttribute('data-theme'), 'dark', 'LightsOut maps to the dark theme')
  eq(host.style.colorScheme, 'dark', 'and dark form controls')
  await app.send({ type: 'tt:stop' })
}

// ==================================================== T5c: performance ======
section('T5c  playback stability under a hostile page')
{
  // X pauses players it does not consider primary, and it does so while they are still
  // buffering. Reacting to the `pause` event and bailing on networkState LOADING skipped
  // almost every real case, which left exactly one column running; resuming on every
  // pause instead produced a tight loop that was audible as stuttering. The keep-alive
  // must therefore re-check state at a fixed rate: always recover, never storm.
  const app = loadContent()
  addTweet(app.document, { status: '5001', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]

  // Paused by the page while still buffering: the old code ignored this entirely.
  video.networkState = 2
  video.paused = true
  let before = video.playCalls
  app.tick()
  await settle(30)
  ok(video.playCalls > before, 'a column paused while buffering is resumed, not ignored', `calls=${video.playCalls - before}`)
  eq(video.paused, false, 'the recovered column is playing again')

  // Sustained recovery, but rate limited.
  video.networkState = 1
  before = video.playCalls
  for (let i = 0; i < 12; i++) {
    video.paused = true
    app.tick()
  }
  const extra = video.playCalls - before
  ok(extra <= 1, 'twelve rapid ticks cannot produce twelve resumes, so there is no tug-of-war', `calls=${extra}`)

  // Critically: it must never give up. The old code exhausted a budget and left the
  // column dead, which is what reduced the grid to a single playing video.
  await settle(700)
  video.paused = true
  before = video.playCalls
  app.tick()
  await settle(30)
  ok(video.playCalls > before, 'the keep-alive tries again later instead of giving up permanently')

  // The shared paint timer must not leak, and progress must be transform-based.
  const fill = host.shadowRoot.querySelector('.tile-fill')
  ok(/scaleX/.test(fill.style.transform ?? ''), 'tile progress is written as a transform', fill.style.transform)
  await app.send({ type: 'tt:stop' })
  eq(app.intervals.size, 0, 'the paint timer is cleared on stop', `${app.intervals.size} alive`)
}
{
  // Several columns must all recover independently, not just the newest one.
  const app = loadContent()
  for (let i = 0; i < 3; i++) addTweet(app.document, { status: String(5100 + i), videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const videos = host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  const before = videos.map((video) => video.playCalls)

  // The page pauses every background column at once, mid-buffer.
  videos.forEach((video) => {
    video.networkState = 2
    video.paused = true
  })
  app.tick()
  await settle(50)
  ok(
    videos.every((video, index) => video.playCalls > before[index]),
    'every paused column is recovered, so more than one video plays at once',
    videos.map((video, i) => `${video.playCalls - before[i]}`).join(',')
  )
  ok(videos.every((video) => video.paused === false), 'all columns are playing simultaneously')
  await app.send({ type: 'tt:stop' })
}
{
  // Eight columns is the widest grid the add-on lays out, so it has to behave like eight
  // separate tabs at once: distinct players, each guarded in the page's compartment, each
  // surviving a page pause, and every one of them handed back on close.
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 10; i++) tweets.push(addTweet(app.document, { status: String(5200 + i), videos: 1 }))
  const response = await app.send({ type: 'tt:toggle', options: { columns: 8, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 8)
eq(response?.playing, 8, 'eight columns mount eight clips at once')
  const host = app.document.querySelector('#timeline-tv-host')
  const stages = host.shadowRoot.querySelectorAll('.tile-stage')
  const videos = stages.map((stage) => stage.children[0])
  eq(new Set(videos).size, 8, 'all eight columns play a different clip')
  ok(videos.every((video) => video.playCalls > 0), 'all eight are playing')

  const before = videos.map((video) => video.playCalls)
  videos.forEach((video) => video.wrappedJSObject.pause()) // the page pauses all eight
  await settle(30)
  ok(videos.every((video) => video.paused === false), 'the page cannot stop any of the eight')

  // The page gets tougher only in guard-free builds: pausing is then a real stop, and the
  // keep-alive has to bring every column back by itself.
  videos.forEach((video) => {
    video.networkState = 2
    video.paused = true
  })
  app.tick()
  await settle(50)
  ok(
    videos.every((video, index) => video.playCalls > before[index]),
    'every one of the eight is recovered by the keep-alive',
    videos.map((video, i) => `${video.playCalls - before[i]}`).join(',')
  )

  const diag = await app.send({ type: 'tt:diagnostics' })
  ok(
    diag.lanes.every((lane) => lane.source === 'moved' && lane.guard === 'page' && lane.connected === true),
    'every column reports a connected, page-guarded player',
    JSON.stringify(diag.lanes.map((lane) => [lane.source, lane.guard, lane.connected]))
  )

  await app.send({ type: 'tt:stop' })
  ok(
    tweets.every((tweet) => tweet.article.children.includes(tweet.videos[0])),
    'all ten timeline players went back where they came from'
  )
  eq(app.intervals.size, 0, 'an eight-column close leaves no timers running')
}

// ============================================ T5i: the bulk audio control ====
section('T5i  one control makes the whole grid audible')
{
  // With a wide grid, hearing anything meant clicking every tile's speaker: the master mute
  // clears only its own flag and every column keeps its own. That is what this control is for.
  const app = loadContent()
  // Two more clips than columns, so a column that finishes has something to move on to.
  for (let i = 0; i < 6; i++) addTweet(app.document, { status: String(5300 + i), videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 4, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 4)
  const host = app.document.querySelector('#timeline-tv-host')
  const shadow = host.shadowRoot
  const videos = shadow.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  const unmuteButton = shadow.getElementById('tt-unmute')

  ok(Boolean(unmuteButton), 'the bar has a bulk unmute next to the mute and volume controls')
  ok(shadow.querySelector('#tt-volume') !== null, 'and the volume slider is still there')
  ok(videos.every((video) => video.muted === true), 'every column starts silent')
  ok(!unmuteButton.classList.contains('is-on'), 'and the bulk control does not claim otherwise')

  unmuteButton.click()
  await settle(20)
  ok(videos.every((video) => video.muted === false), 'one click makes every column audible')
  ok(videos.every((video) => video.volume === 0.5), 'at the master volume rather than zero')
  ok(videos.every((video) => video.paused === false), 'and every column is playing, not just unmuted')
  ok(unmuteButton.classList.contains('is-on'), 'the control now reports that the grid is audible')
  const tiles = shadow.querySelectorAll('.tile')
  ok(tiles.every((tile) => !tile.classList.contains('is-muted')), 'each tile speaker shows as audible')

  // The master mute still wins, and the bulk control agrees with it afterwards.
  const masterMute = shadow.getElementById('tt-mute')
  masterMute.click()
  await settle(10)
  ok(videos.every((video) => video.muted === true), 'the master mute still silences everything at once')
  ok(!unmuteButton.classList.contains('is-on'), 'and the bulk control shows the grid is silent again')
  masterMute.click()
  await settle(10)
  ok(videos.every((video) => video.muted === false), 'master unmute brings every column back')

  // A single column muted by hand is enough to make the grid "not all audible".
  shadow.querySelectorAll('.tile-mute')[1].click()
  await settle(10)
  eq(videos[1].muted, true, 'muting one tile silences only that tile')
  ok(!unmuteButton.classList.contains('is-on'), 'and the bulk control reports the grid is not fully audible')

  // Keyboard path.
  app.document.dispatch('keydown', { key: 'u' })
  await settle(20)
  ok(videos.every((video) => video.muted === false), 'the U shortcut unmutes every column too')

  // A muted column stays muted as it pulls the next clip only if it was muted; unmute-all
  // survives the column changing videos.
  videos[0].dispatch('ended', {})
  await settle(30)
  stagger(app)
  const replacement = shadow.querySelectorAll('.tile-stage')[0].children[0]
  eq(replacement.muted, false, 'a column unmuted by the bulk control keeps its audio for the next clip')

  await app.send({ type: 'tt:stop' })
}
{
  // Nothing mounted: the control must not pretend, and must not throw.
  const app = loadContent()
  addTweet(app.document, { status: '5400', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const errors = app.warnings.length
  host.shadowRoot.getElementById('tt-unmute').click()
  await settle(10)
  eq(app.warnings.length, errors, 'using the bulk control does not produce errors')
  await app.send({ type: 'tt:stop' })
}
{
  // An image is advanced by its own timeout, not by the video element's play(). Clearing
  // userPaused without restarting that timeout left a paused image frozen forever.
  const app = loadContent()
  addTweet(app.document, { status: '5410', images: ['https://pbs.twimg.com/media/one.jpg'] })
  addTweet(app.document, { status: '5411', images: ['https://pbs.twimg.com/media/two.jpg'] })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: true, imageSeconds: 1 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged()?.tagName, 'IMG', 'an image is showing')

  app.document.dispatch('keydown', { key: ' ' }) // pause the image before its 1s timer ends
  await settle(20)
  ok(String(staged()?.src).includes('one.jpg'), 'the paused image stays on screen')

  host.shadowRoot.getElementById('tt-unmute').click() // a gesture that should resume it
  await settle(40)
  stagger(app)
  await settle(40)
  ok(String(staged()?.src).includes('two.jpg'), 'unmuting a paused image restarts its timer, so it advances')
  await app.send({ type: 'tt:stop' })
}
{
  // Diagnostics must expose what is actually happening in every column.
  const app = loadContent()
  for (let i = 0; i < 3; i++) addTweet(app.document, { status: String(6000 + i), videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const videos = host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  videos[0].playbackQuality = { droppedVideoFrames: 12, totalVideoFrames: 400 }

  const diag = await app.send({ type: 'tt:diagnostics' })
  ok(diag?.ok === true && Array.isArray(diag.lanes), 'diagnostics responds with per-column rows')
  eq(diag?.lanes?.length, 3, 'one row per column')
  ok(
    diag.lanes.every((lane) => 'droppedFrames' in lane && 'resumes' in lane && 'networkState' in lane),
    'rows carry frame-drop, resume and buffering state'
  )
  eq(diag?.lanes?.[0]?.droppedFrames, 12, 'dropped frame counts come from the media element')
  eq(diag?.lanes?.filter((lane) => lane.focused).length, 1, 'exactly one column is reported as focused')

  await app.send({ type: 'tt:stop' })
  eq(app.intervals.size, 0, 'diagnostics does not leak timers')
  const idle = await app.send({ type: 'tt:diagnostics' })
  eq(idle?.lanes?.length, 0, 'diagnostics is empty when nothing is playing')
}

// ================================================ T5d: advancing columns =====
section('T5d  every column keeps selecting the next video')
{
  // A column must advance on a finished clip even if the `ended` event never arrives.
  const app = loadContent()
  const first = addTweet(app.document, { status: '7001', videos: 1 })
  const second = addTweet(app.document, { status: '7002', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const stage = () => host.shadowRoot.querySelector('.tile-stage')
  eq(stage().children[0], first.videos[0], 'the first clip is playing')

  // Reach the end without emitting `ended`: the paint watchdog has to notice.
  first.videos[0].currentTime = 19.9
  first.videos[0].ended = true
  stagger(app)
  await settle()
  eq(stage().children[0], second.videos[0], 'the column advances even when the ended event is missed')
  await app.send({ type: 'tt:stop' })
}
{
  // An entry whose <video> can no longer be found must be skipped, not fatal: the
  // column used to stop on the first unplayable item while the queue still had work.
  const app = loadContent()
  const one = addTweet(app.document, { status: '7101', videos: 1 })
  const two = addTweet(app.document, { status: '7102', videos: 1 })
  const three = addTweet(app.document, { status: '7103', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const stage = () => host.shadowRoot.querySelector('.tile-stage')
  eq(stage().children[0], one.videos[0], 'playing the first item')

  two.article.remove() // X virtualised/re-rendered that tweet away
  one.videos[0].dispatch('ended', {})
  await settle()
  stagger(app)
  eq(stage().children[0], three.videos[0], 'the unplayable item is skipped and the next is selected')
  ok(
    !host.shadowRoot.querySelector('.tile').classList.contains('is-empty'),
    'the column is not left empty while items remain in the queue'
  )
  await app.send({ type: 'tt:stop' })
}
{
  // A duplicated `ended` (event + watchdog) must not eat a clip.
  const app = loadContent()
  const one = addTweet(app.document, { status: '7201', videos: 1 })
  const two = addTweet(app.document, { status: '7202', videos: 1 })
  addTweet(app.document, { status: '7203', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const stage = () => host.shadowRoot.querySelector('.tile-stage')

  one.videos[0].dispatch('ended', {})
  one.videos[0].dispatch('ended', {})
  app.tick()
  await settle()
  stagger(app)
  eq(stage().children[0], two.videos[0], 'a duplicate finished signal does not skip the next clip')
  await app.send({ type: 'tt:stop' })
}
{
  // Every column advances independently as it finishes.
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 6; i++) {
    const tweet = addTweet(app.document, { status: String(7300 + i), videos: 1 })
    tweets.push(tweet.videos[0])
  }
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  eq(new Set(staged()).size, 3, 'three clips are running')

  tweets[0].dispatch('ended', {})
  await settle()
  stagger(app)
  ok(staged().includes(tweets[3]), 'column 1 pulled item 4')
  tweets[1].dispatch('ended', {})
  await settle()
  stagger(app)
  ok(staged().includes(tweets[4]), 'column 2 pulled item 5')
  tweets[2].dispatch('ended', {})
  await settle()
  stagger(app)
  ok(staged().includes(tweets[5]), 'column 3 pulled item 6')
  eq(new Set(staged()).size, 3, 'each column independently selected its own next video')
  await app.send({ type: 'tt:stop' })
  ok(tweets.every((video) => video.parentNode && video.parentNode.tagName === 'ARTICLE'), 'all six videos are back in their tweets')
}

// ============================================ T5e: simultaneous playback =====
section('T5e  the page cannot stop a column, and Next takes the oldest')
{
  // X's player manager pauses players it does not consider primary, while they are still
  // buffering. Resuming per pause event never kept three columns alive; the mounted
  // element must simply refuse to be stopped, while the add-on keeps its own control.
  //
  // The page is simulated through `wrappedJSObject` - the page's OWN reflection - because
  // that is where X's calls land. Calling video.pause() here would be the content script's
  // reflection, which the page never reads: the earlier version of this test did exactly
  // that and passed while the real add-on kept losing every column.
  const app = loadContent()
  addTweet(app.document, { status: '8001', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]
  const view = video.wrappedJSObject

  view.pause() // the page asking the player to stop
  await settle(20)
  eq(video.paused, false, 'a pause request from the page does not stop a mounted column')
  ok(
    Object.prototype.hasOwnProperty.call(view, 'pause') && !Object.prototype.hasOwnProperty.call(video, 'pause'),
    'the guard lives on the page own view, not on the content script own reflection'
  )

  view.load() // X freeing a player it thinks it is finished with
  eq(video.readyState, 4, 'a load from the page cannot strip a mounted column of its media')

  // The add-on's own control is untouched: it goes through the native implementation.
  app.document.dispatch('keydown', { key: ' ' })
  await settle(10)
  eq(video.paused, true, 'the add-on can still pause the column it is playing')
  app.document.dispatch('keydown', { key: ' ' })
  await settle(10)
  eq(video.paused, false, 'and start it again')

  // Both blocked calls are counted, so the diagnostics can say the guard is doing work.
  const reported = await app.send({ type: 'tt:diagnostics' })
  eq(reported?.lanes?.[0]?.source, 'moved', 'the diagnostics report a borrowed player')
  eq(reported?.lanes?.[0]?.guard, 'page', 'and that its guard is installed where the page looks')
  eq(reported?.lanes?.[0]?.blockedPauses, 2, 'with the pause and load it already swallowed')

  // X also removes a player it is virtualising away. That must not tear the tile down.
  view.remove()
  eq(video.isConnected, true, 'a remove from the page cannot tear a mounted column out of the overlay')

  await app.send({ type: 'tt:stop' })
  eq(video.paused, true, 'the add-on can still pause the element itself on teardown')
  ok(video.parentNode?.tagName === 'ARTICLE', 'the element is back in its tweet')

  // The guard must be removed again, or the timeline video would be permanently unstoppable.
  ok(!Object.prototype.hasOwnProperty.call(view, 'pause'), 'the guard is gone from the page own view')
  ok(!Object.prototype.hasOwnProperty.call(view, 'remove'), 'and the remove guard is gone too')
  video.play()
  await settle(10)
  eq(video.paused, false, 'the returned element can still be played')
  view.pause()
  eq(video.paused, true, 'the returned element can still be paused by the page')
  view.remove()
  eq(video.isConnected, false, 'and the page can remove it again after close')
}
{
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 6; i++) tweets.push(addTweet(app.document, { status: String(8100 + i), videos: 1 }))
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  const positions = () => staged().map((video) => tweets.findIndex((t) => t.videos[0] === video)).join(',')
  const activeTile = () => host.shadowRoot.querySelectorAll('.tile').findIndex((t) => t.classList.contains('is-active'))

  eq(positions(), '0,1,2', 'the three columns start with the first three items')

  app.document.dispatch('keydown', { key: 'ArrowRight' })
  await settle()
  eq(positions(), '3,1,2', 'Next advances the OLDEST column to item 4')
  eq(activeTile(), 0, 'Next focuses the column it advanced')

  app.document.dispatch('keydown', { key: 'ArrowRight' })
  await settle()
  eq(positions(), '3,4,2', 'the next press advances the now-oldest column')

  app.document.dispatch('keydown', { key: 'ArrowRight' })
  await settle()
  eq(positions(), '3,4,5', 'pressing through cycles each column exactly once')

  await app.send({ type: 'tt:stop' })
  ok(tweets.every((t) => t.article.children.includes(t.videos[0])), 'every clip went back to its tweet')
}

// ============================================= T5f: hardware-decode probe =====
section('T5f  the decode-capability probe reports acceleration')
{
  const app = loadContent({ hardwareDecode: true })
  addTweet(app.document, { status: '9001', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]
  video.videoWidth = 1920
  video.videoHeight = 1080

  const diag = await app.send({ type: 'tt:diagnostics' })
  ok(Boolean(diag?.decode), 'diagnostics includes decode capability')
  eq(diag?.decode?.powerEfficient, true, 'hardware decoding is reported as power efficient')
  ok(String(diag?.decode?.resolution).includes('1920'), 'the probe uses the real stream resolution', diag?.decode?.resolution)
  eq(diag?.lanes?.[0]?.resolution, '1920x1080', 'per-column resolution is reported')
  await app.send({ type: 'tt:stop' })
}
{
  // The whole point of the probe: tell a software-decode problem apart from everything else.
  const app = loadContent({ hardwareDecode: false })
  addTweet(app.document, { status: '9002', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const diag = await app.send({ type: 'tt:diagnostics' })
  eq(diag?.decode?.powerEfficient, false, 'software decoding is reported honestly')
  await app.send({ type: 'tt:stop' })
  const idle = await app.send({ type: 'tt:diagnostics' })
  eq(idle?.decode, null, 'no decode probe when nothing is playing')
}

// ============================================== T5g: never abandon a clip =====
section('T5g  a paused clip is resumed, not skipped')
{
  // A clip that stops part-way must be resumed and played to the end. Skipping it after a
  // timeout lost the rest of the video whenever X paused or slowed a player.
  const app = loadContent()
  const one = addTweet(app.document, { status: '9501', videos: 1 })
  addTweet(app.document, { status: '9502', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  const video = staged()
  eq(video, one.videos[0], 'the first clip is playing')

  // The page stops the clip, and keeps stopping it, for well over any timeout.
  video.paused = true
  video.readyState = 3 // it still holds its media
  app.tick() // records the stall; the keep-alive resumes it
  const afterFirstResume = video.playCalls
  video.paused = true // the page stops it again
  app.advance(120000) // two minutes of this
  app.tick() // repaints (marks it waiting) and resumes once more
  await settle(30)
  eq(staged(), one.videos[0], 'a paused clip with media is never skipped, however long it waits')
  ok(video.playCalls > afterFirstResume, 'the stalled clip is resumed rather than dropped')
  ok(
    host.shadowRoot.querySelector('.tile').classList.contains('is-waiting'),
    'a stalled column is shown as waiting'
  )

  // Once it is playing again the marker clears.
  app.tick()
  await settle(20)
  ok(!host.shadowRoot.querySelector('.tile').classList.contains('is-waiting'), 'the waiting marker clears once it plays')
  await app.send({ type: 'tt:stop' })
}
{
  // The one case where waiting cannot help: the element lost its media entirely.
  const app = loadContent()
  const one = addTweet(app.document, { status: '9601', videos: 1 })
  const two = addTweet(app.document, { status: '9602', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'playing the first clip')

  one.videos[0].paused = true
  one.videos[0].readyState = 0 // no media at all: it cannot resume by waiting
  app.tick()
  app.advance(25000)
  app.tick()
  stagger(app)
  await settle(30)
  eq(staged(), two.videos[0], 'an element that lost its media is stepped over')
  await app.send({ type: 'tt:stop' })
}
{
  // One column erroring must not make the others drop their clips.
  const app = loadContent()
  for (let i = 0; i < 3; i++) addTweet(app.document, { status: String(9700 + i), videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])
  const initial = staged()

  initial[0].dispatch('error', {})
  initial[1].dispatch('error', {})
  initial[2].dispatch('error', {})
  await settle(40)
  const after = staged()
  eq(after.length, 3, 'every column still holds a clip after simultaneous errors')
  ok(
    after.filter(Boolean).length === 3,
    'a transient media error in one column does not make the others skip',
    after.map((v) => (v ? 'ok' : 'empty')).join(',')
  )
  await app.send({ type: 'tt:stop' })
}
{
  // A page-aborted media request is not a broken source. X aborts players it is recycling,
  // and counting that as a failure skipped a clip that was still playing.
  const app = loadContent()
  const one = addTweet(app.document, { status: '9750', videos: 1 })
  const two = addTweet(app.document, { status: '9751', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'the first clip is playing')
  one.videos[0].error = { code: 1 } // MediaError.MEDIA_ERR_ABORTED
  one.videos[0].dispatch('error', {})
  await settle(30)
  eq(staged(), one.videos[0], 'an aborted media request does not skip the clip')
  eq(two.videos[0].playCalls, 0, 'and the next clip is left alone')
  await app.send({ type: 'tt:stop' })
}

// ================================== T5j: a column that cannot advance itself ====
section('T5j  a column always finds its way to the next clip')
{
  // The report: some columns sit at the end of a clip - video 1, or video 60 - while the
  // queue is at 92. X's player pauses a clip a fraction before its end and shows its own
  // replay button, so `ended` never becomes true on those players, and the add-on only ever
  // advanced on `ended`. Position is the fact that does not depend on the player.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5501', videos: 1 })
  const two = addTweet(app.document, { status: '5502', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'the first clip is playing')

  // Paused at the end, `ended` never set: exactly what X leaves behind.
  one.videos[0].currentTime = 19.9
  one.videos[0].paused = true
  eq(one.videos[0].ended, false, 'the player never reported the clip as ended')
  stagger(app)
  await settle(30)
  eq(staged(), two.videos[0], 'a column at the end of a clip takes the next one anyway')
  ok(two.videos[0].playCalls > 0, 'and the next clip is actually playing')
  await app.send({ type: 'tt:stop' })
}
{
  // The same clip in the middle: paused, but not at the end, so it keeps its clip. The page
  // pausing a player is the keep-alive's problem and must never cost the rest of a video.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5511', videos: 1 })
  const two = addTweet(app.document, { status: '5512', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 5
  one.videos[0].readyState = 4
  for (let i = 0; i < 4; i++) {
    one.videos[0].paused = true
    app.advance(30000)
    app.tick()
  }
  await settle(30)
  eq(staged(), one.videos[0], 'a clip the page keeps pausing is never spent, however long it takes')
  await app.send({ type: 'tt:stop' })
}
{
  // A player that claims to be playing and has the data, but which has stopped moving: no
  // `ended`, no pause, nothing to resume. This is the frozen tile, and no existing rule
  // touched it because every rule keyed off `paused` or `ended`.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5521', videos: 1 })
  const two = addTweet(app.document, { status: '5522', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 6
  one.videos[0].readyState = 4
  one.videos[0].paused = false // it says it is playing
  app.tick() // records where the clip is
  app.advance(5000)
  app.tick() // five seconds on: not a single frame of progress
  app.advance(10000)
  app.tick() // fifteen seconds: data is sitting right there, so one more play() attempt
  app.advance(21000)
  app.tick() // just over thirty seconds of stillness: restart the same clip first
  await settle(30)
  eq(staged(), one.videos[0], 'a frozen player is restarted instead of being skipped')
  eq(two.videos[0].playCalls, 0, 'and the next clip is not pulled in yet')

  app.tick() // the restarted player has not moved either: start its stall clock
  app.advance(31000)
  app.tick() // it froze again after a full restart; now it is the next clip's turn
  stagger(app)
  await settle(30)
  eq(staged(), two.videos[0], 'a player that freezes again is stepped over')
  await app.send({ type: 'tt:stop' })
}
{
  // A player that still has its data but is waiting on the network is buffering, not frozen.
  // Switching here is what makes a slow connection lose the rest of a clip.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5525', videos: 1 })
  const two = addTweet(app.document, { status: '5526', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 6
  one.videos[0].readyState = 4
  one.videos[0].networkState = 2 // NETWORK_LOADING: more data is on its way
  one.videos[0].paused = false
  app.tick()
  app.advance(120000)
  app.tick()
  await settle(30)
  eq(staged(), one.videos[0], 'a player that is still loading keeps its clip, however long it waits')
  eq(two.videos[0].playCalls, 0, 'and the next clip is not pulled in early')
  await app.send({ type: 'tt:stop' })
}
{
  // A reused X player can arrive with `ended` still set from the timeline's own playback.
  // That is not the end of the clip we just mounted.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5527', videos: 1 })
  const two = addTweet(app.document, { status: '5528', videos: 1 })
  one.videos[0].ended = true // stale flag, while currentTime is still at the start
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  app.tick()
  app.tick()
  await settle(30)
  eq(staged(), one.videos[0], 'a stale ended flag does not switch away from a clip that has not played')
  eq(two.videos[0].playCalls, 0, 'and the next clip is left alone')
  await app.send({ type: 'tt:stop' })
}
{
  // X can report a barely-initialised duration while the media source is setting up. A tiny
  // finite duration must not make the position check true at the very start of a clip.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5529', videos: 1 })
  const two = addTweet(app.document, { status: '5530', videos: 1 })
  one.videos[0].duration = 0.2
  one.videos[0].currentTime = 0.1
  one.videos[0].readyState = 4
  one.videos[0].paused = false
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  app.tick()
  app.tick()
  await settle(30)
  eq(staged(), one.videos[0], 'a tiny provisional duration does not switch the clip away')
  eq(two.videos[0].playCalls, 0, 'and the next clip is left alone')
  await app.send({ type: 'tt:stop' })
}
{
  // A hidden tab can leave the paint timer unattended for minutes. The stall clock must not
  // count that gap, or returning to the tab retires several clips at once.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5532', videos: 1 })
  const two = addTweet(app.document, { status: '5533', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  one.videos[0].currentTime = 6
  one.videos[0].readyState = 4
  one.videos[0].paused = false
  app.tick()

  app.document.hidden = true
  app.advance(120000)
  app.tick()
  await settle(20)
  eq(staged(), one.videos[0], 'a hidden tab does not burn through the clip on wall-clock time')

  app.document.hidden = false
  app.document.dispatch('visibilitychange', {})
  app.tick()
  await settle(20)
  eq(staged(), one.videos[0], 'and the stall clock starts fresh when the tab becomes visible again')
  eq(two.videos[0].playCalls, 0, 'the next clip is left alone')
  await app.send({ type: 'tt:stop' })
}
{
  // Buffering looks the same and must NOT be treated as frozen: this is the rule that was
  // paid for twice already, so it gets its own check at a much longer clock.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5531', videos: 1 })
  const two = addTweet(app.document, { status: '5532', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 6
  one.videos[0].readyState = 2 // HAVE_CURRENT_DATA: more is on its way
  one.videos[0].paused = false
  one.videos[0].networkState = 2
  app.tick()
  for (let i = 0; i < 5; i++) {
    app.advance(60000)
    app.tick()
  }
  await settle(30)
  eq(staged(), one.videos[0], 'a column that is buffering keeps its clip, for as long as it needs')
  eq(two.videos[0].playCalls, 0, 'and the next clip is left alone')
  await app.send({ type: 'tt:stop' })
}
{
  // An element whose media never arrived, with play() pending so it never reports `paused`.
  // The old escape from this lived inside the paused branch, so it could not fire.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5541', videos: 1 })
  const two = addTweet(app.document, { status: '5542', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 0
  one.videos[0].readyState = 0
  one.videos[0].paused = false
  app.tick()
  app.advance(21000)
  app.tick()
  stagger(app)
  await settle(30)
  eq(staged(), two.videos[0], 'a player whose media never arrived is stepped over too')
  await app.send({ type: 'tt:stop' })
}
{
  // A new clip starts its own stall clock. Comparing it with the previous clip's position
  // made a perfectly healthy clip look frozen after a short timeout.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5551', videos: 1 })
  const two = addTweet(app.document, { status: '5552', videos: 1 })
  const three = addTweet(app.document, { status: '5553', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]

  one.videos[0].currentTime = 15 // the first clip got a long way in
  app.tick()
  one.videos[0].dispatch('ended', {})
  await settle(30)
  stagger(app)
  eq(staged(), two.videos[0], 'the next clip is mounted')

  two.videos[0].currentTime = 0.5 // half a second in, on the new clip's own clock
  app.tick()
  app.advance(13000)
  app.tick()
  await settle(30)
  eq(staged(), two.videos[0], 'the new clip is not mistaken for a stalled one')
  eq(three.videos[0].playCalls, 0, 'and the clip after it is not pulled in early')
  await app.send({ type: 'tt:stop' })
}
{
  // An empty column with a full queue must refill itself. Refilling used to depend on the page
  // mutating the DOM, so after an unplayable stretch a column could sit empty indefinitely
  // while items waited behind it in the queue.
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 10; i++) tweets.push(addTweet(app.document, { status: String(5560 + i), videos: 1 }))
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), tweets[0].videos[0], 'the first clip is playing')

  // The next seven become unplayable between collection and use, which is more than the
  // skip limit allows in one advance.
  for (let i = 1; i <= 7; i++) tweets[i].videos[0].remove()
  staged().dispatch('ended', {})
  await settle(120)
  stagger(app) // one fill attempt, which walks the seven unplayable items and gives up
  eq(staged(), tweets[0].videos[0], 'the unplayable run leaves the previous frame on screen')

  stagger(app) // no page mutation, no new collection: just the column asking again
  await settle(30)
  eq(staged(), tweets[8].videos[0], 'the holding column picks up the next playable item by itself')
  ok(tweets[8].videos[0].playCalls > 0, 'and plays it')
  await app.send({ type: 'tt:stop' })
}

{
  // Seeking backwards moves the watchdog's baseline too. It used to keep comparing the new
  // position with the old one, so a long rewind looked exactly like a frozen player and the
  // column jumped to the next clip after the stall timeout.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5556', videos: 1 })
  const two = addTweet(app.document, { status: '5557', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'the first clip is playing')

  one.videos[0].currentTime = 15
  app.tick() // the watchdog records 15s as the last known position

  // Click the progress bar at 10%: a rewind from 15s to 2s.
  host.shadowRoot.getElementById('tt-progress').dispatch('click', { clientX: 140 })
  ok(one.videos[0].currentTime < 3, 'the click seeks the clip back', String(one.videos[0].currentTime))

  // It plays forward again, still below the old 15s mark for a long time. That is progress,
  // not a stall.
  one.videos[0].currentTime = 4.5
  app.tick()
  app.advance(13000)
  one.videos[0].currentTime = 10
  app.tick()
  app.advance(13000)
  one.videos[0].currentTime = 14.5
  app.tick()
  await settle(30)
  eq(staged(), one.videos[0], 'a rewind is not mistaken for a stalled player')
  eq(two.videos[0].playCalls, 0, 'and the next clip is not pulled in early')
  await app.send({ type: 'tt:stop' })
}

// =============================== T5k: the grid fills one column at a time =====
section('T5k  columns start one at a time, and nothing else waits')
{
  // Eight players asked to start in the same tick is the burst this exists to avoid: eight
  // media pipelines, eight decoders and eight sets of segment requests arriving together. One
  // column per MOUNT_STAGGER_MS, in tile order.
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 8; i++) tweets.push(addTweet(app.document, { status: String(5600 + i), videos: 1 }))
  const response = await app.send({ type: 'tt:toggle', options: { columns: 8, includeImages: false, imageSeconds: 3 } })
  eq(response?.playing, 8, 'eight columns are planned')
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () =>
    host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0]).filter(Boolean)

  eq(staged().length, 1, 'only the first column is playing when the overlay opens')
  for (let i = 0; i < 5; i++) app.tick()
  eq(staged().length, 1, 'repainting does not start the rest at once')

  app.advance(1000)
  app.tick()
  eq(staged().length, 2, 'the second column starts one stagger later')

  fillGrid(app, 8)
  eq(staged().length, 8, 'all eight columns end up playing')
  eq(staged()[0], tweets[0].videos[0], 'the columns fill in tile order')
  eq(staged()[7], tweets[7].videos[0], 'and the last one gets the last of the first eight clips')

  await app.send({ type: 'tt:stop' })
  ok(tweets.every((tweet) => tweet.article.children.includes(tweet.videos[0])), 'every player goes home again')
}
{
  // The stagger must not become a delay between clips: a column whose clip ended on its own is
  // only ever held back by another column that started a moment ago.
  const app = loadContent()
  const one = addTweet(app.document, { status: '5701', videos: 1 })
  const two = addTweet(app.document, { status: '5702', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'the clip is playing')

  one.videos[0].currentTime = 19.9
  one.videos[0].paused = true
  app.advance(20000) // twenty seconds of playing, so no other mount is recent
  app.tick() // the clip is over
  app.tick() // and the queue is free: no stagger window to wait for
  await settle(30)
  eq(staged(), two.videos[0], 'a clip that ends on its own is replaced immediately, not staggered')
  await app.send({ type: 'tt:stop' })
}
{
  // A finished clip holds its last frame while the next one is fetched, and "No more videos"
  // is only said after the search has had a real chance. Emptying the tile on `ended` made a
  // normal advance flash the end-of-timeline note.
  const app = loadContent()
  const first = addTweet(app.document, { status: '5801', videos: 1 })
  const second = addTweet(app.document, { status: '5802', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 2, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const tiles = host.shadowRoot.querySelectorAll('.tile')
  const stage = (tile) => tile.querySelector('.tile-stage').children[0]
  const fill = (tile) => tile.querySelector('.tile-fill')

  ok(tiles[1].classList.contains('is-empty'), 'the second column waits its turn')
  ok(tiles[1].classList.contains('is-pending'), 'and says so rather than claiming the timeline ran out')
  eq(tiles[1].querySelector('.tile-note').textContent, '', 'the note stays quiet while a clip is still coming')

  fillGrid(app, 2)
  ok(second.videos[0].playCalls > 0, 'then it starts playing')
  ok(Boolean(fill(tiles[0])), 'the first column is showing its clip')

  // The clip ends and the queue is drained. The last frame must stay up while the search runs.
  first.videos[0].currentTime = 19.9
  first.videos[0].paused = true
  stagger(app)
  await settle(80)
  eq(stage(tiles[0]), first.videos[0], 'the finished clip is still on screen, holding its last frame')
  ok(!tiles[0].classList.contains('is-empty'), 'and the tile is not emptied the moment the clip ends')
  eq(tiles[0].querySelector('.tile-note').textContent, '', 'so the end-of-timeline note is not shown yet')
  eq(first.videos[0].paused, true, 'the held frame is paused, not left playing past the end')

  // Five seconds later the search may still be going: still holding.
  app.advance(5000)
  app.tick()
  await settle(80)
  eq(stage(tiles[0]), first.videos[0], 'the last frame is held while the timeline is still being searched')
  eq(tiles[0].querySelector('.tile-note').textContent, '', 'with no "no more videos" while it is still looking')

  // Past the grace period, with the search exhausted, the tile is allowed to say so.
  app.advance(8000)
  app.tick()
  await settle(80) // let the final optimistic round finish
  app.tick()
  await settle(40)
  ok(tiles[0].classList.contains('is-empty'), 'after the grace period the finished tile is emptied')
  ok(!tiles[0].classList.contains('is-pending'), 'a drained queue is not reported as pending')
  eq(tiles[0].querySelector('.tile-note').textContent, 'No more videos', 'and only then says there is nothing left')
  await app.send({ type: 'tt:stop' })
}
{
  // The same hold applies when the next clip is found during the search: it replaces the last
  // frame when it is ready, and the end note never appears.
  const app = loadContent()
  const first = addTweet(app.document, { status: '5811', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const tile = host.shadowRoot.querySelector('.tile')
  const staged = () => tile.querySelector('.tile-stage').children[0]
  eq(staged(), first.videos[0], 'the first clip is playing')

  let loaded = null
  app.onScroll(() => {
    if (!loaded) loaded = addTweet(app.document, { status: '5812', videos: 1 })
  })
  first.videos[0].currentTime = 19.9
  first.videos[0].paused = true
  app.tick() // finish the clip; the optimistic search starts
  await settle(200) // the search scrolls, and X adds the next tweet
  eq(staged(), first.videos[0], 'the old frame is held while the next clip is being found')

  app.advance(1100)
  app.tick()
  await settle(60)
  eq(staged(), loaded?.videos[0], 'the found clip replaces the held frame')
  ok(!tile.classList.contains('is-empty'), 'the tile never went empty during the hand-off')
  eq(tile.querySelector('.tile-note').textContent, '', 'and the end note was never shown')
  await app.send({ type: 'tt:stop' })
}

// =============================== T5l: optimistic discovery keeps looking ====
section('T5l  discovery keeps going until the columns are full')
{
  // Eight columns over a timeline where the videos are far apart. Discovery used to stop as soon
  // as the collected count grew, which fills the two columns that were found and abandons the
  // other six: nothing was scrolling to look for more, because only a drained queue after a clip
  // ended, or a manual Next, ever scrolled. This is the "it takes longer to find eight streams"
  // report.
  const app = loadContent()
  const seed = [addTweet(app.document, { status: '6001', videos: 1 }), addTweet(app.document, { status: '6002', videos: 1 })]
  await app.send({ type: 'tt:toggle', options: { columns: 8, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () =>
    host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0]).filter(Boolean)

  // These clips are long (ten minutes), so the stall watchdog has nothing to say about them
  // while the search runs: what is being tested is discovery, not the watchdog.
  const longClips = (tweet) => {
    for (const video of tweet.videos) video.duration = 600
    return tweet
  }
  seed.forEach(longClips)

  // Every scroll is X loading more of the timeline: one more tweet with a video in it.
  let loaded = 0
  app.onScroll(() => {
    if (loaded >= 10) return
    longClips(addTweet(app.document, { status: String(6100 + loaded), videos: 1 }))
    loaded += 1
  })

  // A round is: let the clips play for a moment, then let the add-on act.
  const rounds = async (n) => {
    for (let i = 0; i < n; i++) {
      for (const video of staged()) video.currentTime += 2
      app.advance(1100)
      app.tick()
      await settle(120) // any search in flight finishes its scrolls
    }
  }

  await rounds(20)
  eq(staged().length, 8, 'discovery keeps scrolling until all eight columns have a clip')
  ok(app.scrolls() > 0, 'and it was scrolling that found them', `${app.scrolls()} scrolls`)

  // Nothing left to find: the grid is full, so the optimistic search stops.
  const afterFull = app.scrolls()
  await rounds(6)
  ok(app.scrolls() <= afterFull + 1, 'a full grid stops searching', `${app.scrolls() - afterFull} extra scrolls`)
  eq(staged().length, 8, 'and every column is still playing')
  await app.send({ type: 'tt:stop' })
}
{
  // A timeline with nothing more to give: the search must stop instead of scrolling the page
  // forever underneath the grid, and the empty columns then say so.
  const app = loadContent()
  const seed = [addTweet(app.document, { status: '6201', videos: 1 }), addTweet(app.document, { status: '6202', videos: 1 })]
  for (const tweet of seed) for (const video of tweet.videos) video.duration = 600
  await app.send({ type: 'tt:toggle', options: { columns: 8, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const tiles = host.shadowRoot.querySelectorAll('.tile')
  const staged = () =>
    host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0]).filter(Boolean)

  const rounds = async (n) => {
    for (let i = 0; i < n; i++) {
      for (const video of staged()) video.currentTime += 2
      app.advance(1800)
      app.tick()
      await settle(120)
    }
  }

  await rounds(3)
  ok(
    tiles.filter((tile) => tile.classList.contains('is-pending')).length > 0,
    'while it is still looking, empty columns say they are waiting'
  )
  eq(
    tiles.filter((tile) => tile.querySelector('.tile-note').textContent === 'No more videos').length,
    0,
    'and none of them claims the timeline is over while the search still has rounds to spend'
  )

  await rounds(9)
  const settled = app.scrolls()
  ok(settled > 0, 'it did look for more clips', `${settled} scrolls`)
  await rounds(6)
  eq(app.scrolls(), settled, 'a search that keeps coming back empty is abandoned, not repeated forever')
  eq(
    tiles.filter((tile) => tile.querySelector('.tile-note').textContent === 'No more videos').length,
    6,
    'and then the empty columns are told there is nothing left'
  )
  await app.send({ type: 'tt:stop' })
}

// ======================================== T5h: the page guard, measured ======
section('T5h  the guard sits where the page looks, and its absence is survivable')
{
  // The model itself, first: if the two reflections ever get merged in this harness, the
  // suite would start blessing the design that shipped three times and never worked.
  const app = loadContent()
  const el = app.document.createElement('video')
  el.readyState = 4
  el.play()
  el.pause = () => {} // exactly the old guard: a property on the content script's reflection
  eq(el.wrappedJSObject.pause() ?? el.paused, true, "the page's own view ignores a guard written on the content script's view")
}
{
  // Three borrowed players at once, each guarded where X's code will run into it.
  const app = loadContent()
  const tweets = []
  for (let i = 0; i < 3; i++) tweets.push(addTweet(app.document, { status: String(9800 + i), videos: 1 }))
  for (let i = 0; i < 2; i++) addTweet(app.document, { status: String(9900 + i), videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 3, includeImages: false, imageSeconds: 3 } })
  fillGrid(app, 3)
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelectorAll('.tile-stage').map((stage) => stage.children[0])

  eq(staged().length, 3, 'three columns are playing')
  for (const video of staged()) video.wrappedJSObject.pause() // X pauses every background player
  await settle(20)
  ok(staged().every((video) => video.paused === false), 'all three refuse the page pause at once')

  const reported = await app.send({ type: 'tt:diagnostics' })
  eq(reported?.lanes?.length, 3, 'the diagnostics cover every column')
  ok(
    reported.lanes.every((lane) => lane.source === 'moved' && lane.guard === 'page' && lane.blockedPauses === 1),
    'every column reports a page-visible guard that has swallowed exactly one pause',
    JSON.stringify(reported.lanes.map((lane) => [lane.source, lane.guard, lane.blockedPauses]))
  )
  ok(reported.lanes.every((lane) => lane.connected === true), 'and none of them is a detached player')

  await app.send({ type: 'tt:stop' })
  ok(
    tweets.every((tweet) => !Object.prototype.hasOwnProperty.call(tweet.videos[0].wrappedJSObject, 'pause')),
    'every borrowed player is handed back without a guard'
  )
}
{
  // A build that exposes no page view cannot be guarded. That must degrade to the keep-alive
  // - and it must be said once, not pretended, because the whole bug was a guard that only
  // existed on this side of the wall.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '9950', videos: 1 })
  Object.defineProperty(tweet.videos[0], 'wrappedJSObject', { value: undefined, configurable: true })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]

  ok(
    app.warnings.some((line) => line.includes('could not guard the page player')),
    'an unguardable player is reported rather than silently assumed safe'
  )
  video.pause() // with no page view, the page's call is the element's own pause()
  eq(video.paused, true, 'the page can still pause a player the add-on could not guard')
  const before = video.playCalls
  app.tick()
  await settle(20)
  ok(video.playCalls > before, 'and the keep-alive still recovers it')
  eq(video.paused, false, 'the column is playing again')

  const reported = await app.send({ type: 'tt:diagnostics' })
  eq(reported?.lanes?.[0]?.guard, 'not-reached', 'the diagnostics say the guard never reached the page')
  ok(reported?.lanes?.[0]?.source === 'moved', 'and still report the player it could not guard')
  await app.send({ type: 'tt:stop' })
}
{
  // Chrome has no wrappedJSObject. The MAIN-world page-guard bridge advertises itself on
  // <html> at document_start; content.js marks the mounted element and reports the guard as
  // page-visible without pretending a page reflection exists.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '9951', videos: 1 })
  Object.defineProperty(tweet.videos[0], 'wrappedJSObject', { value: undefined, configurable: true })
  app.document.documentElement.dataset.ttGuardBridge = '1'
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]

  eq(video.getAttribute('data-tt-player'), '1', 'the Chrome bridge marks the mounted player')
  ok(
    !app.warnings.some((line) => line.includes('could not guard the page player')),
    'the bridge is not reported as an unguarded player'
  )
  const reported = await app.send({ type: 'tt:diagnostics' })
  eq(reported?.lanes?.[0]?.guard, 'page', 'the diagnostics report the bridge as a page guard')
  eq(reported?.lanes?.[0]?.blockedPauses, 0, 'with the bridge having no per-call counter in the isolated world')

  await app.send({ type: 'tt:stop' })
  eq(video.getAttribute('data-tt-player'), null, 'the marker is removed when the player is handed back')
}
{
  // The guard is three fields: pause, load and remove. If one cannot be installed, all of them
  // have to be rolled back: releaseGuard() only runs for a complete install, so a half-installed
  // guard would leave the page's player permanently unpausable after the overlay closed.
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '9955', videos: 1 })
  const originalPause = function () {
    tweet.videos[0].pauseCalls += 1
  }
  const view = {
    pause: originalPause,
    get load() {
      return function () {}
    },
    set load(_) {
      throw new Error('load cannot be replaced on this view')
    }
  }
  Object.defineProperty(tweet.videos[0], 'wrappedJSObject', { value: view, configurable: true })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  ok(
    app.warnings.some((line) => line.includes('could not guard the page player')),
    'an incomplete guard is reported as unguarded'
  )
  await app.send({ type: 'tt:stop' })
  eq(view.pause, originalPause, 'a guard that could not be completed leaves no pause override behind')
}
{
  // X removing the player it lent us leaves an element that still accepts play() and still
  // reports a currentTime, so a tile can show one frozen frame while the keep-alive pushes a
  // corpse. The column must notice and take the next clip.
  const app = loadContent()
  const one = addTweet(app.document, { status: '9960', videos: 1 })
  const two = addTweet(app.document, { status: '9961', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const staged = () => host.shadowRoot.querySelector('.tile-stage').children[0]
  eq(staged(), one.videos[0], 'the first clip is playing')

  one.videos[0].remove() // the page takes its player back, mid-clip
  app.tick()
  await settle(20)
  eq(staged(), two.videos[0], 'a column whose player was removed moves on instead of freezing')
  ok(two.videos[0].playCalls > 0, 'and the replacement clip is playing')
  await app.send({ type: 'tt:stop' })
}
{
  // The same removal with nothing left to play must end on an empty column, not thrash.
  const app = loadContent()
  const only = addTweet(app.document, { status: '9970', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  only.videos[0].remove()
  const errors = app.warnings.length
  for (let i = 0; i < 6; i++) app.tick()
  await settle(20)
  eq(app.warnings.length, errors, 'a timeline with nothing left does not produce errors')
  ok(host.shadowRoot.querySelector('.tile').classList.contains('is-empty'), 'the column shows as empty')
  await app.send({ type: 'tt:stop' })
}

// ================================================== T6: message + keyboard ===
section('T6  message API and keyboard')
{
  const app = loadContent()
  addTweet(app.document, { status: '999', videos: 2 })
  eq(app.listeners.length, 1, 'one message listener registered')

  let state = await app.send({ type: 'tt:state' })
  eq(state?.active, false, 'state reports inactive before start')
  eq(state?.version, '9.9.9-test', 'state reports the version the content script was loaded from')

  const listenersBefore = app.document.listenerCount('keydown')
  await app.send({ type: 'tt:toggle', options: { includeImages: false, imageSeconds: 3 } })
  ok(app.document.listenerCount('keydown') === listenersBefore + 1, 'keydown handler attached while open')

  state = await app.send({ type: 'tt:state' })
  eq(state?.active, true, 'state reports active while open')
  eq(state?.count, 2, 'state reports the queue length')

  const second = await app.send({ type: 'tt:toggle', options: { includeImages: false, imageSeconds: 3 } })
  eq(second?.active, false, 'toggle closes when already open')
  eq(app.document.listenerCount('keydown'), listenersBefore, 'keydown handler detached on close')

  ok((await app.send({ type: 'nonsense' })) === undefined, 'unrelated messages are ignored')
  const stopWhenIdle = await app.send({ type: 'tt:stop' })
  ok(stopWhenIdle?.ok === true && stopWhenIdle?.active === false, 'stop is a safe no-op when idle')
}
{
  // Arrow keys navigate the focused tile; while open the page's own handlers are blocked
  const app = loadContent()
  const tweet = addTweet(app.document, { status: '1010', videos: 2 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  let defaultPrevented = false
  let propagated = false
  app.document.dispatch('keydown', {
    key: 'ArrowRight',
    preventDefault() {
      defaultPrevented = true
    },
    stopPropagation() {
      propagated = true
    }
  })
  await settle()
  ok(defaultPrevented && propagated, 'handled keys are prevented from reaching the page')
  const count = host?.shadowRoot?.querySelector('#tt-count')?.textContent ?? ''
  ok(/^2\/2$/.test(count.trim()), 'ArrowRight advanced the focused tile to the second item', `count=${JSON.stringify(count)}`)
  const laneStage = host?.shadowRoot?.querySelector('.tile-stage')
  eq(tweet.videos[1].parentNode, laneStage, 'second video is mounted in the focused tile')

  // ArrowLeft walks that tile's history back to the first video.
  app.document.dispatch('keydown', { key: 'ArrowLeft' })
  await settle()
  eq(tweet.videos[0].parentNode, host?.shadowRoot?.querySelector('.tile-stage'), 'ArrowLeft returns the tile to its previous video')

  await app.send({ type: 'tt:stop' })
  ok(tweet.videos.every((v) => tweet.article.children.includes(v)), 'every visited video was restored')
}

{
  // Starting is asynchronous, and `current` is only assigned when it finishes. Two toggles in
  // that window (the popup button plus the keyboard command, for instance) used to build two
  // overlays, each with its own host and its own set of players.
  const app = loadContent()
  addTweet(app.document, { status: '1020', videos: 1 })
  const first = app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const second = app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const [a, b] = await Promise.all([first, second])
  eq(app.document.querySelectorAll('#timeline-tv-host').length, 1, 'two toggles in flight build only one overlay')
  eq(a?.active, true, 'the first toggle reports the overlay open')
  eq(b?.active, true, 'and the one that joined it reports the same state')
  await app.send({ type: 'tt:stop' })
}
{
  // X's composer is a contenteditable div. Player shortcuts must not steal typing from it.
  const app = loadContent()
  addTweet(app.document, { status: '1030', videos: 1 })
  await app.send({ type: 'tt:toggle', options: { columns: 1, includeImages: false, imageSeconds: 3 } })
  const host = app.document.querySelector('#timeline-tv-host')
  const video = host.shadowRoot.querySelector('.tile-stage').children[0]
  const editable = app.document.createElement('div')
  editable.setAttribute('contenteditable', 'true')
  app.document.body.appendChild(editable)
  eq(video.paused, false, 'the clip is playing before the keystroke')

  app.document.dispatch('keydown', { key: ' ', composedPath: () => [editable] })
  await settle(20)
  eq(video.paused, false, 'a Space typed into a contenteditable is not a player shortcut')
  await app.send({ type: 'tt:stop' })
}

// ========================================================= T7: background ===
section('T7  background keyboard command')
{
  const commandHandlers = []
  const sent = []
  const context = {
    console,
    globalThis: null,
    browser: {
      commands: { onCommand: { addListener: (fn) => commandHandlers.push(fn) } },
      tabs: {
        query: async () => [{ id: 42 }],
        sendMessage: async (tabId, message) => {
          sent.push({ tabId, message })
          return { ok: true }
        }
      }
    }
  }
  context.globalThis = context
  vm.createContext(context)
  new vm.Script(read('background.js'), { filename: 'background.js' }).runInContext(context)
  eq(commandHandlers.length, 1, 'background registers a command listener')
  await commandHandlers[0]('toggle-slideshow')
  eq(sent.length, 1, 'command forwards exactly one message')
  eq(sent[0]?.message?.type, 'tt:toggle', 'command sends the toggle message')
  eq(sent[0]?.tabId, 42, 'command targets the active tab')
  await commandHandlers[0]('some-other-command')
  eq(sent.length, 1, 'unrelated commands are ignored')

  const failing = { ...context }
  const failingHandlers = []
  const failContext = {
    console,
    globalThis: null,
    browser: {
      commands: { onCommand: { addListener: (fn) => failingHandlers.push(fn) } },
      tabs: {
        query: async () => [{ id: 7 }],
        sendMessage: async () => {
          throw new Error('no content script')
        }
      }
    }
  }
  failContext.globalThis = failContext
  vm.createContext(failContext)
  new vm.Script(read('background.js'), { filename: 'background.js' }).runInContext(failContext)
  let threw = false
  try {
    await failingHandlers[0]('toggle-slideshow')
  } catch {
    threw = true
  }
  ok(!threw, 'a missing content script does not produce an unhandled rejection')
  ok(Boolean(failing) && Boolean(failingHandlers.length), 'second background context loaded')
}

// ============================================================== T8: icons ===
section('T8  icons')
function readPngSize(file) {
  const buffer = fs.readFileSync(file)
  const signatureOk = [0x89, 0x50, 0x4e, 0x47].every((b, i) => buffer[i] === b)
  if (!signatureOk) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}
for (const size of [16, 32, 48, 96, 128]) {
  const file = path.join(ROOT, 'icons', `icon-${size}.png`)
  if (!fs.existsSync(file)) {
    ok(false, `icons/icon-${size}.png exists`)
    continue
  }
  const dims = readPngSize(file)
  ok(dims?.width === size && dims?.height === size, `icon-${size}.png is a ${size}x${size} PNG`, JSON.stringify(dims))
}
{
  // Confirm the largest icon actually contains the accent colour, i.e. it is not blank.
  const buffer = fs.readFileSync(path.join(ROOT, 'icons', 'icon-128.png'))
  let offset = 8
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    if (type === 'IDAT') idat.push(buffer.subarray(offset + 8, offset + 8 + length))
    if (type === 'IEND') break
    offset += 12 + length
  }
  const raw = zlib.inflateSync(Buffer.concat(idat))
  // Scanlines are filter-byte prefixed, so the stride is width*4 + 1.
  const size = 128
  const stride = size * 4 + 1
  ok(raw.length === stride * size, 'icon-128.png payload size matches its dimensions', `${raw.length} vs ${stride * size}`)
  let accent = 0
  let opaque = 0
  for (let y = 0; y < size; y++) {
    const rowStart = y * stride
    for (let x = 0; x < size; x++) {
      const i = rowStart + 1 + x * 4
      const r = raw[i]
      const g = raw[i + 1]
      const b = raw[i + 2]
      const a = raw[i + 3]
      if (a > 200) opaque++
      if (a > 200 && b > 180 && b > r + 50) accent++
    }
  }
  ok(accent > 100, 'icon-128.png contains the accent colour (not a blank tile)', `accent px=${accent}`)
  ok(opaque > 2000, 'icon-128.png is substantially opaque', `opaque px=${opaque}`)
}

// ------------------------------------------------------------------ summary ---
console.log(`\n${'='.repeat(64)}`)
console.log(`checks passed: ${passed}   failed: ${failures.length}`)
if (failures.length) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log('ALL CHECKS PASSED')
}
