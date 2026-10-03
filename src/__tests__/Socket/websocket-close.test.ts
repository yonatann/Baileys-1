import { EventEmitter } from 'events'
import { URL } from 'url'
import { WebSocketClient } from '../../Socket/Client/websocket'

function makeClient(fakeSocket: unknown) {
	const c = new WebSocketClient(new URL('ws://localhost:1234'), {} as never)
	;(c as unknown as { socket: unknown }).socket = fakeSocket
	return c
}

// Fake ws: EventEmitter + close(). clean=emits 'close' asynchronously; hang=never emits.
function fakeSocket(clean: boolean) {
	const ee = new EventEmitter() as EventEmitter & { readyState: number; close: () => void }
	ee.readyState = 1
	ee.close = () => {
		if (clean) {
			setImmediate(() => ee.emit('close'))
		}
	}
	return ee
}

describe('WebSocketClient.close(timeoutMs) — bounded graceful close (BE#689)', () => {
	it('returns true (flushed) when the socket closes within the timeout', async () => {
		await expect(makeClient(fakeSocket(true)).close(1000)).resolves.toBe(true)
	})

	it('returns false (not flushed) when the close event does not arrive before the timeout', async () => {
		await expect(makeClient(fakeSocket(false)).close(150)).resolves.toBe(false)
	})

	it('returns true immediately when there is no socket', async () => {
		await expect(makeClient(null).close(1000)).resolves.toBe(true)
	})

	it('returns FALSE when the close event carries code 1006 (abnormal/no close frame)', async () => {
		const ee = new EventEmitter() as EventEmitter & { readyState: number; close: () => void }
		ee.readyState = 1
		ee.close = () => setImmediate(() => ee.emit('close', 1006))
		await expect(makeClient(ee).close(1000)).resolves.toBe(false)
	})

	it('returns TRUE for a clean close code (1000/1001)', async () => {
		const ee = new EventEmitter() as EventEmitter & { readyState: number; close: () => void }
		ee.readyState = 1
		ee.close = () => setImmediate(() => ee.emit('close', 1000))
		await expect(makeClient(ee).close(1000)).resolves.toBe(true)
	})

	it('returns immediately (no timeout wait) when the socket is already CLOSED', async () => {
		const ee = new EventEmitter() as EventEmitter & { readyState: number; close: () => void }
		ee.readyState = 3 // WebSocket.CLOSED — never emits a new close event
		ee.close = () => undefined
		const start = Date.now()
		await expect(makeClient(ee).close(5000)).resolves.toBe(true)
		expect(Date.now() - start).toBeLessThan(500) // did not burn the 5s timeout
	})
})
