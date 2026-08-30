# 公开 Demo

本目录只放可公开提交的合成微信小程序，用于 `miniprogram-browser` 回归和演示：

- `public-demo`：微信原生项目，可直接打开。
- `taro-demo`：Taro React + TypeScript，先运行 `npm ci` 和 `npm run build:weapp`。
- `uni-app-demo`：uni-app Vue 3 + Vite，先运行 `npm ci` 和 `npm run build:mp-weixin`。

三套 Demo 使用 `touristappid`、相同的五页行为契约，不包含真实业务数据、账号、接口、截图或设备路径。CLI 应把它们统一视为编译后的标准微信小程序，不增加框架专用分支。
