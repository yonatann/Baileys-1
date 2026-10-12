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
 *   - needs the NCT salt (IndexedDB `WAWebNctSalt`) and the account LID (WA: `chat.accountLid`);
 *     both are checked for null only, as WA does;
 *   - content = HMAC-SHA256(key = salt bytes, msg = UTF-8 of the account LID string).
 * Only used when no valid tctoken is attached (WA: `tctoken ?? cstoken`).
 */
export function genCsTokenNode(opts: {
	enabled: boolean
	salt: Buffer | Uint8Array | undefined
	chatJid: string
	accountLid: string | undefined
}): BinaryNode | undefined {
	const { enabled, salt, chatJid, accountLid } = opts
	if (!enabled || !isRegularUser(chatJid)) return undefined
	if (salt === undefined || salt === null) return undefined
	if (accountLid === undefined || accountLid === null) return undefined
	const content = hmacSign(Buffer.from(accountLid, 'utf8'), Buffer.from(salt), 'sha256')
	return { tag: 'cstoken', attrs: {}, content }
}

/**
 * Stand-in for WA's `chat.accountLid`. The fork has no per-chat accountLid store, so the LID comes
 * from the LID-PN mapping store. An unmapped PN resolves to `undefined` (WA null), never to the PN
 * itself, so a PN is never hashed as if it were an account LID.
 */
export async function resolveAccountLid(
	jid: string,
	getLIDForPN: (pn: string) => Promise<string | null>
): Promise<string | undefined> {
	if (isLidUser(jid)) return jid
	const lid = await getLIDForPN(jid)
	return lid && isLidUser(lid) ? lid : undefined
}

export type NctSaltSyncResult =
	| { kind: 'set'; salt: Buffer }
	| { kind: 'remove' }
	| { kind: 'unsupported' }
	| { kind: 'malformed' }

/**
 * Applies one `nct_salt_sync` syncd mutation, mirroring WAWebNctSaltSync `$NctSaltSync$p_1`
 * (b12@1500868-1501984): REMOVE clears the stored salt; any other operation other than SET is
 * unsupported; SET without a salt is malformed.
 */
export function applyNctSaltSyncAction(
	operation: proto.SyncdMutation.SyncdOperation | null | undefined,
	value: proto.SyncActionValue.INctSaltSyncAction | null | undefined
): NctSaltSyncResult {
	if (operation === proto.SyncdMutation.SyncdOperation.REMOVE) return { kind: 'remove' }
	if (operation !== proto.SyncdMutation.SyncdOperation.SET) return { kind: 'unsupported' }
	const salt = value?.salt
	if (salt === null || salt === undefined) return { kind: 'malformed' }
	return { kind: 'set', salt: Buffer.from(salt) }
}

/**
 * The NCT salt is stored only from the INITIAL_BOOTSTRAP history sync (WA handleInitialSyncMsgs,
 * b07@3212946 `K(d.nctSalt)`): a null salt is a no-op, never a removal.
 */
export function nctSaltFromHistorySync(
	syncType: proto.HistorySync.HistorySyncType | null | undefined,
	nctSalt: Uint8Array | null | undefined
): Buffer | undefined {
	if (syncType !== proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP) return undefined
	if (nctSalt === null || nctSalt === undefined) return undefined
	return Buffer.from(nctSalt)
}
