import { AB_PROPS_DEFAULT_REFRESH_SEC, clampAbPropsRefreshSec, planInitQueries } from '../../Utils/init-queries'

// WA Web parity (B7): b06@4249442 WAWebABPropsLocalStorage clamps refresh to [600, 604800], default 86400;
// b07@323919 / b07@330914 fetch blocklist + privacy at pairing bootstrap only; later via account_sync/dirty pushes.
const NOW = 1_800_000_000_000

describe('clampAbPropsRefreshSec', () => {
	it('defaults to 86400 when absent/garbage', () => {
		expect(AB_PROPS_DEFAULT_REFRESH_SEC).toBe(86400)
		expect(clampAbPropsRefreshSec(undefined)).toBe(86400)
		expect(clampAbPropsRefreshSec('abc')).toBe(86400)
	})
	it('clamps to [600, 604800]', () => {
		expect(clampAbPropsRefreshSec('5')).toBe(600)
		expect(clampAbPropsRefreshSec('99999999')).toBe(604800)
		expect(clampAbPropsRefreshSec('3600')).toBe(3600)
	})
})

describe('planInitQueries', () => {
	it('first ever open (fresh pairing): fetches everything', () => {
		expect(planInitQueries({}, NOW)).toEqual({ props: true, blocklist: true, privacy: true })
	})
	it('reconnect within refresh window: skips all three', () => {
		const creds = {
			lastPropHash: 'h',
			abPropsSyncedAt: NOW - 60_000,
			abPropsRefreshSec: 86400,
			blocklistSyncedAt: NOW - 120_000,
			privacySyncedAt: NOW - 120_000
		}
		expect(planInitQueries(creds, NOW)).toEqual({ props: false, blocklist: false, privacy: false })
	})
	it('props refetched once the server refresh interval elapsed; blocklist/privacy still skipped', () => {
		const creds = {
			lastPropHash: 'h',
			abPropsSyncedAt: NOW - 86401_000,
			abPropsRefreshSec: 86400,
			blocklistSyncedAt: 1,
			privacySyncedAt: 1
		}
		expect(planInitQueries(creds, NOW)).toEqual({ props: true, blocklist: false, privacy: false })
	})
	it('props fetched when no persisted hash/timestamp even if other flags set', () => {
		expect(planInitQueries({ blocklistSyncedAt: 1, privacySyncedAt: 1 }, NOW).props).toBe(true)
	})
	it('clock moved backwards: treats as due', () => {
		expect(
			planInitQueries({ lastPropHash: 'h', abPropsSyncedAt: NOW + 10_000_000, abPropsRefreshSec: 600 }, NOW).props
		).toBe(true)
	})
})
