import {
	APP_STATE_BACKOFF_BASE,
	APP_STATE_BACKOFF_MAX_MS,
	APP_STATE_BACKOFF_MIN_MS,
	AppStateRetryGate,
	partitionByRetryGate,
	trackGatedCollection,
	appStateRetryBackoffMs
} from '../../Utils/chat-utils'

describe('app-state retry backoff (WA Web WAWebSyncd: min(max(2^n * 1s, serverBackoff), 1h))', () => {
	it('uses WA Web constants (b07@1068624 N=1000, M=1h, w=2)', () => {
		expect(APP_STATE_BACKOFF_MIN_MS).toBe(1000)
		expect(APP_STATE_BACKOFF_MAX_MS).toBe(60 * 60 * 1000)
		expect(APP_STATE_BACKOFF_BASE).toBe(2)
	})

	it('doubles from 1s and caps at 1h', () => {
		expect([0, 1, 2, 3].map(n => appStateRetryBackoffMs(n))).toEqual([1000, 2000, 4000, 8000])
		expect(appStateRetryBackoffMs(11)).toBe(2048_000)
		expect(appStateRetryBackoffMs(12)).toBe(APP_STATE_BACKOFF_MAX_MS)
		expect(appStateRetryBackoffMs(500)).toBe(APP_STATE_BACKOFF_MAX_MS)
	})

	it('a server-provided backoff is a floor, still capped at 1h', () => {
		expect(appStateRetryBackoffMs(0, 30_000)).toBe(30_000)
		expect(appStateRetryBackoffMs(5, 1000)).toBe(32_000)
		expect(appStateRetryBackoffMs(0, 10 * 3600_000)).toBe(APP_STATE_BACKOFF_MAX_MS)
	})

	it('negative / NaN inputs fall back to the first step', () => {
		expect(appStateRetryBackoffMs(-3)).toBe(1000)
		expect(appStateRetryBackoffMs(NaN)).toBe(1000)
	})
})

describe('AppStateRetryGate (cross-call cooldown per collection)', () => {
	it('allows a collection that never failed', () => {
		const gate = new AppStateRetryGate()
		expect(gate.remainingMs('regular', 0)).toBe(0)
	})

	it('cools a failed collection down by the escalating backoff, per collection', () => {
		const gate = new AppStateRetryGate()
		expect(gate.recordFailure('regular', 0)).toBe(1000)
		expect(gate.remainingMs('regular', 400)).toBe(600)
		expect(gate.remainingMs('regular', 1000)).toBe(0)
		expect(gate.remainingMs('regular_low', 400)).toBe(0)
		expect(gate.recordFailure('regular', 1000)).toBe(2000)
		expect(gate.recordFailure('regular', 3000)).toBe(4000)
	})

	it('caps at 1h and a success resets the ladder', () => {
		const gate = new AppStateRetryGate()
		let wait = 0
		for (let i = 0; i < 20; i++) wait = gate.recordFailure('regular', 0)
		expect(wait).toBe(APP_STATE_BACKOFF_MAX_MS)
		gate.recordSuccess('regular')
		expect(gate.remainingMs('regular', 0)).toBe(0)
		expect(gate.recordFailure('regular', 0)).toBe(1000)
	})
})

describe('partitionByRetryGate', () => {
	const cooled = () => {
		const gate = new AppStateRetryGate()
		gate.recordFailure('regular', 0)
		return gate
	}

	it('defers cooling-down collections and runs the rest', () => {
		const { run, deferred } = partitionByRetryGate(['regular', 'regular_low'], cooled(), 100)
		expect(run).toEqual(['regular_low'])
		expect(deferred).toEqual([{ name: 'regular', remainingMs: 900 }])
	})

	it('bypass (an explicit appPatch write must always fetch) runs everything and defers nothing', () => {
		const { run, deferred } = partitionByRetryGate(['regular', 'regular_low'], cooled(), 100, true)
		expect(run).toEqual(['regular', 'regular_low'])
		expect(deferred).toEqual([])
	})

	it('runs a collection once its cooldown has elapsed', () => {
		expect(partitionByRetryGate(['regular'], cooled(), 1000).run).toEqual(['regular'])
	})
})

describe('trackGatedCollection', () => {
	it('never downgrades an existing initial-sync flag', () => {
		const tracked = new Map<string, boolean>([['regular', true]])
		trackGatedCollection(tracked, 'regular', false)
		expect(tracked.get('regular')).toBe(true)
		trackGatedCollection(tracked, 'regular_low', false)
		expect(tracked.get('regular_low')).toBe(false)
	})

	it('with a gate, records a failure so an instantly-failing retry backs off exponentially', () => {
		const tracked = new Map<string, boolean>()
		const gate = new AppStateRetryGate()
		expect(trackGatedCollection(tracked, 'regular', false, gate, 0)).toBe(1000)
		expect(trackGatedCollection(tracked, 'regular', false, gate, 1000)).toBe(2000)
		expect(trackGatedCollection(tracked, 'regular', false, gate, 3000)).toBe(4000)
	})
})
