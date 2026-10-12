import { jest } from '@jest/globals'
import P from 'pino'
import { classifyLidPnConflict, isClientAssignedLidUser } from '../../Signal/lid-conflict'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalKeyStoreWithTransaction } from '../../Types'

// WA Web parity (PR3, LOG ONLY): createLidPnMappings conflict classification.
// Evidence: WAWebDBCreateLidPnMappings, b06.js ~@382408 (function R) and WAWebWidDevTools.isWidClientAssigned
// (b06.js ~@379990): isWidClientAssigned(lid) = lid is a LID && (parseInt(user) & 65536) !== 0.

describe('isClientAssignedLidUser (WA isWidClientAssigned: bit 16 of the LID user)', () => {
	it('is true when bit 16 (65536) is set', () => {
		expect(isClientAssignedLidUser('65536')).toBe(true)
		expect(isClientAssignedLidUser('196608')).toBe(true) // 2^17 + 2^16
	})

	it('is false when bit 16 is clear', () => {
		expect(isClientAssignedLidUser('65535')).toBe(false)
		expect(isClientAssignedLidUser('131072')).toBe(false) // 2^17 only
		expect(isClientAssignedLidUser('0')).toBe(false)
	})

	it('is false for a non-numeric or absent user (WA: NaN -> false, null -> false)', () => {
		expect(isClientAssignedLidUser('abc')).toBe(false)
		expect(isClientAssignedLidUser(undefined)).toBe(false)
	})
})

describe('classifyLidPnConflict (WA createLidPnMappings R())', () => {
	const base = { lidUser: '111', pnUser: '222', pnUserIsCachedLid: false }

	it('no conflict when the LID has no cached PN', () => {
		expect(classifyLidPnConflict({ ...base, learningSource: 'usync', cachedPnUserForLid: undefined })).toBeUndefined()
	})

	it('no conflict when the cached PN equals the new PN', () => {
		expect(classifyLidPnConflict({ ...base, learningSource: 'usync', cachedPnUserForLid: '222' })).toBeUndefined()
	})

	it('a real LID whose cached PN differs is logged as lid-pn-mapping-conflict-<src> (logs only)', () => {
		expect(classifyLidPnConflict({ ...base, learningSource: 'usync', cachedPnUserForLid: '333' })).toEqual({
			kind: 'lid',
			logKey: 'lid-pn-mapping-conflict-usync'
		})
	})

	it('new PN that is actually a cached LID is pn-is-lid (checked before fake-LID)', () => {
		expect(
			classifyLidPnConflict({
				lidUser: '65536',
				pnUser: '222',
				pnUserIsCachedLid: true,
				learningSource: 'history-sync-chunk',
				cachedPnUserForLid: '333'
			})
		).toEqual({ kind: 'pn-is-lid', logKey: 'lid-pn-mapping-conflict-pn-is-lid' })
	})

	it('a client-assigned (fake) LID with a differing cached PN is fake-lid-<src>', () => {
		expect(
			classifyLidPnConflict({
				lidUser: '65536',
				pnUser: '222',
				pnUserIsCachedLid: false,
				learningSource: 'usync',
				cachedPnUserForLid: '333'
			})
		).toEqual({ kind: 'fake-lid', logKey: 'lid-pn-mapping-conflict-fake-lid-usync' })
	})

	it('an untagged mapping (no WA learning source known) is logged under the untagged label', () => {
		expect(classifyLidPnConflict({ ...base, learningSource: undefined, cachedPnUserForLid: '333' })).toEqual({
			kind: 'lid',
			logKey: 'lid-pn-mapping-conflict-untagged'
		})
	})
})

describe('LIDMappingStore conflict logging (log only, writes unchanged)', () => {
	const makeKeys = () => {
		const keys = {
			get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
			set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
			transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
			isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
		}
		return keys as any
	}
	const LID = '111@lid'
	const PN = '222@s.whatsapp.net'

	it('logs a conflict with the learning source and still writes the same batch as before', async () => {
		const keys = makeKeys()
		// 1st get: PN cache-miss read (empty). 2nd get: conflict read, LID 111 cached to PN 333.
		keys.get
			.mockResolvedValueOnce({} as any)
			.mockResolvedValueOnce({ '111_reverse': '333' } as any)
		const logger = P({ level: 'silent' })
		const warn = jest.spyOn(logger, 'warn')
		const store = new LIDMappingStore(keys, logger)

		await store.storeLIDPNMappings([{ lid: LID, pn: PN, learningSource: 'usync' } as LIDMapping])

		expect(warn).toHaveBeenCalledWith(
			expect.objectContaining({ learningSource: 'usync' }),
			'lid-pn-mapping-conflict-usync'
		)
		expect(keys.set).toHaveBeenCalledWith({ 'lid-mapping': { '222': '111', '111_reverse': '222' } })
	})

	it('a failing conflict read never blocks the write (log-only)', async () => {
		const keys = makeKeys()
		keys.get
			.mockResolvedValueOnce({} as any)
			.mockRejectedValueOnce(new Error('db down'))
		const store = new LIDMappingStore(keys, P({ level: 'silent' }))

		await expect(store.storeLIDPNMappings([{ lid: LID, pn: PN, learningSource: 'usync' } as LIDMapping])).resolves.toBeUndefined()
		expect(keys.set).toHaveBeenCalledTimes(1)
	})

	it('does not log when there is no conflict', async () => {
		const keys = makeKeys()
		keys.get.mockResolvedValue({} as any)
		const logger = P({ level: 'silent' })
		const warn = jest.spyOn(logger, 'warn')
		await new LIDMappingStore(keys, logger).storeLIDPNMappings([{ lid: LID, pn: PN, learningSource: 'usync' } as LIDMapping])
		expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringMatching(/^lid-pn-mapping-conflict/))
	})
})
