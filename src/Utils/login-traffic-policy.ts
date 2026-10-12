import { getBinaryNodeChild, type BinaryNode, S_WHATSAPP_NET } from '../WABinary'

/**
 * WA Web parity (B5): login-time prekey traffic.
 *
 * WA Web never polls the server's prekey count (there is no `<iq xmlns="encrypt"><count/></iq>` in the
 * bundle) and never digests the key bundle at login. It uploads at login ONLY when the local flag
 * `serverHasPreKeys` is false (WAWebRegisterPassiveTasks "KeyUpload"), and otherwise reacts to the server's
 * `<notification type="encrypt">` with `<count>` (WAWebHandlePreKeyLow) or `<digest>` (WAWebHandleDigestKey).
 *
 * `firstUnuploadedPreKeyId > 1` is our `serverHasPreKeys`. The extra local-only check (current prekey present in
 * storage) is a free safety net for a wiped/partial key store.
 */
export type LoginPreKeyDecision =
	| { check: false }
	| { check: true; reason: 'never_uploaded' | 'current_prekey_missing' }

export const decideLoginPreKeyCheck = (state: {
	firstUnuploadedPreKeyId: number
	nextPreKeyId: number
	currentPreKeyExists: boolean
}): LoginPreKeyDecision => {
	if (state.firstUnuploadedPreKeyId <= 1) return { check: true, reason: 'never_uploaded' }
	if (state.nextPreKeyId - 1 > 0 && !state.currentPreKeyExists) return { check: true, reason: 'current_prekey_missing' }
	return { check: false }
}

export type ServerEncryptNotificationKind = 'prekey_low' | 'digest' | 'other'

export const classifyServerEncryptNotification = (node: BinaryNode): ServerEncryptNotificationKind => {
	if (node.attrs.from !== S_WHATSAPP_NET) return 'other'
	if (getBinaryNodeChild(node, 'count')) return 'prekey_low'
	if (getBinaryNodeChild(node, 'digest')) return 'digest'
	return 'other'
}
