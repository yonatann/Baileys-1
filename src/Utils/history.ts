import { pipeline } from 'stream/promises'
import { promisify } from 'util'
import { createInflate, inflate } from 'zlib'
import { proto } from '../../WAProto/index.js'
import type { Chat, Contact, LIDMapping, WAMessage, WAMessageKey } from '../Types'
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
 * HISTORY_SYNC_ON_DEMAND request body, field-for-field what WA Web builds (b07@784600-785634):
 * {chatJid, oldestMsgId, oldestMsgFromMe, onDemandMsgCount, oldestMsgTimestampMs, supportInlineResponse:true}.
 * WA Web never populates `accountLid` (proto field 6) here, so neither do we.
 *
 * `supportInlineResponse` (field 7) is WA Web's `!0`, but it tells the phone to answer INLINE in a
 * PEER_DATA_OPERATION_REQUEST_RESPONSE instead of a history-sync notification; process-message does not
 * consume inline history responses, so it is OPT-IN here (default omitted) to avoid breaking on-demand history.
 */
export const buildHistorySyncOnDemandRequest = ({
	count,
	oldestMsgKey,
	oldestMsgTimestamp,
	supportInlineResponse
}: {
	count: number
	oldestMsgKey: WAMessageKey
	oldestMsgTimestamp: number | Long
	supportInlineResponse?: boolean
}): proto.Message.PeerDataOperationRequestMessage.IHistorySyncOnDemandRequest => ({
	chatJid: oldestMsgKey.remoteJid,
	oldestMsgFromMe: oldestMsgKey.fromMe,
	oldestMsgId: oldestMsgKey.id,
	oldestMsgTimestampMs: oldestMsgTimestamp,
	onDemandMsgCount: count,
	...(supportInlineResponse ? { supportInlineResponse: true } : {})
})

/**
 * Stanza attrs for a peer-data-operation message. WA Web sets `privacy_sensitive` to
 * PrivacySensitiveType.OnDemand (=1, b07@647234) for HISTORY_SYNC_ON_DEMAND only (b07@779113 `F(e)`,
 * unless justknob 4199); stanza attr emitted at b07@655635.
 */
export const getPeerDataOperationStanzaAttrs = (
	requestType: proto.Message.PeerDataOperationRequestType | null | undefined
): { [key: string]: string } => ({
	category: 'peer',
	push_priority: 'high_force',
	...(requestType === proto.Message.PeerDataOperationRequestType.HISTORY_SYNC_ON_DEMAND
		? { privacy_sensitive: '1' }
		: {})
})
