// make-icons.mjs — generate the extension's rocket-play icon set.
//
// No image library is available (and none is needed): this renders an RGBA
// buffer with 4x4 supersampling for smooth edges, then writes a minimal PNG by
// hand using Node's zlib. Everything here is original geometric artwork, so the
// icons can be published with the rest of the extension.
//
//   node tools/make-icons.mjs icons
//
// Design: a rounded near-black tile with a metallic white play/rocket triangle,
// one tapered blue exhaust plume, and a small blue planet ahead. The same mark
// is used at every size; there are no alternate logos.

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const OUT = process.argv[2] || 'icons'
const SIZES = [16, 32, 48, 96, 128]

const COLORS = {
  tile: [5, 7, 10, 255], // #05070a
  tileEdge: [30, 38, 47, 255], // #1e262f
  whiteTop: [255, 255, 255],
  whiteBottom: [178, 193, 208], // #b2c1d0
  blue: [29, 155, 240, 255], // #1d9bf0, the extension accent
  blueBright: [126, 226, 255, 255], // #7ee2ff
  blueGlow: [20, 128, 220, 255],
  planetHighlight: [220, 250, 255, 255]
}

const SS = 4 // supersampling factor per axis

// ---------------------------------------------------------------- geometry ---

/** Signed distance from a point to a rounded rectangle, for anti-aliased edges. */
function insideRoundedRect(x, y, left, top, right, bottom, radius) {
  const cx = Math.min(Math.max(x, left + radius), right - radius)
  const cy = Math.min(Math.max(y, top + radius), bottom - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius || (x >= left && x <= right && y >= top + radius && y <= bottom - radius) || (y >= top && y <= bottom && x >= left + radius && x <= right - radius)
}

/** Point-in-triangle via half-plane tests. */
function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by)
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy)
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function mix(a, b, t) {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

function over(base, overlay, alpha) {
  return [
    Math.round(overlay[0] * alpha + base[0] * (1 - alpha)),
    Math.round(overlay[1] * alpha + base[1] * (1 - alpha)),
    Math.round(overlay[2] * alpha + base[2] * (1 - alpha))
  ]
}

// The play/rocket triangle. Coordinates are normalised to the icon.
const TIP = [0.72, 0.30]
const BASE = [0.42, 0.56]
const HALF_WIDTH = 0.165
const BASE_SWEEP = 0.050
const SHIP = (() => {
  const dx = TIP[0] - BASE[0]
  const dy = TIP[1] - BASE[1]
  const length = Math.hypot(dx, dy)
  const ux = dx / length
  const uy = dy / length
  const px = -uy
  const py = ux
  const a = [
    BASE[0] + px * HALF_WIDTH - ux * BASE_SWEEP,
    BASE[1] + py * HALF_WIDTH - uy * BASE_SWEEP
  ]
  const b = [
    BASE[0] - px * HALF_WIDTH - ux * BASE_SWEEP,
    BASE[1] - py * HALF_WIDTH - uy * BASE_SWEEP
  ]
  return { tip: TIP, a, b, ux, uy, px, py }
})()

// One tapered exhaust plume, starting just behind the triangle base.
const FLAME = (() => {
  const start = [BASE[0] - SHIP.ux * 0.015, BASE[1] - SHIP.uy * 0.015]
  const control = [
    BASE[0] - SHIP.ux * 0.33 * 0.5 + SHIP.px * 0.08,
    BASE[1] - SHIP.uy * 0.33 * 0.5 + SHIP.py * 0.08
  ]
  const end = [
    BASE[0] - SHIP.ux * 0.33 + SHIP.px * 0.15,
    BASE[1] - SHIP.uy * 0.33 + SHIP.py * 0.15
  ]
  const points = []
  const widths = []
  for (let i = 0; i < 40; i++) {
    const t = i / 39
    const mt = 1 - t
    points.push([
      mt * mt * start[0] + 2 * mt * t * control[0] + t * t * end[0],
      mt * mt * start[1] + 2 * mt * t * control[1] + t * t * end[1]
    ])
    widths.push(0.090 * Math.pow(1 - t, 1.3) + 0.005)
  }
  return { points, widths }
})()

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  const x = ax + dx * t
  const y = ay + dy * t
  return { distance: Math.hypot(px - x, py - y), t }
}

/** Nearest distance to the exhaust centreline, plus the local plume width. */
function plumeAt(x, y) {
  let nearest = Infinity
  let width = 0
  for (let i = 0; i < FLAME.points.length - 1; i++) {
    const a = FLAME.points[i]
    const b = FLAME.points[i + 1]
    const hit = distanceToSegment(x, y, a[0], a[1], b[0], b[1])
    if (hit.distance < nearest) {
      nearest = hit.distance
      width = FLAME.widths[i] + (FLAME.widths[i + 1] - FLAME.widths[i]) * hit.t
    }
  }
  return { distance: nearest, width }
}

const PLANET = { x: 0.795, y: 0.205, radius: 0.038 }

/** Colour of the design at normalised coordinates (0..1). */
function sample(u, v) {
  // Rounded near-black tile with a thin edge.
  if (!insideRoundedRect(u, v, 0, 0, 1, 1, 0.22)) return [0, 0, 0, 0]
  const onEdge = !insideRoundedRect(u, v, 0.003, 0.003, 0.997, 0.997, 0.217)
  let colour = onEdge ? COLORS.tileEdge.slice(0, 3) : COLORS.tile.slice(0, 3)
  let alpha = 255

  // Metallic play/rocket triangle.
  if (insideTriangle(u, v, SHIP.tip[0], SHIP.tip[1], SHIP.a[0], SHIP.a[1], SHIP.b[0], SHIP.b[1])) {
    colour = mix(COLORS.whiteTop, COLORS.whiteBottom, v)
  }

  // Exhaust: soft outer glow, solid blue body, bright core.
  const plume = plumeAt(u, v)
  if (plume.distance <= plume.width) colour = over(colour, COLORS.blueGlow, 70 / 255)
  if (plume.distance <= plume.width / 2) colour = COLORS.blue.slice(0, 3)
  if (plume.distance <= plume.width * 0.38 / 2) colour = COLORS.blueBright.slice(0, 3)

  // Planet ahead of the ship: pale halo, blue disc, highlight.
  const planetDistance = Math.hypot(u - PLANET.x, v - PLANET.y)
  if (planetDistance <= PLANET.radius * 2.2) colour = over(colour, [150, 220, 255], 0.16)
  if (planetDistance <= PLANET.radius * 1.6) colour = over(colour, [130, 215, 255], 0.20)
  if (planetDistance <= PLANET.radius) colour = COLORS.blue.slice(0, 3)
  const hx = (u - (PLANET.x - PLANET.radius * 0.05)) / (PLANET.radius * 0.55)
  const hy = (v - (PLANET.y - PLANET.radius * 0.30)) / (PLANET.radius * 0.30)
  if (hx * hx + hy * hy <= 1) colour = over(colour, COLORS.planetHighlight, 220 / 255)

  return [colour[0], colour[1], colour[2], alpha]
}

// -------------------------------------------------------------------- PNG ----

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

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: truecolour + alpha
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // Each scanline is prefixed with filter type 0 (none)
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const perPixel = SS * SS
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = sample((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
          r += cr * ca
          g += cg * ca
          b += cb * ca
          a += ca
        }
      }
      const i = (y * size + x) * 4
      if (a === 0) {
        rgba[i] = rgba[i + 1] = rgba[i + 2] = rgba[i + 3] = 0
      } else {
        rgba[i] = Math.round(r / a)
        rgba[i + 1] = Math.round(g / a)
        rgba[i + 2] = Math.round(b / a)
        rgba[i + 3] = Math.round(a / perPixel)
      }
    }
  }
  return encodePng(size, size, rgba)
}

fs.mkdirSync(OUT, { recursive: true })
for (const size of SIZES) {
  const png = render(size)
  const file = path.join(OUT, `icon-${size}.png`)
  fs.writeFileSync(file, png)
  console.log(`[icons] ${file}  ${size}x${size}  ${png.length} bytes`)
}
