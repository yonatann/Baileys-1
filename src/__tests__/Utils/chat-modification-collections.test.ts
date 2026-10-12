import { chatModificationToAppPatch } from '../../Utils/chat-utils'

const JID = '1234567890@s.whatsapp.net'

describe('chat modification collection routing (C7 / WA Web parity)', () => {
	it('routes a star mutation to regular_high (WA Web WAWebStarMessageSync collectionName = RegularHigh, b10.js@791524)', () => {
		const patch = chatModificationToAppPatch(
			{ star: { messages: [{ id: 'ABC', fromMe: false, remoteJid: JID }], star: true } } as any,
			JID
		)
		expect(patch.type).toBe('regular_high')
		expect(patch.index[0]).toBe('star')
	})
})
