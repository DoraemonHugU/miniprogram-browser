const fs = require('node:fs/promises')
const path = require('node:path')

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

function buildSemanticSignature(records = []) {
  return JSON.stringify((records || []).map((record) => [record.kind || '', record.text || '']))
}

function buildGridLayout(width, height, columns = 8) {
  const safeWidth = Math.max(1, Number(width || 1))
  const safeHeight = Math.max(1, Number(height || 1))
  const safeColumns = Math.max(1, Number(columns || 8))
  const cellSize = Math.max(1, Math.ceil(safeWidth / safeColumns))
  const rows = Math.max(1, Math.ceil(safeHeight / cellSize))

  return {
    width: safeWidth,
    height: safeHeight,
    columns: safeColumns,
    rows,
    cellSize,
  }
}

function computeCellGridFromBitmap(bitmap, columns = 8) {
  const layout = buildGridLayout(bitmap.width, bitmap.height, columns)
  const totals = new Array(layout.columns * layout.rows).fill(0)
  const counts = new Array(layout.columns * layout.rows).fill(0)

  for (let y = 0; y < bitmap.height; y += 1) {
    for (let x = 0; x < bitmap.width; x += 1) {
      const index = (bitmap.width * y + x) << 2
      const r = bitmap.data[index]
      const g = bitmap.data[index + 1]
      const b = bitmap.data[index + 2]
      const cellX = Math.min(layout.columns - 1, Math.floor(x / layout.cellSize))
      const cellY = Math.min(layout.rows - 1, Math.floor(y / layout.cellSize))
      const cellIndex = cellY * layout.columns + cellX
      const gray = Math.round(r * 0.299 + g * 0.587 + b * 0.114)
      totals[cellIndex] += gray
      counts[cellIndex] += 1
    }
  }

  const cells = totals.map((total, index) => {
    const count = counts[index] || 1
    return Math.round(total / count)
  })

  return {
    layout,
    cells,
  }
}

async function createVisualProbe({
  miniProgram,
  page,
  records,
  config,
  columns = 8,
  screenshotPath,
  cleanupScreenshot = false,
  captureScreenshot,
  createImageAdapter,
}) {
  const targetPath = screenshotPath || path.join(config.tempScreenshotDir || '/tmp', `visual-probe-${Date.now()}-${Math.random().toString(16).slice(2)}.png`)
  const performCapture = captureScreenshot || (async (instance, outputPath) => {
    await instance.screenshot({ path: outputPath })
    return outputPath
  })

  if (!screenshotPath) {
    await performCapture(miniProgram, targetPath)
  }

  const Jimp = createImageAdapter ? null : requireJimp(config)
  const image = createImageAdapter ? await createImageAdapter(targetPath) : await Jimp.read(targetPath)
  const { layout, cells } = computeCellGridFromBitmap(image.bitmap, columns)
  const systemInfo = await miniProgram.systemInfo()
  const refs = await collectRecordRects(page, records, systemInfo)

  if (!screenshotPath || cleanupScreenshot) {
    await fs.rm(targetPath, { force: true }).catch(() => {})
  }

  return {
    route: page.path,
    semanticSignature: buildSemanticSignature(records),
    layout,
    cells,
    refs,
  }
}

async function collectRecordRects(page, records, systemInfo) {
  const bySelector = new Map()
  for (const record of records || []) {
    const selector = record && record.strategy ? record.strategy.selector : null
    if (!selector) {
      continue
    }
    const list = bySelector.get(selector) || []
    list.push(record)
    bySelector.set(selector, list)
  }

  const windowWidth = Number(systemInfo && systemInfo.windowWidth) || Number(systemInfo && systemInfo.screenWidth) || 375
  const windowHeight = Number(systemInfo && systemInfo.windowHeight) || Number(systemInfo && systemInfo.screenHeight) || 812
  const refs = []

  for (const [selector, selectorRecords] of bySelector.entries()) {
    let elements = []
    try {
      elements = await page.$$(selector)
    } catch (_) {
      continue
    }

    for (const record of selectorRecords) {
      const element = elements[Number(record.strategy.index || 0)]
      if (!element) {
        continue
      }
      try {
        const [size, offset] = await Promise.all([element.size(), element.offset()])
        const width = Number(size && size.width) || 0
        const height = Number(size && size.height) || 0
        const left = Number(offset && offset.left) || 0
        const top = Number(offset && offset.top) || 0
        refs.push({
          ref: record.ref,
          kind: record.kind,
          text: record.text,
          rectPct: {
            x: roundPct(left / windowWidth * 100),
            y: roundPct(top / windowHeight * 100),
            w: roundPct(width / windowWidth * 100),
            h: roundPct(height / windowHeight * 100),
          },
        })
      } catch (_) {
      }
    }
  }

  return refs
}

function roundPct(value) {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10))
}

function rectsIntersect(regionPct, rectPct) {
  const left = regionPct.x
  const right = regionPct.x + regionPct.w
  const top = regionPct.y
  const bottom = regionPct.y + regionPct.h
  const rectLeft = rectPct.x
  const rectRight = rectPct.x + rectPct.w
  const rectTop = rectPct.y
  const rectBottom = rectPct.y + rectPct.h

  return !(rectLeft >= right || rectRight <= left || rectTop >= bottom || rectBottom <= top)
}

function buildVisualDiffSummary(beforeProbe, afterProbe, options = {}) {
  if (!beforeProbe || !afterProbe) {
    return null
  }
  if (beforeProbe.route !== afterProbe.route) {
    return null
  }
  if (beforeProbe.semanticSignature !== afterProbe.semanticSignature) {
    return null
  }

  const beforeLayout = beforeProbe.layout
  const afterLayout = afterProbe.layout
  if (!beforeLayout || !afterLayout) {
    return null
  }
  if (beforeLayout.columns !== afterLayout.columns || beforeLayout.rows !== afterLayout.rows) {
    return null
  }

  const threshold = Number(options.cellThreshold || 8)
  const changed = new Set()
  for (let index = 0; index < afterProbe.cells.length; index += 1) {
    const diff = Math.abs(Number(afterProbe.cells[index] || 0) - Number(beforeProbe.cells[index] || 0))
    if (diff >= threshold) {
      changed.add(index)
    }
  }

  if (changed.size === 0) {
    return null
  }

  const regions = []
  const visited = new Set()
  const { columns, rows } = afterLayout
  const neighbors = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]

  for (const start of changed) {
    if (visited.has(start)) {
      continue
    }

    const queue = [start]
    visited.add(start)
    let minX = columns
    let maxX = 0
    let minY = rows
    let maxY = 0

    while (queue.length > 0) {
      const current = queue.shift()
      const x = current % columns
      const y = Math.floor(current / columns)
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x)
      minY = Math.min(minY, y)
      maxY = Math.max(maxY, y)

      for (const [dx, dy] of neighbors) {
        const nextX = x + dx
        const nextY = y + dy
        if (nextX < 0 || nextX >= columns || nextY < 0 || nextY >= rows) {
          continue
        }
        const nextIndex = nextY * columns + nextX
        if (!changed.has(nextIndex) || visited.has(nextIndex)) {
          continue
        }
        visited.add(nextIndex)
        queue.push(nextIndex)
      }
    }

    const regionPct = {
      x: roundPct(minX / columns * 100),
      y: roundPct(minY / rows * 100),
      w: roundPct((maxX - minX + 1) / columns * 100),
      h: roundPct((maxY - minY + 1) / rows * 100),
    }

    regions.push({
      regionPct,
      beforeRefs: (beforeProbe.refs || [])
        .filter((item) => item.rectPct && rectsIntersect(regionPct, item.rectPct))
        .map((item) => ({ ref: item.ref, kind: item.kind, text: item.text })),
      afterRefs: (afterProbe.refs || [])
        .filter((item) => item.rectPct && rectsIntersect(regionPct, item.rectPct))
        .map((item) => ({ ref: item.ref, kind: item.kind, text: item.text })),
    })
  }

  return {
    visualChanged: true,
    regions,
  }
}

module.exports = {
  buildSemanticSignature,
  buildGridLayout,
  computeCellGridFromBitmap,
  collectRecordRects,
  createVisualProbe,
  buildVisualDiffSummary,
}
