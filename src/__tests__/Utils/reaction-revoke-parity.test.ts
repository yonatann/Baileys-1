import { proto } from '../../../WAProto/index.js'
import { generateWAMessageContent, isReactionRevoke } from '../../Utils/messages'

// WA Web WAWebSendMsgCommonApi.editAttribute (b006): a REACTION whose text equals
// WAWebDBGetReactions.REVOKED_REACTION_TEXT ("", b007) is sent with
// edit=7 (WAWebAck.EDIT_ATTR.SENDER_REVOKE, b005); any other reaction carries no edit attr.
const key: proto.IMessageKey = {
	remoteJid: '120363000000000001@g.us',
	fromMe: false,
	id: '3EB0C0FFEE0000000000AA',
	participant: '100000000000002@lid'
}

describe('reaction removal stanza parity with WA Web', () => {
	it('an empty-text reaction is a revoke', () => {
		expect(isReactionRevoke({ reactionMessage: { key, text: '', senderTimestampMs: 1 } })).toBe(true)
	})

	it('an emoji reaction is not a revoke', () => {
		expect(isReactionRevoke({ reactionMessage: { key, text: '\u{1F440}', senderTimestampMs: 1 } })).toBe(false)
	})

	it('a non-reaction message is not a revoke', () => {
		expect(isReactionRevoke({ conversation: '' })).toBe(false)
		expect(isReactionRevoke(undefined)).toBe(false)
	})

	it('react {text: ""} generates a revoke; react {text: emoji} does not', async () => {
		const removal = await generateWAMessageContent({ react: { key, text: '' } }, {} as never)
		const set = await generateWAMessageContent({ react: { key, text: '\u{1F440}' } }, {} as never)
		expect(isReactionRevoke(removal)).toBe(true)
		expect(isReactionRevoke(set)).toBe(false)
	})

	it('the revoke survives an encode/decode round-trip', async () => {
		const removal = await generateWAMessageContent({ react: { key, text: '' } }, {} as never)
		const decoded = proto.Message.decode(proto.Message.encode(removal).finish())
		expect(isReactionRevoke(decoded)).toBe(true)
	})
})
