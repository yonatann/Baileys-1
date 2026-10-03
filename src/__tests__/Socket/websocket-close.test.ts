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
})
