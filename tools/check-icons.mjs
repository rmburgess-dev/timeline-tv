// check-icons.mjs — decode the generated PNGs and print them as ASCII art.
//
// The icons are produced by tools/make-icons.mjs, so this file is the independent
// check of that output: it parses the PNG container, inflates IDAT, undoes the
// scanline filters, and renders each pixel as a character. Handy because it makes
// the artwork reviewable in a terminal.
//
//   node tools/check-icons.mjs icons

import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.argv[2] || 'icons'

function readPng(file) {
  const buf = fs.readFileSync(file)
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (!signature.every((b, i) => buf[i] === b)) throw new Error('bad PNG signature')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idat = []

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('latin1', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
    } else if (type === 'IDAT') {
      idat.push(data)
    } else if (type === 'IEND') {
      break
    }
    offset += 12 + length
  }
  if (bitDepth !== 8 || colorType !== 6) throw new Error(`unexpected format (depth ${bitDepth}, type ${colorType})`)

  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const pixels = Buffer.alloc(width * height * 4)

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const dstOffset = y * stride
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? pixels[dstOffset + x - 4] : 0
      const b = y > 0 ? pixels[dstOffset - stride + x] : 0
      const c = x >= 4 && y > 0 ? pixels[dstOffset - stride + x - 4] : 0
      const value = src[x]
      let out
      switch (filter) {
        case 0: out = value; break
        case 1: out = value + a; break
        case 2: out = value + b; break
        case 3: out = value + ((a + b) >> 1); break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          out = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
          break
        }
        default: throw new Error(`bad filter ${filter} on row ${y}`)
      }
      pixels[dstOffset + x] = out & 0xff
    }
  }
  return { width, height, pixels }
}

function describe(r, g, b, a) {
  if (a < 30) return ' ' // transparent
  if (b > 150 && b > r + 40) return '#' // accent blue
  if (r > 120 && g > 140 && b > 150) return '+' // tick grey
  if (r + g + b < 130) return '.' // dark tile
  return 'o' // tile edge
}

for (const size of [16, 32, 48]) {
  const file = path.join(DIR, `icon-${size}.png`)
  const { width, height, pixels } = readPng(file)
  const counts = new Map()
  const rows = []
  for (let y = 0; y < height; y++) {
    let line = ''
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4
      const ch = describe(pixels[i], pixels[i + 1], pixels[i + 2], pixels[i + 3])
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
      line += ch
    }
    rows.push(line)
  }
  console.log(`\n--- ${file}  ${width}x${height} ---`)
  console.log(rows.join('\n'))
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([ch, n]) => `${ch === ' ' ? 'transparent' : ch}=${n}`)
  console.log(`pixels: ${summary.join('  ')}`)
}
