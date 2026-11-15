import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { ArkProvider } from '../../src/providers/ark.ts'
import { JimengProvider } from '../../src/providers/jimeng.ts'
import { LibTVProvider } from '../../src/providers/libtv.ts'
import { OpenAIProvider } from '../../src/providers/openai.ts'
import type { ConnectionSnapshot, ProviderCheckpoint, ProviderRequest, ProviderRuntime } from '../../src/types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'convax-creation-provider-'))
  cleanups.push(() => rm(path, { recursive: true, force: true }))
  return path
}

function connection(settings: ConnectionSnapshot['settings']): ConnectionSnapshot {
  return { id: 'connection' as ConnectionSnapshot['id'], providerId: 'test' as ConnectionSnapshot['providerId'], revision: 1, accountBinding: 'test-account', settings }
}

function runtime(workDirectory: string, settings: ConnectionSnapshot['settings'] = {}): ProviderRuntime & { checkpoints: ProviderCheckpoint[] } {
  const checkpoints: ProviderCheckpoint[] = []
  return { operationId: 'operation' as ProviderRuntime['operationId'], connection: connection(settings), workDirectory, maxBytes: 1024 * 1024,
    signal: new AbortController().signal, checkpoints, checkpoint: async (value) => { checkpoints.push(value) } }
}

const request: ProviderRequest = { kind: 'image', prompt: 'literal $(echo unsafe); `echo unsafe`', parameters: {}, references: [] }

async function server(handler: (request: IncomingMessage, response: ServerResponse, body: string) => void): Promise<string> {
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => { handler(request, response, body) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => {
      if (error) reject(error)
      else resolve()
    }))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing server address')
  return `http://127.0.0.1:${address.port}/v1`
}

function apiDeps() { return { subprocess: {} as SubprocessRuntime, readCredential: async () => 'fixture-key' } }

describe('model API providers', () => {
  it('discovers compatible OpenAI models before selection and keeps the draft credential transient', async () => {
    const calls: string[] = []
    const baseUrl = await server((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      expect(req.headers.authorization).toBe('Bearer unsaved-fixture-key')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [
        { id: 'gpt-image-2' }, { id: 'gpt-4o-mini-tts' }, { id: 'tts-1-hd' }, { id: 'gpt-4o' }, { id: 'whisper-1' },
      ] }))
    })
    const input = connection({ baseUrl })
    const provider = new OpenAIProvider({ ...apiDeps(), readCredential: async () => undefined })
    const preparation = await provider.prepare(input, new AbortController().signal, 'unsaved-fixture-key')
    expect(preparation).toEqual({ state: 'ready', models: [
      { id: 'gpt-image-2', label: 'gpt-image-2', kind: 'image' },
      { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts', kind: 'audio' },
      { id: 'tts-1-hd', label: 'tts-1-hd', kind: 'audio' },
    ] })
    expect(calls).toEqual(['GET /v1/models'])
    expect(input.settings).toEqual({ baseUrl })
    expect(JSON.stringify(preparation)).not.toContain('unsaved-fixture-key')
    expect(await provider.prepare(input, new AbortController().signal)).toMatchObject({ state: 'unavailable', reason: 'not-authorized' })
  })

  it('discovers only Ark video models without requiring a chosen model or Endpoint', async () => {
    const calls: string[] = []
    const baseUrl = await server((req, res) => {
      calls.push(`${req.method} ${req.url}`)
      expect(req.headers.authorization).toBe('Bearer draft-ark-key')
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ data: [{ id: 'doubao-seedance-2-0-260128' }, { id: 'doubao-seed-1-6' }] }))
    })
    const provider = new ArkProvider(apiDeps())
    const preparation = await provider.prepare(connection({ baseUrl }), new AbortController().signal, 'draft-ark-key')
    expect(preparation).toEqual({ state: 'ready', models: [
      { id: 'doubao-seedance-2-0-260128', label: 'doubao-seedance-2-0-260128', kind: 'video' },
    ] })
    expect(calls).toEqual(['GET /v1/models'])
  })

  it('reports rejected credentials without echoing the API response body', async () => {
    const baseUrl = await server((_req, res) => { res.writeHead(401); res.end('do not expose fixture-private-key') })
    for (const provider of [new OpenAIProvider(apiDeps()), new ArkProvider(apiDeps())]) {
      const preparation = await provider.prepare(connection({ baseUrl }), new AbortController().signal)
      expect(preparation).toMatchObject({ state: 'unavailable', reason: 'not-authorized' })
      expect(JSON.stringify(preparation)).not.toContain('fixture-private-key')
    }
  })

  it('persists generated image bytes and recovers them without charging again', async () => {
    let posts = 0
    const image = Buffer.from('89504e470d0a1a0a00000000', 'hex')
    const baseUrl = await server((req, res, body) => {
      expect(req.headers.authorization).toBe('Bearer fixture-key')
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'GET') { res.end(JSON.stringify({ id: 'gpt-image-fixture' })); return }
      posts++
      expect(req.url).toBe('/v1/images/generations')
      expect(JSON.parse(body)).toEqual({ model: 'gpt-image-fixture', prompt: request.prompt })
      res.end(JSON.stringify({ data: [{ b64_json: image.toString('base64') }] }))
    })
    const run = runtime(await directory(), { baseUrl, imageModel: 'gpt-image-fixture' })
    const provider = new OpenAIProvider(apiDeps())
    expect((await provider.describe(run.connection, run.signal)).state).toBe('ready')
    const snapshot = await provider.submit(request, run)
    expect(snapshot.state).toBe('completed')
    expect(run.checkpoints).toEqual([{ version: 1, data: { attempted: true } }])
    expect(await provider.reconcile(request, run.checkpoints[0], run)).toEqual(snapshot)
    if (snapshot.state !== 'completed') throw new Error('Expected output')
    const destination = join(run.workDirectory, 'import.png')
    await provider.collect(snapshot.outputs[0]!, { path: destination }, run)
    expect(await readFile(destination)).toEqual(image)
    expect(posts).toBe(1)
  })

  it('requests WAV speech through the speech endpoint and persists its bytes', async () => {
    const baseUrl = await server((req, res, body) => {
      expect(req.url).toBe('/v1/audio/speech')
      expect(JSON.parse(body)).toEqual({ model: 'tts-fixture', input: 'Hello', voice: 'alloy', response_format: 'wav' })
      res.setHeader('Content-Type', 'audio/wav')
      res.end(Buffer.from('RIFFfixtureWAVE'))
    })
    const run = runtime(await directory(), { baseUrl, audioModel: 'tts-fixture' })
    const snapshot = await new OpenAIProvider(apiDeps()).submit({ ...request, kind: 'audio', prompt: 'Hello', parameters: { voice: 'alloy', response_format: 'wav' } }, run)
    expect(snapshot.state).toBe('completed')
    if (snapshot.state === 'completed') expect(snapshot.outputs[0]?.suggestedFilename).toBe('creation-1.wav')
  })

  it('keeps ambiguous API submissions unknown and never retries their POST', async () => {
    let posts = 0
    const baseUrl = await server((_req, res) => { posts++; res.destroy() })
    const run = runtime(await directory(), { baseUrl, imageModel: 'gpt-image-fixture' })
    const provider = new OpenAIProvider(apiDeps())
    expect((await provider.submit(request, run)).state).toBe('submission-unknown')
    expect((await provider.reconcile(request, run.checkpoints[0], run)).state).toBe('submission-unknown')
    expect(posts).toBe(1)
  })

  it('recovers an Ark task by ID and refreshes its media URL before collection', async () => {
    let posts = 0
    let queries = 0
    let baseUrl = ''
    baseUrl = await server((req, res, body) => {
      if (req.url === '/output.mp4') { res.end('fixture video'); return }
      res.setHeader('Content-Type', 'application/json')
      if (req.method === 'POST') {
        posts++
        expect(JSON.parse(body)).toEqual({ model: 'video-fixture', content: [{ type: 'text', text: request.prompt }] })
        res.end(JSON.stringify({ id: 'task-fixture' })); return
      }
      queries++
      expect(req.url).toBe('/v1/contents/generations/tasks/task-fixture')
      res.end(JSON.stringify({ id: 'task-fixture', status: 'succeeded', content: { video_url: new URL('/output.mp4', baseUrl).href } }))
    })
    const run = runtime(await directory(), { baseUrl, videoModel: 'video-fixture' })
    const provider = new ArkProvider(apiDeps())
    const videoRequest = { ...request, kind: 'video' as const }
    const submitted = await provider.submit(videoRequest, run)
    expect(submitted.state).toBe('running')
    const checkpoint = run.checkpoints.at(-1)
    expect(checkpoint?.data).toEqual({ taskId: 'task-fixture' })
    const complete = await provider.reconcile(videoRequest, checkpoint, run)
    if (complete.state !== 'completed') throw new Error('Expected completion')
    expect(JSON.stringify(complete)).not.toContain('http')
    const destination = join(run.workDirectory, 'video.mp4')
    await provider.collect(complete.outputs[0]!, { path: destination }, run)
    expect(await readFile(destination, 'utf8')).toBe('fixture video')
    expect(posts).toBe(1)
    expect(queries).toBe(2)
    expect(await provider.cancel()).toEqual({ state: 'unsupported' })
  })

  it('bounds large responses and does not fabricate an output after a transfer failure', async () => {
    const baseUrl = await server((_req, res) => { res.setHeader('Content-Length', '999999999'); res.end('large') })
    const run = runtime(await directory(), { baseUrl, audioModel: 'speech-fixture' })
    const provider = new OpenAIProvider(apiDeps())
    expect((await provider.submit({ ...request, kind: 'audio', parameters: { voice: 'alloy' } }, run)).state).toBe('submission-unknown')
  })
})

async function cliFixture(source: string) {
  const workDirectory = await directory()
  const executable = join(workDirectory, 'provider-fixture')
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => fiber.dispose())
  return { workDirectory, executable, deps: { subprocess: ctx.subprocess, readCredential: async () => undefined } }
}

describe('CLI providers with local executable fixtures', () => {
  it('detects Jimeng and lists all three media catalogs before project, model and budget are configured', async () => {
    const fixture = await cliFixture(`
const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');
const kind=args[args.indexOf('--type')+1];
const data = args[0] === 'auth' ? {loggedIn:true} : {items:[{model:kind+'-fixture',displayName:kind+' fixture'}]};
console.log(JSON.stringify({schemaVersion:'2',ok:true,data}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory })
    const provider = new JimengProvider(fixture.deps)
    expect(await provider.prepare(run.connection, run.signal)).toEqual({ state: 'ready', models: [
      { id: 'image-fixture', label: 'image fixture', kind: 'image' },
      { id: 'video-fixture', label: 'video fixture', kind: 'video' },
      { id: 'audio-fixture', label: 'audio fixture', kind: 'audio' },
    ] })
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toHaveLength(4)
    expect(calls).toEqual(expect.arrayContaining([
      ['auth', 'status', '--format', 'json', '--non-interactive', '--profile', 'default'],
      ['model', 'list', '--type', 'image', '--format', 'json', '--non-interactive', '--profile', 'default'],
      ['model', 'list', '--type', 'video', '--format', 'json', '--non-interactive', '--profile', 'default'],
      ['model', 'list', '--type', 'audio', '--format', 'json', '--non-interactive', '--profile', 'default'],
    ]))
    expect(run.checkpoints).toEqual([])
  })

  it('uses a transient LibTV token only for read-only status and model searches', async () => {
    const fixture = await cliFixture(`
const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');
if(args[0] === 'status') console.log(JSON.stringify({auth:{loggedIn:process.env.LIBTV_TOKEN === 'draft-token'},binding:{}}));
else if(args[0] === 'model' && args[1] === 'search') console.log(JSON.stringify({nodeType:args[3],query:'',matchKind:'all',matches:[{modelKey:args[3]+'-fixture',modelName:args[3]+' model'}]}));
else process.exit(1);`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory })
    const provider = new LibTVProvider(fixture.deps)
    expect(await provider.prepare(run.connection, run.signal, 'draft-token')).toEqual({ state: 'ready', models: [
      { id: 'image-fixture', label: 'image model', kind: 'image' },
      { id: 'video-fixture', label: 'video model', kind: 'video' },
      { id: 'audio-fixture', label: 'audio model', kind: 'audio' },
    ] })
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toHaveLength(4)
    expect(calls).toEqual(expect.arrayContaining([
      ['status'], ['model', 'search', '--type', 'image'], ['model', 'search', '--type', 'video'], ['model', 'search', '--type', 'audio'],
    ]))
    expect(JSON.stringify(calls)).not.toContain('draft-token')
    expect(run.checkpoints).toEqual([])
  })

  it('distinguishes missing CLIs and signed-out accounts without requiring generation settings', async () => {
    const fixture = await cliFixture(`
const args=process.argv.slice(2);
console.log(JSON.stringify(args[0] === 'auth' ? {data:{loggedIn:false}} : {auth:{loggedIn:false}}));`)
    for (const provider of [new JimengProvider(fixture.deps), new LibTVProvider(fixture.deps)]) {
      const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory })
      expect(await provider.prepare(run.connection, run.signal)).toMatchObject({ state: 'unavailable', reason: 'not-authorized' })
      run.connection.settings.executable = join(fixture.workDirectory, 'does-not-exist')
      expect(await provider.prepare(run.connection, run.signal)).toMatchObject({ state: 'unavailable', reason: 'not-installed' })
    }
  })

  it('checkpoints Jimeng identities before saving and running, and sends the prompt as one argument', async () => {
    const fixture = await cliFixture(`
const fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync('calls.jsonl', JSON.stringify(args)+'\\n');
let data = {};
if(args[0] === 'auth') data = { loggedIn: true };
if(args[0] === 'model') data = { items: [{ model:'image-fixture', modes:[{name:'t2i', flags:[{flag:'--count', min:1, max:4}]}] }] };
if(args[0] === 'node') {
 const persisted=JSON.parse(fs.readFileSync('checkpoint.json','utf8'));
 if(args[1] === 'create') {if(persisted.data.phase!=='saving')process.exit(1);data={node:{nodeId:args[args.indexOf('--node-id')+1]}};}
 if(args[1] === 'quote') data={items:[{nodeId:persisted.data.nodeId,maxCredits:10}],totalMaxCredits:10,confirmable:true};
 if(args[1] === 'confirm') data={creditConfirmationToken:'fixture-token',creditCeiling:20};
 if(args[1] === 'run') {if(persisted.data.phase!=='submitting'||persisted.data.submitId!==args[args.indexOf('--submit-id')+1])process.exit(1);data={items:[{submitId:persisted.data.submitId,state:'accepted'}]};}
}
if(args[0] === 'operation') data = { state:'succeeded', resources:[{resourceId:'resource-fixture',state:'succeeded'}] };
if(args[0] === 'resource') fs.writeFileSync(args[args.indexOf('--output')+1], 'fixture image');
console.log(JSON.stringify({schemaVersion:'2',ok:true,data}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory, projectId: '11111111-2222-3333-4444-555555555555', creditCeiling: 20, imageModel: 'image-fixture' })
    run.checkpoint = async (value) => {
      await writeFile(join(fixture.workDirectory, 'checkpoint.json'), JSON.stringify(value))
      run.checkpoints.push(value)
    }
    const provider = new JimengProvider(fixture.deps)
    const inspection = await provider.describe(run.connection, run.signal)
    expect(inspection.state).toBe('ready')
    if (inspection.state === 'ready') expect(inspection.capabilities.map(value => value.kind)).toEqual(['image'])
    const result = await provider.submit({ ...request, parameters: { mode: 't2i' } }, run)
    expect(result.state).toBe('completed')
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const generated = calls.find(args => args[0] === 'node')!
    expect(generated[generated.indexOf('--prompt') + 1]).toBe(request.prompt)
    const submitted = calls.find(args => args[0] === 'node' && args[1] === 'run')!
    expect(submitted[submitted.indexOf('--submit-id') + 1]).toBe(run.checkpoints[0]?.data.submitId)
    expect(generated[generated.indexOf('--node-id') + 1]).toMatch(/^node_[0-9a-hjkmnp-tv-z]{10}$/)
    expect(generated).not.toContain('--run')
    expect(calls.find(args => args[0] === 'node' && args[1] === 'confirm')).toContain('--credit-ceiling')
    expect(generated).not.toContain('--yes')
    await provider.reconcile(request, run.checkpoints[0], run)
    const updated = await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')
    expect(updated.split('\n').filter(line => line.startsWith('["node","create"'))).toHaveLength(1)
    expect(updated.split('\n').filter(line => line.startsWith('["node","run"'))).toHaveLength(1)
  })

  it('exposes the official image flags and requires an explicit fixed output count', async () => {
    const fixture = await cliFixture(`
const args=process.argv.slice(2);
console.log(JSON.stringify({ok:true,data:args[0]==='auth'?{loggedIn:true}:{items:[{model:'fixed-image',displayName:'Four image model',modes:[{name:'t2i',flags:[
 {flag:'--count',required:false,min:4,max:4,step:1},{flag:'--resolution',required:true,values:['1K','2K']},{flag:'--ratio',values:['1:1','16:9']}
]}]}]}}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory,
      projectId: '11111111-2222-3333-4444-555555555555', imageModel: 'fixed-image' })
    const provider = new JimengProvider(fixture.deps)
    const result = await provider.describe(run.connection, run.signal)
    expect(result).toMatchObject({ state: 'ready', capabilities: [{ kind: 'image', maxOutputs: 4, parameterSchema: {
      required: ['mode', 'count', 'resolution'], properties: {
        count: { type: 'integer', enum: [4] }, resolution: { type: 'string', enum: ['1K', '2K'] },
      },
    } }] })
    expect(provider.descriptor.supportedKinds).toEqual(['image', 'video', 'audio'])
    expect(provider.descriptor.unsupportedKinds).toBeUndefined()
    expect(provider.descriptor.configuration?.filter(field => field.mediaKind).every(field => !field.required)).toBe(true)
    expect(provider.descriptor.configuration?.find(field => field.key === 'creditCeiling')).toMatchObject({ advanced: true })
    expect(provider.descriptor.configuration?.find(field => field.key === 'creditCeiling')?.required).toBeUndefined()
    expect(provider.descriptor.configuration?.filter(field => field.affectsSetup).map(field => field.key)).toEqual(['executable', 'cwd', 'profile'])
  })

  it.each(['video', 'audio'] as const)('saves a %s draft with discovered parameters and no hidden image-model requirement', async (kind) => {
    const fixture = await cliFixture(`
const fs=require('node:fs');const args=process.argv.slice(2);const value=key=>args[args.indexOf(key)+1];
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');let data={};
if(args[0]==='auth')data={loggedIn:true};
else if(args[0]==='model')data={items:[{model:value('--type')+'-fixture',modes:value('--type')==='video'
 ?[{name:'t2v',flags:[{flag:'--duration',required:true,values:['5','10']},{flag:'--ratio',values:['16:9']},{flag:'--count',min:1,max:2}]}]
 :[{name:'tts',scenario:'text-reading',flags:[{flag:'--scenario',required:true,values:['text-reading']}]}]}]};
else if(args[0]==='voice')data={models:{'audio-fixture':Number(value('--offset'))===0
 ?{items:[{voiceId:'12345',voiceName:'Shared narrator'}],hasMore:true,nextOffset:1,totalCount:2}
 :{items:[{voiceId:'98765432101234567',voiceName:'Shared narrator'}],hasMore:false,nextOffset:2,totalCount:2}}};
else if(args[0]==='node'&&args[1]==='create')data={node:{nodeId:value('--node-id')}};
else if(args[0]==='node'&&args[1]==='quote')data={items:[{nodeId:value('--node-id'),maxCredits:10}],totalMaxCredits:10,confirmable:true};
else process.exit(2);
console.log(JSON.stringify({schemaVersion:'2',ok:true,data}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory,
      projectId: '11111111-2222-3333-4444-555555555555', [`${kind}Model`]: `${kind}-fixture` })
    const provider = new JimengProvider(fixture.deps)
    const inspection = await provider.describe(run.connection, run.signal)
    expect(inspection).toMatchObject({ state: 'ready', capabilities: [{ kind, modelId: `${kind}-fixture` }] })
    if (kind === 'audio' && inspection.state === 'ready') {
      expect(validateJsonSchemaValue(inspection.capabilities[0]!.parameterSchema,
        { mode: 'tts', scenario: 'text-reading', 'voice-name': 'Shared narrator' })).not.toEqual([])
    }
    const parameters = kind === 'video' ? { mode: 't2v', duration: 5, ratio: '16:9', count: 1 }
      : { mode: 'tts', scenario: 'text-reading', 'voice-id': '98765432101234567' }
    expect(await provider.submit({ ...request, kind, parameters }, run)).toMatchObject({ state: 'awaiting-approval', approval: { credits: 10 } })
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const saved = calls.find(args => args[0] === 'node' && args[1] === 'create')!
    expect(saved.slice(0, 3)).toEqual(['node', 'create', kind])
    expect(saved[saved.indexOf('--prompt') + 1]).toBe(request.prompt)
    expect(saved).not.toContain('--run')
    if (kind === 'video') expect(saved).toEqual(expect.arrayContaining(['--duration', '5', '--ratio', '16:9', '--count', '1']))
    else {
      expect(saved).toEqual(expect.arrayContaining(['--scenario', 'text-reading', '--voice-id', '98765432101234567']))
      expect(saved).not.toContain('--count')
      expect(calls.filter(args => args[0] === 'voice').map(args => args[args.indexOf('--offset') + 1])).toEqual(['0', '1', '0', '1'])
    }
    expect(calls.some(args => args[1] === 'run' || args[1] === 'confirm')).toBe(false)
  })

  it('preserves first-frame and last-frame upload order and rejects invalid modes before uploading', async () => {
    const fixture = await cliFixture(`
const fs=require('node:fs');const args=process.argv.slice(2);const value=key=>args[args.indexOf(key)+1];
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');let data={};
if(args[0]==='model')data={items:[{model:'video-fixture',modes:[{name:'t2v',flags:[]},{name:'first_last_frame',flags:[],
 references:{min:1,max:2,types:[{mediaType:'image',min:1,max:2}]}}]}]};
else if(args[0]==='resource'&&args[1]==='upload')data={resourceId:value('--resource-id')};
else if(args[0]==='node'&&args[1]==='create')data={node:{nodeId:value('--node-id')}};
else if(args[0]==='node'&&args[1]==='quote')data={items:[{nodeId:value('--node-id'),maxCredits:10}],totalMaxCredits:10,confirmable:true};
else process.exit(2);
console.log(JSON.stringify({schemaVersion:'2',ok:true,data}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory,
      projectId: '11111111-2222-3333-4444-555555555555', videoModel: 'video-fixture' })
    const provider = new JimengProvider(fixture.deps)
    const references: ProviderRequest['references'] = ['first.png', 'last.png'].map(name => ({ role: 'reference', kind: 'image',
      path: join(fixture.workDirectory, name), mimeType: 'image/png' }))
    await expect(provider.submit({ ...request, kind: 'video', parameters: { mode: 't2v' }, references }, run)).rejects.toThrow('0–0 references')
    expect((await provider.submit({ ...request, kind: 'video', parameters: { mode: 'first_last_frame' }, references }, run)).state).toBe('awaiting-approval')
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    const uploads = calls.filter(args => args[0] === 'resource')
    expect(uploads.map(args => args[args.indexOf('--file') + 1])).toEqual(references.map(reference => reference.path))
    const saved = calls.find(args => args[0] === 'node' && args[1] === 'create')!
    expect(saved.flatMap((value, index) => value === '--ref' ? [saved[index + 1]] : [])).toEqual(uploads.map(args => `res:${args[args.indexOf('--resource-id') + 1]}`))
    expect(calls.filter(args => args[0] === 'node' && args[1] === 'create')).toHaveLength(1)
  })

  it('creates a LibTV node once, runs it once, and respects the watermark download option', async () => {
    const fixture = await cliFixture(`
const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2); fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0] === 'status') console.log(JSON.stringify({auth:{loggedIn:true},binding:{}}));
else if(args[0] === 'model' && args[1] === 'search') console.log(JSON.stringify({nodeType:'image',query:'',matchKind:'all',matches:[{modelKey:'image-fixture',modelName:'LibTV Image One'}]}));
else if(args[0] === 'model') console.log(JSON.stringify({modelName:'image-fixture',modelKey:'image-fixture',schema:{properties:{count:[1,2],ratio:{enum:['1:1','16:9']}}}}));
else if(args[0] === 'download') {const out=path.join(args[args.indexOf('-o')+1],'image.png');fs.writeFileSync(out,'fixture image');console.log(out)}
else if(args[1] === 'create') console.log(JSON.stringify({nodeKey:'created-node'}));
else if(args.includes('--run')) console.log(JSON.stringify({nodeKey:'created-node',status:2}));
else console.log(JSON.stringify({nodeKey:'created-node',data:{url:['https://example.invalid/media']}}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory, projectUuid: 'project-fixture', watermark: true, imageModel: 'image-fixture' })
    const provider = new LibTVProvider(fixture.deps)
    expect(await provider.describe(run.connection, run.signal)).toMatchObject({ state: 'ready', capabilities: [
      { kind: 'image', modelId: 'image-fixture', modelLabel: 'LibTV Image One' },
    ] })
    const result = await provider.submit(request, run)
    if (result.state !== 'completed') throw new Error('Expected output')
    expect(run.checkpoints.at(-1)?.data.nodeKey).toBe('created-node')
    await provider.collect(result.outputs[0]!, { path: join(fixture.workDirectory, 'import.png') }, run)
    await provider.reconcile(request, run.checkpoints.at(-1), run)
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args.includes('--run'))).toHaveLength(1)
    expect(calls.find(args => args[0] === 'node' && args[1] === 'create')).toContain('model=LibTV Image One')
    expect(calls.find(args => args[0] === 'download')).toContain('true')
    expect(await readFile(join(fixture.workDirectory, 'import.png'), 'utf8')).toBe('fixture image')
  })

  it('does not rerun an interrupted LibTV generation while querying its original node', async () => {
    const fixture = await cliFixture(`
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='model')console.log(JSON.stringify({matches:[{modelKey:'image-fixture',modelName:'LibTV Image One'}]}));
else if(args[1]==='create')console.log(JSON.stringify({nodeKey:'uncertain-node'}));
else if(args.includes('--run'))process.exit(1);
else console.log(JSON.stringify({nodeKey:'uncertain-node',data:{url:[]}}));`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory, projectUuid: 'project-fixture', watermark: false, imageModel: 'image-fixture' })
    const provider = new LibTVProvider(fixture.deps)
    expect((await provider.submit(request, run)).state).toBe('submission-unknown')
    expect((await provider.reconcile(request, run.checkpoints.at(-1), run)).state).toBe('submission-unknown')
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args.includes('--run'))).toHaveLength(1)
    expect(calls.filter(args => args.includes('create'))).toHaveLength(1)
  })

  it('uses the selected LibTV model key instead of the connection default and rejects ambiguous names before mutations', async () => {
    const fixture = await cliFixture(`
const fs=require('node:fs');const args=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
if(args[0]==='model')console.log(JSON.stringify({matches:[
 {modelKey:'default-key',modelName:'Default model'},{modelKey:'selected-key',modelName:'Selected model'},
 {modelKey:'duplicate-one',modelName:'Same name'},{modelKey:'duplicate-two',modelName:'Same name'}
]}));
else if(args[1]==='create'){if(!args.includes('model=Selected model'))process.exit(1);console.log(JSON.stringify({nodeKey:'selected-node'}));}
else if(args.includes('--run'))console.log(JSON.stringify({nodeKey:'selected-node',status:2}));
else process.exit(1);`)
    const run = runtime(fixture.workDirectory, { executable: fixture.executable, cwd: fixture.workDirectory,
      projectUuid: 'project-fixture', watermark: true, imageModel: 'default-key' })
    const provider = new LibTVProvider(fixture.deps)
    for (const modelId of ['missing-key', 'duplicate-one']) {
      await expect(provider.submit({ ...request, modelId }, run)).rejects.toThrow(/unavailable|multiple models/)
    }
    expect(run.checkpoints).toEqual([])
    const before = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(before.every(args => args[0] === 'model')).toBe(true)
    expect(await provider.submit({ ...request, modelId: 'selected-key' }, run)).toMatchObject({ state: 'completed' })
    const calls = (await readFile(join(fixture.workDirectory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls.filter(args => args[1] === 'create')).toHaveLength(1)
    expect(calls.find(args => args[1] === 'create')).toContain('model=Selected model')
    expect(calls.some(args => args.includes('model=selected-key') || args.includes('model=Default model'))).toBe(false)
  })
})
