import type { proto } from '../../WAProto/index.js'
import {
	classifyPhashMismatch,
	computeResendDelta,
	isResendExpired,
	type GroupFanoutRecord,
	selectPhashFanoutJids
} from '../Utils/group-phash-resend'
import {
	buildFetchMissingPreKeysQuery,
	type KnownUserDevices,
	parseMissingPreKeyBundles
} from '../Utils/missing-prekeys'
import { encodeSignedDeviceIdentity } from '../Utils/validate-connection'
import { type BinaryNode, jidDecode, jidEncode } from '../WABinary'
import {
	assertSessions,
	assertSessionsPerJid,
	createParticipantNodes,
	getMessageType,
	getUSyncDevices
} from './send-core'
import type { SendCoreAdapter } from './types'

/**
 * WA Web parity (`WAWebSendGroupSkmsgJob` → `WAWebResendGroupMsg.resendGroupMsg`) for a group
 * `<ack phash>` mismatch: send the message again, as a GROUP_DIRECT stanza, to the devices the server
 * knows that the original fan-out missed.
 */

/** The bits of the socket the resend needs on top of the send core. */
export type GroupResendAdapter = SendCoreAdapter & {
	/** remote registration id of the open signal session with `jid`, if there is one */
	sessionRegistrationId(jid: string): Promise<number | undefined>
	/** this device's registration id (`creds.registrationId`) */
	localRegistrationId(): number | undefined
}

export type GroupResendOutcome =
	| { status: 'no-record' }
	| { status: 'phash-matches' }
	| { status: 'expired' }
	| { status: 'no-new-devices' }
	| { status: 'resent'; devices: string[] }

/** One `<user>` per account of `jids`, listing every device of the account we hold a session for. */
const collectKnownDevices = async (
	adapter: GroupResendAdapter,
	record: GroupFanoutRecord
): Promise<KnownUserDevices[]> => {
	const me = adapter.me()
	const byUser = new Map<string, { userJid: string; deviceIds: Set<number> }>()
	for (const jid of record.oldAsSent) {
		const decoded = jidDecode(jid)
		if (!decoded) continue
		const userJid = jidEncode(decoded.user, decoded.server)
		const entry = byUser.get(userJid) ?? { userJid, deviceIds: new Set<number>() }
		// WA Web always lists the account's primary device next to the devices of its device list
		entry.deviceIds.add(0)
		entry.deviceIds.add(decoded.device ?? 0)
		byUser.set(userJid, entry)
	}

	const users: KnownUserDevices[] = []
	for (const { userJid, deviceIds } of byUser.values()) {
		const devices: KnownUserDevices['devices'] = []
		for (const deviceId of deviceIds) {
			const decoded = jidDecode(userJid)!
			const deviceJid = jidEncode(decoded.user, decoded.server, deviceId)
			const isMeDevice = deviceJid === me?.id || deviceJid === me?.lid
			const registrationId = isMeDevice ? adapter.localRegistrationId() : await adapter.sessionRegistrationId(deviceJid)
			// a device without a session is simply not listed: that is how the server knows to send its bundle
			if (registrationId !== undefined) devices.push({ deviceId, registrationId })
		}

		users.push({ userJid, devices })
	}

	return users
}

/** `fetchResendMissingKeys`: ask the server for bundles of devices we do not know and inject them. */
export const fetchResendMissingKeys = async (adapter: GroupResendAdapter, record: GroupFanoutRecord) => {
	const users = await collectKnownDevices(adapter, record)
	if (!users.length) return
	const result = await adapter.query(buildFetchMissingPreKeysQuery(users))
	const { bundles, failedUsers } = parseMissingPreKeyBundles(result)
	if (failedUsers) adapter.logger.warn({ failedUsers }, 'fetchResendMissingKeys: some users failed')
	for (const { jid, session } of bundles) {
		await adapter.signal.injectE2ESession({ jid, session })
	}
}

/**
 * Resend group message `msgId` to the devices a server phash mismatch revealed.
 *
 * Once-only: the record is taken (deleted) on entry, and the resend stanza carries no phash, so the
 * server cannot answer it with another mismatch.
 */
export const resendGroupMsgToMissingDevices = async (
	adapter: GroupResendAdapter,
	{ msgId, serverPhash, ackTimeMs }: { msgId: string; serverPhash: string; ackTimeMs: number }
): Promise<GroupResendOutcome> => {
	const { logger } = adapter
	const record = adapter.groupFanoutRecords?.take(msgId)
	if (!record) return { status: 'no-record' }
	if (record.sentPhash === serverPhash) return { status: 'phash-matches' }

	// a failed key fetch is only logged: the resend may still reach devices we already hold sessions for
	try {
		await fetchResendMissingKeys(adapter, record)
	} catch (err) {
		logger.warn({ msgId, err: (err as Error).message }, 'fetchResendMissingKeys failed')
	}

	// `sendQueryGroup`: a failure aborts the resend
	await adapter.groupMetadata(record.group)

	if (isResendExpired(ackTimeMs, Date.now())) {
		logger.info({ msgId }, 'group resend skipped: older than the resend window')
		return { status: 'expired' }
	}

	const me = adapter.me()
	if (!me) return { status: 'no-new-devices' }
	const users = new Set<string>()
	for (const jid of record.oldAsSent) {
		const decoded = jidDecode(jid)
		if (decoded) users.add(jidEncode(decoded.user, decoded.server))
	}

	const fresh = await getUSyncDevices(adapter, [...users], false, false)
	const freshFiltered = selectPhashFanoutJids(fresh, me.id, me.lid)
	const sender = record.addressingMode === 'lid' && me.lid ? me.lid : me.id
	// observability only: which local recipe reproduces the server's hash (no wire effect)
	logger.info(
		{
			msgId,
			serverPhash,
			...classifyPhashMismatch({
				serverPhash,
				oldAsSent: record.oldAsSent,
				oldFiltered: record.oldFiltered,
				freshFiltered,
				sender
			})
		},
		'group phash mismatch'
	)

	const delta = computeResendDelta(record.oldFiltered, freshFiltered)
	if (!delta.length) return { status: 'no-new-devices' }

	let reachable = delta
	try {
		await assertSessions(adapter, delta)
	} catch (err) {
		logger.warn(
			{ msgId, err: (err as Error).message },
			'group resend: batch assertSessions failed, retrying per device'
		)
		reachable = await assertSessionsPerJid(adapter, delta)
	}

	// plain message to the new devices, wrapped as a device-sent message for the sender's own account;
	// no sender-key distribution and no sender-key-memory update (WA Web's GROUP_DIRECT does neither)
	const ownAccountMessage: proto.IMessage = {
		deviceSentMessage: { destinationJid: record.group, message: record.message },
		messageContextInfo: record.message.messageContextInfo
	}
	const { nodes, shouldIncludeDeviceIdentity } = await createParticipantNodes(
		adapter,
		reachable,
		record.message,
		record.extraAttrs,
		ownAccountMessage,
		{ alreadyPatched: true }
	)

	const content: BinaryNode[] = [
		{ tag: 'participants', attrs: {}, content: nodes },
		{ tag: 'enc', attrs: { v: '2', type: 'skmsg', ...record.extraAttrs } }
	]
	if (shouldIncludeDeviceIdentity) {
		content.push({
			tag: 'device-identity',
			attrs: {},
			content: encodeSignedDeviceIdentity(adapter.account()!, true)
		})
	}

	content.push(...record.trailingNodes)
	await adapter.sendNode({
		tag: 'message',
		attrs: {
			id: msgId,
			to: record.group,
			type: getMessageType(record.message),
			...record.stanzaAttrs,
			device_fanout: 'false'
		},
		content
	})
	logger.info({ msgId, devices: reachable }, 'group message resent to devices missed by the phash')
	return { status: 'resent', devices: reachable }
}
