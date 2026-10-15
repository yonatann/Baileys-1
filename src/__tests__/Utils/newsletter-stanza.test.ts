import { proto } from '../../../WAProto/index.js'
import type { WAMediaUploadFunction } from '../../Types'
import { generateWAMessage } from '../../Utils/messages'
import { buildNewsletterMessageNode, captureUploadHandle } from '../../Utils/newsletter-stanza'
import type { BinaryNode } from '../../WABinary'

// synthetic ids only
const JID = '120363000000000001@newsletter'
const NEW_ID = '3EB0AAAAAAAAAAAAAAAAAA'
const ORIGINAL_ID = '3EB0BBBBBBBBBBBBBBBBBB'
const HANDLE = 'wa_channel_image/flat/00000000000000000000000000000000'

const children = (node: BinaryNode) => node.content as BinaryNode[]
const decodePlaintext = (node: BinaryNode) => {
	const plaintext = children(node).find(c => c.tag === 'plaintext')!
	return proto.Message.decode(plaintext.content as Uint8Array)
}

describe('buildNewsletterMessageNode (WA Web channel stanza shapes)', () => {
	it('text: type=text, bare <plaintext>', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: { conversation: 'hello channel' },
			messageType: 'text',
			mediaType: ''
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'text' })
		expect(children(node).map(c => [c.tag, c.attrs])).toEqual([['plaintext', {}]])
		expect(decodePlaintext(node).conversation).toBe('hello channel')
	})

	it('link: stays type=text with no mediatype, even when typed as a url preview', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: {
				extendedTextMessage: { text: 'see https://example.com', matchedText: 'https://example.com', title: 'Example' }
			},
			messageType: 'media',
			mediaType: 'url'
		})
		expect(node.attrs.type).toBe('text')
		expect(node.attrs.media_id).toBeUndefined()
		expect(children(node)[0]!.attrs).toEqual({})
	})

	it('image with an upload handle: type=media, media_id, <plaintext mediatype=image>', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: { imageMessage: { directPath: '/o1/v/t24/f2/m0/x', mimetype: 'image/jpeg' } },
			messageType: 'media',
			mediaType: 'image',
			mediaHandle: HANDLE
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'media', media_id: HANDLE })
		expect(children(node).map(c => [c.tag, c.attrs])).toEqual([['plaintext', { mediatype: 'image' }]])
	})

	it('document without a handle: type=media, no media_id', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: { documentMessage: { directPath: '/o1/v/t24/f2/m0/y', mimetype: 'application/pdf' } },
			messageType: 'media',
			mediaType: 'document'
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'media' })
		expect(children(node)[0]!.attrs).toEqual({ mediatype: 'document' })
	})

	it('poll: type=poll, <meta polltype=creation contenttype=text/> BEFORE <plaintext>, no mediatype', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: {
				pollCreationMessageV3: {
					name: 'Q?',
					options: [{ optionName: 'a' }, { optionName: 'b' }],
					selectableOptionsCount: 1
				}
			},
			messageType: 'poll',
			mediaType: ''
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'poll' })
		expect(children(node).map(c => [c.tag, c.attrs])).toEqual([
			['meta', { polltype: 'creation', contenttype: 'text' }],
			['plaintext', {}]
		])
		expect(decodePlaintext(node).pollCreationMessageV3?.name).toBe('Q?')
	})

	it('edit: id = ORIGINAL id, edit=3, type=text, payload is the new content (no protocolMessage)', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: {
				protocolMessage: {
					key: { remoteJid: JID, fromMe: true, id: ORIGINAL_ID },
					type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
					editedMessage: { conversation: 'edited text' },
					timestampMs: 1
				}
			},
			messageType: 'text',
			mediaType: '',
			// what sendMessage sets for a normal-chat edit
			additionalAttributes: { edit: '1' }
		})
		expect(node.attrs).toEqual({ to: JID, id: ORIGINAL_ID, edit: '3', type: 'text' })
		expect(children(node).map(c => [c.tag, c.attrs])).toEqual([['plaintext', {}]])
		const payload = decodePlaintext(node)
		expect(payload.protocolMessage).toBeFalsy()
		expect(payload.conversation).toBe('edited text')
	})

	it('media edit: type=media with the edited media type on <plaintext>', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: {
				protocolMessage: {
					key: { remoteJid: JID, fromMe: true, id: ORIGINAL_ID },
					type: proto.Message.ProtocolMessage.Type.MESSAGE_EDIT,
					editedMessage: { imageMessage: { caption: 'new caption' } }
				}
			},
			messageType: 'text',
			mediaType: ''
		})
		expect(node.attrs).toEqual({ to: JID, id: ORIGINAL_ID, edit: '3', type: 'media' })
		expect(children(node)[0]!.attrs).toEqual({ mediatype: 'image' })
	})

	it('delete: id = ORIGINAL id, edit=8 (admin revoke, not 7), type=text, empty <plaintext/>', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: {
				protocolMessage: {
					key: { remoteJid: JID, fromMe: true, id: ORIGINAL_ID },
					type: proto.Message.ProtocolMessage.Type.REVOKE
				}
			},
			messageType: 'text',
			mediaType: '',
			// what sendMessage sets for a fromMe delete
			additionalAttributes: { edit: '7' }
		})
		expect(node.attrs).toEqual({ to: JID, id: ORIGINAL_ID, edit: '8', type: 'text' })
		expect(children(node)).toEqual([{ tag: 'plaintext', attrs: {} }])
	})

	it('keeps extra attributes but never lets them override to/id', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: { conversation: 'x' },
			messageType: 'text',
			mediaType: '',
			additionalAttributes: { to: 'other@newsletter', id: 'OTHER', foo: 'bar' }
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'text', foo: 'bar' })
	})

	it('poll with a caller-forced type=text (existing 479 workaround) is relayed unchanged: no <meta>', () => {
		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: { pollCreationMessageV3: { name: 'Q?', options: [{ optionName: 'a' }], selectableOptionsCount: 1 } },
			messageType: 'poll',
			mediaType: '',
			additionalAttributes: { type: 'text' }
		})
		expect(node.attrs).toEqual({ to: JID, id: NEW_ID, type: 'text' })
		expect(children(node).map(c => [c.tag, c.attrs])).toEqual([['plaintext', {}]])
	})
})

describe('captureUploadHandle (upload handle -> media_id)', () => {
	const fakeUpload =
		(handle?: string): WAMediaUploadFunction =>
		async () => ({ mediaUrl: undefined, directPath: '/o1/v/t24/f2/m0/z', handle })

	it('keeps the handle from the newsletter media upload so it can be published as media_id', async () => {
		const capture = captureUploadHandle(fakeUpload('wa_channel_ptt/flat/11111111111111111111111111111111'))
		const msg = await generateWAMessage(
			JID,
			{ document: Buffer.from('synthetic file'), mimetype: 'application/octet-stream', fileName: 'a.bin' },
			{ userJid: '15550000001@s.whatsapp.net', upload: capture.upload }
		)
		expect(msg.message?.documentMessage?.directPath).toBe('/o1/v/t24/f2/m0/z')
		expect(capture.getHandle()).toBe('wa_channel_ptt/flat/11111111111111111111111111111111')

		const node = buildNewsletterMessageNode({
			jid: JID,
			msgId: NEW_ID,
			message: msg.message!,
			messageType: 'media',
			mediaType: 'ptt',
			mediaHandle: capture.getHandle()
		})
		expect(node.attrs.media_id).toBe('wa_channel_ptt/flat/11111111111111111111111111111111')
	})

	it('yields no handle when the upload returns none (e.g. documents)', async () => {
		const capture = captureUploadHandle(fakeUpload(undefined))
		await capture.upload('/dev/null', { fileEncSha256B64: 'x', mediaType: 'document', newsletter: true })
		expect(capture.getHandle()).toBeUndefined()
	})
})
