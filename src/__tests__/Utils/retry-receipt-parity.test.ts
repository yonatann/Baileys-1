import { describe, expect, it, jest } from '@jest/globals'
import {
	decideRetryBaseKeyAction,
	decideRetryKeyBundle,
	forgetSenderKeyEntry,
	parseRetryReceiptCount,
	refuseRetryReceipt,
	requesterHasDevice,
	RETRY_RECEIPT_MAX_RETRY,
	runRetryReceipt,
	shouldDeleteSessionOnRegMismatch,
	type RetryReceiptDeps,
	type RetryReceiptInput
} from '../../Utils/retry-receipt-parity'

const GROUP = '120363000000000001@g.us'
const ME = '15550000009:5@s.whatsapp.net'
const ME_LID = '900000000000009:5@lid'
const PRIMARY = '15550000001@s.whatsapp.net'
const COMPANION = '15550000001:3@s.whatsapp.net'
const OTHER = '15550000002@s.whatsapp.net'
const MSG = { conversation: 'hi' }
const BUNDLE = {
	registrationId: 42,
	identityKey: new Uint8Array(32),
	signedPreKey: { keyId: 1, publicKey: new Uint8Array(32), signature: new Uint8Array(64) }
}

const silentLogger = { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn(), trace: jest.fn() } as any

const makeDeps = (overrides: Partial<RetryReceiptDeps> = {}) => {
	let memory: Record<string, boolean> = { [PRIMARY]: true, [COMPANION]: true, [OTHER]: true }
	const deps: RetryReceiptDeps & { memory: () => Record<string, boolean> } = {
		logger: silentLogger,
		maxRetry: RETRY_RECEIPT_MAX_RETRY,
		listDevices: jest.fn(async () => [0, 3]),
		getSenderKeyMemory: jest.fn(async () => memory),
		setSenderKeyMemory: jest.fn(async (_g: string, map: Record<string, boolean>) => {
			memory = map
		}),
		isMeDevice: jid => jid === ME || jid === ME_LID,
		isMeAccount: jid => jid.startsWith('15550000009'),
		getLocalRegId: jest.fn(async () => 42),
		injectSession: jest.fn(async () => {}),
		deleteSession: jest.fn(async () => {}),
		baseKey: { save: jest.fn(() => {}), hasSame: jest.fn(() => false), delete: jest.fn(() => {}) },
		ensureSession: jest.fn(async () => {}),
		getMessage: jest.fn(async () => MSG),
		resend: jest.fn(async () => {}),
		memory: () => memory,
		...overrides
	}
	return deps
}

const input = (over: Partial<RetryReceiptInput> = {}): RetryReceiptInput => ({
	remoteJid: GROUP,
	requester: PRIMARY,
	retryCount: 1,
	offline: false,
	receivedRegId: 42,
	bundle: null,
	ids: ['MSG1'],
	...over
})

const expectNoMutation = (deps: ReturnType<typeof makeDeps>) => {
	expect(deps.setSenderKeyMemory).not.toHaveBeenCalled()
	expect(deps.injectSession).not.toHaveBeenCalled()
	expect(deps.deleteSession).not.toHaveBeenCalled()
	expect(deps.ensureSession).not.toHaveBeenCalled()
	expect(deps.resend).not.toHaveBeenCalled()
	expect(deps.baseKey!.save).not.toHaveBeenCalled()
	expect(deps.memory()).toEqual({ [PRIMARY]: true, [COMPANION]: true, [OTHER]: true })
}

// W2 — WAWebRetryRequestParser: `maybeAttrInt("count") ?? 0`
describe('parseRetryReceiptCount', () => {
	it('defaults to 0 when the attr is absent or not a number (not 1)', () => {
		expect(parseRetryReceiptCount(undefined)).toBe(0)
		expect(parseRetryReceiptCount('')).toBe(0)
		expect(parseRetryReceiptCount('x')).toBe(0)
		expect(parseRetryReceiptCount('3')).toBe(3)
	})
})

// W4 / W5 — WAWebHandleRetryRequest.E: refuse before any session work
describe('refuseRetryReceipt', () => {
	it('refuses at the requester count >= MAX_RETRY (5)', () => {
		const base = { maxRetry: 5, requester: PRIMARY, receivedRegId: 1, deviceKnown: true }
		expect(refuseRetryReceipt({ ...base, retryCount: 4 })).toBeNull()
		expect(refuseRetryReceipt({ ...base, retryCount: 5 })).toBe('retry_count_exceeded')
		expect(refuseRetryReceipt({ ...base, retryCount: 9 })).toBe('retry_count_exceeded')
	})

	it('refuses an unknown device, a missing requester and a missing registration', () => {
		const base = { maxRetry: 5, retryCount: 1, requester: PRIMARY, receivedRegId: 1 }
		expect(refuseRetryReceipt({ ...base, deviceKnown: false })).toBe('unknown_device')
		expect(refuseRetryReceipt({ ...base, requester: undefined, deviceKnown: true })).toBe('no_requester')
		expect(refuseRetryReceipt({ ...base, receivedRegId: null, deviceKnown: true })).toBe('missing_registration')
	})
})

// W5 — WAWebApiDeviceList.hasDevice
describe('requesterHasDevice', () => {
	it('device 0 is always known without a lookup; companions must be in the stored list', async () => {
		const list = jest.fn(async () => [0, 3])
		expect(await requesterHasDevice(PRIMARY, list)).toBe(true)
		expect(list).not.toHaveBeenCalled()
		expect(await requesterHasDevice(COMPANION, list)).toBe(true)
		expect(await requesterHasDevice('15550000001:7@s.whatsapp.net', list)).toBe(false)
		expect(await requesterHasDevice(COMPANION, async () => null)).toBe(false)
	})
})

// W6 — WAWebApiParticipantStore.markForgetSenderKey → C(record, wids, false)
describe('forgetSenderKeyEntry', () => {
	const map = { [PRIMARY]: true, [COMPANION]: true, [OTHER]: true }

	it('flips only the requester entry to false; every other entry stays', () => {
		const r = forgetSenderKeyEntry(map, COMPANION, false)
		expect(r.changed).toBe(true)
		expect(r.map).toEqual({ [PRIMARY]: true, [COMPANION]: false, [OTHER]: true })
		expect(r.rotateKey).toBe(false)
	})

	it('skips the current device, and flags rotateKey for an unknown PN device only', () => {
		expect(forgetSenderKeyEntry(map, ME, true)).toEqual({ map, changed: false, rotateKey: false })
		expect(forgetSenderKeyEntry(map, '15550000003@s.whatsapp.net', false)).toEqual({ map, changed: false, rotateKey: true })
		expect(forgetSenderKeyEntry(map, '900000000000003@lid', false)).toEqual({ map, changed: false, rotateKey: false })
	})
})

// W8 — WAWebProcessRetryKeyBundle.processKeyBundle
describe('decideRetryKeyBundle', () => {
	it('skips without a bundle; online always uses the bundle', () => {
		expect(decideRetryKeyBundle({ hasBundle: false, receivedRegId: 1, localRegId: null, offline: true })).toBe('skip')
		expect(decideRetryKeyBundle({ hasBundle: true, receivedRegId: 1, localRegId: null, offline: false })).toBe('use')
		expect(decideRetryKeyBundle({ hasBundle: true, receivedRegId: 1, localRegId: 2, offline: false })).toBe('use')
	})

	it('offline: no local session or a reg mismatch deletes and skips; a match uses the bundle', () => {
		expect(decideRetryKeyBundle({ hasBundle: true, receivedRegId: 1, localRegId: null, offline: true })).toBe(
			'delete_session_and_skip'
		)
		expect(decideRetryKeyBundle({ hasBundle: true, receivedRegId: 1, localRegId: 2, offline: true })).toBe(
			'delete_session_and_skip'
		)
		expect(decideRetryKeyBundle({ hasBundle: true, receivedRegId: 1, localRegId: 1, offline: true })).toBe('use')
	})
})

// W9 — WAWebUpdateLocalSignalSession: `!used && local != null && local !== received`
describe('shouldDeleteSessionOnRegMismatch', () => {
	it('deletes only when the bundle was not used and a stored reg id differs', () => {
		expect(shouldDeleteSessionOnRegMismatch(false, 1, 2)).toBe(true)
		expect(shouldDeleteSessionOnRegMismatch(true, 1, 2)).toBe(false)
		expect(shouldDeleteSessionOnRegMismatch(false, null, 2)).toBe(false)
		expect(shouldDeleteSessionOnRegMismatch(false, 2, 2)).toBe(false)
	})
})

// W10 — WAWebUpdateLocalSignalSession base-key rule
describe('decideRetryBaseKeyAction', () => {
	it('saves at count 2, deletes above 2 on the same base key, nothing otherwise', () => {
		expect(decideRetryBaseKeyAction(1, false)).toBe('none')
		expect(decideRetryBaseKeyAction(2, false)).toBe('save')
		expect(decideRetryBaseKeyAction(2, true)).toBe('save')
		expect(decideRetryBaseKeyAction(3, true)).toBe('delete_session')
		expect(decideRetryBaseKeyAction(3, false)).toBe('none')
	})
})

describe('runRetryReceipt (WA Web order)', () => {
	// regression for #301 finding (2): a declined retry must leave memory and sessions untouched
	it('count >= MAX_RETRY: refuses with zero mutation', async () => {
		const deps = makeDeps()
		const out = await runRetryReceipt(deps, input({ retryCount: 5 }))
		expect(out).toEqual({ kind: 'refused', reason: 'retry_count_exceeded' })
		expectNoMutation(deps)
	})

	it('unknown requester device: refuses with zero mutation', async () => {
		const deps = makeDeps({ listDevices: jest.fn(async () => [0]) })
		const out = await runRetryReceipt(deps, input({ requester: COMPANION }))
		expect(out).toEqual({ kind: 'refused', reason: 'unknown_device' })
		expectNoMutation(deps)
	})

	it('missing <registration>: refuses with zero mutation', async () => {
		const deps = makeDeps()
		const out = await runRetryReceipt(deps, input({ receivedRegId: null }))
		expect(out).toEqual({ kind: 'refused', reason: 'missing_registration' })
		expectNoMutation(deps)
	})

	// W6 — never the whole group
	it('group retry forgets only the requester sender-key entry', async () => {
		const deps = makeDeps()
		await runRetryReceipt(deps, input({ requester: COMPANION }))
		expect(deps.memory()).toEqual({ [PRIMARY]: true, [COMPANION]: false, [OTHER]: true })
		expect(deps.setSenderKeyMemory).toHaveBeenCalledTimes(1)
	})

	it('1:1 retry does not touch sender-key memory', async () => {
		const deps = makeDeps()
		await runRetryReceipt(deps, input({ remoteJid: PRIMARY }))
		expect(deps.getSenderKeyMemory).not.toHaveBeenCalled()
		expect(deps.setSenderKeyMemory).not.toHaveBeenCalled()
	})

	// W12 — a refusal at the lookup has already run W6–W11 (WA Web order), never a whole-group wipe
	it('message not found: requester entry forgotten + session ensured, no resend', async () => {
		const deps = makeDeps({ getMessage: jest.fn(async () => undefined) })
		const out = await runRetryReceipt(deps, input({ requester: COMPANION }))
		expect(out).toEqual({ kind: 'handled', sent: [], notFound: ['MSG1'] })
		expect(deps.memory()).toEqual({ [PRIMARY]: true, [COMPANION]: false, [OTHER]: true })
		expect(deps.ensureSession).toHaveBeenCalledWith(COMPANION)
		expect(deps.resend).not.toHaveBeenCalled()
	})

	// W7 — own-account requester with a changed registration id aborts
	it('own-account requester with a changed reg id throws before any session work', async () => {
		const deps = makeDeps({ getLocalRegId: jest.fn(async () => 7), listDevices: jest.fn(async () => [0, 2]) })
		await expect(runRetryReceipt(deps, input({ requester: '15550000009:2@s.whatsapp.net' }))).rejects.toThrow(
			/registration Id change/
		)
		expect(deps.injectSession).not.toHaveBeenCalled()
		expect(deps.deleteSession).not.toHaveBeenCalled()
		expect(deps.resend).not.toHaveBeenCalled()
	})

	// W8 — bundle semantics through the orchestrator
	it('online bundle is injected; offline bundle with a reg mismatch deletes the session instead', async () => {
		const online = makeDeps()
		await runRetryReceipt(online, input({ bundle: BUNDLE }))
		expect(online.injectSession).toHaveBeenCalledWith(PRIMARY, BUNDLE)
		expect(online.deleteSession).not.toHaveBeenCalled()

		const offline = makeDeps({ getLocalRegId: jest.fn(async () => 7) })
		await runRetryReceipt(offline, input({ bundle: BUNDLE, offline: true }))
		expect(offline.injectSession).not.toHaveBeenCalled()
		expect(offline.deleteSession).toHaveBeenCalledWith(PRIMARY)
	})

	// W9
	it('no bundle + stored reg id differs: deletes the session, then ensures (non-forced) and resends', async () => {
		const deps = makeDeps({ getLocalRegId: jest.fn(async () => 7) })
		await runRetryReceipt(deps, input())
		expect(deps.deleteSession).toHaveBeenCalledWith(PRIMARY)
		expect(deps.ensureSession).toHaveBeenCalledWith(PRIMARY)
		expect(deps.resend).toHaveBeenCalledWith('MSG1', MSG, PRIMARY, 1)
	})

	// W10
	it('count 2 saves the base key; count 3 with the same base key deletes the session', async () => {
		const save = makeDeps()
		await runRetryReceipt(save, input({ retryCount: 2 }))
		expect(save.baseKey!.save).toHaveBeenCalledWith(PRIMARY, 'MSG1')
		expect(save.deleteSession).not.toHaveBeenCalled()

		const del = makeDeps({ baseKey: { save: jest.fn(() => {}), hasSame: jest.fn(() => true), delete: jest.fn(() => {}) } })
		await runRetryReceipt(del, input({ retryCount: 3 }))
		expect(del.deleteSession).toHaveBeenCalledWith(PRIMARY)
		expect(del.baseKey!.delete).toHaveBeenCalledWith(PRIMARY, 'MSG1')
	})

	// W11 + W13 — one resend to the requester device, with the requester's own count; a primary
	// requester is NOT a send-to-all
	it('primary requester: resend goes to that device only, count 4 is still eligible', async () => {
		const deps = makeDeps()
		const out = await runRetryReceipt(deps, input({ retryCount: 4, ids: ['A', 'B'] }))
		expect(out).toEqual({ kind: 'handled', sent: ['A', 'B'], notFound: [] })
		expect(deps.ensureSession).toHaveBeenCalledTimes(1)
		expect(deps.resend).toHaveBeenNthCalledWith(1, 'A', MSG, PRIMARY, 4)
		expect(deps.resend).toHaveBeenNthCalledWith(2, 'B', MSG, PRIMARY, 4)
	})
})
