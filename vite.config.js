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
      '/@/': join(PACKAGE_ROOT, 'src') + '/',
      'fs': 'original-fs', // 把 fs 替换为 original-fs 否则无法操作 asar。
    },
  },
  build: {
    ssr: true,
    sourcemap: false,
    target: `node18`,
    outDir: 'dist',
    assetsDir: '.',
    minify: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
    },
    rollupOptions: {
      output: {
        entryFileNames: '[name].mjs',
      },
      external: ['original-fs', 'electron'],
    },
    emptyOutDir: true,
    reportCompressedSize: false,
  },
  plugins: [],
};

export default config;
 