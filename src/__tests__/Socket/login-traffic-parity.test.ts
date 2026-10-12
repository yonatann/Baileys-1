import { Boom } from '@hapi/boom'
import { describe, expect, it, jest } from '@jest/globals'
import {
	classifyServerEncryptNotification,
	decideLoginPreKeyCheck,
	runKeyDigest,
	runPreKeyLow,
	uploadWithServerFlag
} from '../../Utils/login-traffic-policy'
import { type BinaryNode, S_WHATSAPP_NET } from '../../WABinary'

// WA Web parity (B5): no unconditional prekey-count / digest IQ at login.
// Evidence: WAWebRegisterPassiveTasks "KeyUpload" runs only when !getServerHasPreKeys (b06@2282389+);
// WAWebHandlePreKeyLow (b12@1723946) / WAWebHandleDigestKey (b12@1583869) are notification-driven.
describe('decideLoginPreKeyCheck', () => {
	it('skips the network check when the server is known to hold our prekeys and the current prekey exists', () => {
		expect(decideLoginPreKeyCheck({ serverHasPreKeys: true, nextPreKeyId: 813, currentPreKeyExists: true })).toEqual({
			check: false
		})
	})
	it('checks when the flag is false (fresh pairing OR a failed/interrupted upload)', () => {
		expect(decideLoginPreKeyCheck({ serverHasPreKeys: false, nextPreKeyId: 813, currentPreKeyExists: true })).toEqual({
			check: true,
			reason: 'server_has_no_prekeys'
		})
	})
	it('checks once for legacy sessions (flag undefined)', () => {
		expect(
			decideLoginPreKeyCheck({ serverHasPreKeys: undefined, nextPreKeyId: 813, currentPreKeyExists: true })
		).toEqual({
			check: true,
			reason: 'legacy_unknown'
		})
	})
	it('checks when the latest prekey is missing from local storage', () => {
		expect(decideLoginPreKeyCheck({ serverHasPreKeys: true, nextPreKeyId: 813, currentPreKeyExists: false })).toEqual({
			check: true,
			reason: 'current_prekey_missing'
		})
	})
})

describe('uploadWithServerFlag (failed upload -> next login rechecks)', () => {
	it('sets false before and true only after success', async () => {
		const flags: boolean[] = []
		await uploadWithServerFlag(
			f => flags.push(f),
			async () => {}
		)
		expect(flags).toEqual([false, true])
	})
	it('leaves the flag false when the upload fails, so the next login re-uploads', async () => {
		let persisted: boolean | undefined = true
		await expect(
			uploadWithServerFlag(
				f => (persisted = f),
				async () => {
					throw new Error('timeout')
				}
			)
		).rejects.toThrow('timeout')
		expect(persisted).toBe(false)
		expect(
			decideLoginPreKeyCheck({ serverHasPreKeys: persisted, nextPreKeyId: 813, currentPreKeyExists: true }).check
		).toBe(true)
	})
})

describe('runPreKeyLow', () => {
	it('uploads the full 812 batch unconditionally, even when the reported count is above the old <5 gate', async () => {
		const upload = jest.fn<(c: number) => Promise<void>>(async () => {})
		await runPreKeyLow({ stanzaId: 'a', inFlight: new Set(), upload, count: 812 })
		expect(upload).toHaveBeenCalledWith(812)
	})
	it('de-dupes a redelivered stanza while in flight', async () => {
		const upload = jest.fn<(c: number) => Promise<void>>(async () => {})
		await runPreKeyLow({ stanzaId: 'a', inFlight: new Set(['a']), upload, count: 812 })
		expect(upload).not.toHaveBeenCalled()
	})
})

describe('runKeyDigest', () => {
	it('re-uploads on a 404 from the digest query (WAWebDigestKeyJob) instead of throwing', async () => {
		const upload = jest.fn<() => Promise<void>>(async () => {})
		await runKeyDigest({
			queryDigest: async () => {
				throw new Boom('no record', { statusCode: 404 })
			},
			upload
		})
		expect(upload).toHaveBeenCalledTimes(1)
	})
	it('rethrows other errors without uploading', async () => {
		const upload = jest.fn<() => Promise<void>>(async () => {})
		await expect(
			runKeyDigest({
				queryDigest: async () => {
					throw new Boom('boom', { statusCode: 500 })
				},
				upload
			})
		).rejects.toThrow('boom')
		expect(upload).not.toHaveBeenCalled()
	})
	it('does nothing when the digest node is present', async () => {
		const upload = jest.fn<() => Promise<void>>(async () => {})
		await runKeyDigest({
			queryDigest: async () => ({ tag: 'iq', attrs: {}, content: [{ tag: 'digest', attrs: {} }] }),
			upload
		})
		expect(upload).not.toHaveBeenCalled()
	})
})

describe('classifyServerEncryptNotification', () => {
	const n = (content: BinaryNode[], from = S_WHATSAPP_NET): BinaryNode => ({
		tag: 'notification',
		attrs: { from, type: 'encrypt', id: 'x' },
		content
	})
	it('count -> prekey_low', () => {
		expect(classifyServerEncryptNotification(n([{ tag: 'count', attrs: { value: '3' } }]))).toBe('prekey_low')
	})
	it('digest -> digest (previously crashed on count!.attrs)', () => {
		expect(classifyServerEncryptNotification(n([{ tag: 'digest', attrs: {} }]))).toBe('digest')
	})
	it('pq_count only -> ignored', () => {
		expect(classifyServerEncryptNotification(n([{ tag: 'pq_count', attrs: { value: '3' } }]))).toBe('other')
	})
	it('non-server sender -> other', () => {
		expect(classifyServerEncryptNotification(n([{ tag: 'count', attrs: { value: '3' } }], '123@s.whatsapp.net'))).toBe(
			'other'
		)
	})
})
