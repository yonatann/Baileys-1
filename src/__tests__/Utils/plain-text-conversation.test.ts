import { describe, expect, it } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import { generateWAMessage, toConversationIfPlainText } from '../../Utils/messages'

// Shapes captured live from WA Web 2.3000.1050463354 on 2026-10-15 (1:1, group, community):
// plain text goes out as `conversation`; reply, mention and link preview keep
// `extendedTextMessage`.
const jid = '100000000000001@lid'
const opts = {
	userJid: '200000000000002@s.whatsapp.net',
	upload: async () => {
		throw new Error('no upload expected')
	}
}

const contentKeys = (msg: WAMessage) =>
	Object.keys(proto.Message.toObject(msg.message as proto.Message)).filter(k => k !== 'messageContextInfo')

describe('plain text as conversation (WA Web parity)', () => {
	it('sends plain text as conversation', async () => {
		const msg = await generateWAMessage(jid, { text: 'hello', linkPreview: null }, opts)
		expect(contentKeys(msg)).toEqual(['conversation'])
		expect(msg.message?.conversation).toBe('hello')
	})

	it('keeps extendedTextMessage for a mention', async () => {
		const msg = await generateWAMessage(
			jid,
			{ text: 'hi @100000000000001', mentions: ['100000000000001@lid'], linkPreview: null },
			opts
		)
		expect(contentKeys(msg)).toEqual(['extendedTextMessage'])
		expect(msg.message?.extendedTextMessage?.contextInfo?.mentionedJid).toEqual(['100000000000001@lid'])
	})

	it('keeps extendedTextMessage for a reply', async () => {
		const quoted: WAMessage = {
			key: { remoteJid: jid, fromMe: false, id: '3EB0AAAAAAAAAAAAAAAAAA' },
			message: { conversation: 'original' }
		}
		const msg = await generateWAMessage(jid, { text: 'reply', linkPreview: null }, { ...opts, quoted })
		expect(contentKeys(msg)).toEqual(['extendedTextMessage'])
		expect(msg.message?.extendedTextMessage?.contextInfo?.stanzaId).toBe('3EB0AAAAAAAAAAAAAAAAAA')
	})

	it('keeps extendedTextMessage for a link preview', async () => {
		const msg = await generateWAMessage(
			jid,
			{
				text: 'see https://example.com',
				linkPreview: { 'canonical-url': 'https://example.com', 'matched-text': 'https://example.com', title: 'Example' }
			},
			opts
		)
		expect(contentKeys(msg)).toEqual(['extendedTextMessage'])
	})

	it('keeps extendedTextMessage in a disappearing chat (contextInfo.expiration)', async () => {
		const msg = await generateWAMessage(
			jid,
			{ text: 'ttl', linkPreview: null },
			{ ...opts, ephemeralExpiration: 86400 }
		)
		expect(contentKeys(msg)).toEqual(['extendedTextMessage'])
	})

	it('preserves messageContextInfo when rewriting', () => {
		const secret = new Uint8Array(32).fill(7)
		const out = toConversationIfPlainText({
			extendedTextMessage: { text: 'x' },
			messageContextInfo: { messageSecret: secret }
		})
		expect(out).toEqual({ conversation: 'x', messageContextInfo: { messageSecret: secret } })
	})
})
