import type { BinaryNode } from '../WABinary'

/**
 * `<call>` control actions whose ACK carries the action tag as `type`
 * (`<ack class="call" type="group_update">`), as captured from WA Web by
 * meowcaller (signaling.BuildCallControlAck). Other call actions stay typeless.
 */
const TYPED_CALL_ACK_ACTIONS = new Set([
	'group_update',
	'enc_rekey',
	'waiting_room_update',
	'user_action',
	'screen_share'
])

const callAckType = (node: BinaryNode): string | undefined => {
	if (node.tag !== 'call' || !Array.isArray(node.content)) return undefined
	const action = node.content[0]?.tag
	return action && TYPED_CALL_ACK_ACTIONS.has(action) ? action : undefined
}

/**
 * Builds an ACK stanza for a received node.
 * Pure function -- no I/O, no side effects.
 *
 * Mirrors WhatsApp Web's ACK construction:
 * - WAWebHandleMsgSendAck.sendAck / sendNack
 * - WAWebCreateNackFromStanza.createNackFromStanza
 */
export function buildAckStanza(node: BinaryNode, errorCode?: number, meId?: string): BinaryNode {
	const { tag, attrs } = node
	const stanza: BinaryNode = {
		tag: 'ack',
		attrs: {
			id: attrs.id!,
			to: attrs.from!,
			class: tag
		}
	}

	if (errorCode) {
		stanza.attrs.error = errorCode.toString()
	}

	if (attrs.participant) {
		stanza.attrs.participant = attrs.participant
	}

	if (attrs.recipient) {
		stanza.attrs.recipient = attrs.recipient
	}

	// WA Web always includes type when present: `n.type || DROP_ATTR`
	const type = attrs.type || callAckType(node)
	if (type) {
		stanza.attrs.type = type
	}

	// WA Web WAWebHandleMsgSendAck.sendAck/sendNack always include `from` for message-class ACKs
	if (tag === 'message' && meId) {
		stanza.attrs.from = meId
	}

	return stanza
}
