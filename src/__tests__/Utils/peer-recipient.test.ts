import { describe, expect, it } from '@jest/globals'
import { resolvePeerRecipientPn } from '../../Utils/peer-recipient'

// WA Web 2.3000.1050463354 (captured 2026-10-15) sent every 1:1 message to an @lid chat with
// peer_recipient_pn="<pn>@s.whatsapp.net" (user JID, no device).
const lookup = (map: Record<string, string>) => async (lid: string) => map[lid] ?? null
const meLid = '300000000000003:52@lid'

describe('resolvePeerRecipientPn', () => {
	it('returns the PN user JID for a LID chat', async () => {
		await expect(
			resolvePeerRecipientPn(
				'100000000000001@lid',
				meLid,
				lookup({ '100000000000001@lid': '15550000001@s.whatsapp.net' })
			)
		).resolves.toBe('15550000001@s.whatsapp.net')
	})

	it('drops a device suffix from the stored mapping', async () => {
		await expect(
			resolvePeerRecipientPn(
				'100000000000001@lid',
				meLid,
				lookup({ '100000000000001@lid': '15550000001:3@s.whatsapp.net' })
			)
		).resolves.toBe('15550000001@s.whatsapp.net')
	})

	it('is absent for a PN-addressed chat', async () => {
		await expect(resolvePeerRecipientPn('15550000001@s.whatsapp.net', meLid, lookup({}))).resolves.toBeUndefined()
	})

	it('is absent when the mapping is unknown', async () => {
		await expect(resolvePeerRecipientPn('100000000000001@lid', meLid, lookup({}))).resolves.toBeUndefined()
	})

	it('is absent for our own chat', async () => {
		await expect(
			resolvePeerRecipientPn(
				'300000000000003@lid',
				meLid,
				lookup({ '300000000000003@lid': '15550000003@s.whatsapp.net' })
			)
		).resolves.toBeUndefined()
	})

	it('is absent for groups and newsletters', async () => {
		await expect(resolvePeerRecipientPn('120363000000000000@g.us', meLid, lookup({}))).resolves.toBeUndefined()
		await expect(resolvePeerRecipientPn('120363000000000001@newsletter', meLid, lookup({}))).resolves.toBeUndefined()
	})
})
