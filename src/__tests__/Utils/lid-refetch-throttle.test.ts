import NodeCache from '@cacheable/node-cache'
import { selectLidsForForceRefetch } from '../../Utils/lid-refetch-throttle'

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
