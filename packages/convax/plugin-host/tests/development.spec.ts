/** Convax authoring resources follow the existing optional skill registry lifecycle. */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { expect, it } from 'vitest'
import { registerConvaxDevelopment } from '../src/development.ts'

it('registers the packaged skill globally and removes only its provider on unload', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SkillRegistry)
    const skills = ctx.skills
    skills.register({ name: 'another-skill', description: 'Independent provider', source: 'runtime', content: 'Keep this skill.' })
    const owner = ctx.plugin({ apply: registerConvaxDevelopment })
    await owner
    const skill = await skills.get('convax-plugin-development')
    expect(skill).toMatchObject({ provider: 'convax-development', source: 'bundled', resourceBase: { kind: 'directory' } })
    expect(skill?.content).toContain('../../templates/canvas-note/')
    await owner.dispose()
    expect((await ctx.skills.get('another-skill'))?.content).toBe('Keep this skill.')
    expect(await skills.get('convax-plugin-development')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})

it('does not require the skill registry and follows its later availability', async () => {
  const ctx = new Context()
  try {
    const owner = ctx.plugin({ apply: registerConvaxDevelopment })
    await owner
    expect(ctx.get('skills')).toBeUndefined()
    const registry = ctx.plugin(SkillRegistry)
    await registry
    await expect.poll(async () => (await ctx.skills.get('convax-plugin-development'))?.provider).toBe('convax-development')
    await registry.dispose()
    expect(ctx.get('skills')).toBeUndefined()
    await ctx.plugin(SkillRegistry)
    await expect.poll(async () => (await ctx.skills.get('convax-plugin-development'))?.provider).toBe('convax-development')
    await owner.dispose()
    expect(await ctx.skills.get('convax-plugin-development')).toBeUndefined()
  } finally { await ctx.fiber.dispose() }
})
