import { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { GenerationCapability, JsonObject, MediaKind, ProviderRequest } from '../types.ts'
import { objectSchema, record, string } from './common.ts'

export interface JimengVoice { id?: string; name: string }
export const JIMENG_FLAGS: Record<MediaKind, readonly string[]> = {
  image: ['ratio', 'resolution', 'count'],
  video: ['ratio', 'resolution', 'count', 'duration'],
  audio: ['duration', 'scenario', 'voice-id', 'voice-name'],
}
const MODES: Record<MediaKind, readonly string[]> = {
  image: ['t2i', 'i2i'], video: ['t2v', 'first_last_frame', 'm2v'], audio: ['tts', 'music'],
}
interface ReferenceRule {
  min: number
  max: number
  types: { kind: MediaKind; min: number; max: number }[]
  requireAnyOfTypes: string[]
  mutuallyExclusiveTypes: string[]
}
interface Mode {
  name: string
  scenario?: string
  flags: Record<string, unknown>[]
  schemas: JsonObject[]
  references: ReferenceRule
}

function bound(value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Jimeng returned an invalid model limit')
  return value
}

function property(name: string, flag: Record<string, unknown>): JsonObject {
  const numeric = name === 'count' || name === 'duration'
  const result: JsonObject = { type: name === 'count' ? 'integer' : numeric ? 'number' : 'string' }
  if (Array.isArray(flag.values) && flag.values.length) {
    const values = flag.values.map(value => numeric ? Number(value) : string(value, 'model flag value'))
    if (values.some(value => typeof value === 'number' && !Number.isFinite(value))) throw new Error('Jimeng returned an invalid flag value')
    result.enum = values
  } else if (numeric && typeof flag.min === 'number' && typeof flag.max === 'number') {
    const step = bound(flag.step, name === 'count' ? 1 : 0)
    const span = flag.max - flag.min
    if (step > 0 && span >= 0 && span / step <= 1000) {
      result.enum = Array.from({ length: Math.floor(span / step) + 1 },
        (_, index) => Number((Number(flag.min) + index * step).toPrecision(12)))
    }
  }
  const limits = ['min', 'max', 'step', 'minLength', 'maxLength'].flatMap(key =>
    typeof flag[key] === 'number' ? [`${key}=${flag[key]}`] : [])
  if (limits.length) result.description = `Current model limits: ${limits.join(', ')}. Enforced again before saving.`
  return result
}

function references(kind: MediaKind, name: string, scenario: string | undefined, value: unknown): ReferenceRule {
  const empty: ReferenceRule = { min: 0, max: 0, types: [], requireAnyOfTypes: [], mutuallyExclusiveTypes: [] }
  if (name === 't2v' || kind === 'audio' && scenario !== 'omni-dubbing') return empty
  if (name === 't2i' && value === undefined) return empty
  const raw = value === undefined ? {} : record(value)
  const rule: ReferenceRule = {
    min: bound(raw.min, name === 'i2i' || name === 'first_last_frame' || name === 'm2v' ? 1 : 0),
    max: bound(raw.max, name === 'first_last_frame' ? 2 : 0),
    types: (Array.isArray(raw.types) ? raw.types : []).map((value) => {
      const type = record(value)
      if (type.mediaType !== 'image' && type.mediaType !== 'video' && type.mediaType !== 'audio') throw new Error('Jimeng returned an unknown reference type')
      return { kind: type.mediaType, min: bound(type.min, 0), max: bound(type.max, 0) }
    }),
    requireAnyOfTypes: Array.isArray(raw.requireAnyOfTypes) ? raw.requireAnyOfTypes.map(value => string(value, 'reference type')) : [],
    mutuallyExclusiveTypes: Array.isArray(raw.mutuallyExclusiveTypes) ? raw.mutuallyExclusiveTypes.map(value => string(value, 'reference type')) : [],
  }
  if (name === 'first_last_frame') {
    rule.min = Math.max(1, rule.min)
    rule.max = Math.min(2, rule.max)
    rule.types = [{ kind: 'image', min: rule.min, max: rule.max }]
  }
  if (rule.max < rule.min || rule.max > 0 && !rule.types.length) throw new Error('Jimeng returned incomplete reference limits')
  return rule
}

function voiceProperty(voices: readonly JimengVoice[], field: 'id' | 'name'): JsonObject | undefined {
  const identitiesByName = new Map<string, Set<string>>()
  for (const [index, voice] of voices.entries()) {
    const identities = identitiesByName.get(voice.name) ?? new Set<string>()
    identities.add(voice.id ?? `missing-id:${index}`)
    identitiesByName.set(voice.name, identities)
  }
  const values = [...new Map(voices.flatMap((voice) => {
    // The official catalog can reuse a display name for several distinct voices.
    // A repeated page row with the same ID remains unambiguous; a shared name does not.
    if (field === 'name' && identitiesByName.get(voice.name)?.size !== 1) return []
    const value = voice[field]
    return value === undefined ? [] : [[value, { type: 'string', const: value, title: voice.name }] as const]
  })).values()]
  if (!values.length) return undefined
  return { ...(values.length === 1 ? values[0] : { oneOf: values }),
    description: field === 'id' ? 'Preferred: use the stable voice ID from this model catalog.'
      : 'Only names that identify exactly one catalog voice are accepted; prefer voice-id.' }
}

function modes(kind: MediaKind, model: Record<string, unknown>, voices: readonly JimengVoice[]): Mode[] {
  if (!Array.isArray(model.modes)) throw new Error('Jimeng model has no generation modes')
  const result: Mode[] = []
  for (const value of model.modes) {
    const raw = record(value)
    const name = string(raw.name, 'generation mode')
    if (!MODES[kind].includes(name)) continue
    const flags: (Record<string, unknown> & { flag: string })[] = (Array.isArray(raw.flags) ? raw.flags : []).map(record)
      .map(flag => ({ ...flag, flag: string(flag.flag, 'flag').replace(/^--/, '') }))
    const handled = ['mode', 'model', 'prompt', 'ref', ...JIMENG_FLAGS[kind]]
    if (flags.some(flag => flag.required === true && !handled.includes(flag.flag))) continue
    const scenario = raw.scenario === undefined ? undefined : string(raw.scenario, 'audio scenario')
    if (scenario !== undefined && (kind !== 'audio' || name !== 'tts' || !['text-reading', 'omni-dubbing'].includes(scenario))) continue
    const properties: JsonObject = { mode: { type: 'string', const: name } }
    const required = ['mode']
    for (const flag of flags) {
      if (!JIMENG_FLAGS[kind].includes(flag.flag) || flag.flag === 'voice-id' || flag.flag === 'voice-name') continue
      properties[flag.flag] = property(flag.flag, flag)
      const values = Array.isArray(flag.values) ? flag.values.map(Number) : undefined
      if (flag.required === true || flag.flag === 'count' && (bound(flag.min, 1) > 1 || values !== undefined && !values.includes(1))) required.push(flag.flag)
    }
    if (scenario !== undefined) { properties.scenario = { type: 'string', const: scenario }; if (!required.includes('scenario')) required.push('scenario') }
    const referenceRule = references(kind, name, scenario, raw.references)
    const description = name === 'first_last_frame' ? 'References: one first-frame image, or two images in first-frame then last-frame order.'
      : `References: ${referenceRule.min}–${referenceRule.max}; ${referenceRule.types.map(type => `${type.kind} ${type.min}–${type.max}`).join(', ') || 'none'}.`
    const schemas: JsonObject[] = []
    if (kind === 'audio' && name === 'tts') {
      if (scenario === 'omni-dubbing') schemas.push({ ...objectSchema(properties, required), description })
      for (const field of ['id', 'name'] as const) {
        const voice = voiceProperty(voices, field)
        if (voice !== undefined) schemas.push({ ...objectSchema({ ...properties, [`voice-${field}`]: voice },
          [...required, `voice-${field}`]), description })
      }
    } else schemas.push({ ...objectSchema(properties, required), description })
    if (schemas.length) result.push({ name, ...(scenario === undefined ? {} : { scenario }), flags, schemas, references: referenceRule })
  }
  if (!result.length) throw new Error('This Jimeng model has no supported modes or selectable voices; refresh its catalog or choose another model')
  return result
}

export function jimengCapability(
  kind: MediaKind, model: Record<string, unknown>, voices: readonly JimengVoice[] = [],
): GenerationCapability {
  const choices = modes(kind, model, voices)
  // The live catalog lists first_last_frame twice for one-frame and two-frame inputs.
  // Host parameters exclude references, so identical parameter branches must appear only once.
  const unique = new Map<string, JsonObject>()
  for (const schema of choices.flatMap(mode => mode.schemas)) {
    const { description, ...constraints } = schema
    const key = JSON.stringify(constraints)
    const prior = unique.get(key)
    unique.set(key, prior === undefined ? schema : { ...constraints,
      description: [...new Set([string(prior.description, 'reference description'), string(description, 'reference description')])].join(' Or: ') })
  }
  const schemas = [...unique.values()]
  const maxOutputs = kind === 'audio' ? 1 : Math.max(1, ...choices.flatMap(mode => mode.flags.filter(flag => flag.flag === 'count').map(flag =>
    Math.max(bound(flag.max, 1), ...(Array.isArray(flag.values) ? flag.values.map(Number) : [1])))))
  const maxReferences = Math.max(...choices.map(mode => mode.references.max))
  const kinds = [...new Set(choices.flatMap(mode => mode.references.types.filter(type => type.max > 0).map(type => type.kind)))]
  return { kind, modelId: string(model.model, 'model ID'),
    ...(typeof model.displayName === 'string' && model.displayName.trim() ? { modelLabel: model.displayName } : {}),
    maxOutputs, parameterSchema: schemas.length === 1 ? schemas[0] ?? {} : { oneOf: schemas },
    inputs: maxReferences ? [{ role: 'reference', kinds, minItems: 0, maxItems: maxReferences }] : [] }
}

function checkFlag(flag: Record<string, unknown>, value: unknown): void {
  if (value === undefined) return
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || typeof flag.min === 'number' && value < flag.min || typeof flag.max === 'number' && value > flag.max) {
      throw new Error(`Jimeng ${String(flag.flag)} is outside the discovered range`)
    }
    if (typeof flag.step === 'number' && flag.step > 0) {
      const steps = (value - bound(flag.min, 0)) / flag.step
      if (Math.abs(steps - Math.round(steps)) > 1e-8) throw new Error(`Jimeng ${String(flag.flag)} does not match the discovered step`)
    }
  } else if (typeof value === 'string' && (typeof flag.minLength === 'number' && value.length < flag.minLength
    || typeof flag.maxLength === 'number' && value.length > flag.maxLength)) throw new Error(`Jimeng ${String(flag.flag)} has an unsupported length`)
}

/** Mode-dependent reference limits cannot be expressed by the Host's union input slots. */
export function validateJimengRequest(request: ProviderRequest, model: Record<string, unknown>, voices: readonly JimengVoice[] = []): void {
  const choices = modes(request.kind, model, voices)
  const matching = choices.filter(mode => mode.schemas.some(schema => validateJsonSchemaValue(schema, request.parameters).length === 0))
  if (!matching.length) throw new Error('Jimeng generation parameters do not match the current model; use creation_describe again')
  const errors: string[] = []
  for (const selected of matching) {
    try {
      for (const flag of selected.flags) checkFlag(flag, flag.flag === 'prompt' ? request.prompt : request.parameters[String(flag.flag)])
      checkReferences(request, selected)
      return
    } catch (error) { errors.push(error instanceof Error ? error.message : 'Invalid Jimeng reference selection') }
  }
  throw new Error([...new Set(errors)].join('; '))
}

function checkReferences(request: ProviderRequest, selected: Mode): void {
  const refs = request.references.map((reference) => {
    if (reference.role !== 'reference') throw new Error('Jimeng inputs use the reference role')
    return reference.kind
  })
  if (selected.scenario === 'omni-dubbing' && (request.parameters['voice-id'] !== undefined || request.parameters['voice-name'] !== undefined)) refs.push('audio')
  const rule = selected.references
  if (refs.length < rule.min || refs.length > rule.max) throw new Error(`Jimeng ${selected.name} requires ${rule.min}–${rule.max} references`)
  for (const kind of refs) if (!rule.types.some(type => type.kind === kind && type.max > 0)) throw new Error(`Jimeng ${selected.name} does not accept ${kind} references`)
  for (const type of rule.types) {
    const count = refs.filter(kind => kind === type.kind).length
    if (count < type.min || count > type.max) throw new Error(`Jimeng ${selected.name} requires ${type.min}–${type.max} ${type.kind} references`)
  }
  if (rule.requireAnyOfTypes.length && !refs.some(kind => rule.requireAnyOfTypes.includes(kind))) throw new Error('Jimeng requires a reference of the discovered media types')
  if (rule.mutuallyExclusiveTypes.filter(kind => refs.includes(kind as MediaKind)).length > 1) throw new Error('Jimeng does not allow these reference types together')
}
