import { jest } from '@jest/globals'
import { readFileSync } from 'fs'
import { join } from 'path'
import { deflateSync } from 'zlib'
import { proto } from '../../../WAProto/index.js'
import type { WAMessage } from '../../Types'
import { makeEventBuffer } from '../../Utils/event-buffer'
import { createHistorySyncAcker, markHttpNetworkError } from '../../Utils/history'
import { aesDecryptGCM, hkdf } from '../../Utils/crypto'
import { buildHistSyncServerErrorReceiptNode } from '../../Utils/messages-media'
import processMessage from '../../Utils/process-message'

const ME = '1234@s.whatsapp.net'
const T = proto.HistorySync.HistorySyncType
const ALL = Object.values(T).filter((v): v is number => typeof v === 'number')

const makeHistoryMsg = (syncType: proto.HistorySync.HistorySyncType, payload: Buffer, fromMe = true): WAMessage => ({
	key: { remoteJid: ME, fromMe, id: 'HIST1' },
	messageTimestamp: 1700000000,
	message: {
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: { syncType, initialHistBootstrapInlinePayload: payload, chunkOrder: 1 }
		}
	}
})

// no inline payload -> the chunk must be downloaded; with no url/directPath the download stage fails (non-network)
const makeDownloadMsg = (syncType: proto.HistorySync.HistorySyncType): WAMessage => ({
	key: { remoteJid: ME, fromMe: true, id: 'DL1' },
	messageTimestamp: 1700000000,
	message: {
		protocolMessage: {
			type: proto.Message.ProtocolMessage.Type.HISTORY_SYNC_NOTIFICATION,
			historySyncNotification: {
				syncType,
				chunkOrder: 1,
				mediaKey: Buffer.alloc(32, 7),
				fileLength: 10,
				fileSha256: Buffer.alloc(32),
				fileEncSha256: Buffer.alloc(32)
			}
		}
	}
})

const validPayload = (syncType: proto.HistorySync.HistorySyncType) =>
	deflateSync(Buffer.from(proto.HistorySync.encode({ syncType, conversations: [] }).finish()))

const silentLogger = {
	level: 'silent',
	child: () => silentLogger,
	trace: () => {},
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	fatal: () => {}
} as any

/** ctx for processMessage. `ev` is either a recording stub or a real buffer. */
const makeCtx = (shouldProcessHistoryMsg: boolean, ev: any, extra: Record<string, unknown> = {}) => ({
	shouldProcessHistoryMsg,
	ev,
	creds: { me: { id: ME } } as any,
	keyStore: {} as any,
	signalRepository: { lidMapping: { storeLIDPNMappings: async () => {}, getLIDForPN: async () => null } } as any,
	options: {},
	getMessage: async () => undefined,
	logger: silentLogger,
	...extra
})

const recordingEv = (order: string[]) =>
	({
		emit: (name: string) => {
			order.push(name)
			return true
		}
	}) as any

const makeAcker = (opts: { processable?: boolean; send?: (...a: any[]) => Promise<void>; serverErr?: any } = {}) =>
	createHistorySyncAcker({
		shouldSyncHistoryMessage: () => opts.processable ?? true,
		processableTypes: ALL,
		sendHistSyncReceipt: opts.send ?? (async () => {}),
		sendServerErrorReceipt: opts.serverErr ?? (async () => {})
	})

describe('hist_sync receipt policy (WA Web b07)', () => {
	describe('receive-time acks (INITIAL_STATUS_V3 + unprocessed chunks)', () => {
		it('V3 from self is acked on receive (WA Web b07@554640, before download)', async () => {
			const send = jest.fn(async () => {})
			await makeAcker({ send }).ackOnReceive(makeHistoryMsg(T.INITIAL_STATUS_V3, validPayload(T.INITIAL_STATUS_V3)))
			expect(send).toHaveBeenCalledTimes(1)
		})

		it('a processed non-V3 chunk is NOT acked on receive', async () => {
			const send = jest.fn(async () => {})
			await makeAcker({ send }).ackOnReceive(makeHistoryMsg(T.RECENT, validPayload(T.RECENT)))
			expect(send).not.toHaveBeenCalled()
		})

		it('a config-skipped chunk is acked on receive (nothing is stored, so there is nothing to wait for)', async () => {
			const send = jest.fn(async () => {})
			await makeAcker({ processable: false, send }).ackOnReceive(makeHistoryMsg(T.FULL, validPayload(T.FULL)))
			expect(send).toHaveBeenCalledTimes(1)
		})

		it('a type outside processableTypes is acked on receive', async () => {
			const send = jest.fn(async () => {})
			const acker = createHistorySyncAcker({
				shouldSyncHistoryMessage: () => true,
				processableTypes: [T.RECENT],
				sendHistSyncReceipt: send,
				sendServerErrorReceipt: async () => {}
			})
			await acker.ackOnReceive(makeHistoryMsg(T.FULL, validPayload(T.FULL)))
			expect(send).toHaveBeenCalledTimes(1)
			await acker.ackOnReceive(makeHistoryMsg(T.RECENT, validPayload(T.RECENT)))
			expect(send).toHaveBeenCalledTimes(1)
		})

		it('SPOOF: a fromMe=false history notification gets NO receipt (WA Web b06@712861 isMeAccount guard)', async () => {
			const send = jest.fn(async () => {})
			await makeAcker({ send }).ackOnReceive(makeHistoryMsg(T.INITIAL_STATUS_V3, validPayload(T.INITIAL_STATUS_V3), false))
			expect(send).not.toHaveBeenCalled()
		})

		it('a non-history message is a no-op', async () => {
			const send = jest.fn(async () => {})
			await makeAcker({ send }).ackOnReceive({ key: { remoteJid: ME, id: 'X', fromMe: true }, message: { conversation: 'hi' } })
			expect(send).not.toHaveBeenCalled()
		})
	})

	describe('post-store ack (WA Web b07@572936: after the store try-block, every type except V3)', () => {
		it('chunkAck sends exactly one hist_sync receipt, only when invoked, and is idempotent', async () => {
			const send = jest.fn(async () => {})
			const ack = makeAcker({ send }).chunkAck(
				{ syncType: T.RECENT } as any,
				makeHistoryMsg(T.RECENT, validPayload(T.RECENT))
			)
			expect(send).not.toHaveBeenCalled()
			await ack()
			await ack()
			expect(send).toHaveBeenCalledTimes(1)
		})

		it.each([T.INITIAL_BOOTSTRAP, T.RECENT, T.FULL, T.ON_DEMAND, T.PUSH_NAME, T.NON_BLOCKING_DATA])(
			'syncType %s: post-store ack (WA Web acks every non-V3 type after its store)',
			async syncType => {
				const send = jest.fn(async () => {})
				const msg = makeHistoryMsg(syncType, validPayload(syncType))
				const ack = makeAcker({ send }).chunkAck({ syncType } as any, msg)
				expect(send).not.toHaveBeenCalled()
				await ack()
				expect(send).toHaveBeenCalledTimes(1)
			}
		)

		it('INITIAL_STATUS_V3 chunkAck never sends again (already acked on receive)', async () => {
			const send = jest.fn(async () => {})
			const msg = makeHistoryMsg(T.INITIAL_STATUS_V3, validPayload(T.INITIAL_STATUS_V3))
			await makeAcker({ send }).chunkAck({ syncType: T.INITIAL_STATUS_V3 } as any, msg)()
			expect(send).not.toHaveBeenCalled()
		})
	})

	describe('download failure -> SendHistSyncServerErrorReceipt (WA Web b07@558374-558589)', () => {
		it('a non-network download failure sends the server-error receipt with the chunk id + mediaKey', async () => {
			const serverErr = jest.fn(async () => {})
			const acker = makeAcker({ serverErr })
			const err = new Error('decrypt failed')
			await acker.onDownloadFailed({ syncType: T.RECENT, mediaKey: Buffer.alloc(32, 7) } as any, makeDownloadMsg(T.RECENT), err)
			expect(serverErr).toHaveBeenCalledTimes(1)
			expect(serverErr).toHaveBeenCalledWith(ME, 'DL1', Buffer.alloc(32, 7))
		})

		it('a network failure (HttpNetworkError) sends NO error receipt (WA Web returns early, b07@557378)', async () => {
			const serverErr = jest.fn(async () => {})
			const err = markHttpNetworkError(new Error('Failed to fetch stream'))
			await makeAcker({ serverErr }).onDownloadFailed({ syncType: T.RECENT, mediaKey: Buffer.alloc(32, 7) } as any, makeDownloadMsg(T.RECENT), err)
			expect(serverErr).not.toHaveBeenCalled()
		})

		it('no mediaKey -> no error receipt (WA Web only has a key while the chunk is still encrypted)', async () => {
			const serverErr = jest.fn(async () => {})
			await makeAcker({ serverErr }).onDownloadFailed({ syncType: T.RECENT } as any, makeDownloadMsg(T.RECENT), new Error('x'))
			expect(serverErr).not.toHaveBeenCalled()
		})
	})

	describe('server-error receipt stanza (WAWebSendHistSyncServerErrorReceiptJob, b07@548700 / b08)', () => {
		it('stanza shape: receipt{type=server-error,to=remote user,id,category=peer} > encrypt > enc_p + enc_iv', () => {
			const mediaKey = Buffer.alloc(32, 9)
			const node = buildHistSyncServerErrorReceiptNode({ remote: '111@s.whatsapp.net', id: 'ABC', mediaKey })
			expect(node.tag).toBe('receipt')
			expect(node.attrs).toEqual({ type: 'server-error', to: '111@s.whatsapp.net', id: 'ABC', category: 'peer' })
			const [encrypt] = node.content as any[]
			expect(encrypt.tag).toBe('encrypt')
			const enc_p = encrypt.content.find((c: any) => c.tag === 'enc_p')
			const enc_iv = encrypt.content.find((c: any) => c.tag === 'enc_iv')
			expect(enc_iv.content).toHaveLength(12)
			expect(Buffer.isBuffer(enc_p.content)).toBe(true)
		})

		it('payload round-trips: AES-GCM(HKDF(mediaKey,"WhatsApp Media Retry Notification"), AAD=id) decodes to stanzaId=id', () => {
			const mediaKey = Buffer.alloc(32, 9)
			const node = buildHistSyncServerErrorReceiptNode({ remote: '111@s.whatsapp.net', id: 'ABC', mediaKey })
			const [encrypt] = node.content as any[]
			const enc_p = encrypt.content.find((c: any) => c.tag === 'enc_p').content as Buffer
			const enc_iv = encrypt.content.find((c: any) => c.tag === 'enc_iv').content as Buffer
			const key = hkdf(mediaKey, 32, { info: 'WhatsApp Media Retry Notification' })
			const plain = aesDecryptGCM(enc_p, key, enc_iv, Buffer.from('ABC'))
			expect(proto.ServerErrorReceipt.decode(plain).stanzaId).toBe('ABC')
		})
	})

	describe('download vs post-download failures (WA Web b07@559300 decode -> outer catch, no receipt)', () => {
		it('an inline payload that cannot be inflated throws and sends NO error receipt', async () => {
			const onDownloadFailed = jest.fn(async (..._args: unknown[]) => {})
			const order: string[] = []
			await expect(
				processMessage(
					makeHistoryMsg(T.RECENT, Buffer.from('not-zlib')),
					makeCtx(true, recordingEv(order), { historySyncAcker: { onDownloadFailed, chunkAck: () => async () => {} } }) as any
				)
			).rejects.toBeDefined()
			expect(onDownloadFailed).not.toHaveBeenCalled()
		})

		it('a failing DOWNLOAD reaches onDownloadFailed with the error and still rethrows', async () => {
			const onDownloadFailed = jest.fn(async (..._args: unknown[]) => {})
			const order: string[] = []
			await expect(
				processMessage(
					makeDownloadMsg(T.RECENT),
					makeCtx(true, recordingEv(order), { historySyncAcker: { onDownloadFailed, chunkAck: () => async () => {} } }) as any
				)
			).rejects.toBeDefined()
			expect(onDownloadFailed).toHaveBeenCalledTimes(1)
			expect(onDownloadFailed.mock.calls[0]![0]).toMatchObject({ syncType: T.RECENT })
		})
	})

	describe('end-to-end ordering with the real event buffer', () => {
		it('fallback (no opt-in): the receipt is released after the chunk is flushed to listeners, never before', async () => {
			const ev = makeEventBuffer(silentLogger)
			const order: string[] = []
			ev.on('messaging-history.set', () => {
				order.push('STORE')
			})
			const send = jest.fn(async () => {
				order.push('RECEIPT')
			})
			const acker = makeAcker({ send })
			ev.buffer()
			await processMessage(
				makeHistoryMsg(T.RECENT, validPayload(T.RECENT)),
				makeCtx(true, ev, { historySyncAcker: acker }) as any
			)
			expect(send).not.toHaveBeenCalled()
			ev.flush()
			expect(order).toEqual(['STORE', 'RECEIPT'])
		})

		it('opt-in: the receipt waits for the consumer to call the ack after its own store', async () => {
			const ev = makeEventBuffer(silentLogger, { awaitHistorySyncStore: true })
			let consumerAck: (() => Promise<void>) | undefined
			const order: string[] = []
			ev.on('messaging-history.set', (data: any) => {
				consumerAck = data.historySyncAck
			})
			const send = jest.fn(async () => {
				order.push('RECEIPT')
			})
			ev.buffer()
			await processMessage(
				makeHistoryMsg(T.RECENT, validPayload(T.RECENT)),
				makeCtx(true, ev, { historySyncAcker: makeAcker({ send }) }) as any
			)
			ev.flush()
			expect(send).not.toHaveBeenCalled()
			expect(consumerAck).toBeDefined()
			await consumerAck!()
			expect(order).toEqual(['RECEIPT'])
		})

		it('SPOOF at the process-message guard: nothing is stored and no receipt or hook runs', async () => {
			const order: string[] = []
			const chunkAck = jest.fn(() => async () => {})
			const onDownloadFailed = jest.fn(async (..._args: unknown[]) => {})
			await processMessage(
				makeHistoryMsg(T.RECENT, validPayload(T.RECENT), false),
				makeCtx(true, recordingEv(order), { historySyncAcker: { chunkAck, onDownloadFailed } }) as any
			)
			expect(order).not.toContain('messaging-history.set')
			expect(chunkAck).not.toHaveBeenCalled()
			expect(onDownloadFailed).not.toHaveBeenCalled()
		})
	})

	describe('wiring', () => {
		const src = () => readFileSync(join(process.cwd(), 'src/Socket/messages-recv.ts'), 'utf8')

		it('messages-recv: receive-time ack is gated by the acker and the upsert carries the acker', () => {
			expect(src()).toContain('await historyAcker.ackOnReceive(msg)')
			expect(src()).toContain('historySyncAcker: historyAcker')
			expect(src()).toContain('shouldSyncHistoryMessage: config.shouldSyncHistoryMessage')
			expect(src()).toContain('processableTypes: PROCESSABLE_HISTORY_TYPES')
		})

		it('socket: the event buffer is told about the consumer opt-in', () => {
			const s = readFileSync(join(process.cwd(), 'src/Socket/socket.ts'), 'utf8')
			expect(s).toContain('makeEventBuffer(logger, { awaitHistorySyncStore: config.awaitHistorySyncStore })')
		})
	})
})
