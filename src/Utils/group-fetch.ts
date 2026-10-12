import type { GroupMetadata } from '../Types'

/**
 * Coalesce concurrent callers of an idempotent refresh. A caller arriving while a run is in
 * flight must NOT just join it — the in-flight request was issued before whatever the caller is
 * reacting to (e.g. `dirty type=groups` then `cleanDirtyBits`), so joining could lose that
 * change. Instead all mid-flight callers share ONE trailing run that starts after the current one
 * settles (success or failure). A lone call runs once.
 */
export const coalesceInflight = <T>(fn: () => Promise<T>): (() => Promise<T>) => {
	let current: Promise<T> | undefined
	let trailing: Promise<T> | undefined
	const start = (): Promise<T> => {
		const p: Promise<T> = fn().finally(() => {
			if (current === p) {
				current = undefined
			}
		})
		current = p
		return p
	}

	return () => {
		if (!current) {
			return start()
		}

		if (!trailing) {
			trailing = current
				.catch(() => undefined)
				.then(() => {
					trailing = undefined
					return start()
				})
		}

		return trailing
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
			const full = await fetchOne(g.id)
			// WA Web keeps only `truncated == null` results of the by-id re-query
			if (!full.truncated) {
				out.push(full)
			}
		} catch (err) {
			onError?.(g.id, err)
		}
	}

	return out
}
