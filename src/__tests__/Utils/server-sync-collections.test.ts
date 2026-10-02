import { collectServerSyncCollectionNames } from '../../Utils/server-sync-collections'
import { type BinaryNode } from '../../WABinary'

function serverSyncNode(names: string[]): BinaryNode {
	return {
		tag: 'notification',
		attrs: { type: 'server_sync' },
		content: names.map(name => ({
			tag: 'collection',
			attrs: { name, version: '1' },
			content: undefined
		}))
	}
}

describe('server_sync collection extraction (D2 / BE#662)', () => {
	it('returns ALL collection names, not just the first', () => {
		const node = serverSyncNode(['critical_block', 'regular_high', 'regular_low'])
		expect(collectServerSyncCollectionNames(node)).toEqual([
			'critical_block',
			'regular_high',
			'regular_low'
		])
	})

	it('returns the single collection name when only one is present', () => {
		const node = serverSyncNode(['critical_unblock_low'])
		expect(collectServerSyncCollectionNames(node)).toEqual(['critical_unblock_low'])
	})

	it('returns an empty array when there are no collection children', () => {
		const node: BinaryNode = { tag: 'notification', attrs: { type: 'server_sync' }, content: undefined }
		expect(collectServerSyncCollectionNames(node)).toEqual([])
	})

	it('dedups repeated collection names preserving first-seen order', () => {
		const node = serverSyncNode(['critical_block', 'regular', 'critical_block'])
		expect(collectServerSyncCollectionNames(node)).toEqual(['critical_block', 'regular'])
	})

	it('filters out unknown collection names not in ALL_WA_PATCH_NAMES', () => {
		// WA Web drops names that fail CollectionName.cast; an unknown name left in the
		// resync list makes resyncAppState loop forever (the server omits it from the response).
		const node = serverSyncNode(['critical_block', 'bogus_collection', 'regular'])
		expect(collectServerSyncCollectionNames(node)).toEqual(['critical_block', 'regular'])
	})

	it('returns empty when every collection name is unknown', () => {
		const node = serverSyncNode(['nope', 'also_nope'])
		expect(collectServerSyncCollectionNames(node)).toEqual([])
	})

	it('skips collection children with a missing name attr', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: { type: 'server_sync' },
			content: [
				{ tag: 'collection', attrs: { version: '1' }, content: undefined },
				{ tag: 'collection', attrs: { name: 'regular', version: '1' }, content: undefined }
			]
		}
		expect(collectServerSyncCollectionNames(node)).toEqual(['regular'])
	})
})
