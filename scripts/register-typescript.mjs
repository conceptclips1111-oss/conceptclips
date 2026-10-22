// In-process TypeScript loading for the local API/tests. No bundler subprocess needed.
import { registerHooks } from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL && !/\.[a-z]+$/i.test(specifier)) {
      const candidate = new URL(specifier + '.ts', context.parentURL);
      if (existsSync(candidate)) return { url: candidate.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith('file:') && url.endsWith('.ts') && !url.includes('/node_modules/')) {
      const code = readFileSync(fileURLToPath(url),'utf8');
      return { format:'module', source:ts.transpileModule(code,{ compilerOptions:{ target:ts.ScriptTarget.ES2022, module:ts.ModuleKind.ESNext } }).outputText, shortCircuit:true };
    }
    return next(url, context);
  }
});
