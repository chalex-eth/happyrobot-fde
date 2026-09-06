import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
const root = resolve(import.meta.dirname, '..');
async function* files(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (['node_modules', '.next', 'dist'].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(ts|tsx|mjs)$/.test(path)) yield path;
  }
}
const violations = [];
for (const folder of ['apps/web/src', 'apps/api/src', 'packages/contracts/src']) {
  for await (const path of files(resolve(root, folder))) {
    const source = await readFile(path, 'utf8');
    function check(spec) {
      const target = spec.startsWith('.') ? relative(root, resolve(dirname(path), spec)) : spec;
      if (
        folder === 'apps/web/src' &&
        (target.startsWith('apps/api/') || target === '@carrier/api')
      )
        violations.push(`${relative(root, path)} imports backend ${spec}`);
      if (
        folder === 'packages/contracts/src' &&
        (spec.startsWith('node:') ||
          target.startsWith('apps/') ||
          (!spec.startsWith('.') && spec !== 'zod'))
      )
        violations.push(`${relative(root, path)} imports non-contract dependency ${spec}`);
      if (
        folder === 'apps/api/src' &&
        (target.startsWith('apps/web/') || spec === 'next' || spec.startsWith('next/'))
      )
        violations.push(`${relative(root, path)} imports frontend ${spec}`);
      const from = relative(root, path).match(/^apps\/api\/src\/modules\/([^/]+)\//);
      const to = target.match(/^apps\/api\/src\/modules\/([^/]+)\/(.+)$/);
      if (from && to && from[1] !== to[1] && !/^index(?:\.js|\.ts)?$/.test(to[2]))
        violations.push(`${relative(root, path)} bypasses module interface: ${spec}`);
    }
    // Scan static and literal dynamic imports. This is a local architecture
    // check, not a security policy or a replacement for TypeScript resolution.
    for (const match of source.matchAll(
      /(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s*)?['"]([^'"\n]+)['"]/g,
    ))
      check(match[1]);
    for (const match of source.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) check(match[1]);
  }
}
if (violations.length) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else console.log('Workspace and module import boundaries passed.');
