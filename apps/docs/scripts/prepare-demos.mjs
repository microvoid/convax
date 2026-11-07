/** Project the repository's canonical demo assets into the docs public directory. */
import { cpSync, rmSync } from 'node:fs';

const source = new URL('../../../docs/assets/convax-demos/', import.meta.url);
const destination = new URL('../public/demos/', import.meta.url);
rmSync(destination, { recursive: true, force: true });
cpSync(source, destination, { recursive: true });
