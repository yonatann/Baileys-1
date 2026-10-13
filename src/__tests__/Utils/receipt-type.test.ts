import { proto } from '../../../WAProto/index.js'
import { getDeliveryReceiptType, resolveIncomingReceiptType } from '../../Utils/messages'

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

	it('AB-gated unified-infra addons + memberLabel -> inactive', () => {
		expect(getDeliveryReceiptType({ pollUpdateMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ encEventResponseMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ commentMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ encCommentMessage: {} })).toBe('inactive')
		expect(getDeliveryReceiptType({ protocolMessage: { memberLabel: {} } })).toBe('inactive')
		expect(getDeliveryReceiptType({ protocolMessage: { type: 0 } })).toBeUndefined()
	})
})

describe('resolveIncomingReceiptType branch ordering', () => {
	const react: proto.IMessage = { reactionMessage: { text: 'x' } }
	it('peer category wins over everything', () => {
		expect(resolveIncomingReceiptType({ category: 'peer', fromMe: true, message: react })).toBe('peer_msg')
	})
	it('fromMe -> sender (over content type)', () => {
		expect(resolveIncomingReceiptType({ category: undefined, fromMe: true, message: react })).toBe('sender')
	})
	it('otherwise content-based', () => {
		expect(resolveIncomingReceiptType({ category: undefined, fromMe: false, message: react })).toBe('inactive')
		expect(
			resolveIncomingReceiptType({ category: undefined, fromMe: false, message: { conversation: 'a' } })
		).toBeUndefined()
	})
})
