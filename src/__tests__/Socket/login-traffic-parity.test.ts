import { describe, expect, it } from '@jest/globals'
import { classifyServerEncryptNotification, decideLoginPreKeyCheck } from '../../Utils/login-traffic-policy'
import { type BinaryNode, S_WHATSAPP_NET } from '../../WABinary'

// WA Web parity (B5): no unconditional prekey-count / digest IQ at login.
// Evidence: WAWebRegisterPassiveTasks "KeyUpload" runs only when !getServerHasPreKeys (b06@2282389+);
// WAWebHandlePreKeyLow (b12@1723946) / WAWebHandleDigestKey (b12@1583869) are notification-driven.
describe('decideLoginPreKeyCheck', () => {
	it('skips the network check for an already-registered account with its current prekey in storage', () => {
		expect(
			decideLoginPreKeyCheck({ firstUnuploadedPreKeyId: 813, nextPreKeyId: 813, currentPreKeyExists: true })
		).toEqual({
			check: false
		})
	})
	it('checks when prekeys were never uploaded (fresh pairing)', () => {
		expect(decideLoginPreKeyCheck({ firstUnuploadedPreKeyId: 1, nextPreKeyId: 1, currentPreKeyExists: false })).toEqual(
			{
				check: true,
				reason: 'never_uploaded'
			}
		)
	})
	it('checks when the most recently generated prekey is missing from local storage', () => {
		expect(
			decideLoginPreKeyCheck({ firstUnuploadedPreKeyId: 813, nextPreKeyId: 813, currentPreKeyExists: false })
		).toEqual({
			check: true,
			reason: 'current_prekey_missing'
		})
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
