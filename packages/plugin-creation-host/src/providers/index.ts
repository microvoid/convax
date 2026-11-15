import type { CreationProvider } from '../types.ts'
import { ArkProvider } from './ark.ts'
import type { ProviderDependencies } from './common.ts'
import { JimengProvider } from './jimeng.ts'
import { LibTVProvider } from './libtv.ts'
import { OpenAIProvider } from './openai.ts'

export function createBuiltinProviders(dependencies: ProviderDependencies): CreationProvider[] {
  return [new JimengProvider(dependencies), new LibTVProvider(dependencies),
    new OpenAIProvider(dependencies), new ArkProvider(dependencies)]
}
