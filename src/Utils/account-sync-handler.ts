import { type BinaryNode, getBinaryNodeChild, getBinaryNodeChildren, jidDecode } from '../WABinary'

export type AccountSyncDeviceSyncResult =
	/** The account_sync carries no device-list child — caller handles disappearing_mode/blocklist etc. */
	| { action: 'no_device_child' }
	/** A device-list child is present but we have no own-user id to reconcile against. */
	| { action: 'skipped_no_me' }
	/** Reconcile the account's OWN device list via a fresh USync fetch. */
	| { action: 'reconcile'; ownUser: string; deviceJids: string[] }

export type AccountSyncContext = {
	meId: string | undefined
	meLid: string | undefined
}

/**
 * WA Web parity (D1 / BE#661): a `type=account_sync` notification can carry a `<devices>`
 * (device-list) child. WA Web's `handleAccountSyncNotification` (AccountSyncType.DEVICES) feeds it
 * to `addUserToPendingDeviceSync` → `doPendingDeviceSync`, a USync-based reconcile of the account's
 * OWN device list. The fork's `account_sync` case handled only `disappearing_mode`/`blocklist` and
 * IGNORED a device-list child, so the account's own device view could go stale — the push seen
 * immediately before several `device_removed` events.
 *
 * This inspects an account_sync node and, when it carries a device-list child, signals the caller to
 * reconcile the own device list via USync (returning the own user and any device jids present, for
 * observability). Non-device account_sync children fall through unchanged.
 */
export function extractAccountSyncDeviceSync(node: BinaryNode, ctx: AccountSyncContext): AccountSyncDeviceSyncResult {
	const devicesChild = getBinaryNodeChild(node, 'devices')
	if (!devicesChild) {
		return { action: 'no_device_child' }
	}

	const ownUser = ctx.meId ? jidDecode(ctx.meId)?.user : undefined
	if (!ownUser) {
		return { action: 'skipped_no_me' }
	}

	const deviceJids = getBinaryNodeChildren(devicesChild, 'device')
		.map(d => d.attrs.jid)
		.filter((jid): jid is string => !!jid)

	return { action: 'reconcile', ownUser, deviceJids }
}
