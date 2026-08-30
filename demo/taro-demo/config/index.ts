import { defineConfig } from '@tarojs/cli'

export default defineConfig({
  projectName: 'taro-public-demo',
  date: '2026-08-29',
  designWidth: 750,
  deviceRatio: {
    640: 2.34 / 2,
    750: 1,
    828: 1.81 / 2
  },
  sourceRoot: 'src',
  outputRoot: 'dist',
  plugins: ['@tarojs/plugin-framework-react'],
  defineConstants: {},
  copy: {
    patterns: [],
    options: {}
  },
  framework: 'react',
  compiler: 'webpack5',
  mini: {
    postcss: {
      pxtransform: {
        enable: true
      },
      url: {
        enable: true
      },
      cssModules: {
        enable: false
      }
    }
  }
})
