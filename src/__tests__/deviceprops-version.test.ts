import { parseOsVersion } from '../Utils/validate-connection'

// The DeviceProps.version sent at companion registration used to be HARDCODED to
// macOS 10.15.7 (Catalina, 2019) regardless of config — a stale, non-human tell.
// It now derives from config.browser[2]. These pin the parse.
describe('parseOsVersion (DeviceProps.version from config.browser[2])', () => {
	it('parses a full x.y.z version', () => {
		expect(parseOsVersion('15.6.1')).toEqual({ primary: 15, secondary: 6, tertiary: 1 })
	})

	it('parses x.y (missing tertiary → 0)', () => {
		expect(parseOsVersion('15.5')).toEqual({ primary: 15, secondary: 5, tertiary: 0 })
	})

	it('parses a single major (missing minor/patch → 0)', () => {
		expect(parseOsVersion('15')).toEqual({ primary: 15, secondary: 0, tertiary: 0 })
	})

	it('keeps the stock Browsers.macOS default (14.4.1) once derived from config', () => {
		expect(parseOsVersion('14.4.1')).toEqual({ primary: 14, secondary: 4, tertiary: 1 })
	})

	it('falls back to 10.15.7 when no usable version string is supplied', () => {
		expect(parseOsVersion(undefined)).toEqual({ primary: 10, secondary: 15, tertiary: 7 })
		expect(parseOsVersion('')).toEqual({ primary: 10, secondary: 15, tertiary: 7 })
		expect(parseOsVersion('not-a-version')).toEqual({ primary: 10, secondary: 15, tertiary: 7 })
	})
})
