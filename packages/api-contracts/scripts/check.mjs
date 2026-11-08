import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import Ajv2020 from 'ajv/dist/2020.js'

const root = new URL('../', import.meta.url)
const readJson = async path => JSON.parse(await readFile(new URL(path, root), 'utf8'))
const document = await readJson('openapi/convax.openapi.json')
assert.equal(document.openapi, '3.1.0')
const validator = new Ajv2020({ strict: true })
validator.addFormat('date-time', value => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && Number.isFinite(Date.parse(value)))
const schemas = await Promise.all((await readdir(new URL('schemas/', root)))
  .filter(name => name.endsWith('.json')).map(name => readJson(`schemas/${name}`)))
for (const schema of schemas) validator.addSchema(schema)
for (const schema of schemas) validator.getSchema(schema.$id)
const ids = new Set()
for (const [path, methods] of Object.entries(document.paths)) {
  assert.ok(path.startsWith('/'), 'HTTP paths are absolute')
  for (const operation of Object.values(methods)) {
    assert.ok(operation.operationId && !ids.has(operation.operationId), 'operationId is required and unique')
    ids.add(operation.operationId)
    for (const response of Object.values(operation.responses)) {
      const reference = response.content['application/json'].schema.$ref
      assert.match(reference, /^\.\.\/schemas\/[\w-]+\.json$/u)
      const schema = await readJson(`openapi/${reference}`)
      assert.ok(validator.getSchema(schema.$id), `Response schema resolves: ${reference}`)
    }
  }
}
console.log(`Validated ${ids.size} Convax API operation and referenced JSON schemas`)
