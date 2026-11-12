import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { backup, DatabaseSync } from 'node:sqlite'
import { CanvasDatabase } from '../../packages/plugin-host/src/database.ts'
import type { WebScaffold } from '../../libs/dsh/apps/web/tests/scaffold.ts'
import { COMPLEX_CANVAS_TITLE, seedComplexCanvas } from './complex-canvas.ts'

/** Export a fresh board into an isolated Web profile before the browser edits it. */
export async function exportComplexCanvas(scaffold: WebScaffold, output: string, counterBundle: string): Promise<string> {
  const home = join(output, 'home')
  const projects = join(output, 'projects')
  const storages = join(home, 'storages')
  const counterLink = join(home, 'profiles', 'web', 'node_modules', '@local', 'dsh-convax-counter-example')
  const databasePath = join(storages, 'convax-canvas.sqlite')
  await Promise.all([mkdir(storages, { recursive: true }), mkdir(dirname(counterLink), { recursive: true })])
  await symlink(counterBundle, counterLink, 'junction')
  const { id, root } = await seedComplexCanvas(scaffold.ctx.convax, projects)
  const source = new DatabaseSync(join(scaffold.harnessHome, 'storages', 'convax-canvas.sqlite'), { readOnly: true })
  try { await backup(source, databasePath) } finally { source.close() }

  const database = await CanvasDatabase.open({ path: databasePath })
  try {
    await database.table('directories').put(id, { path: root })
  } finally { await database.close() }

  const patch = join(output, 'demo.patch.yml')
  await writeFile(patch, `- id: convax-host\n  config:\n    databasePath: ${JSON.stringify(databasePath)}\n    canvasDirectoryRoot: ${JSON.stringify(projects)}\n`)
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const command = `DSH_HOME=${quote(home)} node libs/dsh/apps/cli/lib/bin.js web --patch packages/plugin-renderer/cordis.patch.yml --patch packages/plugin-renderer/examples/counter/cordis.patch.yml --patch ${quote(patch)} --port 0 --no-open`
  const instructions = join(output, 'README.md')
  await writeFile(instructions, `# Night Ferry canvas

Start Convax from the repository root after building artifacts.

\`\`\`sh
${command}
\`\`\`

Open the authenticated local URL printed in the terminal. After it redirects to the app, add \`?convax-renderer=compare\` to the URL. If you see the preview notice, choose **Continue**.

Choose **Workspace actions**, **All canvases**, then **${COMPLEX_CANVAS_TITLE}**. Use **Fit canvas** and switch renderers in the lower-right corner.

The board has 69 nodes, 90 connections and six groups. Its resource cards point to the files in the local \`projects/\` directory. Keep this demo directory at its current path so those references continue to resolve.
`)
  return instructions
}
