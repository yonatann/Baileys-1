import { proto } from '../../../WAProto/index.js'
import { getDeliveryReceiptType } from '../../Utils/messages'

describe('getDeliveryReceiptType (WA Web sendDeliveryReceipt parity)', () => {
	it('plain text -> typeless delivery receipt, regardless of online state', () => {
		expect(getDeliveryReceiptType({ conversation: 'hi' })).toBeUndefined()
		expect(getDeliveryReceiptType({ extendedTextMessage: { text: 'hi' } })).toBeUndefined()
	})
	it('media -> typeless', () => {
		expect(getDeliveryReceiptType({ imageMessage: {} })).toBeUndefined()
	})
	it('reaction / enc reaction / keep-in-chat / history bundle+notice -> inactive', () => {
		expect(getDeliveryReceiptType({ reactionMessage: { text: '👍' } })).toBe('inactive')
		expect(getDeliveryReceiptType({ encReactionMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ keepInChatMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ messageHistoryBundle: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ messageHistoryNotice: {} })).toBe('inactive')
	})
	it('unwraps ephemeral wrapper before classifying', () => {
		const m: proto.IMessage = { ephemeralMessage: { message: { reactionMessage: { text: 'x' } } } }
		expect(getDeliveryReceiptType(m)).toBe('inactive')
		const t: proto.IMessage = { ephemeralMessage: { message: { conversation: 'x' } } }
		expect(getDeliveryReceiptType(t)).toBeUndefined()
	})
	it('missing message -> typeless', () => {
		expect(getDeliveryReceiptType(undefined)).toBeUndefined()
		expect(getDeliveryReceiptType(null)).toBeUndefined()
	})
})
