import { describe, expect, it, jest } from '@jest/globals'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { proto } from '../../../WAProto/index.js'
import type { SendCoreAdapter } from '../../SendCore/types'
import type { WaWapNode, WaWebModules, WaWid } from '../../SendCore/wa-web/modules'
import type { MessageRelayOptions } from '../../Types'
import type { BinaryNode } from '../../WABinary'

// Same pad pin as the socket snapshot test: the fixtures were recorded with it, and the <reporting>
// token is computed over the padded bytes. Fork modules load dynamically so the mock is in place first.
const realCrypto = await import('crypto')
const pinnedRandomBytes = (size: number) => Buffer.alloc(size, 0x07)
jest.unstable_mockModule('crypto', () => ({
	...realCrypto,
	default: { ...realCrypto.default, randomBytes: pinnedRandomBytes },
	randomBytes: pinnedRandomBytes
}))

const { proto: protoRuntime } = await import('../../../WAProto/index.js')
const { buildAndRelay } = await import('../../SendCore')
const { makeWaWebAdapter, widToJid } = await import('../../SendCore/wa-web/wa-web-adapter')
const { unpadRandomMax16 } = await import('../../Utils/generics')
const { default: logger } = await import('../../Utils/logger')
const { binaryNodeToString, encodeBinaryNode, jidDecode } = await import('../../WABinary')

/**
 * WA Web adapter parity (#333 slice 2).
 *
 * Drives `buildAndRelay` through `makeWaWebAdapter` against a stub of the WA Web module surface
 * that holds the SAME identities, sessions, device lists and tokens as the socket snapshot test, and
 * asserts the stanza handed to WA Web's socket is byte-identical to the fixture the Baileys socket
 * produced for the same input. One send core, two transports, one wire shape.
 *
 * Covers the 1:1 cases (slice 2) and the group / status cases (slice 3: sender keys through WA Web's own
 * sender-key session and participant table).
 */

const ME_PN_USER = '972500000001'
const ME_LID_USER = '100000000000001'
const ME_DEVICE = 7
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

const LID_USER_BY_PN_USER: Record<string, string> = {
	[ME_PN_USER]: ME_LID_USER,
	[OTHER_PN_USER]: OTHER_LID_USER,
	[THIRD_PN_USER]: THIRD_LID_USER
}
const PN_USER_BY_LID_USER: Record<string, string> = Object.fromEntries(
	Object.entries(LID_USER_BY_PN_USER).map(([pn, lid]) => [lid, pn])
)

/** device records per user, as WA Web's device list stores them (keyIndex only on companions) */
const DEVICES_BY_USER: Record<string, { id: number; keyIndex?: number }[]> = {
	[ME_PN_USER]: [{ id: 0 }, { id: ME_DEVICE, keyIndex: 1 }],
	[ME_LID_USER]: [{ id: 0 }, { id: ME_DEVICE, keyIndex: 1 }],
	[OTHER_PN_USER]: [{ id: 0 }, { id: 3, keyIndex: 1 }],
	[OTHER_LID_USER]: [{ id: 0 }, { id: 3, keyIndex: 1 }],
	[THIRD_PN_USER]: [{ id: 0 }],
	[THIRD_LID_USER]: [{ id: 0 }]
}

/** the snapshot group's members, in each addressing mode, as WA Web's group model lists them */
const GROUP_MEMBERS: Record<'pn' | 'lid', string[]> = {
	pn: [`${ME_PN_USER}@c.us`, `${OTHER_PN_USER}@c.us`, `${THIRD_PN_USER}@c.us`],
	lid: [`${ME_LID_USER}@lid`, `${OTHER_LID_USER}@lid`, `${THIRD_LID_USER}@lid`]
}

/** device jids with no session yet (they get a pkmsg) */
const PKMSG_JIDS = new Set([`${OTHER_PN_USER}:3@s.whatsapp.net`, `${OTHER_LID_USER}:3@lid`])

const NOW_SEC = Math.floor(Date.now() / 1000)
const TC_TOKEN = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex')
const MESSAGE_SECRET = Buffer.alloc(32, 0x5a)

const sha256 = (...parts: (string | Uint8Array)[]) => {
	const h = createHash('sha256')
	for (const p of parts) {
		h.update(p)
	}

	return new Uint8Array(h.digest())
}

// WA Web spells the same addresses `user[:device]@c.us` / `@lid`; the Wid stub keeps that spelling.
const makeWid = (serialized: string): WaWid => {
	const [userPart, server] = serialized.split('@') as [string, string]
	const [user, device] = userPart.split(':') as [string, string | undefined]
	return {
		user,
		server,
		device: device === undefined ? undefined : Number(device),
		toString: () => serialized
	}
}

const altServer = (server: string) => (server === 'lid' ? 'c.us' : 'lid')
const alternate = (wid: WaWid): WaWid | null => {
	const user = wid.server === 'lid' ? PN_USER_BY_LID_USER[wid.user] : LID_USER_BY_PN_USER[wid.user]
	if (!user) return null
	return makeWid(`${user}${wid.device ? `:${wid.device}` : ''}@${altServer(wid.server)}`)
}

const isWid = (value: unknown): value is WaWid => typeof value === 'object' && value !== null && 'server' in value

/** what WA Web's socket got, turned back into the fork's node shape so it can be encoded and compared */
const wapToBinary = (node: WaWapNode): BinaryNode => ({
	tag: node.tag,
	attrs: Object.fromEntries(Object.entries(node.attrs).map(([k, v]) => [k, isWid(v) ? widToJid(v) : v])),
	content: Array.isArray(node.content) ? node.content.map(wapToBinary) : node.content
})

type SenderKeyRow = { keyed: Set<string>; rotateKey: boolean }

const makeStubModules = (opts: { addressingMode?: 'pn' | 'lid' } = {}) => {
	const sent: WaWapNode[] = []
	const iqs: WaWapNode[] = []
	const tokens = new Map<string, { token: Uint8Array; timestamp?: string; senderTimestamp?: number }>()
	for (const lidUser of [ME_LID_USER, OTHER_LID_USER, THIRD_LID_USER]) {
		tokens.set(`${lidUser}@lid`, { token: TC_TOKEN, timestamp: String(NOW_SEC), senderTimestamp: NOW_SEC })
	}

	/** WA Web's participant table: per group, the device Wids (serialized) that hold our sender key */
	const senderKeyRows = new Map<string, SenderKeyRow>()
	const senderKeyRow = (group: string) => {
		let row = senderKeyRows.get(group)
		if (!row) {
			row = { keyed: new Set(), rotateKey: false }
			senderKeyRows.set(group, row)
		}

		return row
	}

	const deletedSenderKeys: string[] = []
	const addressingMode = opts.addressingMode ?? 'pn'

	const modules: WaWebModules = {
		makeWid,
		makeWapNode: (tag, attrs, content) => ({ tag, attrs, content }),
		readWapNode: node => node as WaWapNode,
		sendStanzaAndReturnAck: async stanza => {
			sent.push(stanza)
			return { ack: true }
		},
		sendIq: async stanza => {
			iqs.push(stanza)
			throw new Error(`unexpected iq on the wire: ${stanza.tag}`)
		},
		makeAckTemplate: opts => opts,
		me: () => ({ pn: makeWid(`${ME_PN_USER}:${ME_DEVICE}@c.us`), lid: makeWid(`${ME_LID_USER}:${ME_DEVICE}@lid`) }),
		signedDeviceIdentity: () => ({
			details: Buffer.alloc(16, 0x11),
			accountSignatureKey: Buffer.alloc(32, 0x22),
			accountSignature: Buffer.alloc(64, 0x33),
			deviceSignature: Buffer.alloc(64, 0x44)
		}),
		signal: {
			// same fake ciphertext function as the socket snapshot, keyed by the Baileys spelling of the jid
			encryptSignalProto: async (wid, data) => {
				const jid = widToJid(wid)
				return {
					type: PKMSG_JIDS.has(jid) ? 'pkmsg' : 'msg',
					ciphertext: sha256('enc:', jid, ':', unpadRandomMax16(data))
				}
			},
			hasSignalSessions: async wids => wids.map(() => true),
			createSignalSession: async () => {
				throw new Error('no session should be created: every device already has one')
			},
			// same fake sender-key functions as the socket snapshot: WA Web hands both back from one call
			encryptSenderKeyMsgSignalProto: async (group, me, data) => ({
				ciphertext: sha256('skenc:', widToJid(group), ':', unpadRandomMax16(data)),
				senderKeyBytes: sha256('skdm:', widToJid(group), ':', widToJid(me))
			}),
			deleteGroupSenderKeyInfo: async group => {
				deletedSenderKeys.push(group.toString())
			}
		},
		getDeviceIds: async wids =>
			wids.map(wid => ({ wid: makeWid(`${wid.user}@${wid.server}`), devices: DEVICES_BY_USER[wid.user] ?? [] })),
		groupMetadata: async group =>
			group.toString() === GROUP_JID
				? { participants: GROUP_MEMBERS[addressingMode].map(makeWid), addressingMode }
				: undefined,
		senderKeys: {
			get: async group => {
				const row = senderKeyRow(group.toString())
				return { keyed: [...row.keyed].map(makeWid), rotateKey: row.rotateKey }
			},
			markHasSenderKey: async (group, devices) => {
				const row = senderKeyRow(group.toString())
				for (const device of devices) {
					row.keyed.add(device.toString())
				}

				row.rotateKey = false
			}
		},
		lidForPn: pn => (pn.server === 'lid' ? null : alternate(pn)),
		pnForLid: lid => (lid.server === 'lid' ? alternate(lid) : null),
		tcToken: {
			get: async wid => tokens.get(wid.toString()) ?? null,
			set: async (wid, entry) => {
				if (entry) {
					tokens.set(wid.toString(), entry)
				} else {
					tokens.delete(wid.toString())
				}
			}
		},
		abProps: () => ({ privacyTokenOn1to1: true, lidTrustedTokenIssueToLid: false })
	}
	return { modules, sent, iqs, tokens, senderKeyRows, senderKeyRow, deletedSenderKeys }
}

type Stub = ReturnType<typeof makeStubModules>

const silent = () => logger.child({}, { level: 'silent' })

const FIXTURE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'Socket',
	'__fixtures__',
	'send-core-stanzas.json'
)
const fixtures: Record<string, { hex: string; xml: string }> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

const text = (conversation: string): proto.IMessage => ({ conversation })

type Case = {
	name: string
	jid: string
	message: proto.IMessage
	options: MessageRelayOptions
	addressingMode?: 'pn' | 'lid'
	seed?: (adapter: SendCoreAdapter, stub: Stub) => Promise<void>
}

/** every case of the socket snapshot, by fixture name, verbatim */
const CASES: Case[] = [
	{ name: 'text-1to1-pn', jid: OTHER_PN, message: text('hello pn'), options: { messageId: 'SNAP0001' } },
	{ name: 'text-1to1-lid', jid: OTHER_LID, message: text('hello lid'), options: { messageId: 'SNAP0002' } },
	{
		name: 'text-1to1-self',
		jid: `${ME_PN_USER}@s.whatsapp.net`,
		message: text('note to self'),
		options: { messageId: 'SNAP0003' }
	},
	{
		name: 'text-1to1-reporting-token',
		jid: OTHER_PN,
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
	{ name: 'group-skmsg-fresh-pn', jid: GROUP_JID, message: text('hello group'), options: { messageId: 'SNAP0007' } },
	{
		name: 'group-skmsg-fresh-lid',
		jid: GROUP_JID,
		message: text('hello lid group'),
		options: { messageId: 'SNAP0008' },
		addressingMode: 'lid'
	},
	{
		name: 'group-skmsg-known-keys',
		jid: GROUP_JID,
		message: text('hello again group'),
		options: { messageId: 'SNAP0009' },
		// the same seed as the socket test, through the adapter's store: own devices stay in the adapter,
		// the other members' devices land in WA Web's participant table
		seed: async adapter => {
			const known: Record<string, boolean> = {}
			for (const user of [ME_PN_USER, OTHER_PN_USER, THIRD_PN_USER]) {
				for (const { id } of DEVICES_BY_USER[user]!) {
					known[id ? `${user}:${id}@s.whatsapp.net` : `${user}@s.whatsapp.net`] = true
				}
			}

			await adapter.keys.set({ 'sender-key-memory': { [GROUP_JID]: known } })
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
		options: { messageId: 'SNAP0007', participant: { jid: THIRD_PN, count: 0 } }
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
	{ name: 'newsletter-text', jid: NEWSLETTER_JID, message: text('hello channel'), options: { messageId: 'SNAP0011' } },
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
	}
]

describe('wa-web adapter', () => {
	for (const c of CASES) {
		it(`relays ${c.name} byte-identically to the Baileys socket`, async () => {
			const stub = makeStubModules({ addressingMode: c.addressingMode })
			const { modules, sent, iqs } = stub
			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await c.seed?.(adapter, stub)
			await buildAndRelay(adapter, c.jid, c.message, c.options)

			expect(iqs).toHaveLength(0)
			expect(sent).toHaveLength(1)
			const node = wapToBinary(sent[0]!)
			const expected = fixtures[c.name]
			expect(expected).toBeDefined()
			// xml first: a readable diff when the wire shape drifts
			expect(binaryNodeToString(node)).toBe(expected!.xml)
			expect(Buffer.from(encodeBinaryNode(node)).toString('hex')).toBe(expected!.hex)
		})
	}

	it('covers every fixture the socket snapshot recorded', () => {
		expect(CASES.map(c => c.name).sort()).toEqual(Object.keys(fixtures).sort())
	})

	it('hands WA Web Wids, not strings, for every jid attribute', async () => {
		const { modules, sent } = makeStubModules()
		const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
		await buildAndRelay(adapter, OTHER_PN, text('wids please'), { messageId: 'SNAP0001' })

		const stanza = sent[0]!
		expect(isWid(stanza.attrs.to)).toBe(true)
		expect((stanza.attrs.to as WaWid).toString()).toBe(`${OTHER_PN_USER}@c.us`)
		const participants = (stanza.content as WaWapNode[]).find(n => n.tag === 'participants')!
		for (const to of participants.content as WaWapNode[]) {
			expect(isWid(to.attrs.jid)).toBe(true)
			expect((to.attrs.jid as WaWid).server).toBe('c.us')
		}
	})

	it('acks through the ack template of the stanza it sent', async () => {
		const { modules } = makeStubModules()
		const acks: [string, unknown][] = []
		const adapter = makeWaWebAdapter({
			modules,
			logger: logger.child({}, { level: 'silent' }),
			onAck: (id, ack) => acks.push([id, ack])
		})
		await buildAndRelay(adapter, OTHER_PN, text('ack me'), { messageId: 'SNAP0001' })
		expect(acks).toEqual([['SNAP0001', { ack: true }]])
	})

	it('fetches a missing session through WA Web as an encrypt IQ to the bare server jid', async () => {
		const { modules, sent, iqs } = makeStubModules()
		const fresh = `${OTHER_PN_USER}:3@c.us`
		const created: [string, unknown][] = []
		modules.signal.hasSignalSessions = async wids => wids.map(wid => wid.toString() !== fresh)
		modules.signal.createSignalSession = async (wid, bundle) => {
			created.push([wid.toString(), bundle])
		}

		// what WA Web's socket hands back for `get encrypt`, as a WapNode (jid attrs are Wids there too)
		modules.sendIq = async stanza => {
			iqs.push(stanza)
			const user = makeWid(`${OTHER_LID_USER}:3@lid`)
			return {
				tag: 'iq',
				attrs: { type: 'result', from: makeWid('@s.whatsapp.net') },
				content: [
					{
						tag: 'list',
						attrs: {},
						content: [
							{
								tag: 'user',
								attrs: { jid: user },
								content: [
									{ tag: 'registration', attrs: {}, content: Buffer.from('00000101', 'hex') },
									{ tag: 'type', attrs: {}, content: Buffer.from('05', 'hex') },
									{ tag: 'identity', attrs: {}, content: Buffer.alloc(32, 0xaa) },
									{ tag: 'device-identity', attrs: {}, content: Buffer.alloc(8, 0xee) },
									{
										tag: 'skey',
										attrs: {},
										content: [
											{ tag: 'id', attrs: {}, content: Buffer.from('000001', 'hex') },
											{ tag: 'value', attrs: {}, content: Buffer.alloc(32, 0xbb) },
											{ tag: 'signature', attrs: {}, content: Buffer.alloc(64, 0xcc) }
										]
									},
									{
										tag: 'key',
										attrs: {},
										content: [
											{ tag: 'id', attrs: {}, content: Buffer.from('000002', 'hex') },
											{ tag: 'value', attrs: {}, content: Buffer.alloc(32, 0xdd) }
										]
									}
								]
							}
						]
					}
				]
			}
		}

		const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
		await buildAndRelay(adapter, OTHER_PN, text('first contact'), { messageId: 'SNAP0001' })

		expect(iqs).toHaveLength(1)
		const iq = iqs[0]!
		expect(iq.tag).toBe('iq')
		expect(iq.attrs.xmlns).toBe('encrypt')
		expect(iq.attrs.type).toBe('get')
		// the server jid keeps its spelling: `@c.us` is not an address WA Web routes to
		expect((iq.attrs.to as WaWid).toString()).toBe('@s.whatsapp.net')
		const users = (iq.content as WaWapNode[])[0]!.content as WaWapNode[]
		// the core asks for the LID spelling of a PN device when a mapping is known
		expect(users.map(u => (u.attrs.jid as WaWid).toString())).toEqual([`${OTHER_LID_USER}:3@lid`])

		// the answer came back through readWapNode -> toBinaryNode and landed as a WA Web session
		expect(created).toEqual([
			[
				`${OTHER_LID_USER}:3@lid`,
				{
					registrationId: 257,
					identityKey: Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 0xaa)]),
					signedPreKey: {
						keyId: 1,
						publicKey: Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 0xbb)]),
						signature: Buffer.alloc(64, 0xcc)
					},
					preKey: { keyId: 2, publicKey: Buffer.concat([Buffer.from([5]), Buffer.alloc(32, 0xdd)]) },
					// companion device: WA Web refuses to create the session without the ADV blob
					deviceIdentity: Buffer.alloc(8, 0xee)
				}
			]
		])
		expect(sent).toHaveLength(1)
	})

	it('carries peer_recipient_pn (the gate diff) as a c.us Wid', async () => {
		const { modules, sent } = makeStubModules()
		const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
		await buildAndRelay(adapter, OTHER_LID, text('to a lid chat'), {
			messageId: 'SNAP0002',
			additionalAttributes: { peer_recipient_pn: OTHER_PN }
		})

		const stanza = sent[0]!
		expect((stanza.attrs.to as WaWid).toString()).toBe(OTHER_LID)
		expect(isWid(stanza.attrs.peer_recipient_pn)).toBe(true)
		expect((stanza.attrs.peer_recipient_pn as WaWid).toString()).toBe(`${OTHER_PN_USER}@c.us`)
	})

	it('issues our tctoken once after a send when WA Web holds none with a senderTimestamp', async () => {
		const { modules, sent, iqs, tokens } = makeStubModules()
		// the contact's token is there (so <tctoken> attaches) but we never issued ours
		tokens.set(OTHER_LID, { token: TC_TOKEN, timestamp: String(NOW_SEC) })
		modules.sendIq = async stanza => {
			iqs.push(stanza)
			const tokenNodes = (stanza.content as WaWapNode[])[0]!.content as WaWapNode[]
			return {
				tag: 'iq',
				attrs: { type: 'result', from: makeWid('@s.whatsapp.net') },
				content: [
					{
						tag: 'tokens',
						attrs: {},
						content: tokenNodes.map(t => ({
							tag: 'token',
							attrs: { jid: t.attrs.jid!, t: t.attrs.t!, type: 'trusted_contact' },
							content: Buffer.alloc(16, 0xee)
						}))
					}
				]
			}
		}

		const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
		await buildAndRelay(adapter, OTHER_PN, text('first of the week'), { messageId: 'SNAP0001' })
		expect(sent).toHaveLength(1)

		// the issuance runs fire-and-forget after sendNode; wait for it to land
		for (let i = 0; i < 50 && !tokens.get(OTHER_LID)?.senderTimestamp; i++) {
			await new Promise(r => setTimeout(r, 5))
		}

		expect(iqs).toHaveLength(1)
		const iq = iqs[0]!
		expect(iq.attrs.xmlns).toBe('privacy')
		expect(iq.attrs.type).toBe('set')
		expect((iq.attrs.to as WaWid).toString()).toBe('@s.whatsapp.net')
		const token = ((iq.content as WaWapNode[])[0]!.content as WaWapNode[])[0]!
		expect(token.attrs.type).toBe('trusted_contact')
		expect((token.attrs.jid as WaWid).toString()).toBe(`${OTHER_PN_USER}@c.us`)

		// the whole chain completed: WA Web's store now carries our senderTimestamp, and the core's own
		// `__index` bookkeeping row (not a jid) stayed inside the adapter instead of reaching WA Web
		expect(tokens.get(OTHER_LID)?.senderTimestamp).toBeGreaterThan(0)
		expect([...tokens.keys()].every(k => k.includes('@'))).toBe(true)
		const index = await adapter.keys.get('tctoken', ['__index'])
		expect(JSON.parse(Buffer.from(index['__index']!.token).toString())).toEqual([OTHER_LID])

		// a second send in the same bucket issues nothing
		await buildAndRelay(adapter, OTHER_PN, text('second of the week'), { messageId: 'SNAP0001' })
		await new Promise(r => setTimeout(r, 20))
		expect(iqs).toHaveLength(1)
		expect(sent).toHaveLength(2)
	})

	it('swallows an onAck listener fault after the stanza went out', async () => {
		const { modules, sent } = makeStubModules()
		const adapter = makeWaWebAdapter({
			modules,
			logger: logger.child({}, { level: 'silent' }),
			onAck: () => {
				throw new Error('listener bug')
			}
		})
		await expect(buildAndRelay(adapter, OTHER_PN, text('still fine'), { messageId: 'SNAP0001' })).resolves.toBe(
			'SNAP0001'
		)
		expect(sent).toHaveLength(1)
	})

	describe('groups', () => {
		const participantsOf = (stanza: WaWapNode) =>
			((stanza.content as WaWapNode[]).find(n => n.tag === 'participants')?.content as WaWapNode[] | undefined)?.map(
				to => (to.attrs.jid as WaWid).toString()
			)

		it('records delivered sender keys in WA Web (other devices) and in the adapter (own devices) after the ack', async () => {
			const stub = makeStubModules()
			const { modules, sent, senderKeyRow } = stub
			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })

			// WA Web's table holds exactly the other members' devices, never ours
			expect([...senderKeyRow(GROUP_JID).keyed].sort()).toEqual(
				[`${OTHER_PN_USER}@c.us`, `${OTHER_PN_USER}:3@c.us`, `${THIRD_PN_USER}@c.us`].sort()
			)
			// the core sees the union (our primary stays in the adapter), so the next send carries no key
			// distribution at all
			const memory = await adapter.keys.get('sender-key-memory', [GROUP_JID])
			expect(Object.keys(memory[GROUP_JID]!).sort()).toEqual(
				[`${ME_PN_USER}@s.whatsapp.net`, OTHER_PN, `${OTHER_PN_USER}:3@s.whatsapp.net`, THIRD_PN].sort()
			)
			await buildAndRelay(adapter, GROUP_JID, text('hello again group'), { messageId: 'SNAP0009' })
			expect(sent).toHaveLength(2)
			expect(participantsOf(sent[1]!)).toBeUndefined()
		})

		it('keeps a failed send out of the sender-key bookkeeping', async () => {
			const stub = makeStubModules()
			const { modules, senderKeyRow } = stub
			modules.sendStanzaAndReturnAck = async () => {
				throw new Error('socket closed')
			}

			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await expect(buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })).rejects.toThrow(
				'socket closed'
			)

			expect(senderKeyRow(GROUP_JID).keyed.size).toBe(0)
			expect(await adapter.keys.get('sender-key-memory', [GROUP_JID])).toEqual({ [GROUP_JID]: {} })
			expect(adapter.keys.isInTransaction()).toBe(false)

			// the retry distributes the key to everyone again, as if the first attempt never happened
			const sent: WaWapNode[] = []
			modules.sendStanzaAndReturnAck = async stanza => {
				sent.push(stanza)
				return { ack: true }
			}

			await buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })
			expect(binaryNodeToString(wapToBinary(sent[0]!))).toBe(fixtures['group-skmsg-fresh-pn']!.xml)
		})

		it('rotates the sender key when WA Web flagged the group, and redistributes to everyone', async () => {
			const stub = makeStubModules()
			const { modules, sent, senderKeyRow, deletedSenderKeys } = stub
			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })
			expect(deletedSenderKeys).toEqual([])

			// a member left: WA Web raises rotateKey on the participant row
			senderKeyRow(GROUP_JID).rotateKey = true
			await buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })

			expect(deletedSenderKeys).toEqual([GROUP_JID])
			expect(sent).toHaveLength(2)
			// own devices included: the adapter's own-device bookkeeping was reset along with the key
			expect(binaryNodeToString(wapToBinary(sent[1]!))).toBe(fixtures['group-skmsg-fresh-pn']!.xml)
			expect(senderKeyRow(GROUP_JID).rotateKey).toBe(false)
			// a third send is quiet again
			await buildAndRelay(adapter, GROUP_JID, text('hello again group'), { messageId: 'SNAP0009' })
			expect(deletedSenderKeys).toEqual([GROUP_JID])
			expect(participantsOf(sent[2]!)).toBeUndefined()
		})

		it('reads members and addressing mode from WA Web, never from the wire', async () => {
			const stub = makeStubModules()
			const { modules, sent, iqs } = stub
			modules.groupMetadata = async () => undefined
			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await expect(buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })).rejects.toThrow(
				/holds no metadata/
			)
			expect(iqs).toHaveLength(0)
			expect(sent).toHaveLength(0)
		})

		it('stamps the expiration attribute from the group timer', async () => {
			const stub = makeStubModules()
			const { modules, sent } = stub
			modules.groupMetadata = async () => ({
				participants: GROUP_MEMBERS.pn.map(makeWid),
				addressingMode: 'pn',
				ephemeralDuration: 86400
			})
			const adapter = makeWaWebAdapter({ modules, logger: silent() })
			await buildAndRelay(adapter, GROUP_JID, text('hello group'), { messageId: 'SNAP0007' })
			expect(sent[0]!.attrs.expiration).toBe('86400')
		})
	})

	it('round-trips jids through wids without changing their spelling', () => {
		for (const jid of [OTHER_PN, OTHER_LID, `${OTHER_PN_USER}:3@s.whatsapp.net`, `${ME_LID_USER}:7@lid`]) {
			const decoded = jidDecode(jid)!
			const wid = makeWid(
				`${decoded.user}${decoded.device ? `:${decoded.device}` : ''}@${decoded.server === 's.whatsapp.net' ? 'c.us' : decoded.server}`
			)
			expect(widToJid(wid)).toBe(jid)
		}
	})
})
