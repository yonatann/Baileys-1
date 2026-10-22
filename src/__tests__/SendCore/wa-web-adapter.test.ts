import { describe, expect, it, jest } from '@jest/globals'
import { createHash } from 'crypto'
import { readFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import type { proto } from '../../../WAProto/index.js'
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
 * Covers the 1:1 cases only: group sends need sender keys, which this adapter does not wire yet.
 */

const ME_PN_USER = '972500000001'
const ME_LID_USER = '100000000000001'
const ME_DEVICE = 7
const OTHER_PN_USER = '972500000002'
const OTHER_LID_USER = '100000000000002'
const OTHER_PN = `${OTHER_PN_USER}@s.whatsapp.net`
const OTHER_LID = `${OTHER_LID_USER}@lid`

const LID_USER_BY_PN_USER: Record<string, string> = {
	[ME_PN_USER]: ME_LID_USER,
	[OTHER_PN_USER]: OTHER_LID_USER
}
const PN_USER_BY_LID_USER: Record<string, string> = Object.fromEntries(
	Object.entries(LID_USER_BY_PN_USER).map(([pn, lid]) => [lid, pn])
)

/** device records per user, as WA Web's device list stores them (keyIndex only on companions) */
const DEVICES_BY_USER: Record<string, { id: number; keyIndex?: number }[]> = {
	[ME_PN_USER]: [{ id: 0 }, { id: ME_DEVICE, keyIndex: 1 }],
	[ME_LID_USER]: [{ id: 0 }, { id: ME_DEVICE, keyIndex: 1 }],
	[OTHER_PN_USER]: [{ id: 0 }, { id: 3, keyIndex: 1 }],
	[OTHER_LID_USER]: [{ id: 0 }, { id: 3, keyIndex: 1 }]
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

const makeStubModules = () => {
	const sent: WaWapNode[] = []
	const iqs: WaWapNode[] = []
	const tokens = new Map<string, { token: Uint8Array; timestamp?: string; senderTimestamp?: number }>()
	for (const lidUser of [ME_LID_USER, OTHER_LID_USER]) {
		tokens.set(`${lidUser}@lid`, { token: TC_TOKEN, timestamp: String(NOW_SEC), senderTimestamp: NOW_SEC })
	}

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
			}
		},
		getDeviceIds: async wids =>
			wids.map(wid => ({ wid: makeWid(`${wid.user}@${wid.server}`), devices: DEVICES_BY_USER[wid.user] ?? [] })),
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
	return { modules, sent, iqs }
}

const FIXTURE_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'Socket',
	'__fixtures__',
	'send-core-stanzas.json'
)
const fixtures: Record<string, { hex: string; xml: string }> = JSON.parse(readFileSync(FIXTURE_PATH, 'utf-8'))

const text = (conversation: string): proto.IMessage => ({ conversation })

type Case = { name: string; jid: string; message: proto.IMessage; options: MessageRelayOptions }

/** the 1:1 cases of the socket snapshot, by fixture name, verbatim */
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
			const { modules, sent, iqs } = makeStubModules()
			const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
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

	it('refuses group sends until sender keys are wired', async () => {
		const { modules, sent } = makeStubModules()
		const adapter = makeWaWebAdapter({ modules, logger: logger.child({}, { level: 'silent' }) })
		await expect(
			buildAndRelay(adapter, '120363000000000001@g.us', text('hello group'), { messageId: 'SNAP0007' })
		).rejects.toThrow(/not wired yet/)
		expect(sent).toHaveLength(0)
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
