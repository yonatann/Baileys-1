import { describe, expect, it } from '@jest/globals'
import type { proto } from '../../../WAProto/index.js'
import * as barrel from '../../Utils/index'
import { FUTURE_PROOF_WRAPPERS, getFutureProofMessage, normalizeMessageContent } from '../../Utils/message-content'

describe('FUTURE_PROOF_WRAPPERS', () => {
	it('is exported from the Utils barrel (and so the package root)', () => {
		expect(barrel.FUTURE_PROOF_WRAPPERS).toBe(FUTURE_PROOF_WRAPPERS)
	})

	it('lists the nine wrappers in priority order', () => {
		expect([...FUTURE_PROOF_WRAPPERS]).toEqual([
			'ephemeralMessage',
			'viewOnceMessage',
			'documentWithCaptionMessage',
			'viewOnceMessageV2',
			'viewOnceMessageV2Extension',
			'editedMessage',
			'associatedChildMessage',
			'groupStatusMessage',
			'groupStatusMessageV2'
		])
	})

	it.each(FUTURE_PROOF_WRAPPERS)(
		'%s is peeled by normalizeMessageContent and returned by getFutureProofMessage',
		wrapper => {
			const inner: proto.IMessage = { conversation: 'inner' }
			const wrapped: proto.IMessage = { [wrapper]: { message: inner } }
			expect(getFutureProofMessage(wrapped)?.message).toBe(inner)
			expect(normalizeMessageContent(wrapped)).toBe(inner)
		}
	)

	it('the first listed wrapper wins when a message carries two', () => {
		const first: proto.IMessage = { conversation: 'first' }
		const second: proto.IMessage = { conversation: 'second' }
		const both: proto.IMessage = {
			groupStatusMessageV2: { message: second },
			ephemeralMessage: { message: first }
		}
		expect(getFutureProofMessage(both)?.message).toBe(first)
	})

	it('a plain or empty message has no wrapper', () => {
		expect(getFutureProofMessage({ conversation: 'x' })).toBeUndefined()
		expect(getFutureProofMessage(null)).toBeUndefined()
		expect(getFutureProofMessage(undefined)).toBeUndefined()
	})
})
