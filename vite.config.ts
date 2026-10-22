import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import ts from 'typescript';
export default defineConfig(({ command }) => ({
  resolve: { preserveSymlinks: true },
  plugins: command === 'serve' ? [react()] : [{
    name: 'production-environment', enforce: 'pre',
    transform(code) { return { code: code.replaceAll('process.env.NODE_ENV', '"production"').replaceAll('process.env', '({})').replaceAll('import.meta.hot', 'undefined'), map: null }; }
  }, {
    name: 'typescript-build',
    transform(code, id) {
      if (!/\.[jt]sx?$/.test(id) || id.includes('node_modules')) return;
      return { code: ts.transpileModule(code, { fileName: id, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, map: null };
    }
  }],
  esbuild: command === 'build' ? false : undefined,
  server: { port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8788' } },
  build: { outDir: 'dist', sourcemap: false, minify: false, cssMinify: false }
}));
