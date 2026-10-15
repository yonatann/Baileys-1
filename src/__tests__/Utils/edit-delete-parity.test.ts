import { proto } from '../../../WAProto/index.js'
import { shouldHideDecryptFail } from '../../Utils/decrypt-fail'
import { isRevokeMessage, shouldIncludeReportingToken } from '../../Utils/reporting-utils'

// Shapes captured from WA Web 2.3000.1050463354 (1:1, group, community):
//   delete: <message type=text edit=7> enc WITHOUT decrypt-fail, NO <reporting>
//   edit:   <message type=text edit=1> enc decrypt-fail="hide", WITH <reporting>
const key: proto.IMessageKey = { remoteJid: '100000000000002@lid', fromMe: true, id: '3EB0C0FFEE0000000000AA' }
const secret = new Uint8Array(32).fill(7)

const revoke: proto.IMessage = {
	protocolMessage: { key, type: proto.Message.ProtocolMessage.Type.REVOKE },
	messageContextInfo: { messageSecret: secret }
}

const plainEdit: proto.IMessage = {
	protocolMessage: {
		key,
		type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
		editedMessage: { conversation: 'edited' },
		timestampMs: 1
	},
	messageContextInfo: { messageSecret: secret }
}

const secretEdit: proto.IMessage = {
	secretEncryptedMessage: {
		targetMessageKey: key,
		encIv: new Uint8Array(12),
		encPayload: new Uint8Array(16),
		secretEncType: proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT
	},
	messageContextInfo: { messageSecret: secret }
}

describe('edit/delete stanza parity with WA Web', () => {
	describe('<reporting> on delete', () => {
		it('a revoke is not reported', () => {
			expect(isRevokeMessage(revoke)).toBe(true)
		})

		it('an edit and ordinary messages are still reported', () => {
			expect(isRevokeMessage(plainEdit)).toBe(false)
			expect(shouldIncludeReportingToken(plainEdit)).toBe(true)
			expect(isRevokeMessage({ conversation: 'hi' })).toBe(false)
		})
	})

	describe('decrypt-fail="hide"', () => {
		it('edits are hidden (plain protocolMessage and secret-encrypted)', () => {
			expect(shouldHideDecryptFail(plainEdit)).toBe(true)
			expect(shouldHideDecryptFail(secretEdit)).toBe(true)
		})

		it('a delete is not hidden', () => {
			expect(shouldHideDecryptFail(revoke)).toBe(false)
		})

		it('keeps the existing reaction and pin behaviour', () => {
			expect(shouldHideDecryptFail({ reactionMessage: { key, text: '👍' } })).toBe(true)
			expect(shouldHideDecryptFail({ pinInChatMessage: { key } })).toBe(true)
		})

		it('covers the other add-ons WA Web hides', () => {
			expect(shouldHideDecryptFail({ pollUpdateMessage: { vote: { encPayload: new Uint8Array(1) } } })).toBe(true)
			expect(shouldHideDecryptFail({ keepInChatMessage: { key } })).toBe(true)
			expect(shouldHideDecryptFail({ encReactionMessage: { targetMessageKey: key } })).toBe(true)
			expect(
				shouldHideDecryptFail({
					protocolMessage: { type: proto.Message.ProtocolMessage.Type.EPHEMERAL_SYNC_RESPONSE }
				})
			).toBe(true)
		})

		it('ordinary content is not hidden', () => {
			expect(shouldHideDecryptFail({ conversation: 'hi' })).toBe(false)
			expect(shouldHideDecryptFail({ extendedTextMessage: { text: 'hi' } })).toBe(false)
			expect(shouldHideDecryptFail({ imageMessage: {} })).toBe(false)
			expect(shouldHideDecryptFail(undefined)).toBe(false)
		})

		it('looks through ephemeral wrappers', () => {
			expect(shouldHideDecryptFail({ ephemeralMessage: { message: plainEdit } })).toBe(true)
		})
	})
})
