import { Boom } from '@hapi/boom'
import { assertAppPatchAccepted } from '../../Utils/chat-utils'
import type { BinaryNode } from '../../WABinary'

const result = (collAttrs: Record<string, string>, collContent?: BinaryNode[]): BinaryNode => ({
	tag: 'iq',
	attrs: { type: 'result' },
	content: [
		{
			tag: 'sync',
			attrs: {},
			content: [{ tag: 'collection', attrs: { name: 'regular_low', ...collAttrs }, content: collContent }]
		}
	]
})

const errNode = (code: string, text = 'x'): BinaryNode => ({ tag: 'error', attrs: { code, text } })

describe('assertAppPatchAccepted (WA Web WAWebSyncdResponseParser b07@1268300)', () => {
	it('accepts a normal success collection', () => {
		expect(() => assertAppPatchAccepted(result({ version: '5' }), 'regular_low')).not.toThrow()
	})

	it('accepts a success with has_more_patches', () => {
		expect(() => assertAppPatchAccepted(result({ version: '5', has_more_patches: 'true' }), 'regular_low')).not.toThrow()
	})

	it.each([
		['409', 'conflict'],
		['400', 'fatal'],
		['404', 'fatal'],
		['500', 'retry']
	])('throws Boom for collection error %s (%s)', (code, state) => {
		let err: any
		try {
			assertAppPatchAccepted(result({ type: 'error' }, [errNode(code)]), 'regular_low')
		} catch (e) {
			err = e
		}

		expect(err).toBeInstanceOf(Boom)
		expect(err.output.statusCode).toBe(Number(code))
		expect(err.data).toMatchObject({ collection: 'regular_low', code, state })
	})

	it('only considers the targeted collection', () => {
		const node = result({ name: 'other', type: 'error' }, [errNode('409')])
		expect(() => assertAppPatchAccepted(node, 'regular_low')).not.toThrow()
	})

	it('treats an error collection without <error> child as retryable 500', () => {
		expect(() => assertAppPatchAccepted(result({ type: 'error' }), 'regular_low')).toThrow(/regular_low/)
	})
})
