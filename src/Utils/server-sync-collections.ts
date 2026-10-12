import { ALL_WA_PATCH_NAMES, type WAPatchName } from '../Types'
import { type BinaryNode, getBinaryNodeChildren } from '../WABinary'

const VALID_PATCH_NAMES = new Set<string>(ALL_WA_PATCH_NAMES)

/**
 * WA Web parity (D2 / BE#662): a `server_sync` notification can carry MULTIPLE
 * `<collection>` children. WA Web's `WAWebHandleServerSyncNotification` resyncs
 * every collection (`mapChildrenWithTag("collection", …)` → `markCollectionsForSync`).
 *
 * The fork previously read only the FIRST collection (`getBinaryNodeChild`), leaving
 * every subsequent changed collection un-resynced and the app-state drifting
 * (e.g. `critical_block` / `critical_unblock_low` lagging the server).
 *
 * This returns ALL collection names (deduped, first-seen order) so the caller can
 * resync them in one `resyncAppState` call.
 */
export function collectServerSyncCollectionNames(node: BinaryNode): WAPatchName[] {
	const seen = new Set<string>()
	const names: WAPatchName[] = []
	for (const collection of getBinaryNodeChildren(node, 'collection')) {
		const name = collection.attrs.name
		// Drop unknown names (WA Web's CollectionName.cast): an unknown collection left in the
		// resync list is never returned by the server, so resyncAppState would re-query forever.
		if (!name || seen.has(name) || !VALID_PATCH_NAMES.has(name)) {
			continue
		}

		seen.add(name)
		names.push(name as WAPatchName)
	}

	return names
}

/**
 * WA Web parity (C5): WA Web does not resync every collection named in a `server_sync`
 * notification. `WAWebSyncd` U()/H() (b07.js@1062818) keeps a collection only when its
 * local version is missing, the notification carries no server version, or
 * `localV < serverV`; a collection already at/past the server version is skipped.
 *
 * `localVersionOf` returns the locally stored app-state version for a collection
 * (`undefined` when no state is stored). Unknown names are dropped as in
 * {@link collectServerSyncCollectionNames}.
 */
export function selectStaleServerSyncCollections(
	node: BinaryNode,
	localVersionOf: (name: WAPatchName) => number | undefined
): WAPatchName[] {
	const stale: WAPatchName[] = []
	for (const name of collectServerSyncCollectionNames(node)) {
		const collection = getBinaryNodeChildren(node, 'collection').find(c => c.attrs.name === name)
		const serverVersion = collection?.attrs.version === undefined ? undefined : Number(collection.attrs.version)
		const localVersion = localVersionOf(name)

		if (
			localVersion === undefined ||
			serverVersion === undefined ||
			Number.isNaN(serverVersion) ||
			localVersion < serverVersion
		) {
			stale.push(name)
		}
	}

	return stale
}
