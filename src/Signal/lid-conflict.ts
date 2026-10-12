/**
 * WA Web parity (PR3, LOG ONLY): createLidPnMappings conflict classification.
 * WAWebDBCreateLidPnMappings function R (b06.js ~@382408): called for a mapping whose LID has a cached PN that
 * differs from the new PN. WA logs and (for two classes) returns early. Writes are NOT affected by this module.
 */

/** WA Web WAWebWidDevTools.isWidClientAssigned (b06.js ~@379990): LID user with bit 16 (65536) set. */
export const isClientAssignedLidUser = (lidUser: string | undefined): boolean => {
	if (lidUser == null) {
		return false
	}

	const n = parseInt(lidUser, 10)
	return isNaN(n) ? false : (n & 65536) !== 0
}

export type LidPnConflict = { kind: 'pn-is-lid' | 'fake-lid' | 'lid'; logKey: string }

export type LidPnConflictInput = {
	/** WA learningSource; undefined when the call site has no verified WA source. */
	learningSource: string | undefined
	lidUser: string
	pnUser: string
	/** PN user cached for lidUser, or undefined when none is cached. */
	cachedPnUserForLid: string | undefined
	/** True when pnUser is itself a cached LID (WA: getPhoneNumber(createUserLidOrThrow(pn.user)) != null). */
	pnUserIsCachedLid: boolean
}

/**
 * Returns the conflict class WA would log, or undefined when there is no conflict.
 * Precedence follows WA R(): pn-is-lid first, then fake-lid, then the plain lid conflict.
 */
export const classifyLidPnConflict = (input: LidPnConflictInput): LidPnConflict | undefined => {
	if (input.cachedPnUserForLid === undefined || input.cachedPnUserForLid === input.pnUser) {
		return undefined
	}

	const src = input.learningSource ?? 'untagged'
	if (input.pnUserIsCachedLid) {
		return { kind: 'pn-is-lid', logKey: 'lid-pn-mapping-conflict-pn-is-lid' }
	}

	if (isClientAssignedLidUser(input.lidUser)) {
		return { kind: 'fake-lid', logKey: `lid-pn-mapping-conflict-fake-lid-${src}` }
	}

	return { kind: 'lid', logKey: `lid-pn-mapping-conflict-${src}` }
}
