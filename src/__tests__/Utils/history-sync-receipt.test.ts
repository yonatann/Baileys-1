import { jest } from '@jest/globals'
import { deflateSync } from 'zlib'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import { createHistorySyncAcker } from '../../Utils/history'
import processMessage from '../../Utils/process-message'

const ME = '1234@s.whatsapp.net'

const makeHistoryMsg = (syncType: proto.HistorySync.HistorySyncType, payload: Buffer): WAMessage => ({
	key: { remoteJid: ME, fromMe: true, id: 'HIST1' },
	messageTimestamp: 1700000000,
	message: {
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: { syncType, initialHistBootstrapInlinePayload: payload, chunkOrder: 1 }
		}
	}
})

const validPayload = (syncType: proto.HistorySync.HistorySyncType) =>
	deflateSync(Buffer.from(proto.HistorySync.encode({ syncType, conversations: [] }).finish()))

const makeCtx = (shouldProcessHistoryMsg: boolean, order: string[], extra: Record<string, unknown> = {}) => {
	const ev = {
		emit: (name: string) => {
			order.push(name)
			return true
		}
	} as any
	return {
		shouldProcessHistoryMsg,
		ev,
		creds: { me: { id: ME } } as any,
		keyStore: {} as any,
		signalRepository: { lidMapping: { storeLIDPNMappings: async () => {}, getLIDForPN: async () => null } } as any,
		options: {},
		getMessage: async () => undefined,
		...extra
	}
}

describe('hist_sync receipt timing (WA Web b07@572936)', () => {
	const T = proto.HistorySync.HistorySyncType

	it('calls onHistorySyncStored AFTER messaging-history.set when the chunk is stored', async () => {
		const order: string[] = []
		const onHistorySyncStored = jest.fn(async () => {
			order.push('STORED_CB')
		})
		await processMessage(
			makeHistoryMsg(T.RECENT, validPayload(T.RECENT)),
			makeCtx(true, order, { onHistorySyncStored }) as any
		)
		expect(onHistorySyncStored).toHaveBeenCalledTimes(1)
		expect(order.indexOf('STORED_CB')).toBeGreaterThan(order.indexOf('messaging-history.set'))
		expect(order.indexOf('messaging-history.set')).toBeGreaterThanOrEqual(0)
	})

	it('does NOT call it for a skipped chunk', async () => {
		const onHistorySyncStored = jest.fn()
		await processMessage(
			makeHistoryMsg(T.FULL, validPayload(T.FULL)),
			makeCtx(false, [], { onHistorySyncStored }) as any
		)
		expect(onHistorySyncStored).not.toHaveBeenCalled()
	})

	it('does NOT call it when download/decode fails', async () => {
		const onHistorySyncStored = jest.fn()
		await expect(
			processMessage(
				makeHistoryMsg(T.RECENT, Buffer.from('not-zlib')),
				makeCtx(true, [], { onHistorySyncStored }) as any
			)
		).rejects.toBeDefined()
		expect(onHistorySyncStored).not.toHaveBeenCalled()
	})

	it('a throwing callback never breaks history processing', async () => {
		const onHistorySyncStored = jest.fn(async () => {
			throw new Error('send failed')
		})
		await expect(
			processMessage(
				makeHistoryMsg(T.RECENT, validPayload(T.RECENT)),
				makeCtx(true, [], { onHistorySyncStored }) as any
			)
		).resolves.toBeUndefined()
		expect(onHistorySyncStored).toHaveBeenCalledTimes(1)
	})

	// Wiring of the policy end-to-end: acker + processMessage, recording the order of events.
	const run = async (syncType: proto.HistorySync.HistorySyncType, processable: boolean, payload?: Buffer) => {
		const order: string[] = []
		const acker = createHistorySyncAcker({
			isProcessable: () => processable,
			sendHistSyncReceipt: async () => {
				order.push('RECEIPT')
			}
		})
		const msg = makeHistoryMsg(syncType, payload ?? validPayload(syncType))
		await acker.ackOnReceive(msg) // what messages-recv does on receive
		order.push('RECEIVED_DONE')
		let err: unknown
		try {
			await processMessage(msg, makeCtx(processable, order, { onHistorySyncStored: acker.onStored }) as any)
		} catch (e) {
			err = e
		}

		return { order: order.filter(o => o !== 'creds.update'), err }
	}

	it('processed non-V3 chunk: NO receipt on receive, exactly one AFTER messaging-history.set', async () => {
		const { order } = await run(T.RECENT, true)
		expect(order).toEqual(['RECEIVED_DONE', 'messaging-history.set', 'RECEIPT'])
	})

	it('INITIAL_STATUS_V3: acked on receive (before download) and not again after store', async () => {
		const { order } = await run(T.INITIAL_STATUS_V3, true)
		expect(order).toEqual(['RECEIPT', 'RECEIVED_DONE', 'messaging-history.set'])
	})

	it('config-skipped chunk: acked on receive (unchanged legacy behaviour), never after', async () => {
		const { order } = await run(T.FULL, false)
		expect(order).toEqual(['RECEIPT', 'RECEIVED_DONE'])
	})

	it('processed chunk whose decode fails: no receipt at all', async () => {
		const { order, err } = await run(T.RECENT, true, Buffer.from('not-zlib'))
		expect(err).toBeDefined()
		expect(order).toEqual(['RECEIVED_DONE'])
	})

	it('non-history message: acker is a no-op', async () => {
		const send = jest.fn(async () => {})
		const acker = createHistorySyncAcker({ isProcessable: () => true, sendHistSyncReceipt: send })
		await acker.ackOnReceive({ key: { remoteJid: ME, id: 'X' }, message: { conversation: 'hi' } })
		expect(send).not.toHaveBeenCalled()
	})
})
