/** Node only: Workers has no filesystem, so this module is excluded from
 *  tsconfig.workers.json. The `ROUTES` variable carries the same JSON there. */

import { readFileSync } from 'node:fs';

/** Returns raw text: parsing belongs to the one zod pass in load.ts so a syntax
 *  error is a numbered problem. Throws only a message safe to print (no stack). */
export function readConfigFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (err) {
    const code = (err as { code?: string }).code;
    throw new Error(
      code === 'ENOENT' ? `no such file: ${path}` : `could not be read: ${code ?? 'unknown error'}`,
    );
  }
}
