import type { proto } from '../../WAProto/index.js'
import type { BinaryNode } from '../WABinary'
import { jidDecode } from '../WABinary'
import { hkdf, hmacSign } from './crypto'

/**
 * WA Web `maximum_group_size_for_rcat` AB prop default: no content binding is
 * generated when the recipient (user) list is larger than this.
 */
export const RCAT_MAX_RECIPIENTS = 100

/** WA Web `WAWebPipConst.URL_PATTERNS.ONLINE_VIDEO_URL.YOUTUBE` */
const YOUTUBE_URL_PATTERNS = [
	/^https?:\/\/youtu\.be\/(.{11})/,
	/^https?:\/\/(m\.)?youtube\.com\/watch\?v=(.{11})/,
	/^https?:\/\/(m\.)?youtube\.com\/shorts\/(.{11})/
]

/**
 * A link message, the way WA Web's `mediaTypeFromProtobuf` classifies it
 * (`mediatype="url"` on the enc node, `type="media"` on the message).
 */
export const isLinkMessage = (message: proto.IMessage | null | undefined) =>
	!!message?.extendedTextMessage?.matchedText?.trim()

/**
 * WA Web `WAWebMsgRcatUtils.getContentIdString`: the matched URL, or the video
 * id when it is a YouTube link
 */
export const getContentIdString = (matchedText: string | null | undefined) => {
	if (!matchedText) {
		return undefined
	}

	const withoutWww = matchedText.split('www.').join('')
	for (const pattern of YOUTUBE_URL_PATTERNS) {
		const match = withoutWww.match(pattern)
		if (match) {
			return match[match.length - 1]
		}
	}

	return matchedText
}

/** `user@server` with no device, the form WA Web's `widToUserJid` produces */
export const toRcatUserJid = (jid: string) => {
	const decoded = jidDecode(jid)
	if (!decoded?.user) {
		return undefined
	}

	const server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server
	return `${decoded.user}@${server}`
}

/** WA Web `WAWebMsgRcatUtils.deriveNonce`: HKDF-SHA256, empty salt, 32 bytes */
export const deriveRcatKey = (messageSecret: Uint8Array, stanzaId: string, fromJid: string, toJid: string) =>
	Buffer.from(hkdf(messageSecret, 32, { info: [stanzaId, fromJid, toJid, 'Rcat'].join('') }))

/** HMAC-SHA256(rcatKey, contentId) truncated to 8 bytes */
export const generateContentBinding = (rcatKey: Uint8Array, contentId: string) =>
	hmacSign(Buffer.from(contentId, 'utf8'), rcatKey).subarray(0, 8)

export type ContentBindingSource = {
	messageSecret: Uint8Array
	contentId: string
}

/**
 * Returns what a content binding is computed from, or undefined when WA Web
 * would not send one (not a link message, or no messageSecret).
 */
export const getContentBindingSource = (
	message: proto.IMessage | null | undefined
): ContentBindingSource | undefined => {
	if (!isLinkMessage(message)) {
		return undefined
	}

	const contentId = getContentIdString(message!.extendedTextMessage!.matchedText)
	const messageSecret = message!.messageContextInfo?.messageSecret
	if (!contentId || !messageSecret?.length) {
		return undefined
	}

	return { messageSecret, contentId }
}

/**
 * Builds a per-user content-binding lookup for one send, mirroring WA Web
 * `genContentBindingForMsg`: one 8-byte binding per recipient user JID,
 * derived from the sender user JID. Returns undefined when there are no
 * recipients or more than RCAT_MAX_RECIPIENTS.
 */
export const makeContentBindings = ({
	source,
	stanzaId,
	senderJid,
	recipientCount
}: {
	source: ContentBindingSource
	stanzaId: string
	senderJid: string
	recipientCount: number
}) => {
	const fromJid = toRcatUserJid(senderJid)
	if (!fromJid || recipientCount === 0 || recipientCount > RCAT_MAX_RECIPIENTS) {
		return undefined
	}

	const cache = new Map<string, Buffer>()
	const forUser = (jid: string) => {
		const toJid = toRcatUserJid(jid)
		if (!toJid) {
			return undefined
		}

		let binding = cache.get(toJid)
		if (!binding) {
			binding = generateContentBinding(deriveRcatKey(source.messageSecret, stanzaId, fromJid, toJid), source.contentId)
			cache.set(toJid, binding)
		}

		return binding
	}

	return {
		forUser,
		/** `<sender_content_binding>`: the binding for the sender's own user */
		senderNode: (): BinaryNode | undefined => {
			const binding = forUser(fromJid)
			return binding ? { tag: 'sender_content_binding', attrs: {}, content: binding } : undefined
		},
		/** `<content_binding>` child of a `<to>` node */
		node: (userJid: string): BinaryNode | undefined => {
			const binding = forUser(userJid)
			return binding ? { tag: 'content_binding', attrs: {}, content: binding } : undefined
		}
	}
}

export type ContentBindings = NonNullable<ReturnType<typeof makeContentBindings>>

/**
 * Appends a `<content_binding>` child to each `<to jid>` node. `userJidFor`
 * picks whose binding goes on the node: the chat user for a 1:1 fanout (WA Web
 * keys every device, own devices included, by the chat), or the device's own
 * user for a group fanout.
 */
export const appendContentBindings = (
	toNodes: BinaryNode[],
	bindings: ContentBindings,
	userJidFor: (deviceJid: string) => string
) => {
	for (const node of toNodes) {
		const deviceJid = node.attrs.jid
		if (!deviceJid || !Array.isArray(node.content)) {
			continue
		}

		const binding = bindings.node(userJidFor(deviceJid))
		if (binding) {
			node.content.push(binding)
		}
	}
}

/**
 * Group fanout with no sender-key distribution: WA Web still sends a
 * `<participants>` list of `<to jid>` nodes carrying only `<content_binding>`
 * for the devices that already hold the sender key.
 */
export const makeBindingOnlyParticipantNodes = (deviceJids: string[], bindings: ContentBindings): BinaryNode[] => {
	const nodes: BinaryNode[] = []
	for (const jid of deviceJids) {
		const binding = bindings.node(jid)
		if (binding) {
			nodes.push({ tag: 'to', attrs: { jid }, content: [binding] })
		}
	}

	return nodes
}
