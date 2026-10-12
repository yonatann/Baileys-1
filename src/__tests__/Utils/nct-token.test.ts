import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { BaileysEventEmitter, ChatMutation, Contact } from '../../Types'
import { processSyncAction } from '../../Utils/chat-utils'
import {
	applyNctSaltSyncAction,
	genCsTokenNode,
	isNctTokenSendEnabled,
	nctSaltFromHistorySync,
	resolveAccountLid
} from '../../Utils/nct-token-utils'

const SALT = Buffer.from(Array.from({ length: 32 }, (_, i) => i))
const LID = '123456789@lid'
const SET = proto.SyncdMutation.SyncdOperation.SET
const REMOVE = proto.SyncdMutation.SyncdOperation.REMOVE

describe('isNctTokenSendEnabled (AB prop 24941 / wa_nct_token_send_enabled)', () => {
	it('defaults to false when the prop is absent (WA default !1)', () => {
		expect(isNctTokenSendEnabled({})).toBe(false)
	})
	it('reads the numeric AB id 24941', () => {
		expect(isNctTokenSendEnabled({ '24941': 'true' })).toBe(true)
		expect(isNctTokenSendEnabled({ '24941': '1' })).toBe(true)
		expect(isNctTokenSendEnabled({ '24941': 'false' })).toBe(false)
	})
	it('reads the named prop', () => {
		expect(isNctTokenSendEnabled({ wa_nct_token_send_enabled: 'true' })).toBe(true)
	})
})

describe('genCsTokenNode (WAWebSendMsgCreateFanoutStanza genCsTokenBody, b07@694300-696300)', () => {
	const base = { enabled: true, salt: SALT, chatJid: LID, accountLid: LID }

	it('builds <cstoken> whose content is HMAC-SHA256(salt, accountLid string)', () => {
		const node = genCsTokenNode(base)
		expect(node).toBeDefined()
		expect(node!.tag).toBe('cstoken')
		expect(node!.attrs).toEqual({})
		// independently computed: python hmac.new(bytes(range(32)), b'123456789@lid', sha256)
		expect((node!.content as Buffer).toString('hex')).toBe(
			'0cfd9eab42441c819c347447e3c4ab8703daf0f1399b22aaa7a97c318ddbf835'
		)
	})

	it('is absent when the AB gate is off', () => {
		expect(genCsTokenNode({ ...base, enabled: false })).toBeUndefined()
	})

	it('is absent when no NCT salt is stored (WA null-check only, b06 genCsTokenBody n==null)', () => {
		expect(genCsTokenNode({ ...base, salt: undefined })).toBeUndefined()
	})

	it('an empty stored salt still yields a token, as WA does (decodeB64("") is a valid HMAC key)', () => {
		const node = genCsTokenNode({ ...base, salt: Buffer.alloc(0) })
		// independently computed: python hmac.new(b'', b'123456789@lid', sha256)
		expect((node!.content as Buffer).toString('hex')).toBe(
			'9d9a12e1de8ef27b13b31e4cf75057dcf409d7cc8e6fdd4d92223d8e3046f3c5'
		)
	})

	it('is absent for non-regular-user chats (group, PSA, bot)', () => {
		expect(genCsTokenNode({ ...base, chatJid: '120363000000000000@g.us' })).toBeUndefined()
		expect(genCsTokenNode({ ...base, chatJid: '0@s.whatsapp.net' })).toBeUndefined()
		expect(genCsTokenNode({ ...base, chatJid: '13135550001@s.whatsapp.net' })).toBeUndefined()
	})

	it('is absent when the account LID is unknown (WA: accountLid == null, b07 genCsTokenBody r==null)', () => {
		expect(genCsTokenNode({ ...base, accountLid: undefined })).toBeUndefined()
	})

	it('does not re-gate the account LID on its format (WA checks only null; the caller resolves it)', () => {
		const node = genCsTokenNode({ ...base, accountLid: '972500000000@s.whatsapp.net' })
		expect(node).toBeDefined()
	})
})

describe('resolveAccountLid (stand-in for WA chat.accountLid, which the fork lacks)', () => {
	it('passes a LID destination through without a mapping lookup', async () => {
		const lookup = jest.fn(async () => '999@lid')
		await expect(resolveAccountLid(LID, lookup)).resolves.toBe(LID)
		expect(lookup).not.toHaveBeenCalled()
	})
	it('maps a PN destination through the LID mapping store', async () => {
		await expect(resolveAccountLid('972500000000@s.whatsapp.net', async () => LID)).resolves.toBe(LID)
	})
	it('never returns a non-LID value from the store, even if the store returns a PN', async () => {
		await expect(resolveAccountLid('972500000000@s.whatsapp.net', async () => '972500000000@s.whatsapp.net')).resolves.toBeUndefined()
	})
	it('returns undefined for an unmapped PN, never the PN itself (WA null)', async () => {
		await expect(resolveAccountLid('972500000000@s.whatsapp.net', async () => null)).resolves.toBeUndefined()
	})
})

describe('applyNctSaltSyncAction (WAWebNctSaltSync $NctSaltSync$p_1, b12@1500868-1501984)', () => {
	it('SET stores the salt bytes', () => {
		expect(applyNctSaltSyncAction(SET, { salt: SALT })).toEqual({ kind: 'set', salt: SALT })
	})
	it('REMOVE clears the salt regardless of value', () => {
		expect(applyNctSaltSyncAction(REMOVE, undefined)).toEqual({ kind: 'remove' })
	})
	it('SET without a salt is malformed', () => {
		expect(applyNctSaltSyncAction(SET, {})).toEqual({ kind: 'malformed' })
	})
	it('a non-SET, non-REMOVE operation is unsupported (WA SyncActionState.Unsupported)', () => {
		expect(applyNctSaltSyncAction(undefined, { salt: SALT })).toEqual({ kind: 'unsupported' })
	})
})

describe('nctSaltFromHistorySync (WA stores nctSalt only on INITIAL_BOOTSTRAP, b07@3212946)', () => {
	const INITIAL_BOOTSTRAP = proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP
	const RECENT = proto.HistorySync.HistorySyncType.RECENT

	it('stores the salt from an INITIAL_BOOTSTRAP history sync', () => {
		expect(nctSaltFromHistorySync(INITIAL_BOOTSTRAP, SALT)).toEqual(SALT)
	})
	it('ignores a salt on any other history sync type', () => {
		expect(nctSaltFromHistorySync(RECENT, SALT)).toBeUndefined()
	})
	it('ignores a missing salt on INITIAL_BOOTSTRAP', () => {
		expect(nctSaltFromHistorySync(INITIAL_BOOTSTRAP, null)).toBeUndefined()
		expect(nctSaltFromHistorySync(INITIAL_BOOTSTRAP, undefined)).toBeUndefined()
	})
})

describe('nct_salt_sync syncd mutation (processSyncAction)', () => {
	const makeEv = () => {
		const emit = jest.fn(() => true)
		return { ev: { emit } as unknown as BaileysEventEmitter, emit }
	}
	const me = { id: '1234567890:1@s.whatsapp.net', name: 'Test User' } as Contact
	const mutation = (operation: proto.SyncdMutation.SyncdOperation | undefined, value?: proto.ISyncActionValue) =>
		({
			syncAction: { value: value ?? null },
			index: ['nct_salt_sync'],
			operation
		}) as unknown as ChatMutation

	it('SET emits creds.update with the salt, carrying me unchanged so the pushName handler is a no-op', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(SET, { nctSaltSyncAction: { salt: SALT } }), ev, me)
		expect(emit).toHaveBeenCalledWith('creds.update', { nctSalt: SALT, me })
	})

	it('REMOVE emits creds.update clearing the salt, carrying me unchanged', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(REMOVE), ev, me)
		expect(emit).toHaveBeenCalledWith('creds.update', { nctSalt: undefined, me })
	})

	it('a mutation with no operation is unsupported and emits nothing (no SET default)', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(undefined, { nctSaltSyncAction: { salt: SALT } }), ev, me)
		expect(emit).not.toHaveBeenCalledWith('creds.update', expect.anything())
	})

	it('SET with a null salt is malformed and emits nothing', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(SET, { nctSaltSyncAction: {} }), ev, me)
		expect(emit).not.toHaveBeenCalledWith('creds.update', expect.anything())
	})
})
