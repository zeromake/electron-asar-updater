import {join} from 'node:path';

const PACKAGE_ROOT = __dirname;

/**
 * @type {import('vite').UserConfig}
 * @see https://vitejs.dev/config/
 */
const config = {
  mode: process.env.MODE,
  root: PACKAGE_ROOT,
  resolve: {
    alias: {
      '/@/': join(PACKAGE_ROOT, 'src'),
      'fs': 'original-fs', // 把 fs 替换为 original-fs 否则无法操作 asar。
    },
  },
  build: {
    ssr: true,
    sourcemap: false,
    target: 'node18',
    outDir: 'dist',
    minify: false,
    rollupOptions: {
      input: ['src/index.ts'],
      output: [
        {
          format: 'esm',
          entryFileNames: '[name].mjs',
        },
        {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        }
      ],
      external: [
        'electron',
        'original-fs',
        // 'node:util',
        // 'node:https',
        // 'node:path',
        // 'node:process',
        // 'node:child_process',
        // 'node:stream',
        // 'node:zlib'
      ],
    },
  }
};

export default config;
