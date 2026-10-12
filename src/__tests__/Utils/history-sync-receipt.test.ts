import { jest } from '@jest/globals'
import { deflateSync } from 'zlib'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import { shouldSendHistorySyncReceipt } from '../../Utils/history'
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

	it('shouldSendHistorySyncReceipt excludes INITIAL_STATUS_V3 only', () => {
		expect(shouldSendHistorySyncReceipt(T.INITIAL_STATUS_V3)).toBe(false)
		for (const t of [T.INITIAL_BOOTSTRAP, T.RECENT, T.FULL, T.PUSH_NAME, T.ON_DEMAND, T.NON_BLOCKING_DATA]) {
			expect(shouldSendHistorySyncReceipt(t)).toBe(true)
		}
	})
})
