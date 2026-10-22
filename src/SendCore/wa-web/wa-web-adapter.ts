import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import {
	type GroupMetadata,
	type PossiblyExtendedCacheStore,
	type SignalDataSet,
	type SignalDataTypeMap,
	type SignalKeyStoreWithTransaction,
	WAMessageAddressingMode
} from '../../Types'
import { DEFAULT_LID_REFETCH_THROTTLE_SEC } from '../../Utils'
import type { ILogger } from '../../Utils/logger'
import { makeKeyedMutex, makeMutex } from '../../Utils/make-mutex'
import { type BinaryNode, jidDecode, jidEncode, type JidServer } from '../../WABinary'
import type { USyncQuery, USyncQueryResult, USyncQueryResultList } from '../../WAUSync'
import type { SendCoreAdapter, SendCoreSignal } from '../types'
import type { WaWapNode, WaWebModules, WaWid } from './modules'

/**
 * Binds the send core to a live WA Web page: WA Web's own socket, Signal store, device list and
 * tokens. No second socket, no second identity, no second ratchet. The extension passes the WA Web
 * modules in (`WaWebModules`); this file owns only the shape translation between the two worlds:
 *
 * - JIDs: WA Web says `c.us`, Baileys says `s.whatsapp.net`; `lid` and `g.us` match.
 * - Nodes: `BinaryNode` and `WapNode` are the same tag / attrs / children tree; JID-valued attrs become Wids.
 * - Keys: WA Web has no `SignalKeyStore`; `tctoken` reads through to WA Web's token store and
 *   `sender-key-memory` to its participant table, `device-list` lives in memory here.
 * - Groups: the skmsg ciphertext and the sender-key distribution message come from WA Web's own
 *   sender-key session for the group; member lists and addressing mode from its group model.
 */

const JID_ATTRS = new Set(['to', 'from', 'participant', 'recipient', 'jid', 'peer_recipient_pn'])

const WA_WEB_TO_BAILEYS_SERVER: { [server: string]: JidServer } = { 'c.us': 's.whatsapp.net' }
const BAILEYS_TO_WA_WEB_SERVER: { [server: string]: string } = { 's.whatsapp.net': 'c.us' }

export const widToJid = (wid: WaWid): string =>
	jidEncode(wid.user, WA_WEB_TO_BAILEYS_SERVER[wid.server] ?? (wid.server as JidServer), wid.device)

export const makeJidToWid =
	(makeWid: WaWebModules['makeWid']) =>
	(jid: string): WaWid => {
		const decoded = jidDecode(jid)
		if (!decoded) {
			throw new Boom(`not a jid: ${jid}`, { statusCode: 400 })
		}

		// the c.us spelling is for USER jids only: the bare server jid (`@s.whatsapp.net`, the `to` of
		// every IQ) stays as it is
		const server = decoded.user ? (BAILEYS_TO_WA_WEB_SERVER[decoded.server] ?? decoded.server) : decoded.server
		return makeWid(`${decoded.user}${decoded.device ? `:${decoded.device}` : ''}@${server}`)
	}

const isWid = (value: unknown): value is WaWid =>
	typeof value === 'object' && value !== null && 'user' in value && 'server' in value

const noDeviceCache: PossiblyExtendedCacheStore = {
	get: () => undefined,
	set: () => {},
	del: () => {},
	flushAll: () => {}
}

export type WaWebAdapterOptions = {
	modules: WaWebModules
	logger: ILogger
	/** Called with the server ack for every `<message>` the adapter put on the wire, keyed by stanza id. */
	onAck?: (id: string, ack: unknown) => void
}

export const makeWaWebAdapter = ({ modules, logger, onAck }: WaWebAdapterOptions): SendCoreAdapter => {
	const jidToWid = makeJidToWid(modules.makeWid)

	const toWapNode = (node: BinaryNode): WaWapNode => {
		const attrs: WaWapNode['attrs'] = {}
		for (const [key, value] of Object.entries(node.attrs)) {
			if (value === undefined) continue
			attrs[key] = JID_ATTRS.has(key) ? jidToWid(value) : value
		}

		const content = Array.isArray(node.content) ? node.content.map(toWapNode) : node.content
		return modules.makeWapNode(node.tag, attrs, content)
	}

	const toBinaryNode = (node: WaWapNode): BinaryNode => {
		const attrs: BinaryNode['attrs'] = {}
		for (const [key, value] of Object.entries(node.attrs)) {
			attrs[key] = isWid(value) ? widToJid(value) : value
		}

		const content = Array.isArray(node.content) ? node.content.map(toBinaryNode) : node.content
		return { tag: node.tag, attrs, content }
	}

	const isMeDevice = (jid: string) => {
		const me = modules.me()
		const user = jidDecode(jid)?.user
		return !!me && !!user && (user === me.pn.user || user === me.lid?.user)
	}

	// Key store the send core writes through. Two of its types belong to WA Web and read through:
	// - `tctoken` for jid-keyed entries (WA Web's token store). The core also keeps a bookkeeping row under
	//   `TC_TOKEN_INDEX_KEY` (`__index`, the list of jids it has tokens for); not a jid, stays in memory.
	// - `sender-key-memory` (which devices hold our sender key for a group) = WA Web's participant table,
	//   so native and raw sends agree on who still needs the key. WA Web never tracks the account's own
	//   devices there (it never fans out to them; the core does), so those live in `ownDeviceKeys`.
	// Everything else (`device-list`) is in memory.
	const memory: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] } } = {}
	const ownDeviceKeys: { [group: string]: { [deviceJid: string]: boolean } } = {}
	// groups whose key WA Web flagged for rotation (a member left): the next encrypt drops the key first
	const pendingRotation = new Set<string>()
	const isWaWebToken = (type: keyof SignalDataTypeMap, id: string) => type === 'tctoken' && !!jidDecode(id)

	const readSenderKeyMemory = async (group: string): Promise<SignalDataTypeMap['sender-key-memory']> => {
		const { keyed, rotateKey } = await modules.senderKeys.get(jidToWid(group))
		if (rotateKey) {
			pendingRotation.add(group)
			return {}
		}

		const map: SignalDataTypeMap['sender-key-memory'] = { ...ownDeviceKeys[group] }
		for (const wid of keyed) {
			map[widToJid(wid)] = true
		}

		return map
	}

	const writeSenderKeyMemory = async (group: string, map: SignalDataTypeMap['sender-key-memory'] | null) => {
		if (!map) {
			delete ownDeviceKeys[group]
			return
		}

		const others: WaWid[] = []
		const own: { [deviceJid: string]: boolean } = {}
		for (const [deviceJid, hasKey] of Object.entries(map)) {
			if (!hasKey) continue
			if (isMeDevice(deviceJid)) {
				own[deviceJid] = true
			} else {
				others.push(jidToWid(deviceJid))
			}
		}

		ownDeviceKeys[group] = own
		if (others.length) {
			await modules.senderKeys.markHasSenderKey(jidToWid(group), others)
		}
	}

	const readOne = async (type: keyof SignalDataTypeMap, id: string): Promise<unknown> => {
		if (isWaWebToken(type, id)) {
			const entry = await modules.tcToken.get(jidToWid(id))
			return entry ? { ...entry, token: Buffer.from(entry.token) } : undefined
		}

		if (type === 'sender-key-memory') {
			return readSenderKeyMemory(id)
		}

		return memory[type]?.[id]
	}

	const writeOne = async (type: keyof SignalDataTypeMap, id: string, value: unknown) => {
		if (isWaWebToken(type, id)) {
			await modules.tcToken.set(jidToWid(id), value as SignalDataTypeMap['tctoken'] | null)
			return
		}

		if (type === 'sender-key-memory') {
			await writeSenderKeyMemory(id, value as SignalDataTypeMap['sender-key-memory'] | null)
			return
		}

		const bucket = (memory[type] ||= {}) as { [id: string]: unknown }
		if (value === null) {
			delete bucket[id]
		} else {
			bucket[id] = value
		}
	}

	// The core wraps a send in `keys.transaction` and writes `sender-key-memory` BEFORE the stanza goes
	// out; the Baileys store buffers those writes and drops them when the send throws. Same here: inside
	// a transaction, writes land in `pending` (reads see them), and only a transaction that returns
	// normally flushes them. A failed group send therefore never records a sender key as delivered,
	// and the flush matches WA Web's own order (`markHasSenderKey` after the ack). WA Web runs the send
	// from inside its per-chat queue, so transactions never overlap; a nested one joins the outer.
	let txDepth = 0
	let pending: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } } = {}

	const keys: SignalKeyStoreWithTransaction = {
		async get(type, ids) {
			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				const buffered = pending[type]
				const value = buffered && id in buffered ? buffered[id] : await readOne(type, id)
				if (value !== undefined && value !== null) {
					out[id] = value as SignalDataTypeMap[typeof type]
				}
			}

			return out
		},
		async set(data: SignalDataSet) {
			for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
				const entries = data[type]
				if (!entries) continue
				for (const [id, value] of Object.entries(entries)) {
					if (txDepth > 0) {
						const bucket = (pending[type] ||= {}) as { [id: string]: unknown }
						bucket[id] = value
					} else {
						await writeOne(type, id, value)
					}
				}
			}
		},
		isInTransaction: () => txDepth > 0,
		async transaction(exec) {
			txDepth++
			try {
				const result = await exec()
				if (txDepth === 1) {
					const toFlush = pending
					pending = {}
					for (const type of Object.keys(toFlush) as (keyof SignalDataTypeMap)[]) {
						for (const [id, value] of Object.entries(toFlush[type] ?? {})) {
							await writeOne(type, id, value)
						}
					}
				}

				return result
			} catch (err) {
				if (txDepth === 1) {
					pending = {}
				}

				throw err
			} finally {
				txDepth--
			}
		}
	}

	const signal: SendCoreSignal = {
		async encryptMessage({ jid, data }) {
			return modules.signal.encryptSignalProto(jidToWid(jid), data)
		},
		async encryptGroupMessage({ group, data, meId }) {
			const groupWid = jidToWid(group)
			const meWid = jidToWid(meId)
			if (pendingRotation.has(group)) {
				// a member left since the last send: fresh key, and nobody (own devices included) holds it yet
				await modules.signal.deleteGroupSenderKeyInfo(groupWid, meWid)
				delete ownDeviceKeys[group]
				pendingRotation.delete(group)
			}

			const { ciphertext, senderKeyBytes } = await modules.signal.encryptSenderKeyMsgSignalProto(groupWid, meWid, data)
			return { ciphertext, senderKeyDistributionMessage: senderKeyBytes }
		},
		async validateSession(jid) {
			const [exists] = await modules.signal.hasSignalSessions([jidToWid(jid)])
			return { exists: !!exists }
		},
		async injectE2ESession({ jid, session }) {
			await modules.signal.createSignalSession(jidToWid(jid), session)
		},
		lidMapping: {
			async getLIDForPN(pn) {
				const lid = modules.lidForPn(jidToWid(pn))
				return lid ? widToJid(lid) : null
			},
			async getPNForLID(lid) {
				const pn = modules.pnForLid(jidToWid(lid))
				return pn ? widToJid(pn) : null
			},
			async getLIDsForPNs(pns) {
				const pairs = pns.flatMap(pn => {
					const lid = modules.lidForPn(jidToWid(pn))
					return lid ? [{ pn, lid: widToJid(lid) }] : []
				})
				return pairs.length ? pairs : null
			},
			// WA Web owns the LID/PN cache; a usync answer never teaches it anything new.
			async storeLIDPNMappings() {}
		}
	}

	const readGroupMetadata = async (jid: string): Promise<GroupMetadata | undefined> => {
		const model = await modules.groupMetadata(jidToWid(jid))
		if (!model) {
			return undefined
		}

		return {
			id: jid,
			owner: undefined,
			subject: '',
			addressingMode: model.addressingMode === 'lid' ? WAMessageAddressingMode.LID : WAMessageAddressingMode.PN,
			ephemeralDuration: model.ephemeralDuration,
			participants: model.participants.map(wid => ({ id: widToJid(wid), admin: null }))
		}
	}

	const executeUSyncQuery = async (query: USyncQuery): Promise<USyncQueryResult | undefined> => {
		const ids = query.users.map(u => u.id).filter((id): id is string => !!id)
		if (!ids.length) {
			return { list: [], sideList: [] }
		}

		// No `lid` on the entries on purpose: the core treats a lid in a usync answer as a NEW mapping and
		// force-refetches identities for it (a wire IQ that would replace WA Web's live sessions). WA Web
		// already knows the mapping; the core reads it through `lidMapping` when it needs it.
		const records = await modules.getDeviceIds(ids.map(jidToWid))
		const list: USyncQueryResultList[] = records.map(({ wid, devices }) => ({
			id: widToJid(wid),
			devices: { deviceList: devices.map(d => ({ id: d.id, keyIndex: d.keyIndex, isHosted: d.isHosted })) }
		}))
		return { list, sideList: [] }
	}

	return {
		logger,
		me: () => {
			const me = modules.me()
			return me ? { id: widToJid(me.pn), lid: me.lid ? widToJid(me.lid) : undefined } : undefined
		},
		account: () => modules.signedDeviceIdentity(),
		signal,
		keys,
		sendNode: async node => {
			const to = node.attrs.to
			if (node.tag !== 'message' || !node.attrs.id || !to) {
				throw new Boom('wa-web adapter: sendNode only carries <message> stanzas', { statusCode: 400 })
			}

			const ack = await modules.sendStanzaAndReturnAck(
				toWapNode(node),
				modules.makeAckTemplate({ id: node.attrs.id, cls: 'message', from: jidToWid(to) })
			)
			// the stanza is on the wire by now: a listener fault must not surface as a failed send
			try {
				onAck?.(node.attrs.id, ack)
			} catch (err) {
				logger.warn({ id: node.attrs.id, err }, 'wa-web adapter: onAck listener threw')
			}
		},
		query: async node => toBinaryNode(modules.readWapNode(await modules.sendIq(toWapNode(node)))),
		executeUSyncQuery,
		// both read WA Web's live group model: the "cache" IS the source of truth here, and the core's
		// fallback must never turn into a wire IQ behind WA Web's back
		groupMetadata: async jid => {
			const metadata = await readGroupMetadata(jid)
			if (!metadata) {
				throw new Boom(`wa-web adapter: WA Web holds no metadata for ${jid}`, { statusCode: 404 })
			}

			return metadata
		},
		cachedGroupMetadata: readGroupMetadata,
		patchMessageBeforeSending: msg => msg,
		serverProps: {
			get privacyTokenOn1to1() {
				return modules.abProps().privacyTokenOn1to1
			},
			get lidTrustedTokenIssueToLid() {
				return modules.abProps().lidTrustedTokenIssueToLid
			}
		},
		// WA Web keeps the device list current from its own device notifications; a private copy here
		// would go stale against it, so every send asks WA Web (getDeviceIds) and nothing is cached.
		userDevicesCache: noDeviceCache,
		devicesMutex: makeMutex(),
		lidForceRefetchThrottle: new NodeCache<boolean>({ stdTTL: DEFAULT_LID_REFETCH_THROTTLE_SEC, useClones: false }),
		encryptionMutex: makeKeyedMutex(),
		inFlightTcTokenIssuance: new Set<string>(),
		messageRetryManager: null
	}
}
