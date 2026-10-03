import WebSocket from 'ws'
import { DEFAULT_ORIGIN } from '../../Defaults'
import { AbstractSocketClient } from './types'

export class WebSocketClient extends AbstractSocketClient {
	protected socket: WebSocket | null = null

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
			return true
		}

		const closed = new Promise<boolean>(resolve => {
			this.socket?.once('close', () => resolve(true))
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
		return flushed
	}
	send(str: string | Uint8Array, cb?: (err?: Error) => void): boolean {
		this.socket?.send(str, cb)

		return Boolean(this.socket)
	}
}
