import { generateParticipantHashV2 } from '../../Utils/generics'
import { isPhashFanoutDevice, selectPhashFanoutJids } from '../../Utils/group-phash-resend'

const ME_PN = '15550000009:5@s.whatsapp.net'
const ME_LID = '900000000000009:5@lid'

// WA Web `WAWebDBDeviceListFanout.getFanOutList`: device id 99 and hosted devices never enter the
// group fan-out list (and therefore never enter the phash); the current device is excluded too.
describe('isPhashFanoutDevice / selectPhashFanoutJids', () => {
	it('drops device 99, hosted devices and the exact sender device', () => {
		expect(isPhashFanoutDevice('15550000001@s.whatsapp.net', 0, ME_PN, ME_LID)).toBe(true)
		expect(isPhashFanoutDevice('15550000001:4@s.whatsapp.net', 4, ME_PN, ME_LID)).toBe(true)
		expect(isPhashFanoutDevice('15550000001:99@s.whatsapp.net', 99, ME_PN, ME_LID)).toBe(false)
		expect(isPhashFanoutDevice('15550000001:3@hosted', 3, ME_PN, ME_LID)).toBe(false)
		expect(isPhashFanoutDevice('100000000000001:3@hosted.lid', 3, ME_PN, ME_LID)).toBe(false)
		expect(isPhashFanoutDevice(ME_PN, 5, ME_PN, ME_LID)).toBe(false)
		expect(isPhashFanoutDevice(ME_LID, 5, ME_PN, ME_LID)).toBe(false)
		// own OTHER devices stay (WA Web's isMeDevice only matches the current device)
		expect(isPhashFanoutDevice('15550000009@s.whatsapp.net', 0, ME_PN, ME_LID)).toBe(true)
	})

	it('a list with a 99/hosted device hashes equal to the list without them', () => {
		const clean = ['15550000001@s.whatsapp.net', '15550000001:4@s.whatsapp.net', '15550000002@s.whatsapp.net']
		const withNoise = [...clean, '15550000002:99@s.whatsapp.net', '15550000003:2@hosted']
		const filtered = selectPhashFanoutJids(
			withNoise.map(jid => ({ jid, device: Number(jid.match(/:(\d+)@/)?.[1] ?? 0) })),
			ME_PN,
			ME_LID
		)
		expect(filtered).toEqual(clean)
		expect(generateParticipantHashV2([...filtered, ME_PN])).toBe(generateParticipantHashV2([...clean, ME_PN]))
		expect(generateParticipantHashV2([...withNoise, ME_PN])).not.toBe(generateParticipantHashV2([...clean, ME_PN]))
	})

	it('hashes to the live-captured WA Web value once the noise is stripped', () => {
		// The 6-device LID fixture in participant-hash.test.ts reproduces a phash captured from a
		// real WA Web group send; adding a hosted/99 member and filtering must land on the same value.
		const captured = [
			'100000000000001@lid',
			'100000000000001:3@lid',
			'100000000000001:7@lid',
			'200000000000002@lid',
			'200000000000002:11@lid',
			'200000000000002:12@lid'
		]
		const usync = [...captured, '300000000000003:99@hosted.lid'].map(jid => ({
			jid,
			device: Number(jid.match(/:(\d+)@/)?.[1] ?? 0)
		}))
		// the sender device is folded into the fixture; pass an unrelated "me" so nothing else drops
		expect(generateParticipantHashV2(selectPhashFanoutJids(usync, ME_PN, ME_LID))).toBe('2:tR64+Ziz')
	})
})
