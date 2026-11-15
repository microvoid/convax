import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JimengProvider } from '../../src/providers/jimeng.ts'
import type { ProviderCheckpoint, ProviderRequest, ProviderRuntime } from '../../src/types.ts'

const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { while (cleanups.length) await cleanups.pop()!() })
const projectId = '11111111-2222-3333-4444-555555555555'
const request: ProviderRequest = { kind: 'image', prompt: 'A test image; $(not a shell)', modelId: 'image-fixture',
  parameters: { mode: 't2i', count: 1 }, references: [] }
interface Plan {
  price: number
  dropRunReply?: boolean
  dropSaveReply?: boolean
  confirmPrice?: number
  awaitingConfirmation?: boolean
  resubmittable?: boolean
  invalidQuote?: boolean
}

/** A real child process models only the external CLI; checkpoints and calls remain inspectable on disk. */
async function fixture(creditCeiling?: number) {
  const directory = await mkdtemp(join(tmpdir(), 'convax-jimeng-approval-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const ctx = new Context()
  const fiber = await ctx.plugin(LocalSubprocessRuntime)
  cleanups.push(() => fiber.dispose())
  const program = join(directory, 'cli.cjs')
  await writeFile(program, `
const fs=require('node:fs');const args=process.argv.slice(2);const name=args.slice(0,2).join(' ');
const value=flag=>args[args.indexOf(flag)+1];
const plan=JSON.parse(fs.readFileSync('plan.json','utf8'));
const state=JSON.parse(fs.readFileSync('state.json','utf8'));
const checkpoint=()=>JSON.parse(fs.readFileSync('checkpoint.json','utf8')).data;
fs.appendFileSync('calls.jsonl',JSON.stringify(args)+'\\n');
let data={};
if(name==='model list')data={items:[{model:'image-fixture',modes:[{name:'t2i',flags:[{flag:'--count',min:1,max:4}]}]}]};
else if(name==='node create'){
 if(args.includes('--run')||args.includes('--submit-id')||checkpoint().phase!=='saving')process.exit(2);
 state.nodeId=value('--node-id');state.creates++;data={node:{nodeId:state.nodeId}};
}else if(name==='node show')data={nodes:[{nodeId:state.nodeId,result:'FOUND',node:{nodeId:state.nodeId}}]};
else if(name==='node quote')data={items:[{nodeId:state.nodeId,maxCredits:plan.price}],totalMaxCredits:plan.invalidQuote?undefined:plan.price,draftVersion:1,confirmable:true,confirmationRequired:true};
else if(name==='node confirm'){
 if(plan.confirmPrice!==undefined){plan.price=plan.confirmPrice;delete plan.confirmPrice;fs.writeFileSync('plan.json',JSON.stringify(plan));process.exit(10);}
 if(Number(value('--credit-ceiling'))<plan.price)process.exit(10);
 data={creditConfirmationToken:'private-approval-token',creditCeiling:Number(value('--credit-ceiling'))};
}else if(name==='node run'){
 if(checkpoint().phase!=='submitting'||checkpoint().submitId!==value('--submit-id')||value('--node-id')!==state.nodeId||value('--credit-token')!=='private-approval-token')process.exit(2);
 state.runs++;state.submitId=value('--submit-id');data={items:[{nodeId:state.nodeId,submitId:state.submitId,state:'accepted'}]};
}else if(name==='operation status'){
 data=state.runs?{state:'succeeded',submission:{state:'completed',resubmittable:false},resources:[{resourceId:'image-output',state:'succeeded'}]}
  :plan.awaitingConfirmation?{state:'awaiting_confirmation',submission:{state:'awaiting_confirmation',resubmittable:plan.resubmittable===true},resources:[]}
  :{state:'unknown',submission:{state:'absent',resubmittable:false},resources:[]};
}else process.exit(2);
fs.writeFileSync('state.json',JSON.stringify(state));
if(name==='node run'&&plan.dropRunReply)process.exit(1);
if(name==='node create'&&plan.dropSaveReply)process.exit(1);
console.log(JSON.stringify({schemaVersion:'2',ok:true,data}));
`)
  await writeFile(join(directory, 'state.json'), JSON.stringify({ creates: 0, runs: 0 }))
  await writeFile(join(directory, 'plan.json'), JSON.stringify({ price: 30 }))
  const nativeSpawn = ctx.subprocess.spawn.bind(ctx.subprocess)
  const spawn = vi.spyOn(ctx.subprocess, 'spawn').mockImplementation(spec => nativeSpawn({
    ...spec, argv: [spec.argv[0]!, program, ...spec.argv.slice(1)],
  }))
  cleanups.push(async () => { spawn.mockRestore() })
  let checkpoint: ProviderCheckpoint | undefined
  const runtime: ProviderRuntime = {
    operationId: 'jimeng-operation' as ProviderRuntime['operationId'],
    connection: { id: 'jimeng-connection' as ProviderRuntime['connection']['id'], providerId: 'jimeng-cli' as ProviderRuntime['connection']['providerId'],
      revision: 1, accountBinding: 'fixture-account', settings: { executable: process.execPath, cwd: directory, projectId, imageModel: 'image-fixture',
        ...(creditCeiling === undefined ? {} : { creditCeiling }) } },
    workDirectory: directory, maxBytes: 1024, signal: new AbortController().signal,
    checkpoint: async (value) => { checkpoint = structuredClone(value); await writeFile(join(directory, 'checkpoint.json'), JSON.stringify(value)) },
  }
  const provider = new JimengProvider({ subprocess: ctx.subprocess, readCredential: async () => undefined })
  return { provider, runtime, checkpoint: () => checkpoint!,
    plan: (value: Plan) => writeFile(join(directory, 'plan.json'), JSON.stringify(value)),
    state: async () => JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { creates: number; runs: number; nodeId?: string; submitId?: string },
    calls: async () => (await readFile(join(directory, 'calls.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[]),
  }
}

describe('Jimeng saved drafts and credit approval', () => {
  it('preserves an unapproved draft and quote without submitting a paid generation', async () => {
    const run = await fixture()
    const result = await run.provider.submit(request, run.runtime)
    expect(result).toMatchObject({ state: 'awaiting-approval', approval: { credits: 30, unit: 'credits' } })
    expect(run.checkpoint().data).toMatchObject({ projectId, phase: 'saved' })
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    const calls = await run.calls()
    expect(calls.map(args => args.slice(0, 2).join(' '))).toEqual(['model list', 'node create', 'node quote'])
    expect(calls[1]![calls[1]!.indexOf('--prompt') + 1]).toBe(request.prompt)
  })

  it('runs within an existing explicit ceiling and keeps the short-lived confirmation token out of checkpoints', async () => {
    const run = await fixture(30)
    expect((await run.provider.submit(request, run.runtime)).state).toBe('completed')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 1, submitId: run.checkpoint().data.submitId })
    expect(JSON.stringify(run.checkpoint())).not.toContain('private-approval-token')
    expect((await run.calls()).some(args => args.includes('--yes'))).toBe(false)
  })

  it('re-quotes the same draft after approval and asks again when its price exceeds that approval', async () => {
    const run = await fixture(10)
    expect((await run.provider.submit(request, run.runtime)).state).toBe('awaiting-approval')
    const checkpoint = run.checkpoint()
    await run.plan({ price: 35 })
    expect(await run.provider.approve(request, checkpoint, 30, run.runtime)).toMatchObject({ state: 'awaiting-approval', approval: { credits: 35 } })
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    expect((await run.provider.approve(request, run.checkpoint(), 35, run.runtime)).state).toBe('completed')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 1, submitId: checkpoint.data.submitId })
    expect(run.runtime.connection.settings.creditCeiling).toBe(10)
  })

  it('recovers an accepted run after a lost response without creating or charging again', async () => {
    const run = await fixture()
    await run.provider.submit(request, run.runtime)
    await run.plan({ price: 30, dropRunReply: true })
    await run.provider.approve(request, run.checkpoint(), 30, run.runtime)
    expect((await run.provider.approve(request, run.checkpoint(), 30, run.runtime)).state).toBe('completed')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 1 })
  })

  it('finds the original saved node after a lost save reply and only quotes it during recovery', async () => {
    const run = await fixture(30)
    await run.plan({ price: 30, dropSaveReply: true })
    expect((await run.provider.submit(request, run.runtime)).state).toBe('submission-unknown')
    expect(run.checkpoint().data.phase).toBe('saving')
    const nodeId = run.checkpoint().data.nodeId
    expect(await run.provider.reconcile(request, run.checkpoint(), run.runtime)).toMatchObject({
      state: 'awaiting-approval', checkpoint: { data: { nodeId, phase: 'saved' } }, approval: { credits: 30 },
    })
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    expect((await run.calls()).map(args => args.slice(0, 2).join(' '))).toEqual(['model list', 'node create', 'node show', 'operation status', 'node quote'])
  })

  it('returns a new quote if the price increases between quote and confirmation', async () => {
    const run = await fixture(30)
    await run.plan({ price: 30, confirmPrice: 35 })
    expect(await run.provider.submit(request, run.runtime)).toMatchObject({ state: 'awaiting-approval', approval: { credits: 35 } })
    expect(run.checkpoint().data.phase).toBe('saved')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    expect((await run.calls()).filter(args => args[1] === 'run')).toEqual([])
  })

  it.each([true, false])('requires the server resubmittable decision for awaiting_confirmation recovery (%s)', async (resubmittable) => {
    const run = await fixture()
    await run.provider.submit(request, run.runtime)
    await run.runtime.checkpoint({ ...run.checkpoint(), data: { ...run.checkpoint().data, phase: 'submitting' } })
    const submitId = run.checkpoint().data.submitId
    await run.plan({ price: 30, awaitingConfirmation: true, resubmittable })
    expect((await run.provider.approve(request, run.checkpoint(), 30, run.runtime)).state).toBe(resubmittable ? 'completed' : 'submission-unknown')
    expect(await run.state()).toMatchObject({ creates: 1, runs: resubmittable ? 1 : 0 })
    if (resubmittable) {
      expect((await run.provider.approve(request, run.checkpoint(), 30, run.runtime)).state).toBe('completed')
      expect(await run.state()).toMatchObject({ runs: 1, submitId })
    }
  })

  it('preserves an unquotable saved draft without interpreting a missing price as free', async () => {
    const run = await fixture(30)
    await run.plan({ price: 30, invalidQuote: true })
    expect((await run.provider.submit(request, run.runtime)).state).toBe('submission-unknown')
    expect(run.checkpoint().data.phase).toBe('saved')
    expect((await run.calls()).filter(args => args[1] === 'confirm' || args[1] === 'run')).toEqual([])
    await run.plan({ price: 30 })
    expect((await run.provider.reconcile(request, run.checkpoint(), run.runtime)).state).toBe('awaiting-approval')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
  })

  it('does not resubmit an ambiguous persisted submitting phase even when the service reports absent', async () => {
    const run = await fixture()
    await run.provider.submit(request, run.runtime)
    await run.runtime.checkpoint({ ...run.checkpoint(), data: { ...run.checkpoint().data, phase: 'submitting' } })
    expect((await run.provider.approve(request, run.checkpoint(), 30, run.runtime)).state).toBe('submission-unknown')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    expect((await run.calls()).filter(args => args[1] === 'confirm')).toEqual([])
  })

  it('reconciles a saved draft by quoting only and treats an explicit zero ceiling as free-only', async () => {
    const run = await fixture(0)
    expect((await run.provider.submit(request, run.runtime)).state).toBe('awaiting-approval')
    expect((await run.provider.reconcile(request, run.checkpoint(), run.runtime)).state).toBe('awaiting-approval')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 0 })
    await run.plan({ price: 0 })
    expect((await run.provider.approve(request, run.checkpoint(), 0, run.runtime)).state).toBe('completed')
    expect(await run.state()).toMatchObject({ creates: 1, runs: 1 })
  })
})
