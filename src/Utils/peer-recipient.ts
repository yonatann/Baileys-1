import { jidDecode } from '../WABinary'

/**
 * WA Web (`createFanoutMsgStanza`) adds `peer_recipient_pn` to a 1:1 message addressed to a
 * LID once the account is LID-migrated: the recipient's phone-number user JID, no device.
 * Returns undefined when the chat is not a LID chat, is our own chat, or the mapping is unknown.
 */
export const resolvePeerRecipientPn = async (
	jid: string,
	meLid: string | undefined,
	getPNForLID: (lid: string) => Promise<string | null>
): Promise<string | undefined> => {
	const decoded = jidDecode(jid)
	if (decoded?.server !== 'lid') {
		return undefined
	}

	if (meLid && jidDecode(meLid)?.user === decoded.user) {
		return undefined
	}

	const pn = await getPNForLID(jid)
	const pnDecoded = pn ? jidDecode(pn) : undefined
	if (!pnDecoded?.user || pnDecoded.server !== 's.whatsapp.net') {
		return undefined
	}

	return `${pnDecoded.user}@s.whatsapp.net`
}
