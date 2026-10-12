import { promisify } from 'util'
import { inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage, isHttpNetworkError } from './messages-media'

export { isHttpNetworkError, markHttpNetworkError } from './messages-media'

const inflatePromise = promisify(inflate)

const extractPnFromMessages = (messages: proto.IHistorySyncMsg[]): string | undefined => {
	for (const msgItem of messages) {
		const message = msgItem.message
		// Only extract from outgoing messages (fromMe: true) in 1:1 chats
		// because userReceipt.userJid is the recipient's JID
		if (!message?.key?.fromMe || !message.userReceipt?.length) {
			continue
		}

		const userJid = message.userReceipt[0]?.userJid
		if (userJid && (isPnUser(userJid) || isHostedPnUser(userJid))) {
			return userJid
		}
	}

	return undefined
}

/**
 * Download + decrypt stage only: the bytes are still deflated. Any failure here is a "download failure" for the
 * hist_sync error receipt (WA Web b07@558374); inflate/decode failures are not (see `downloadHistory`).
 */
const downloadHistoryBytes = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	const chunks: Buffer[] = []
	for await (const chunk of stream) {
		chunks.push(chunk as Buffer)
	}

	return Buffer.concat(chunks)
}

/**
 * @param onDownloadFailed called with the error when the DOWNLOAD stage fails, before it is rethrown. Inflate and
 * decode failures happen after the download and never reach it (WA Web: the decode error goes to the outer catch,
 * no error receipt).
 */
export const downloadHistory = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit,
	onDownloadFailed?: (err: unknown) => Promise<void> | void
) => {
	let compressed: Buffer
	try {
		compressed = await downloadHistoryBytes(msg, options)
	} catch (err) {
		await onDownloadFailed?.(err)
		throw err
	}

	const buffer = await inflatePromise(compressed)
	return proto.HistorySync.decode(buffer)
}

export const processHistoryMessage = (item: proto.IHistorySync, logger?: ILogger) => {
	const messages: WAMessage[] = []
	const contacts: Contact[] = []
	const chats: Chat[] = []
	const lidPnMappings: LIDMapping[] = []

	logger?.trace({ progress: item.progress }, 'processing history of type ' + item.syncType?.toString())

	// Extract LID-PN mappings for all sync types
	for (const m of item.phoneNumberToLidMappings || []) {
		if (m.lidJid && m.pnJid) {
			lidPnMappings.push({ lid: m.lidJid, pn: m.pnJid })
		}
	}

	switch (item.syncType) {
		case proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP:
		case proto.HistorySync.HistorySyncType.RECENT:
		case proto.HistorySync.HistorySyncType.FULL:
		case proto.HistorySync.HistorySyncType.ON_DEMAND:
			for (const chat of item.conversations! as Chat[]) {
				contacts.push({
					id: chat.id!,
					name: chat.displayName || chat.name || chat.username || undefined,
					username: chat.username || undefined,
					lid: chat.lidJid || chat.accountLid || undefined,
					phoneNumber: chat.pnJid || undefined
				})

				const chatId = chat.id!
				const isLid = isLidUser(chatId) || isHostedLidUser(chatId)
				const isPn = isPnUser(chatId) || isHostedPnUser(chatId)
				if (isLid && chat.pnJid) {
					lidPnMappings.push({ lid: chatId, pn: chat.pnJid })
				} else if (isPn && chat.lidJid) {
					lidPnMappings.push({ lid: chat.lidJid, pn: chatId })
				} else if (isLid && !chat.pnJid) {
					// Fallback: extract PN from userReceipt in messages when pnJid is missing
					const pnFromReceipt = extractPnFromMessages(chat.messages || [])
					if (pnFromReceipt) {
						lidPnMappings.push({ lid: chatId, pn: pnFromReceipt })
					}
				}

				const msgs = chat.messages || []
				delete chat.messages

				for (const item of msgs) {
					const message = item.message! as WAMessage
					messages.push(message)

					if (!chat.messages?.length) {
						// keep only the most recent message in the chat array
						chat.messages = [{ message }]
					}

					if (!message.key.fromMe && !chat.lastMessageRecvTimestamp) {
						chat.lastMessageRecvTimestamp = toNumber(message.messageTimestamp)
					}

					if (
						(message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_BSP ||
							message.messageStubType === WAMessageStubType.BIZ_PRIVACY_MODE_TO_FB) &&
						message.messageStubParameters?.[0]
					) {
						contacts.push({
							id: message.key.participant || message.key.remoteJid!,
							verifiedName: message.messageStubParameters?.[0]
						})
					}
				}

				chats.push(chat)
			}

			break
		case proto.HistorySync.HistorySyncType.PUSH_NAME:
			for (const c of item.pushnames!) {
				contacts.push({ id: c.id!, notify: c.pushname! })
			}

			break
	}

	return {
		chats,
		contacts,
		messages,
		lidPnMappings,
		pastParticipants: item.pastParticipants,
		syncType: item.syncType,
		progress: item.progress
	}
}

export const downloadAndProcessHistorySyncNotification = async (
	msg: proto.Message.IHistorySyncNotification,
	options: RequestInit,
	logger?: ILogger,
	onDownloadFailed?: (err: unknown) => Promise<void> | void
) => {
	let historyMsg: proto.HistorySync
	if (msg.initialHistBootstrapInlinePayload) {
		historyMsg = proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
	} else {
		historyMsg = await downloadHistory(msg, options, onDownloadFailed)
	}

	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}

/**
 * `hist_sync` receipt policy (WA Web WAWebHandleHistorySyncChunk, b07):
 *  - INITIAL_STATUS_V3: acked on receive, before download (b07@554640). The post-store chunkAck is a no-op for it.
 *  - a chunk we will not process (config `shouldSyncHistoryMessage` false, or an unprocessable type): WA Web has no
 *    skip-by-config; this is the pre-existing ack-on-receive kept as-is (nothing is stored, so nothing to wait for).
 *  - a processed chunk: acked by `chunkAck` only AFTER download + decode + the `messaging-history.set` hand-off
 *    (b07@572936 is after the store try-block). The library releases it when the event buffer has handed the chunk to
 *    listeners; with `awaitHistorySyncStore` the consumer releases it after its own durable store (see event-buffer.ts).
 *  - only messages from the account itself are processed (WA Web b06@712861 isMeAccount guard): spoofed history
 *    notifications get no receipt.
 *  - a DOWNLOAD failure (not a request-stage HTTP/network failure, b07@557378) sends an encrypted server-error receipt
 *    so the phone re-uploads the chunk (WAWebSendHistSyncServerErrorReceiptJob, b07@558374-558589). Inflate/decode
 *    failures send nothing (b07@559300 outer catch).
 *  - no receipt aggregation across chunks: each chunk's receipt is sent on its own (b07 sends one id per call).
 * Residuals vs WA Web: a failing receipt send throws (WA Web returns silently); the chunk-level in-flight store
 * markChunkForReuploadPending has no equivalent here.
 */
export type HistorySyncAcker = ReturnType<typeof createHistorySyncAcker>

export const createHistorySyncAcker = ({
	shouldSyncHistoryMessage,
	processableTypes,
	sendHistSyncReceipt,
	sendServerErrorReceipt
}: {
	shouldSyncHistoryMessage: (n: proto.Message.IHistorySyncNotification) => boolean
	processableTypes: readonly proto.HistorySync.HistorySyncType[]
	sendHistSyncReceipt: (msg: WAMessage) => Promise<void>
	sendServerErrorReceipt: (remote: string, id: string, mediaKey: Uint8Array) => Promise<void>
}) => {
	// same predicate chats.ts uses to decide whether a history chunk is processed
	const isProcessable = (n: proto.Message.IHistorySyncNotification) =>
		shouldSyncHistoryMessage(n) && processableTypes.includes(n.syncType! as proto.HistorySync.HistorySyncType)

	return {
		/** call when the message is received; acks immediately only for V3 and for chunks we will not process */
		ackOnReceive: async (msg: WAMessage) => {
			// WA Web b06@712861: a history notification not from the account itself is dropped, with no receipt
			if (!msg.key.fromMe) {
				return
			}

			const n = getHistoryMsg(msg.message!)
			if (!n) {
				return
			}

			if (n.syncType === proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3 || !isProcessable(n)) {
				await sendHistSyncReceipt(msg)
			}
		},
		/** download stage failed: send the encrypted server-error receipt unless it was a request-stage network failure */
		onDownloadFailed: async (n: proto.Message.IHistorySyncNotification, msg: WAMessage, err: unknown) => {
			if (isHttpNetworkError(err) || !n.mediaKey) {
				return
			}

			await sendServerErrorReceipt(msg.key.remoteJid!, msg.key.id!, n.mediaKey)
		},
		/**
		 * returns the chunk's receipt thunk, to run once the chunk is stored or handed off. Idempotent: the
		 * receipt is sent at most once per chunk. V3 is already acked on receive, so its thunk does nothing.
		 */
		chunkAck: (n: proto.Message.IHistorySyncNotification, msg: WAMessage) => {
			let sent = false
			return async () => {
				if (sent) {
					return
				}

				sent = true
				if (n.syncType === proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3) {
					return
				}

				await sendHistSyncReceipt(msg)
			}
		}
	}
}
