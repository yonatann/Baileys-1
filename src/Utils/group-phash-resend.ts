import type { proto } from '../../WAProto/index.js'
import { type BinaryNode, type BinaryNodeAttributes, isHostedLidUser, isHostedPnUser } from '../WABinary'
import { generateParticipantHashV2 } from './generics'

/**
 * WA Web parity for the group `<message phash>` input set.
 *
 * `WAWebDBDeviceListFanout.getFanOutList` builds the list a group send fans out to: device id 99
 * and hosted devices never enter it for a group chat (the hosted-include flag is only set for
 * 1:1 chats by `WAWebSendUserMsgJob`), and the current device is excluded (`isMeDevice` matches
 * the current PN/LID device only — own companion devices stay). `WAWebSendGroupSkmsgJob` then
 * hashes exactly that list plus the sender device (`phashV2([...skList, ...skDistribList, me])`),
 * so the hashed set and the fan-out set are the same set.
 *
 * Pure helpers only; the socket wiring lives in `Socket/messages-send.ts`.
 */
export const isPhashFanoutDevice = (
	jid: string,
	device: number | undefined,
	meId: string,
	meLid: string | undefined
): boolean => {
	if (device === 99) return false
	if (isHostedPnUser(jid) || isHostedLidUser(jid)) return false
	if (jid === meId || (!!meLid && jid === meLid)) return false
	return true
}

export const selectPhashFanoutJids = (
	devices: { jid: string; device?: number }[],
	meId: string,
	meLid: string | undefined
): string[] => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const { jid, device } of devices) {
		if (!isPhashFanoutDevice(jid, device, meId, meLid) || seen.has(jid)) continue
		seen.add(jid)
		out.push(jid)
	}

	return out
}

/**
 * WA Web parity for the group `<ack phash>` mismatch path
 * (`WAWebSendGroupSkmsgJob` → `WAWebResendGroupMsg.resendGroupMsg`).
 *
 * The server answers a group message whose phash differs from its own device view with a `phash`
 * on the `<ack>`. WA Web then refreshes the device list of the users the skmsg went to, takes
 * `differenceBy(freshFanOutList, oldList, String)` (new devices only) and sends the message to
 * just those devices as a GROUP_DIRECT stanza: same id, `device_fanout="false"`, per-device `<enc>`
 * nodes, an empty `<enc type="skmsg">` marker, and NO phash, so the resend cannot be answered
 * with another mismatch. Pure helpers only; the send lives in `SendCore/send-core.ts`.
 */

/** `WAWebSendMsgCommonApi.getResendTimeoutInSeconds`: `web_e2e_backfill_expire_time` || 5 min. */
export const PHASH_RESEND_MAX_AGE_MS = 5 * 60 * 1000

/** Bound on the in-memory stand-in for WA Web's persisted `resendGroupMsg` job. */
export const PHASH_RECORD_STORE_MAX = 256

/**
 * Memory guard only, not a WA Web window: WA Web's single timeout is measured from the ACK
 * (`isResendExpired`), so a record must outlive any ack that can still be acted on.
 */
export const PHASH_RECORD_TTL_MS = 60 * 60 * 1000

/** `differenceBy(freshFanOutList, oldList, String)`: new devices only, never removals. */
export const computeResendDelta = (oldJids: readonly string[], freshJids: readonly string[]): string[] => {
	const old = new Set(oldJids)
	const delta = new Set<string>()
	for (const jid of freshJids) {
		if (!old.has(jid)) delta.add(jid)
	}

	return [...delta]
}

export type PhashMismatchVerdict =
	/** server hash == the sent set minus hosted/99: our hash recipe was wrong, the device list was fine */
	| 'recipe'
	/** server hash == the refreshed set: the device list we sent with was stale */
	| 'stale-list'
	/** server hash == exactly what we sent: nothing to resend (forensics only) */
	| 'sent-matches'
	/** no local candidate reproduces the server hash */
	| 'unknown'

export const classifyPhashMismatch = ({
	serverPhash,
	oldAsSent,
	oldFiltered,
	freshFiltered,
	sender
}: {
	serverPhash: string
	oldAsSent: readonly string[]
	oldFiltered: readonly string[]
	freshFiltered: readonly string[]
	sender: string
}): { verdict: PhashMismatchVerdict; hashes: { sent: string; oldFiltered: string; fresh: string } } => {
	const hashes = {
		sent: generateParticipantHashV2([...oldAsSent, sender]),
		oldFiltered: generateParticipantHashV2([...oldFiltered, sender]),
		fresh: generateParticipantHashV2([...freshFiltered, sender])
	}
	let verdict: PhashMismatchVerdict = 'unknown'
	if (serverPhash === hashes.sent) verdict = 'sent-matches'
	else if (serverPhash === hashes.oldFiltered) verdict = 'recipe'
	else if (serverPhash === hashes.fresh) verdict = 'stale-list'

	return { verdict, hashes }
}

export type GroupFanoutRecord = {
	group: string
	/** the phash sent on the original `<message>`: WA Web resends only when the ack's differs */
	sentPhash: string
	/** every device jid the phash was computed over, as returned by the device query (sender excluded) */
	oldAsSent: string[]
	/** the same list minus hosted / device 99 / the sender device: WA Web's fan-out list */
	oldFiltered: string[]
	addressingMode: string
	/** other attrs of the original `<message>` (`edit`, `expiration`, `addressing_mode`, ...), minus id/to/type/phash */
	stanzaAttrs: BinaryNodeAttributes
	/** the group payload after `patchMessageBeforeSending`, encrypted per new device on a resend */
	message: proto.IMessage
	/** `mediatype` / `decrypt-fail` attrs the original `<enc>` nodes carried */
	extraAttrs: BinaryNodeAttributes
	/** reporting token + caller-supplied nodes (`<meta>`) that trailed the original stanza */
	trailingNodes: BinaryNode[]
	sentAt: number
}

/**
 * msgId → fan-out record written at group send time and consumed exactly once by the mismatch
 * handler. Bounded and TTL'd: a mismatch for a message older than the WA Web resend window finds
 * nothing and is a no-op.
 */
export class GroupFanoutRecordStore {
	private readonly records = new Map<string, GroupFanoutRecord>()

	constructor(
		private readonly max: number = PHASH_RECORD_STORE_MAX,
		private readonly ttlMs: number = PHASH_RECORD_TTL_MS,
		private readonly now: () => number = Date.now
	) {}

	set(msgId: string, record: GroupFanoutRecord): void {
		this.records.delete(msgId)
		this.records.set(msgId, record)
		while (this.records.size > this.max) {
			const oldest = this.records.keys().next()
			if (oldest.done) break
			this.records.delete(oldest.value)
		}
	}

	/** Read without consuming (tests / diagnostics). */
	peek(msgId: string): GroupFanoutRecord | undefined {
		return this.records.get(msgId)
	}

	/** Returns and deletes synchronously: the once-per-message guard. */
	take(msgId: string): GroupFanoutRecord | undefined {
		const record = this.records.get(msgId)
		if (!record) return undefined
		this.records.delete(msgId)
		return this.now() - record.sentAt > this.ttlMs ? undefined : record
	}

	clear(): void {
		this.records.clear()
	}
}

/** `unixTime() - ackTime > getResendTimeoutInSeconds()`, in ms. */
export const isResendExpired = (ackTimeMs: number, nowMs: number, maxAgeMs = PHASH_RESEND_MAX_AGE_MS): boolean =>
	nowMs - ackTimeMs > maxAgeMs
