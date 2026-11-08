/** A real model uses the bundled skill to build projects, deliver an analysis, and prepare a fork. */
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-convax-plugin-host'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller'
import type { CanvasCommand, CanvasId, CanvasNodeId, CanvasNodeTypeId, CanvasOperationId } from '@deepseek-ai/dsh-convax-plugin-host/types'
import { bootProductionProfile } from '../../../../libs/dsh/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts'

const root = process.cwd()
const ctx = await bootProductionProfile({
  binName: 'convax-chat-workflows', profile: 'web', overlayPaths: [
    fileURLToPath(new URL('../../../plugin-renderer/cordis.patch.yml', import.meta.url)),
    fileURLToPath(new URL('./chat-composition.patch.yml', import.meta.url)),
    fileURLToPath(new URL('./chat-workflows.patch.yml', import.meta.url)),
  ],
  prepare(context) {
    provideCmdline(context, { args: ['--port', '0', '--no-open'], exit: code => { throw new Error(`Unexpected exit ${code}`) } })
  },
})
try {
  const host = ctx.convax
  const canvasId = 'workflow-canvas' as CanvasId
  const ownerId = 'workflow-chat' as CanvasNodeId
  const graph = () => host.workspace().canvases.find(canvas => canvas.id === canvasId)!
  let operation = 0
  async function seed(command: CanvasCommand): Promise<void> {
    const result = await host.execute({ canvasId, expectedRevision: graph()?.revision ?? 0,
      operationId: `workflow-seed-${++operation}` as CanvasOperationId, command })
    assert(result.ok, JSON.stringify(result))
  }
  await seed({ kind: 'create', title: 'Project workflows' })
  await seed({ kind: 'add-node', node: { id: ownerId, typeId: 'convax.chat' as CanvasNodeTypeId,
    dataVersion: 1, revision: 0, data: { title: 'Workspace coordinator', cwd: root }, position: { x: 0, y: 0 } } })
  const projects = [{ name: 'Atlas', seats: 17 }, { name: 'Beacon', seats: 25 }]
  for (const [index, project] of projects.entries()) {
    const cwd = join(root, project.name)
    await mkdir(cwd, { recursive: true })
    const path = join(cwd, 'requirements.md')
    await writeFile(path, `# ${project.name}\nplannedSeats=${project.seats}\n`)
    await seed({ kind: 'add-node', node: { id: `${project.name}-input` as CanvasNodeId,
      typeId: 'convax.file' as CanvasNodeTypeId, dataVersion: 1, revision: 0,
      data: { path }, position: { x: 700, y: 300 + index * 180 } } })
  }
  const thread = await host.createThread({ kind: 'create', canvasId, nodeId: ownerId,
    expectedRevision: graph().revision, operationId: 'workflow-owner-thread' as CanvasOperationId })
  assert(thread.ok, JSON.stringify(thread))
  const sessionId = thread.sessionId
  const models = await ctx.llm.listModels('deepseek-official')
  const model = models.find(value => value.id === 'deepseek-flash') ?? models[0]
  assert(model, 'The configured provider must advertise a model')
  await ctx.sessionController.selectModel({ sessionId, provider: 'deepseek-official', model: model.id })
  const renderer = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-renderer')
  assert(renderer)
  await renderer.update({ disabled: true })
  await ctx.loader.await()
  const rendererDisabled = [...ctx.loader.entries()].find(entry => entry.options.id === 'convax-renderer')?.options.disabled === true
  assert(rendererDisabled, 'The workflows must run without the renderer')
  const timings: number[] = []
  let turn = 0
  async function prompt(text: string): Promise<Agent> {
    const started = Date.now()
    await ctx.sessionController.prompt({ sessionId, requestId: `workflow-prompt-${++turn}` as SessionRequestId,
      mode: 'queue', content: [{ type: 'text', text }] }, new AbortController().signal)
    const agent = ctx.agents.get(sessionId)
    assert(agent)
    await agent.whenIdle()
    await ctx.sessions.flush(agent.session)
    await host.retryOperations()
    timings.push(Date.now() - started)
    return agent
  }
  let agent = await prompt('把当前画布上的 Atlas 和 Beacon 两份需求资料组织成两个项目工作区：每个项目建一个同名分组，保留并归入原需求卡片，添加指向该项目目录的文件夹卡片和一个项目 Chat，连接需求卡片到对应 Chat，再分别准备一个独立 thread。Chat 的目录应是需求文件所在目录。准备完成就结束，不向新 thread 发送消息，原始资料保持不变。')
  const projectChats = projects.map(project => {
    const cwd = join(root, project.name)
    const chat = host.workspace().chats.find(value => value.canvasId === canvasId && value.nodeId !== ownerId && value.cwd === cwd)
    assert(chat, `${project.name} Chat must use its project directory`)
    assert.equal(chat.threads.length, 1, 'Project preparation creates exactly one cold thread')
    assert.equal(ctx.agents.get(chat.threads[0]!.sessionId), undefined, 'Preparation must not start another Agent')
    const groupId = graph().nodes.find(node => node.id === chat.nodeId)?.groupId
    assert(groupId, 'Each project Chat belongs to its project group')
    assert.equal(graph().nodes.find(node => node.id === `${project.name}-input`)?.groupId, groupId)
    assert(graph().nodes.some(node => node.typeId === 'convax.folder' && node.data.path === cwd && node.groupId === groupId))
    assert(graph().connections.some(edge => edge.source === `${project.name}-input` && edge.target === chat.nodeId && edge.purpose === 'input'))
    return chat
  })
  assert.equal(new Set(projectChats.map(chat => graph().nodes.find(node => node.id === chat.nodeId)?.groupId)).size, 2)
  agent = await prompt('读取 Atlas 和 Beacon 两个项目的需求文件，把其中的 plannedSeats 数值相加。在当前工作目录生成 summary.md，完整内容为“总席位：<合计>”加换行，把占位符替换为计算结果，并将这个文件作为本轮成果交付回当前画布。保留两个项目工作区。')
  assert.equal(await readFile(join(root, 'summary.md'), 'utf8'), '总席位：42\n')
  const deliveries = graph().connections.filter(edge => edge.source === ownerId && edge.purpose === 'delivery')
  assert.equal(deliveries.length, 1, 'One presented file produces one durable delivery')
  assert.equal(graph().nodes.find(node => node.id === deliveries[0]!.target)?.data.path, join(root, 'summary.md'))
  const beforeForkCount = projectChats[0]!.threads.length
  const sourcePrefixLength = agent.session.snapshotEvents().length
  agent = await prompt('把刚才本对话已经完成的分析分叉到 Atlas 项目 Chat 中，准备一个新的 thread 便于后续继续。使用最新已完成的对话前缀，遵循来源对话的项目目录与历史继承规则。只准备这次分叉，不发送新任务，也不创建重复的项目 Chat。')
  const atlas = host.workspace().chats.find(chat => chat.nodeId === projectChats[0]!.nodeId)!
  assert.equal(atlas.threads.length, beforeForkCount + 1)
  const fork = atlas.threads.find(value => value.parentSessionId === sessionId)
  assert(fork, 'The prepared thread must fork the source conversation')
  assert.equal(fork.inheritedEventCount, sourcePrefixLength, 'The fork must retain the latest completed prefix')
  assert.equal(ctx.agents.get(fork.sessionId), undefined)
  assert.equal((await ctx.sessionPersistence.stat(fork.sessionId))?.header.cwd, root)
  await using forkLog = await ctx.sessionPersistence.open(fork.sessionId, 'read')
  const forkEvents = (await forkLog.read(0)).events
  assert(forkEvents.slice(fork.inheritedEventCount).every(event => event.type !== 'user/message'), 'Preparation must not send a new prompt')
  const events = agent.session.ownEvents()
  const calls = events.flatMap(event => event.type === 'tool/call' || event.type === 'tool/ptc-dispatch'
    ? [{ name: event.data.name, arguments: (typeof event.data.arguments === 'string' ? JSON.parse(event.data.arguments) : event.data.arguments) as Record<string, unknown> }] : [])
  assert(calls.some(call => call.name === 'skill' && call.arguments.name === 'convax'), 'The ordinary request must load the bundled user skill')
  for (const name of ['convax_graph', 'convax_commit', 'convax_chat', 'read', 'write', 'present']) {
    assert(calls.some(call => call.name === name), `Workflow must exercise ${name}`)
  }
  assert(events.some(event => event.type === 'user/message' && event.data.source?.kind === 'runtime-context'
    && JSON.stringify(event.data.content).includes('Convax Chat identity:')), 'The bound Chat must receive runtime identity')
  for (const project of projects) {
    const path = join(root, project.name, 'requirements.md')
    assert(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'read' && !event.data.isError
      && typeof event.data.arguments === 'object' && event.data.arguments !== null
      && 'file_path' in event.data.arguments && typeof event.data.arguments.file_path === 'string'
      && resolve(root, event.data.arguments.file_path) === path), 'The analysis must read each input file successfully')
    assert.equal(await readFile(join(root, project.name, 'requirements.md'), 'utf8'), `# ${project.name}\nplannedSeats=${project.seats}\n`)
  }
  await writeFile(join(root, 'workflow-report.json'), JSON.stringify({
    model: model.id, timings, rendererDisabled, canvas: graph(), chats: host.workspace().chats,
    sessionId, forkSessionId: fork.sessionId, calls: calls.map(call => call.name),
  }))
} finally { await ctx.fiber.dispose() }
