import { jest } from '@jest/globals'
import { proto } from '../../../WAProto/index.js'
import type { BaileysEventEmitter, ChatMutation } from '../../Types'
import { processSyncAction } from '../../Utils/chat-utils'
import { applyNctSaltSyncAction, genCsTokenNode, isNctTokenSendEnabled } from '../../Utils/nct-token-utils'

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
	const base = { enabled: true, salt: SALT, chatJid: LID, recipientLid: LID }

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

	it('is absent when no NCT salt is stored', () => {
		expect(genCsTokenNode({ ...base, salt: undefined })).toBeUndefined()
		expect(genCsTokenNode({ ...base, salt: Buffer.alloc(0) })).toBeUndefined()
	})

	it('is absent for non-regular-user chats (group, PSA, bot)', () => {
		expect(genCsTokenNode({ ...base, chatJid: '120363000000000000@g.us' })).toBeUndefined()
		expect(genCsTokenNode({ ...base, chatJid: '0@s.whatsapp.net' })).toBeUndefined()
		expect(genCsTokenNode({ ...base, chatJid: '13135550001@s.whatsapp.net' })).toBeUndefined()
	})

	it('is absent when the account LID is unknown or not a LID', () => {
		expect(genCsTokenNode({ ...base, recipientLid: undefined })).toBeUndefined()
		expect(genCsTokenNode({ ...base, recipientLid: '972500000000@s.whatsapp.net' })).toBeUndefined()
	})
})

describe('applyNctSaltSyncAction (WAWebNctSaltSync applyMutations, b12@1500354)', () => {
	it('SET stores the salt bytes', () => {
		expect(applyNctSaltSyncAction(SET, { salt: SALT })).toEqual({ kind: 'set', salt: SALT })
	})
	it('REMOVE clears the salt regardless of value', () => {
		expect(applyNctSaltSyncAction(REMOVE, undefined)).toEqual({ kind: 'remove' })
	})
	it('SET without a salt is malformed', () => {
		expect(applyNctSaltSyncAction(SET, {})).toEqual({ kind: 'malformed' })
	})
})

describe('nct_salt_sync syncd mutation (processSyncAction)', () => {
	const makeEv = () => {
		const emit = jest.fn(() => true)
		return { ev: { emit } as unknown as BaileysEventEmitter, emit }
	}
	const mutation = (operation: proto.SyncdMutation.SyncdOperation, value?: proto.ISyncActionValue): ChatMutation =>
		({
			syncAction: { value: value ?? null },
			index: ['nct_salt_sync'],
			operation
		}) as unknown as ChatMutation

	it('SET emits creds.update with the salt', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(SET, { nctSaltSyncAction: { salt: SALT } }), ev, { id: 'me' } as never)
		expect(emit).toHaveBeenCalledWith('creds.update', { nctSalt: SALT })
	})

	it('REMOVE emits creds.update clearing the salt', () => {
		const { ev, emit } = makeEv()
		processSyncAction(mutation(REMOVE), ev, { id: 'me' } as never)
		expect(emit).toHaveBeenCalledWith('creds.update', { nctSalt: undefined })
	})
})
