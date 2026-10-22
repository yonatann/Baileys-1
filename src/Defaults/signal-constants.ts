// Leaf constants for the Signal / ADV identity code paths.
// Kept import-free on purpose: `Defaults/index.ts` pulls in the libsignal repository and the
// pino logger at module scope, so `Utils/crypto` + `Utils/signal` must not reach it just for a
// one-byte prefix — the SendCore browser bundle (WA Web adapter) would otherwise drag the whole
// Signal tree in. `Defaults/index.ts` re-exports these, so every existing import keeps working.

export const WA_ADV_ACCOUNT_SIG_PREFIX = Buffer.from([6, 0])
export const WA_ADV_DEVICE_SIG_PREFIX = Buffer.from([6, 1])
export const WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX = Buffer.from([6, 5])
export const WA_ADV_HOSTED_DEVICE_SIG_PREFIX = Buffer.from([6, 6])

export const KEY_BUNDLE_TYPE = Buffer.from([5])
