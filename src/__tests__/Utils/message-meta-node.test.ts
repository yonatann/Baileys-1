import { describe, expect, it } from '@jest/globals'
import type { proto } from '../../../WAProto/index.js'
import { deriveMetaAttrs, isViewOnceMessage, withDerivedMetaNode } from '../../Utils/message-meta-node'
import type { BinaryNode } from '../../WABinary'

const vote: proto.IMessage = {
	pollUpdateMessage: {
		pollCreationMessageKey: { remoteJid: '1@g.us', id: 'POLL1' },
		vote: { encPayload: Buffer.alloc(8, 1), encIv: Buffer.alloc(12, 2) }
	}
}
const image: proto.Message.IImageMessage = { mimetype: 'image/jpeg' }

describe('deriveMetaAttrs (WAWebSendMsgMetaNode parity)', () => {
	it('poll vote -> polltype=vote', () => {
		expect(deriveMetaAttrs(vote)).toEqual({ polltype: 'vote' })
	})

	it('a pollUpdateMessage without a vote gets no attrs', () => {
		expect(deriveMetaAttrs({ pollUpdateMessage: { pollCreationMessageKey: { id: 'P' } } })).toEqual({})
	})

	it('view-once wrappers v1 / v2 / v2-extension -> view_once=true', () => {
		for (const wrapper of ['viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension'] as const) {
			expect(deriveMetaAttrs({ [wrapper]: { message: { imageMessage: image } } })).toEqual({ view_once: 'true' })
		}
	})

	it('inner viewOnce flag on image / video / audio -> view_once=true', () => {
		expect(isViewOnceMessage({ imageMessage: { ...image, viewOnce: true } })).toBe(true)
		expect(isViewOnceMessage({ videoMessage: { viewOnce: true } })).toBe(true)
		expect(isViewOnceMessage({ audioMessage: { viewOnce: true } })).toBe(true)
	})

	it('derives from the unwrapped message (ephemeral / document-with-caption wrappers)', () => {
		expect(deriveMetaAttrs({ ephemeralMessage: { message: vote } })).toEqual({ polltype: 'vote' })
		expect(
			deriveMetaAttrs({ ephemeralMessage: { message: { viewOnceMessage: { message: { imageMessage: image } } } } })
		).toEqual({ view_once: 'true' })
		expect(deriveMetaAttrs({ ephemeralMessage: { message: { imageMessage: { ...image, viewOnce: true } } } })).toEqual({
			view_once: 'true'
		})
	})

	it('view_once is media-only: a view-once wrapper around text or a contact gets none', () => {
		expect(deriveMetaAttrs({ viewOnceMessage: { message: { conversation: 'hi' } } })).toEqual({})
		expect(deriveMetaAttrs({ viewOnceMessageV2: { message: { contactMessage: { displayName: 'x' } } } })).toEqual({})
	})

	it('regular media, viewOnce=false and text carry no view_once (never "false")', () => {
		expect(deriveMetaAttrs({ imageMessage: image })).toEqual({})
		expect(deriveMetaAttrs({ imageMessage: { ...image, viewOnce: false } })).toEqual({})
		expect(deriveMetaAttrs({ conversation: 'hi' })).toEqual({})
	})
})

describe('withDerivedMetaNode', () => {
	it('returns the input untouched when nothing is derived', () => {
		const nodes: BinaryNode[] = [{ tag: 'biz', attrs: {} }]
		expect(withDerivedMetaNode(nodes, { conversation: 'hi' })).toBe(nodes)
		expect(withDerivedMetaNode(undefined, { conversation: 'hi' })).toBeUndefined()
	})

	it('adds a single <meta> node when the caller gave none', () => {
		expect(withDerivedMetaNode(undefined, vote)).toEqual([{ tag: 'meta', attrs: { polltype: 'vote' } }])
		const biz: BinaryNode = { tag: 'biz', attrs: {} }
		expect(withDerivedMetaNode([biz], vote)).toEqual([biz, { tag: 'meta', attrs: { polltype: 'vote' } }])
	})

	it('merges into the caller <meta> (caller attrs win) without mutating the input', () => {
		const callerMeta: BinaryNode = { tag: 'meta', attrs: { polltype: 'creation', appdata: 'default' } }
		const input = [callerMeta]
		const out = withDerivedMetaNode(input, {
			viewOnceMessage: { message: { imageMessage: image } },
			...vote
		})
		expect(out).toEqual([{ tag: 'meta', attrs: { polltype: 'creation', appdata: 'default', view_once: 'true' } }])
		expect(out!.filter(n => n.tag === 'meta')).toHaveLength(1)
		expect(callerMeta.attrs).toEqual({ polltype: 'creation', appdata: 'default' })
		expect(input).toHaveLength(1)
	})
})
