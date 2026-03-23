const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const PImage = require('pureimage')
const fontkit = require('fontkit')

function resolveNavigationMetrics(windowInfo, menuButtonRect) {
  const screenWidth = windowInfo.screenWidth ?? windowInfo.windowWidth ?? 375
  const statusBarHeight = windowInfo.statusBarHeight ?? 20
  const fallbackGap = 8
  const fallbackMenuWidth = 88
  const fallbackMenuHeight = 32
  const rightInset = menuButtonRect
    ? Math.max(screenWidth - menuButtonRect.right, 14)
    : 14
  const gap = menuButtonRect
    ? Math.max(menuButtonRect.top - statusBarHeight, 4)
    : fallbackGap
  const menuHeight = menuButtonRect?.height ?? fallbackMenuHeight
  const menuWidth = menuButtonRect?.width ?? fallbackMenuWidth
  const navBarHeight = statusBarHeight + gap * 2 + menuHeight

  return {
    statusBarHeight,
    navBarHeight,
    navBarContentHeight: navBarHeight - statusBarHeight,
    contentTop: navBarHeight + 16,
    capsuleWidth: menuWidth + rightInset * 2,
    capsuleSlotWidth: menuWidth + rightInset,
  }
}

function resolveCapsuleBox({ imageWidth, navigationMetrics, windowWidth, pixelRatio }) {
  const scale = imageWidth / (windowWidth || 375)
  const rightInset = navigationMetrics.capsuleWidth - navigationMetrics.capsuleSlotWidth
  const capsuleWidth = navigationMetrics.capsuleSlotWidth - rightInset
  const capsuleHeight = 32
  const x = Math.round((windowWidth - navigationMetrics.capsuleWidth) * scale)
  const y = Math.round((navigationMetrics.statusBarHeight + (navigationMetrics.navBarContentHeight - capsuleHeight) / 2) * scale)
  const width = Math.round(capsuleWidth * scale)
  const height = Math.round(capsuleHeight * scale)

  return {
    x,
    y,
    width,
    height,
    separatorX: x + Math.round(width / 2),
    centerY: y + Math.round(height / 2),
    scale,
  }
}

function resolveCapsulePaintSpec(box) {
  const scale = box.scale || 1

  return {
    shadowLayers: [
      { spread: Math.max(3, Math.round(scale * 3)), alpha: 26 },
      { spread: Math.max(2, Math.round(scale)), alpha: 18 },
    ],
    borderThickness: Math.max(1, Math.round(scale * 0.6)),
    separatorInset: Math.max(8, Math.round(scale * 8)),
    dividerThickness: 1,
    menuDotRadius: Math.max(2, Math.round(scale * 1.6)),
    menuDotGap: Math.max(6, Math.round(scale * 5.4)),
    closeRingRadius: Math.max(5, Math.round(scale * 3.2)),
    closeRingStroke: Math.max(2, Math.round(scale)),
  }
}

function requireJimp(config) {
  const jimp = require('jimp')
  if (jimp && typeof jimp.read === 'function') {
    return jimp
  }
  if (jimp && jimp.Jimp && typeof jimp.Jimp.read === 'function') {
    return {
      ...jimp,
      read: jimp.Jimp.read.bind(jimp.Jimp),
    }
  }
  return jimp
}

async function createBlankImage(Jimp, width, height, color) {
  if (typeof Jimp.create === 'function') {
    return Jimp.create(width, height, color)
  }
  throw new Error('Jimp blank image creation is not available')
}

const FOCUS_PALETTE = [
  { name: 'blue', rgb: [0, 102, 255] },
  { name: 'green', rgb: [0, 214, 143] },
  { name: 'amber', rgb: [255, 176, 0] },
  { name: 'pink', rgb: [255, 0, 153] },
  { name: 'purple', rgb: [153, 0, 255] },
  { name: 'red', rgb: [255, 69, 58] },
  { name: 'cyan', rgb: [0, 214, 255] },
  { name: 'lime', rgb: [164, 214, 0] },
]

function hashString(value) {
  let hash = 2166136261
  const input = String(value || '')
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360 / 360
  const saturation = clampNumber(s, 0, 100) / 100
  const lightness = clampNumber(l, 0, 100) / 100
  if (saturation === 0) {
    const gray = Math.round(lightness * 255)
    return [gray, gray, gray]
  }
  const q = lightness < 0.5
    ? lightness * (1 + saturation)
    : lightness + saturation - lightness * saturation
  const p = 2 * lightness - q
  const toRgb = (t) => {
    let channel = t
    if (channel < 0) channel += 1
    if (channel > 1) channel -= 1
    if (channel < 1 / 6) return p + (q - p) * 6 * channel
    if (channel < 1 / 2) return q
    if (channel < 2 / 3) return p + (q - p) * (2 / 3 - channel) * 6
    return p
  }
  return [
    Math.round(toRgb(hue + 1 / 3) * 255),
    Math.round(toRgb(hue) * 255),
    Math.round(toRgb(hue - 1 / 3) * 255),
  ]
}

function layoutIdentity(record) {
  return record && (record.ref || record.businessKey || record.selector || `${record.kind || 'node'}:${record.text || ''}`)
}

function rgba(Jimp, r, g, b, a) {
  return typeof Jimp.rgbaToInt === 'function'
    ? Jimp.rgbaToInt(r, g, b, a)
    : 0
}

function unpackRgba(color) {
  return {
    r: (color >>> 24) & 255,
    g: (color >>> 16) & 255,
    b: (color >>> 8) & 255,
    a: color & 255,
  }
}

function clampBox(box, bitmap) {
  const x = Math.max(0, Math.min(bitmap.width - 1, Math.round(box.x)))
  const y = Math.max(0, Math.min(bitmap.height - 1, Math.round(box.y)))
  const width = Math.max(1, Math.min(bitmap.width - x, Math.round(box.width)))
  const height = Math.max(1, Math.min(bitmap.height - y, Math.round(box.height)))

  return { x, y, width, height }
}

function insetBox(box, inset) {
  const safeInset = Math.max(0, Math.round(inset))
  const width = Math.max(1, box.width - safeInset * 2)
  const height = Math.max(1, box.height - safeInset * 2)

  return {
    x: box.x + safeInset,
    y: box.y + safeInset,
    width,
    height,
  }
}

function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function boxesOverlap(left, right) {
  return !(left.x + left.width <= right.x || right.x + right.width <= left.x || left.y + left.height <= right.y || right.y + right.height <= left.y)
}

function placeBadgeBox(preferredBox, image, occupiedBadges) {
  const candidateOffsets = [0, 28, 56, -28, 84, -56]
  for (const offset of candidateOffsets) {
    const candidate = clampBox({
      x: preferredBox.x,
      y: preferredBox.y + offset,
      width: preferredBox.width,
      height: preferredBox.height,
    }, image.bitmap)
    if (!occupiedBadges.some((item) => boxesOverlap(item, candidate))) {
      occupiedBadges.push(candidate)
      return candidate
    }
  }
  occupiedBadges.push(preferredBox)
  return preferredBox
}

function drawRectFill(image, box, color) {
  image.scan(box.x, box.y, box.width, box.height, function scan(_pixelX, _pixelY, idx) {
    this.bitmap.data.writeUInt32BE(color, idx)
  })
}

function blendRectFill(image, box, color) {
  const { r, g, b, a } = unpackRgba(color)
  const alpha = a / 255

  image.scan(box.x, box.y, box.width, box.height, function scan(_pixelX, _pixelY, idx) {
    const currentR = this.bitmap.data[idx]
    const currentG = this.bitmap.data[idx + 1]
    const currentB = this.bitmap.data[idx + 2]
    this.bitmap.data[idx] = Math.round(currentR * (1 - alpha) + r * alpha)
    this.bitmap.data[idx + 1] = Math.round(currentG * (1 - alpha) + g * alpha)
    this.bitmap.data[idx + 2] = Math.round(currentB * (1 - alpha) + b * alpha)
    this.bitmap.data[idx + 3] = 255
  })
}

function blendPixel(buffer, idx, r, g, b, alpha) {
  buffer[idx] = Math.round(buffer[idx] * (1 - alpha) + r * alpha)
  buffer[idx + 1] = Math.round(buffer[idx + 1] * (1 - alpha) + g * alpha)
  buffer[idx + 2] = Math.round(buffer[idx + 2] * (1 - alpha) + b * alpha)
  buffer[idx + 3] = 255
}

function blendHatchFill(image, box, color, options = {}) {
  const { r, g, b } = unpackRgba(color)
  const minDimension = Math.max(1, Math.min(box.width, box.height))
  const spacing = clampNumber(options.spacing || Math.round(minDimension * 0.5), 6, 12)
  const stripeWidth = clampNumber(options.stripeWidth || Math.round(spacing / 3), 1, 3)
  const baseAlpha = options.baseAlpha || 0.04
  const stripeAlpha = options.stripeAlpha || 0.18

  image.scan(box.x, box.y, box.width, box.height, function scan(pixelX, pixelY, idx) {
    const localX = pixelX - box.x
    const localY = pixelY - box.y
    const stripe = ((localX + localY) % spacing) < stripeWidth
    blendPixel(this.bitmap.data, idx, r, g, b, stripe ? stripeAlpha : baseAlpha)
  })
}

function drawRectOutline(image, box, color, thickness = 3) {
  const safeThickness = Math.max(1, Math.round(thickness))
  drawRectFill(image, { x: box.x, y: box.y, width: box.width, height: Math.min(box.height, safeThickness) }, color)
  drawRectFill(image, { x: box.x, y: Math.max(box.y, box.y + box.height - safeThickness), width: box.width, height: Math.min(box.height, safeThickness) }, color)
  drawRectFill(image, { x: box.x, y: box.y, width: Math.min(box.width, safeThickness), height: box.height }, color)
  drawRectFill(image, { x: Math.max(box.x, box.x + box.width - safeThickness), y: box.y, width: Math.min(box.width, safeThickness), height: box.height }, color)
}

function kindVisualStyle(Jimp, kind) {
  const styles = {
    button: {
      fill: rgba(Jimp, 219, 234, 254, 255),
      border: rgba(Jimp, 37, 99, 235, 255),
      labelBg: rgba(Jimp, 37, 99, 235, 228),
    },
    text: {
      fill: rgba(Jimp, 241, 245, 249, 255),
      border: rgba(Jimp, 148, 163, 184, 255),
      labelBg: rgba(Jimp, 71, 85, 105, 216),
    },
    input: {
      fill: rgba(Jimp, 255, 255, 255, 255),
      border: rgba(Jimp, 51, 65, 85, 255),
      labelBg: rgba(Jimp, 51, 65, 85, 220),
    },
    image: {
      fill: rgba(Jimp, 226, 232, 240, 255),
      border: rgba(Jimp, 71, 85, 105, 255),
      labelBg: rgba(Jimp, 71, 85, 105, 220),
    },
    default: {
      fill: rgba(Jimp, 248, 250, 252, 255),
      border: rgba(Jimp, 148, 163, 184, 255),
      labelBg: rgba(Jimp, 71, 85, 105, 220),
    },
  }

  return styles[kind] || styles.default
}

function resolveLayoutFontPath(config) {
  const candidates = [
    process.env.MINIPROGRAM_BROWSER_LAYOUT_FONT,
    process.env.MPB_LAYOUT_FONT,
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansSC-Regular.ttf',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate
    }
  }

  return ''
}

function resolveFontkitFont(fontPath) {
  const opened = fontkit.openSync(fontPath)
  if (opened && Array.isArray(opened.fonts) && opened.fonts.length) {
    return opened.fonts[0]
  }
  return opened
}

function measureGlyphRun(font, text, fontSize) {
  const run = font.layout(text)
  const scale = fontSize / font.unitsPerEm
  const width = run.positions.reduce((sum, position) => sum + (position.xAdvance || 0), 0) * scale
  return { run, width }
}

function fitLayoutText(font, text, fontSize, maxWidth) {
  const raw = String(text || '').trim()
  if (!raw) {
    return ''
  }

  if (measureGlyphRun(font, raw, fontSize).width <= maxWidth) {
    return raw
  }

  const chars = Array.from(raw)
  let current = ''
  for (const char of chars) {
    const next = `${current}${char}`
    if (measureGlyphRun(font, `${next}…`, fontSize).width > maxWidth) {
      return current ? `${current}…` : raw.slice(0, 1)
    }
    current = next
  }

  return raw
}

function drawGlyphRun(ctx, font, text, x, baselineY, fontSize) {
  const { run } = measureGlyphRun(font, text, fontSize)
  const scale = fontSize / font.unitsPerEm
  let penX = x

  for (let index = 0; index < run.glyphs.length; index += 1) {
    const glyph = run.glyphs[index]
    const position = run.positions[index]
    const glyphPath = glyph.path
    let hasPath = false
    ctx.beginPath()

    for (const command of glyphPath.commands) {
      const args = command.args || []
      if (command.command === 'moveTo') {
        hasPath = true
        ctx.moveTo(penX + args[0] * scale + position.xOffset * scale, baselineY - args[1] * scale - position.yOffset * scale)
      } else if (command.command === 'lineTo') {
        hasPath = true
        ctx.lineTo(penX + args[0] * scale + position.xOffset * scale, baselineY - args[1] * scale - position.yOffset * scale)
      } else if (command.command === 'quadraticCurveTo') {
        hasPath = true
        ctx.quadraticCurveTo(
          penX + args[0] * scale + position.xOffset * scale,
          baselineY - args[1] * scale - position.yOffset * scale,
          penX + args[2] * scale + position.xOffset * scale,
          baselineY - args[3] * scale - position.yOffset * scale,
        )
      } else if (command.command === 'bezierCurveTo') {
        hasPath = true
        ctx.bezierCurveTo(
          penX + args[0] * scale + position.xOffset * scale,
          baselineY - args[1] * scale - position.yOffset * scale,
          penX + args[2] * scale + position.xOffset * scale,
          baselineY - args[3] * scale - position.yOffset * scale,
          penX + args[4] * scale + position.xOffset * scale,
          baselineY - args[5] * scale - position.yOffset * scale,
        )
      } else if (command.command === 'closePath') {
        ctx.closePath()
      }
    }

    if (hasPath) {
      ctx.fill()
    }
    penX += position.xAdvance * scale
  }
}

function stripLayoutContextSuffix(text) {
  return String(text || '').replace(/\s*<[^>]+>\s*$/u, '').trim()
}

function buildLayoutTextItems(image, refs) {
  const parentRefs = new Set((refs || []).map((record) => record.parentRef).filter(Boolean))
  const byId = new Map((refs || []).map((record) => [record.ref || record.businessKey || record.selector, record]))
  const childrenByParent = new Map()
  for (const record of refs || []) {
    const parentId = record.parentRef
    if (parentId) {
      const existingChildren = childrenByParent.get(parentId) || []
      existingChildren.push(record)
      childrenByParent.set(parentId, existingChildren)
    }
  }

  const textByNode = new Map()
  function collectDescendantTexts(record) {
    const id = record.ref || record.businessKey || record.selector
    if (!id) {
      return new Set()
    }
    if (textByNode.has(id)) {
      return textByNode.get(id)
    }

    const texts = new Set()
    for (const child of childrenByParent.get(id) || []) {
      const childText = stripLayoutContextSuffix(child.text)
      if (child.kind === 'text' && childText) {
        texts.add(childText)
      }
      for (const item of collectDescendantTexts(child)) {
        texts.add(item)
      }
    }
    textByNode.set(id, texts)
    return texts
  }

  for (const record of refs || []) {
    if (!record || record.kind !== 'text' || !record.parentRef) {
      continue
    }
    const normalized = stripLayoutContextSuffix(record.text)
    if (!normalized) {
      continue
    }
    collectDescendantTexts(byId.get(record.parentRef) || record)
  }
  const items = []

  for (const record of refs || []) {
    const text = stripLayoutContextSuffix(record && record.text)
    if (!record || !record.rectPct || !text) {
      continue
    }
    if (record.kind === 'view' && parentRefs.has(record.ref)) {
      continue
    }
    if (record.kind !== 'text') {
      const childTexts = collectDescendantTexts(record)
      if (childTexts && childTexts.has(text)) {
        continue
      }
    }

    const box = clampBox({
      x: image.bitmap.width * (record.rectPct.x / 100),
      y: image.bitmap.height * (record.rectPct.y / 100),
      width: image.bitmap.width * (record.rectPct.w / 100),
      height: image.bitmap.height * (record.rectPct.h / 100),
    }, image.bitmap)

    items.push({ ref: record.ref, kind: record.kind, text, box, safeBox: { ...box } })
  }

  return items
}

function computeTextSafeBoxes(textItems, occupiedBadges) {
  for (const item of textItems || []) {
    const safeBox = {
      x: item.box.x + 8,
      y: item.box.y + 6,
      width: Math.max(1, item.box.width - 16),
      height: Math.max(1, item.box.height - 10),
    }
    for (const badge of occupiedBadges || []) {
      if (!boxesOverlap(safeBox, badge)) {
        continue
      }
      const badgeBottom = badge.y + badge.height + 4
      const badgeRight = badge.x + badge.width + 6
      if (badgeBottom > safeBox.y && badgeBottom < item.box.y + item.box.height) {
        const delta = badgeBottom - safeBox.y
        safeBox.y += delta
        safeBox.height = Math.max(1, safeBox.height - delta)
      }
      if (badgeRight > safeBox.x && badgeRight < item.box.x + item.box.width) {
        const delta = badgeRight - safeBox.x
        safeBox.x += delta
        safeBox.width = Math.max(1, safeBox.width - delta)
      }
    }
    item.safeBox = safeBox
  }
  return textItems
}

function drawCapsuleOverlay(image, Jimp, systemInfo, menuButtonRect) {
  const navigationMetrics = resolveNavigationMetrics(systemInfo || {}, menuButtonRect)
  const box = resolveCapsuleBox({
    imageWidth: image.bitmap.width,
    navigationMetrics,
    windowWidth: (systemInfo && (systemInfo.windowWidth || systemInfo.screenWidth)) || 375,
    pixelRatio: (systemInfo && systemInfo.pixelRatio) || 1,
  })
  const fillColor = rgba(Jimp, 255, 255, 255, 232)
  const borderColor = rgba(Jimp, 148, 163, 184, 168)
  const iconColor = rgba(Jimp, 71, 85, 105, 255)
  const paint = resolveCapsulePaintSpec(box)

  drawRoundedRect(image, box, fillColor, borderColor)
  drawLine(image, box.separatorX, box.y + paint.separatorInset, box.separatorX, box.y + box.height - paint.separatorInset, borderColor, paint.dividerThickness)
  const leftCenterX = box.x + Math.round(box.width * 0.25)
  const rightCenterX = box.x + Math.round(box.width * 0.75)
  drawCircle(image, leftCenterX - paint.menuDotGap, box.centerY, paint.menuDotRadius, iconColor)
  drawCircle(image, leftCenterX, box.centerY, paint.menuDotRadius, iconColor)
  drawCircle(image, leftCenterX + paint.menuDotGap, box.centerY, paint.menuDotRadius, iconColor)
  drawRing(image, rightCenterX, box.centerY, paint.closeRingRadius, paint.closeRingStroke, iconColor)
}

async function renderLayoutTextOverlay({ image, refs, textItems, systemInfo }) {
  const fontPath = resolveLayoutFontPath()
  if (!fontPath) {
    return false
  }

  const font = resolveFontkitFont(fontPath)
  const canvas = PImage.make(image.bitmap.width, image.bitmap.height)
  const ctx = canvas.getContext('2d')
  canvas.data.fill(0)
  ctx.fillStyle = '#0f172a'

  for (const record of textItems || []) {
    const box = record.safeBox || record.box
    const fontSize = clampNumber(Math.round(box.height * 0.56), 10, 24)
    const maxWidth = Math.max(8, box.width)
    const text = fitLayoutText(font, record.text, fontSize, maxWidth)
    if (!text) {
      continue
    }
    drawGlyphRun(ctx, font, text, box.x, box.y + fontSize, fontSize)
  }

  const overlayPath = path.join(os.tmpdir(), `mpb-layout-text-${Date.now()}-${Math.random().toString(16).slice(2)}.png`)
  await PImage.encodePNGToStream(canvas, fs.createWriteStream(overlayPath))
  const Jimp = requireJimp({})
  const overlay = await Jimp.read(overlayPath)
  image.composite(overlay, 0, 0)
  try {
    await fs.promises.unlink(overlayPath)
  } catch (_) {
  }
  return true
}

function buildLayoutMetrics(refs) {
  const byRef = new Map((refs || []).map((record) => [layoutIdentity(record), record]))
  const cache = new Map()
  let rootIndex = 0

  function resolve(record) {
    if (!record) {
      return { depth: 0, group: 0 }
    }
    const identity = layoutIdentity(record)
    if (cache.has(identity)) {
      return cache.get(identity)
    }
    if (!record.parentRef) {
      const result = { depth: 0, group: rootIndex++ }
      cache.set(identity, result)
      return result
    }
    const parentMetrics = resolve(byRef.get(record.parentRef))
    const result = { depth: parentMetrics.depth + 1, group: parentMetrics.group }
    cache.set(identity, result)
    return result
  }

  for (const record of refs || []) {
    resolve(record)
  }

  return cache
}

function layoutColorScheme(Jimp, record, metrics) {
  const metric = metrics.get(layoutIdentity(record)) || { depth: 0, group: 0 }
  const identityHash = hashString(layoutIdentity(record))
  const hue = (metric.group * 83 + identityHash) % 360
  const fill = hslToRgb(hue, 72, clampNumber(88 - metric.depth * 4, 62, 90))
  const border = hslToRgb(hue, 82, clampNumber(52 - metric.depth * 2, 34, 56))
  const label = hslToRgb(hue, 76, clampNumber(40 - metric.depth, 28, 44))

  return {
    fill: rgba(Jimp, ...fill, 255),
    border: rgba(Jimp, ...border, 255),
    labelBg: rgba(Jimp, ...label, 228),
    labelText: rgba(Jimp, 255, 255, 255, 255),
    metric,
  }
}

function textForLayout(record) {
  return record.ref
}

function drawLayoutNode(image, Jimp, record, font, metrics, badgeState, options = {}) {
  if (!record || !record.rectPct) {
    return
  }

  const box = clampBox({
    x: image.bitmap.width * (record.rectPct.x / 100),
    y: image.bitmap.height * (record.rectPct.y / 100),
    width: image.bitmap.width * (record.rectPct.w / 100),
    height: image.bitmap.height * (record.rectPct.h / 100),
  }, image.bitmap)
  const minDimension = Math.max(1, Math.min(box.width, box.height))
  const borderThickness = clampNumber(Math.round(minDimension * 0.05), 1, 6)
  const innerBox = insetBox(box, 1)
  const paletteStyle = layoutColorScheme(Jimp, record, metrics)
  const fillAlpha = record.kind === 'view'
    ? clampNumber(28 + (paletteStyle.metric.depth * 10), 28, 64)
    : 255
  blendRectFill(image, box, (paletteStyle.fill & 0xffffff00) | fillAlpha)
  drawRectOutline(image, box, rgba(Jimp, 15, 23, 42, 180), borderThickness + 1)
  drawRectOutline(image, innerBox, paletteStyle.border, borderThickness)

  if (options.drawBadge) {
    drawSemanticBadge(image, Jimp, record, font, badgeState, paletteStyle.metric.depth)
  }
}

function drawSemanticBadge(image, Jimp, record, font, badgeState, depth = 0) {
  if (!record || !record.ref || !record.rectPct) {
    return
  }

  const box = clampBox({
    x: image.bitmap.width * (record.rectPct.x / 100),
    y: image.bitmap.height * (record.rectPct.y / 100),
    width: image.bitmap.width * (record.rectPct.w / 100),
    height: image.bitmap.height * (record.rectPct.h / 100),
  }, image.bitmap)
  const labelWidth = clampNumber(Math.max(56, record.ref.length * 10 + 18), 56, Math.max(56, image.bitmap.width - box.x))
  const labelBox = placeBadgeBox(clampBox({
    x: (depth % 2 === 0)
      ? box.x
      : Math.max(0, box.x + box.width - labelWidth),
    y: Math.max(0, box.y - 24),
    width: labelWidth,
    height: 20,
  }, image.bitmap), image, badgeState.badges)
  const badgeMetrics = badgeState.metrics || new Map()
  const badgePalette = layoutColorScheme(Jimp, record, badgeMetrics)
  drawRoundedRect(image, labelBox, badgePalette.labelBg, rgba(Jimp, 15, 23, 42, 220))
  if (font && typeof image.print === 'function') {
    image.print(font, labelBox.x + 6, labelBox.y + 4, record.ref, Math.max(1, labelWidth - 12))
  }
}

async function captureLayoutScreenshot({
  targetPath,
  config,
  refs,
  focusRefs,
  focusRecords,
  badgeRecords,
  noRef,
  systemInfo,
  menuButtonRect,
  capsule,
  createImageAdapter,
  colorAdapter,
  textRenderer,
}) {
  const Jimp = colorAdapter || requireJimp(config)
  const windowWidth = Number(systemInfo && (systemInfo.windowWidth || systemInfo.screenWidth)) || 375
  const windowHeight = Number(systemInfo && (systemInfo.windowHeight || systemInfo.screenHeight)) || 812
  const imageWidth = Math.max(1080, Math.round(windowWidth * 2.5))
  const imageHeight = Math.max(320, Math.round(imageWidth * (windowHeight / windowWidth)))
  const image = createImageAdapter
    ? await createImageAdapter(targetPath)
    : await createBlankImage(Jimp, imageWidth, imageHeight, rgba(Jimp, 248, 250, 252, 255))
  const font = typeof Jimp.loadFont === 'function' && Jimp.FONT_SANS_16_WHITE
    ? await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
    : null
  const metrics = buildLayoutMetrics(refs)
  const badgeState = { badges: [], metrics: buildLayoutMetrics(badgeRecords || refs) }
  const suppressedBadgeRefs = new Set(Array.isArray(focusRefs) ? focusRefs : [])
  const semanticBadges = badgeRecords || refs || []

  drawRectFill(image, { x: 0, y: 0, width: image.bitmap.width, height: image.bitmap.height }, rgba(Jimp, 248, 250, 252, 255))
  if (capsule) {
    drawCapsuleOverlay(image, Jimp, systemInfo, menuButtonRect)
  }
  for (const record of refs || []) {
    drawLayoutNode(image, Jimp, record, font, metrics, badgeState, { drawBadge: false })
  }

  for (const record of semanticBadges) {
    if (suppressedBadgeRefs.has(record.ref)) {
      continue
    }
    if (!noRef) {
      drawSemanticBadge(image, Jimp, record, font, badgeState, 0)
    }
  }

  const textItems = computeTextSafeBoxes(buildLayoutTextItems(image, refs), badgeState.badges)

  if (textRenderer) {
    await textRenderer({ image, refs, systemInfo, textItems })
  } else if (typeof image.composite === 'function') {
    await renderLayoutTextOverlay({ image, refs, textItems, systemInfo })
  }

  let focusLegend = []
  if (Array.isArray(focusRefs) && focusRefs.length) {
    focusLegend = renderFocusOverlay(image, Jimp, resolveFocusTargets(focusRecords || semanticBadges || refs, focusRefs), font, { showLabel: !noRef })
  }

  await image.writeAsync(targetPath)

  return {
    path: targetPath,
    mode: 'layout',
    source: focusLegend.length ? 'layout+focus' : 'layout',
    focusLegend,
  }
}

function resolveFocusTargets(refs, focusRefs) {
  const requested = Array.isArray(focusRefs) ? focusRefs : []
  if (!requested.length) {
    return []
  }

  const byRef = new Map((refs || []).map((item) => [item.ref, item]))
  const missing = requested.filter((ref) => !byRef.has(ref))
  if (missing.length) {
    throw new Error(`Unknown focus refs: ${missing.join(', ')}`)
  }

  return requested.map((ref, index) => ({
    ...byRef.get(ref),
    color: FOCUS_PALETTE[index % FOCUS_PALETTE.length],
  }))
}

function renderFocusOverlay(image, Jimp, refs, font, options = {}) {
  const legend = []
  const showLabel = options.showLabel !== false

  for (const item of refs || []) {
    if (!item.rectPct) {
      continue
    }

    const box = clampBox({
      x: image.bitmap.width * (item.rectPct.x / 100),
      y: image.bitmap.height * (item.rectPct.y / 100),
      width: image.bitmap.width * (item.rectPct.w / 100),
      height: image.bitmap.height * (item.rectPct.h / 100),
    }, image.bitmap)
    const minDimension = Math.max(1, Math.min(box.width, box.height))
    const borderThickness = clampNumber(Math.round(minDimension * 0.08), 2, 8)
    const outerThickness = clampNumber(borderThickness + 2, 3, 10)
    const innerBox = insetBox(box, 1)
    const borderColor = rgba(Jimp, ...item.color.rgb, 255)
    const outerBorderColor = rgba(Jimp, 15, 23, 42, 255)
    const fillColor = rgba(Jimp, ...item.color.rgb, 255)
    const labelFill = rgba(Jimp, ...item.color.rgb, 228)
    const labelBorder = rgba(Jimp, 15, 23, 42, 216)
    const labelWidth = Math.max(52, item.ref.length * 10 + 18)
    const labelBox = clampBox({
      x: box.x,
      y: Math.max(0, box.y - 28),
      width: Math.min(labelWidth, image.bitmap.width - box.x),
      height: 24,
    }, image.bitmap)

    blendHatchFill(image, box, fillColor)
    drawRectOutline(image, box, outerBorderColor, outerThickness)
    drawRectOutline(image, innerBox, borderColor, borderThickness)
    if (showLabel) {
      drawRoundedRect(image, labelBox, labelFill, labelBorder)
      if (font && typeof image.print === 'function') {
        image.print(font, labelBox.x + 6, labelBox.y + 5, item.ref)
      }
    }
    legend.push(`${item.ref} [${item.kind}] ${item.text || ''} color=${item.color.name}`.trim())
  }

  return legend
}

async function overlayFocusScreenshot({
  targetPath,
  config,
  refs,
  focusRefs,
  noRef,
  createImageAdapter,
  colorAdapter,
}) {
  const targets = resolveFocusTargets(refs, focusRefs)
  const Jimp = colorAdapter || requireJimp(config)
  const image = createImageAdapter ? await createImageAdapter(targetPath) : await Jimp.read(targetPath)
  const font = typeof Jimp.loadFont === 'function' && Jimp.FONT_SANS_16_WHITE
    ? await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
    : null
  const focusLegend = renderFocusOverlay(image, Jimp, targets, font, { showLabel: !noRef })

  await image.writeAsync(targetPath)

  return {
    path: targetPath,
    focusLegend,
  }
}

async function readOfficialMenuButtonRect(miniProgram, timeoutMs = 800) {
  const tasks = []

  if (typeof miniProgram.evaluate === 'function') {
    tasks.push(Promise.resolve().then(() => miniProgram.evaluate(() => wx.getMenuButtonBoundingClientRect())))
  }

  if (typeof miniProgram.callWxMethod === 'function') {
    tasks.push(Promise.resolve().then(() => miniProgram.callWxMethod('getMenuButtonBoundingClientRect')))
  }

  if (!tasks.length) {
    return undefined
  }

  try {
    return await Promise.race([
      ...tasks,
      new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs)),
    ])
  } catch (_) {
    return undefined
  }
}

function drawRoundedRect(image, box, fillColor, borderColor) {
  const radius = Math.round(box.height / 2)

  image.scan(box.x, box.y, box.width, box.height, function scan(pixelX, pixelY, idx) {
    const localX = pixelX - box.x
    const localY = pixelY - box.y
    let inside = false

    if (localX >= radius && localX < box.width - radius) {
      inside = true
    } else {
      const centerX = localX < radius ? radius : box.width - radius
      const dx = localX - centerX
      const dy = localY - radius
      inside = dx * dx + dy * dy <= radius * radius
    }

    if (!inside) {
      return
    }

    const isBorder = localY < 2 || localY >= box.height - 2 || localX < 2 || localX >= box.width - 2
    this.bitmap.data.writeUInt32BE(isBorder ? borderColor : fillColor, idx)
  })
}

function expandBox(box, spread, offsetY = 0) {
  return {
    x: box.x - spread,
    y: box.y - spread + offsetY,
    width: box.width + spread * 2,
    height: box.height + spread * 2,
  }
}

function drawLine(image, x1, y1, x2, y2, color, thickness = 2) {
  const minX = Math.min(x1, x2)
  const maxX = Math.max(x1, x2)
  const minY = Math.min(y1, y2)
  const maxY = Math.max(y1, y2)

  image.scan(minX - thickness, minY - thickness, maxX - minX + thickness * 2 + 1, maxY - minY + thickness * 2 + 1, function scan(pixelX, pixelY, idx) {
    const area = Math.abs((y2 - y1) * pixelX - (x2 - x1) * pixelY + x2 * y1 - y2 * x1)
    const base = Math.hypot(y2 - y1, x2 - x1) || 1
    const distance = area / base
    if (distance <= thickness) {
      this.bitmap.data.writeUInt32BE(color, idx)
    }
  })
}

function drawCircle(image, centerX, centerY, radius, color) {
  image.scan(centerX - radius, centerY - radius, radius * 2 + 1, radius * 2 + 1, function scan(pixelX, pixelY, idx) {
    const dx = pixelX - centerX
    const dy = pixelY - centerY
    if (dx * dx + dy * dy <= radius * radius) {
      this.bitmap.data.writeUInt32BE(color, idx)
    }
  })
}

function drawRing(image, centerX, centerY, radius, strokeWidth, color) {
  image.scan(centerX - radius - strokeWidth, centerY - radius - strokeWidth, (radius + strokeWidth) * 2 + 1, (radius + strokeWidth) * 2 + 1, function scan(pixelX, pixelY, idx) {
    const dx = pixelX - centerX
    const dy = pixelY - centerY
    const distance = Math.sqrt(dx * dx + dy * dy)
    if (distance <= radius && distance >= radius - strokeWidth) {
      this.bitmap.data.writeUInt32BE(color, idx)
    }
  })
}

async function captureVisualScreenshot({
  miniProgram,
  targetPath,
  config,
  timeoutMs = 15000,
  pageCapture,
  createImageAdapter,
  colorAdapter,
}) {
  const Jimp = colorAdapter || requireJimp(config)
  const capturePage = pageCapture || (async (destinationPath) => {
    await miniProgram.screenshot({ path: destinationPath })
    return destinationPath
  })

  await capturePage(targetPath, timeoutMs)

  const systemInfo = await miniProgram.systemInfo()
  const menuButtonRect = await readOfficialMenuButtonRect(miniProgram, 800)

  const image = createImageAdapter ? await createImageAdapter(targetPath) : await Jimp.read(targetPath)
  const navigationMetrics = resolveNavigationMetrics(systemInfo, menuButtonRect)
  const box = resolveCapsuleBox({
    imageWidth: image.bitmap.width,
    navigationMetrics,
    windowWidth: systemInfo.windowWidth || systemInfo.screenWidth || 375,
    pixelRatio: systemInfo.pixelRatio || 1,
  })

  const fillColor = Jimp.rgbaToInt(255, 255, 255, 232)
  const borderColor = Jimp.rgbaToInt(148, 163, 184, 168)
  const iconColor = Jimp.rgbaToInt(71, 85, 105, 255)
  const shadowColor = (alpha) => Jimp.rgbaToInt(15, 23, 42, alpha)
  const paint = resolveCapsulePaintSpec(box)

  for (const layer of paint.shadowLayers) {
    drawRoundedRect(image, expandBox(box, layer.spread, Math.max(1, Math.round(box.scale * 0.6))), shadowColor(layer.alpha), shadowColor(0))
  }

  drawRoundedRect(image, box, fillColor, borderColor)
  drawLine(image, box.separatorX, box.y + paint.separatorInset, box.separatorX, box.y + box.height - paint.separatorInset, borderColor, paint.dividerThickness)

  const leftCenterX = box.x + Math.round(box.width * 0.25)
  const rightCenterX = box.x + Math.round(box.width * 0.75)

  drawCircle(image, leftCenterX - paint.menuDotGap, box.centerY, paint.menuDotRadius, iconColor)
  drawCircle(image, leftCenterX, box.centerY, paint.menuDotRadius, iconColor)
  drawCircle(image, leftCenterX + paint.menuDotGap, box.centerY, paint.menuDotRadius, iconColor)

  drawRing(image, rightCenterX, box.centerY, paint.closeRingRadius, paint.closeRingStroke, iconColor)

  await image.writeAsync(targetPath)

  return {
    path: targetPath,
    mode: 'visual',
    source: menuButtonRect ? 'page+menuRect' : 'page+fallback-capsule',
  }
}

async function captureAnnotatedScreenshot({
  miniProgram,
  targetPath,
  config,
  refs,
  focusRefs,
  noRef,
  timeoutMs = 15000,
  pageCapture,
  createImageAdapter,
  colorAdapter,
}) {
  const Jimp = colorAdapter || requireJimp(config)
  const capturePage = pageCapture || (async (destinationPath) => {
    await miniProgram.screenshot({ path: destinationPath })
    return destinationPath
  })

  await capturePage(targetPath, timeoutMs)

  const image = createImageAdapter ? await createImageAdapter(targetPath) : await Jimp.read(targetPath)
  const font = typeof Jimp.loadFont === 'function' && Jimp.FONT_SANS_16_WHITE
    ? await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
    : null
  const fillColor = typeof Jimp.rgbaToInt === 'function'
    ? Jimp.rgbaToInt(15, 23, 42, 232)
    : 0
  const borderColor = typeof Jimp.rgbaToInt === 'function'
    ? Jimp.rgbaToInt(148, 163, 184, 180)
    : 0
  const legend = []
  const focusLegend = renderFocusOverlay(image, Jimp, resolveFocusTargets(refs, focusRefs), font, { showLabel: !noRef })

  if (!noRef) {
    for (const item of refs || []) {
      if (!item.rectPct) {
        continue
      }

      const label = item.ref
      const x = Math.max(0, Math.round(image.bitmap.width * (item.rectPct.x / 100)))
      const y = Math.max(0, Math.round(image.bitmap.height * (item.rectPct.y / 100)) - 24)
      const width = Math.max(42, label.length * 10 + 12)
      const box = {
        x,
        y,
        width: Math.min(width, image.bitmap.width - x),
        height: 22,
      }

      drawRoundedRect(image, box, fillColor, borderColor)
      if (font && typeof image.print === 'function') {
        image.print(font, box.x + 6, box.y + 4, label)
      }
      legend.push(`${item.ref} [${item.kind}] ${item.text || ''}`.trim())
    }
  }

  await image.writeAsync(targetPath)

  return {
    path: targetPath,
    mode: 'annotate',
    source: focusLegend.length ? 'page+refs+focus' : 'page+refs',
    legend,
    focusLegend,
  }
}

module.exports = {
  captureAnnotatedScreenshot,
  captureLayoutScreenshot,
  overlayFocusScreenshot,
  layoutColorScheme,
  resolveNavigationMetrics,
  resolveCapsuleBox,
  resolveCapsulePaintSpec,
  readOfficialMenuButtonRect,
  captureVisualScreenshot,
}
