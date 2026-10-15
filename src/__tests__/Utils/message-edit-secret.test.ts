import { proto } from '../../../WAProto/index.js'
import {
	decryptMessageEdit,
	deriveMessageEditKey,
	encryptMessageEdit,
	MESSAGE_EDIT_USE_CASE,
	toEditUserJid
} from '../../Utils/message-edit-secret'

// Vectors computed independently (Python hmac/hashlib HKDF per RFC 5869 with an
// empty salt, and cryptography's AESGCM) from WA Web's derivation:
//   key = HKDF(origSecret, info = origStanzaId + origSender + editSender + 'Message Edit', 32)
//   encPayload = AES-256-GCM(key, iv, encode({ protocolMessage }), no AAD) || tag
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)
const IV = Uint8Array.from({ length: 12 }, (_, i) => i)
const ME = '100000000000001@lid'
const ORIGINAL_ID = '3EB0C0FFEE0000000000AA'

const plainEdit: proto.Message.IProtocolMessage = {
	key: { remoteJid: '100000000000002@lid', fromMe: true, id: ORIGINAL_ID },
	type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
	editedMessage: { extendedTextMessage: { text: 'edited text' } },
	timestampMs: 1760000000000
}

const params = { messageSecret: SECRET, originalSenderJid: ME, editSenderJid: ME }

describe('secret-encrypted message edit (WA Web parity)', () => {
	it('uses the WA Web use-case name', () => {
		expect(MESSAGE_EDIT_USE_CASE).toBe('Message Edit')
	})

	it('derives the edit key from the edited message id and user JIDs', () => {
		expect(deriveMessageEditKey({ ...params, stanzaId: ORIGINAL_ID }).toString('hex')).toBe(
			'397b09dfb8a10c46c10f4cfe76262aac818e96de157c30c1a6fddcd86608c2d6'
		)
		// device suffixes are dropped (widToUserJid)
		expect(
			deriveMessageEditKey({
				...params,
				stanzaId: ORIGINAL_ID,
				originalSenderJid: '100000000000001:5@lid',
				editSenderJid: '100000000000001:5@lid'
			}).toString('hex')
		).toBe('397b09dfb8a10c46c10f4cfe76262aac818e96de157c30c1a6fddcd86608c2d6')
	})

	it('builds secretEncryptedMessage{MESSAGE_EDIT} with the reference payload', () => {
		const msg = encryptMessageEdit(plainEdit, params, IV)
		expect(Object.keys(msg).sort()).toEqual(['messageContextInfo', 'secretEncryptedMessage'])
		expect(msg.messageContextInfo).toEqual({ messageSecret: SECRET })

		const sem = msg.secretEncryptedMessage!
		expect(sem.secretEncType).toBe(proto.Message.SecretEncryptedMessage.SecretEncType.MESSAGE_EDIT)
		expect(sem.targetMessageKey).toEqual(plainEdit.key)
		expect(Buffer.from(sem.encIv!).toString('hex')).toBe('000102030405060708090a0b')
		expect(Buffer.from(sem.encPayload!).toString('hex')).toBe(
			'f1b120bb2e8508c9a515cef5d678cb3b2b092baf4551aeac322ab3a1e237f6e268ea8f0b5ab4c53d1b376caf87bfe529c92733da67d06e93a7acbf523fbb34e6d99b1729cd9286fc4138d78bf524b1e34e3a14bf82acfb65c8cdbfdcd9'
		)
	})

	it('round-trips, and survives protobuf encoding of the outer message', () => {
		const msg = encryptMessageEdit(plainEdit, params)
		const wire = proto.Message.decode(proto.Message.encode(msg).finish())
		const decrypted = decryptMessageEdit(wire.secretEncryptedMessage!, params)
		expect(decrypted.protocolMessage?.editedMessage?.extendedTextMessage?.text).toBe('edited text')
		expect(decrypted.protocolMessage?.key?.id).toBe(ORIGINAL_ID)
	})

	it('fails to decrypt with the wrong secret or sender', () => {
		const msg = encryptMessageEdit(plainEdit, params, IV)
		expect(() =>
			decryptMessageEdit(msg.secretEncryptedMessage!, { ...params, messageSecret: new Uint8Array(32) })
		).toThrow()
		expect(() =>
			decryptMessageEdit(msg.secretEncryptedMessage!, { ...params, editSenderJid: '15550000001@s.whatsapp.net' })
		).toThrow()
	})

	it('requires the edited message key', () => {
		expect(() => encryptMessageEdit({ ...plainEdit, key: undefined }, params)).toThrow()
	})

	it('normalizes c.us to s.whatsapp.net', () => {
		expect(toEditUserJid('15550000001:2@c.us')).toBe('15550000001@s.whatsapp.net')
	})
})
