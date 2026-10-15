import { proto } from '../../WAProto/index.js'
import type { WAMediaUploadFunction } from '../Types'
import type { BinaryNode, BinaryNodeAttributes } from '../WABinary'
import { encodeNewsletterMessage } from './generics'
import { normalizeMessageContent } from './messages'

export type NewsletterStanzaInput = {
	/** newsletter jid (`...@newsletter`) */
	jid: string
	/** id generated for this send; replaced by the original id for an edit or a delete */
	msgId: string
	/** message as it will be published (after patchMessageBeforeSending) */
	message: proto.IMessage
	/** `<message type>` as computed for normal chats */
	messageType: string
	/** `<plaintext mediatype>` as computed for normal chats ('' when none) */
	mediaType: string
	/** upload `handle` of the media, published as `media_id` when present */
	mediaHandle?: string
	additionalAttributes?: BinaryNodeAttributes
}

/**
 * Builds the `<message>` stanza WA Web publishes to a channel.
 * Shapes come from the WA Web publish builders (WASmaxOutMessagePublishNewsletter*):
 * - text:   type=text, <plaintext>
 * - media:  type=media, media_id=<upload handle>, <plaintext mediatype=..>
 * - poll:   type=poll, <meta polltype=creation contenttype=text/> before <plaintext>
 * - edit:   id=<original id>, edit=3, payload = the new content (not a protocolMessage)
 * - delete: id=<original id>, edit=8, type=text, empty <plaintext/>
 */
export const buildNewsletterMessageNode = ({
	jid,
	msgId,
	message,
	messageType,
	mediaType,
	mediaHandle,
	additionalAttributes
}: NewsletterStanzaInput): BinaryNode => {
	// `edit` set by sendMessage (7/1 for normal chats) never applies to channels
	const extraAttrs = withoutKeys(additionalAttributes || {}, ['edit'])
	const content = normalizeMessageContent(message)
	const protocolMessage = content?.protocolMessage
	const originalId = protocolMessage?.key?.id

	if (protocolMessage?.type === proto.Message.ProtocolMessage.Type.REVOKE && originalId) {
		return {
			tag: 'message',
			attrs: { to: jid, id: originalId, edit: '8', type: 'text', ...stripIdentity(extraAttrs) },
			content: [{ tag: 'plaintext', attrs: {} }]
		}
	}

	if (
		protocolMessage?.type === proto.Message.ProtocolMessage.Type.MESSAGE_EDIT &&
		originalId &&
		protocolMessage.editedMessage
	) {
		const edited = protocolMessage.editedMessage
		const editedMediaType = newsletterMediaType(edited)
		return {
			tag: 'message',
			attrs: {
				to: jid,
				id: originalId,
				edit: '3',
				type: editedMediaType ? 'media' : 'text',
				...stripIdentity(extraAttrs)
			},
			content: [
				{
					tag: 'plaintext',
					attrs: editedMediaType ? { mediatype: editedMediaType } : {},
					content: encodeNewsletterMessage(edited)
				}
			]
		}
	}

	const bytes = encodeNewsletterMessage(message)
	// a caller may force `type` (e.g. a poll relayed as type=text); keep that stanza exactly as asked
	if (isPollCreation(content) && (extraAttrs.type === undefined || extraAttrs.type === 'poll')) {
		return {
			tag: 'message',
			attrs: { to: jid, id: msgId, ...stripIdentity(extraAttrs), type: 'poll' },
			content: [
				{ tag: 'meta', attrs: { polltype: 'creation', contenttype: 'text' } },
				{ tag: 'plaintext', attrs: {}, content: bytes }
			]
		}
	}

	// a link (preview or not) is published as text, without mediatype
	const channelMediaType = mediaType === 'url' ? '' : mediaType
	const type = channelMediaType ? 'media' : messageType === 'media' ? 'text' : messageType
	return {
		tag: 'message',
		attrs: {
			to: jid,
			id: msgId,
			type,
			...(channelMediaType && mediaHandle ? { media_id: mediaHandle } : {}),
			...stripIdentity(extraAttrs),
			...(extraAttrs.type ? { type: extraAttrs.type } : {})
		},
		content: [
			{
				tag: 'plaintext',
				attrs: channelMediaType ? { mediatype: channelMediaType } : {},
				content: bytes
			}
		]
	}
}

const withoutKeys = (attrs: BinaryNodeAttributes, keys: string[]): BinaryNodeAttributes =>
	Object.fromEntries(Object.entries(attrs).filter(([key]) => !keys.includes(key)))

const stripIdentity = (attrs: BinaryNodeAttributes) => withoutKeys(attrs, ['to', 'id', 'type'])

const isPollCreation = (content: proto.IMessage | undefined) =>
	!!(content?.pollCreationMessage || content?.pollCreationMessageV2 || content?.pollCreationMessageV3)

const newsletterMediaType = (message: proto.IMessage): string => {
	const content = normalizeMessageContent(message)
	if (content?.imageMessage) return 'image'
	if (content?.videoMessage) return content.videoMessage.gifPlayback ? 'gif' : 'video'
	if (content?.audioMessage) return content.audioMessage.ptt ? 'ptt' : 'audio'
	if (content?.documentMessage) return 'document'
	if (content?.stickerMessage) return 'sticker'
	return ''
}

/**
 * Wraps an upload function so the media `handle` from the upload response can be
 * published as the channel `media_id` (WA Web: UnencryptedMediaEntry.handle -> mediaHandle).
 * Only the last upload's handle is kept; a media-cache hit does no upload and yields none.
 */
export const captureUploadHandle = (upload: WAMediaUploadFunction) => {
	let handle: string | undefined
	const wrapped: WAMediaUploadFunction = async (filePath, opts) => {
		const result = await upload(filePath, opts)
		handle = result.handle
		return result
	}

	return { upload: wrapped, getHandle: () => handle }
}
