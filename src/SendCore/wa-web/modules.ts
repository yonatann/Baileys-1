import type { proto } from '../../../WAProto/index.js'

/**
 * The slice of WA Web (page context) that `makeWaWebAdapter` needs. The extension resolves each entry
 * from the comet module registry (`require('WAWebSignal')` and friends) and passes them in; this
 * package never touches `window` or the registry itself, which keeps the adapter unit-testable here.
 *
 * Each field names the WA Web module it is expected to come from. Entries marked "confirmed" were
 * exercised live by the 2026-10-13 dry-run gate (scratchpad/baileys-ext-spike-results.md); the rest
 * are read from the module dump and get validated the first time the gate runs through this adapter.
 */

/** A WA Web `Wid`. Only the three fields the adapter reads, plus `toString()` as `user[:device]@server`. */
export type WaWid = {
	user: string
	server: string
	device?: number
	toString(): string
}

/** A WA Web `WapNode`, as far as the adapter is concerned: the same tag / attrs / children tree as `BinaryNode`. */
export type WaWapNode = {
	tag: string
	attrs: { [key: string]: string | WaWid }
	content?: WaWapNode[] | Uint8Array | string
}

export type WaWebSignalModule = {
	/** `WAWebSignal.Cipher.encryptSignalProto(deviceWid, paddedBytes)` */
	encryptSignalProto(wid: WaWid, data: Uint8Array): Promise<{ type: 'pkmsg' | 'msg'; ciphertext: Uint8Array }>
	/** `WAWebSignal.Session.hasSignalSessions([wid])` */
	hasSignalSessions(wids: WaWid[]): Promise<boolean[]>
	/** `WAWebSignal.Session.createSignalSession(wid, bundle)`: the prekey bundle parsed from the `encrypt` IQ. */
	createSignalSession(
		wid: WaWid,
		bundle: {
			registrationId: number
			identityKey: Uint8Array
			signedPreKey: { keyId: number; publicKey: Uint8Array; signature: Uint8Array }
			preKey?: { keyId: number; publicKey: Uint8Array }
		}
	): Promise<void>
}

export type WaWebModules = {
	/** `WAWebWid` / `WAWebCommsWapMd.JID`: build a Wid from `user[:device]@server` (confirmed via `JID(...)`). */
	makeWid(serialized: string): WaWid
	/** `WAWap.wap(tag, attrs, children)` (confirmed: `createFanoutMsgStanza` builds its stanza with it). */
	makeWapNode(tag: string, attrs: WaWapNode['attrs'], content?: WaWapNode['content']): WaWapNode
	/** Read a WapNode back as a plain tree (IQ results come back as WapNodes). */
	readWapNode(node: unknown): WaWapNode
	/** `WADeprecatedSendIq.deprecatedSendStanzaAndReturnAck(stanza, ackTemplate)` (confirmed on WA Web's own send path). */
	sendStanzaAndReturnAck(stanza: WaWapNode, ackTemplate: unknown): Promise<unknown>
	/** `WADeprecatedSendIq.deprecatedSendIq(stanza)`: prekey fetch and other request/response IQs. */
	sendIq(stanza: WaWapNode): Promise<unknown>
	/** `WAWebCommsAckParser.toCoreAckTemplate({ id, class: 'message', from })` */
	makeAckTemplate(opts: { id: string; cls: 'message'; from: WaWid }): unknown
	/** `WAWebUserPrefsMeUser.getMaybeMePnUser()` / `getMaybeMeLidUser()` (confirmed). Device Wids. */
	me(): { pn: WaWid; lid?: WaWid } | undefined
	/** The signed device identity WA Web attaches as `<device-identity>` (`WAWebSignalDeviceIdentity`). */
	signedDeviceIdentity(): proto.IADVSignedDeviceIdentity | undefined
	signal: WaWebSignalModule
	/**
	 * `WAWebApiDeviceList.getDeviceIds(wids)` / `bulkGetDeviceRecord` (confirmed via `getFanOutList`): the device
	 * records per user Wid. `id` 0 is the primary; companions carry the `keyIndex` WA Web stores for them;
	 * hosted (business-platform) devices set `isHosted`. The answer's `wid` is the address WA Web itself would
	 * fan out to: when it holds a LID mapping for a PN wid it answers under the LID wid, the way the Baileys
	 * socket gets a `lid` back from usync. The adapter passes that address through unchanged.
	 */
	getDeviceIds(
		wids: WaWid[]
	): Promise<{ wid: WaWid; devices: { id: number; keyIndex?: number; isHosted?: boolean }[] }[]>
	/** `WAWebLidPnCache` / `WAWebApiContact.getAlternateDeviceWid`: the other addressing of a user Wid, or null. */
	lidForPn(pn: WaWid): WaWid | null
	pnForLid(lid: WaWid): WaWid | null
	/** WA Web's trusted-contact token store for a chat Wid (the `<tctoken>` child the gate observed). */
	tcToken: {
		get(wid: WaWid): Promise<{ token: Uint8Array; timestamp?: string; senderTimestamp?: number } | null>
		set(wid: WaWid, entry: { token: Uint8Array; timestamp?: string; senderTimestamp?: number } | null): Promise<void>
	}
	/** WA Web AB props: `privacy_token_on_1to1` (10518) and `lid_trusted_token_issue_to_lid` (14303). */
	abProps(): { privacyTokenOn1to1: boolean; lidTrustedTokenIssueToLid: boolean }
}
