import { proto } from '../../WAProto/index.js'
import type { BinaryNode } from '../WABinary'
import { isLidUser } from '../WABinary'
import { hmacSign } from './crypto'
import { isRegularUser } from './tc-token-utils'

/**
 * AB prop 24941 (`wa_nct_token_send_enabled`) gates cstoken emission on 1:1 sends.
 * WA Web default is `false` (WAWebABPropConfig table, b06@1243462 `[24941,"bool",!1,!1]`), so an
 * absent prop must NOT enable cstoken. Read by numeric id, falling back to the named prop.
 */
export const NCT_TOKEN_SEND_AB_PROP = '24941'
export function isNctTokenSendEnabled(props: { [_: string]: string }): boolean {
	const raw = props[NCT_TOKEN_SEND_AB_PROP] ?? props['wa_nct_token_send_enabled']
	return raw === 'true' || raw === '1'
}

/**
 * Builds the `<cstoken>` child for a 1:1 message stanza, mirroring WA Web's `genCsTokenBody`
 * (WAWebSendMsgCreateFanoutStanza, b07@694300-696300):
 *   - gate: AB prop wa_nct_token_send_enabled === true, and the chat is a regular user;
 *   - needs the NCT salt (IndexedDB `WAWebNctSalt`) and the chat's account LID;
 *   - content = HMAC-SHA256(key = salt bytes, msg = UTF-8 of the account LID string).
 * Only used when no valid tctoken is attached (WA: `tctoken ?? cstoken`).
 */
export function genCsTokenNode(opts: {
	enabled: boolean
	salt: Buffer | Uint8Array | undefined
	chatJid: string
	recipientLid: string | undefined
}): BinaryNode | undefined {
	const { enabled, salt, chatJid, recipientLid } = opts
	if (!enabled || !isRegularUser(chatJid)) return undefined
	if (salt === undefined || salt === null) return undefined
	if (!recipientLid || !isLidUser(recipientLid)) return undefined
	const content = hmacSign(Buffer.from(recipientLid, 'utf8'), Buffer.from(salt), 'sha256')
	return { tag: 'cstoken', attrs: {}, content }
}

export type NctSaltSyncResult = { kind: 'set'; salt: Buffer } | { kind: 'remove' } | { kind: 'malformed' }

/**
 * Applies one `nct_salt_sync` syncd mutation, mirroring WAWebNctSaltSync `$NctSaltSync$p_1`
 * (b12@1500868): REMOVE clears the stored salt first; SET without a salt is malformed.
 */
export function applyNctSaltSyncAction(
	operation: proto.SyncdMutation.SyncdOperation,
	value: proto.SyncActionValue.INctSaltSyncAction | null | undefined
): NctSaltSyncResult {
	if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) return { kind: 'remove' }
	const salt = value?.salt
	if (salt === null || salt === undefined) return { kind: 'malformed' }
	return { kind: 'set', salt: Buffer.from(salt) }
}
