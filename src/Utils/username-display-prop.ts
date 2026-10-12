/**
 * WA Web parity (FR2): AB prop `username_contact_display`, config code 4746 (bool, default true).
 * Evidence: WAWebABPropsConfigs (b09.js ~@311516) `username_contact_display:[4746,"bool",!0,!0]`;
 * WAWebUsernameGatingUtils (b06.js module @3755282; getter e() @3755434) `usernameDisplayedEnabled()` = getABPropConfigValue("username_contact_display") || isGuest.
 * usernameDisplayedEnabled() = this prop term OR the isGuest input (WA: `getABPropConfigValue(...) || Environment.isGuest`,
 * isGuest = gkx 10314). The isGuest input comes from SocketConfig.gatekeepers.isGuest and defaults to false (U-2: the
 * companion-client value of gkx 10314 is not verifiable from the bundle). The value is display-only and does NOT
 * participate in the LID-migration gate (WAIsAccountLidFieldMigrated).
 */
export const USERNAME_CONTACT_DISPLAY_CONFIG_CODE = '4746'
export const USERNAME_CONTACT_DISPLAY_CONFIG_NAME = 'username_contact_display'
export const USERNAME_CONTACT_DISPLAY_DEFAULT = true

/**
 * Applies the server's value for the username_contact_display AB prop from an abt `<props>` dictionary.
 * When the prop is absent (fresh session or delta response that omits unchanged props) the current value is kept:
 * on a fresh session `current` is the WA default, and on a restored session it is the last-known server value.
 */
export function applyUsernameContactDisplayProp(props: { [_: string]: string }, current: boolean): boolean {
	const raw = props[USERNAME_CONTACT_DISPLAY_CONFIG_CODE]
	if (raw === undefined) {
		return current
	}
	// WA Web parseConfigValue (b04.js ~@487041): bool = "1" | "True" | "true".
	return raw === '1' || raw === 'True' || raw === 'true'
}

/**
 * WA Web usernameDisplayedEnabled(): the prop term OR Environment.isGuest (gkx 10314, WAWebUsernameGatingUtils).
 */
export function usernameDisplayedEnabled(input: { usernameContactDisplayProp: boolean; isGuest: boolean }): boolean {
	return input.usernameContactDisplayProp || input.isGuest
}

/**
 * Resolves the isGuest input from SocketConfig.gatekeepers. Only the explicit boolean true enables it; absent = false.
 */
export function resolveIsGuest(gatekeepers: { isGuest?: boolean } | undefined): boolean {
	return gatekeepers?.isGuest === true
}
