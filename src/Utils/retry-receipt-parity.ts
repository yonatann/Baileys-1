import type { proto } from '../../WAProto/index.js'
import type { SignalRepository } from '../Types'
import { isJidGroup, isLidUser, jidDecode } from '../WABinary'
import type { ILogger } from './logger'

type E2ESession = Parameters<SignalRepository['injectE2ESession']>[0]['session']

/**
 * WA Web parity for an incoming `<receipt type="retry">` on a message we sent.
 *
 * The sequence below mirrors `WAWebHandleRetryRequest` (`E` + `handleRetryRequest`),
 * `WAWebUpdateLocalSignalSession`, `WAWebProcessRetryKeyBundle` and `WAWebSendRetryMsgJob`
 * rule by rule, in WA Web's execution order. Pure decision helpers are exported for the unit
 * tests; `runRetryReceipt` is the orchestrator the socket wires its stores into.
 */

/** `WAWebPostMessageHighRetryCountMetric.MAX_RETRY` */
export const RETRY_RECEIPT_MAX_RETRY = 5

/** `WAWebUpdateLocalSignalSession`: the retry count at which the session base key is saved. */
export const RETRY_BASE_KEY_CHECK_COUNT = 2

/** `WAWebRetryRequestParser`: `retryCount: retry.maybeAttrInt("count") ?? 0`. */
export const parseRetryReceiptCount = (count: string | undefined): number => {
	const n = count === undefined ? NaN : parseInt(count, 10)
	return Number.isFinite(n) ? n : 0
}

/**
 * `WAWebSendMsgCommonApi.isPrimaryDevice(wid)`: `wid.device == null || wid.device === DEFAULT_DEVICE_ID (0)`.
 * `WAWebGetGroupKeyDistributionMsg` drops a companion whose SKDM encryption fails but rejects the
 * send when a primary device fails.
 */
export const isPrimaryDeviceJid = (jid: string): boolean => {
	const decoded = jidDecode(jid)
	return !!decoded && !decoded.device
}

export type RetryReceiptRefusal = 'retry_count_exceeded' | 'no_requester' | 'unknown_device' | 'missing_registration'

/**
 * `WAWebHandleRetryRequest.E`: refuse before touching any session when the requester's own
 * count has reached MAX_RETRY, when there is no requester, or when the requester device is not
 * in our device list. `WAWebRetryRequestParser` requires the `<registration>` child, so a receipt
 * without one never reaches the handler either.
 */
export const refuseRetryReceipt = (opts: {
	retryCount: number
	maxRetry: number
	requester: string | undefined
	receivedRegId: number | null
	deviceKnown: boolean
}): RetryReceiptRefusal | null => {
	if (opts.retryCount >= opts.maxRetry) return 'retry_count_exceeded'
	if (!opts.requester) return 'no_requester'
	if (opts.receivedRegId === null) return 'missing_registration'
	if (!opts.deviceKnown) return 'unknown_device'
	return null
}

/**
 * `WAWebApiDeviceList.hasDevice(user, deviceId)`: device 0 is always known; any other device id
 * must be present in the stored device list of the user (or of its PN/LID alternate).
 */
export const requesterHasDevice = async (
	requester: string,
	listDevices: (user: string) => Promise<number[] | null>
): Promise<boolean> => {
	const decoded = jidDecode(requester)
	if (!decoded) return false
	const device = decoded.device || 0
	if (device === 0) return true
	const devices = await listDevices(decoded.user)
	return !!devices?.includes(device)
}

/**
 * `WAWebApiParticipantStore.markForgetSenderKey(group, [requester])` → `C(record, wids, false)`:
 * only the requester's own entry flips to false; entries of every other device are untouched;
 * the current device is skipped; an entry we never had marks `rotateKey` for a PN requester.
 */
export const forgetSenderKeyEntry = (
	map: Record<string, boolean>,
	requester: string,
	isMeDevice: boolean
): { map: Record<string, boolean>; changed: boolean; rotateKey: boolean } => {
	if (isMeDevice) return { map, changed: false, rotateKey: false }
	if (Object.prototype.hasOwnProperty.call(map, requester)) {
		return { map: { ...map, [requester]: false }, changed: true, rotateKey: false }
	}

	return { map, changed: false, rotateKey: !isLidUser(requester) }
}

export type RetryKeyBundleDecision = 'skip' | 'delete_session_and_skip' | 'use'

/**
 * `WAWebProcessRetryKeyBundle.processKeyBundle(bundle, requester, recvRegId, localRegId, offline)`:
 * no bundle → skip. Offline receipt: no local session → delete + skip; local reg ≠ received →
 * delete + skip; else build the session from the bundle. Online receipt: always build from it.
 */
export const decideRetryKeyBundle = (opts: {
	hasBundle: boolean
	receivedRegId: number
	localRegId: number | null
	offline: boolean
}): RetryKeyBundleDecision => {
	if (!opts.hasBundle) return 'skip'
	if (opts.offline) {
		if (opts.localRegId === null) return 'delete_session_and_skip'
		if (opts.localRegId !== opts.receivedRegId) return 'delete_session_and_skip'
	}

	return 'use'
}

/** `WAWebUpdateLocalSignalSession`: bundle not used and a stored reg id that differs → delete. */
export const shouldDeleteSessionOnRegMismatch = (
	bundleUsed: boolean,
	localRegId: number | null,
	receivedRegId: number
): boolean => !bundleUsed && localRegId !== null && localRegId !== receivedRegId

export type RetryBaseKeyAction = 'save' | 'delete_session' | 'none'

/**
 * `WAWebUpdateLocalSignalSession`: retryCount === 2 saves the session base key for this message;
 * retryCount > 2 with the same base key as saved deletes the session.
 */
export const decideRetryBaseKeyAction = (retryCount: number, hasSameBaseKey: boolean): RetryBaseKeyAction => {
	if (retryCount === RETRY_BASE_KEY_CHECK_COUNT) return 'save'
	if (retryCount > RETRY_BASE_KEY_CHECK_COUNT && hasSameBaseKey) return 'delete_session'
	return 'none'
}

export type RetryReceiptInput = {
	remoteJid: string
	/** the device asking for the retry (`participant` for a group, `from` for a 1:1) */
	requester: string | undefined
	retryCount: number
	offline: boolean
	receivedRegId: number | null
	bundle: E2ESession | null
	ids: string[]
}

export type RetryReceiptDeps = {
	logger: ILogger
	maxRetry: number
	listDevices: (user: string) => Promise<number[] | null>
	getSenderKeyMemory: (group: string) => Promise<Record<string, boolean>>
	setSenderKeyMemory: (group: string, map: Record<string, boolean>) => Promise<unknown> | void
	/**
	 * WA Web runs the receipt and the send jobs of one chat serially, so `markForgetSenderKey` never
	 * interleaves with a send's read-modify-write of the same participant record. The socket runs the
	 * forget inside the same keys transaction the send path holds; absent → run unguarded.
	 */
	withSenderKeyMemoryLock?: <T>(group: string, fn: () => Promise<T>) => Promise<T>
	isMeDevice: (jid: string) => boolean
	isMeAccount: (jid: string) => boolean
	getLocalRegId: (jid: string) => Promise<number | null>
	injectSession: (jid: string, bundle: E2ESession) => Promise<void>
	deleteSession: (jid: string) => Promise<unknown>
	/** absent when the socket has no base-key store (`enableRecentMessageCache: false`) */
	baseKey?: {
		save: (jid: string, msgId: string) => Promise<void> | void
		hasSame: (jid: string, msgId: string) => Promise<boolean> | boolean
		delete: (jid: string, msgId: string) => Promise<void> | void
	}
	/** non-forced: fetch a prekey only when there is no session (`ensureE2ESessions([h], false)`) */
	ensureSession: (jid: string) => Promise<unknown>
	getMessage: (id: string) => Promise<proto.IMessage | undefined>
	/** one stanza to the requester device only (`createGroupDeviceMsgStanza(…, {participant})`) */
	resend: (id: string, msg: proto.IMessage, requester: string, retryCount: number) => Promise<void>
}

export type RetryReceiptOutcome =
	| { kind: 'refused'; reason: RetryReceiptRefusal }
	| { kind: 'handled'; sent: string[]; notFound: string[] }

/**
 * The full WA Web retry-receipt path for a message we sent, in WA Web's order:
 * refuse (no mutation) → forget the requester's sender-key entry → own-device reg guard → key
 * bundle → reg-mismatch delete → base-key rule → non-forced session ensure → message lookup →
 * resend to the requester device only.
 */
export const runRetryReceipt = async (
	deps: RetryReceiptDeps,
	input: RetryReceiptInput
): Promise<RetryReceiptOutcome> => {
	const { logger } = deps
	const { remoteJid, requester, retryCount, offline, receivedRegId, bundle, ids } = input

	const deviceKnown = requester ? await requesterHasDevice(requester, deps.listDevices) : false
	const refusal = refuseRetryReceipt({ retryCount, maxRetry: deps.maxRetry, requester, receivedRegId, deviceKnown })
	if (refusal) {
		logger.info({ remoteJid, requester, retryCount, reason: refusal }, 'refusing retry receipt')
		return { kind: 'refused', reason: refusal }
	}

	const jid = requester!
	const regId = receivedRegId!

	if (isJidGroup(remoteJid)) {
		const forget = async () => {
			const current = await deps.getSenderKeyMemory(remoteJid)
			const result = forgetSenderKeyEntry(current, jid, deps.isMeDevice(jid))
			if (result.changed) {
				await deps.setSenderKeyMemory(remoteJid, result.map)
			}

			return result
		}

		const { rotateKey } = deps.withSenderKeyMemoryLock
			? await deps.withSenderKeyMemoryLock(remoteJid, forget)
			: await forget()

		if (rotateKey) {
			// WA Web flags the group for a sender-key rotation here; the fork has no rotateKey
			// consumer yet, so the next send only re-distributes to devices without an entry.
			logger.debug({ remoteJid, requester: jid }, 'retry from a device without a sender-key entry')
		}
	}

	const localRegId = await deps.getLocalRegId(jid)
	if (deps.isMeAccount(jid) && localRegId !== regId) {
		throw new Error(
			`updateLocalSignalSession: detect registration Id change remote: ${regId}, local: ${String(localRegId)} for peer device`
		)
	}

	const bundleDecision = decideRetryKeyBundle({ hasBundle: !!bundle, receivedRegId: regId, localRegId, offline })
	let bundleUsed = false
	if (bundleDecision === 'delete_session_and_skip') {
		logger.info({ requester: jid, localRegId, regId }, 'retry key bundle skipped, deleting session')
		await deps.deleteSession(jid)
	} else if (bundleDecision === 'use') {
		await deps.injectSession(jid, bundle!)
		bundleUsed = true
	}

	if (shouldDeleteSessionOnRegMismatch(bundleUsed, localRegId, regId)) {
		logger.info({ requester: jid, localRegId, regId }, 'retry reg id mismatch, deleting session')
		await deps.deleteSession(jid)
	}

	const msgId = ids[0]
	if (deps.baseKey && msgId) {
		const hasSame = retryCount > RETRY_BASE_KEY_CHECK_COUNT ? await deps.baseKey.hasSame(jid, msgId) : false
		const action = decideRetryBaseKeyAction(retryCount, hasSame)
		if (action === 'save') {
			await deps.baseKey.save(jid, msgId)
		} else if (action === 'delete_session') {
			logger.warn({ requester: jid, retryCount }, 'same base key on retry, deleting session')
			await deps.deleteSession(jid)
		}

		if (retryCount > RETRY_BASE_KEY_CHECK_COUNT) {
			await deps.baseKey.delete(jid, msgId)
		}
	}

	await deps.ensureSession(jid)

	const sent: string[] = []
	const notFound: string[] = []
	for (const id of ids) {
		const msg = await deps.getMessage(id)
		if (!msg) {
			logger.warn({ remoteJid, id, requester: jid }, 'retry not authorized: message not found')
			notFound.push(id)
			continue
		}

		await deps.resend(id, msg, jid, retryCount)
		sent.push(id)
	}

	return { kind: 'handled', sent, notFound }
}
