/**
 * Default per-LID cooldown (seconds) for the identity force-refetch throttle.
 *
 * A real identity CHANGE is handled separately (see `identity-change-handler.ts`, which
 * force-refetches on an `identity` notification, debounced 5s), so this longer window only
 * collapses repeated "new LID mapping discovered" force-refetches for the SAME LID during
 * multi-device / large-group churn. It does not mask a genuine identity change.
 */
export const DEFAULT_LID_REFETCH_THROTTLE_SEC = 300

/**
 * The only two operations the throttle needs from its backing store. Structural on purpose:
 * the Baileys socket still passes a `NodeCache<boolean>` (which satisfies this), while the
 * WA Web adapter passes `createTtlThrottleStore` so the extension bundle does not have to
 * carry `@cacheable/node-cache`.
 */
export type LidRefetchThrottleStore = {
	get(key: string): boolean | undefined
	set(key: string, value: boolean): unknown
}

/** Drop expired entries once the map holds at least this many, so it cannot grow without bound. */
const TTL_STORE_SWEEP_THRESHOLD = 1000

/**
 * Minimal dependency-free TTL store for the throttle: an entry is readable for `ttlSec` seconds
 * after it was last `set`, then reads as missing (same semantics as `NodeCache` with `stdTTL`).
 * `now` is injectable for tests.
 */
export function createTtlThrottleStore(ttlSec: number, now: () => number = Date.now): LidRefetchThrottleStore {
	const expiresAt = new Map<string, number>()
	const ttlMs = ttlSec * 1000

	return {
		get(key) {
			const expiry = expiresAt.get(key)
			if (expiry === undefined) {
				return undefined
			}

			if (expiry <= now()) {
				expiresAt.delete(key)
				return undefined
			}

			return true
		},
		set(key, value) {
			if (!value) {
				expiresAt.delete(key)
				return true
			}

			const t = now()
			if (expiresAt.size >= TTL_STORE_SWEEP_THRESHOLD) {
				for (const [k, expiry] of expiresAt) {
					if (expiry <= t) {
						expiresAt.delete(k)
					}
				}
			}

			expiresAt.set(key, t + ttlMs)
			return true
		}
	}
}

export type LidRefetchSelection = {
	/** LIDs that should be force-refetched now (not seen within the throttle window). */
	toRefetch: string[]
	/** LIDs skipped because they were force-refetched within the throttle window. */
	throttled: string[]
}

/**
 * WA Web parity (D3 / BE#660): WA Web fetches identity keys through a throttled, batched
 * job (`WAWebGetIdentityKeysJob` with pending-queues + throttle). The fork force-refetched
 * identity for EVERY newly-mapped LID with no throttle (`assertSessions(lids, true)`), which
 * under heavy LID-mapping churn produced an identity-fetch storm (repeated `encrypt`/`get-pre-key`
 * IQs with `reason='identity'`) that WhatsApp rate-limits (420/429) — a plausible device_removed
 * contributor.
 *
 * This selects which of `lids` to force-refetch now: a LID is refetched only if it was not
 * force-refetched within the throttle window (tracked in `throttleCache`, TTL = window). Selected
 * LIDs are marked in the cache. Input is deduped; order is preserved.
 */
export function selectLidsForForceRefetch(lids: string[], throttleCache: LidRefetchThrottleStore): LidRefetchSelection {
	const toRefetch: string[] = []
	const throttled: string[] = []
	const seen = new Set<string>()

	for (const lid of lids) {
		if (!lid || seen.has(lid)) {
			continue
		}

		seen.add(lid)

		if (throttleCache.get(lid)) {
			throttled.push(lid)
			continue
		}

		throttleCache.set(lid, true)
		toRefetch.push(lid)
	}

	return { toRefetch, throttled }
}
