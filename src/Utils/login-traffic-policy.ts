import { type BinaryNode, getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

/**
 * WA Web parity (B5): login-time prekey traffic.
 *
 * WA Web never polls the server's prekey count (there is no `<iq xmlns="encrypt"><count/></iq>` in the
 * bundle) and never digests the key bundle at login. It uploads at login ONLY when the local flag
 * `serverHasPreKeys` is false (WAWebRegisterPassiveTasks "KeyUpload"), and otherwise reacts to the server's
 * `<notification type="encrypt">` with `<count>` (WAWebHandlePreKeyLow) or `<digest>` (WAWebHandleDigestKey).
 *
 * `creds.serverHasPreKeys` is our persisted `serverHasPreKeys`. The extra local-only check (current prekey present in
 * storage) is a free safety net for a wiped/partial key store.
 */
export type LoginPreKeyDecision =
	| { check: false }
	| { check: true; reason: 'server_has_no_prekeys' | 'legacy_unknown' | 'current_prekey_missing' }

/**
 * `serverHasPreKeys` mirrors WA Web's persisted flag (setServerHasPreKeys): set false BEFORE every upload and on
 * every PreKeyLow notification (b12@1723946), set true only after the upload IQ succeeds (b06@2278756, `b.success`).
 * A failed/timed-out/SIGKILLed upload therefore leaves it false and the next login re-uploads.
 * `undefined` = session paired before this flag existed: check once (count IQ) and set it true if the server has keys.
 */
export const decideLoginPreKeyCheck = (state: {
	serverHasPreKeys: boolean | undefined
	nextPreKeyId: number
	currentPreKeyExists: boolean
}): LoginPreKeyDecision => {
	if (state.serverHasPreKeys === false) return { check: true, reason: 'server_has_no_prekeys' }
	if (state.serverHasPreKeys === undefined) return { check: true, reason: 'legacy_unknown' }
	if (state.nextPreKeyId - 1 > 0 && !state.currentPreKeyExists) return { check: true, reason: 'current_prekey_missing' }
	return { check: false }
}

/** Flag bracket around an upload: false before, true only if `doUpload` resolves. */
export const uploadWithServerFlag = async (
	setFlag: (serverHasPreKeys: boolean) => void,
	doUpload: () => Promise<void>
): Promise<void> => {
	setFlag(false)
	await doUpload()
	setFlag(true)
}

/** WA Web WAWebDigestKeyJob (b06@2282389): a 404 ("no record for current user") means re-upload. */
export const runKeyDigest = async (deps: {
	queryDigest: () => Promise<BinaryNode>
	upload: () => Promise<void>
}): Promise<void> => {
	let res: BinaryNode
	try {
		res = await deps.queryDigest()
	} catch (e) {
		// query() -> assertNodeErrorFree throws `new Boom(text, { data: +code })`, so the IQ
		// error code lands in `data` as a bare number (statusCode stays 500).
		const err = e as { output?: { statusCode?: number }; data?: unknown }
		if (Number(err?.data) === 404 || err?.output?.statusCode === 404) {
			await deps.upload()
			return
		}

		throw e
	}

	if (!getBinaryNodeChild(res, 'digest')) {
		await deps.upload()
		throw new Error('encrypt/get digest returned no digest node')
	}
}

/** WA Web WAWebHandlePreKeyLow (b12@1723946): any <count> notification re-uploads the full batch, no threshold. */
export const runPreKeyLow = async (deps: {
	stanzaId: string | undefined
	inFlight: Set<string>
	upload: (count: number) => Promise<void>
	count: number
}): Promise<void> => {
	if (deps.stanzaId && deps.inFlight.has(deps.stanzaId)) return
	if (deps.stanzaId) deps.inFlight.add(deps.stanzaId)
	try {
		await deps.upload(deps.count)
	} finally {
		if (deps.stanzaId) deps.inFlight.delete(deps.stanzaId)
	}
}

export type ServerEncryptNotificationKind = 'prekey_low' | 'digest' | 'other'

export const classifyServerEncryptNotification = (node: BinaryNode): ServerEncryptNotificationKind => {
	if (node.attrs.from !== S_WHATSAPP_NET) return 'other'
	if (getBinaryNodeChild(node, 'count')) return 'prekey_low'
	if (getBinaryNodeChild(node, 'digest')) return 'digest'
	return 'other'
}
