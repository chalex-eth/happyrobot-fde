import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Workspace scripts and npm -w may start with different working directories.
export function workspaceRoot(): string {
  let directory = process.cwd();
  while (true) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const value: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
      if (value && typeof value === 'object' && 'name' in value && value.name === 'carrier-sales')
        return directory;
    }
    const parent = dirname(directory);
    if (parent === directory) throw Error('Carrier workspace root not found');
    directory = parent;
  }
}
