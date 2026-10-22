import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals'
import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import { existsSync, promises as fs, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { proto } from '../../../WAProto/index.js'
import type { LIDMappingStore } from '../../Signal/lid-mapping'
import type {
	GroupMetadata,
	MessageRelayOptions,
	SignalRepositoryWithLIDStore,
	WAMessageAddressingMode
} from '../../Types'
import type { BinaryNode } from '../../WABinary'

// Mocks MUST be registered before any fork module loads (ESM static imports are hoisted), so every
// fork import below is dynamic. Only type imports are static.

// `encodeWAMessage` pads the proto with 1-16 random bytes (`writeRandomPadMax16`), and the
// <reporting> token is computed over the PADDED bytes, so the pad decides whether the node is even
// attached. Pin the pad byte to 0x07 (8 pad bytes of 0x08 = a clean varint field the extractor skips).
const realCrypto = await import('crypto')
const pinnedRandomBytes = (size: number) => Buffer.alloc(size, 0x07)
jest.unstable_mockModule('crypto', () => ({
	...realCrypto,
	default: { ...realCrypto.default, randomBytes: pinnedRandomBytes },
	randomBytes: pinnedRandomBytes
}))

class FakeWebSocketClient extends EventEmitter {
	readonly frames: Buffer[] = []
	isOpen = true
	isClosed = false
	isClosing = false
	isConnecting = false
	lastCloseFlushed: boolean | null = null
	constructor(
		public url: URL,
		public config: unknown
	) {
		super()
	}
	connect() {}
	async close() {
		this.isOpen = false
		this.isClosed = true
		this.lastCloseFlushed = true
		return true
	}
	send(data: Uint8Array | Buffer, cb?: (err?: Error) => void) {
		this.frames.push(Buffer.from(data))
		cb?.()
		return true
	}
}

let lastClient: FakeWebSocketClient | undefined

jest.unstable_mockModule('../../Socket/Client/websocket', () => ({
	WebSocketClient: class extends FakeWebSocketClient {
		constructor(url: URL, config: unknown) {
			super(url, config)
			lastClient = this
		}
	}
}))

const { proto: protoRuntime } = await import('../../../WAProto/index.js')
const { DEFAULT_CONNECTION_CONFIG } = await import('../../Defaults')
const { WAMessageAddressingMode: WAMessageAddressingModeRuntime } = await import('../../Types')
const { unpadRandomMax16 } = await import('../../Utils/generics')
const { default: logger } = await import('../../Utils/logger')
const { useMultiFileAuthState } = await import('../../Utils/use-multi-file-auth-state')
const { binaryNodeToString, decodeBinaryNode, jidDecode } = await import('../../WABinary')
const { default: makeWASocket } = await import('../../Socket')

// NOT `TestUtils/session`: it imports the package root, which loads the real websocket client before
// the mock below is registered.
const makeSession = async () => {
	const dir = join(tmpdir(), `baileys-send-core-snapshot-${Date.now()}-${Math.random().toString(16).slice(2)}`)
	await fs.mkdir(dir, { recursive: true })
	const { state } = await useMultiFileAuthState(dir)
	return { state, clear: () => fs.rm(dir, { recursive: true, force: true }) }
}

/**
 * Stanza snapshot for the send core (#333 slice 1).
 *
 * Drives `relayMessage` through a real `makeWASocket` with every non-deterministic input pinned
 * (fake signal repository, pre-seeded device cache, fixed message ids, fixed tctoken), captures the
 * bytes handed to the websocket and compares them to committed fixtures. The fixtures were recorded
 * on master BEFORE the send core was extracted, so the extraction is proven byte-identical by this
 * test passing unchanged. Regenerate only on an intentional wire change:
 *   UPDATE_SEND_CORE_FIXTURES=1 yarn test send-core-stanza-snapshot
 */

const ME_PN_USER = '972500000001'
const ME_LID_USER = '100000000000001'
const ME_DEVICE = 7
const ME_ID = `${ME_PN_USER}:${ME_DEVICE}@s.whatsapp.net`
const ME_LID = `${ME_LID_USER}:${ME_DEVICE}@lid`
const OTHER_PN_USER = '972500000002'
const OTHER_LID_USER = '100000000000002'
const OTHER_PN = `${OTHER_PN_USER}@s.whatsapp.net`
const OTHER_LID = `${OTHER_LID_USER}@lid`
const THIRD_PN_USER = '972500000003'
const THIRD_LID_USER = '100000000000003'
const THIRD_PN = `${THIRD_PN_USER}@s.whatsapp.net`
const GROUP_JID = '120363000000000001@g.us'
const NEWSLETTER_JID = '120363000000000002@newsletter'
const STATUS_JID = 'status@broadcast'

const LID_BY_PN: Record<string, string> = {
	[`${ME_PN_USER}@s.whatsapp.net`]: `${ME_LID_USER}@lid`,
	[OTHER_PN]: OTHER_LID,
	[THIRD_PN]: `${THIRD_LID_USER}@lid`
}
const PN_BY_LID: Record<string, string> = Object.fromEntries(Object.entries(LID_BY_PN).map(([pn, lid]) => [lid, pn]))

/** device list per user, as the usync cache stores it (device 0 = primary) */
const DEVICES_BY_USER: Record<string, { server: 'lid' | 's.whatsapp.net'; devices: number[] }> = {
	[ME_PN_USER]: { server: 's.whatsapp.net', devices: [0, ME_DEVICE] },
	[ME_LID_USER]: { server: 'lid', devices: [0, ME_DEVICE] },
	[OTHER_PN_USER]: { server: 's.whatsapp.net', devices: [0, 3] },
	[OTHER_LID_USER]: { server: 'lid', devices: [0, 3] },
	[THIRD_PN_USER]: { server: 's.whatsapp.net', devices: [0] },
	[THIRD_LID_USER]: { server: 'lid', devices: [0] }
}

/** jids that get a pkmsg (fresh session) instead of a msg */
const PKMSG_JIDS = new Set([`${OTHER_PN_USER}:3@s.whatsapp.net`, `${OTHER_LID_USER}:3@lid`])

const sha256 = (...parts: (string | Uint8Array)[]) => {
	const h = createHash('sha256')
	for (const p of parts) {
		h.update(p)
	}

	return new Uint8Array(h.digest())
}

const makeFakeSignalRepository = (): SignalRepositoryWithLIDStore => {
	const lidMapping = {
		getLIDForPN: async (pn: string) => {
			const decoded = jidDecode(pn)
			if (!decoded) return null
			const lid = LID_BY_PN[`${decoded.user}@s.whatsapp.net`]
			if (!lid) return null
			const lidUser = jidDecode(lid)!.user
			return decoded.device ? `${lidUser}:${decoded.device}@lid` : `${lidUser}@lid`
		},
		getPNForLID: async (lid: string) => {
			const decoded = jidDecode(lid)
			if (!decoded) return null
			const pn = PN_BY_LID[`${decoded.user}@lid`]
			if (!pn) return null
			const pnUser = jidDecode(pn)!.user
			return decoded.device ? `${pnUser}:${decoded.device}@s.whatsapp.net` : `${pnUser}@s.whatsapp.net`
		},
		getLIDsForPNs: async (pns: string[]) =>
			pns.map(pn => ({ pn, lid: LID_BY_PN[pn] })).filter((m): m is { pn: string; lid: string } => !!m.lid),
		storeLIDPNMappings: async () => {}
	}
	const repo = {
		decryptGroupMessage: async () => new Uint8Array(),
		processSenderKeyDistributionMessage: async () => {},
		decryptMessage: async () => new Uint8Array(),
		// hash the unpadded proto so the fake ciphertext is a pure function of (recipient, message)
		// even if the pad pin above ever stops covering a code path
		encryptMessage: async ({ jid, data }: { jid: string; data: Uint8Array }) => ({
			type: PKMSG_JIDS.has(jid) ? ('pkmsg' as const) : ('msg' as const),
			ciphertext: sha256('enc:', jid, ':', unpadRandomMax16(data))
		}),
		encryptGroupMessage: async ({ group, data, meId }: { group: string; data: Uint8Array; meId: string }) => ({
			senderKeyDistributionMessage: sha256('skdm:', group, ':', meId),
			ciphertext: sha256('skenc:', group, ':', unpadRandomMax16(data))
		}),
		getSenderKeyDistributionMessage: async ({ group, meId }: { group: string; meId: string }) =>
			sha256('skdm:', group, ':', meId),
		hasSenderKey: async () => true,
		getSessionInfo: async () => null,
		injectE2ESession: async () => {},
		validateSession: async () => ({ exists: true }),
		jidToSignalProtocolAddress: (jid: string) => jid,
		migrateSession: async () => ({ migrated: 0, skipped: 0, total: 0 }),
		deleteSession: async () => {},
		lidMapping: lidMapping as unknown as LIDMappingStore
	}
	return repo as SignalRepositoryWithLIDStore
}

/**
 * in-memory usync device cache, pre-seeded so no device query ever hits the wire. Holds what a real
 * fetch would have cached: `extractDeviceJids` drops the socket's own device (ME_DEVICE) from its own
 * user, so the cache never lists it either and no send ever fans out to itself.
 */
const makeDeviceCache = () => {
	const store = new Map<string, unknown>()
	for (const [user, { server, devices }] of Object.entries(DEVICES_BY_USER)) {
		const isMe = user === ME_PN_USER || user === ME_LID_USER
		store.set(
			user,
			devices.filter(device => !(isMe && device === ME_DEVICE)).map(device => ({ user, server, device }))
		)
	}

	return {
		get: <T>(key: string) => store.get(key) as T | undefined,
		set: <T>(key: string, value: T) => {
			store.set(key, value)
		},
		del: (key: string) => {
			store.delete(key)
		},
		flushAll: () => store.clear()
	}
}

const groupMetadata = (addressingMode: WAMessageAddressingMode): GroupMetadata => ({
	id: GROUP_JID,
	owner: OTHER_PN,
	subject: 'snapshot group',
	addressingMode,
	participants:
		addressingMode === WAMessageAddressingModeRuntime.LID
			? [
					{ id: `${ME_LID_USER}@lid`, admin: null },
					{ id: OTHER_LID, admin: null },
					{ id: `${THIRD_LID_USER}@lid`, admin: null }
				]
			: [
					{ id: `${ME_PN_USER}@s.whatsapp.net`, admin: null },
					{ id: OTHER_PN, admin: null },
					{ id: THIRD_PN, admin: null }
				]
})

/** the frame layout of a fresh (pre-handshake) noise handler: [4-byte intro header]? + 3-byte length + node */
const stripFrame = (frame: Buffer, first: boolean) => {
	const introSize = first ? 4 : 0
	const len = (frame[introSize]! << 16) | (frame[introSize + 1]! << 8) | frame[introSize + 2]!
	const body = frame.subarray(introSize + 3)
	if (body.length !== len) {
		throw new Error(`frame length mismatch: header says ${len}, got ${body.length}`)
	}

	return body
}

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'send-core-stanzas.json')
const UPDATE = process.env.UPDATE_SEND_CORE_FIXTURES === '1'

type Fixtures = Record<string, { hex: string; xml: string }>

const loadFixtures = (): Fixtures => (existsSync(FIXTURE_PATH) ? JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8')) : {})

type SocketUnderTest = {
	sock: ReturnType<typeof makeWASocket>
	client: FakeWebSocketClient
	keys: Awaited<ReturnType<typeof makeSession>>['state']['keys']
	clear: () => Promise<void>
}

const NOW_SEC = Math.floor(Date.now() / 1000)
const TC_TOKEN = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
const MESSAGE_SECRET = Buffer.alloc(32, 0x5a)

const makeSocketUnderTest = async (
	opts: { addressingMode?: WAMessageAddressingMode } = {}
): Promise<SocketUnderTest> => {
	const { state, clear } = await makeSession()
	state.creds.me = { id: ME_ID, lid: ME_LID, name: 'snapshot' }
	state.creds.account = {
		details: Buffer.alloc(16, 0x11),
		accountSignatureKey: Buffer.alloc(32, 0x22),
		accountSignature: Buffer.alloc(64, 0x33),
		deviceSignature: Buffer.alloc(64, 0x44)
	}
	state.creds.abPropsServerProps = { privacyTokenOn1to1: true, lidTrustedTokenIssueToLid: false }
	// a fresh, unexpired peer token so the <tctoken> node attaches; senderTimestamp in the current bucket
	// so the fire-and-forget issuance (a wire IQ) never starts
	await state.keys.set({
		tctoken: {
			[OTHER_LID]: { token: TC_TOKEN, timestamp: String(NOW_SEC), senderTimestamp: NOW_SEC },
			[`${ME_LID_USER}@lid`]: { token: TC_TOKEN, timestamp: String(NOW_SEC), senderTimestamp: NOW_SEC }
		}
	})

	lastClient = undefined
	const sock = makeWASocket({
		...DEFAULT_CONNECTION_CONFIG,
		auth: state,
		logger: logger.child({}, { level: 'silent' }),
		makeSignalRepository: makeFakeSignalRepository,
		userDevicesCache: makeDeviceCache(),
		cachedGroupMetadata: async jid =>
			jid === GROUP_JID ? groupMetadata(opts.addressingMode ?? WAMessageAddressingModeRuntime.PN) : undefined,
		shouldSyncHistoryMessage: () => false
	})
	if (!lastClient) {
		throw new Error('websocket mock was not constructed')
	}

	return { sock, client: lastClient, keys: state.keys, clear }
}

type Case = {
	name: string
	jid: string
	message: proto.IMessage
	options: MessageRelayOptions
	addressingMode?: WAMessageAddressingMode
	seed?: (t: SocketUnderTest) => Promise<void>
}

const text = (conversation: string): proto.IMessage => ({ conversation })

const CASES: Case[] = [
	{
		name: 'text-1to1-pn',
		jid: OTHER_PN,
		message: text('hello pn'),
		options: { messageId: 'SNAP0001' }
	},
	{
		name: 'text-1to1-lid',
		jid: OTHER_LID,
		message: text('hello lid'),
		options: { messageId: 'SNAP0002' }
	},
	{
		name: 'text-1to1-self',
		jid: `${ME_PN_USER}@s.whatsapp.net`,
		message: text('note to self'),
		options: { messageId: 'SNAP0003' }
	},
	{
		name: 'text-1to1-reporting-token',
		jid: OTHER_PN,
		// extendedTextMessage: `conversation` carries no reporting field, so it would never get a <reporting> node
		message: { extendedTextMessage: { text: 'with secret' }, messageContextInfo: { messageSecret: MESSAGE_SECRET } },
		options: { messageId: 'SNAP0004' }
	},
	{
		name: 'image-1to1-pn',
		jid: OTHER_PN,
		message: {
			imageMessage: {
				url: 'https://mmg.whatsapp.net/d/f/snapshot.enc',
				mimetype: 'image/jpeg',
				fileSha256: Buffer.alloc(32, 1),
				fileLength: 1234,
				mediaKey: Buffer.alloc(32, 2),
				fileEncSha256: Buffer.alloc(32, 3),
				directPath: '/v/t62.7118-24/snapshot.enc',
				mediaKeyTimestamp: 1700000000
			}
		},
		options: { messageId: 'SNAP0005' }
	},
	{
		name: 'edit-1to1-pn',
		jid: OTHER_PN,
		message: {
			protocolMessage: {
				key: { remoteJid: OTHER_PN, fromMe: true, id: 'SNAP0001' },
				type: protoRuntime.Message.ProtocolMessage.Type.MESSAGE_EDIT,
				editedMessage: text('edited'),
				timestampMs: 1700000000000
			}
		},
		options: { messageId: 'SNAP0006' }
	},
	{
		name: 'group-skmsg-fresh-pn',
		jid: GROUP_JID,
		message: text('hello group'),
		options: { messageId: 'SNAP0007' }
	},
	{
		name: 'group-skmsg-fresh-lid',
		jid: GROUP_JID,
		message: text('hello lid group'),
		options: { messageId: 'SNAP0008' },
		addressingMode: WAMessageAddressingModeRuntime.LID
	},
	{
		name: 'group-skmsg-known-keys',
		jid: GROUP_JID,
		message: text('hello again group'),
		options: { messageId: 'SNAP0009' },
		seed: async t => {
			const known: Record<string, boolean> = {}
			for (const user of [ME_PN_USER, OTHER_PN_USER, THIRD_PN_USER]) {
				for (const device of DEVICES_BY_USER[user]!.devices) {
					known[device ? `${user}:${device}@s.whatsapp.net` : `${user}@s.whatsapp.net`] = true
				}
			}

			await t.keys.set({ 'sender-key-memory': { [GROUP_JID]: known } })
		}
	},
	{
		name: 'retry-1to1-pn',
		jid: OTHER_PN,
		message: text('hello pn'),
		options: { messageId: 'SNAP0001', participant: { jid: `${OTHER_PN_USER}:3@s.whatsapp.net`, count: 2 } }
	},
	{
		name: 'retry-1to1-own-device',
		jid: OTHER_PN,
		message: text('hello pn'),
		options: { messageId: 'SNAP0001', participant: { jid: `${ME_PN_USER}@s.whatsapp.net`, count: 1 } }
	},
	{
		name: 'retry-group',
		jid: GROUP_JID,
		message: text('hello group'),
		options: { messageId: 'SNAP0007', participant: { jid: `${THIRD_PN_USER}@s.whatsapp.net`, count: 0 } }
	},
	{
		name: 'peer-app-state-key-request',
		jid: `${ME_PN_USER}@s.whatsapp.net`,
		message: {
			protocolMessage: {
				type: protoRuntime.Message.ProtocolMessage.Type.APP_STATE_SYNC_KEY_REQUEST,
				appStateSyncKeyRequest: { keyIds: [{ keyId: Buffer.from('0001', 'hex') }] }
			}
		},
		options: { messageId: 'SNAP0010', additionalAttributes: { category: 'peer', push_priority: 'high' } }
	},
	{
		name: 'newsletter-text',
		jid: NEWSLETTER_JID,
		message: text('hello channel'),
		options: { messageId: 'SNAP0011' }
	},
	{
		name: 'status-broadcast',
		jid: STATUS_JID,
		message: text('my status'),
		options: { messageId: 'SNAP0012', statusJidList: [OTHER_PN, THIRD_PN] }
	},
	{
		name: 'text-1to1-additional-nodes',
		jid: OTHER_PN,
		message: text('with extra node'),
		options: {
			messageId: 'SNAP0013',
			additionalNodes: [
				{ tag: 'biz', attrs: {}, content: [{ tag: 'interactive', attrs: { type: 'native_flow', v: '1' } }] }
			]
		}
	},
	{
		name: 'poll-vote-1to1-pn',
		jid: OTHER_PN,
		message: {
			pollUpdateMessage: {
				pollCreationMessageKey: { remoteJid: OTHER_PN, fromMe: false, id: 'POLL0001' },
				vote: { encPayload: Buffer.alloc(16, 4), encIv: Buffer.alloc(12, 5) },
				senderTimestampMs: 1700000000000
			}
		},
		options: { messageId: 'SNAP0014' }
	},
	{
		name: 'view-once-image-1to1-pn',
		jid: OTHER_PN,
		message: {
			viewOnceMessage: {
				message: {
					imageMessage: {
						url: 'https://mmg.whatsapp.net/d/f/snapshot.enc',
						mimetype: 'image/jpeg',
						fileSha256: Buffer.alloc(32, 1),
						fileLength: 1234,
						mediaKey: Buffer.alloc(32, 2),
						fileEncSha256: Buffer.alloc(32, 3),
						directPath: '/v/t62.7118-24/snapshot.enc',
						mediaKeyTimestamp: 1700000000,
						viewOnce: true
					}
				}
			}
		},
		options: { messageId: 'SNAP0015' }
	}
]

describe('send core stanza snapshot', () => {
	const fixtures = loadFixtures()
	const recorded: Fixtures = {}

	beforeAll(() => {
		if (!UPDATE && Object.keys(fixtures).length === 0) {
			throw new Error(`no fixtures at ${FIXTURE_PATH}; record them with UPDATE_SEND_CORE_FIXTURES=1`)
		}
	})

	afterAll(() => {
		if (UPDATE) {
			writeFileSync(FIXTURE_PATH, JSON.stringify(recorded, null, '\t') + '\n')
		}
	})

	for (const c of CASES) {
		it(`relays ${c.name} byte-identically`, async () => {
			const t = await makeSocketUnderTest({ addressingMode: c.addressingMode })
			try {
				await c.seed?.(t)
				await t.sock.relayMessage(c.jid, c.message, c.options)
				expect(t.client.frames).toHaveLength(1)
				const body = stripFrame(t.client.frames[0]!, true)
				const node: BinaryNode = await decodeBinaryNode(body)
				const hex = body.toString('hex')
				const xml = binaryNodeToString(node)
				recorded[c.name] = { hex, xml }
				if (!UPDATE) {
					const expected = fixtures[c.name]
					expect(expected).toBeDefined()
					// xml first: a readable diff when the wire shape drifts
					expect(xml).toBe(expected!.xml)
					expect(hex).toBe(expected!.hex)
				}
			} finally {
				await t.sock.end(undefined)
				await t.clear()
			}
		})
	}
})
