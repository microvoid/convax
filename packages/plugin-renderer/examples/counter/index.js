/** Counter node provider; importing the bundle does not enable the Convax product. */
export const name = 'convax-counter-example'

/**
 * Register the example only while the Convax Host is available.
 * @param {import('@deepseek-ai/cordis').Context} ctx - Owning plugin context.
 */
export function apply(ctx) {
  ctx.inject(['convax'], (scope) => {
    scope.effect(() => scope.convax.registerNodeType({
      id: 'example.convax.counter',
      dataVersion: 1,
      description: 'An editable integer counter.',
      dataSchema: { type: 'object', required: ['value'], properties: {
        value: { type: 'integer', minimum: Number.MIN_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
      }, additionalProperties: false },
      ports: [],
      parse(data) {
        if (!Number.isSafeInteger(data.value)) throw new Error('Counter value must be a safe integer')
        return { value: data.value }
      },
    }))
  })
}
