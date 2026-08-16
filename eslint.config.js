// ESLint flat config（ESLint 10）。
import js from '@eslint/js'
import tseslint from '@typescript-eslint/eslint-plugin'
import tsParser from '@typescript-eslint/parser'
import globals from 'globals'

export default [
  {
    ignores: ['lib/**', '.test-dist/**', 'node_modules/**', '.npm-cache/**', 'dist/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts', 'src/**/*.tsx', 'tests/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
      // host 侧用 Node 全局，client 侧用浏览器全局；混合声明保持两方可编译
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      // TS 编译器负责类型/全局检查（DOM lib、JSX 命名空间等），ESLint 的 no-undef 会误报
      'no-undef': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-this-alias': 'off',
    },
  },
  {
    // 音源脚本隔离子进程（runner）：自包含 CJS，使用 Node 全局
    files: ['src/engine/runner.js'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'off',
      'no-unused-vars': 'off',
      'no-useless-assignment': 'off',
    },
  },
  {
    // 移植自 lx-music-desktop 的 SDK 平台模块（.js 原样保留，Apache-2.0）：不套用项目规则
    files: ['src/sdk/**/*.js'],
    rules: {
      'no-undef': 'off',
      'no-useless-assignment': 'off',
      'no-redeclare': 'off',
      'no-unused-vars': 'off',
      'no-prototype-builtins': 'off',
      'no-empty': 'off',
      'no-useless-escape': 'off',
      'no-fallthrough': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      sourceType: 'module',
      ecmaVersion: 2022,
      globals: {
        ...globals.node,
      },
    },
  },
]
