import NodeCache from '@cacheable/node-cache'
import {
	createTtlThrottleStore,
	type LidRefetchThrottleStore,
	selectLidsForForceRefetch
} from '../../Utils/lid-refetch-throttle'

describe('LID identity force-refetch throttle (D3 / BE#660)', () => {
	let cache: NodeCache<boolean>

	beforeEach(() => {
		cache = new NodeCache<boolean>({ stdTTL: 300, useClones: false })
	})

	it('refetches all LIDs on first sighting and marks them throttled', () => {
		const result = selectLidsForForceRefetch(['a@lid', 'b@lid'], cache)
		expect(result.toRefetch).toEqual(['a@lid', 'b@lid'])
		expect(result.throttled).toEqual([])
	})

	it('throttles LIDs already force-refetched within the window', () => {
		selectLidsForForceRefetch(['a@lid', 'b@lid'], cache)
		const result = selectLidsForForceRefetch(['a@lid', 'b@lid'], cache)
		expect(result.toRefetch).toEqual([])
		expect(result.throttled).toEqual(['a@lid', 'b@lid'])
	})

	it('refetches only the newly-seen LIDs, throttling the recently-seen ones', () => {
		selectLidsForForceRefetch(['a@lid'], cache)
		const result = selectLidsForForceRefetch(['a@lid', 'c@lid'], cache)
		expect(result.toRefetch).toEqual(['c@lid'])
		expect(result.throttled).toEqual(['a@lid'])
	})

	it('dedups the input LID list', () => {
		const result = selectLidsForForceRefetch(['a@lid', 'a@lid', 'b@lid'], cache)
		expect(result.toRefetch).toEqual(['a@lid', 'b@lid'])
		expect(result.throttled).toEqual([])
	})

	it('returns empty arrays for an empty input', () => {
		const result = selectLidsForForceRefetch([], cache)
		expect(result.toRefetch).toEqual([])
		expect(result.throttled).toEqual([])
	})

	it('allows a LID to be refetched again once its throttle entry has expired', () => {
		selectLidsForForceRefetch(['a@lid'], cache)
		cache.del('a@lid') // simulate TTL expiry
		const result = selectLidsForForceRefetch(['a@lid'], cache)
		expect(result.toRefetch).toEqual(['a@lid'])
		expect(result.throttled).toEqual([])
	})
})

describe('selectLidsForForceRefetch with a structural store (no NodeCache)', () => {
	it('works against a plain Map-backed store', () => {
		const map = new Map<string, boolean>()
		const store: LidRefetchThrottleStore = {
			get: key => map.get(key),
			set: (key, value) => map.set(key, value)
		}
		expect(selectLidsForForceRefetch(['a@lid', 'b@lid'], store).toRefetch).toEqual(['a@lid', 'b@lid'])
		expect(selectLidsForForceRefetch(['a@lid', 'b@lid'], store).throttled).toEqual(['a@lid', 'b@lid'])
	})
})

describe('createTtlThrottleStore', () => {
	let nowMs: number
	const now = () => nowMs

	beforeEach(() => {
		nowMs = 1_000_000
	})

	it('reads a key as set until the TTL elapses, then as missing', () => {
		const store = createTtlThrottleStore(300, now)
		expect(store.get('a@lid')).toBeUndefined()
		store.set('a@lid', true)
		expect(store.get('a@lid')).toBe(true)
		nowMs += 299_999
		expect(store.get('a@lid')).toBe(true)
		nowMs += 1
		expect(store.get('a@lid')).toBeUndefined()
	})

	it('re-setting a key restarts its TTL', () => {
		const store = createTtlThrottleStore(300, now)
		store.set('a@lid', true)
		nowMs += 200_000
		store.set('a@lid', true)
		nowMs += 200_000
		expect(store.get('a@lid')).toBe(true)
	})

	it('setting false clears the entry', () => {
		const store = createTtlThrottleStore(300, now)
		store.set('a@lid', true)
		store.set('a@lid', false)
		expect(store.get('a@lid')).toBeUndefined()
	})

	it('drives the throttle the same way NodeCache does: throttled inside the window, refetched after it', () => {
		const store = createTtlThrottleStore(300, now)
		expect(selectLidsForForceRefetch(['a@lid'], store).toRefetch).toEqual(['a@lid'])
		expect(selectLidsForForceRefetch(['a@lid'], store).throttled).toEqual(['a@lid'])
		nowMs += 300_000
		const after = selectLidsForForceRefetch(['a@lid'], store)
		expect(after.toRefetch).toEqual(['a@lid'])
		expect(after.throttled).toEqual([])
	})

	it('sweeps expired entries so the map cannot grow without bound', () => {
		const store = createTtlThrottleStore(10, now)
		for (let i = 0; i < 1000; i++) {
			store.set(`${i}@lid`, true)
		}

		nowMs += 11_000
		store.set('fresh@lid', true) // triggers the sweep of the 1000 expired keys
		expect(store.get('0@lid')).toBeUndefined()
		expect(store.get('fresh@lid')).toBe(true)
	})
})
