import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import type { WAPatchCreate } from '../../Types'
import {
	buildStarLegacyRemovePatch,
	chatModificationToAppPatch,
	decodeSyncdPatch,
	encodeSyncdPatch,
	newLTHashState
} from '../../Utils/chat-utils'

const JID = '1234567890@s.whatsapp.net'
const KEY_ID = randomBytes(16).toString('base64')
const KEY: proto.Message.IAppStateSyncKeyData = { keyData: randomBytes(32), timestamp: Date.now() }
const getKey = async (id: string) => (id === KEY_ID ? KEY : null)
const OP = proto.SyncdMutation.SyncdOperation

const starPatch = (star: boolean) =>
	chatModificationToAppPatch({ star: { messages: [{ id: 'ABC', fromMe: false }], star } } as any, JID)

/** What an old Baileys build wrote: the same star mutation in regular_low. */
const legacyLowStar = (): WAPatchCreate => ({ ...starPatch(true), type: 'regular_low' })

describe('legacy regular_low star cleanup (C7a follow-up)', () => {
	// WA Web's sync store is keyed by index alone with no cross-collection arbitration
	// (b07@1055100; 'index-in-wrong-collection' b06@2904468), so a stale regular_low star
	// must be REMOVEd when the star moves to regular_high.
	it('encodeSyncdPatch REMOVE drops the index from indexValueMap and restores the LTHash', async () => {
		const set = await encodeSyncdPatch(legacyLowStar(), KEY_ID, newLTHashState(), getKey)
		expect(Object.keys(set.state.indexValueMap)).toHaveLength(1)
		const rm = await encodeSyncdPatch({ ...legacyLowStar(), operation: OP.REMOVE }, KEY_ID, set.state, getKey)
		expect(Object.keys(rm.state.indexValueMap)).toHaveLength(0)
		expect(rm.state.hash.equals(newLTHashState().hash)).toBe(true)
	})

	it('returns a REMOVE for regular_low when it holds the star index (star and unstar)', async () => {
		const { state } = await encodeSyncdPatch(legacyLowStar(), KEY_ID, newLTHashState(), getKey)
		for (const s of [true, false]) {
			const rm = await buildStarLegacyRemovePatch(starPatch(s), KEY_ID, state, getKey)
			expect(rm).toBeDefined()
			expect(rm!.type).toBe('regular_low')
			expect(rm!.operation).toBe(OP.REMOVE)
			expect(rm!.index).toEqual(starPatch(s).index)
		}
	})

	it('returns undefined when regular_low does not hold it / is empty / patch is not a star', async () => {
		expect(await buildStarLegacyRemovePatch(starPatch(true), KEY_ID, newLTHashState(), getKey)).toBeUndefined()
		const { state } = await encodeSyncdPatch(legacyLowStar(), KEY_ID, newLTHashState(), getKey)
		const other = chatModificationToAppPatch({ star: { messages: [{ id: 'ZZZ', fromMe: true }], star: true } } as any, JID)
		expect(await buildStarLegacyRemovePatch(other, KEY_ID, state, getKey)).toBeUndefined()
		const archive = chatModificationToAppPatch({ archive: true, lastMessages: [] } as any, JID)
		expect(await buildStarLegacyRemovePatch(archive, KEY_ID, state, getKey)).toBeUndefined()
	})

	it('the REMOVE patch validates (patch/snapshot MAC + LTHash) against the stored regular_low state', async () => {
		const { state } = await encodeSyncdPatch(legacyLowStar(), KEY_ID, newLTHashState(), getKey)
		const rmCreate = (await buildStarLegacyRemovePatch(starPatch(false), KEY_ID, state, getKey))!
		const { patch, state: next } = await encodeSyncdPatch(rmCreate, KEY_ID, state, getKey)
		const seen: any[] = []
		const decoded = await decodeSyncdPatch(
			{ ...patch, version: { version: next.version } },
			'regular_low',
			state,
			getKey,
			m => seen.push(m),
			true
		)
		expect(Object.keys(decoded.indexValueMap)).toHaveLength(0)
		expect(decoded.hash.equals(next.hash)).toBe(true)
		expect(seen[0].index[0]).toBe('star')
	})
})
