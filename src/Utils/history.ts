import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { createInflate, inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage } from '../Types'
import { WAMessageStubType } from '../Types'
import { isHostedLidUser, isHostedPnUser, isLidUser, isPnUser } from '../WABinary'
import { toNumber } from './generics'
import type { ILogger } from './logger.js'
import { normalizeMessageContent } from './messages'
import { downloadContentFromMessage } from './messages-media'

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

export const downloadHistory = async (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => {
	const stream = await downloadContentFromMessage(msg, 'md-msg-hist', { options })
	// Pipe decrypted stream directly through zlib inflate
	// This avoids allocating an intermediate buffer for the compressed data
	const inflater = createInflate()
	const chunks: Buffer[] = []
	inflater.on('data', (chunk: Buffer) => chunks.push(chunk))
	await pipeline(stream, inflater)

	const buffer = Buffer.concat(chunks)
	const syncData = proto.HistorySync.decode(buffer)
	return syncData
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
	logger?: ILogger
) => {
	let historyMsg: proto.HistorySync
	if (msg.initialHistBootstrapInlinePayload) {
		historyMsg = proto.HistorySync.decode(await inflatePromise(msg.initialHistBootstrapInlinePayload))
	} else {
		historyMsg = await downloadHistory(msg, options)
	}

	return processHistoryMessage(historyMsg, logger)
}

export const getHistoryMsg = (message: proto.IMessage) => {
	const normalizedContent = !!message ? normalizeMessageContent(message) : undefined
	const anyHistoryMsg = normalizedContent?.protocolMessage?.historySyncNotification!

	return anyHistoryMsg
}

/**
 * `hist_sync` completion receipt policy (WA Web WAWebHandleHistorySyncChunk):
 *  - INITIAL_STATUS_V3: acked BEFORE download (b07@554500-554849, try/catch "Status receipt send failed");
 *    the late receipt at b07@572936 skips V3 precisely because it was already acked. -> ack on receive.
 *  - chunks we do NOT process (config `shouldSyncHistoryMessage` false / unprocessable type): WA Web has no
 *    skip-by-config; it would have processed + acked. Kept as ack-on-receive (unchanged pre-existing behaviour).
 *  - processed chunks: ack only AFTER download + decode + `messaging-history.set` (b07@572936, which in WA Web
 *    comes after handleProgressiveHistorySyncMsgs + setLastHistorySyncedChunk, i.e. after its DB writes).
 *    A download/decode failure throws before the hook, so NO receipt (WA Web: same).
 * Known gap: WA Web also sends an encrypted error receipt on download failure (WAWebSendHistSyncServerErrorReceiptJob,
 * b07@558378/@581741); not implemented here.
 */
export const createHistorySyncAcker = ({
	isProcessable,
	sendHistSyncReceipt
}: {
	isProcessable: (n: proto.Message.IHistorySyncNotification) => boolean
	sendHistSyncReceipt: (msg: WAMessage) => Promise<void>
}) => ({
	/** call when the message is received; acks immediately only for V3 and for chunks we will not process */
	ackOnReceive: async (msg: WAMessage) => {
		const n = getHistoryMsg(msg.message!)
		if (!n) {
			return
		}

		if (n.syncType === proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3 || !isProcessable(n)) {
			await sendHistSyncReceipt(msg)
		}
	},
	/** `onHistorySyncStored` hook: acks processed chunks after store (V3 was already acked on receive) */
	onStored: async (n: proto.Message.IHistorySyncNotification, msg: WAMessage) => {
		if (n.syncType === proto.HistorySync.HistorySyncType.INITIAL_STATUS_V3) {
			return
		}

		await sendHistSyncReceipt(msg)
	}
})
