import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { proto } from '../../WAProto/index.js'
import { DEFAULT_CACHE_TTLS, WA_DEFAULT_EPHEMERAL } from '../Defaults'
import type { SendCoreAdapter } from '../SendCore'
import * as sendCore from '../SendCore'
import { GroupFanoutRecordStore } from '../Utils/group-phash-resend'
import type {
	AnyMessageContent,
	MediaConnInfo,
	MessageReceiptType,
	MessageRelayOptions,
	MiscMessageGenerationOptions,
	SocketConfig,
	WAMessage,
	WAMessageKey
} from '../Types'
import {
	aggregateMessageKeysNotFromMe,
	assertMediaContent,
	bindWaitForEvent,
	decryptMediaRetryData,
	DEF_MEDIA_HOST,
	DEFAULT_LID_REFETCH_THROTTLE_SEC,
	encryptMediaRetryRequest,
	generateMessageIDV2,
	generateWAMessage,
	getPeerDataOperationStanzaAttrs,
	getStatusCodeForMediaRetry,
	getUrlFromDirectPath,
	getWAUploadToServer,
	isReactionRevoke,
	MessageRetryManager,
	unixTimestampSeconds
} from '../Utils'
import { getUrlInfo } from '../Utils/link-preview'
import { makeKeyedMutex, makeMutex } from '../Utils/make-mutex'
import { encryptMessageEdit } from '../Utils/message-edit-secret'
import { captureUploadHandle } from '../Utils/newsletter-stanza'
import {
	type BinaryNode,
	type BinaryNodeAttributes,
	getBinaryNodeChild,
	getBinaryNodeChildren,
	isJidGroup,
	isJidNewsletter,
	isLidUser,
	isPnUser,
	jidNormalizedUser,
	type JidWithDevice,
	S_WHATSAPP_NET
} from '../WABinary'
import { makeNewsletterSocket } from './newsletter'

export const makeMessagesSocket = (config: SocketConfig) => {
	const {
		logger,
		linkPreviewImageThumbnailWidth,
		generateHighQualityLinkPreview,
		options: httpRequestOptions,
		patchMessageBeforeSending,
		cachedGroupMetadata,
		enableRecentMessageCache,
		maxMsgRetryCount
	} = config
	const sock = makeNewsletterSocket(config)
	const {
		ev,
		authState,
		messageMutex,
		signalRepository,
		upsertMessage,
		query,
		fetchPrivacySettings,
		sendNode,
		groupMetadata,
		groupToggleEphemeral,
		registerSocketEndHandler
	} = sock

	/**
	 * Set of tctoken storage JIDs with a fire-and-forget `issuePrivacyTokens` IQ in flight.
	 * Prevents duplicate IQs from rapid back-to-back sends before `senderTimestamp` persists.
	 * Entries are always removed in `.finally()`, so the set is bounded by concurrency.
	 */
	const inFlightTcTokenIssuance = new Set<string>()

	const userDevicesCache =
		config.userDevicesCache ||
		new NodeCache<JidWithDevice[]>({
			stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, // 5 minutes
			useClones: false
		})
	/** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
	const devicesMutex = makeMutex()

	/**
	 * Per-LID cooldown for the identity force-refetch on newly-mapped LIDs (D3 / BE#660).
	 * Throttles repeated `assertSessions(lids, true)` for the same LID during LID-mapping churn
	 * to avoid an identity-fetch storm that WhatsApp rate-limits.
	 */
	const lidForceRefetchThrottle = new NodeCache<boolean>({
		stdTTL: DEFAULT_LID_REFETCH_THROTTLE_SEC,
		useClones: false
	})

	// Initialize message retry manager if enabled
	const messageRetryManager = enableRecentMessageCache ? new MessageRetryManager(logger, maxMsgRetryCount) : null

	// Prevent race conditions in Signal session encryption by user
	const encryptionMutex = makeKeyedMutex()

	/**
	 * The send core (`src/SendCore`) is transport-agnostic; this adapter binds it to this socket's
	 * websocket, signal store and auth state. The state objects above are shared with the rest of the
	 * socket (device notifications, retry receipts) through the returned socket surface as before.
	 */
	const groupFanoutRecords = new GroupFanoutRecordStore()

	const adapter: SendCoreAdapter = {
		logger,
		me: () => authState.creds.me,
		account: () => authState.creds.account,
		signal: signalRepository,
		keys: authState.keys,
		sendNode,
		query,
		executeUSyncQuery: sock.executeUSyncQuery,
		groupMetadata,
		cachedGroupMetadata,
		patchMessageBeforeSending,
		serverProps: sock.serverProps,
		userDevicesCache,
		devicesMutex,
		lidForceRefetchThrottle,
		encryptionMutex,
		inFlightTcTokenIssuance,
		groupFanoutRecords,
		messageRetryManager
	}

	/** Fetch all the devices we've to send a message to */
	const getUSyncDevices = (jids: string[], useCache: boolean, ignoreZeroDevices: boolean) =>
		sendCore.getUSyncDevices(adapter, jids, useCache, ignoreZeroDevices)

	const assertSessions = (jids: string[], force?: boolean) => sendCore.assertSessions(adapter, jids, force)

	const createParticipantNodes = (
		recipientJids: string[],
		message: proto.IMessage,
		extraAttrs?: BinaryNode['attrs'],
		dsmMessage?: proto.IMessage,
		opts?: { rejectOnPrimaryDeviceFailure?: boolean }
	) => sendCore.createParticipantNodes(adapter, recipientJids, message, extraAttrs, dsmMessage, opts)

	const relayMessage = (jid: string, message: proto.IMessage, options: MessageRelayOptions) =>
		sendCore.buildAndRelay(adapter, jid, message, options)

	const issuePrivacyTokens = (jids: string[], timestamp?: number) =>
		sendCore.issuePrivacyTokens(adapter, jids, timestamp)

	let mediaConn: Promise<MediaConnInfo> | undefined
	/** Per-socket media host; updated whenever media_conn is fetched. Defaults to the public WhatsApp host. */
	let mediaHost: string = DEF_MEDIA_HOST
	const refreshMediaConn = async (forceGet = false): Promise<MediaConnInfo> => {
		const media = await mediaConn
		if (!media || forceGet || new Date().getTime() - media.fetchDate.getTime() > media.ttl * 1000) {
			mediaConn = (async () => {
				const result = await query({
					tag: 'iq',
					attrs: {
						type: 'set',
						xmlns: 'w:m',
						to: S_WHATSAPP_NET
					},
					content: [{ tag: 'media_conn', attrs: {} }]
				})
				const mediaConnNode = getBinaryNodeChild(result, 'media_conn')!
				// TODO: explore full length of data that whatsapp provides
				const node: MediaConnInfo = {
					hosts: getBinaryNodeChildren(mediaConnNode, 'host').map(({ attrs }) => ({
						hostname: attrs.hostname!,
						maxContentLengthBytes: +attrs.maxContentLengthBytes!
					})),
					auth: mediaConnNode.attrs.auth!,
					ttl: +mediaConnNode.attrs.ttl!,
					fetchDate: new Date()
				}
				logger.debug('fetched media conn')
				if (node.hosts[0]) {
					mediaHost = node.hosts[0].hostname
				}

				return node
			})()
		}

		return mediaConn!
	}

	/**
	 * generic send receipt function
	 * used for receipts of phone call, read, delivery etc.
	 * */
	const sendReceipt = async (
		jid: string,
		participant: string | undefined,
		messageIds: string[],
		type: MessageReceiptType
	) => {
		if (!messageIds || messageIds.length === 0) {
			throw new Boom('missing ids in receipt')
		}

		const node: BinaryNode = {
			tag: 'receipt',
			attrs: {
				id: messageIds[0]!
			}
		}
		const isReadReceipt = type === 'read' || type === 'read-self'
		if (isReadReceipt) {
			node.attrs.t = unixTimestampSeconds().toString()
		}

		if (type === 'sender' && (isPnUser(jid) || isLidUser(jid))) {
			node.attrs.recipient = jid
			node.attrs.to = participant!
		} else {
			node.attrs.to = jid
			if (participant) {
				node.attrs.participant = participant
			}
		}

		if (type) {
			node.attrs.type = type
		}

		const remainingMessageIds = messageIds.slice(1)
		if (remainingMessageIds.length) {
			node.content = [
				{
					tag: 'list',
					attrs: {},
					content: remainingMessageIds.map(id => ({
						tag: 'item',
						attrs: { id }
					}))
				}
			]
		}

		logger.debug({ attrs: node.attrs, messageIds }, 'sending receipt for messages')
		await sendNode(node)
	}

	/** Correctly bulk send receipts to multiple chats, participants */
	const sendReceipts = async (keys: WAMessageKey[], type: MessageReceiptType) => {
		const recps = aggregateMessageKeysNotFromMe(keys)
		for (const { jid, participant, messageIds } of recps) {
			await sendReceipt(jid, participant, messageIds, type)
		}
	}

	/** Bulk read messages. Keys can be from different chats & participants */
	const readMessages = async (keys: WAMessageKey[]) => {
		const privacySettings = await fetchPrivacySettings()
		// based on privacy settings, we have to change the read type
		const readType = privacySettings.readreceipts === 'all' ? 'read' : 'read-self'
		await sendReceipts(keys, readType)
	}

	/**
	 * Update Member Label
	 */
	const updateMemberLabel = (jid: string, memberLabel: string) => {
		return relayMessage(
			jid,
			{
				protocolMessage: {
					type: proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE,
					memberLabel: {
						label: memberLabel?.slice(0, 30),
						labelTimestamp: unixTimestampSeconds()
					}
				}
			},
			{
				additionalNodes: [
					{
						tag: 'meta',
						attrs: {
							tag_reason: 'user_update',
							appdata: 'member_tag'
						},
						content: undefined
					}
				]
			}
		)
	}

	const sendPeerDataOperationMessage = async (
		pdoMessage: proto.Message.IPeerDataOperationRequestMessage
	): Promise<string> => {
		//TODO: for later, abstract the logic to send a Peer Message instead of just PDO - useful for App State Key Resync with phone
		if (!authState.creds.me?.id) {
			throw new Boom('Not authenticated')
		}

		const protocolMessage: proto.IMessage = {
			protocolMessage: {
				peerDataOperationRequestMessage: pdoMessage,
				type: proto.Message.ProtocolMessage.Type.PEER_DATA_OPERATION_REQUEST_MESSAGE
			}
		}

		const meJid = jidNormalizedUser(authState.creds.me.id)

		const msgId = await relayMessage(meJid, protocolMessage, {
			// privacy_sensitive=1 for HISTORY_SYNC_ON_DEMAND, like WA Web (b07@655635/779113)
			additionalAttributes: getPeerDataOperationStanzaAttrs(pdoMessage.peerDataOperationRequestType),
			additionalNodes: [
				{
					tag: 'meta',
					attrs: { appdata: 'default' }
				}
			]
		})

		return msgId
	}

	const waUploadToServer = getWAUploadToServer(config, refreshMediaConn)

	const waitForMsgMediaUpdate = bindWaitForEvent(ev, 'messages.media-update')

	registerSocketEndHandler(() => {
		if (!config.userDevicesCache && userDevicesCache.close) {
			userDevicesCache.close()
		}

		lidForceRefetchThrottle.close?.()

		mediaConn = undefined
		if (messageRetryManager) {
			messageRetryManager.clear()
		}

		groupFanoutRecords.clear()
	})

	/** WA Web `resendGroupMsg` for a group `<ack phash>` mismatch, see `SendCore/group-resend`. */
	const resendGroupMsgToMissingDevices = (opts: { msgId: string; serverPhash: string; ackTimeMs: number }) =>
		sendCore.resendGroupMsgToMissingDevices(
			{
				...adapter,
				sessionRegistrationId: async jid => (await signalRepository.getSessionInfo(jid))?.registrationId,
				localRegistrationId: () => authState.creds.registrationId
			},
			opts
		)

	return {
		...sock,
		userDevicesCache,
		devicesMutex,
		issuePrivacyTokens,
		assertSessions,
		relayMessage,
		resendGroupMsgToMissingDevices,
		sendReceipt,
		sendReceipts,
		readMessages,
		refreshMediaConn,
		// Function (not getter) so the spread in chats.ts preserves the live closure binding.
		getMediaHost: () => mediaHost,
		waUploadToServer,
		fetchPrivacySettings,
		sendPeerDataOperationMessage,
		createParticipantNodes,
		getUSyncDevices,
		messageRetryManager,
		updateMemberLabel,
		updateMediaMessage: async (message: WAMessage) => {
			const content = assertMediaContent(message.message)
			const mediaKey = content.mediaKey!
			const meId = authState.creds.me!.id
			const node = encryptMediaRetryRequest(message.key, mediaKey, meId)

			let error: Error | undefined = undefined
			await Promise.all([
				sendNode(node),
				waitForMsgMediaUpdate(async update => {
					const result = update.find(c => c.key.id === message.key.id)
					if (result) {
						if (result.error) {
							error = result.error
						} else {
							try {
								const media = decryptMediaRetryData(result.media!, mediaKey, result.key.id!)
								if (media.result !== proto.MediaRetryNotification.ResultType.SUCCESS) {
									const resultStr = proto.MediaRetryNotification.ResultType[media.result!]
									throw new Boom(`Media re-upload failed by device (${resultStr})`, {
										data: media,
										statusCode: getStatusCodeForMediaRetry(media.result!) || 404
									})
								}

								content.directPath = media.directPath
								content.url = getUrlFromDirectPath(content.directPath!, mediaHost)

								logger.debug({ directPath: media.directPath, key: result.key }, 'media update successful')
							} catch (err: any) {
								error = err
							}
						}

						return true
					}
				})
			])

			if (error) {
				throw error
			}

			ev.emit('messages.update', [{ key: message.key, update: { message: message.message } }])

			return message
		},
		sendMessage: async (jid: string, content: AnyMessageContent, options: MiscMessageGenerationOptions = {}) => {
			const userJid = authState.creds.me!.id
			if (
				typeof content === 'object' &&
				'disappearingMessagesInChat' in content &&
				typeof content['disappearingMessagesInChat'] !== 'undefined' &&
				isJidGroup(jid)
			) {
				const { disappearingMessagesInChat } = content
				const value =
					typeof disappearingMessagesInChat === 'boolean'
						? disappearingMessagesInChat
							? WA_DEFAULT_EPHEMERAL
							: 0
						: disappearingMessagesInChat
				await groupToggleEphemeral(jid, value)
			} else {
				// channels publish the upload handle as media_id; capture it from the media upload
				const newsletterUpload = isJidNewsletter(jid) ? captureUploadHandle(waUploadToServer) : undefined
				const fullMsg = await generateWAMessage(jid, content, {
					logger,
					userJid,
					getUrlInfo: text =>
						getUrlInfo(text, {
							thumbnailWidth: linkPreviewImageThumbnailWidth,
							fetchOpts: {
								timeout: 3_000,
								...(httpRequestOptions || {})
							},
							logger,
							uploadImage: generateHighQualityLinkPreview ? waUploadToServer : undefined
						}),
					//TODO: CACHE
					getProfilePicUrl: sock.profilePictureUrl,
					getCallLink: sock.createCallLink,
					upload: newsletterUpload?.upload ?? waUploadToServer,
					mediaCache: config.mediaCache,
					options: config.options,
					messageId: generateMessageIDV2(sock.user?.id),
					...options
				})
				const isEventMsg = 'event' in content && !!content.event
				const isDeleteMsg = 'delete' in content && !!content.delete
				const isEditMsg = 'edit' in content && !!content.edit
				const isPinMsg = 'pin' in content && !!content.pin
				const isPollMessage = 'poll' in content && !!content.poll
				const additionalAttributes: BinaryNodeAttributes = {}
				const additionalNodes: BinaryNode[] = []
				// required for delete
				if (isDeleteMsg) {
					// if the chat is a group, and I am not the author, then delete the message as an admin
					if (isJidGroup(content.delete?.remoteJid as string) && !content.delete?.fromMe) {
						additionalAttributes.edit = '8'
					} else {
						additionalAttributes.edit = '7'
					}
				} else if (isEditMsg) {
					additionalAttributes.edit = '1'
				} else if (isPinMsg) {
					additionalAttributes.edit = '2'
				} else if (isReactionRevoke(fullMsg.message)) {
					additionalAttributes.edit = '7'
				} else if (isPollMessage) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							polltype: 'creation'
						}
					} as BinaryNode)
				} else if (isEventMsg) {
					additionalNodes.push({
						tag: 'meta',
						attrs: {
							event_type: 'creation'
						}
					} as BinaryNode)
				}

				// WA Web sends edits secret-encrypted with the edited message's messageSecret
				let relayContent = fullMsg.message!
				let reportingMessage: proto.IMessage | undefined
				const editMessageSecret = isEditMsg && 'editMessageSecret' in content ? content.editMessageSecret : undefined
				const plainEdit = fullMsg.message?.protocolMessage
				if (editMessageSecret && plainEdit) {
					const self = authState.creds.me!.lid || authState.creds.me!.id
					relayContent = encryptMessageEdit(plainEdit, {
						messageSecret: editMessageSecret,
						originalSenderJid: self,
						editSenderJid: self
					})
					// WA Web computes the reporting token over the decrypted edit
					reportingMessage = { protocolMessage: plainEdit, messageContextInfo: { messageSecret: editMessageSecret } }
				}

				await relayMessage(jid, relayContent, {
					messageId: fullMsg.key.id!,
					useCachedGroupMetadata: options.useCachedGroupMetadata,
					additionalAttributes,
					statusJidList: options.statusJidList,
					additionalNodes,
					reportingMessage,
					newsletterMediaHandle: newsletterUpload?.getHandle()
				})
				if (config.emitOwnEvents) {
					process.nextTick(async () => {
						await messageMutex.mutex(() => upsertMessage(fullMsg, 'append'))
					})
				}

				return fullMsg
			}
		}
	}
}
