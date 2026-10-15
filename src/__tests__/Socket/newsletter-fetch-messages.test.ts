import { buildNewsletterFetchMessagesNode, buildNewsletterFetchMessageUpdatesNode } from '../../Socket/newsletter'
import type { BinaryNode } from '../../WABinary'

const JID = '120363000000000001@newsletter'

describe('newsletterFetchMessages (channel history)', () => {
	// verified live 2026-10-15: the server answers this shape; it never answers
	// `<iq to=<channel jid>><message_updates/></iq>` (60s timeout)
	it('asks s.whatsapp.net for <messages type=jid jid=.. count=..>', () => {
		const node = buildNewsletterFetchMessagesNode('tag-1', JID, 30)

		expect(node.attrs).toEqual({ id: 'tag-1', type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' })
		expect(node.content).toEqual([{ tag: 'messages', attrs: { type: 'jid', jid: JID, count: '30' } }])
	})

	it('does not require since/after, and passes them when given', () => {
		const node = buildNewsletterFetchMessagesNode('tag-1', JID, 10, 0, 105)

		expect((node.content as BinaryNode[])[0]!.attrs).toEqual({
			type: 'jid',
			jid: JID,
			count: '10',
			since: '0',
			after: '105'
		})
	})
})

describe('newsletterFetchMessageUpdates (old shape kept)', () => {
	it('sends <message_updates> to the channel jid', () => {
		const node = buildNewsletterFetchMessageUpdatesNode('tag-1', JID, 5)

		expect(node.attrs.to).toBe(JID)
		expect(node.content).toEqual([{ tag: 'message_updates', attrs: { count: '5' } }])
	})
})
