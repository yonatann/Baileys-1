import { jest } from '@jest/globals'
import {
	AB_PROPS_DEFAULT_REFRESH_SEC,
	clampAbPropsRefreshSec,
	dispatchAccountSyncDirtyProtocols,
	planInitQueries
} from '../../Utils/init-queries'

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

describe('clampAbPropsRefreshSec edge inputs', () => {
	it('0, negative, NaN-ish and null fall back to the 86400 default', () => {
		expect(clampAbPropsRefreshSec(0)).toBe(86400)
		expect(clampAbPropsRefreshSec('0')).toBe(86400)
		expect(clampAbPropsRefreshSec(-5)).toBe(86400)
		expect(clampAbPropsRefreshSec('-600')).toBe(86400)
		expect(clampAbPropsRefreshSec('')).toBe(86400)
		expect(clampAbPropsRefreshSec(null)).toBe(86400)
		expect(clampAbPropsRefreshSec(NaN)).toBe(86400)
	})
	it('exact bounds are kept', () => {
		expect(clampAbPropsRefreshSec(600)).toBe(600)
		expect(clampAbPropsRefreshSec(604800)).toBe(604800)
		expect(clampAbPropsRefreshSec(599)).toBe(600)
		expect(clampAbPropsRefreshSec(604801)).toBe(604800)
	})
})

describe('planInitQueries refresh boundary', () => {
	const base = { lastPropHash: 'h', abPropsRefreshSec: 3600, blocklistSyncedAt: 1, privacySyncedAt: 1 }
	it('one ms before the boundary: not due; exactly at the boundary: due', () => {
		expect(planInitQueries({ ...base, abPropsSyncedAt: NOW - 3_600_000 + 1 }, NOW).props).toBe(false)
		expect(planInitQueries({ ...base, abPropsSyncedAt: NOW - 3_600_000 }, NOW).props).toBe(true)
	})
	it('raw refresh below the minimum is clamped to 600s before comparing', () => {
		expect(planInitQueries({ ...base, abPropsRefreshSec: 5, abPropsSyncedAt: NOW - 599_000 }, NOW).props).toBe(false)
		expect(planInitQueries({ ...base, abPropsRefreshSec: 5, abPropsSyncedAt: NOW - 600_000 }, NOW).props).toBe(true)
	})
})

describe('dispatchAccountSyncDirtyProtocols (WA Web b12@1604229 parser + b12@3626909 handler)', () => {
	const mk = () => ({
		fetchPrivacy: jest.fn<(force?: boolean) => Promise<unknown>>(async () => undefined),
		fetchBlocklist: jest.fn<() => Promise<unknown>>(async () => undefined)
	})
	it('privacy child -> forced privacy refetch', async () => {
		const h = mk()
		await dispatchAccountSyncDirtyProtocols(['privacy'], h)
		expect(h.fetchPrivacy).toHaveBeenCalledWith(true)
		expect(h.fetchBlocklist).not.toHaveBeenCalled()
	})
	it('blocklist child -> blocklist refetch', async () => {
		const h = mk()
		await dispatchAccountSyncDirtyProtocols(['blocklist'], h)
		expect(h.fetchBlocklist).toHaveBeenCalledTimes(1)
		expect(h.fetchPrivacy).not.toHaveBeenCalled()
	})
	it('both, unknown tags ignored, errors do not throw', async () => {
		const h = mk()
		h.fetchPrivacy.mockRejectedValueOnce(new Error('x'))
		await expect(
			dispatchAccountSyncDirtyProtocols(['devices', 'privacy', 'blocklist', 'zzz'], h)
		).resolves.toBeUndefined()
		expect(h.fetchBlocklist).toHaveBeenCalledTimes(1)
	})
	it('no protocols -> nothing', async () => {
		const h = mk()
		await dispatchAccountSyncDirtyProtocols([], h)
		expect(h.fetchPrivacy).not.toHaveBeenCalled()
		expect(h.fetchBlocklist).not.toHaveBeenCalled()
	})
})
