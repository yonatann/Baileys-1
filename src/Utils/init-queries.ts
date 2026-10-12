/**
 * WA Web parity (B7): connection-open init queries.
 *
 * WA Web does NOT refetch AB props / blocklist / privacy on every socket open:
 *  - AB props: persisted `{abKey, hash, refresh, lastSyncTime}`; the hash is sent on later syncs and the
 *    sync is a scheduled task whose period is the server `refresh` attr, clamped [600s, 604800s],
 *    default 86400s (b06@4249442 WAWebABPropsLocalStorage; b06@1787788 WAWebAbPropsSyncJob; b06@2465540).
 *  - blocklist: fetched at pairing bootstrap (b07@323919), then only on account_sync notification
 *    (b07@501014) / dirty-bit (b12@3627025), conditional on a persisted dhash (b07@289468; the fork sends none).
 *  - privacy: fetched at pairing bootstrap (b07@330914), then only on account_sync notification
 *    (b07@499300 forceUpdatePrivacySettings) / dirty-bit (b12@3626909).
 *  - dirty-bit wire shape (b12@1604229 parser): `<ib><dirty type="account_sync" timestamp=..><privacy/><blocklist/>..</dirty></ib>`;
 *    the protocols are the CHILD TAGS of an account_sync dirty node (SUPPORTED_DIRTY_PROTOCOLS, b12@1598771:
 *    devices/picture/privacy/blocklist/notice). The fork wires privacy + blocklist only.
 */
export const AB_PROPS_DEFAULT_REFRESH_SEC = 86400
const AB_PROPS_MIN_REFRESH_SEC = 600
const AB_PROPS_MAX_REFRESH_SEC = 604800

export const clampAbPropsRefreshSec = (raw: string | number | undefined | null): number => {
	const n = typeof raw === 'number' ? raw : parseInt(String(raw ?? ''), 10)
	if (!Number.isFinite(n) || n <= 0) {
		return AB_PROPS_DEFAULT_REFRESH_SEC
	}

	return Math.min(AB_PROPS_MAX_REFRESH_SEC, Math.max(AB_PROPS_MIN_REFRESH_SEC, n))
}

export type InitQueryCreds = {
	lastPropHash?: string
	abPropsSyncedAt?: number
	abPropsRefreshSec?: number
	blocklistSyncedAt?: number
	privacySyncedAt?: number
}

export const planInitQueries = (creds: InitQueryCreds, now: number) => {
	const syncedAt = creds.abPropsSyncedAt
	const refreshMs = clampAbPropsRefreshSec(creds.abPropsRefreshSec) * 1000
	const propsDue = !creds.lastPropHash || syncedAt === undefined || syncedAt > now || now - syncedAt >= refreshMs
	return {
		props: propsDue,
		blocklist: creds.blocklistSyncedAt === undefined,
		privacy: creds.privacySyncedAt === undefined
	}
}

export type DirtyProtocolHandlers = {
	fetchPrivacy: (force?: boolean) => Promise<unknown>
	fetchBlocklist: () => Promise<unknown>
}

/** WA Web WAWebHandleDirtyBits protocol handler (b12@3626909/3627025): privacy -> forced refetch, blocklist -> refetch. */
export const dispatchAccountSyncDirtyProtocols = async (
	protocols: string[],
	handlers: DirtyProtocolHandlers,
	onError?: (protocol: string, error: unknown) => void
) => {
	const jobs: Promise<unknown>[] = []
	const run = (name: string, fn: () => Promise<unknown>) =>
		jobs.push(
			Promise.resolve()
				.then(fn)
				.catch(error => onError?.(name, error))
		)
	if (protocols.includes('privacy')) {
		run('privacy', () => handlers.fetchPrivacy(true))
	}

	if (protocols.includes('blocklist')) {
		run('blocklist', () => handlers.fetchBlocklist())
	}

	await Promise.all(jobs)
}
