/** Brand and identity for the opt-in Convax Desktop installer. */
export const CONVAX_DESKTOP_PRODUCT = Object.freeze({
  appId: 'io.microvoid.convax',
  name: 'Convax',
  artifactPrefix: 'convax',
  protocol: 'convax',
})

/** Select the package's product from the build environment, preserving the upstream default. */
export function isConvaxDesktopProduct(environment) {
  const product = environment.DSH_DESKTOP_PRODUCT
  if (product === undefined) return false
  if (product === 'convax') return true
  throw new Error('desktop package: DSH_DESKTOP_PRODUCT must be convax when set')
}
