import type { proto } from '../../WAProto/index.js'
import type { WAMessageContent } from '../Types'
import type { BinaryNode, BinaryNodeAttributes } from '../WABinary'
import { getFutureProofMessage, normalizeMessageContent, UNWRAP_DEPTH } from './message-content'

/**
 * Attributes of the `<meta>` child WA Web adds to a `<message>` stanza, limited to the ones the
 * fork derives from the message itself. Shapes follow WAWebSendMsgMetaNode (wa-web-dump), which
 * derives them from the UNWRAPPED protobuf:
 * - `polltype="vote"` when `pollUpdateMessage.vote` is set
 * - `view_once="true"` for view-once media (attribute dropped otherwise, never "false")
 */
export type DerivedMetaAttrs = Partial<Record<'polltype' | 'view_once', string>>

const isViewOnceWrapper = (layer: WAMessageContent): boolean =>
	!!(layer.viewOnceMessage || layer.viewOnceMessageV2 || layer.viewOnceMessageV2Extension)

/** a view-once wrapper anywhere in the wrapper chain (ephemeral > view once > media ...) */
const hasViewOnceWrapper = (message: WAMessageContent): boolean => {
	let layer: WAMessageContent | null | undefined = message
	for (let i = 0; i < UNWRAP_DEPTH && layer; i++) {
		if (isViewOnceWrapper(layer)) return true
		layer = getFutureProofMessage(layer)?.message
	}

	return false
}

/**
 * WA Web sets `view_once` from the media record (`mediaData.isViewOnce`), so only image / video /
 * audio count: a view-once wrapper (what `sendMessage({ viewOnce: true })` produces) or the media's
 * own `viewOnce` flag, with a media message inside.
 */
export const isViewOnceMessage = (message: proto.IMessage): boolean => {
	const content = normalizeMessageContent(message)
	const media = content?.imageMessage ?? content?.videoMessage ?? content?.audioMessage
	if (!media) return false
	return media.viewOnce === true || hasViewOnceWrapper(message)
}

export const isPollVoteMessage = (message: proto.IMessage): boolean =>
	!!normalizeMessageContent(message)?.pollUpdateMessage?.vote

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
