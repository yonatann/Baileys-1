import type { GroupMetadata } from '../Types'

/**
 * Share one in-flight call between concurrent callers (the slot clears on settle,
 * success or failure). Used for the fetch-all-participating-groups IQ: the
 * connect-time seed and the `dirty type=groups` handler both fire right after
 * login and would otherwise each send the same IQ.
 */
export const coalesceInflight = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
	let inflight: Promise<T> | undefined
	return () => {
		if (!inflight) {
			inflight = fn().finally(() => {
				inflight = undefined
			})
		}

		return inflight
	}
}

/**
 * WA Web parity (B8; WAWebGroupQueryJob: GetParticipatingGroups returns
 * `<group id truncated="true" size=N/>` for big groups, whose participants are then
 * re-queried by id — WAWebQueryAndUpdateGroupMetadataJob). A truncated record carries NO
 * participant list: surfacing it as-is would hand consumers (group-send encryption) an
 * empty participant list. Re-fetch each one (sequentially) and drop any that fails —
 * absent is safe (callers fall back to a live per-group query), empty is not.
 */
export const resolveTruncatedGroups = async (
	groups: GroupMetadata[],
	fetchOne: (jid: string) => Promise<GroupMetadata>,
	onError?: (jid: string, err: unknown) => void
): Promise<GroupMetadata[]> => {
	const out: GroupMetadata[] = []
	for (const g of groups) {
		if (!g.truncated) {
			out.push(g)
			continue
		}

		try {
			out.push(await fetchOne(g.id))
		} catch (err) {
			onError?.(g.id, err)
		}
	}

	return out
}
