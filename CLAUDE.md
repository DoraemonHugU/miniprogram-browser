@AGENTS.md

## 构建与运行契约

CLI 源码在 `src/`（TypeScript），编译产物在 `dist/`（`package.json` 的 `bin` 指向 `dist/miniprogram-browser.js`）。`dist/` 不在源码管理中自动同步，改完源码后必须重新构建，否则运行入口会停留在旧版本：

```bash
npm run build          # tsc 编译 src/ -> dist/
node dist/miniprogram-browser.js help
npm test               # build + node --test tests/*.test.cjs + 图片处理 Python 测试（需系统有 python）
```

改动 `src/` 后，务必先 `npm run build` 再运行或跑测试；不要直接信任未重新构建的 `dist/`。
