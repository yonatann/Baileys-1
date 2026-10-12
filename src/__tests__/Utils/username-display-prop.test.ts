import { describe, expect, it } from '@jest/globals'
import {
	applyUsernameContactDisplayProp,
	USERNAME_CONTACT_DISPLAY_CONFIG_CODE,
	USERNAME_CONTACT_DISPLAY_CONFIG_NAME,
	USERNAME_CONTACT_DISPLAY_DEFAULT
} from '../../Utils/username-display-prop'
import { type BinaryNode, reduceBinaryNodeToDictionary } from '../../WABinary'

// WA Web parity (FR2): AB prop 4746 `username_contact_display` (bool, default true).
// Evidence: WAWebABPropsConfigs b09.js ~@311516 `username_contact_display:[4746,"bool",!0,!0]`;
// WAWebUsernameGatingUtils (b06.js ~@3755282) `usernameDisplayedEnabled()` = getABPropConfigValue("username_contact_display") || isGuest.
describe('username_contact_display AB prop (4746)', () => {
	it('uses WA Web config code 4746, name username_contact_display, default true', () => {
		expect(USERNAME_CONTACT_DISPLAY_CONFIG_CODE).toBe('4746')
		expect(USERNAME_CONTACT_DISPLAY_CONFIG_NAME).toBe('username_contact_display')
		expect(USERNAME_CONTACT_DISPLAY_DEFAULT).toBe(true)
	})

	it('present true (config_value "1") sets true', () => {
		expect(applyUsernameContactDisplayProp({ '4746': '1' }, false)).toBe(true)
	})

	it('present false (config_value "0") sets false', () => {
		expect(applyUsernameContactDisplayProp({ '4746': '0' }, true)).toBe(false)
	})

	it('parses the WA bool spellings "1", "True", "true" as true', () => {
		expect(applyUsernameContactDisplayProp({ '4746': 'True' }, false)).toBe(true)
		expect(applyUsernameContactDisplayProp({ '4746': 'true' }, false)).toBe(true)
	})

	it('treats any other value as false (WA parseConfigValue: "1"|"True"|"true")', () => {
		expect(applyUsernameContactDisplayProp({ '4746': 'false' }, true)).toBe(false)
		expect(applyUsernameContactDisplayProp({ '4746': '0' }, true)).toBe(false)
	})

	it('ignores the name-keyed form (WA abt map is keyed by config_code only)', () => {
		expect(applyUsernameContactDisplayProp({ username_contact_display: 'true' }, false)).toBe(false)
	})

	it('absent on a fresh session keeps the WA default (true)', () => {
		expect(applyUsernameContactDisplayProp({}, USERNAME_CONTACT_DISPLAY_DEFAULT)).toBe(true)
	})

	it('absent from a delta response keeps the last-known server value (restored false stays false)', () => {
		expect(applyUsernameContactDisplayProp({ '9999': '1' }, false)).toBe(false)
	})

	it('parses the abt IQ <props><prop config_code=.../></props> response shape', () => {
		const propsNode: BinaryNode = {
			tag: 'props',
			attrs: { hash: 'h', refresh: '3600' },
			content: [{ tag: 'prop', attrs: { config_code: '4746', config_value: '0' } }]
		}
		const props = reduceBinaryNodeToDictionary(propsNode, 'prop')
		expect(applyUsernameContactDisplayProp(props, true)).toBe(false)

		const onNode: BinaryNode = {
			tag: 'props',
			attrs: {},
			content: [{ tag: 'prop', attrs: { config_code: '4746', config_value: 'True' } }]
		}
		expect(applyUsernameContactDisplayProp(reduceBinaryNodeToDictionary(onNode, 'prop'), false)).toBe(true)
	})
})
