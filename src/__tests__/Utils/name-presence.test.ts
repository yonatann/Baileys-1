import { FORK_PRESENCE_ONLY_ON_NAME_CHANGE, nextPresenceNameOnCredsUpdate } from '../../Utils/name-presence'

// WA Web only sends a name-only <presence> when the pushname actually changes
// (syncd SettingPushName mutation: b10@2454668). It never sends one for unrelated
// credential churn (signed prekeys, counters, ...). Before B10 the fork compared
// `creds.me?.name !== update.me?.name` — which is TRUE whenever the update has no
// `me` (undefined !== 'Alice') — and sent <presence/> with the undefined attr
// dropped by the encoder, i.e. a typeless (= AVAILABLE) presence on EVERY creds.update.
describe('nextPresenceNameOnCredsUpdate (B10)', () => {
	it('returns null for an update with no `me` (unrelated cred churn) — the bug case', () => {
		expect(nextPresenceNameOnCredsUpdate('Alice', { registrationId: 1 })).toBeNull()
	})
	it('returns null when `me` is present but has no name', () => {
		expect(nextPresenceNameOnCredsUpdate('Alice', { me: { id: 'x@s.whatsapp.net' } })).toBeNull()
	})
	it('returns null when the name is unchanged', () => {
		expect(nextPresenceNameOnCredsUpdate('Alice', { me: { id: 'x', name: 'Alice' } })).toBeNull()
	})
	it('returns null for an empty-string name', () => {
		expect(nextPresenceNameOnCredsUpdate('Alice', { me: { id: 'x', name: '' } })).toBeNull()
	})
	it('returns the new name when the pushname is first learned', () => {
		expect(nextPresenceNameOnCredsUpdate(undefined, { me: { id: 'x', name: 'Alice' } })).toBe('Alice')
	})
	it('returns the new name when the pushname changes', () => {
		expect(nextPresenceNameOnCredsUpdate('Alice', { me: { id: 'x', name: 'Bob' } })).toBe('Bob')
	})
	it('exports a capability marker so consumers can detect the fixed fork', () => {
		expect(FORK_PRESENCE_ONLY_ON_NAME_CHANGE).toBe(true)
	})
})
