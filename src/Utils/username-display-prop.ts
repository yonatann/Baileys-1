/**
 * WA Web parity (FR2): AB prop `username_contact_display`, config code 4746 (bool, default true).
 * Evidence: WAWebABPropsConfigs (b09.js ~@311516) `username_contact_display:[4746,"bool",!0,!0]`;
 * WAWebUsernameGatingUtils (b06.js ~@3755282) `usernameDisplayedEnabled()` = getABPropConfigValue("username_contact_display") || isGuest.
 * The isGuest disjunct is a WA Web browser-session gatekeeper (gkx 10314); a paired Baileys session is never a guest, so it is omitted.
 * This value is display-only and does NOT participate in the LID-migration gate (WAIsAccountLidFieldMigrated).
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
	const raw = props[USERNAME_CONTACT_DISPLAY_CONFIG_CODE] ?? props[USERNAME_CONTACT_DISPLAY_CONFIG_NAME]
	if (raw === undefined) {
		return current
	}
	return raw === 'true' || raw === '1'
}
