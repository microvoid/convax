/** Browser factory: the example needs no compiler or private renderer import. */
window.__ModuleLoader__.load({
  id: '@local/dsh-convax-counter-example',
  factory(require) {
    const React = require('react')
    const { Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const typeId = 'example.convax.counter'
    const namespace = 'example.convax.counter'
    const frame = {
      boxSizing: 'border-box', padding: 12,
      border: '0.5px solid var(--dsw-alias-border-l2)',
      borderRadius: 'var(--dsw-radius-lg)',
      background: 'var(--dsw-alias-bg-base)', color: 'var(--dsw-alias-label-primary)',
    }

    function Counter({ node, busy, selected, command, remove, labels }) {
      const [saving, setSaving] = React.useState(false)
      const [failed, setFailed] = React.useState(false)
      const mounted = React.useRef(false)
      const latestRevision = React.useRef(node.revision)
      latestRevision.current = node.revision
      React.useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
      React.useEffect(() => { setSaving(false); setFailed(false) }, [node.revision])
      const change = async (delta) => {
        if (busy || saving) return
        const revision = node.revision
        setSaving(true)
        setFailed(false)
        try {
          const saved = await command({
            kind: 'update-node', nodeId: node.id, dataVersion: 1, data: { value: node.data.value + delta },
          })
          if (!mounted.current) return
          if (!saved) { setFailed(true); setSaving(false) }
          // Keep controls disabled until a committed snapshot supplies the successor revision.
          else if (latestRevision.current !== revision) setSaving(false)
        } catch (_saveFailure) {
          if (mounted.current) { setFailed(true); setSaving(false) }
        }
      }
      return h('article', {
        style: { ...frame, width: 280, borderColor: selected ? 'var(--dsw-alias-state-business-primary)' : undefined },
        'data-convax-counter': node.id,
      },
      h('header', { style: { fontWeight: 500 } }, labels.title),
      h('div', { className: 'nodrag nopan nowheel', style: { display: 'flex', alignItems: 'center', gap: 12, marginBlock: 12 } },
        h(Button, { 'aria-label': labels.decrease, 'data-testid': 'convax-example-decrement',
          disabled: busy || saving || !Number.isSafeInteger(node.data.value - 1), onClick: () => { void change(-1) } }, '−'),
        h('output', { 'aria-label': labels.value, 'data-testid': 'convax-example-value',
          style: { flex: 1, textAlign: 'center' } }, String(node.data.value)),
        h(Button, { 'aria-label': labels.increase, 'data-testid': 'convax-example-increment',
          disabled: busy || saving || !Number.isSafeInteger(node.data.value + 1), onClick: () => { void change(1) } }, '+')),
      h(Button, { className: 'nodrag nopan', disabled: busy || saving, onClick: remove }, labels.remove),
      failed ? h('p', { role: 'status' }, labels.saveUnknown) : null)
    }

    function CreateCounter({ t, list, create }) {
      const [workspace, setWorkspace] = React.useState(null)
      const [canvasId, setCanvasId] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [failure, setFailure] = React.useState(null)
      const request = React.useRef(null)
      const mounted = React.useRef(false)
      const adopt = (value) => {
        setWorkspace(value)
        setCanvasId(previous => value.canvases.some(canvas => canvas.id === previous) ? previous : value.canvases[0]?.id ?? '')
        const pending = request.current
        if (pending !== null && value.canvases.some(canvas => canvas.nodes.some(node => node.id === pending.command.node.id))) {
          request.current = null
          setFailure(null)
        }
      }
      const refresh = async () => {
        setBusy(true)
        try {
          const value = await list()
          if (mounted.current) { adopt(value); if (request.current === null) setFailure(null) }
        } catch (_queryFailure) {
          if (mounted.current) setFailure('loadFailed')
        } finally { if (mounted.current) setBusy(false) }
      }
      React.useEffect(() => {
        mounted.current = true
        void refresh()
        return () => { mounted.current = false }
      }, [])
      const add = async () => {
        if (busy) return
        const canvas = workspace?.canvases.find(item => item.id === canvasId)
        if (request.current === null) {
          if (canvas === undefined) return
          request.current = {
            canvasId: canvas.id, expectedRevision: canvas.revision, operationId: crypto.randomUUID(),
            command: { kind: 'add-node', node: {
              id: crypto.randomUUID(), typeId, dataVersion: 1, data: { value: 0 },
              position: { x: 200 + canvas.nodes.length % 3 * 320, y: 160 + Math.floor(canvas.nodes.length / 3) * 180 },
              revision: 0,
            } },
          }
        }
        setBusy(true)
        setFailure(null)
        try {
          const result = await create(request.current)
          if (!mounted.current) return
          request.current = null
          adopt(result.workspace)
          if (!result.ok) setFailure(result.code === 'conflict' ? 'conflict' : 'createFailed')
        } catch (_unknownCreationOutcome) {
          // Retain this exact request for an idempotent retry after a lost response.
          if (mounted.current) setFailure('createUnknown')
        } finally { if (mounted.current) setBusy(false) }
      }
      const canvases = workspace?.canvases ?? []
      return h('details', {
        open: true, 'data-convax-counter-controls': '',
        style: { ...frame, position: 'fixed', right: 12,
          top: 'calc(var(--dsh-frame-top-clearance, 0px) + 60px)',
          width: 280, maxWidth: 'calc(100vw - 24px)', pointerEvents: 'auto' },
      },
      h('summary', { style: { fontWeight: 500, cursor: 'pointer' } }, t('example')),
      h('label', { style: { display: 'block', marginBlock: 8 } }, t('canvas'),
        h('select', { 'aria-label': t('canvas'), 'data-testid': 'convax-example-canvas',
          value: canvasId, disabled: busy || request.current !== null,
          style: { boxSizing: 'border-box', width: '100%', color: 'inherit', background: 'inherit', font: 'inherit' },
          onChange: event => { setCanvasId(event.target.value); setFailure(null) },
        }, canvases.map(canvas => h('option', { key: canvas.id, value: canvas.id }, canvas.title)))),
      canvases.length === 0 && !busy ? h('p', null, t('noCanvas')) : null,
      h('div', { style: { display: 'flex', gap: 8 } },
        h(Button, { disabled: busy, 'data-testid': 'convax-example-refresh', onClick: () => { void refresh() } }, t('refresh')),
        h(Button, { disabled: busy || canvasId === '', 'data-testid': 'convax-example-create',
          onClick: () => { void add() } }, t(request.current === null ? 'create' : 'retryCreate'))),
      failure === null ? null : h('p', { role: 'status' }, t(failure)))
    }

    return {
      inject: ['locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(namespace, {
          en: {
            example: 'Counter example', canvas: 'Target canvas', noCanvas: 'Create a canvas, then refresh this list.',
            refresh: 'Refresh', create: 'Add counter', retryCreate: 'Retry creation',
            title: 'Counter', value: 'Counter value', decrease: 'Decrease', increase: 'Increase', remove: 'Remove reference',
            loadFailed: 'Canvases could not be loaded. Refresh to try again.',
            conflict: 'The canvas changed. Refresh and create again.',
            createFailed: 'The counter was not created. Check that its Host plugin is enabled.',
            createUnknown: 'Creation was not confirmed. Refresh to check, or retry this request.',
            saveUnknown: 'Saving was not confirmed. Check the latest value before trying again.',
          },
          zh: {
            example: '计数器示例', canvas: '目标画布', noCanvas: '请先创建画布，再刷新此列表',
            refresh: '刷新', create: '添加计数器', retryCreate: '重试创建',
            title: '计数器', value: '计数值', decrease: '减少', increase: '增加', remove: '移除引用',
            loadFailed: '无法加载画布，请刷新重试', conflict: '画布已变化，请刷新后重新创建',
            createFailed: '未创建计数器，请检查其 Host 插件是否启用',
            createUnknown: '创建结果尚未确认，请刷新检查，或重试同一请求',
            saveUnknown: '保存结果尚未确认，请检查当前数值后再操作',
          },
        }))
        const t = ctx.locale.bind(namespace)
        ctx.inject(['slots', 'convaxRenderer', 'remote', 'remote.convax'], (scope) => {
          const remote = scope.remote.convax
          const lifetime = new AbortController()
          const pending = new Set()
          const track = (operation) => {
            const job = Promise.resolve().then(() => {
              if (lifetime.signal.aborted) throw lifetime.signal.reason
              return operation()
            })
            pending.add(job)
            void job.then(() => { pending.delete(job) }, () => { pending.delete(job) })
            return job
          }
          scope.effect(() => async () => {
            lifetime.abort(new Error('Counter example was unloaded'))
            await Promise.allSettled([...pending])
          })
          scope.convaxRenderer.registerNodeRenderer(typeId, {
            dataVersion: 1,
            component: props => h(Counter, { ...props, labels: {
              title: t('title'), value: t('value'), decrease: t('decrease'), increase: t('increase'),
              remove: t('remove'), saveUnknown: t('saveUnknown'),
            } }),
          })
          scope.slots.inject('shell.overlay', () => scope.slots.register({
            name: 'shell.overlay', id: 'convax-counter-example', locale: namespace,
            inject: () => ({
              list: () => track(async () => {
                const result = await remote.workspace()
                if (!result.ok) throw result.error
                return result.value
              }),
              create: request => track(async () => {
                const result = await remote.execute(request, lifetime.signal)
                if (!result.ok) throw result.error
                return result.value
              }),
            }),
          }, CreateCounter))
        })
      },
    }
  },
})
