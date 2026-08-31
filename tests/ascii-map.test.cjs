const test = require('node:test')
const assert = require('node:assert/strict')
const {
  renderAsciiMap,
  clampGridH,
  refDigits,
  isContainer,
  isInteractiveKind,
  classifyLod,
} = require('../dist/lib/ascii-map.js')

function rec(ref, kind, rectPct, extra = {}) {
  return { ref, kind, rectPct, ...extra }
}

function mapBody(out) {
  return String(out || '').split('\n').slice(1).join('\n')
}

test('empty records render to empty string (no crash, no grid)', () => {
  assert.equal(renderAsciiMap([]), '')
  assert.equal(renderAsciiMap([{ ref: '@e1', kind: 'text' }]), '')
  assert.equal(renderAsciiMap(null), '')
})

test('two leaf refs appear with digits and row labels', () => {
  const out = renderAsciiMap([
    rec('@e1', 'text', { x: 0, y: 0, w: 50, h: 10 }),
    rec('@e2', 'button', { x: 50, y: 0, w: 50, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })
  assert.match(out, /map 32x24/)
  assert.doesNotMatch(out, /[^\x00-\x7F]/u)
  assert.match(out, /[12]/)
  assert.ok(out.split('\n').length >= 3)
})

test('container draws a border box, leaf draws its ref', () => {
  const out = renderAsciiMap([
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e2', 'button', { x: 10, y: 10, w: 20, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })
  assert.match(out, /\+/)
  assert.match(out, /\||-/)
})

test('large button inside view gets its own border box (full pipeline)', () => {
  const out = renderAsciiMap([
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e2', 'button', { x: 10, y: 20, w: 40, h: 15 }),
  ], { viewport: { w: 375, h: 812 } })
  const body = mapBody(out)
  // outer + inner corners both present; button digit present
  assert.match(body, /\+/)
  assert.match(body, /2/)
  // more than one distinct horizontal border row suggests nested boxes
  const borderRows = body.split('\n').filter((line) => /\+-+/.test(line) || /-\+-/.test(line) || /\+{1}[-+]+\+/.test(line))
  assert.ok(borderRows.length >= 2, `expected nested borders, got:\n${out}`)
})

test('tiny text is mark-only (no dedicated small box spam)', () => {
  const out = renderAsciiMap([
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e9', 'text', { x: 48, y: 48, w: 1.5, h: 1.2 }),
  ], { viewport: { w: 375, h: 812 } })
  assert.match(out, /9/)
  // tiny node should classify as mark
  assert.equal(classifyLod({ x: 48, y: 48, w: 1.5, h: 1.2 }, 48, 50, 'text'), 'mark')
  assert.equal(classifyLod({ x: 10, y: 10, w: 40, h: 20 }, 48, 50, 'button'), 'box')
})

test('overlapping leaf centers try to avoid before using *', () => {
  const out = renderAsciiMap([
    rec('@e1', 'button', { x: 20, y: 20, w: 30, h: 20 }),
    rec('@e2', 'button', { x: 22, y: 22, w: 30, h: 20 }),
  ], { viewport: { w: 375, h: 812 } })
  const body = mapBody(out)
  const has1 = /1/.test(body)
  const has2 = /2/.test(body)
  // both labels preferred; * only if unavoidable
  assert.ok(has1 && has2, `expected both labels, got:\n${out}`)
})

test('three bottom-bar buttons keep three visible digits', () => {
  const out = renderAsciiMap([
    rec('@e10', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e22', 'button', { x: 0, y: 90, w: 33, h: 10 }),
    rec('@e23', 'button', { x: 33, y: 90, w: 34, h: 10 }),
    rec('@e24', 'button', { x: 67, y: 90, w: 33, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })
  const body = mapBody(out)
  assert.match(body, /22|2/)
  // digits may be multi-char "22" "23" "24"
  assert.match(body, /23/)
  assert.match(body, /24/)
})

test('identical rectPct yields stable map regardless of fictional dpr context', () => {
  const records = [
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 50 }),
    rec('@e2', 'button', { x: 10, y: 10, w: 30, h: 15 }),
  ]
  const a = renderAsciiMap(records, { viewport: { w: 375, h: 812 } })
  const b = renderAsciiMap(records, { viewport: { w: 375, h: 812, pixelRatio: 3 } })
  assert.equal(a, b)
})

test('legacy mode keeps container-only borders', () => {
  const out = renderAsciiMap([
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e2', 'button', { x: 10, y: 10, w: 40, h: 20 }),
  ], { viewport: { w: 375, h: 812 }, legacy: true })
  assert.match(out, /\+/)
  assert.match(out, /2/)
})

test('refDigits folds >99 into aN/bN and keeps 1-99 plain', () => {
  assert.equal(refDigits('@e3'), '3')
  assert.equal(refDigits('@e1'), '1')
  assert.equal(refDigits('@e100'), 'a1')
  assert.equal(refDigits('@e108'), 'a9')
  assert.equal(refDigits('@e109'), 'b1')
})

test('isContainer only matches container kinds', () => {
  assert.equal(isContainer(rec('@e1', 'view')), true)
  assert.equal(isContainer(rec('@e1', 'nav')), true)
  assert.equal(isContainer(rec('@e1', 'button')), false)
  assert.equal(isContainer(rec('@e1', 'text')), false)
})

test('isInteractiveKind recognizes controls', () => {
  assert.equal(isInteractiveKind('button'), true)
  assert.equal(isInteractiveKind('input'), true)
  assert.equal(isInteractiveKind('text'), false)
  assert.equal(isInteractiveKind('view'), false)
})

test('clampGridH keeps the compact map within 12-24 rows', () => {
  const portrait = clampGridH(375, 812)
  const landscape = clampGridH(812, 375)
  assert.ok(portrait >= 12 && portrait <= 24)
  assert.ok(landscape >= 12 && landscape <= 24)
  assert.ok(portrait > landscape)
})

test('default map stays compact for agent output and folds empty row runs', () => {
  const out = renderAsciiMap([
    rec('@e1', 'button', { x: 10, y: 10, w: 30, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })

  assert.match(out, /map 32x24/)
  assert.ok(out.split('\n').length < 15, out)
  assert.match(out, /\.\.\.\|/u)
})

test('large text remains a mark instead of drawing a noisy box', () => {
  assert.equal(classifyLod({ x: 5, y: 5, w: 90, h: 30 }, 32, 24, 'text'), 'mark')
})
