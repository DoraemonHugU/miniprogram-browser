/**
 * ASCII 空间 mini-map 渲染器（纯文本，零图像依赖）。
 *
 * 输入：带 `rectPct`（0–100 百分比坐标，来自 collectRecordRects）的 ref 列表。
 * 输出：图例 + 网格字符串；无 rectPct 的 record 被跳过；records 为空返回空串。
 * 分层：第一遍画容器边框盒，第二遍把叶子 ref 叠在中心格；冲突打 `*` 碰撞标记。
 * 设计来源：.trellis/tasks/07-16-ascii-default-snapshot/design.md §1。
 */

const GRID_W = 48

const CONTAINER_KINDS = new Set([
  'view', 'container', 'scroll-view', 'scrollview', 'scroll',
  'list', 'list-view', 'nav', 'navbar', 'tabbar', 'tab', 'tabs',
  'page', 'root', 'swiper', 'swiper-item', 'form', 'cell-group', 'section',
])

function isContainer(record: Record<string, unknown>): boolean {
  const kind = String((record && record.kind) || '').toLowerCase()
  return CONTAINER_KINDS.has(kind)
}

function clampGridH(vpW: number, vpH: number): number {
  const w = Number(vpW) || 375
  const h = Number(vpH) || 812
  const raw = Math.round(GRID_W * (h / w) * 0.5)
  return Math.max(16, Math.min(56, raw))
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

function rectToCells(rectPct: Record<string, unknown>, gridH: number): { colL: number; colR: number; rowT: number; rowB: number } | null {
  const x = Number(rectPct && rectPct.x)
  const y = Number(rectPct && rectPct.y)
  const w = Number(rectPct && rectPct.w)
  const h = Number(rectPct && rectPct.h)
  if ([x, y, w, h].some((v: number) => Number.isNaN(v))) return null
  const colL = Math.max(0, Math.min(GRID_W - 1, Math.floor((x / 100) * GRID_W)))
  const colR = Math.max(colL, Math.min(GRID_W - 1, Math.floor(((x + w) / 100) * GRID_W)))
  const rowT = Math.max(0, Math.min(gridH - 1, Math.floor((y / 100) * gridH)))
  const rowB = Math.max(rowT, Math.min(gridH - 1, Math.floor(((y + h) / 100) * gridH)))
  return { colL, colR, rowT, rowB }
}

function renderAsciiMap(records: Record<string, unknown>[], options: Record<string, unknown> = {}): string {
  const list = Array.isArray(records) ? records : []
  const vp = options && options.viewport
  const vpObj = vp as Record<string, number> | undefined
  const gridH = clampGridH(Number(vpObj && vpObj.w), Number(vpObj && vpObj.h))

  const withRect = list.filter((r: Record<string, unknown>) => r && r.rectPct)
  if (withRect.length === 0) return ''

  const grid: Array<Array<{ b: string; l: string }>> = Array.from({ length: gridH }, () =>
    Array.from({ length: GRID_W }, () => ({ b: ' ', l: ' ' })),
  )

  for (const record of withRect) {
    if (!isContainer(record)) continue
    const cells = rectToCells(record.rectPct as Record<string, unknown>, gridH)
    if (!cells) continue
    const { colL, colR, rowT, rowB } = cells
    for (let r = rowT; r <= rowB; r += 1) {
      for (let c = colL; c <= colR; c += 1) {
        const isCorner = (r === rowT || r === rowB) && (c === colL || c === colR)
        const isHBorder = (r === rowT || r === rowB) && c > colL && c < colR
        const isVBorder = (c === colL || c === colR) && r > rowT && r < rowB
        if (isCorner) grid[r][c].b = '+'
        else if (isHBorder) grid[r][c].b = '-'
        else if (isVBorder) grid[r][c].b = '|'
      }
    }
  }

  for (const record of withRect) {
    if (isContainer(record)) continue
    const cells = rectToCells(record.rectPct as Record<string, unknown>, gridH)
    if (!cells) continue
    const { colL, colR, rowT, rowB } = cells
    const col = Math.round((colL + colR) / 2)
    const row = Math.round((rowT + rowB) / 2)
    const marker = refDigits(String(record.ref || ''))
    if (grid[row][col].l !== ' ') grid[row][col].l = '*'
    else grid[row][col].l = marker
  }

  const rows: string[] = []
  for (let r = 0; r < gridH; r += 1) {
    const yPct = Math.round(((r + 0.5) / gridH) * 100)
    const line = grid[r].map((cell: { b: string; l: string }) => (cell.l !== ' ' ? cell.l : cell.b)).join('')
    rows.push(`${String(yPct).padStart(4, ' ')}%│${line}`)
  }

  const perRowPct = Math.round(100 / gridH)
  const legend = `top-left=(0,0) x→右 y→下; 每行≈${perRowPct}%  边框=容器 @eN=元素中心 *=碰撞`
  return `${legend}\n${rows.join('\n')}`
}

module.exports = { renderAsciiMap, GRID_W, clampGridH, refDigits, isContainer }
