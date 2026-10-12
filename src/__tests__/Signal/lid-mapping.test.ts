import { jest } from '@jest/globals'
import P from 'pino'
import { LIDMappingStore } from '../../Signal/lid-mapping'
import type { LIDMapping, SignalDataTypeMap, SignalKeyStoreWithTransaction } from '../../Types'

const HOSTED_DEVICE_ID = 99

const mockKeys: jest.Mocked<SignalKeyStoreWithTransaction> = {
	get: jest.fn<SignalKeyStoreWithTransaction['get']>() as any,
	set: jest.fn<SignalKeyStoreWithTransaction['set']>(),
	transaction: jest.fn<SignalKeyStoreWithTransaction['transaction']>(async (work: () => any) => await work()) as any,
	isInTransaction: jest.fn<SignalKeyStoreWithTransaction['isInTransaction']>()
}
const logger = P({ level: 'silent' })

describe('LIDMappingStore', () => {
	const mockPnToLIDFunc = jest.fn<(jids: string[]) => Promise<LIDMapping[] | undefined>>()
	let lidMappingStore: LIDMappingStore

	beforeEach(() => {
		jest.clearAllMocks()
		lidMappingStore = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc)
	})

	describe('getPNForLID', () => {
		it('should correctly map a standard LID with a hosted device ID back to a standard PN with a hosted device', async () => {
			const lidWithHostedDevice = `12345:${HOSTED_DEVICE_ID}@lid`
			const pnUser = '54321'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({ [`12345_reverse`]: pnUser } as SignalDataTypeMap['lid-mapping'])

			const result = await lidMappingStore.getPNForLID(lidWithHostedDevice)
			expect(result).toBe(`${pnUser}:${HOSTED_DEVICE_ID}@s.whatsapp.net`)
		})

		it('should return null if no reverse mapping is found', async () => {
			const lid = 'nonexistent@lid'

			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping']) // Simulate not found in DB

			const result = await lidMappingStore.getPNForLID(lid)
			expect(result).toBeNull()
		})
	})
	describe('negative cache (WA Web parity: a miss is logged, not re-queried — b06@1508452)', () => {
		const PN = '5511999990000@s.whatsapp.net'
		let nowMs = 1_000_000
		let store: LIDMappingStore

		beforeEach(() => {
			nowMs = 1_000_000
			// @ts-ignore
			mockKeys.get.mockResolvedValue({} as SignalDataTypeMap['lid-mapping'])
			store = new LIDMappingStore(mockKeys, logger, mockPnToLIDFunc, {
				negativeTtlMs: 60_000,
				negativeMaxEntries: 3,
				now: () => nowMs
			})
		})

		it('does not re-issue the USync for a pn that just missed', async () => {
			mockPnToLIDFunc.mockResolvedValue([])
			expect(await store.getLIDForPN(PN)).toBeNull()
			expect(await store.getLIDForPN(PN)).toBeNull()
			expect(await store.getLIDForPN(PN)).toBeNull()
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(1)
		})

		it('treats an undefined (failed) USync result as a miss too', async () => {
			mockPnToLIDFunc.mockResolvedValue(undefined)
			await store.getLIDForPN(PN)
			await store.getLIDForPN(PN)
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(1)
		})

		it('retries after the negative TTL elapses', async () => {
			mockPnToLIDFunc.mockResolvedValue([])
			await store.getLIDForPN(PN)
			nowMs += 60_001
			await store.getLIDForPN(PN)
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(2)
		})

		it('does NOT negative-cache a thrown USync error (transient)', async () => {
			mockPnToLIDFunc.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce([])
			await expect(store.getLIDForPN(PN)).rejects.toThrow('boom')
			await store.getLIDForPN(PN)
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(2)
		})

		it('a later learned mapping overrides the negative entry', async () => {
			mockPnToLIDFunc.mockResolvedValue([])
			await store.getLIDForPN(PN)
			await store.storeLIDPNMappings([{ pn: PN, lid: '123456@lid' }])
			expect(await store.getLIDForPN(PN)).toBe('123456@lid')
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(1)
		})

		it('only queries the pns that are not negatively cached in a batch', async () => {
			const PN2 = '5511999991111@s.whatsapp.net'
			mockPnToLIDFunc.mockResolvedValue([])
			await store.getLIDForPN(PN)
			mockPnToLIDFunc.mockClear()
			await store.getLIDsForPNs([PN, PN2])
			expect(mockPnToLIDFunc).toHaveBeenCalledWith([PN2])
		})

		it('is bounded (oldest negative evicted past negativeMaxEntries)', async () => {
			mockPnToLIDFunc.mockResolvedValue([])
			const pns = [0, 1, 2, 3].map(i => `55119999000${i}@s.whatsapp.net`)
			for (const pn of pns) await store.getLIDForPN(pn)
			mockPnToLIDFunc.mockClear()
			await store.getLIDForPN(pns[0]!) // evicted (max 3) -> queried again
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(1)
			mockPnToLIDFunc.mockClear()
			await store.getLIDForPN(pns[3]!) // newest still cached
			expect(mockPnToLIDFunc).toHaveBeenCalledTimes(0)
		})
	})
})
