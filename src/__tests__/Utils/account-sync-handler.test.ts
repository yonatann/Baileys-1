import P from 'pino'
import {
	extractAccountSyncDeviceSync,
	reconcileOwnDevicesOnAccountSync,
	type AccountSyncReconcileResult
} from '../../Utils/account-sync-handler'
import { type BinaryNode } from '../../WABinary'

const logger = P({ level: 'silent' })

// device-suffixed me.id (the real shape from pair-success) — the exact case B1 missed
const ME_ID = '15551230000:3@s.whatsapp.net'
const ME_LID = '99887766:3@lid'

function accountSyncNode(child: BinaryNode, offline?: string): BinaryNode {
	return {
		tag: 'notification',
		attrs: { type: 'account_sync', from: ME_ID, ...(offline !== undefined ? { offline } : {}) },
		content: [child]
	}
}

function devicesChild(deviceJids: string[]): BinaryNode {
	return {
		tag: 'devices',
		attrs: {},
		content: deviceJids.map(jid => ({ tag: 'device', attrs: { jid }, content: undefined }))
	}
}

describe('account_sync device-list reconcile — extractor (D1 / BE#661)', () => {
	it('derives a bare ownUser and the device number from a device-suffixed me.id', () => {
		const node = accountSyncNode(devicesChild(['15551230000:0@s.whatsapp.net', '15551230000:3@s.whatsapp.net']))
		const r = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(r.action).toBe('reconcile')
		if (r.action !== 'reconcile') return
		expect(r.ownUser).toBe('15551230000') // bare — no :3 suffix
		expect(r.ownLidUser).toBe('99887766')
		expect(r.ownDevice).toBe(3)
		expect(r.needsUsync).toBe(false)
	})

	it('flags ownDevicePresent=true when our device id is in the pushed list', () => {
		const node = accountSyncNode(devicesChild(['15551230000:0@s.whatsapp.net', '15551230000:3@s.whatsapp.net']))
		const r = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(r.action === 'reconcile' && r.ownDevicePresent).toBe(true)
	})

	it('flags ownDevicePresent=false when our device id is ABSENT from the pushed list (pre-removal signal)', () => {
		const node = accountSyncNode(devicesChild(['15551230000:0@s.whatsapp.net', '15551230000:7@s.whatsapp.net']))
		const r = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(r.action === 'reconcile' && r.ownDevicePresent).toBe(false)
	})

	it('sets needsUsync=true for an empty <devices> child (context notification)', () => {
		const r = extractAccountSyncDeviceSync(accountSyncNode(devicesChild([])), { meId: ME_ID, meLid: ME_LID })
		expect(r.action === 'reconcile' && r.needsUsync).toBe(true)
	})

	it('ignores disappearing_mode / blocklist account_sync', () => {
		const dm = accountSyncNode({ tag: 'disappearing_mode', attrs: { duration: '0', t: '1' }, content: undefined })
		expect(extractAccountSyncDeviceSync(dm, { meId: ME_ID, meLid: ME_LID }).action).toBe('no_device_child')
	})

	it('skips when the own id is unavailable', () => {
		const r = extractAccountSyncDeviceSync(accountSyncNode(devicesChild(['x:0@s.whatsapp.net'])), {
			meId: undefined,
			meLid: undefined
		})
		expect(r.action).toBe('skipped_no_me')
	})

	// R3-1: ownDevicePresent must match our device across BOTH the PN and LID user forms.
	it('flags ownDevicePresent=true for a LID-form pushed list carrying our LID device', () => {
		const node = accountSyncNode(devicesChild(['99887766:0@lid', '99887766:3@lid']))
		const r = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(r.action === 'reconcile' && r.ownDevicePresent).toBe(true)
	})

	it('flags ownDevicePresent=false for a LID-form list missing our LID device', () => {
		const node = accountSyncNode(devicesChild(['99887766:0@lid', '99887766:9@lid']))
		const r = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(r.action === 'reconcile' && r.ownDevicePresent).toBe(false)
	})

	// R3-1: only reconcile when the push is for OUR account (WA Web isMeAccount(from)).
	it('skips a push whose from is NOT our account', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: { type: 'account_sync', from: '447700900000@s.whatsapp.net' },
			content: [devicesChild(['447700900000:0@s.whatsapp.net'])]
		}
		expect(extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID }).action).toBe('skipped_not_me')
	})

	it('reconciles when from is our LID account', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: { type: 'account_sync', from: ME_LID },
			content: [devicesChild(['99887766:3@lid'])]
		}
		expect(extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID }).action).toBe('reconcile')
	})

	it('reconciles when from is absent (server-omitted)', () => {
		const node: BinaryNode = {
			tag: 'notification',
			attrs: { type: 'account_sync' },
			content: [devicesChild(['15551230000:3@s.whatsapp.net'])]
		}
		expect(extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID }).action).toBe('reconcile')
	})
})

describe('account_sync device-list reconcile — orchestrator (D1 / BE#661, B1+B2)', () => {
	function makeDeps(overrides: Record<string, unknown> = {}) {
		const calls: { del: string[]; usync: string[][]; usyncWhileLocked: boolean } = {
			del: [],
			usync: [],
			usyncWhileLocked: false
		}
		let lockHeld = false
		return {
			calls,
			deps: {
				meIdNormalized: '15551230000@s.whatsapp.net', // bare — the B1 fix
				offline: false,
				delCachedUser: async (u: string) => {
					calls.del.push(u)
				},
				withDevicesLock: async <T>(fn: () => Promise<T>): Promise<T> => {
					lockHeld = true
					try {
						return await fn()
					} finally {
						lockHeld = false
					}
				},
				getUSyncDevices: async (jids: string[]) => {
					if (lockHeld) calls.usyncWhileLocked = true // B2: must be OUTSIDE the mutex
					calls.usync.push(jids)
					return []
				},
				logger,
				...overrides
			}
		}
	}

	const base: Omit<AccountSyncReconcileResult, 'deviceJids' | 'ownDevicePresent' | 'needsUsync'> = {
		action: 'reconcile',
		ownUser: '15551230000',
		ownLidUser: '99887766',
		ownDevice: 3
	}

	it('drops BOTH the PN and LID cached own-device entries under the lock', async () => {
		const { calls, deps } = makeDeps()
		await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: ['15551230000:3@s.whatsapp.net'], ownDevicePresent: true, needsUsync: false },
			deps
		)
		expect(calls.del).toEqual(['15551230000', '99887766'])
	})

	it('does NOT USync when the pushed list is non-empty (apply locally)', async () => {
		const { calls, deps } = makeDeps()
		await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: ['15551230000:3@s.whatsapp.net'], ownDevicePresent: true, needsUsync: false },
			deps
		)
		expect(calls.usync).toEqual([])
	})

	it('USyncs with the BARE me.id user jid when the list is empty (B1 fix)', async () => {
		const { calls, deps } = makeDeps()
		await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: [], ownDevicePresent: false, needsUsync: true },
			deps
		)
		expect(calls.usync).toEqual([['15551230000@s.whatsapp.net']])
	})

	it('runs getUSyncDevices OUTSIDE the devices mutex (B2 deadlock guard)', async () => {
		const { calls, deps } = makeDeps()
		await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: [], ownDevicePresent: false, needsUsync: true },
			deps
		)
		expect(calls.usyncWhileLocked).toBe(false)
	})

	it('does NOT USync during offline processing', async () => {
		const { calls, deps } = makeDeps({ offline: true })
		await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: [], ownDevicePresent: false, needsUsync: true },
			deps
		)
		expect(calls.usync).toEqual([])
	})

	it('warns when our own device is absent from a non-empty pushed list', async () => {
		const warns: unknown[] = []
		const { deps } = makeDeps({ logger: { ...logger, warn: (obj: unknown) => warns.push(obj) } })
		const res = await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: ['15551230000:0@s.whatsapp.net'], ownDevicePresent: false, needsUsync: false },
			deps
		)
		expect(res.warnedOwnAbsent).toBe(true)
	})

	it('does NOT warn own-absent for an empty list (that is a context notification, not a removal)', async () => {
		const { deps } = makeDeps()
		const res = await reconcileOwnDevicesOnAccountSync(
			{ ...base, deviceJids: [], ownDevicePresent: false, needsUsync: true },
			deps
		)
		expect(res.warnedOwnAbsent).toBe(false)
	})
})
