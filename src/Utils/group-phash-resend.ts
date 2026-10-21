import { isHostedLidUser, isHostedPnUser } from '../WABinary'

/**
 * WA Web parity for the group `<message phash>` input set.
 *
 * `WAWebDBDeviceListFanout.getFanOutList` builds the list a group send fans out to: device id 99
 * and hosted devices never enter it for a group chat (the hosted-include flag is only set for
 * 1:1 chats by `WAWebSendUserMsgJob`), and the current device is excluded (`isMeDevice` matches
 * the current PN/LID device only — own companion devices stay). `WAWebSendGroupSkmsgJob` then
 * hashes exactly that list plus the sender device (`phashV2([...skList, ...skDistribList, me])`),
 * so the hashed set and the fan-out set are the same set.
 *
 * Pure helpers only; the socket wiring lives in `Socket/messages-send.ts`.
 */
export const isPhashFanoutDevice = (
	jid: string,
	device: number | undefined,
	meId: string,
	meLid: string | undefined
): boolean => {
	if (device === 99) return false
	if (isHostedPnUser(jid) || isHostedLidUser(jid)) return false
	if (jid === meId || (!!meLid && jid === meLid)) return false
	return true
}

export const selectPhashFanoutJids = (
	devices: { jid: string; device?: number }[],
	meId: string,
	meLid: string | undefined
): string[] => {
	const out: string[] = []
	const seen = new Set<string>()
	for (const { jid, device } of devices) {
		if (!isPhashFanoutDevice(jid, device, meId, meLid) || seen.has(jid)) continue
		seen.add(jid)
		out.push(jid)
	}

	return out
}
