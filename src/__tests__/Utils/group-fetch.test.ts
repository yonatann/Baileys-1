import { extractGroupMetadata, parseParticipatingGroups } from '../../Socket/groups'
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

	it('drops a group whose re-fetch comes back truncated again (WA Web filters truncated==null)', async () => {
		const out = await resolveTruncatedGroups([meta('b@g.us', { truncated: true, size: 9 })], async jid =>
			meta(jid, { truncated: true, size: 9 })
		)
		expect(out).toEqual([])
	})

	it('drops a truncated group whose re-fetch fails (never emits an empty participant list)', async () => {
		const out = await resolveTruncatedGroups([meta('b@g.us', { truncated: true, size: 9 })], async () => {
			throw new Error('boom')
		})
		expect(out).toEqual([])
	})
})

describe('coalesceInflight', () => {
	it('callers during a flight share ONE trailing re-run (so a change signalled mid-flight is not lost)', async () => {
		let calls = 0
		const gates: Array<() => void> = []
		const fn = coalesceInflight(async () => {
			const n = ++calls
			await new Promise<void>(r => gates.push(r))
			return n
		})
		const a = fn()
		const b = fn() // arrives mid-flight
		const c = fn() // also mid-flight: shares b's trailing run
		expect(calls).toBe(1)
		gates[0]!()
		expect(await a).toBe(1)
		await new Promise(r => setImmediate(r))
		expect(calls).toBe(2)
		gates[1]!()
		expect(await b).toBe(2)
		expect(await c).toBe(2)
		expect(calls).toBe(2)
	})

	it('a lone call just runs once; the next call after it settles runs again', async () => {
		let calls = 0
		const fn = coalesceInflight(async () => ++calls)
		expect(await fn()).toBe(1)
		expect(await fn()).toBe(2)
	})

	it('a rejection does not wedge the slot', async () => {
		let n = 0
		const fn = coalesceInflight(async () => {
			if (++n === 1) throw new Error('x')
			return 'ok'
		})
		await expect(fn()).rejects.toThrow('x')
		expect(await fn()).toBe('ok')
	})

	it('a trailing run still happens when the in-flight one fails', async () => {
		let n = 0
		const fn = coalesceInflight(async () => {
			if (++n === 1) throw new Error('x')
			return 'ok'
		})
		const a = fn()
		const b = fn()
		await expect(a).rejects.toThrow('x')
		expect(await b).toBe('ok')
	})
})

describe('parseParticipatingGroups wiring (fetch-all result -> truncated resolution)', () => {
	const groupNode = (attrs: Record<string, string>): BinaryNode => ({ tag: 'group', attrs: { creation: '1', s_t: '1', ...attrs } })

	it('re-fetches the truncated group by id and never emits an empty participant list', async () => {
		const result: BinaryNode = {
			tag: 'iq',
			attrs: {},
			content: [
				{
					tag: 'groups',
					attrs: {},
					content: [groupNode({ id: '111' }), groupNode({ id: '222', truncated: 'true', size: '9' })]
				}
			]
		}
		const asked: string[] = []
		const data = await parseParticipatingGroups(result, async jid => {
			asked.push(jid)
			return meta(jid, { participants: [{ id: 'p@lid' } as any] })
		})
		expect(asked).toEqual(['222@g.us'])
		expect(Object.keys(data).sort()).toEqual(['111@g.us', '222@g.us'])
		expect(data['222@g.us']!.participants).toHaveLength(1)
	})
})
