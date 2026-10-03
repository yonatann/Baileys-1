import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null
	/** BE#689: result of the most recent close() — lets the consumer read the flush after end() (null = never closed). */
	lastCloseFlushed: boolean | null = null

	get isOpen(): boolean {
		return this.socket?.readyState === WebSocket.OPEN
	}
	get isClosed(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSED
	}
	get isClosing(): boolean {
		return this.socket === null || this.socket?.readyState === WebSocket.CLOSING
	}
	get isConnecting(): boolean {
		return this.socket?.readyState === WebSocket.CONNECTING
	}

	connect() {
		if (this.socket) {
			return
		}

		this.socket = new WebSocket(this.url, {
			origin: DEFAULT_ORIGIN,
			headers: this.config.options?.headers as {},
			handshakeTimeout: this.config.connectTimeoutMs,
			timeout: this.config.connectTimeoutMs,
			agent: this.config.agent
		})

		this.socket.setMaxListeners(0)

		const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']

		for (const event of events) {
			this.socket?.on(event, (...args: any[]) => this.emit(event, ...args))
		}
	}

	/**
	 * Close the socket. Returns whether the close actually completed (the WS `close` event fired) =
	 * "flushed". When `timeoutMs > 0` the wait is BOUNDED (BE#689): on an abrupt spot-node network
	 * teardown the `close` event may never arrive, so an unbounded await could hang the whole
	 * shutdown and never confirm the flush. A timed-out close resolves `false` so the caller can
	 * record that WhatsApp likely saw an abrupt drop rather than a clean close.
	 */
	async close(timeoutMs = 0): Promise<boolean> {
		if (!this.socket) {
			this.lastCloseFlushed = true
			return true
		}

		// BE#689 M4: if the socket is already CLOSED, `close()` emits no further `close` event, so
		// arming a wait would just burn the full timeout and report a false "abrupt drop". Return now.
		if (this.socket.readyState === WebSocket.CLOSED) {
			this.socket = null
			this.lastCloseFlushed = true
			return true
		}

		const closed = new Promise<boolean>(resolve => {
			// BE#689 M2: ws emits `close` even on an abnormal teardown (reset/FIN with no close frame)
			// with code 1006 — the exact abrupt-spot-drop case. Treat ONLY a non-1006 close as flushed.
			this.socket?.once('close', (code: number) => resolve(code !== 1006))
		})

		this.socket.close()

		let flushed: boolean
		if (timeoutMs > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined
			const timedOut = new Promise<boolean>(resolve => {
				timer = setTimeout(() => resolve(false), timeoutMs)
			})
			flushed = await Promise.race([closed, timedOut])
			if (timer) {
				clearTimeout(timer)
			}
		} else {
			flushed = await closed
		}

		this.socket = null
		this.lastCloseFlushed = flushed
		return flushed
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}
