import { randomBytes } from 'crypto'
import { proto } from '../../WAProto/index.js'
import { jidDecode } from '../WABinary'
import { aesDecryptGCM, aesEncryptGCM, hkdf } from './crypto'

/** WA Web `WAUseCaseSecret.UseCaseSecretModificationType.MESSAGE_EDIT` */
export const MESSAGE_EDIT_USE_CASE = 'Message Edit'

const NO_AAD = Buffer.alloc(0)

/** `user@server` with no device (WA Web `widToUserJid`) */
export const toEditUserJid = (jid: string) => {
	const decoded = jidDecode(jid)
	if (!decoded?.user) {
		throw new Error(`invalid jid for message edit: ${jid}`)
	}

	return `${decoded.user}@${decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server}`
}

/**
 * WA Web `WAUseCaseSecret.createUseCaseSecret` for "Message Edit":
 * HKDF-SHA256(original messageSecret, empty salt,
 *   info = originalStanzaId + originalSenderUserJid + editSenderUserJid + "Message Edit", 32)
 */
export const deriveMessageEditKey = ({
	messageSecret,
	stanzaId,
	originalSenderJid,
	editSenderJid
}: {
	messageSecret: Uint8Array
	stanzaId: string
	originalSenderJid: string
	editSenderJid: string
}) =>
	Buffer.from(
		hkdf(messageSecret, 32, {
			info: [stanzaId, toEditUserJid(originalSenderJid), toEditUserJid(editSenderJid), MESSAGE_EDIT_USE_CASE].join('')
		})
	)

export type MessageEditSecretParams = {
	/** messageSecret of the message being edited */
	messageSecret: Uint8Array
	/** who sent the message being edited (us), LID preferred like WA Web */
	originalSenderJid: string
	/** who sends the edit (us), LID preferred like WA Web */
	editSenderJid: string
}

/**
 * Wraps a MESSAGE_EDIT protocolMessage the way WA Web sends edits
 * (WAWebCreateEncryptedMessageEditMsgData + WAWebGenerateSecretMessageEditProto):
 * the `{ protocolMessage }` proto is AES-256-GCM encrypted (12-byte IV, no AAD)
 * with the "Message Edit" use-case key and sent as
 * `secretEncryptedMessage{ secretEncType: MESSAGE_EDIT }`, carrying the edited
 * message's own messageSecret in messageContextInfo.
 */
export const encryptMessageEdit = (
	edit: proto.Message.IProtocolMessage,
	{ messageSecret, originalSenderJid, editSenderJid }: MessageEditSecretParams,
	iv: Uint8Array = randomBytes(12)
): proto.IMessage => {
	const targetMessageKey = edit.key
	if (!targetMessageKey?.id) {
		throw new Error('message edit needs the key of the edited message')
	}

	const key = deriveMessageEditKey({ messageSecret, stanzaId: targetMessageKey.id, originalSenderJid, editSenderJid })
	const plaintext = proto.Message.encode({ protocolMessage: edit }).finish()

	return {
		secretEncryptedMessage: {
			targetMessageKey,
			encIv: iv,
			encPayload: aesEncryptGCM(plaintext, key, iv, NO_AAD),
			secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
		},
		messageContextInfo: { messageSecret }
	}
}

/** Inverse of encryptMessageEdit: returns the `{ protocolMessage }` proto */
export const decryptMessageEdit = (
	secretEncryptedMessage: proto.Message.ISecretEncryptedMessage,
	{ messageSecret, originalSenderJid, editSenderJid }: MessageEditSecretParams
) => {
	const { targetMessageKey, encIv, encPayload } = secretEncryptedMessage
	if (!targetMessageKey?.id || !encIv || !encPayload) {
		throw new Error('incomplete secret-encrypted message edit')
	}

	const key = deriveMessageEditKey({ messageSecret, stanzaId: targetMessageKey.id, originalSenderJid, editSenderJid })
	return proto.Message.decode(aesDecryptGCM(encPayload, key, encIv, NO_AAD))
}
