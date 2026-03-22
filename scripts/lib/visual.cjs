const path = require('node:path')

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

function renderFocusOverlay(image, Jimp, refs, font) {
  const legend = []

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
    drawRoundedRect(image, labelBox, labelFill, labelBorder)
    if (font && typeof image.print === 'function') {
      image.print(font, labelBox.x + 6, labelBox.y + 5, item.ref)
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
  createImageAdapter,
  colorAdapter,
}) {
  const targets = resolveFocusTargets(refs, focusRefs)
  const Jimp = colorAdapter || requireJimp(config)
  const image = createImageAdapter ? await createImageAdapter(targetPath) : await Jimp.read(targetPath)
  const font = typeof Jimp.loadFont === 'function' && Jimp.FONT_SANS_16_WHITE
    ? await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE)
    : null
  const focusLegend = renderFocusOverlay(image, Jimp, targets, font)

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
  const focusLegend = renderFocusOverlay(image, Jimp, resolveFocusTargets(refs, focusRefs), font)

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
  overlayFocusScreenshot,
  resolveNavigationMetrics,
  resolveCapsuleBox,
  resolveCapsulePaintSpec,
  readOfficialMenuButtonRect,
  captureVisualScreenshot,
}
