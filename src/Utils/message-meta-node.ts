import type { proto } from '../../WAProto/index.js'
import type { BinaryNode, BinaryNodeAttributes } from '../WABinary'

/**
 * Attributes of the `<meta>` child WA Web adds to a `<message>` stanza, limited to the ones the
 * fork derives from the message itself. Shapes follow WAWebSendMsgMetaNode (wa-web-dump):
 * - `polltype="vote"` when `pollUpdateMessage.vote` is set
 * - `view_once="true"` when the media is view-once (attribute dropped otherwise, never "false")
 */
export type DerivedMetaAttrs = Partial<Record<'polltype' | 'view_once', string>>

const isViewOnceMedia = (message: proto.IMessage): boolean =>
	message.imageMessage?.viewOnce === true ||
	message.videoMessage?.viewOnce === true ||
	message.audioMessage?.viewOnce === true

/** the message is view-once: a view-once wrapper (checked before unwrapping) or a media flag */
export const isViewOnceMessage = (message: proto.IMessage): boolean => {
	const wrapper = message.viewOnceMessage ?? message.viewOnceMessageV2 ?? message.viewOnceMessageV2Extension
	return !!wrapper || isViewOnceMedia(message)
}

export const isPollVoteMessage = (message: proto.IMessage): boolean => !!message.pollUpdateMessage?.vote

export const deriveMetaAttrs = (message: proto.IMessage): DerivedMetaAttrs => {
	const attrs: DerivedMetaAttrs = {}
	if (isPollVoteMessage(message)) attrs.polltype = 'vote'
	if (isViewOnceMessage(message)) attrs.view_once = 'true'
	return attrs
}

/**
 * Returns `additionalNodes` with the derived attributes on ONE `<meta>` node, like WA Web (a single
 * node carries all attributes). An existing `<meta>` from the caller is kept and only gains the
 * attributes it does not already set; the input array and its nodes are not mutated.
 */
export const withDerivedMetaNode = (
	additionalNodes: BinaryNode[] | undefined,
	message: proto.IMessage
): BinaryNode[] | undefined => {
	const derived = deriveMetaAttrs(message)
	if (!Object.keys(derived).length) return additionalNodes

	const nodes = additionalNodes ?? []
	const existing = nodes.findIndex(n => n.tag === 'meta')
	if (existing === -1) return [...nodes, { tag: 'meta', attrs: { ...derived } }]

	const current = nodes[existing]!
	const attrs: BinaryNodeAttributes = { ...derived, ...current.attrs }
	return nodes.map((n, i) => (i === existing ? { ...current, attrs } : n))
}
