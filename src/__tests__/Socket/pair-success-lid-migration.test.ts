import { jest } from '@jest/globals'
import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import { DEFAULT_CONNECTION_CONFIG, WA_ADV_ACCOUNT_SIG_PREFIX } from '../../Defaults'
import makeWASocket from '../../Socket'
import { WebSocketClient } from '../../Socket/Client/websocket'
import { Curve, hmacSign } from '../../Utils/crypto'
import type { BinaryNode } from '../../WABinary'
import { makeSession, mockWebSocket } from '../TestUtils/session'

mockWebSocket()

// WA Web parity FR1 at the socket level (PR1 acceptance): the pair-success handler must persist the
// migration flag only when true, and must never end/logout the connection because of it.
// Evidence: WAWebHandlePairSuccess (b06.js ~@2184561 / ~@2184958) calls socketLogout when isChatDbLidMigrated !== true;
// the fork deliberately does NOT (D1). Here we assert the no-logout / no-flip half on the real handler.

function buildIdentity() {
	const advSecretKey = randomBytes(32).toString('base64')
	const signedIdentityKey = Curve.generateKeyPair()
	const accountKey = Curve.generateKeyPair()
	const deviceDetails = Buffer.from(proto.ADVDeviceIdentity.encode({ rawId: 1, timestamp: 1, keyIndex: 1 }).finish())
	const accountSignature = Curve.sign(
		accountKey.private,
		Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, signedIdentityKey.public])
	)
	const details = Buffer.from(
		proto.ADVSignedDeviceIdentity.encode({
			details: deviceDetails,
			accountSignatureKey: accountKey.public,
			accountSignature
		}).finish()
	)
	const hmac = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
	const deviceIdentityBytes = Buffer.from(proto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish())
	return { advSecretKey, signedIdentityKey, deviceIdentityBytes }
}

const pairSuccessStanza = (deviceIdentityBytes: Buffer, clientProps?: Buffer): BinaryNode => {
	const children: BinaryNode[] = [
		{ tag: 'device-identity', attrs: {}, content: deviceIdentityBytes },
		{ tag: 'device', attrs: { jid: '123:1@s.whatsapp.net', lid: '999:1@lid' } },
		{ tag: 'platform', attrs: { name: 'web' } }
	]
	if (clientProps) {
		children.push({ tag: 'client-props', attrs: {}, content: clientProps })
	}
	return {
		tag: 'iq',
		attrs: { id: 'pair-1', from: 's.whatsapp.net', type: 'set' },
		content: [{ tag: 'pair-success', attrs: {}, content: children }]
	}
}

const propsBytes = (p: { isChatDbLidMigrated?: boolean }) =>
	Buffer.from(proto.ClientPairingProps.encode(p).finish())

const runPairSuccess = async (clientProps?: Buffer) => {
	const { state, clear } = await makeSession()
	const identity = buildIdentity()
	state.creds.advSecretKey = identity.advSecretKey
	state.creds.signedIdentityKey = identity.signedIdentityKey
	// The socket is not really connected in unit tests: stub the wire send (captured by makeSocket) and report open,
	// so the handler's reply goes through and only the handler's own logic decides whether the connection ends.
	jest.spyOn(WebSocketClient.prototype as any, 'send').mockImplementation(((_d: unknown, cb?: (err?: Error) => void) => cb?.()) as any)
	const sock = makeWASocket({ ...DEFAULT_CONNECTION_CONFIG, auth: state })
	Object.defineProperty(sock.ws, 'isOpen', { get: () => true })

	const creditUpdates: any[] = []
	const connectionUpdates: any[] = []
	sock.ev.on('creds.update', u => creditUpdates.push(u))
	sock.ev.on('connection.update', u => connectionUpdates.push(u))

	sock.ws.emit('CB:iq,,pair-success', pairSuccessStanza(identity.deviceIdentityBytes, clientProps))
	await new Promise(resolve => setTimeout(resolve, 100))

	const closed = connectionUpdates.some(u => u.connection === 'close')
	return { state, closed, creditUpdates, sock, clear }
}

describe('pair-success socket handler: LID migration flag (FR1)', () => {
	it('isChatDbLidMigrated false: no connection close (no logout) and no flag write', async () => {
		const r = await runPairSuccess(propsBytes({ isChatDbLidMigrated: false }))
		expect(r.closed).toBe(false)
		expect(r.creditUpdates.some(u => 'isChatDbLidMigrated' in u)).toBe(false)
		expect(r.state.creds.isChatDbLidMigrated).toBeUndefined()
		await r.sock.end(new Error('test done'))
		await r.clear()
	})

	it('client-props absent: no connection close and no flag write', async () => {
		const r = await runPairSuccess(undefined)
		expect(r.closed).toBe(false)
		expect(r.creditUpdates.some(u => 'isChatDbLidMigrated' in u)).toBe(false)
		await r.sock.end(new Error('test done'))
		await r.clear()
	})

	it('malformed client-props bytes: no connection close (decode failure must not end pairing)', async () => {
		const r = await runPairSuccess(Buffer.from([0xff, 0xff, 0xff, 0x7f, 0x01]))
		expect(r.closed).toBe(false)
		await r.sock.end(new Error('test done'))
		await r.clear()
	})

	it('isChatDbLidMigrated true: the flag is written through creds.update (positive control)', async () => {
		const r = await runPairSuccess(propsBytes({ isChatDbLidMigrated: true, isSyncdPureLidSession: true }))
		expect(r.creditUpdates.some(u => u.isChatDbLidMigrated === true)).toBe(true)
		await r.sock.end(new Error('test done'))
		await r.clear()
	})
})
