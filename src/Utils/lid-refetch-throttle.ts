import type NodeCache from '@cacheable/node-cache'

/**
 * Default per-LID cooldown (seconds) for the identity force-refetch throttle.
 *
 * A real identity CHANGE is handled separately (see `identity-change-handler.ts`, which
 * force-refetches on an `identity` notification, debounced 5s), so this longer window only
 * collapses repeated "new LID mapping discovered" force-refetches for the SAME LID during
 * multi-device / large-group churn. It does not mask a genuine identity change.
 */
export const DEFAULT_LID_REFETCH_THROTTLE_SEC = 300

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
export function selectLidsForForceRefetch(lids: string[], throttleCache: NodeCache<boolean>): LidRefetchSelection {
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
