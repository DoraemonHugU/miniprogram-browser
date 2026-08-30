# Implement：原生公开 Demo 组件目录

## 1. 契约与测试

- [x] 先补静态测试，约束 app.json 页面注册、四文件结构、合成安全边界和关键原生导航调用。
- [x] 用 `app inspect` 验证页面和静态路由图可发现。

## 2. 页面实现

- [x] 扩展 Index 为目录首页。
- [x] 添加 Controls 页。
- [x] 添加 Lists 页。
- [x] 添加 Navigation 与 Detail 页。
- [x] 检查所有数据、文案和配置均为公开合成内容。

## 3. 真机暴露的 CLI 回归

- [x] 普通同页 click 不再输出猜测性的登录/授权 notice；路由事件仍正常返回。
- [x] 重复 selector、重复文案控件按派生 selector 和 occurrence 精确命中。
- [x] 两项修复均先补失败测试，再在 Mac `public-demo` 真实旅程复验。

## 4. 验证

- [x] `npm run build`、相关 Node 测试、`npm run typecheck:strict`、`npm run lint`。
- [x] macOS 公开 Demo 真实链路覆盖目录、表单、列表、导航、截图和关闭。
- [x] `npm test`、`npm run pack:check`、`git diff --check`、敏感信息与运行产物检查。
