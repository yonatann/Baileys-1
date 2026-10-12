import { chatModificationToAppPatch } from '../../Utils/chat-utils'

// WA Web (WAWebSyncdUtils): the participant segment of a per-message index is the
// sender's JID only for an INCOMING message in a non-user (group/broadcast) chat;
// otherwise '0'. A wrong index never matches on the phone, so the mutation is
// silently not applied.
const GROUP = '120363000000000000@g.us'
const SENDER = '5511999999999@s.whatsapp.net'
const SENDER_LID = '123456789012345@lid'

describe('per-message app-state index participant segment', () => {
	const star = (jid: string, m: { id: string; fromMe?: boolean; participant?: string }) =>
		chatModificationToAppPatch({ star: { messages: [m], star: true } }, jid).index
	const del = (jid: string, key: { id: string; fromMe?: boolean; participant?: string; remoteJid?: string }) =>
		chatModificationToAppPatch({ deleteForMe: { deleteMedia: false, key, timestamp: 1 } }, jid).index

	it('star on an incoming group message carries the sender JID', () => {
		expect(star(GROUP, { id: 'M1', fromMe: false, participant: SENDER })).toEqual(['star', GROUP, 'M1', '0', SENDER])
	})
	it('delete-for-me on an incoming group message carries the sender JID (lid too)', () => {
		expect(del(GROUP, { id: 'M2', fromMe: false, participant: SENDER_LID })).toEqual(['deleteMessageForMe', GROUP, 'M2', '0', SENDER_LID])
	})
	it('own group message keeps 0', () => {
		expect(star(GROUP, { id: 'M3', fromMe: true, participant: SENDER })[4]).toBe('0')
		expect(del(GROUP, { id: 'M3', fromMe: true, participant: SENDER })[4]).toBe('0')
	})
	it('1:1 chats keep 0 even if a participant is present', () => {
		expect(star(SENDER, { id: 'M4', fromMe: false, participant: SENDER })[4]).toBe('0')
		expect(del(SENDER_LID, { id: 'M4', fromMe: false, participant: SENDER })[4]).toBe('0')
	})
	it('no participant → 0', () => {
		expect(star(GROUP, { id: 'M5', fromMe: false })[4]).toBe('0')
	})
})
