import { extractGroupMetadata } from '../../Socket/groups'
import { coalesceInflight, resolveTruncatedGroups } from '../../Utils/group-fetch'
import type { GroupMetadata } from '../../Types'
import type { BinaryNode } from '../../WABinary'

const meta = (id: string, extra: Partial<GroupMetadata> = {}): GroupMetadata =>
	({ id, subject: id, participants: [], ...extra }) as GroupMetadata

describe('extractGroupMetadata truncated flag (WAWebGroupQueryJob / WASmaxInGroupsTruncatedGroupInfoMixin)', () => {
	it('flags <group truncated="true" size="N"> and keeps size', () => {
		const node: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: [{ tag: 'group', attrs: { id: '1203630000', truncated: 'true', size: '25000', creation: '1', s_t: '1' } }]
		}
		const m = extractGroupMetadata(node)
		expect(m.truncated).toBe(true)
		expect(m.size).toBe(25000)
		expect(m.participants).toEqual([])
	})

	it('does not flag a normal group', () => {
		const node: BinaryNode = {
			tag: 'result',
			attrs: {},
			content: [{ tag: 'group', attrs: { id: '1203630001', creation: '1', s_t: '1' } }]
		}
		expect(extractGroupMetadata(node).truncated).toBeUndefined()
	})
})

describe('resolveTruncatedGroups', () => {
	it('re-fetches truncated groups one at a time and replaces the empty record', async () => {
		const order: string[] = []
		const full = meta('b@g.us', { participants: [{ id: 'x@lid' } as any] })
		const out = await resolveTruncatedGroups(
			[meta('a@g.us', { participants: [{ id: 'p@lid' } as any] }), meta('b@g.us', { truncated: true, size: 9 })],
			async jid => {
				order.push(jid)
				return full
			}
		)
		expect(order).toEqual(['b@g.us'])
		expect(out.map(g => g.id)).toEqual(['a@g.us', 'b@g.us'])
		expect(out[1]!.participants).toHaveLength(1)
		expect(out[1]!.truncated).toBeUndefined()
	})

	it('drops a truncated group whose re-fetch fails (never emits an empty participant list)', async () => {
		const out = await resolveTruncatedGroups([meta('b@g.us', { truncated: true, size: 9 })], async () => {
			throw new Error('boom')
		})
		expect(out).toEqual([])
	})
})

describe('coalesceInflight', () => {
	it('shares one in-flight call, then runs again once settled', async () => {
		let calls = 0
		let release!: () => void
		const gate = new Promise<void>(r => (release = r))
		const fn = coalesceInflight(async () => {
			calls++
			await gate
			return calls
		})
		const a = fn()
		const b = fn()
		release()
		expect(await a).toBe(1)
		expect(await b).toBe(1)
		expect(calls).toBe(1)
		expect(await fn()).toBe(2)
	})

	it('a rejection clears the slot so the next call retries', async () => {
		let n = 0
		const fn = coalesceInflight(async () => {
			if (++n === 1) throw new Error('x')
			return 'ok'
		})
		await expect(fn()).rejects.toThrow('x')
		expect(await fn()).toBe('ok')
	})
})
