import { Boom } from '@hapi/boom'
import { jest } from '@jest/globals'
import { assertAppPatchAccepted, commitAppPatch } from '../../Utils/chat-utils'
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
		expect(() =>
			assertAppPatchAccepted(result({ version: '5', has_more_patches: 'true' }), 'regular_low')
		).not.toThrow()
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
		let err: any
		try {
			assertAppPatchAccepted(result({ type: 'error' }), 'regular_low')
		} catch (e) {
			err = e
		}

		expect(err.output.statusCode).toBe(500)
		expect(err.data).toMatchObject({ code: '500', state: 'retry' })
	})

	it('detects has_more_patches by presence', () => {
		let err: any
		try {
			assertAppPatchAccepted(result({ type: 'error', has_more_patches: '1' }, [errNode('409')]), 'regular_low')
		} catch (e) {
			err = e
		}

		expect(err.data.hasMorePatches).toBe(true)
	})
})

describe('commitAppPatch', () => {
	const okResult = result({ version: '6' })
	const mk = (responses: BinaryNode[]) => {
		const store: any = {}
		const set = jest.fn(async (d: any) => Object.assign(store, d['app-state-sync-version']))
		const transaction = jest.fn(async (fn: () => Promise<any>) => fn())
		const resync = jest.fn(async () => {})
		const queue = [...responses]
		const query = jest.fn(async () => queue.shift()!)
		const state = { version: 6, hash: Buffer.alloc(128), indexValueMap: {} }
		return {
			set,
			transaction,
			resync,
			query,
			opts: {
				name: 'regular_low' as const,
				keys: { transaction, get: async () => ({}), set } as any,
				transactionKey: 'k',
				resync,
				encode: async () => ({ patch: {}, state }),
				buildNode: () => ({ tag: 'iq', attrs: {} }) as BinaryNode,
				query
			}
		}
	}

	it('commits the version on success (pre-sync runs before the transaction)', async () => {
		const m = mk([okResult])
		await commitAppPatch(m.opts)
		expect(m.set).toHaveBeenCalledTimes(1)
		expect(m.resync).toHaveBeenCalledTimes(1)
		expect(m.resync.mock.invocationCallOrder[0]).toBeLessThan(m.transaction.mock.invocationCallOrder[0]!)
	})

	it('does not commit and surfaces a fatal error (400) without retrying', async () => {
		const m = mk([result({ type: 'error' }, [errNode('400')])])
		await expect(commitAppPatch(m.opts)).rejects.toMatchObject({ data: { state: 'fatal', code: '400' } })
		expect(m.set).not.toHaveBeenCalled()
		expect(m.query).toHaveBeenCalledTimes(1)
	})

	it('conflict -> re-sync -> retry -> success commits once', async () => {
		const m = mk([result({ type: 'error' }, [errNode('409')]), okResult])
		await commitAppPatch(m.opts)
		expect(m.query).toHaveBeenCalledTimes(2)
		expect(m.resync).toHaveBeenCalledTimes(2)
		expect(m.set).toHaveBeenCalledTimes(1)
	})

	it('persistent conflict throws after bounded attempts, never committing', async () => {
		const c = () => result({ type: 'error' }, [errNode('409')])
		const m = mk([c(), c(), c(), c()])
		await expect(commitAppPatch(m.opts)).rejects.toMatchObject({ data: { state: 'conflict' } })
		expect(m.query).toHaveBeenCalledTimes(3)
		expect(m.set).not.toHaveBeenCalled()
	})
})
