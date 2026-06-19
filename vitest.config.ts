import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/*/test/**/*.test.ts',
      'packages/*/src/**/*.test.ts',
      'server/test/**/*.test.ts'
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: [
        'packages/*/src/**/*.ts',
        'server/src/**/*.ts'
      ],
      exclude: [
        '**/*.test.ts',
        '**/*.d.ts',
        '**/index.ts'
      ]
    }
  },
  resolve: {
    alias: {
      '@tender/core': resolve(__dirname, 'packages/core/src/index.ts'),
      '@tender/auth': resolve(__dirname, 'packages/auth/src/index.ts'),
      '@tender/protocol': resolve(__dirname, 'packages/protocol/src/index.ts'),
      '@tender/router': resolve(__dirname, 'packages/router/src/index.ts'),
      '@tender/audit': resolve(__dirname, 'packages/audit/src/index.ts'),
      '@tender/quota': resolve(__dirname, 'packages/quota/src/index.ts')
    }
  }
});
