import { proto } from '../../WAProto/index.js'
import { normalizeMessageContent } from './messages'

const HIDDEN_PROTOCOL_TYPES = new Set<proto.Message.ProtocolMessage.Type | null | undefined>([
	proto.Message.ProtocolMessage.Type.EPHEMERAL_SYNC_RESPONSE,
	proto.Message.ProtocolMessage.Type.REQUEST_WELCOME_MESSAGE,
	proto.Message.ProtocolMessage.Type.GROUP_MEMBER_LABEL_CHANGE
])

/**
 * Whether the `<enc>` nodes carry `decrypt-fail="hide"`, mirroring WA Web
 * `WAWebE2EProtoUtils.decryptFailAttributeFromProtobuf`: the receiver should
 * not show a "waiting for this message" placeholder when it cannot decrypt an
 * add-on (reaction, vote, edit, pin, keep...) of another message.
 */
export const shouldHideDecryptFail = (message: proto.IMessage | null | undefined) => {
	const content = normalizeMessageContent(message)
	if (!content) {
		return false
	}

	if (
		content.reactionMessage ||
		content.encReactionMessage ||
		content.pollUpdateMessage?.vote ||
		content.keepInChatMessage ||
		content.editedMessage ||
		content.pinInChatMessage ||
		content.encEventResponseMessage ||
		content.messageHistoryNotice ||
		content.botInvokeMessage?.message?.protocolMessage?.type ===
			proto.Message.ProtocolMessage.Type.REQUEST_WELCOME_MESSAGE ||
		content.secretEncryptedMessage?.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.EVENT_EDIT ||
		// WA Web sends its (secret-encrypted) message edits with decrypt-fail=hide
		content.secretEncryptedMessage?.secretEncType === proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
	) {
		return true
	}

	const protocolMessage = content.protocolMessage
	return !!protocolMessage && (!!protocolMessage.editedMessage || HIDDEN_PROTOCOL_TYPES.has(protocolMessage.type))
}
