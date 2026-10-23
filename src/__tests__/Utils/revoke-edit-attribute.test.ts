import { revokeEditAttribute } from '../../Utils/messages'

// WA Web WAWebChatSendMessages.sendRevokeMsgs: Revoke.Sender (edit=7) for an own message
// (WAWebMsgActionCapability.canSenderRevokeMsg), Revoke.Admin (edit=8) for someone else's
// message in a group (canAdminRevokeMsg). A channel revoke is edit=8.
const id = '3EB0C0FFEE0000000000AA'
const group = '120363000000000001@g.us'

describe('revoke edit attribute parity with WA Web', () => {
	it('an own message is a sender revoke in any chat', () => {
		expect(revokeEditAttribute({ remoteJid: '100000000000002@lid', fromMe: true, id })).toBe('7')
		expect(revokeEditAttribute({ remoteJid: '972500000000@s.whatsapp.net', fromMe: true, id })).toBe('7')
		expect(revokeEditAttribute({ remoteJid: group, fromMe: true, id })).toBe('7')
	})

	it("someone else's group message is an admin revoke", () => {
		expect(revokeEditAttribute({ remoteJid: group, fromMe: false, id, participant: '100000000000003@lid' })).toBe(
			'8'
		)
	})

	it('a channel revoke is edit=8', () => {
		expect(revokeEditAttribute({ remoteJid: '120363000000000002@newsletter', fromMe: true, id })).toBe('8')
		expect(revokeEditAttribute({ remoteJid: '120363000000000002@newsletter', fromMe: false, id })).toBe('8')
	})

	it("someone else's message outside a group cannot be revoked", () => {
		for (const remoteJid of ['100000000000002@lid', '972500000000@s.whatsapp.net', 'status@broadcast']) {
			expect(() => revokeEditAttribute({ remoteJid, fromMe: false, id })).toThrow(
				expect.objectContaining({ output: expect.objectContaining({ statusCode: 400 }) })
			)
		}
	})

	it('a key with no fromMe is not treated as own', () => {
		expect(() => revokeEditAttribute({ remoteJid: '100000000000002@lid', id })).toThrow()
		expect(revokeEditAttribute({ remoteJid: group, id })).toBe('8')
	})
})
