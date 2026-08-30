# Implement：ASCII 线框 v1

## Checklist

1. [ ] 扩展 `tests/ascii-map.test.cjs`（LOD / button 框 / 避让 / 空）→ 红
2. [ ] 重写 `src/lib/ascii-map.ts` 流水线 → 绿
3. [ ] `npm run build` + ascii-map 测试
4. [ ] 写 `.trellis/spec/cli/ascii-map-contracts.md`
5. [ ] skill 图例/读法一句
6. [ ] 公开合成 Demo 真机 snapshot 目视（可选，环境允许时）

## Validate

```bash
npm run build
node --test tests/ascii-map.test.cjs
npm run test:node   # 关注基线 fail 数不恶化
```

## Rollback

`git checkout main -- src/lib/ascii-map.ts tests/ascii-map.test.cjs`
