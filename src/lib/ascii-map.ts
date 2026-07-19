/**
 * ASCII 空间线框渲染器（纯文本，零图像依赖）。
 *
 * 输入：带 rectPct（0–100% 相对窗口）的 ref 列表；可选 parentRef。
 * 输出：图例 + 网格；无 rect 则空串。
 *
 * 流水线：Normalize → Project → LOD → Order → Borders → Labels → Composite
 * - 全量有 rect 的节点进管线（不靠 kind 漏画子组件）
 * - LOD：够大画框，太小只标 @eN 数字；interactive 阈值更松
 * - Label 智能避让：多候选评分；失败才 *
 * - 几何只用百分比，禁止 × devicePixelRatio
 *
 * 契约：.trellis/spec/cli/ascii-map-contracts.md
 */

type AnyRecord = Record<string, unknown>

type LodMode = 'box' | 'mark' | 'skip'

interface CellRect {
  c0: number
  c1: number
  r0: number
  r1: number
}

interface PaintNode {
  ref: string
  kind: string
  parentRef: string
  rectPct: { x: number; y: number; w: number; h: number }
  cells: CellRect
  area: number
  depth: number
  lod: LodMode
  interactive: boolean
  label: string
}

interface MapOptions {
  viewport?: { w?: number; h?: number; pixelRatio?: number }
  mapWidth?: number
  maxBoxDepth?: number
  maxLabelShift?: number
  legacy?: boolean
}

const DEFAULT_MAP_WIDTH = 48
const MIN_GRID_H = 16
const MAX_GRID_H = 56

const CONTAINER_KINDS = new Set([
  'view', 'container', 'scroll-view', 'scrollview', 'scroll',
  'list', 'list-view', 'nav', 'navbar', 'tabbar', 'tab', 'tabs',
  'page', 'root', 'swiper', 'swiper-item', 'form', 'cell-group', 'section',
])

const INTERACTIVE_KINDS = new Set([
  'button', 'input', 'textarea', 'switch', 'checkbox', 'radio',
  'slider', 'picker', 'navigator', 'link', 'image-button',
])

// border bitmask
const B_TOP = 1
const B_BOTTOM = 2
const B_LEFT = 4
const B_RIGHT = 8

function isContainer(record: AnyRecord = {}): boolean {
  const kind = String((record && record.kind) || '').toLowerCase()
  return CONTAINER_KINDS.has(kind)
}

function isInteractiveKind(kind: unknown): boolean {
  return INTERACTIVE_KINDS.has(String(kind || '').toLowerCase())
}

function clampGridH(vpW: number, vpH: number, mapWidth: number = DEFAULT_MAP_WIDTH): number {
  const w = Number(vpW) || 375
  const h = Number(vpH) || 812
  const width = Math.max(16, Number(mapWidth) || DEFAULT_MAP_WIDTH)
  const raw = Math.round(width * (h / w) * 0.5)
  return Math.max(MIN_GRID_H, Math.min(MAX_GRID_H, raw))
}

function refDigits(ref: string): string {
  const n = Number(String(ref || '').replace(/[^0-9]/gu, '')) || 0
  if (n >= 1 && n <= 99) return String(n)
  if (n > 99) {
    const letter = String.fromCharCode(97 + Math.floor((n - 100) / 9))
    const digit = ((n - 100) % 9) + 1
    return `${letter}${digit}`
  }
  return '?'
}

function rectToCells(rectPct: AnyRecord, gridW: number, gridH: number): CellRect | null {
  const x = Number(rectPct && rectPct.x)
  const y = Number(rectPct && rectPct.y)
  const w = Number(rectPct && rectPct.w)
  const h = Number(rectPct && rectPct.h)
  if ([x, y, w, h].some((v) => Number.isNaN(v))) return null
  if (w <= 0 || h <= 0) return null
  const c0 = Math.max(0, Math.min(gridW - 1, Math.floor((x / 100) * gridW)))
  // inclusive right/bottom via ceil-1 so thin rects still occupy cells
  const c1 = Math.max(c0, Math.min(gridW - 1, Math.ceil(((x + w) / 100) * gridW) - 1))
  const r0 = Math.max(0, Math.min(gridH - 1, Math.floor((y / 100) * gridH)))
  const r1 = Math.max(r0, Math.min(gridH - 1, Math.ceil(((y + h) / 100) * gridH) - 1))
  return { c0, c1, r0, r1 }
}

/**
 * LOD：box=画边框；mark=仅数字；skip=不画
 * 阈值用占格，与物理 DPI 无关。
 */
function classifyLod(
  rectPct: AnyRecord,
  gridW: number,
  gridH: number,
  kind: string = '',
): LodMode {
  const cells = rectToCells(rectPct, gridW, gridH)
  if (!cells) return 'skip'
  const cellW = cells.c1 - cells.c0 + 1
  const cellH = cells.r1 - cells.r0 + 1
  const area = cellW * cellH
  const interactive = isInteractiveKind(kind)
  const minW = interactive ? 1 : 2
  const minH = interactive ? 2 : 2
  const minArea = interactive ? 2 : 4
  if (cellW >= minW && cellH >= minH && area >= minArea) return 'box'
  if (area >= 1) return 'mark'
  return 'skip'
}

function borderChar(mask: number): string {
  const v = (mask & B_LEFT) || (mask & B_RIGHT)
  const h = (mask & B_TOP) || (mask & B_BOTTOM)
  if (v && h) return '+'
  if (mask & (B_TOP | B_BOTTOM) && mask & (B_LEFT | B_RIGHT)) return '+'
  // corner if two adjacent
  const corners = [
    B_TOP | B_LEFT,
    B_TOP | B_RIGHT,
    B_BOTTOM | B_LEFT,
    B_BOTTOM | B_RIGHT,
  ]
  if (corners.some((c) => (mask & c) === c)) return '+'
  if (mask & (B_TOP | B_BOTTOM)) return '-'
  if (mask & (B_LEFT | B_RIGHT)) return '|'
  return ' '
}

function paintBorder(masks: number[][], cells: CellRect, gridW: number, gridH: number): void {
  const { c0, c1, r0, r1 } = cells
  for (let r = r0; r <= r1; r += 1) {
    for (let c = c0; c <= c1; c += 1) {
      if (r < 0 || r >= gridH || c < 0 || c >= gridW) continue
      let add = 0
      if (r === r0) add |= B_TOP
      if (r === r1) add |= B_BOTTOM
      if (c === c0) add |= B_LEFT
      if (c === c1) add |= B_RIGHT
      // only border cells
      if (r === r0 || r === r1 || c === c0 || c === c1) {
        masks[r][c] |= add
      }
    }
  }
}

function labelFootprint(col: number, row: number, label: string, gridW: number, gridH: number): Array<{ c: number; r: number }> | null {
  const chars = String(label || '')
  if (!chars) return null
  const cells: Array<{ c: number; r: number }> = []
  for (let i = 0; i < chars.length; i += 1) {
    const c = col + i
    const r = row
    if (c < 0 || c >= gridW || r < 0 || r >= gridH) return null
    cells.push({ c, r })
  }
  return cells
}

function buildLabelCandidates(node: PaintNode, maxShift: number, gridW: number, gridH: number): Array<{ c: number; r: number; score: number }> {
  const { c0, c1, r0, r1 } = node.cells
  const cx = Math.round((c0 + c1) / 2)
  const cy = Math.round((r0 + r1) / 2)
  const raw: Array<{ c: number; r: number; score: number }> = []

  const push = (c: number, r: number, score: number) => {
    if (c < 0 || c >= gridW || r < 0 || r >= gridH) return
    raw.push({ c, r, score })
  }

  push(cx, cy, 100)
  const shifts: Array<[number, number, number]> = [
    [0, -1, 80], [0, 1, 80], [-1, 0, 80], [1, 0, 80],
    [-1, -1, 60], [1, -1, 60], [-1, 1, 60], [1, 1, 60],
  ]
  for (const [dx, dy, base] of shifts) {
    for (let s = 1; s <= maxShift; s += 1) {
      push(cx + dx * s, cy + dy * s, base - 15 * s)
    }
  }

  // inner corners for boxes
  if (node.lod === 'box' && (c1 - c0) >= 2 && (r1 - r0) >= 2) {
    push(c0 + 1, r0 + 1, 70)
    push(c1 - 1, r0 + 1, 70)
    push(c0 + 1, r1 - 1, 70)
    push(c1 - 1, r1 - 1, 70)
  }

  // outside mid edges for interactive
  if (node.interactive) {
    push(cx, r0 - 1, 40)
    push(cx, r1 + 1, 40)
    push(c0 - 1, cy, 40)
    push(c1 + 1, cy, 40)
  }

  if (node.interactive) {
    for (const item of raw) item.score += 20
  }

  // de-dupe by cell keep best score
  const best = new Map<string, { c: number; r: number; score: number }>()
  for (const item of raw) {
    const key = `${item.c},${item.r}`
    const prev = best.get(key)
    if (!prev || item.score > prev.score) best.set(key, item)
  }
  return [...best.values()].sort((a, b) => b.score - a.score)
}

function placeLabels(
  nodes: PaintNode[],
  gridW: number,
  gridH: number,
  maxShift: number,
): { labels: (string | null)[][]; collisions: number } {
  const labels: (string | null)[][] = Array.from({ length: gridH }, () => Array.from({ length: gridW }, () => null))
  const occupied = Array.from({ length: gridH }, () => Array.from({ length: gridW }, () => false))
  let collisions = 0

  const needLabel = nodes.filter((n) => n.lod === 'box' || n.lod === 'mark')
  // interactive first, then larger area
  needLabel.sort((a, b) => {
    if (a.interactive !== b.interactive) return a.interactive ? -1 : 1
    return b.area - a.area
  })

  for (const node of needLabel) {
    const candidates = buildLabelCandidates(node, maxShift, gridW, gridH)
    let placed = false
    for (const cand of candidates) {
      const foot = labelFootprint(cand.c, cand.r, node.label, gridW, gridH)
      if (!foot) continue
      if (foot.some(({ c, r }) => occupied[r][c])) continue
      // place: first cell gets full label string for composite simplicity on multi-digit
      // Store per-cell characters
      for (let i = 0; i < foot.length; i += 1) {
        const { c, r } = foot[i]
        occupied[r][c] = true
        labels[r][c] = node.label[i]
      }
      placed = true
      break
    }
    if (!placed) {
      // last resort center *
      const cx = Math.round((node.cells.c0 + node.cells.c1) / 2)
      const cy = Math.round((node.cells.r0 + node.cells.r1) / 2)
      if (cy >= 0 && cy < gridH && cx >= 0 && cx < gridW && !occupied[cy][cx]) {
        occupied[cy][cx] = true
        labels[cy][cx] = '*'
      }
      collisions += 1
    }
  }

  return { labels, collisions }
}

function buildTreeOrder(nodes: PaintNode[]): PaintNode[] {
  const byRef = new Map(nodes.map((n) => [n.ref, n]))
  const children = new Map<string, PaintNode[]>()
  const roots: PaintNode[] = []

  for (const n of nodes) {
    const p = n.parentRef
    if (p && byRef.has(p)) {
      const list = children.get(p) || []
      list.push(n)
      children.set(p, list)
    } else {
      roots.push(n)
    }
  }

  // sort siblings by area desc for stable nesting paint
  const sortSibs = (list: PaintNode[]) => list.sort((a, b) => b.area - a.area)

  const ordered: PaintNode[] = []
  const visit = (n: PaintNode, depth: number) => {
    n.depth = depth
    ordered.push(n)
    const kids = children.get(n.ref) || []
    sortSibs(kids)
    for (const k of kids) visit(k, depth + 1)
  }

  sortSibs(roots)
  for (const r of roots) visit(r, 0)

  // orphans already in roots; if any missing append by area
  if (ordered.length < nodes.length) {
    const seen = new Set(ordered.map((n) => n.ref))
    const rest = nodes.filter((n) => !seen.has(n.ref)).sort((a, b) => b.area - a.area)
    ordered.push(...rest)
  }
  return ordered
}

function normalizeNodes(
  list: AnyRecord[],
  gridW: number,
  gridH: number,
  maxBoxDepth: number,
): PaintNode[] {
  const nodes: PaintNode[] = []
  for (const raw of list) {
    if (!raw || !raw.rectPct) continue
    const ref = String(raw.ref || '')
    if (!ref) continue
    const kind = String(raw.kind || '').toLowerCase()
    const cells = rectToCells(raw.rectPct as AnyRecord, gridW, gridH)
    if (!cells) continue
    const cellW = cells.c1 - cells.c0 + 1
    const cellH = cells.r1 - cells.r0 + 1
    const area = cellW * cellH
    let lod = classifyLod(raw.rectPct as AnyRecord, gridW, gridH, kind)
    const interactive = isInteractiveKind(kind)
    nodes.push({
      ref,
      kind,
      parentRef: String(raw.parentRef || ''),
      rectPct: {
        x: Number((raw.rectPct as AnyRecord).x),
        y: Number((raw.rectPct as AnyRecord).y),
        w: Number((raw.rectPct as AnyRecord).w),
        h: Number((raw.rectPct as AnyRecord).h),
      },
      cells,
      area,
      depth: 0,
      lod,
      interactive,
      label: refDigits(ref),
    })
  }

  // depth from tree then apply maxBoxDepth
  const ordered = buildTreeOrder(nodes)
  for (const n of ordered) {
    if (n.lod === 'box' && n.depth > maxBoxDepth) {
      n.lod = 'mark'
    }
  }
  return ordered
}

/** 旧算法：仅容器画框 + 叶子中心点 */
function renderAsciiMapLegacy(records: AnyRecord[], options: MapOptions = {}): string {
  const list = Array.isArray(records) ? records : []
  const vp = options.viewport || {}
  const mapWidth = Math.max(16, Number(options.mapWidth) || DEFAULT_MAP_WIDTH)
  const gridH = clampGridH(Number(vp.w), Number(vp.h), mapWidth)
  const gridW = mapWidth

  const withRect = list.filter((r) => r && r.rectPct)
  if (withRect.length === 0) return ''

  const masks = Array.from({ length: gridH }, () => Array.from({ length: gridW }, () => 0))
  const labels: (string | null)[][] = Array.from({ length: gridH }, () => Array.from({ length: gridW }, () => null))

  for (const record of withRect) {
    if (!isContainer(record)) continue
    const cells = rectToCells(record.rectPct as AnyRecord, gridW, gridH)
    if (!cells) continue
    paintBorder(masks, cells, gridW, gridH)
  }

  for (const record of withRect) {
    if (isContainer(record)) continue
    const cells = rectToCells(record.rectPct as AnyRecord, gridW, gridH)
    if (!cells) continue
    const col = Math.round((cells.c0 + cells.c1) / 2)
    const row = Math.round((cells.r0 + cells.r1) / 2)
    const marker = refDigits(String(record.ref || ''))
    if (row < 0 || row >= gridH || col < 0 || col >= gridW) continue
    if (labels[row][col]) labels[row][col] = '*'
    else {
      // place multi-digit carefully
      const foot = labelFootprint(col, row, marker, gridW, gridH)
      if (!foot) continue
      if (foot.some(({ c, r }) => labels[r][c])) {
        labels[row][col] = '*'
      } else {
        for (let i = 0; i < foot.length; i += 1) {
          labels[foot[i].r][foot[i].c] = marker[i]
        }
      }
    }
  }

  return composeOutput(masks, labels, gridW, gridH, true)
}

function composeOutput(
  masks: number[][],
  labels: (string | null)[][],
  gridW: number,
  gridH: number,
  legacy: boolean,
): string {
  const rows: string[] = []
  for (let r = 0; r < gridH; r += 1) {
    const yPct = Math.round(((r + 0.5) / gridH) * 100)
    let line = ''
    for (let c = 0; c < gridW; c += 1) {
      if (labels[r][c]) line += labels[r][c]
      else if (masks[r][c]) line += borderChar(masks[r][c])
      else line += ' '
    }
    rows.push(`${String(yPct).padStart(4, ' ')}%│${line}`)
  }
  const perRowPct = Math.max(1, Math.round(100 / gridH))
  const legend = legacy
    ? `top-left=(0,0) x→右 y→下; 每行≈${perRowPct}%  边框=容器 @eN=元素中心 *=碰撞`
    : `top-left=(0,0) x→右 y→下; 每行≈${perRowPct}%  框=区域 @eN=编号 *=避让失败; map=${gridW}x${gridH}`
  return `${legend}\n${rows.join('\n')}`
}

function renderAsciiMap(records: AnyRecord[] | null, options: MapOptions = {}): string {
  if (options && options.legacy) {
    return renderAsciiMapLegacy(Array.isArray(records) ? records : [], options)
  }

  const list = Array.isArray(records) ? records : []
  const vp = options.viewport || {}
  // pixelRatio intentionally ignored — rectPct already logical
  void vp.pixelRatio

  const mapWidth = Math.max(16, Number(options.mapWidth) || DEFAULT_MAP_WIDTH)
  const maxBoxDepth = Math.max(0, Number(options.maxBoxDepth ?? 6))
  const maxLabelShift = Math.max(0, Number(options.maxLabelShift ?? 2))
  const gridW = mapWidth
  const gridH = clampGridH(Number(vp.w), Number(vp.h), mapWidth)

  const nodes = normalizeNodes(list, gridW, gridH, maxBoxDepth)
  if (nodes.length === 0) return ''

  const masks = Array.from({ length: gridH }, () => Array.from({ length: gridW }, () => 0))

  // paint boxes: ancestors first (tree order already)
  for (const n of nodes) {
    if (n.lod !== 'box') continue
    paintBorder(masks, n.cells, gridW, gridH)
  }

  const { labels } = placeLabels(nodes, gridW, gridH, maxLabelShift)
  return composeOutput(masks, labels, gridW, gridH, false)
}

// back-compat export name used by older clampGridH callers (2-arg)
function clampGridHExport(vpW: number, vpH: number, mapWidth?: number): number {
  return clampGridH(vpW, vpH, mapWidth)
}

module.exports = {
  renderAsciiMap,
  GRID_W: DEFAULT_MAP_WIDTH,
  clampGridH: clampGridHExport,
  refDigits,
  isContainer,
  isInteractiveKind,
  classifyLod,
  rectToCells,
}
