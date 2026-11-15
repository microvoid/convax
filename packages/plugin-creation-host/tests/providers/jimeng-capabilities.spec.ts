import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { jimengCapability, validateJimengRequest } from '../../src/providers/jimeng-capabilities.ts'
import type { MediaKind, ProviderRequest } from '../../src/types.ts'

const voices = [{ id: '12345', name: 'Calm narrator' }, { id: '98765432101234567', name: 'Bright narrator' }]
const captured = JSON.parse(readFileSync(new URL('./fixtures/jimeng-models-1.3.0.json', import.meta.url), 'utf8')) as {
  models: (Record<string, unknown> & { model: string; type: MediaKind })[]
}
function liveModel(id: string): Record<string, unknown> {
  const model = captured.models.find(model => model.model === id)
  if (model === undefined) throw new Error(`Missing public model fixture: ${id}`)
  return model
}
function request(kind: MediaKind, parameters: ProviderRequest['parameters'], refs: MediaKind[] = []): ProviderRequest {
  return { kind, modelId: 'fixture', prompt: 'A short narration', parameters,
    references: refs.map((kind, index) => ({ kind, role: 'reference', path: `/fixture/${index}`, mimeType: `${kind}/fixture` })) }
}
const video = { model: 'fixture', modes: [
  { name: 't2v', flags: [{ flag: '--duration', required: true, min: 2, max: 10, step: 0.5 }, { flag: '--count', min: 1, max: 2 }] },
  { name: 'first_last_frame', flags: [{ flag: '--duration', values: ['5', '10'] }],
    references: { min: 1, max: 2, types: [{ mediaType: 'image', min: 1, max: 2 }] } },
  { name: 'm2v', flags: [], references: { min: 1, max: 3, types: [
    { mediaType: 'image', min: 0, max: 2 }, { mediaType: 'video', min: 0, max: 1 }, { mediaType: 'audio', min: 0, max: 1 },
  ], requireAnyOfTypes: ['image', 'video'], mutuallyExclusiveTypes: ['video', 'audio'] } },
] }
const audio = { model: 'fixture', modes: [
  { name: 'tts', scenario: 'text-reading', flags: [{ flag: '--scenario', required: true, values: ['text-reading'] }], references: { min: 0, max: 0, types: [] } },
  { name: 'music', flags: [{ flag: '--duration', required: true, min: 10, max: 60, step: 1 }] },
] }

describe('Jimeng live media capabilities', () => {
  it('accepts the current official image, video, speech and music catalog shapes', () => {
    for (const model of captured.models) {
      const capability = jimengCapability(model.type, model, voices)
      expect(() => { assertSupportedJsonSchema(capability.parameterSchema) }).not.toThrow()
    }
  })

  it('deduplicates live first_last_frame parameter branches while accepting either reference count', () => {
    const model = liveModel('seedance_2.5')
    const parameters = { mode: 'first_last_frame', ratio: '16:9', resolution: '480p', duration: 4, count: 1 }
    expect(validateJsonSchemaValue(jimengCapability('video', model).parameterSchema, parameters)).toEqual([])
    for (const refs of [['image'], ['image', 'image']] satisfies MediaKind[][]) {
      expect(() => { validateJimengRequest(request('video', parameters, refs), model) }).not.toThrow()
    }
  })

  it('preserves references that a live text-to-image model explicitly supports', () => {
    const model = liveModel('seedream_4.6')
    expect(() => { validateJimengRequest(request('image', { mode: 't2i', ratio: '1:1', resolution: '2K' }, ['image']), model) }).not.toThrow()
  })

  it('uses CLI voice-id as the documented alternative to the live voice-name flag and enforces prompt length', () => {
    const model = liveModel('seed_audio_v1')
    const input = request('audio', { mode: 'tts', scenario: 'text-reading', 'voice-id': '12345' })
    expect(() => { validateJimengRequest(input, model, voices) }).not.toThrow()
    expect(() => { validateJimengRequest({ ...input, prompt: 'a'.repeat(3001) }, model, voices) }).toThrow('unsupported length')
    expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'omni-dubbing' }), model, voices) }).not.toThrow()
    expect(() => { validateJimengRequest(request('audio', { mode: 'music', duration: 30 }), liveModel('seed_music_1.0')) }).not.toThrow()
  })

  it('uses the Host-supported schema subset and preserves live duration values', () => {
    const capability = jimengCapability('video', video)
    expect(() => { assertSupportedJsonSchema(capability.parameterSchema) }).not.toThrow()
    expect(capability.maxOutputs).toBe(2)
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 't2v', duration: 3.5 })).toEqual([])
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 't2v', duration: 3.25 })).not.toEqual([])
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 't2v' })).not.toEqual([])
  })

  it('rejects references on text-to-video despite the other modes accepting inputs', () => {
    expect(jimengCapability('video', video).inputs).toHaveLength(1)
    expect(() => { validateJimengRequest(request('video', { mode: 't2v', duration: 5 }, ['image']), video) }).toThrow('0–0 references')
  })

  it('accepts one or two ordered image frames and rejects missing, excess or non-image frames', () => {
    for (const refs of [['image'], ['image', 'image']] satisfies MediaKind[][]) {
      expect(() => { validateJimengRequest(request('video', { mode: 'first_last_frame', duration: 5 }, refs), video) }).not.toThrow()
    }
    for (const refs of [[], ['image', 'image', 'image'], ['video'], ['image', 'audio']] satisfies MediaKind[][]) {
      expect(() => { validateJimengRequest(request('video', { mode: 'first_last_frame', duration: 5 }, refs), video) }).toThrow()
    }
  })

  it('enforces discovered per-type, required-any and mutually exclusive multimodal rules', () => {
    expect(() => { validateJimengRequest(request('video', { mode: 'm2v' }, ['image', 'audio']), video) }).not.toThrow()
    for (const refs of [['audio'], ['image', 'audio', 'audio'], ['video', 'audio']] satisfies MediaKind[][]) {
      expect(() => { validateJimengRequest(request('video', { mode: 'm2v' }, refs), video) }).toThrow()
    }
  })

  it('exposes same-model voice IDs and names, without allowing both or accepting a made-up voice', () => {
    const capability = jimengCapability('audio', audio, voices)
    expect(() => { assertSupportedJsonSchema(capability.parameterSchema) }).not.toThrow()
    expect(capability.maxOutputs).toBe(1)
    expect(JSON.stringify(capability.parameterSchema)).toContain('Calm narrator')
    for (const selection of [{ 'voice-id': '98765432101234567' }, { 'voice-name': 'Calm narrator' }]) {
      expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'text-reading', ...selection }), audio, voices) }).not.toThrow()
    }
    for (const selection of [{}, { 'voice-id': 'not-in-catalog' }, { 'voice-id': '12345', 'voice-name': 'Calm narrator' }]) {
      expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'text-reading', ...selection }), audio, voices) }).toThrow()
    }
  })

  it('keeps every stable voice ID while excluding names shared across distinct catalog voices', () => {
    const catalog = [{ id: '12345', name: 'Shared narrator' }, { id: '67890', name: 'Shared narrator' },
      { id: '11111', name: 'Unique narrator' }]
    const capability = jimengCapability('audio', audio, catalog)
    for (const id of ['12345', '67890', '11111']) {
      expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 'tts', scenario: 'text-reading', 'voice-id': id })).toEqual([])
    }
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 'tts', scenario: 'text-reading', 'voice-name': 'Shared narrator' })).not.toEqual([])
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 'tts', scenario: 'text-reading', 'voice-name': 'Unique narrator' })).toEqual([])
    expect(JSON.stringify(capability.parameterSchema)).toContain('Preferred: use the stable voice ID')
  })

  it('deduplicates a repeated page row without making its unique voice name ambiguous', () => {
    const voice = { id: '12345', name: 'Repeated row' }
    const capability = jimengCapability('audio', audio, [voice, voice])
    expect(() => { assertSupportedJsonSchema(capability.parameterSchema) }).not.toThrow()
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 'tts', scenario: 'text-reading', 'voice-id': '12345' })).toEqual([])
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 'tts', scenario: 'text-reading', 'voice-name': 'Repeated row' })).toEqual([])
  })

  it('keeps music single-output and does not accept TTS voice, scenario or count flags', () => {
    expect(() => { validateJimengRequest(request('audio', { mode: 'music', duration: 30 }), audio, voices) }).not.toThrow()
    for (const extra of [{ count: 1 }, { 'voice-id': '12345' }, { scenario: 'text-reading' }]) {
      expect(() => { validateJimengRequest(request('audio', { mode: 'music', duration: 30, ...extra }), audio, voices) }).toThrow()
    }
  })

  it('counts an omni-dubbing voice as an audio reference against the same model limits', () => {
    const model = { model: 'fixture', modes: [{ name: 'tts', scenario: 'omni-dubbing', flags: [],
      references: { min: 1, max: 1, types: [{ mediaType: 'audio', min: 1, max: 1 }] } }] }
    expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'omni-dubbing', 'voice-id': '12345' }), model, voices) }).not.toThrow()
    expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'omni-dubbing' }, ['audio']), model, voices) }).not.toThrow()
    expect(() => { validateJimengRequest(request('audio', { mode: 'tts', scenario: 'omni-dubbing', 'voice-id': '12345' }, ['audio']), model, voices) }).toThrow()
  })

  it('omits an unsupported mode rather than dropping its required flag', () => {
    const model = { model: 'fixture', modes: [{ name: 't2v', flags: [{ flag: '--unimplemented', required: true }] }, video.modes[1]] }
    const capability = jimengCapability('video', model)
    expect(validateJsonSchemaValue(capability.parameterSchema, { mode: 't2v' })).not.toEqual([])
    expect(() => jimengCapability('video', { model: 'fixture', modes: [model.modes[0]] })).toThrow('no supported modes')
  })

  it('enforces continuous bounds and steps even where the Host schema cannot represent them', () => {
    const model = { model: 'fixture', modes: [{ name: 't2v', flags: [{ flag: '--duration', required: true, min: 1, max: 600, step: 0.001 }] }] }
    expect(() => { validateJimengRequest(request('video', { mode: 't2v', duration: 2.001 }), model) }).not.toThrow()
    for (const duration of [0.9, 600.01, 2.0001]) expect(() => { validateJimengRequest(request('video', { mode: 't2v', duration }), model) }).toThrow()
  })
})
import { readFileSync } from 'node:fs'
