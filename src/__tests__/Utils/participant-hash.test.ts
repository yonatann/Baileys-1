import { generateParticipantHashV2, toParticipantHashJid } from '../../Utils/generics'

// Expected values come from an independent re-implementation of WA Web's
// WAWebPhashUtils.phashV2 that reproduced, byte for byte, two phash attrs captured live
// from WA Web 2.3000.1050463354 group sends (2026-10-15). Synthetic JIDs keep real
// accounts out of the repo.
describe('participant hash (phash v2)', () => {
	it('formats device JIDs the way WA Web does (agent .0, explicit :0 device)', () => {
		expect(toParticipantHashJid('100000000000001@lid')).toBe('100000000000001.0:0@lid')
		expect(toParticipantHashJid('100000000000001:7@lid')).toBe('100000000000001.0:7@lid')
		expect(toParticipantHashJid('15550000001:4@s.whatsapp.net')).toBe('15550000001.0:4@s.whatsapp.net')
		expect(toParticipantHashJid('15550000001@c.us')).toBe('15550000001.0:0@s.whatsapp.net')
	})

	it('produces the 8-char WA Web hash for a LID group fanout', () => {
		const devices = [
			'100000000000001@lid',
			'100000000000001:3@lid',
			'100000000000001:7@lid',
			'200000000000002@lid',
			'200000000000002:11@lid',
			'200000000000002:12@lid'
		]
		const phash = generateParticipantHashV2(devices)
		expect(phash).toBe('2:tR64+Ziz')
		expect(phash).toMatch(/^2:[A-Za-z0-9+/]{8}$/)
	})

	it('is order-independent and ignores duplicate devices', () => {
		const devices = ['200000000000002:12@lid', '100000000000001@lid', '200000000000002@lid']
		const shuffled = ['200000000000002@lid', '200000000000002:12@lid', '100000000000001@lid', '100000000000001@lid']
		expect(generateParticipantHashV2(devices)).toBe(generateParticipantHashV2(shuffled))
	})

	it('hashes PN-addressed devices', () => {
		expect(
			generateParticipantHashV2([
				'15550000001@s.whatsapp.net',
				'15550000001:4@s.whatsapp.net',
				'15550000002:9@s.whatsapp.net'
			])
		).toBe('2:pU1D+HqD')
	})

	it('does not mutate the input list', () => {
		const devices = ['b@lid', 'a@lid']
		generateParticipantHashV2(devices)
		expect(devices).toEqual(['b@lid', 'a@lid'])
	})
})
