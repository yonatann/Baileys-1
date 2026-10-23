import NodeCache from '@cacheable/node-cache'
import { describe, expect, it, jest } from '@jest/globals'
import type { proto } from '../../../WAProto/index.js'
import type { GroupResendAdapter } from '../../SendCore/group-resend'
import type { GroupMetadata, SignalKeyStoreWithTransaction } from '../../Types'
import type { BinaryNode, JidWithDevice } from '../../WABinary'
import type { USyncQueryResult } from '../../WAUSync'

const { proto: protoRuntime } = await import('../../../WAProto/index.js')
const { resendGroupMsgToMissingDevices } = await import('../../SendCore/group-resend')
const { buildAndRelay } = await import('../../SendCore')
const { GroupFanoutRecordStore, PHASH_RESEND_MAX_AGE_MS, classifyPhashMismatch, computeResendDelta, isResendExpired } =
	await import('../../Utils/group-phash-resend')
const { buildFetchMissingPreKeysQuery, parseMissingPreKeyBundles } = await import('../../Utils/missing-prekeys')
const { unpadRandomMax16, generateParticipantHashV2 } = await import('../../Utils/generics')
const { default: logger } = await import('../../Utils/logger')
const { makeKeyedMutex, makeMutex } = await import('../../Utils/make-mutex')

/**
 * #376 gap 1: group resend on a server phash mismatch.
 *
 * The expected shape is WA Web's GROUP_DIRECT stanza (`WAWebSendMsgCreateDeviceStanza.createFanoutMsgStanza`
 * via `WAWebResendGroupMsg.resendGroupMsg`, dump F_-nTDaG0nK.pretty.js) and the
 * `WASmaxOutPreKeysFetchMissingPreKeysRequest` IQ (same dump).
 */

const ME_PN_USER = '972500000001'
const ME_LID_USER = '100000000000001'
const ME_ID = `${ME_PN_USER}:7@s.whatsapp.net`
const ME_LID = `${ME_LID_USER}:7@lid`
const OTHER_USER = '972500000002'
const OTHER_0 = `${OTHER_USER}@s.whatsapp.net`
const OTHER_1 = `${OTHER_USER}:1@s.whatsapp.net`
const OTHER_2 = `${OTHER_USER}:2@s.whatsapp.net`
const ME_PRIMARY = `${ME_PN_USER}@s.whatsapp.net`
const ME_COMPANION = `${ME_PN_USER}:3@s.whatsapp.net`
const GROUP = '120363000000000001@g.us'
const MSG_ID = '3EB0RESEND0000000001'

const message: proto.IMessage = {
	conversation: 'hello group',
	messageContextInfo: { deviceListMetadataVersion: 2 }
}

type Harness = {
	adapter: GroupResendAdapter
	sent: BinaryNode[]
	queries: BinaryNode[]
	encrypted: Array<{ jid: string; message: proto.IMessage }>
	records: InstanceType<typeof GroupFanoutRecordStore>
}

const makeHarness = ({
	usyncDevices,
	pkmsgFor = []
}: {
	usyncDevices: Record<string, number[]>
	pkmsgFor?: string[]
}): Harness => {
	const sent: BinaryNode[] = []
	const queries: BinaryNode[] = []
	const encrypted: Harness['encrypted'] = []
	const records = new GroupFanoutRecordStore()
	const keys = {
		get: async () => ({}),
		set: async () => undefined,
		transaction: async <T>(work: () => Promise<T>) => work(),
		isInTransaction: () => false
	} as unknown as SignalKeyStoreWithTransaction
	const usyncResult = {
		list: Object.entries(usyncDevices).map(([id, deviceIds]) => ({
			id,
			devices: { deviceList: deviceIds.map(d => ({ id: d, keyIndex: d === 0 ? undefined : 1 })) }
		}))
	} as unknown as USyncQueryResult

	const adapter: GroupResendAdapter = {
		logger,
		me: () => ({ id: ME_ID, lid: ME_LID }),
		account: () => ({ details: new Uint8Array([1]), accountSignature: new Uint8Array([2]) }),
		signal: {
			encryptMessage: async ({ jid, data }) => {
				encrypted.push({ jid, message: protoRuntime.Message.decode(unpadRandomMax16(data)) })
				return { type: pkmsgFor.includes(jid) ? 'pkmsg' : 'msg', ciphertext: new Uint8Array([9, 9]) }
			},
			encryptGroupMessage: async () => {
				throw new Error('a resend must never touch sender keys')
			},
			validateSession: async () => ({ exists: true }),
			injectE2ESession: async () => undefined,
			lidMapping: {
				getLIDForPN: async () => null,
				getPNForLID: async () => null,
				getLIDsForPNs: async () => null,
				storeLIDPNMappings: async () => undefined
			}
		},
		keys,
		sendNode: async node => {
			sent.push(node)
		},
		query: async node => {
			queries.push(node)
			return { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'list', attrs: {} }] }
		},
		executeUSyncQuery: async () => usyncResult,
		groupMetadata: async () => ({ id: GROUP, participants: [] }) as unknown as GroupMetadata,
		patchMessageBeforeSending: async msg => msg,
		serverProps: { privacyTokenOn1to1: false, lidTrustedTokenIssueToLid: false },
		userDevicesCache: new NodeCache<JidWithDevice[]>({ useClones: false }),
		devicesMutex: makeMutex(),
		lidForceRefetchThrottle: new NodeCache<boolean>({ useClones: false }),
		encryptionMutex: makeKeyedMutex(),
		inFlightTcTokenIssuance: new Set<string>(),
		groupFanoutRecords: records,
		messageRetryManager: null,
		sessionRegistrationId: async jid => (jid.startsWith(OTHER_USER) ? 4242 : undefined),
		localRegistrationId: () => 7
	}

	return { adapter, sent, queries, encrypted, records }
}

const record = (over: Partial<Parameters<InstanceType<typeof GroupFanoutRecordStore>['set']>[1]> = {}) => ({
	group: GROUP,
	sentPhash: '2:sentSent',
	oldAsSent: [OTHER_0, OTHER_1, ME_PRIMARY, ME_COMPANION],
	oldFiltered: [OTHER_0, OTHER_1, ME_PRIMARY, ME_COMPANION],
	addressingMode: 'pn',
	stanzaAttrs: { addressing_mode: 'pn' },
	message,
	extraAttrs: {},
	trailingNodes: [],
	sentAt: Date.now(),
	...over
})

const nowAck = () => Date.now()

describe('pure helpers', () => {
	it('computeResendDelta keeps only new devices, never removals', () => {
		expect(computeResendDelta(['a:0@s', 'a:1@s'], ['a:0@s', 'a:2@s', 'b:0@s', 'b:0@s'])).toEqual(['a:2@s', 'b:0@s'])
		expect(computeResendDelta(['a:0@s', 'a:1@s'], ['a:0@s'])).toEqual([])
	})

	it('the window is measured from the ack, against WA Web web_e2e_backfill_expire_time (5 min)', () => {
		expect(PHASH_RESEND_MAX_AGE_MS).toBe(5 * 60 * 1000)
		expect(isResendExpired(1_000, 1_000 + PHASH_RESEND_MAX_AGE_MS)).toBe(false)
		expect(isResendExpired(1_000, 1_001 + PHASH_RESEND_MAX_AGE_MS)).toBe(true)
	})

	it('the record store hands a record out once and is bounded', () => {
		const store = new GroupFanoutRecordStore(2)
		store.set('a', record())
		store.set('b', record())
		store.set('c', record())
		expect(store.take('a')).toBeUndefined()
		expect(store.take('b')).toBeDefined()
		expect(store.take('b')).toBeUndefined()
	})

	it('classifies which local recipe reproduces the server hash', () => {
		const oldAsSent = ['1:0@s.whatsapp.net', '1:99@s.whatsapp.net']
		const oldFiltered = ['1:0@s.whatsapp.net']
		const freshFiltered = ['1:0@s.whatsapp.net', '1:2@s.whatsapp.net']
		const sender = ME_ID
		const verdict = (serverPhash: string) =>
			classifyPhashMismatch({ serverPhash, oldAsSent, oldFiltered, freshFiltered, sender }).verdict
		expect(verdict(generateParticipantHashV2([...oldFiltered, sender]))).toBe('recipe')
		expect(verdict(generateParticipantHashV2([...freshFiltered, sender]))).toBe('stale-list')
		expect(verdict(generateParticipantHashV2([...oldAsSent, sender]))).toBe('sent-matches')
		expect(verdict('2:nope')).toBe('unknown')
	})
})

describe('FetchMissingPreKeys IQ (WASmaxOutPreKeysFetchMissingPreKeysRequest)', () => {
	it('lists known devices with a 4-byte big-endian registration under key_fetch', () => {
		const node = buildFetchMissingPreKeysQuery([
			{
				userJid: OTHER_0,
				devices: [
					{ deviceId: 0, registrationId: 0x01020304 },
					{ deviceId: 2, registrationId: 5 }
				]
			}
		])
		expect(node.tag).toBe('iq')
		expect(node.attrs).toEqual({ xmlns: 'encrypt', to: '@s.whatsapp.net', type: 'get' })
		const keyFetch = (node.content as BinaryNode[])[0]!
		expect(keyFetch.tag).toBe('key_fetch')
		const user = (keyFetch.content as BinaryNode[])[0]!
		expect(user.attrs).toEqual({ jid: OTHER_0 })
		const devices = user.content as BinaryNode[]
		expect(devices.map(d => d.attrs.id)).toEqual(['0', '2'])
		const reg = (devices[0]!.content as BinaryNode[])[0]!
		expect(reg.tag).toBe('registration')
		expect([...(reg.content as Uint8Array)]).toEqual([1, 2, 3, 4])
	})

	it('parses per-device bundles and skips malformed ones', () => {
		const key = (id: number, byte: number): BinaryNode[] => [
			{ tag: 'id', attrs: {}, content: new Uint8Array([0, 0, id]) },
			{ tag: 'value', attrs: {}, content: new Uint8Array(32).fill(byte) }
		]
		const device = (id: string, withIdentity: boolean): BinaryNode => ({
			tag: 'device',
			attrs: { id },
			content: [
				{ tag: 'registration', attrs: {}, content: new Uint8Array([0, 0, 1, 2]) },
				...(withIdentity ? [{ tag: 'identity', attrs: {}, content: new Uint8Array(32).fill(1) }] : []),
				{
					tag: 'skey',
					attrs: {},
					content: [...key(3, 2), { tag: 'signature', attrs: {}, content: new Uint8Array(64).fill(3) }]
				},
				{ tag: 'key', attrs: {}, content: key(4, 4) },
				{ tag: 'device-identity', attrs: {}, content: new Uint8Array([7]) }
			]
		})
		const { bundles, failedUsers } = parseMissingPreKeyBundles({
			tag: 'iq',
			attrs: {},
			content: [
				{
					tag: 'list',
					attrs: {},
					content: [
						{ tag: 'user', attrs: { jid: OTHER_0 }, content: [device('2', true), device('3', false)] },
						{
							tag: 'user',
							attrs: { jid: `${ME_PN_USER}@s.whatsapp.net` },
							content: [{ tag: 'error', attrs: { code: '500' } }]
						}
					]
				}
			]
		})
		expect(bundles.map(b => b.jid)).toEqual([OTHER_2])
		expect(bundles[0]!.session.registrationId).toBe(258)
		expect(bundles[0]!.session.signedPreKey.keyId).toBe(3)
		expect(bundles[0]!.session.preKey?.keyId).toBe(4)
		expect(bundles[0]!.session.deviceIdentity).toEqual(new Uint8Array([7]))
		expect(failedUsers).toBe(2)
	})
})

describe('resendGroupMsgToMissingDevices (WAWebResendGroupMsg parity)', () => {
	const usync = { [OTHER_0]: [0, 1, 2], [`${ME_PN_USER}@s.whatsapp.net`]: [0, 3, 7] }

	it('sends a GROUP_DIRECT stanza to new devices only: no phash, empty skmsg marker, DSM for own account', async () => {
		const h = makeHarness({ usyncDevices: usync, pkmsgFor: [OTHER_2] })
		h.records.set(MSG_ID, record())
		const out = await resendGroupMsgToMissingDevices(h.adapter, {
			msgId: MSG_ID,
			serverPhash: '2:serverXX',
			ackTimeMs: nowAck()
		})
		expect(out).toEqual({ status: 'resent', devices: [OTHER_2] })

		expect(h.sent).toHaveLength(1)
		const stanza = h.sent[0]!
		expect(stanza.tag).toBe('message')
		expect(stanza.attrs).toEqual({
			id: MSG_ID,
			to: GROUP,
			type: 'text',
			device_fanout: 'false',
			addressing_mode: 'pn'
		})
		const children = stanza.content as BinaryNode[]
		expect(children.map(c => c.tag)).toEqual(['participants', 'enc', 'device-identity'])
		const toNodes = children[0]!.content as BinaryNode[]
		expect(toNodes.map(n => n.attrs.jid)).toEqual([OTHER_2])
		const enc = (toNodes[0]!.content as BinaryNode[])[0]!
		expect(enc.attrs).toEqual({ v: '2', type: 'pkmsg' })
		expect(children[1]!.attrs).toEqual({ v: '2', type: 'skmsg' })
		expect(children[1]!.content).toBeUndefined()
		// the plain message, not a sender-key distribution message
		expect(h.encrypted.map(e => e.message.conversation)).toEqual(['hello group'])
	})

	it('wraps the message as a device-sent message for a new device of our own account', async () => {
		const h = makeHarness({ usyncDevices: { [OTHER_0]: [0, 1], [`${ME_PN_USER}@s.whatsapp.net`]: [0, 3, 5, 7] } })
		h.records.set(MSG_ID, record())
		const out = await resendGroupMsgToMissingDevices(h.adapter, {
			msgId: MSG_ID,
			serverPhash: '2:serverXX',
			ackTimeMs: nowAck()
		})
		expect(out).toEqual({ status: 'resent', devices: [`${ME_PN_USER}:5@s.whatsapp.net`] })
		const dsm = h.encrypted[0]!.message.deviceSentMessage
		expect(dsm?.destinationJid).toBe(GROUP)
		expect(dsm?.message?.conversation).toBe('hello group')
		// no pkmsg → no device-identity
		expect((h.sent[0]!.content as BinaryNode[]).map(c => c.tag)).toEqual(['participants', 'enc'])
	})

	it('keeps the original edit attr and does not run the patch hook again', async () => {
		const h = makeHarness({ usyncDevices: usync })
		const patch = jest.fn(async (m: proto.IMessage) => m)
		h.adapter.patchMessageBeforeSending = patch
		h.records.set(MSG_ID, record({ stanzaAttrs: { addressing_mode: 'pn', edit: '7' } }))
		await resendGroupMsgToMissingDevices(h.adapter, { msgId: MSG_ID, serverPhash: '2:serverXX', ackTimeMs: nowAck() })
		expect(h.sent[0]!.attrs.edit).toBe('7')
		expect(h.sent[0]!.attrs.phash).toBeUndefined()
		expect(patch).not.toHaveBeenCalled()
	})

	it('carries media attrs on the marker and the original trailing nodes', async () => {
		const h = makeHarness({ usyncDevices: usync })
		const meta: BinaryNode = { tag: 'meta', attrs: { polltype: 'vote' } }
		h.records.set(MSG_ID, record({ extraAttrs: { mediatype: 'image' }, trailingNodes: [meta] }))
		await resendGroupMsgToMissingDevices(h.adapter, { msgId: MSG_ID, serverPhash: '2:serverXX', ackTimeMs: nowAck() })
		const children = h.sent[0]!.content as BinaryNode[]
		expect(children.map(c => c.tag)).toEqual(['participants', 'enc', 'meta'])
		expect(children[1]!.attrs).toEqual({ v: '2', type: 'skmsg', mediatype: 'image' })
	})

	it('first asks the server for missing bundles with the registration ids it holds', async () => {
		const h = makeHarness({ usyncDevices: usync })
		h.records.set(MSG_ID, record())
		await resendGroupMsgToMissingDevices(h.adapter, { msgId: MSG_ID, serverPhash: '2:serverXX', ackTimeMs: nowAck() })
		expect(h.queries).toHaveLength(1)
		const keyFetch = (h.queries[0]!.content as BinaryNode[])[0]!
		expect(keyFetch.tag).toBe('key_fetch')
		const users = keyFetch.content as BinaryNode[]
		const other = users.find(u => u.attrs.jid === OTHER_0)!
		expect((other.content as BinaryNode[]).map(d => d.attrs.id)).toEqual(['0', '1'])
	})

	it('does nothing when the ack phash equals the one we sent', async () => {
		const h = makeHarness({ usyncDevices: usync })
		h.records.set(MSG_ID, record())
		expect(
			await resendGroupMsgToMissingDevices(h.adapter, { msgId: MSG_ID, serverPhash: '2:sentSent', ackTimeMs: nowAck() })
		).toEqual({ status: 'phash-matches' })
		expect(h.sent).toHaveLength(0)
	})

	it('skips when the ack is older than the resend window', async () => {
		const h = makeHarness({ usyncDevices: usync })
		h.records.set(MSG_ID, record())
		const out = await resendGroupMsgToMissingDevices(h.adapter, {
			msgId: MSG_ID,
			serverPhash: '2:serverXX',
			ackTimeMs: Date.now() - PHASH_RESEND_MAX_AGE_MS - 1_000
		})
		expect(out).toEqual({ status: 'expired' })
		expect(h.sent).toHaveLength(0)
	})

	it('is a no-op when there is nothing new', async () => {
		const h = makeHarness({ usyncDevices: { [OTHER_0]: [0, 1], [`${ME_PN_USER}@s.whatsapp.net`]: [0, 3, 7] } })
		h.records.set(MSG_ID, record())
		expect(
			await resendGroupMsgToMissingDevices(h.adapter, { msgId: MSG_ID, serverPhash: '2:serverXX', ackTimeMs: nowAck() })
		).toEqual({ status: 'no-new-devices' })
		expect(h.sent).toHaveLength(0)
	})

	it('resends at most once per message and ignores unknown ids', async () => {
		const h = makeHarness({ usyncDevices: usync })
		h.records.set(MSG_ID, record())
		const args = { msgId: MSG_ID, serverPhash: '2:serverXX', ackTimeMs: nowAck() }
		await resendGroupMsgToMissingDevices(h.adapter, args)
		expect(await resendGroupMsgToMissingDevices(h.adapter, args)).toEqual({ status: 'no-record' })
		expect(await resendGroupMsgToMissingDevices(h.adapter, { ...args, msgId: 'unknown' })).toEqual({
			status: 'no-record'
		})
		expect(h.sent).toHaveLength(1)
	})

	it('aborts when the group query fails, but only warns when the key fetch fails', async () => {
		const failedKeys = makeHarness({ usyncDevices: usync })
		failedKeys.adapter.query = jest.fn(async () => {
			throw new Error('iq timed out')
		})
		failedKeys.records.set(MSG_ID, record())
		expect(
			(
				await resendGroupMsgToMissingDevices(failedKeys.adapter, {
					msgId: MSG_ID,
					serverPhash: '2:serverXX',
					ackTimeMs: nowAck()
				})
			).status
		).toBe('resent')

		const failedGroup = makeHarness({ usyncDevices: usync })
		failedGroup.adapter.groupMetadata = async () => {
			throw new Error('group query failed')
		}

		failedGroup.records.set(MSG_ID, record())
		await expect(
			resendGroupMsgToMissingDevices(failedGroup.adapter, {
				msgId: MSG_ID,
				serverPhash: '2:serverXX',
				ackTimeMs: nowAck()
			})
		).rejects.toThrow('group query failed')
		expect(failedGroup.sent).toHaveLength(0)
	})
})

describe('buildAndRelay records the fan-out for a later mismatch', () => {
	it('keeps the sent phash, the device sets and the message of a group send', async () => {
		const h = makeHarness({ usyncDevices: { [OTHER_0]: [0, 1, 99], [ME_PRIMARY]: [0, 3, 7] } })
		h.adapter.signal.encryptGroupMessage = async () => ({
			senderKeyDistributionMessage: new Uint8Array([1]),
			ciphertext: new Uint8Array([2])
		})
		h.adapter.groupMetadata = async () =>
			({
				id: GROUP,
				addressingMode: 'pn',
				participants: [{ id: OTHER_0 }, { id: ME_PRIMARY }]
			}) as unknown as GroupMetadata
		await buildAndRelay(h.adapter, GROUP, message, { messageId: MSG_ID, useUserDevicesCache: false })

		const sentPhash = h.sent[0]!.attrs.phash
		expect(sentPhash).toMatch(/^2:/)
		const stored = h.records.take(MSG_ID)
		expect(stored?.sentPhash).toBe(sentPhash)
		expect(stored?.group).toBe(GROUP)
		expect(stored?.message).toEqual(message)
		expect(stored?.stanzaAttrs).toEqual({ addressing_mode: 'pn' })
		// the hash covers the filtered set (no device 99, no sending device) plus the sender
		expect(stored?.oldAsSent).toContain(`${OTHER_USER}:99@s.whatsapp.net`)
		expect(stored?.oldFiltered).toEqual([OTHER_0, OTHER_1, ME_PRIMARY, ME_COMPANION])
	})
})

describe('the stored payload is the patched one', () => {
	it('records the hook output and a resend encrypts it without running the hook again', async () => {
		const h = makeHarness({ usyncDevices: { [OTHER_0]: [0, 1, 2], [ME_PRIMARY]: [0, 3, 7] } })
		const patch = jest.fn(
			async (m: proto.IMessage): Promise<proto.IMessage> => ({ ...m, conversation: 'patched text' })
		)
		h.adapter.patchMessageBeforeSending = patch as GroupResendAdapter['patchMessageBeforeSending']
		h.adapter.signal.encryptGroupMessage = async () => ({
			senderKeyDistributionMessage: new Uint8Array([1]),
			ciphertext: new Uint8Array([2])
		})
		h.adapter.groupMetadata = async () =>
			({
				id: GROUP,
				addressingMode: 'pn',
				participants: [{ id: OTHER_0 }, { id: ME_PRIMARY }]
			}) as unknown as GroupMetadata
		// the original send sees only OTHER_0:[0,1]; device 2 is the one the server knows about
		h.adapter.executeUSyncQuery = async () =>
			({
				list: [
					{ id: OTHER_0, devices: { deviceList: [{ id: 0 }, { id: 1, keyIndex: 1 }] } },
					{ id: ME_PRIMARY, devices: { deviceList: [{ id: 0 }, { id: 3, keyIndex: 1 }, { id: 7, keyIndex: 1 }] } }
				]
			}) as unknown as USyncQueryResult
		await buildAndRelay(h.adapter, GROUP, message, { messageId: MSG_ID, useUserDevicesCache: false })
		expect(h.records.peek(MSG_ID)?.message.conversation).toBe('patched text')
		const callsAfterSend = patch.mock.calls.length

		h.adapter.executeUSyncQuery = async () =>
			({
				list: [
					{ id: OTHER_0, devices: { deviceList: [{ id: 0 }, { id: 1, keyIndex: 1 }, { id: 2, keyIndex: 1 }] } },
					{ id: ME_PRIMARY, devices: { deviceList: [{ id: 0 }, { id: 3, keyIndex: 1 }, { id: 7, keyIndex: 1 }] } }
				]
			}) as unknown as USyncQueryResult
		const out = await resendGroupMsgToMissingDevices(h.adapter, {
			msgId: MSG_ID,
			serverPhash: '2:serverXX',
			ackTimeMs: nowAck()
		})
		expect(out).toEqual({ status: 'resent', devices: [OTHER_2] })
		expect(h.encrypted.at(-1)?.message.conversation).toBe('patched text')
		expect(patch.mock.calls.length).toBe(callsAfterSend)
	})
})
