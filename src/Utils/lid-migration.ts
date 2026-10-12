import { proto } from '../../WAProto/index.js'
import type { AuthenticationCreds } from '../Types'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'

/** Fields the pair-success handler may persist into creds (WA Web parity FR1). */
export type PairingLidMigrationUpdate = Partial<
	Pick<AuthenticationCreds, 'isChatDbLidMigrated' | 'isSyncdPureLidSession'>
>

/**
 * The single gating getter for the account LID migration flag (WA Web equivalent:
 * `Lid1X1MigrationUtils.isLidMigrated()`, stored value === true). Absent = unmigrated.
 * Later migrated-only branches must read this, never the raw field.
 */
export const isAccountLidMigrated = (creds: Pick<AuthenticationCreds, 'isChatDbLidMigrated'>): boolean =>
	creds.isChatDbLidMigrated === true

/**
 * Decodes the optional `client-props` child of a pair-success stanza (WA Web: `pairSuccessClientProps`,
 * decoded as ClientPairingPropsSpec). Returns undefined when the child is absent.
 */
export const parseClientPairingProps = (pairSuccessStanza: BinaryNode): proto.IClientPairingProps | undefined => {
	const pairSuccessNode = getBinaryNodeChild(pairSuccessStanza, 'pair-success')
	const clientPropsNode = getBinaryNodeChild(pairSuccessNode, 'client-props')
	if (!clientPropsNode || !(clientPropsNode.content instanceof Uint8Array)) {
		return undefined
	}

	return proto.ClientPairingProps.decode(clientPropsNode.content)
}

/**
 * Mirrors WA Web's pair-success handling of the migration flag, WITHOUT the logout.
 * - isChatDbLidMigrated === true: persist the flag, plus isSyncdPureLidSession when it is a boolean
 *   (WA stores pureLid only when non-null).
 * - anything else (false, absent, props absent): no change. We never flip the flag to false and never
 *   log out (operator rule: no socketLogout on live sessions).
 */
export const getPairingLidMigrationUpdate = (
	props: proto.IClientPairingProps | undefined
): PairingLidMigrationUpdate => {
	if (props?.isChatDbLidMigrated !== true) {
		return {}
	}

	const update: PairingLidMigrationUpdate = { isChatDbLidMigrated: true }
	if (typeof props.isSyncdPureLidSession === 'boolean') {
		update.isSyncdPureLidSession = props.isSyncdPureLidSession
	}

	return update
}
