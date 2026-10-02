import { extractAccountSyncDeviceSync } from '../../Utils/account-sync-handler'
import { type BinaryNode } from '../../WABinary'

const ME_ID = '15551230000@s.whatsapp.net'
const ME_LID = '99887766@lid'

function accountSyncNode(child: BinaryNode): BinaryNode {
	return { tag: 'notification', attrs: { type: 'account_sync', from: ME_ID }, content: [child] }
}

function devicesChild(deviceJids: string[]): BinaryNode {
	return {
		tag: 'devices',
		attrs: {},
		content: deviceJids.map(jid => ({ tag: 'device', attrs: { jid }, content: undefined }))
	}
}

describe('account_sync device-list reconcile (D1 / BE#661)', () => {
	it('signals a reconcile when the account_sync carries a <devices> child', () => {
		const node = accountSyncNode(
			devicesChild(['15551230000:0@s.whatsapp.net', '15551230000:12@s.whatsapp.net'])
		)
		const result = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(result.action).toBe('reconcile')
		if (result.action === 'reconcile') {
			expect(result.ownUser).toBe('15551230000')
			expect(result.deviceJids).toEqual([
				'15551230000:0@s.whatsapp.net',
				'15551230000:12@s.whatsapp.net'
			])
		}
	})

	it('signals a reconcile even when the <devices> child has no device entries', () => {
		const node = accountSyncNode(devicesChild([]))
		const result = extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID })
		expect(result.action).toBe('reconcile')
		if (result.action === 'reconcile') {
			expect(result.deviceJids).toEqual([])
		}
	})

	it('does NOT signal a reconcile for a disappearing_mode account_sync', () => {
		const node = accountSyncNode({
			tag: 'disappearing_mode',
			attrs: { duration: '604800', t: '1700000000' },
			content: undefined
		})
		expect(extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID }).action).toBe(
			'no_device_child'
		)
	})

	it('does NOT signal a reconcile for a blocklist account_sync', () => {
		const node = accountSyncNode({
			tag: 'blocklist',
			attrs: {},
			content: [{ tag: 'item', attrs: { jid: 'x@s.whatsapp.net', action: 'block' }, content: undefined }]
		})
		expect(extractAccountSyncDeviceSync(node, { meId: ME_ID, meLid: ME_LID }).action).toBe(
			'no_device_child'
		)
	})

	it('skips the reconcile when the own user id is unavailable', () => {
		const node = accountSyncNode(devicesChild(['15551230000:0@s.whatsapp.net']))
		expect(extractAccountSyncDeviceSync(node, { meId: undefined, meLid: undefined }).action).toBe(
			'skipped_no_me'
		)
	})
})
