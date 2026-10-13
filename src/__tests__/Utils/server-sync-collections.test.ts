import { collectServerSyncCollectionNames, selectStaleServerSyncCollections } from '../../Utils/server-sync-collections'
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
		expect(collectServerSyncCollectionNames(node)).toEqual(['critical_block', 'regular_high', 'regular_low'])
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

describe('server_sync version filter (C5 / WA Web parity)', () => {
	// WA Web b07@1062818 U() -> H() (filter): localV == null -> sync; serverV == null -> sync;
	// localV < serverV -> sync; otherwise skip. b12@1744914 passes the notification version map.
	const versionedNode = (entries: Array<[string, string | undefined]>): BinaryNode => ({
		tag: 'notification',
		attrs: { type: 'server_sync' },
		content: entries.map(([name, version]) => {
			const attrs: Record<string, string> = { name }
			if (version !== undefined) {
				attrs.version = version
			}

			return { tag: 'collection', attrs, content: undefined }
		})
	})

	it('skips collections whose local version is already at or past the server version', () => {
		const node = versionedNode([
			['regular_high', '10'],
			['regular_low', '7'],
			['critical_block', '3']
		])
		const local: Record<string, number> = { regular_high: 10, regular_low: 9, critical_block: 3 }
		expect(selectStaleServerSyncCollections(node, n => local[n])).toEqual([])
	})

	it('resyncs only collections whose server version is strictly newer than local', () => {
		const node = versionedNode([
			['regular_high', '11'],
			['regular_low', '7'],
			['critical_block', '4']
		])
		const local: Record<string, number> = { regular_high: 10, regular_low: 9, critical_block: 3 }
		expect(selectStaleServerSyncCollections(node, n => local[n])).toEqual(['regular_high', 'critical_block'])
	})

	it('resyncs a collection with no local state (WA Web: localV undefined -> sync)', () => {
		const node = versionedNode([['regular', '1']])
		expect(selectStaleServerSyncCollections(node, () => undefined)).toEqual(['regular'])
	})

	it('resyncs a collection whose notification carries no version (WA Web: serverV undefined -> sync)', () => {
		const node = versionedNode([['regular', undefined]])
		expect(selectStaleServerSyncCollections(node, () => 5)).toEqual(['regular'])
	})

	it('resyncs a collection whose version attr is empty or non-numeric (not parsed as 0)', () => {
		const node = versionedNode([
			['regular', ''],
			['regular_high', 'abc'],
			['regular_low', '   ']
		])
		expect(selectStaleServerSyncCollections(node, () => 5)).toEqual(['regular', 'regular_high', 'regular_low'])
	})

	it('still drops unknown collection names', () => {
		const node = versionedNode([
			['bogus', '9'],
			['regular', '2']
		])
		expect(selectStaleServerSyncCollections(node, () => 1)).toEqual(['regular'])
	})
})
