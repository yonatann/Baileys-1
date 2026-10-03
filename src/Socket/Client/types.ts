import { EventEmitter } from 'events'
import { URL } from 'url'
import type { SocketConfig } from '../../Types'

export abstract class AbstractSocketClient extends EventEmitter {
	abstract get isOpen(): boolean
	abstract get isClosed(): boolean
	abstract get isClosing(): boolean
	abstract get isConnecting(): boolean

	constructor(
		public url: URL,
		public config: SocketConfig
	) {
		super()
		this.setMaxListeners(0)
	}

	abstract connect(): void
	/** Close the socket; resolves whether it flushed (close completed) within `timeoutMs` (0 = unbounded). */
	abstract close(timeoutMs?: number): Promise<boolean>
	abstract send(str: Uint8Array | string, cb?: (err?: Error) => void): boolean
}
