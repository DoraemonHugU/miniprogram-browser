const test = require('node:test')
const assert = require('node:assert/strict')
const { renderAsciiMap, clampGridH, refDigits, isContainer } = require('../dist/lib/ascii-map.js')

function rec(ref, kind, rectPct) {
  return { ref, kind, rectPct }
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
  assert.match(out, /top-left=\(0,0\)/)
  assert.match(out, /x→右 y→下/)
  assert.match(out, /1%│/) // 行标注存在
  assert.match(out, /[12]/) // 至少出现 ref 数字
  assert.ok(out.split('\n').length > 5)
})

test('container draws a border box, leaf draws its ref', () => {
  const out = renderAsciiMap([
    rec('@e1', 'view', { x: 0, y: 0, w: 100, h: 100 }),
    rec('@e2', 'button', { x: 10, y: 10, w: 20, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })
  assert.match(out, /\+/) // 容器角
  assert.match(out, /\||-/) // 容器边
})

test('overlapping leaf centers collide into * marker', () => {
  const out = renderAsciiMap([
    rec('@e1', 'text', { x: 10, y: 10, w: 20, h: 10 }),
    rec('@e2', 'button', { x: 10, y: 10, w: 20, h: 10 }),
  ], { viewport: { w: 375, h: 812 } })
  assert.match(out, /\*/)
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

test('clampGridH keeps portrait (375x812) within 16-56 and taller than landscape', () => {
  const portrait = clampGridH(375, 812)
  const landscape = clampGridH(812, 375)
  assert.ok(portrait >= 16 && portrait <= 56)
  assert.ok(landscape >= 16 && landscape <= 56)
  assert.ok(portrait > landscape)
})
