import { Boom } from '@hapi/boom'
import type { proto } from '../../WAProto/index.js'
import type { MessageRelayOptions, WAMessageKey } from '../Types'
import {
	appendContentBindings,
	type ContentBindings,
	getContentBindingSource,
	isLinkMessage,
	makeBindingOnlyParticipantNodes,
	makeContentBindings
} from '../Utils/content-binding'
import { shouldHideDecryptFail } from '../Utils/decrypt-fail'
// Specific-file imports on purpose: the `../Utils` barrel re-exports node-only modules
// (`auth-utils`→async_hooks, `messages-media`→jimp, `use-multi-file-auth-state`→fs) that the
// WA Web adapter's browser bundle cannot resolve.
import {
	encodeWAMessage,
	generateMessageIDV2,
	generateParticipantHashV2,
	unixTimestampSeconds
} from '../Utils/generics'
import { selectPhashFanoutJids } from '../Utils/group-phash-resend'
import { selectLidsForForceRefetch } from '../Utils/lid-refetch-throttle'
import { normalizeMessageContent } from '../Utils/message-content'
import { withDerivedMetaNode } from '../Utils/message-meta-node'
import { buildNewsletterMessageNode } from '../Utils/newsletter-stanza'
import { resolvePeerRecipientPn } from '../Utils/peer-recipient'
import { getMessageReportingToken, isRevokeMessage, shouldIncludeReportingToken } from '../Utils/reporting-utils'
import { isPrimaryDeviceJid } from '../Utils/retry-receipt-parity'
import { extractDeviceJids, parseAndInjectE2ESessions } from '../Utils/signal'
import {
	buildMergedTcTokenIndexWrite,
	isTcTokenExpired,
	resolveIssuanceJid,
	resolveTcTokenJid,
	shouldSendNewTcToken,
	storeTcTokensFromIqResult
} from '../Utils/tc-token-utils'
import { encodeSignedDeviceIdentity } from '../Utils/validate-connection'
import {
	areJidsSameUser,
	type BinaryNode,
	type BinaryNodeAttributes,
	type FullJid,
	isHostedLidUser,
	isHostedPnUser,
	isJidBot,
	isJidGroup,
	isJidMetaAI,
	isLidUser,
	isPnUser,
	jidDecode,
	jidEncode,
	jidNormalizedUser,
	PSA_WID,
	S_WHATSAPP_NET
} from '../WABinary'
import { USyncQuery, USyncUser } from '../WAUSync'
import type { DeviceWithJid, SendCoreAdapter } from './types'

/**
 * The transport-agnostic WhatsApp send core.
 *
 * Everything here used to live inside `makeMessagesSocket`'s closure. The bodies are unchanged; the only
 * difference is that the socket state they reached for (`authState`, `signalRepository`, `query`, the
 * device cache, the mutexes, ...) now arrives through a `SendCoreAdapter`. The Baileys socket binds one to
 * itself; a WA Web host binds the same shape to its own socket and signal store.
 *
 * `src/__tests__/Socket/send-core-stanza-snapshot.test.ts` pins the bytes these functions put on the wire.
 */

/** Same contract as `assertMeId(creds)`: fail fast with a 401 Boom before the identity is known. */
const requireMe = (adapter: SendCoreAdapter) => {
	const me = adapter.me()
	if (!me?.id) {
		throw new Boom('Cannot proceed: socket is not authenticated yet (creds.me.id is missing)', { statusCode: 401 })
	}

	return me
}

/** Fetch all the devices we've to send a message to */
export const getUSyncDevices = async (
	adapter: SendCoreAdapter,
	jids: string[],
	useCache: boolean,
	ignoreZeroDevices: boolean
): Promise<DeviceWithJid[]> => {
	const { logger, userDevicesCache, devicesMutex, lidForceRefetchThrottle } = adapter
	const deviceResults: DeviceWithJid[] = []

	if (!useCache) {
		logger.debug('not using cache for devices')
	}

	const toFetch: string[] = []

	const jidsWithUser = jids
		.map(jid => {
			const decoded = jidDecode(jid)
			const user = decoded?.user
			const device = decoded?.device
			const isExplicitDevice = typeof device === 'number' && device >= 0

			if (isExplicitDevice && user) {
				deviceResults.push({
					user,
					device,
					jid
				})
				return null
			}

			jid = jidNormalizedUser(jid)
			return { jid, user }
		})
		.filter(jid => jid !== null)

	let mgetDevices: undefined | Record<string, FullJid[] | undefined>

	if (useCache && userDevicesCache.mget) {
		const usersToFetch = jidsWithUser.map(j => j?.user).filter(Boolean) as string[]
		mgetDevices = await userDevicesCache.mget(usersToFetch)
	}

	for (const { jid, user } of jidsWithUser) {
		if (useCache) {
			const devices =
				mgetDevices?.[user!] || (userDevicesCache.mget ? undefined : ((await userDevicesCache.get(user!)) as FullJid[]))
			if (devices) {
				const devicesWithJid = devices.map(d => ({
					...d,
					jid: jidEncode(d.user, d.server, d.device)
				}))
				deviceResults.push(...devicesWithJid)

				logger.trace({ user }, 'using cache for devices')
			} else {
				toFetch.push(jid)
			}
		} else {
			toFetch.push(jid)
		}
	}

	if (!toFetch.length) {
		return deviceResults
	}

	const requestedLidUsers = new Set<string>()
	for (const jid of toFetch) {
		if (isLidUser(jid) || isHostedLidUser(jid)) {
			const user = jidDecode(jid)?.user
			if (user) requestedLidUsers.add(user)
		}
	}

	const query = new USyncQuery().withContext('interactive').withDeviceProtocol().withLIDProtocol()

	for (const jid of toFetch) {
		query.withUser(new USyncUser().withId(jid)) // todo: investigate - the idea here is that <user> should have an inline lid field with the lid being the pn equivalent
	}

	const result = await adapter.executeUSyncQuery(query)

	if (result) {
		// TODO: LID MAP this stuff (lid protocol will now return lid with devices)
		const lidResults = result.list.filter(a => !!a.lid)
		if (lidResults.length > 0) {
			logger.trace('Storing LID maps from device call')
			await adapter.signal.lidMapping.storeLIDPNMappings(lidResults.map(a => ({ lid: a.lid as string, pn: a.id })))

			// Force-refresh sessions for newly mapped LIDs to align identity addressing.
			// WA Web parity (D3 / BE#660): throttle per-LID so repeated LID-mapping churn
			// does not trigger an unbounded identity-fetch storm (reason='identity' IQs).
			try {
				const lids = lidResults.map(a => a.lid as string)
				const { toRefetch, throttled } = selectLidsForForceRefetch(lids, lidForceRefetchThrottle)
				if (throttled.length) {
					logger.debug(
						{ parity: 'd3', throttled: throttled.length },
						'[waweb-parity][d3] identity force-refetch throttled for recently-refetched LIDs'
					)
				}

				if (toRefetch.length) {
					logger.info(
						{ parity: 'd3', refetch: toRefetch.length, throttled: throttled.length },
						'[waweb-parity][d3] identity force-refetch for newly mapped LIDs'
					)
					await assertSessions(adapter, toRefetch, true)
				}
			} catch (e) {
				logger.warn({ e, count: lidResults.length }, 'failed to assert sessions for newly mapped LIDs')
			}
		}

		const me = adapter.me()
		const extracted = extractDeviceJids(result?.list, me!.id, me!.lid!, ignoreZeroDevices)
		const deviceMap: { [_: string]: FullJid[] } = {}

		for (const item of extracted) {
			deviceMap[item.user] = deviceMap[item.user] || []
			deviceMap[item.user]?.push(item)
		}

		// Process each user's devices as a group for bulk LID migration
		for (const [user, userDevices] of Object.entries(deviceMap)) {
			const isLidUser = requestedLidUsers.has(user)

			// Process all devices for this user
			for (const item of userDevices) {
				const finalJid = isLidUser
					? jidEncode(user, item.server, item.device)
					: jidEncode(item.user, item.server, item.device)

				deviceResults.push({
					...item,
					jid: finalJid
				})

				logger.debug(
					{
						user: item.user,
						device: item.device,
						finalJid,
						usedLid: isLidUser
					},
					'Processed device with LID priority'
				)
			}
		}

		await devicesMutex.mutex(async () => {
			if (userDevicesCache.mset) {
				// if the cache supports mset, we can set all devices in one go
				await userDevicesCache.mset(Object.entries(deviceMap).map(([key, value]) => ({ key, value })))
			} else {
				for (const key in deviceMap) {
					if (deviceMap[key]) await userDevicesCache.set(key, deviceMap[key])
				}
			}
		})

		const userDeviceUpdates: { [userId: string]: string[] } = {}
		for (const [userId, devices] of Object.entries(deviceMap)) {
			if (devices && devices.length > 0) {
				userDeviceUpdates[userId] = devices.map(d => d.device?.toString() || '0')
			}
		}

		if (Object.keys(userDeviceUpdates).length > 0) {
			try {
				await adapter.keys.set({ 'device-list': userDeviceUpdates })
				logger.debug(
					{ userCount: Object.keys(userDeviceUpdates).length },
					'stored user device lists for bulk migration'
				)
			} catch (error) {
				logger.warn({ error }, 'failed to store user device lists')
			}
		}
	}

	return deviceResults
}

/** Per-JID fallback after a failed batch assertSessions: keeps only the devices that answer. */
export const assertSessionsPerJid = async (adapter: SendCoreAdapter, jids: string[]): Promise<string[]> => {
	const reachable: string[] = []
	for (const jid of jids) {
		try {
			await assertSessions(adapter, [jid])
			reachable.push(jid)
		} catch (e) {
			adapter.logger.warn({ jid, err: (e as Error).message }, 'skipping unreachable participant device')
		}
	}

	return reachable
}

export const assertSessions = async (adapter: SendCoreAdapter, jids: string[], force?: boolean) => {
	const { logger, signal } = adapter
	let didFetchNewSession = false
	const uniqueJids = [...new Set(jids)]
	const jidsRequiringFetch: string[] = []

	logger.debug({ jids }, 'assertSessions call with jids')

	for (const jid of uniqueJids) {
		if (!force) {
			const sessionValidation = await signal.validateSession(jid)
			if (sessionValidation.exists) {
				continue
			}
		}

		jidsRequiringFetch.push(jid)
	}

	if (jidsRequiringFetch.length) {
		// LID if mapped, otherwise original
		const wireJids = [
			...jidsRequiringFetch.filter(jid => !!isLidUser(jid) || !!isHostedLidUser(jid)),
			...(
				(await signal.lidMapping.getLIDsForPNs(
					jidsRequiringFetch.filter(jid => !!isPnUser(jid) || !!isHostedPnUser(jid)),
					// forced refresh must not be blocked by a recent (possibly transient) USync miss
					{ bypassNegativeCache: !!force }
				)) || []
			).map(a => a.lid)
		]

		logger.debug({ jidsRequiringFetch, wireJids }, 'fetching sessions')
		const result = await adapter.query({
			tag: 'iq',
			attrs: {
				xmlns: 'encrypt',
				type: 'get',
				to: S_WHATSAPP_NET
			},
			content: [
				{
					tag: 'key',
					attrs: {},
					content: wireJids.map(jid => {
						const attrs: { [key: string]: string } = { jid }
						if (force) attrs.reason = 'identity'
						return { tag: 'user', attrs }
					})
				}
			]
		})
		await parseAndInjectE2ESessions(result, signal)
		didFetchNewSession = true
	}

	return didFetchNewSession
}

export const createParticipantNodes = async (
	adapter: SendCoreAdapter,
	recipientJids: string[],
	message: proto.IMessage,
	extraAttrs?: BinaryNode['attrs'],
	dsmMessage?: proto.IMessage,
	opts?: {
		/**
		 * WA Web parity (#298): `WAWebGetGroupKeyDistributionMsg` drops a companion device whose
		 * sender-key encryption fails but rejects the whole send when a PRIMARY device fails.
		 */
		rejectOnPrimaryDeviceFailure?: boolean
		/** `message` already went through `patchMessageBeforeSending`; do not run the hook again (group resend) */
		alreadyPatched?: boolean
	}
) => {
	const { logger, signal, encryptionMutex } = adapter
	if (!recipientJids.length) {
		return { nodes: [] as BinaryNode[], shouldIncludeDeviceIdentity: false }
	}

	const patched = opts?.alreadyPatched ? message : await adapter.patchMessageBeforeSending(message, recipientJids)
	const patchedMessages = Array.isArray(patched)
		? patched
		: recipientJids.map(jid => ({ recipientJid: jid, message: patched }))

	let shouldIncludeDeviceIdentity = false
	const me = adapter.me()
	const meId = me!.id
	const meLid = me?.lid
	const meLidUser = meLid ? jidDecode(meLid)?.user : null

	const encryptionPromises = (patchedMessages as any).map(
		async ({ recipientJid: jid, message: patchedMessage }: any) => {
			try {
				if (!jid) return null

				let msgToEncrypt = patchedMessage

				if (dsmMessage) {
					const { user: targetUser } = jidDecode(jid)!
					const { user: ownPnUser } = jidDecode(meId)!
					const ownLidUser = meLidUser

					const isOwnUser = targetUser === ownPnUser || (ownLidUser && targetUser === ownLidUser)
					const isExactSenderDevice = jid === meId || (meLid && jid === meLid)

					if (isOwnUser && !isExactSenderDevice) {
						msgToEncrypt = dsmMessage
						logger.debug({ jid, targetUser }, 'Using DSM for own device')
					}
				}

				const bytes = encodeWAMessage(msgToEncrypt)
				const mutexKey = jid

				const node = await encryptionMutex.mutex(mutexKey, async () => {
					const { type, ciphertext } = await signal.encryptMessage({ jid, data: bytes })

					if (type === 'pkmsg') {
						shouldIncludeDeviceIdentity = true
					}

					return {
						tag: 'to',
						attrs: { jid },
						content: [
							{
								tag: 'enc',
								attrs: { v: '2', type, ...(extraAttrs || {}) },
								content: ciphertext
							}
						]
					}
				})

				return node
			} catch (err) {
				logger.error({ jid, err }, 'Failed to encrypt for recipient')
				if (opts?.rejectOnPrimaryDeviceFailure && isPrimaryDeviceJid(jid)) {
					throw new Boom(`getKeyDistributionMsg: encryption fail for primary device ${jid}`, {
						statusCode: 500,
						data: err
					})
				}

				return null
			}
		}
	)

	const nodes = (await Promise.all(encryptionPromises)).filter(node => node !== null) as BinaryNode[]

	if (recipientJids.length > 0 && nodes.length === 0) {
		throw new Boom('All encryptions failed', { statusCode: 500 })
	}

	return { nodes, shouldIncludeDeviceIdentity }
}

/**
 * Build the `<message>` stanza for `jid` (device fan-out, Signal / sender-key encryption, device-identity,
 * content bindings, reporting token, tctoken) and hand it to `adapter.sendNode`. This is the socket's
 * `relayMessage` with the transport injected.
 */
export const buildAndRelay = async (
	adapter: SendCoreAdapter,
	jid: string,
	message: proto.IMessage,
	{
		messageId: msgId,
		participant,
		additionalAttributes,
		additionalNodes: callerNodes,
		useUserDevicesCache,
		useCachedGroupMetadata,
		statusJidList,
		reportingMessage: reportingMessageOverride,
		newsletterMediaHandle
	}: MessageRelayOptions
) => {
	const { logger, signal, keys, patchMessageBeforeSending, cachedGroupMetadata, inFlightTcTokenIssuance } = adapter
	// view-once / poll-vote attrs on the single <meta> node, whoever built the message
	const additionalNodes = withDerivedMetaNode(callerNodes, message)
	const getLIDForPN = (pn: string) => signal.lidMapping.getLIDForPN(pn)
	const me = requireMe(adapter)
	const meId = me.id
	const meLid = me.lid
	const isRetryResend = Boolean(participant?.jid)
	// WA Web parity (#298): `WAWebSendMsgCreateDeviceStanza` attaches `<device-identity>` only when
	// the enc type is pkmsg, for a retry resend as for any other device stanza.
	let shouldIncludeDeviceIdentity = false
	const statusJid = 'status@broadcast'

	const { user, server } = jidDecode(jid)!
	const isGroup = server === 'g.us'
	const isStatus = jid === statusJid
	const isLid = server === 'lid'
	const isNewsletter = server === 'newsletter'
	const isGroupOrStatus = isGroup || isStatus
	const finalJid = jid

	msgId = msgId || generateMessageIDV2(meId)
	useUserDevicesCache = useUserDevicesCache !== false
	useCachedGroupMetadata = useCachedGroupMetadata !== false && !isStatus

	const participants: BinaryNode[] = []
	const destinationJid = !isStatus ? finalJid : statusJid
	const binaryNodeContent: BinaryNode[] = []
	const devices: DeviceWithJid[] = []
	let reportingMessage: proto.IMessage | undefined
	/** group payload after `patchMessageBeforeSending`: what the sender-key ciphertext was built from */
	let patchedGroupMessage: proto.IMessage | undefined

	const meMsg: proto.IMessage = {
		deviceSentMessage: {
			destinationJid,
			message
		},
		messageContextInfo: message.messageContextInfo
	}

	const extraAttrs: BinaryNodeAttributes = {}
	// WA Web content binding (rcat) for link messages, see Utils/content-binding
	const contentBindingSource =
		!isNewsletter && !isStatus && !isRetryResend ? getContentBindingSource(message) : undefined
	let contentBindings: ContentBindings | undefined

	if (participant) {
		if (!isGroup && !isStatus) {
			additionalAttributes = { ...additionalAttributes, device_fanout: 'false' }
		}

		const { user, device } = jidDecode(participant.jid)!
		devices.push({
			user,
			device,
			jid: participant.jid
		})
	}

	await keys.transaction(async () => {
		const mediaType = getMediaType(message)
		if (mediaType) {
			extraAttrs['mediatype'] = mediaType
		}

		if (isNewsletter) {
			const patched = patchMessageBeforeSending ? await patchMessageBeforeSending(message, []) : message
			const stanza = buildNewsletterMessageNode({
				jid,
				msgId,
				message: patched as proto.IMessage,
				messageType: getMessageType(message),
				mediaType,
				mediaHandle: newsletterMediaHandle,
				additionalAttributes
			})
			logger.debug({ msgId }, `sending newsletter message to ${jid}`)
			await adapter.sendNode(stanza)
			return
		}

		if (shouldHideDecryptFail(message)) {
			extraAttrs['decrypt-fail'] = 'hide'
		}

		if (isGroupOrStatus && !isRetryResend) {
			const [groupData, senderKeyMap] = await Promise.all([
				(async () => {
					let groupData = useCachedGroupMetadata && cachedGroupMetadata ? await cachedGroupMetadata(jid) : undefined // todo: should we rely on the cache specially if the cache is outdated and the metadata has new fields?
					if (groupData && Array.isArray(groupData?.participants)) {
						logger.trace({ jid, participants: groupData.participants.length }, 'using cached group metadata')
					} else if (!isStatus) {
						groupData = await adapter.groupMetadata(jid) // TODO: start storing group participant list + addr mode in Signal & stop relying on this
					}

					return groupData
				})(),
				(async () => {
					if (!participant && !isStatus) {
						// what if sender memory is less accurate than the cached metadata
						// on participant change in group, we should do sender memory manipulation
						const result = await keys.get('sender-key-memory', [jid]) // TODO: check out what if the sender key memory doesn't include the LID stuff now?
						return result[jid] || {}
					}

					return {}
				})()
			])

			const participantsList = groupData ? groupData.participants.map(p => p.id) : []

			if (groupData?.ephemeralDuration && groupData.ephemeralDuration > 0) {
				additionalAttributes = {
					...additionalAttributes,
					expiration: groupData.ephemeralDuration.toString()
				}
			}

			if (isStatus && statusJidList) {
				participantsList.push(...statusJidList)
			}

			const additionalDevices = await getUSyncDevices(adapter, participantsList, !!useUserDevicesCache, false)
			devices.push(...additionalDevices)

			if (isGroup) {
				additionalAttributes = {
					...additionalAttributes,
					addressing_mode: groupData?.addressingMode || 'pn'
				}
			}

			const patched = await patchMessageBeforeSending(message)
			if (Array.isArray(patched)) {
				throw new Boom('Per-jid patching is not supported in groups')
			}

			const bytes = encodeWAMessage(patched)
			reportingMessage = patched
			patchedGroupMessage = patched
			const groupAddressingMode = additionalAttributes?.['addressing_mode'] || groupData?.addressingMode || 'pn'
			const groupSenderIdentity = groupAddressingMode === 'lid' && meLid ? meLid : meId
			if (contentBindingSource) {
				contentBindings = makeContentBindings({
					source: contentBindingSource,
					stanzaId: msgId,
					senderJid: groupSenderIdentity,
					recipientCount: groupData?.participants?.length ?? 0
				})
			}

			// WA Web hashes every device it fans out to plus the sending device itself; the server
			// compares it to its own view and answers a mismatch with a phash on the <ack>.
			// The fan-out list (`WAWebDBDeviceListFanout.getFanOutList`) never contains device 99 or
			// hosted devices, so neither does the hash — `getUSyncDevices` returns them, filter here
			// (the sender-key fan-out below already skips them; the hash must cover the same set).
			if (isGroup) {
				additionalAttributes = {
					...additionalAttributes,
					phash: generateParticipantHashV2([...selectPhashFanoutJids(devices, meId, meLid), groupSenderIdentity])
				}
			}

			const { ciphertext, senderKeyDistributionMessage } = await signal.encryptGroupMessage({
				group: destinationJid,
				data: bytes,
				meId: groupSenderIdentity
			})

			const senderKeyRecipients: string[] = []
			for (const device of devices) {
				const deviceJid = device.jid
				const hasKey = !!senderKeyMap[deviceJid]
				if (
					(!hasKey || !!participant) &&
					!isHostedLidUser(deviceJid) &&
					!isHostedPnUser(deviceJid) &&
					device.device !== 99
				) {
					//todo: revamp all this logic
					// the goal is to follow with what I said above for each group, and instead of a true false map of ids, we can set an array full of those the app has already sent pkmsgs
					senderKeyRecipients.push(deviceJid)
					senderKeyMap[deviceJid] = true
				}
			}

			if (senderKeyRecipients.length) {
				logger.debug({ senderKeyJids: senderKeyRecipients }, 'sending new sender key')

				const senderKeyMsg: proto.IMessage = {
					senderKeyDistributionMessage: {
						axolotlSenderKeyDistributionMessage: senderKeyDistributionMessage,
						groupId: destinationJid
					}
				}

				const senderKeySessionTargets = senderKeyRecipients
				let reachableRecipients = [...senderKeySessionTargets]
				try {
					await assertSessions(adapter, senderKeySessionTargets)
				} catch (sessionErr) {
					const isRecoverable = ['not-acceptable', 'Timed Out', 'No sessions'].includes((sessionErr as Error).message)
					if (!isRecoverable || senderKeySessionTargets.length <= 1) {
						throw sessionErr
					}

					logger.warn(
						{ count: senderKeySessionTargets.length, err: (sessionErr as Error).message },
						'batch assertSessions failed — retrying per-JID to skip unreachable devices'
					)
					reachableRecipients = await assertSessionsPerJid(adapter, senderKeySessionTargets)
					const droppedPrimary = senderKeySessionTargets.find(
						j => isPrimaryDeviceJid(j) && !reachableRecipients.includes(j)
					)
					if (droppedPrimary) {
						throw new Boom(`getKeyDistributionMsg: encryption fail for primary device ${droppedPrimary}`, {
							statusCode: 500,
							data: sessionErr
						})
					}
				}

				if (reachableRecipients.length) {
					const result = await createParticipantNodes(
						adapter,
						reachableRecipients,
						senderKeyMsg,
						extraAttrs,
						undefined,
						{
							rejectOnPrimaryDeviceFailure: true
						}
					)
					shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || result.shouldIncludeDeviceIdentity
					if (contentBindings) {
						appendContentBindings(result.nodes, contentBindings, deviceJid => deviceJid)
					}

					participants.push(...result.nodes)
				}
			} else if (contentBindings) {
				const keyHolders = devices
					.filter(({ jid, device }) => !isHostedLidUser(jid) && !isHostedPnUser(jid) && device !== 99)
					.map(({ jid }) => jid)
				participants.push(...makeBindingOnlyParticipantNodes(keyHolders, contentBindings))
			}

			binaryNodeContent.push({
				tag: 'enc',
				attrs: { v: '2', type: 'skmsg', ...extraAttrs },
				content: ciphertext
			})

			await keys.set({ 'sender-key-memory': { [jid]: senderKeyMap } })
		} else {
			// ADDRESSING CONSISTENCY: Match own identity to conversation context
			// TODO: investigate if this is true
			let ownId = meId
			if (isLid && meLid) {
				ownId = meLid
				logger.debug({ to: jid, ownId }, 'Using LID identity for @lid conversation')
			} else {
				logger.debug({ to: jid, ownId }, 'Using PN identity for @s.whatsapp.net conversation')
			}

			const { user: ownUser } = jidDecode(ownId)!
			if (
				!isRetryResend &&
				additionalAttributes?.['category'] !== 'peer' &&
				!additionalAttributes?.['peer_recipient_pn']
			) {
				const peerRecipientPn = await resolvePeerRecipientPn(jid, meLid, lid => signal.lidMapping.getPNForLID(lid))
				if (peerRecipientPn) {
					additionalAttributes = { ...additionalAttributes, peer_recipient_pn: peerRecipientPn }
				}
			}

			if (!participant) {
				const patchedForReporting = await patchMessageBeforeSending(message, [jid])
				reportingMessage = Array.isArray(patchedForReporting)
					? patchedForReporting.find(item => item.recipientJid === jid) || patchedForReporting[0]
					: patchedForReporting
			}

			if (!isRetryResend) {
				const targetUserServer = isLid ? 'lid' : 's.whatsapp.net'
				devices.push({
					user,
					device: 0,
					jid: jidEncode(user, targetUserServer, 0) // rajeh, todo: this entire logic is convoluted and weird.
				})

				if (user !== ownUser) {
					const ownUserServer = isLid ? 'lid' : 's.whatsapp.net'
					const ownUserForAddressing = isLid && meLid ? jidDecode(meLid)!.user : jidDecode(meId)!.user

					devices.push({
						user: ownUserForAddressing,
						device: 0,
						jid: jidEncode(ownUserForAddressing, ownUserServer, 0)
					})
				}

				if (additionalAttributes?.['category'] !== 'peer') {
					// Clear placeholders and enumerate actual devices
					devices.length = 0

					// Use conversation-appropriate sender identity
					const senderIdentity =
						isLid && meLid
							? jidEncode(jidDecode(meLid)?.user!, 'lid', undefined)
							: jidEncode(jidDecode(meId)?.user!, 's.whatsapp.net', undefined)

					// Enumerate devices for sender and target with consistent addressing
					const sessionDevices = await getUSyncDevices(adapter, [senderIdentity, jid], true, false)
					devices.push(...sessionDevices)

					logger.debug(
						{
							deviceCount: devices.length,
							devices: devices.map(d => `${d.user}:${d.device}@${jidDecode(d.jid)?.server}`)
						},
						'Device enumeration complete with unified addressing'
					)
				}
			}

			const allRecipients: string[] = []
			const meRecipients: string[] = []
			const otherRecipients: string[] = []
			const { user: mePnUser } = jidDecode(meId)!
			const { user: meLidUser } = meLid ? jidDecode(meLid)! : { user: null }

			for (const { user, jid } of devices) {
				const isExactSenderDevice = jid === meId || (meLid && jid === meLid)
				if (isExactSenderDevice) {
					logger.debug({ jid, meId, meLid }, 'Skipping exact sender device (whatsmeow pattern)')
					continue
				}

				// Check if this is our device (could match either PN or LID user)
				const isMe = user === mePnUser || user === meLidUser

				if (isMe) {
					meRecipients.push(jid)
				} else {
					otherRecipients.push(jid)
				}

				allRecipients.push(jid)
			}

			await assertSessions(adapter, allRecipients)

			const [
				{ nodes: meNodes, shouldIncludeDeviceIdentity: s1 },
				{ nodes: otherNodes, shouldIncludeDeviceIdentity: s2 }
			] = await Promise.all([
				// For own devices: use DSM if available (1:1 chats only)
				createParticipantNodes(adapter, meRecipients, meMsg || message, extraAttrs),
				createParticipantNodes(adapter, otherRecipients, message, extraAttrs, meMsg)
			])
			if (contentBindingSource) {
				const recipientUsers = new Set([ownUser, ...devices.map(d => d.user)])
				contentBindings = makeContentBindings({
					source: contentBindingSource,
					stanzaId: msgId,
					senderJid: ownId,
					recipientCount: recipientUsers.size
				})
				if (contentBindings) {
					appendContentBindings([...meNodes, ...otherNodes], contentBindings, () => destinationJid)
				}
			}

			participants.push(...meNodes)
			participants.push(...otherNodes)

			shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || s1 || s2
		}

		if (isRetryResend) {
			const isParticipantLid = isLidUser(participant!.jid)
			const isMe = areJidsSameUser(participant!.jid, isParticipantLid ? meLid : meId)

			// WA Web parity (#298): `WAWebSendRetryMsgJob.sendRetry` → `createGroupDeviceMsgStanza` is a
			// plain 1:1 encrypt of the message proto (`encryptMsgProtobuf`); the requester gets a fresh
			// sender key with the NEXT skmsg because its sender-key entry was forgotten on the receipt.
			const messageToSend = message
			const encodedMessageToSend = isMe
				? encodeWAMessage({
						deviceSentMessage: {
							destinationJid,
							message: messageToSend
						}
					})
				: encodeWAMessage(messageToSend)

			const { type, ciphertext: encryptedContent } = await signal.encryptMessage({
				data: encodedMessageToSend,
				jid: participant!.jid
			})

			// `count: C === 0 ? DROP_ATTR : INT(C)`: a count of 0 is not written on the enc node
			binaryNodeContent.push({
				tag: 'enc',
				attrs: {
					v: '2',
					type,
					...(participant!.count ? { count: participant!.count.toString() } : {})
				},
				content: encryptedContent
			})
			shouldIncludeDeviceIdentity = shouldIncludeDeviceIdentity || type === 'pkmsg'
		}

		if (participants.length) {
			if (additionalAttributes?.['category'] === 'peer') {
				const peerNode = participants[0]?.content?.[0] as BinaryNode
				if (peerNode) {
					binaryNodeContent.push(peerNode) // push only enc
				}
			} else {
				binaryNodeContent.push({
					tag: 'participants',
					attrs: {},

					content: participants
				})
			}
		}

		const stanza: BinaryNode = {
			tag: 'message',
			attrs: {
				id: msgId,
				to: destinationJid,
				type: getMessageType(message),
				...(additionalAttributes || {})
			},
			content: binaryNodeContent
		}

		// if the participant to send to is explicitly specified (generally retry recp)
		// ensure the message is only sent to that person
		// if a retry receipt is sent to everyone -- it'll fail decryption for everyone else who received the msg
		if (participant) {
			if (isJidGroup(destinationJid)) {
				stanza.attrs.to = destinationJid
				stanza.attrs.participant = participant.jid
			} else if (areJidsSameUser(participant.jid, meId)) {
				stanza.attrs.to = participant.jid
				stanza.attrs.recipient = destinationJid
			} else {
				stanza.attrs.to = participant.jid
			}
		} else {
			stanza.attrs.to = destinationJid
		}

		if (shouldIncludeDeviceIdentity) {
			;(stanza.content as BinaryNode[]).push({
				tag: 'device-identity',
				attrs: {},
				content: encodeSignedDeviceIdentity(adapter.account()!, true)
			})

			logger.debug({ jid }, 'adding device identity')
		}

		const senderContentBindingNode = contentBindings?.senderNode()
		if (senderContentBindingNode) {
			;(stanza.content as BinaryNode[]).push(senderContentBindingNode)
		}

		if (reportingMessageOverride) {
			reportingMessage = reportingMessageOverride
		}

		let reportingNodeSent: BinaryNode | undefined
		if (
			!isNewsletter &&
			!isRetryResend &&
			reportingMessage?.messageContextInfo?.messageSecret &&
			shouldIncludeReportingToken(reportingMessage) &&
			!isRevokeMessage(reportingMessage)
		) {
			try {
				const encoded = encodeWAMessage(reportingMessage)
				const reportingKey: WAMessageKey = {
					id: msgId,
					fromMe: true,
					remoteJid: destinationJid,
					participant: participant?.jid
				}
				const reportingNode = await getMessageReportingToken(encoded, reportingMessage, reportingKey)
				if (reportingNode) {
					reportingNodeSent = reportingNode
					;(stanza.content as BinaryNode[]).push(reportingNode)
					logger.trace({ jid }, 'added reporting token to message')
				}
			} catch (error: any) {
				logger.warn({ jid, trace: error?.stack }, 'failed to attach reporting token')
			}
		}

		// WA Web never attaches tctoken to peer (AppStateSync) messages — server rejects with 479
		const isPeerMessage = additionalAttributes?.['category'] === 'peer'
		const is1on1Send = !isGroup && !isRetryResend && !isStatus && !isNewsletter && !isPeerMessage

		// Resolve destination to LID for tctoken storage — matches Signal session key pattern
		const tcTokenJid = is1on1Send ? await resolveTcTokenJid(destinationJid, getLIDForPN) : destinationJid
		const contactTcTokenData = is1on1Send ? await keys.get('tctoken', [tcTokenJid]) : {}
		const existingTokenEntry = contactTcTokenData[tcTokenJid]
		let tcTokenBuffer = existingTokenEntry?.token

		// Treat expired tokens the same as missing — clear from cache
		if (tcTokenBuffer?.length && isTcTokenExpired(existingTokenEntry?.timestamp)) {
			logger.debug({ jid: destinationJid, timestamp: existingTokenEntry?.timestamp }, 'tctoken expired, clearing')
			tcTokenBuffer = undefined
			// Preserve senderTimestamp so the fire-and-forget issuance dedupe survives cleanup.
			const cleared =
				existingTokenEntry?.senderTimestamp !== undefined
					? { token: Buffer.alloc(0), senderTimestamp: existingTokenEntry.senderTimestamp }
					: null
			try {
				await keys.set({ tctoken: { [tcTokenJid]: cleared } })
			} catch (err: any) {
				logger.debug({ jid: destinationJid, err: err?.message }, 'failed to persist tctoken expiry cleanup')
			}
		}

		if (tcTokenBuffer?.length && adapter.serverProps.privacyTokenOn1to1) {
			;(stanza.content as BinaryNode[]).push({
				tag: 'tctoken',
				attrs: {},
				content: tcTokenBuffer
			})
		}

		if (additionalNodes && additionalNodes.length > 0) {
			;(stanza.content as BinaryNode[]).push(...additionalNodes)
		}

		logger.debug({ msgId }, `sending message to ${participants.length} devices`)

		// A server phash mismatch comes back on the <ack>; keep what a WA Web-style resend to the missing
		// devices needs (consumed once, see `resendGroupMsgToMissingDevices`).
		if (isGroup && !participant && adapter.groupFanoutRecords && stanza.attrs.phash) {
			adapter.groupFanoutRecords.set(msgId, {
				group: destinationJid,
				sentPhash: stanza.attrs.phash,
				oldAsSent: devices.map(d => d.jid),
				oldFiltered: selectPhashFanoutJids(devices, meId, meLid),
				addressingMode: stanza.attrs.addressing_mode || 'pn',
				stanzaAttrs: Object.fromEntries(
					Object.entries(stanza.attrs).filter(([k]) => !['id', 'to', 'type', 'phash'].includes(k))
				),
				// always set on this path (group branch); the fallback only satisfies the type
				message: patchedGroupMessage ?? message,
				extraAttrs: { ...extraAttrs },
				trailingNodes: [...(reportingNodeSent ? [reportingNodeSent] : []), ...(additionalNodes || [])],
				sentAt: Date.now()
			})
		}

		await adapter.sendNode(stanza)

		// Fire-and-forget: issue our token to the contact AFTER message send.
		// WA Web skips protocol messages and PSA/bot contacts (TcTokenChatAction: isRegularUser)
		const isProtocolMsg = !!normalizeMessageContent(message)?.protocolMessage
		const isBotOrPSA = destinationJid === PSA_WID || isJidBot(destinationJid) || isJidMetaAI(destinationJid)
		if (
			is1on1Send &&
			!isProtocolMsg &&
			!isBotOrPSA &&
			shouldSendNewTcToken(existingTokenEntry?.senderTimestamp) &&
			!inFlightTcTokenIssuance.has(tcTokenJid)
		) {
			inFlightTcTokenIssuance.add(tcTokenJid)
			const issueTimestamp = unixTimestampSeconds()
			const getPNForLID = (lid: string) => signal.lidMapping.getPNForLID(lid)
			resolveIssuanceJid(destinationJid, adapter.serverProps.lidTrustedTokenIssueToLid, getLIDForPN, getPNForLID)
				.then(issueJid => issuePrivacyTokens(adapter, [issueJid], issueTimestamp))
				.then(async result => {
					await storeTcTokensFromIqResult({
						result,
						fallbackJid: tcTokenJid,
						keys,
						getLIDForPN
					})

					const currentData = await keys.get('tctoken', [tcTokenJid])
					const currentEntry = currentData[tcTokenJid]
					const indexWrite = await buildMergedTcTokenIndexWrite(keys, [tcTokenJid])
					await keys.set({
						tctoken: {
							[tcTokenJid]: {
								token: Buffer.alloc(0),
								...currentEntry,
								senderTimestamp: issueTimestamp
							},
							...indexWrite
						}
					})
				})
				.catch(err => {
					logger.debug({ jid: destinationJid, err: err?.message }, 'fire-and-forget tctoken issuance failed')
				})
				.finally(() => {
					inFlightTcTokenIssuance.delete(tcTokenJid)
				})
		}

		// Add message to retry cache if enabled
		if (adapter.messageRetryManager && !participant) {
			adapter.messageRetryManager.addRecentMessage(destinationJid, msgId, message)
		}
	}, meId)

	return msgId
}

export const getMessageType = (message: proto.IMessage) => {
	const normalizedMessage = normalizeMessageContent(message)
	if (!normalizedMessage) return 'text'

	if (normalizedMessage.reactionMessage || normalizedMessage.encReactionMessage) {
		return 'reaction'
	}

	if (
		normalizedMessage.pollCreationMessage ||
		normalizedMessage.pollCreationMessageV2 ||
		normalizedMessage.pollCreationMessageV3 ||
		normalizedMessage.pollUpdateMessage
	) {
		return 'poll'
	}

	if (normalizedMessage.eventMessage) {
		return 'event'
	}

	if (getMediaType(normalizedMessage) !== '') {
		return 'media'
	}

	return 'text'
}

export const getMediaType = (message: proto.IMessage) => {
	if (message.imageMessage) {
		return 'image'
	} else if (message.videoMessage) {
		return message.videoMessage.gifPlayback ? 'gif' : 'video'
	} else if (message.audioMessage) {
		return message.audioMessage.ptt ? 'ptt' : 'audio'
	} else if (message.contactMessage) {
		return 'vcard'
	} else if (message.documentMessage) {
		return 'document'
	} else if (message.contactsArrayMessage) {
		return 'contact_array'
	} else if (message.liveLocationMessage) {
		return 'livelocation'
	} else if (message.stickerMessage) {
		return 'sticker'
	} else if (message.listMessage) {
		return 'list'
	} else if (message.listResponseMessage) {
		return 'list_response'
	} else if (message.buttonsResponseMessage) {
		return 'buttons_response'
	} else if (message.orderMessage) {
		return 'order'
	} else if (message.productMessage) {
		return 'product'
	} else if (message.interactiveResponseMessage) {
		return 'native_flow_response'
	} else if (message.groupInviteMessage) {
		return 'url'
	} else if (isLinkMessage(message)) {
		return 'url'
	}

	return ''
}

export const issuePrivacyTokens = async (adapter: SendCoreAdapter, jids: string[], timestamp?: number) => {
	const t = (timestamp ?? unixTimestampSeconds()).toString()
	const result = await adapter.query({
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'set',
			xmlns: 'privacy'
		},
		content: [
			{
				tag: 'tokens',
				attrs: {},
				content: jids.map(jid => ({
					tag: 'token',
					attrs: {
						jid: jidNormalizedUser(jid),
						t,
						type: 'trusted_contact'
					}
				}))
			}
		]
	})

	return result
}
