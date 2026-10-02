import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, jidDecode } from '../WABinary'
import type { ILogger } from './logger'

export type AccountSyncReconcileResult = {
	action: 'reconcile'
	/** Bare own user (no device suffix), e.g. `15551230000`. */
	ownUser: string
	/** Bare own LID user, if we have a LID. */
	ownLidUser?: string
	/** Our own device number (from the `me.id` suffix; 0 for the primary). */
	ownDevice: number
	/** Device jids carried by the push (may be empty for a context-only notification). */
	deviceJids: string[]
	/** True when the pushed list contains our own device. Only meaningful when the list is non-empty. */
	ownDevicePresent: boolean
	/** True when the push carried NO device list — a context notification that needs a USync fetch. */
	needsUsync: boolean
}

export type AccountSyncDeviceSyncResult =
	/** No device-list child — caller falls through to disappearing_mode/blocklist handling. */
	| { action: 'no_device_child' }
	/** A device-list child is present but we have no own-user id to reconcile against. */
	| { action: 'skipped_no_me' }
	| AccountSyncReconcileResult

export type AccountSyncContext = {
	meId: string | undefined
	meLid: string | undefined
}

/**
 * WA Web parity (D1 / BE#661): parse a `type=account_sync` notification carrying a `<devices>`
 * (device-list) child. WA Web's `handleAccountSyncNotification` (AccountSyncType.DEVICES,
 * `pretty/008_466b5e8469.js:681`) applies the pushed list locally for BOTH the PN and LID wids and
 * runs a USync ONLY when the list is empty (a context notification). The fork previously ignored the
 * device-list child entirely.
 *
 * This is a pure classifier: it derives the bare own user/LID user (stripping the `me.id` device
 * suffix — the suffix is why passing `me.id` straight to `getUSyncDevices` was a no-op, BE#661 B1),
 * whether our own device is present in the pushed list (the pre-removal signal), and whether a USync
 * is needed (empty list). The I/O is done by `reconcileOwnDevicesOnAccountSync`.
 */
export function extractAccountSyncDeviceSync(node: BinaryNode, ctx: AccountSyncContext): AccountSyncDeviceSyncResult {
	const devicesChild = getBinaryNodeChild(node, 'devices')
	if (!devicesChild) {
		return { action: 'no_device_child' }
	}

	const ownDecoded = ctx.meId ? jidDecode(ctx.meId) : undefined
	if (!ownDecoded?.user) {
		return { action: 'skipped_no_me' }
	}

	const ownUser = ownDecoded.user
	const ownDevice = ownDecoded.device ?? 0
	const ownLidUser = ctx.meLid ? jidDecode(ctx.meLid)?.user : undefined

	const deviceJids = getBinaryNodeChildren(devicesChild, 'device')
		.map(d => d.attrs.jid)
		.filter((jid): jid is string => !!jid)

	const ownDevicePresent = deviceJids.some(jid => {
		const d = jidDecode(jid)
		return d?.user === ownUser && (d?.device ?? 0) === ownDevice
	})

	return {
		action: 'reconcile',
		ownUser,
		ownLidUser,
		ownDevice,
		deviceJids,
		ownDevicePresent,
		needsUsync: deviceJids.length === 0
	}
}

export type AccountSyncReconcileDeps = {
	/** Bare own user jid for the USync fetch — MUST be device-suffix-free, else getUSyncDevices no-ops (BE#661 B1). */
	meIdNormalized: string
	/** Whether the notification arrived during offline draining (skip the USync fetch, like WA Web). */
	offline: boolean
	delCachedUser: (user: string) => unknown
	/** The devices mutex runner. The USync fetch runs OUTSIDE it (BE#661 B2: getUSyncDevices re-takes it). */
	withDevicesLock: <T>(fn: () => Promise<T>) => Promise<T>
	getUSyncDevices: (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) => Promise<unknown>
	logger: ILogger
}

/**
 * Reconcile the account's own device list from an account_sync device-list push (D1 / BE#661).
 *
 * - Drops the cached own-device entries for BOTH the PN and LID users, under the devices lock.
 * - Runs a USync ONLY when the push carried no device list (context notification) and not offline —
 *   and OUTSIDE the devices lock, because `getUSyncDevices` re-takes that (non-reentrant) lock (B2).
 * - WARNs when our own device is absent from a NON-empty pushed list (the pre-`device_removed`
 *   signal). WA Web does not self-logout here; the 401 is server-driven. Log only.
 */
export async function reconcileOwnDevicesOnAccountSync(
	result: AccountSyncReconcileResult,
	deps: AccountSyncReconcileDeps
): Promise<{ warnedOwnAbsent: boolean; usynced: boolean }> {
	let warnedOwnAbsent = false
	let usynced = false

	if (!result.needsUsync && !result.ownDevicePresent) {
		deps.logger.warn(
			{ parity: 'd1', ownDevice: result.ownDevice, deviceJids: result.deviceJids },
			'[waweb-parity][d1] OWN DEVICE ABSENT from account_sync device list'
		)
		warnedOwnAbsent = true
	}

	await deps.withDevicesLock(async () => {
		await deps.delCachedUser(result.ownUser)
		if (result.ownLidUser) {
			await deps.delCachedUser(result.ownLidUser)
		}
	})

	if (result.needsUsync && !deps.offline) {
		await deps.getUSyncDevices([deps.meIdNormalized], false, false)
		usynced = true
	}

	deps.logger.info(
		{
			parity: 'd1',
			deviceCount: result.deviceJids.length,
			ownDevicePresent: result.ownDevicePresent,
			usynced,
			warnedOwnAbsent
		},
		'[waweb-parity][d1] account_sync device-list reconcile'
	)

	return { warnedOwnAbsent, usynced }
}
