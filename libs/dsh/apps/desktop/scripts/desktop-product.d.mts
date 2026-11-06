/** Brand and identity for the opt-in Convax Desktop installer. */
export const CONVAX_DESKTOP_PRODUCT: Readonly<{
  appId: 'io.microvoid.convax'
  name: 'Convax'
  artifactPrefix: 'convax'
  protocol: 'convax'
}>

/** Select the package's product from the build environment, preserving the upstream default. */
export function isConvaxDesktopProduct(environment: NodeJS.ProcessEnv): boolean

/** Read the Convax release version from the workspace manifest. */
export function readConvaxDesktopVersion(): string
