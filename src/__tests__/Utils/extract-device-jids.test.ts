import { describe, expect, it } from '@jest/globals'
import { extractDeviceJids } from '../../Utils/signal'
import type { USyncQueryResultList } from '../../WAUSync'

const ME_ID = '972500000001:7@s.whatsapp.net'
const ME_LID = '100000000000001:7@lid'

const answer = (id: string, devices: number[]): USyncQueryResultList => ({
	id,
	devices: { deviceList: devices.map(device => (device ? { id: device, keyIndex: 1 } : { id: device })) }
})

const jids = (result: USyncQueryResultList[]) =>
	extractDeviceJids(result, ME_ID, ME_LID, false).map(d => `${d.user}:${d.device}@${d.server}`)

describe('extractDeviceJids', () => {
	it('drops our own device under its pn user', () => {
		expect(jids([answer('972500000001@s.whatsapp.net', [0, 7, 9])])).toEqual([
			'972500000001:0@s.whatsapp.net',
			'972500000001:9@s.whatsapp.net'
		])
	})

	it('drops our own device under its lid user too', () => {
		expect(jids([answer('100000000000001@lid', [0, 7, 9])])).toEqual(['100000000000001:0@lid', '100000000000001:9@lid'])
	})

	it('keeps the same device number on another user', () => {
		expect(jids([answer('972500000002@s.whatsapp.net', [0, 7])])).toEqual([
			'972500000002:0@s.whatsapp.net',
			'972500000002:7@s.whatsapp.net'
		])
	})
})
