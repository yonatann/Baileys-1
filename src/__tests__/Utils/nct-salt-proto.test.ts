import { proto } from '../../../WAProto/index.js'

const SALT = Buffer.from([1, 2, 3, 4])

describe('NCT salt proto fields (WA field numbers from b04@1653486 / b06@2773324)', () => {
	it('HistorySync.nctSalt is field 19 bytes', () => {
		const bytes = proto.HistorySync.encode({ syncType: 0, nctSalt: SALT }).finish()
		// tag for field 19, wire type 2 = (19 << 3) | 2 = 154 = 0x9a 0x01 (varint)
		expect(Buffer.from(bytes).includes(Buffer.from([0x9a, 0x01, SALT.length]))).toBe(true)
		expect(Buffer.from(proto.HistorySync.decode(bytes).nctSalt!)).toEqual(SALT)
	})

	it('SyncActionValue.nctSaltSyncAction is field 80 message with salt bytes field 1', () => {
		const bytes = proto.SyncActionValue.encode({ nctSaltSyncAction: { salt: SALT } }).finish()
		// (80 << 3) | 2 = 642 -> varint 0x82 0x05
		expect(bytes[0]).toBe(0x82)
		expect(bytes[1]).toBe(0x05)
		const decoded = proto.SyncActionValue.decode(bytes)
		expect(Buffer.from(decoded.nctSaltSyncAction!.salt!)).toEqual(SALT)
	})
})
