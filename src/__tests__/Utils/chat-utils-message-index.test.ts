import { jest } from '@jest/globals'
import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import type { BaileysEventEmitter, Contact } from '../../Types'
import {
	chatModificationToAppPatch,
	decodeSyncdMutations,
	encodeSyncdPatch,
	newLTHashState,
	processSyncAction
} from '../../Utils/chat-utils'

// WA Web (WAWebSyncdUtils.extractParticipantForSync, local ScriptCache module):
// the participant segment of a per-message index is the sender's JID only for an
// INCOMING message in a non-user chat (isUser = c.us|lid|bot|hosted|hosted.lid);
// otherwise '0'. The sender is emitted via Wid.toString({legacy:true}), which KEEPS the
// device when nonzero. The index is [action, chatJid, msgId, fromMe?'1':'0', participant].
// Only the star path is confirmed by this evidence; the deleteMessageForMe builder is
// UNCONFIRMED (the cache holds only its proto/enum), so its tests assume the same extractor.
const GROUP = '120363000000000000@g.us'
const BROADCAST = '5511888888888@broadcast'
const STATUS = 'status@broadcast'
const NEWSLETTER = '120363000000000001@newsletter'
const SENDER = '5511999999999@s.whatsapp.net'
const SENDER_DEVICE = '5511999999999:12@s.whatsapp.net'
const SENDER_LEGACY_C_US = '5511999999999@c.us'
const SENDER_LID = '123456789012345@lid'
const SENDER_LID_DEVICE = '123456789012345:3@lid'

describe('per-message app-state index participant segment', () => {
	const star = (jid: string, m: { id: string; fromMe?: boolean; participant?: string }) =>
		chatModificationToAppPatch({ star: { messages: [m], star: true } }, jid).index
	const del = (jid: string, key: { id: string; fromMe?: boolean; participant?: string }) =>
		chatModificationToAppPatch({ deleteForMe: { deleteMedia: false, key, timestamp: 1 } }, jid).index

	describe('incoming message in a non-user chat carries the sender JID', () => {
		it('star on an incoming group message', () => {
			expect(star(GROUP, { id: 'M1', fromMe: false, participant: SENDER })).toEqual(['star', GROUP, 'M1', '0', SENDER])
		})
		it('delete-for-me on an incoming group message (lid sender)', () => {
			expect(del(GROUP, { id: 'M2', fromMe: false, participant: SENDER_LID })).toEqual([
				'deleteMessageForMe',
				GROUP,
				'M2',
				'0',
				SENDER_LID
			])
		})
		it('device-suffixed PN sender keeps its device (WA Web toString legacy keeps device)', () => {
			expect(star(GROUP, { id: 'M6', fromMe: false, participant: SENDER_DEVICE })[4]).toBe(SENDER_DEVICE)
			expect(del(GROUP, { id: 'M6', fromMe: false, participant: SENDER_DEVICE })[4]).toBe(SENDER_DEVICE)
		})
		it('device-suffixed LID sender keeps its device', () => {
			expect(star(GROUP, { id: 'M7', fromMe: false, participant: SENDER_LID_DEVICE })[4]).toBe(SENDER_LID_DEVICE)
		})
		it('zero device is omitted (device 0 is the default, as in WA Web _serialized)', () => {
			expect(star(GROUP, { id: 'M13', fromMe: false, participant: '5511999999999:0@s.whatsapp.net' })[4]).toBe(SENDER)
		})
		it('legacy c.us sender maps to s.whatsapp.net (WA Web legacy toString), device kept', () => {
			expect(star(GROUP, { id: 'M14', fromMe: false, participant: SENDER_LEGACY_C_US })[4]).toBe(SENDER)
			expect(star(GROUP, { id: 'M15', fromMe: false, participant: '5511999999999:12@c.us' })[4]).toBe(SENDER_DEVICE)
		})
		it('undecodable participant falls back to 0', () => {
			expect(star(GROUP, { id: 'M16', fromMe: false, participant: 'not-a-jid' })[4]).toBe('0')
		})
		it('@broadcast incoming sender carries the sender JID', () => {
			expect(star(BROADCAST, { id: 'M8', fromMe: false, participant: SENDER })).toEqual([
				'star',
				BROADCAST,
				'M8',
				'0',
				SENDER
			])
		})
		it('status@broadcast incoming sender carries the sender JID', () => {
			expect(del(STATUS, { id: 'M9', fromMe: false, participant: SENDER_DEVICE })[4]).toBe(SENDER_DEVICE)
		})
		it('@newsletter: no participant on the key -> 0', () => {
			expect(star(NEWSLETTER, { id: 'M10', fromMe: false })[4]).toBe('0')
			expect(del(NEWSLETTER, { id: 'M10', fromMe: false })[4]).toBe('0')
		})
		it('@newsletter with a participant still follows the non-user rule (sender JID)', () => {
			expect(star(NEWSLETTER, { id: 'M11', fromMe: false, participant: SENDER })[4]).toBe(SENDER)
		})
	})

	describe('segment stays 0', () => {
		it('own group message keeps 0', () => {
			expect(star(GROUP, { id: 'M3', fromMe: true, participant: SENDER })[4]).toBe('0')
			expect(del(GROUP, { id: 'M3', fromMe: true, participant: SENDER })[4]).toBe('0')
		})
		it('1:1 PN chat keeps 0 even if a participant is present', () => {
			expect(star(SENDER, { id: 'M4', fromMe: false, participant: SENDER })[4]).toBe('0')
		})
		it('1:1 LID chat keeps 0 even if a participant is present', () => {
			expect(del(SENDER_LID, { id: 'M4', fromMe: false, participant: SENDER })[4]).toBe('0')
		})
		it('hosted (user) chat keeps 0 (WA Web isUser covers hosted)', () => {
			expect(star('5511999999999@hosted', { id: 'M12', fromMe: false, participant: SENDER })[4]).toBe('0')
		})
		it('no participant -> 0', () => {
			expect(star(GROUP, { id: 'M5', fromMe: false })[4]).toBe('0')
		})
	})

	describe('round-trip through the app-state patch path', () => {
		const MY_KEY_ID = Buffer.from(randomBytes(16)).toString('base64')
		const APP_STATE_KEY: proto.Message.IAppStateSyncKeyData = {
			keyData: randomBytes(32),
			fingerprint: { rawId: 1, currentIndex: 0, deviceIndexes: [0] },
			timestamp: Date.now()
		}
		const getKey = async (keyId: string) => (keyId === MY_KEY_ID ? APP_STATE_KEY : null)

		/** encode a chatModification -> decode the resulting record -> collect {syncAction, index} */
		const roundTrip = async (mod: Parameters<typeof chatModificationToAppPatch>[0], jid: string) => {
			const { patch } = await encodeSyncdPatch(
				chatModificationToAppPatch(mod, jid),
				MY_KEY_ID,
				newLTHashState(),
				getKey
			)
			const seen: { syncAction: proto.ISyncActionData; index: string[] }[] = []
			await decodeSyncdMutations(patch.mutations!, newLTHashState(), getKey, m => seen.push(m as any), true)
			return seen
		}

		it('star on an incoming group message survives encode -> decode with the sender segment', async () => {
			const [m] = await roundTrip(
				{ star: { messages: [{ id: 'RT1', fromMe: false, participant: SENDER_DEVICE }], star: true } },
				GROUP
			)
			expect(m!.index).toEqual(['star', GROUP, 'RT1', '0', SENDER_DEVICE])
			expect(m!.syncAction.value?.starAction?.starred).toBe(true)
		})

		it('delete-for-me on an incoming @broadcast message survives encode -> decode', async () => {
			const [m] = await roundTrip(
				{
					deleteForMe: {
						deleteMedia: false,
						key: { id: 'RT2', fromMe: false, participant: SENDER_LID_DEVICE },
						timestamp: 5
					}
				},
				BROADCAST
			)
			expect(m!.index).toEqual(['deleteMessageForMe', BROADCAST, 'RT2', '0', SENDER_LID_DEVICE])
		})

		it('processSyncAction reads starred from starAction, not from the index segment', async () => {
			const [m] = await roundTrip(
				{ star: { messages: [{ id: 'RT3', fromMe: false, participant: SENDER }], star: false } },
				GROUP
			)
			const ev = { emit: jest.fn() }
			processSyncAction(m as any, ev as unknown as BaileysEventEmitter, {} as Contact)
			expect(ev.emit).toHaveBeenCalledWith('messages.update', [
				{ key: { remoteJid: GROUP, id: 'RT3', fromMe: false }, update: { starred: false } }
			])
		})
	})
})

describe('inbound star parse (no index fallback)', () => {
	const run = (syncAction: any, index: string[]) => {
		const ev = { emit: jest.fn() }
		processSyncAction({ syncAction, index } as any, ev as unknown as BaileysEventEmitter, {} as Contact)
		return ev.emit.mock.calls
	}

	it('a star mutation without starAction emits nothing (index last segment is not a starred flag)', () => {
		// last segment is a sender JID; old code read `=== '1'` -> false, and never honoured a real star state
		expect(run({ value: {} }, ['star', GROUP, 'X', '1', SENDER])).toEqual([])
		expect(run({ value: {} }, ['star', GROUP, 'X', '0', '1'])).toEqual([])
	})

	it('starAction.starred is authoritative regardless of the index segment', () => {
		expect(run({ value: { starAction: { starred: true } } }, ['star', GROUP, 'X', '0', SENDER])).toEqual([
			['messages.update', [{ key: { remoteJid: GROUP, id: 'X', fromMe: false }, update: { starred: true } }]]
		])
	})
})
