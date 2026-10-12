import { jest } from '@jest/globals'
import type { BaileysEventMap } from '../../Types'
import { makeEventBuffer } from '../../Utils/event-buffer'
import type { ILogger } from '../../Utils/logger'

// hist_sync receipt timing: a chunk's receipt (WA Web b07@572936, after its store try-block) must be released
// only once the chunk's `messaging-history.set` has actually left the (bufferable) event buffer, or — when the
// consumer opts in via `awaitHistorySyncStore` — only once the consumer has durably stored it and calls the ack.

const makeTestLogger = (): ILogger =>
	({
		level: 'silent',
		child: () => makeTestLogger(),
		trace: () => {},
		debug: () => {},
		info: () => {},
		warn: () => {},
		error: () => {},
		fatal: () => {}
	}) as unknown as ILogger

const chunk = (id: string) => ({
	chats: [{ id } as any],
	contacts: [],
	messages: [],
	syncType: 6,
	chunkOrder: 1
})

describe('event-buffer historySyncAck', () => {
	it('fallback (no opt-in): ack is released only AFTER the buffer flushed the chunk to listeners', () => {
		const ev = makeEventBuffer(makeTestLogger())
		const order: string[] = []
		ev.on('messaging-history.set', () => {
			order.push('listener')
		})
		const ack = jest.fn(async () => {
			order.push('ack')
		})

		ev.buffer()
		ev.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ack } as any)
		// still buffered: the phone must NOT be told yet (the old code acked right here)
		expect(ack).not.toHaveBeenCalled()

		ev.flush()
		expect(ack).toHaveBeenCalledTimes(1)
		expect(order).toEqual(['listener', 'ack'])
	})

	it('opt-in (awaitHistorySyncStore): the library never acks; the flushed event hands the consumer a callable ack', async () => {
		const ev = makeEventBuffer(makeTestLogger(), { awaitHistorySyncStore: true })
		let received: BaileysEventMap['messaging-history.set'] | undefined
		ev.on('messaging-history.set', data => {
			received = data
		})
		const ack = jest.fn(async () => {})

		ev.buffer()
		ev.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ack } as any)
		ev.flush()

		expect(ack).not.toHaveBeenCalled()
		expect(received).toBeDefined()
		const consumerAck = (received as any).historySyncAck as () => Promise<void>
		expect(typeof consumerAck).toBe('function')

		// the chunk's receipt goes out only when the consumer calls it (i.e. after its store)
		await consumerAck()
		expect(ack).toHaveBeenCalledTimes(1)
	})

	it('destroy() before flush drops the chunk ack (the chunk was never handed to a consumer, so the phone re-sends)', () => {
		for (const awaitHistorySyncStore of [false, true]) {
			const ev = makeEventBuffer(makeTestLogger(), { awaitHistorySyncStore })
			const ack = jest.fn(async () => {})
			ev.buffer()
			ev.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ack } as any)
			ev.destroy()
			ev.flush()
			expect(ack).not.toHaveBeenCalled()
		}
	})

	it('merged chunks: one flush releases every merged chunk ack, in arrival order', async () => {
		const ev = makeEventBuffer(makeTestLogger(), { awaitHistorySyncStore: true })
		let received: any
		ev.on('messaging-history.set', data => {
			received = data
		})
		const order: string[] = []
		const ackA = jest.fn(async () => {
			order.push('A')
		})
		const ackB = jest.fn(async () => {
			order.push('B')
		})

		ev.buffer()
		ev.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ackA } as any)
		ev.emit('messaging-history.set', { ...chunk('b@s.whatsapp.net'), historySyncAck: ackB } as any)
		ev.flush()
		expect(received.chats.length).toBe(2)

		await received.historySyncAck()
		expect(order).toEqual(['A', 'B'])
	})

	it('an empty chunk (nothing to store) still hands the consumer its ack in opt-in mode', async () => {
		const ev = makeEventBuffer(makeTestLogger(), { awaitHistorySyncStore: true })
		let received: any
		ev.on('messaging-history.set', data => {
			received = data
		})
		const ack = jest.fn(async () => {})

		ev.buffer()
		ev.emit('messaging-history.set', { chats: [], contacts: [], messages: [], historySyncAck: ack } as any)
		ev.flush()

		expect(received).toBeDefined()
		await received.historySyncAck()
		expect(ack).toHaveBeenCalledTimes(1)
	})

	it('not buffering: fallback acks right after emit; opt-in hands the ack to the consumer', async () => {
		const evFallback = makeEventBuffer(makeTestLogger())
		const orderF: string[] = []
		evFallback.on('messaging-history.set', () => {
			orderF.push('listener')
		})
		const ackF = jest.fn(async () => {
			orderF.push('ack')
		})
		evFallback.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ackF } as any)
		expect(orderF).toEqual(['listener', 'ack'])

		const evOpt = makeEventBuffer(makeTestLogger(), { awaitHistorySyncStore: true })
		let receivedOpt: any
		evOpt.on('messaging-history.set', data => {
			receivedOpt = data
		})
		const ackO = jest.fn(async () => {})
		evOpt.emit('messaging-history.set', { ...chunk('a@s.whatsapp.net'), historySyncAck: ackO } as any)
		expect(ackO).not.toHaveBeenCalled()
		await receivedOpt.historySyncAck()
		expect(ackO).toHaveBeenCalledTimes(1)
	})
})
