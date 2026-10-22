import type NodeCache from '@cacheable/node-cache'
import type { proto } from '../../WAProto/index.js'
import type {
	GroupMetadata,
	LIDMapping,
	PossiblyExtendedCacheStore,
	SignalKeyStoreWithTransaction,
	SignalRepository,
	SocketConfig
} from '../Types'
import type { GroupFanoutRecordStore } from '../Utils/group-phash-resend'
import type { ILogger } from '../Utils/logger'
import type { KeyedMutex, Mutex } from '../Utils/make-mutex'
import type { MessageRetryManager } from '../Utils/message-retry-manager'
import type { BinaryNode, JidWithDevice } from '../WABinary'
import type { USyncQuery, USyncQueryResult } from '../WAUSync'

/** Device info with wire JID */
export type DeviceWithJid = JidWithDevice & {
	jid: string
}

/** The slice of the LID mapping store the send core reads and writes. */
export type SendCoreLidMapping = {
	getLIDForPN(pn: string): Promise<string | null>
	getPNForLID(lid: string): Promise<string | null>
	getLIDsForPNs(pns: string[], opts?: { bypassNegativeCache?: boolean }): Promise<LIDMapping[] | null>
	storeLIDPNMappings(pairs: LIDMapping[]): Promise<void>
}

/** The slice of the signal repository the send core needs: encrypt, session presence, prekey injection. */
export type SendCoreSignal = Pick<
	SignalRepository,
	'encryptMessage' | 'encryptGroupMessage' | 'validateSession' | 'injectE2ESession'
> & {
	lidMapping: SendCoreLidMapping
}

export type SendCoreServerProps = {
	/** AB prop 10518: gate tctoken on 1:1 messages. */
	privacyTokenOn1to1: boolean
	/** AB prop 14303: issue tctokens to LID instead of PN. */
	lidTrustedTokenIssueToLid: boolean
}

export type SendCoreIdentity = {
	id: string
	lid?: string
}

/**
 * Everything `buildAndRelay` and its helpers need from the transport that carries them.
 *
 * The Baileys socket binds this to its own websocket, signal store and auth state
 * (`makeBaileysSocketAdapter`). A WA Web host binds the same shape to WA Web's live socket and
 * signal store, so one send core serves both.
 *
 * Getters (`me`, `account`) are read on every call: the identity can land after the adapter is built.
 * `serverProps` is held by reference for the same reason. The state fields at the bottom are owned by
 * the adapter so the socket's other handlers (device notifications, retry receipts) share them.
 */
export type SendCoreAdapter = {
	logger: ILogger
	/** `creds.me`; `undefined` before login */
	me(): SendCoreIdentity | undefined
	/** `creds.account`, encoded into the `<device-identity>` node */
	account(): proto.IADVSignedDeviceIdentity | undefined
	signal: SendCoreSignal
	keys: SignalKeyStoreWithTransaction
	sendNode(node: BinaryNode): Promise<void>
	query(node: BinaryNode, timeoutMs?: number): Promise<BinaryNode>
	executeUSyncQuery(query: USyncQuery): Promise<USyncQueryResult | undefined>
	groupMetadata(jid: string): Promise<GroupMetadata>
	cachedGroupMetadata?: SocketConfig['cachedGroupMetadata']
	patchMessageBeforeSending: SocketConfig['patchMessageBeforeSending']
	serverProps: SendCoreServerProps

	/** Same union the socket holds: a user-supplied store or the default in-memory NodeCache. */
	userDevicesCache: PossiblyExtendedCacheStore | NodeCache<JidWithDevice[]>
	/** Serializes writes to userDevicesCache across USync refresh and device-notification handling. */
	devicesMutex: Mutex
	/** Per-LID cooldown for the identity force-refetch on newly-mapped LIDs (D3 / BE#660). */
	lidForceRefetchThrottle: NodeCache<boolean>
	/** Prevents race conditions in Signal session encryption by user. */
	encryptionMutex: KeyedMutex
	/**
	 * Set of tctoken storage JIDs with a fire-and-forget `issuePrivacyTokens` IQ in flight.
	 * Prevents duplicate IQs from rapid back-to-back sends before `senderTimestamp` persists.
	 * Entries are always removed in `.finally()`, so the set is bounded by concurrency.
	 */
	inFlightTcTokenIssuance: Set<string>
	/**
	 * Group fan-outs awaiting a possible `<ack phash>` mismatch. Optional: a host that has its own
	 * resend path (WA Web) leaves it unset and nothing is recorded.
	 */
	groupFanoutRecords?: GroupFanoutRecordStore
	messageRetryManager: MessageRetryManager | null
}
