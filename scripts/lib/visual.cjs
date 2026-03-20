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
  return require('jimp')
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
  const font = typeof Jimp.loadFont === 'function' ? await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE) : null
  const fillColor = typeof Jimp.rgbaToInt === 'function'
    ? Jimp.rgbaToInt(15, 23, 42, 232)
    : 0
  const borderColor = typeof Jimp.rgbaToInt === 'function'
    ? Jimp.rgbaToInt(148, 163, 184, 180)
    : 0
  const legend = []

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
    source: 'page+refs',
    legend,
  }
}

module.exports = {
  captureAnnotatedScreenshot,
  resolveNavigationMetrics,
  resolveCapsuleBox,
  resolveCapsulePaintSpec,
  readOfficialMenuButtonRect,
  captureVisualScreenshot,
}
