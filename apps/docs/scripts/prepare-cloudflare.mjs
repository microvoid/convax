/** Stage Astro output at its public path for accounts without assets.base_path. */
import { copyFileSync, cpSync, existsSync, mkdirSync, renameSync, rmSync } from "node:fs";

const output = new URL("../.cloudflare/", import.meta.url);
const destination = new URL("convax/docs/", output);
const source = new URL("../dist/", import.meta.url);

rmSync(output, { recursive: true, force: true });
mkdirSync(destination, { recursive: true });
cpSync(source, destination, { recursive: true });
for (const name of ["_headers", "_redirects"]) {
  const file = new URL(name, destination);
  if (existsSync(file)) renameSync(file, new URL(name, output));
}
copyFileSync(new URL("404.html", source), new URL("404.html", output));
