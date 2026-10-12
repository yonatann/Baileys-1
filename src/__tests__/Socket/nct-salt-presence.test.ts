import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'

// ESM-mode jest: register the websocket mock before anything imports the socket.
const wsMock = {
	connect: jest.fn(async () => {}),
	close: jest.fn(),
	on: jest.fn(),
	off: jest.fn(),
	once: jest.fn(),
	removeAllListeners: jest.fn(),
	emit: jest.fn(),
	send: jest.fn((_bytes: unknown, cb?: (err?: Error | null) => void) => cb?.(null)),
	isOpen: true
}
jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: jest.fn(() => wsMock)
}))

const { DEFAULT_CONNECTION_CONFIG } = await import('../../Defaults/index.js')
const { default: makeWASocket } = await import('../../Socket/index.js')
const { processSyncAction } = await import('../../Utils/chat-utils.js')
const { makeSession } = await import('../TestUtils/session.js')

const SALT = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

describe('nct salt sync must not send a stray <presence/> (AB 24941 off, default path)', () => {
	const setup = async () => {
		wsMock.send.mockClear()
		const { state, clear } = await makeSession()
		state.creds.me = { id: '1234567890:1@s.whatsapp.net', name: 'Test User' }
		const sock = makeWASocket({ ...DEFAULT_CONNECTION_CONFIG, auth: state })
		await settle()
		return { state, clear, sock }
	}

	it('nct_salt_sync SET stores the salt and sends no stanza when the account name is unchanged', async () => {
		const { state, clear, sock } = await setup()
		const before = wsMock.send.mock.calls.length

		processSyncAction(
			{
				syncAction: { value: { nctSaltSyncAction: { salt: SALT } } as proto.ISyncActionValue },
				index: ['nct_salt_sync'],
				operation: proto.SyncdMutation.SyncdOperation.SET
			} as never,
			sock.ev,
			state.creds.me!
		)
		await settle()

		expect(state.creds.nctSalt).toEqual(SALT)
		expect(wsMock.send.mock.calls.length).toBe(before)

		await sock.end(new Error('Test completed'))
		await clear()
	})

	it('a genuine pushName change still sends the presence stanza', async () => {
		const { state, clear, sock } = await setup()
		const before = wsMock.send.mock.calls.length

		sock.ev.emit('creds.update', { me: { id: state.creds.me!.id, name: 'Renamed' } })
		await settle()

		expect(wsMock.send.mock.calls.length).toBe(before + 1)

		await sock.end(new Error('Test completed'))
		await clear()
	})
})
