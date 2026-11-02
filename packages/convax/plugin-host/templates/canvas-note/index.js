/** Optional Host provider and explicit creation tool for the canvas-only note example. */
export const inject = ['tools']

function createArguments(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError('Expected note arguments')
  const fields = ['canvasId', 'expectedRevision', 'operationId', 'nodeId', 'text', 'x', 'y']
  if (Object.keys(value).some(key => !fields.includes(key))) throw new TypeError('Unexpected note argument')
  for (const key of ['canvasId', 'operationId', 'nodeId']) {
    if (typeof value[key] !== 'string' || value[key] === '' || value[key] !== value[key].trim()) {
      throw new TypeError(`${key} must be a nonempty identity without surrounding whitespace`)
    }
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) throw new TypeError('Expected a positive canvas revision')
  if (typeof value.text !== 'string') throw new TypeError('Expected note text')
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new TypeError('Expected finite note coordinates')
  return value
}

export function apply(ctx) {
  ctx.inject(['convax'], scope => {
    scope.effect(() => scope.convax.registerNodeType({
      id: 'local.note', dataVersion: 1, ports: [],
      description: 'An editable text note on a canvas.',
      dataSchema: { type: 'object', required: ['text'], properties: { text: { type: 'string' } }, additionalProperties: false },
      parse(data) {
        if (typeof data.text !== 'string') throw new Error('A note requires text')
        return { text: data.text }
      },
    }))
    scope.tools.register({
      name: 'convax_note_create',
      description: 'Create an editable note on an existing Convax canvas. Query canvases first and pass its current revision. This does not send a message or start work.',
      presentCall: () => ({ card: 'generic', title: 'Create canvas note' }),
      parameters: {
        type: 'object', additionalProperties: false,
        required: ['canvasId', 'expectedRevision', 'operationId', 'nodeId', 'text', 'x', 'y'],
        properties: {
          canvasId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 1 },
          operationId: { type: 'string' }, nodeId: { type: 'string' }, text: { type: 'string' },
          x: { type: 'number' }, y: { type: 'number' },
        },
      },
      output: {
        schema: { type: 'object', additionalProperties: false, required: ['nodeId'], properties: {
          nodeId: { type: 'string' },
        } },
        render: (_args, result) => [{ type: 'text', text: JSON.stringify(result) }],
      },
      async execute(input, execution) {
        const args = createArguments(input)
        const result = await scope.convax.execute({
          canvasId: args.canvasId, expectedRevision: args.expectedRevision, operationId: args.operationId,
          command: { kind: 'add-node', node: {
            id: args.nodeId, typeId: 'local.note', dataVersion: 1,
            data: { text: args.text }, position: { x: args.x, y: args.y }, revision: 0,
          } },
        }, execution.signal)
        if (!result.ok) throw new Error(result.message)
        return { nodeId: args.nodeId }
      },
    })
  })
}
