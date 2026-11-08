// Nest skips optional transports when their module exports are undefined.
// Empty classes would be instantiated and require transport-only methods.
export const MicroservicesModule = undefined
export const SocketModule = undefined
