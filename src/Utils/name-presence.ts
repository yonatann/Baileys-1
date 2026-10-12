import type { AuthenticationCreds } from '../Types'

/**
 * Capability marker: this fork only sends the name-only (typeless) `<presence>` when the
 * pushname actually changes, not on every `creds.update`. Consumers that previously
 * countered the stray presence (e.g. by sending `unavailable`) can detect the fixed fork
 * via this constant (undefined on older forks) and narrow/drop the counter.
 */
export const FORK_PRESENCE_ONLY_ON_NAME_CHANGE = true

/**
 * Decides whether a `creds.update` should trigger the name-only `<presence name=...>`.
 * Returns the new name to announce, or null for "send nothing".
 *
 * WA Web sends a name-only presence only from the syncd SettingPushName mutation
 * (b10@2454668) and always sends presence with an explicit status elsewhere
 * (b07@3039334). It never emits one for unrelated credential churn. The previous
 * check (`currentName !== update.me?.name`) was TRUE for every update lacking `me`,
 * and the binary encoder drops undefined attrs, so each such update put out a bare
 * `<presence/>` — which WhatsApp reads as AVAILABLE.
 */
export const nextPresenceNameOnCredsUpdate = (
	currentName: string | undefined,
	update: Partial<AuthenticationCreds>
): string | null => {
	const name = update.me?.name
	if (!name || name === currentName) {
		return null
	}

	return name
}
