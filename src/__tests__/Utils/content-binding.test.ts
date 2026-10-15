import {
	appendContentBindings,
	deriveRcatKey,
	generateContentBinding,
	getContentBindingSource,
	getContentIdString,
	isLinkMessage,
	makeBindingOnlyParticipantNodes,
	makeContentBindings,
	RCAT_MAX_RECIPIENTS,
	toRcatUserJid
} from '../../Utils/content-binding'
import type { BinaryNode } from '../../WABinary'

// Vectors computed independently (Python hmac/hashlib, RFC 5869 HKDF with an
// empty salt) from WA Web's WAWebMsgRcatUtils derivation:
//   key = HKDF(messageSecret, info = stanzaId + fromJid + toJid + 'Rcat', 32)
//   binding = HMAC-SHA256(key, contentId)[0:8]
const SECRET = Uint8Array.from({ length: 32 }, (_, i) => i)
const STANZA_ID = '3EB0C0FFEE0000000000AA'
const SENDER = '100000000000001@lid'
const PEER = '100000000000002@lid'
const URL = 'https://example.com/page'

describe('content binding (WA Web rcat parity)', () => {
	it('derives the rcat key like WA Web deriveNonce', () => {
		expect(deriveRcatKey(SECRET, STANZA_ID, SENDER, PEER).toString('hex')).toBe(
			'0ad60d7c7aaacf4b9d188fbc4247f1dc663204c8f18ca05396cf7174dff2a563'
		)
	})

	it('produces 8-byte bindings matching the reference vectors', () => {
		const peer = generateContentBinding(deriveRcatKey(SECRET, STANZA_ID, SENDER, PEER), URL)
		expect(peer).toHaveLength(8)
		expect(peer.toString('hex')).toBe('4c3211d65babb159')

		const self = generateContentBinding(deriveRcatKey(SECRET, STANZA_ID, SENDER, SENDER), URL)
		expect(self.toString('hex')).toBe('9b174003d03c37b2')

		const pn = generateContentBinding(
			deriveRcatKey(SECRET, STANZA_ID, '15550000001@s.whatsapp.net', '15550000002@s.whatsapp.net'),
			'dQw4w9WgXcQ'
		)
		expect(pn.toString('hex')).toBe('bba4b6bedb169429')
	})

	it('uses the YouTube video id as the content id, else the matched text', () => {
		expect(getContentIdString('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1')).toBe('dQw4w9WgXcQ')
		expect(getContentIdString('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
		expect(getContentIdString('https://m.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
		expect(getContentIdString(URL)).toBe(URL)
		expect(getContentIdString('')).toBeUndefined()
		expect(getContentIdString(undefined)).toBeUndefined()
	})

	it('reduces device JIDs to user JIDs (widToUserJid)', () => {
		expect(toRcatUserJid('100000000000002:23@lid')).toBe(PEER)
		expect(toRcatUserJid('15550000002:4@s.whatsapp.net')).toBe('15550000002@s.whatsapp.net')
		expect(toRcatUserJid('15550000002@c.us')).toBe('15550000002@s.whatsapp.net')
	})

	it('classifies only extendedText with matchedText as a link (mediatype=url)', () => {
		expect(isLinkMessage({ extendedTextMessage: { text: `see ${URL}`, matchedText: URL } })).toBe(true)
		expect(isLinkMessage({ extendedTextMessage: { text: 'hi', matchedText: '  ' } })).toBe(false)
		expect(isLinkMessage({ extendedTextMessage: { text: 'hi' } })).toBe(false)
		expect(isLinkMessage({ conversation: URL })).toBe(false)
	})

	it('needs both a link and a messageSecret', () => {
		const link = { extendedTextMessage: { text: URL, matchedText: URL } }
		expect(getContentBindingSource(link)).toBeUndefined()
		expect(getContentBindingSource({ ...link, messageContextInfo: { messageSecret: SECRET } })).toEqual({
			messageSecret: SECRET,
			contentId: URL
		})
		expect(
			getContentBindingSource({ extendedTextMessage: { text: 'hi' }, messageContextInfo: { messageSecret: SECRET } })
		).toBeUndefined()
	})

	describe('stanza nodes', () => {
		const source = { messageSecret: SECRET, contentId: URL }
		const bindings = makeContentBindings({ source, stanzaId: STANZA_ID, senderJid: SENDER, recipientCount: 2 })!

		const toNode = (jid: string): BinaryNode => ({
			tag: 'to',
			attrs: { jid },
			content: [{ tag: 'enc', attrs: { v: '2', type: 'msg', mediatype: 'url' }, content: new Uint8Array(1) }]
		})

		it('sender_content_binding is the binding for the sender user (sender device ignored)', () => {
			const fromDevice = makeContentBindings({
				source,
				stanzaId: STANZA_ID,
				senderJid: '100000000000001:7@lid',
				recipientCount: 2
			})!
			for (const b of [bindings, fromDevice]) {
				const node = b.senderNode()!
				expect(node.tag).toBe('sender_content_binding')
				expect(Buffer.from(node.content as Uint8Array).toString('hex')).toBe('9b174003d03c37b2')
			}
		})

		it('1:1: every <to> (own devices too) gets the chat user binding after <enc>', () => {
			const nodes = [toNode('100000000000002:20@lid'), toNode('100000000000002@lid'), toNode('100000000000001:48@lid')]
			appendContentBindings(nodes, bindings, () => PEER)
			for (const node of nodes) {
				const [enc, binding] = node.content as BinaryNode[]
				expect(enc!.tag).toBe('enc')
				expect(binding!.tag).toBe('content_binding')
				expect(Buffer.from(binding!.content as Uint8Array).toString('hex')).toBe('4c3211d65babb159')
			}
		})

		it('group: each <to> gets its own device user binding', () => {
			const nodes = [toNode('100000000000002:3@lid'), toNode('100000000000001:48@lid')]
			appendContentBindings(nodes, bindings, jid => jid)
			const hex = nodes.map(n => Buffer.from((n.content as BinaryNode[])[1]!.content as Uint8Array).toString('hex'))
			expect(hex).toEqual(['4c3211d65babb159', '9b174003d03c37b2'])
		})

		it('group without sender-key distribution: binding-only <to> nodes', () => {
			const nodes = makeBindingOnlyParticipantNodes(['100000000000002:3@lid'], bindings)
			expect(nodes).toHaveLength(1)
			expect(nodes[0]!.attrs.jid).toBe('100000000000002:3@lid')
			const [only] = nodes[0]!.content as BinaryNode[]
			expect(only!.tag).toBe('content_binding')
			expect((nodes[0]!.content as BinaryNode[]).some(c => c.tag === 'enc')).toBe(false)
		})

		it('no bindings for an empty or oversized recipient list', () => {
			expect(makeContentBindings({ source, stanzaId: STANZA_ID, senderJid: SENDER, recipientCount: 0 })).toBeUndefined()
			expect(
				makeContentBindings({ source, stanzaId: STANZA_ID, senderJid: SENDER, recipientCount: RCAT_MAX_RECIPIENTS + 1 })
			).toBeUndefined()
			expect(
				makeContentBindings({ source, stanzaId: STANZA_ID, senderJid: SENDER, recipientCount: RCAT_MAX_RECIPIENTS })
			).toBeDefined()
		})
	})
})
