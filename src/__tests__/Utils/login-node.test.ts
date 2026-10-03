import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import { type SocketConfig } from '../../Types'
import { generateLoginNode } from '../../Utils/validate-connection'

const config = { ...DEFAULT_CONNECTION_CONFIG } as SocketConfig
const JID = '15551230000:3@s.whatsapp.net'

describe('generateLoginNode — WA Web login continuity (BE#687)', () => {
	it('sends the persistent login counter (lc) it is given', () => {
		expect(generateLoginNode(JID, config, 7).lc).toBe(7)
	})

	it('sends lc=0 on a first-ever login', () => {
		expect(generateLoginNode(JID, config, 0).lc).toBe(0)
	})

	it('connects as ACTIVE (passive:false) — the gateway is the sole/primary device', () => {
		expect(generateLoginNode(JID, config, 1).passive).toBe(false)
	})

	it('keeps pull:true and the decoded username/device', () => {
		const node = generateLoginNode(JID, config, 1)
		expect(node.pull).toBe(true)
		expect(node.username?.toString()).toBe('15551230000')
		expect(node.device).toBe(3)
	})
})
