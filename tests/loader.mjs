import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers')
    return {
      url: new URL('./bindings.ts', import.meta.url).href,
      shortCircuit: true,
    };
  if (specifier.startsWith('@/'))
    return resolve(
      pathToFileURL(path.join(root, specifier.slice(2))).href,
      context,
      next,
    );
  if (specifier.startsWith('.') || specifier.startsWith('file:')) {
    const url = new URL(specifier, context.parentURL);
    if (!path.extname(url.pathname) && existsSync(fileURLToPath(url) + '.ts'))
      return { url: url.href + '.ts', shortCircuit: true };
  }
  return next(specifier, context);
}
