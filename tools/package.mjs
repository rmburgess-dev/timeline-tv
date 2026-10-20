// package.mjs — build the distributable Firefox and Chrome archives with no dependencies.
//
// Firefox installs a .xpi that is simply a zip with manifest.json at its root, and AMO accepts
// the same bytes as a .zip upload. Chrome accepts a zip whose root manifest uses the MV3
// service_worker background and a MAIN-world page guard; it is written as
// timeline-tv-<version>-chrome.zip, plus an unpacked dist/chrome/ directory for "Load unpacked".
//
//   node tools/package.mjs            -> dist/timeline-tv-<version>.xpi, .zip and -chrome.zip
//
// The zip writer here is deliberately minimal (stored + deflated entries) so the
// build works anywhere Node does, including CI, with no npm install step.

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromeManifest, readFirefoxManifest } from './manifest.mjs'

const ROOT = process.argv[2] || '.'
const DIST = path.join(ROOT, 'dist')

// Everything that ships inside both extensions. Anything else in the repo (tooling, docs
// beyond these, CI config) stays out of the packages. page-guard.js is Chrome-only and the
// manifests differ, so those are handled separately below.
const COMMON = [
  'content.js',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-96.png',
  'icons/icon-128.png',
  'LICENSE',
  'NOTICE.md'
]
const FIREFOX_INCLUDE = ['manifest.json', ...COMMON]
const CHROME_INCLUDE = [...COMMON, 'page-guard.js']

// ------------------------------------------------------------------- crc32 ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buffer) {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// --------------------------------------------------------------- zip writer ---

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2)
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
  return { time, day }
}

function buildZip(entries, when = new Date()) {
  const { time, day } = dosDateTime(when)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.data
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    // Store only if deflate failed to help (already-compressed PNGs).
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(day, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    locals.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8) // flags
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(day, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)

    centrals.push(central, name)
    offset += local.length + name.length + payload.length
  }

  const centralBuffer = Buffer.concat(centrals)
  const localBuffer = Buffer.concat(locals)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(localBuffer.length, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([localBuffer, centralBuffer, end])
}

// --------------------------------------------------------------------- build ---

function readEntries(names) {
  const entries = []
  const missing = []
  for (const name of names) {
    const file = path.join(ROOT, name)
    if (!fs.existsSync(file)) {
      missing.push(name)
      continue
    }
    entries.push({ name, data: fs.readFileSync(file) })
  }
  if (missing.length) {
    console.error(`[package] missing required file(s): ${missing.join(', ')}`)
    process.exit(1)
  }
  return entries
}

function referencedFiles(manifest) {
  return new Set(
    [
      manifest.action?.default_popup,
      ...Object.values(manifest.action?.default_icon ?? {}),
      ...Object.values(manifest.icons ?? {}),
      ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
      ...(manifest.background?.scripts ?? []),
      manifest.background?.service_worker
    ].filter(Boolean)
  )
}

function assertPacked(manifest, entries, target) {
  const notPacked = [...referencedFiles(manifest)].filter((file) => !entries.some((e) => e.name === file))
  if (notPacked.length) {
    console.error(`[package] ${target} manifest references files that would not be packaged: ${notPacked.join(', ')}`)
    process.exit(1)
  }
}

function report(label, entries, archive, written) {
  let total = 0
  for (const entry of entries) total += entry.data.length
  console.log(`[package] ${label}: ${entries.length} files, ${(total / 1024).toFixed(1)} KiB uncompressed`)
  for (const entry of entries) console.log(`  + ${entry.name}`)
  for (const out of written) {
    console.log(`[package] wrote ${out} (${(archive.length / 1024).toFixed(1)} KiB)`)
  }
}

const manifest = readFirefoxManifest(ROOT)
const firefoxEntries = readEntries(FIREFOX_INCLUDE)
assertPacked(manifest, firefoxEntries, 'Firefox')

const chrome = chromeManifest(manifest)
const chromeEntries = [
  { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(chrome, null, 2)}\n`) },
  ...readEntries(CHROME_INCLUDE)
]
assertPacked(chrome, chromeEntries, 'Chrome')

fs.mkdirSync(DIST, { recursive: true })
const base = `timeline-tv-${manifest.version}`
const firefoxArchive = buildZip(firefoxEntries)
const firefoxWritten = []
for (const ext of ['xpi', 'zip']) {
  const out = path.join(DIST, `${base}.${ext}`)
  fs.writeFileSync(out, firefoxArchive)
  firefoxWritten.push(out)
}

const chromeArchive = buildZip(chromeEntries)
const chromeZip = path.join(DIST, `${base}-chrome.zip`)
fs.writeFileSync(chromeZip, chromeArchive)

// An unpacked Chrome directory makes "Load unpacked" possible straight from dist/.
const chromeDir = path.join(DIST, 'chrome')
fs.rmSync(chromeDir, { recursive: true, force: true })
for (const entry of chromeEntries) {
  const out = path.join(chromeDir, entry.name)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, entry.data)
}

report('Firefox', firefoxEntries, firefoxArchive, firefoxWritten)
report('Chrome', chromeEntries, chromeArchive, [chromeZip, `${chromeDir}${path.sep}`])

