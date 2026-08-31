// @ts-check

import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', '**/*.cjs', '**/*.js'] },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: { project: true, tsconfigRootDir: import.meta.dirname },
    },
    extends: [
      ...tseslint.configs.recommended,
    ],
    rules: {
      // —— Layer 2: 禁止显式 any（当前无 any 残留，硬门禁）——
      '@typescript-eslint/no-explicit-any': 'error',

      // —— Layer 3: 禁止 any 渗透业务代码（当前关，等核心接口定义后开）——
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',

      // —— 历史遗留兼容 ——
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-unused-expressions': 'off',
    },
  },
  // —— 外部全局声明中 any 不可避免 ——
  {
    files: ['src/types/miniprogram-globals.d.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
