import { DEFAULT_CONNECTION_CONFIG } from '../../Defaults'
import { type SocketConfig } from '../../Types'
import { generateLoginNode, nextLoginCounter } from '../../Utils/validate-connection'

const config = { ...DEFAULT_CONNECTION_CONFIG } as SocketConfig
const JID = '15551230000:3@s.whatsapp.net'

describe('generateLoginNode — WA Web login continuity (BE#687)', () => {
	it('sends the persistent login counter (lc) it is given', () => {
		expect(generateLoginNode(JID, config, 7).lc).toBe(7)
	})

	it('sends lc=0 on a first-ever login', () => {
		expect(generateLoginNode(JID, config, 0).lc).toBe(0)
	})

	it('connects with passive:false (WA Web default for a companion with no pending passive tasks)', () => {
		expect(generateLoginNode(JID, config, 1).passive).toBe(false)
	})

	it('keeps pull:true and the decoded username/device', () => {
		const node = generateLoginNode(JID, config, 1)
		expect(node.pull).toBe(true)
		expect(node.username?.toString()).toBe('15551230000')
		expect(node.device).toBe(3)
	})
})

describe('nextLoginCounter — WA Web lc increment with int32 wrap (BE#687)', () => {
	it('increments by one', () => {
		expect(nextLoginCounter(0)).toBe(1)
		expect(nextLoginCounter(41)).toBe(42)
	})

	it('wraps back to 0 at int32 max (2^31-1), matching WA Web incrementLoginCounter', () => {
		expect(nextLoginCounter(2147483647)).toBe(0)
		expect(nextLoginCounter(2147483646)).toBe(2147483647)
	})
})
