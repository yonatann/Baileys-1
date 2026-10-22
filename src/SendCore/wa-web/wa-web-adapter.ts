import NodeCache from '@cacheable/node-cache'
import { Boom } from '@hapi/boom'
import { DEFAULT_CACHE_TTLS } from '../../Defaults'
import type { SignalDataSet, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'
import { DEFAULT_LID_REFETCH_THROTTLE_SEC } from '../../Utils'
import type { ILogger } from '../../Utils/logger'
import { makeKeyedMutex, makeMutex } from '../../Utils/make-mutex'
import { type BinaryNode, jidDecode, jidEncode, type JidServer, type JidWithDevice } from '../../WABinary'
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
 * - Keys: WA Web has no `SignalKeyStore`; `sender-key-memory` and `device-list` live in memory here,
 *   `tctoken` reads through to WA Web's token store.
 *
 * Groups (sender keys) are not wired yet: `encryptGroupMessage` throws until that slice lands.
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

	// In-memory store for the key types the send core touches; tctoken reads through to WA Web.
	const memory: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] } } = {}
	const keys: SignalKeyStoreWithTransaction = {
		async get(type, ids) {
			const out: { [id: string]: SignalDataTypeMap[typeof type] } = {}
			for (const id of ids) {
				if (type === 'tctoken') {
					const entry = await modules.tcToken.get(jidToWid(id))
					if (entry) {
						out[id] = { ...entry, token: Buffer.from(entry.token) } as SignalDataTypeMap[typeof type]
					}

					continue
				}

				const value = memory[type]?.[id]
				if (value !== undefined) {
					out[id] = value
				}
			}

			return out
		},
		async set(data: SignalDataSet) {
			for (const type of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
				const entries = data[type]
				if (!entries) continue
				for (const [id, value] of Object.entries(entries)) {
					if (type === 'tctoken') {
						await modules.tcToken.set(jidToWid(id), value as SignalDataTypeMap['tctoken'] | null)
						continue
					}

					const bucket = (memory[type] ||= {}) as { [id: string]: unknown }
					if (value === null) {
						delete bucket[id]
					} else {
						bucket[id] = value
					}
				}
			}
		},
		isInTransaction: () => false,
		// WA Web serialises Signal work through its per-chat queues; the host runs buildAndRelay from
		// inside that queue, so there is nothing to batch here.
		transaction: exec => exec()
	}

	const signal: SendCoreSignal = {
		async encryptMessage({ jid, data }) {
			return modules.signal.encryptSignalProto(jidToWid(jid), data)
		},
		async encryptGroupMessage() {
			throw new Boom('wa-web adapter: group sends are not wired yet', { statusCode: 501 })
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
			devices: { deviceList: devices.map(d => ({ id: d.id, keyIndex: d.keyIndex })) }
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
			onAck?.(node.attrs.id, ack)
		},
		query: async node => toBinaryNode(modules.readWapNode(await modules.sendIq(toWapNode(node)))),
		executeUSyncQuery,
		groupMetadata: async jid => {
			throw new Boom(`wa-web adapter: group metadata for ${jid} is not wired yet`, { statusCode: 501 })
		},
		cachedGroupMetadata: undefined,
		patchMessageBeforeSending: msg => msg,
		serverProps: {
			get privacyTokenOn1to1() {
				return modules.abProps().privacyTokenOn1to1
			},
			get lidTrustedTokenIssueToLid() {
				return modules.abProps().lidTrustedTokenIssueToLid
			}
		},
		userDevicesCache: new NodeCache<JidWithDevice[]>({ stdTTL: DEFAULT_CACHE_TTLS.USER_DEVICES, useClones: false }),
		devicesMutex: makeMutex(),
		lidForceRefetchThrottle: new NodeCache<boolean>({ stdTTL: DEFAULT_LID_REFETCH_THROTTLE_SEC, useClones: false }),
		encryptionMutex: makeKeyedMutex(),
		inFlightTcTokenIssuance: new Set<string>(),
		messageRetryManager: null
	}
}
