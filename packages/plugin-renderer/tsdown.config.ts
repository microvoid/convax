import { clientBundle } from '../../libs/dsh/packages/client/tsdown.client.ts'
export default clientBundle(import.meta.dirname, ['lib/types/index.js'])
