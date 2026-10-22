import type { SignalRepository } from '../Types/Signal'
import {
	type BinaryNode,
	getBinaryNodeChild,
	getBinaryNodeChildBuffer,
	getBinaryNodeChildren,
	getBinaryNodeChildUInt,
	jidDecode,
	jidEncode,
	S_WHATSAPP_NET
} from '../WABinary'
import { generateSignalPubKey } from './crypto'
import { encodeBigEndian } from './generics'

/**
 * WA Web parity for `WASmaxPreKeysFetchMissingPreKeysRPC` (`fetchResendMissingKeys`).
 *
 * Request: `<iq xmlns="encrypt" to="s.whatsapp.net" type="get"><key_fetch>` with one
 * `<user jid>` per account and one `<device id><registration>` (4 bytes big-endian) per device we
 * already hold a session for. The server answers with bundles only for the devices it knows that we
 * did not list. Answer: `<iq><list><user jid><device id>` carrying `<registration>`, `<identity>`,
 * `<skey>`, optional `<key>` and optional `<device-identity>`.
 */

export type KnownDeviceRegistration = {
	deviceId: number
	registrationId: number
}

export type KnownUserDevices = {
	userJid: string
	devices: KnownDeviceRegistration[]
}

export const buildFetchMissingPreKeysQuery = (users: readonly KnownUserDevices[]): BinaryNode => ({
	tag: 'iq',
	attrs: { xmlns: 'encrypt', to: S_WHATSAPP_NET, type: 'get' },
	content: [
		{
			tag: 'key_fetch',
			attrs: {},
			content: users.map(({ userJid, devices }) => ({
				tag: 'user',
				attrs: { jid: userJid },
				content: devices.map(({ deviceId, registrationId }) => ({
					tag: 'device',
					attrs: { id: String(deviceId) },
					content: [{ tag: 'registration', attrs: {}, content: encodeBigEndian(registrationId, 4) }]
				}))
			}))
		}
	]
})

type E2ESession = Parameters<SignalRepository['injectE2ESession']>[0]['session']

export type MissingPreKeyBundle = {
	jid: string
	session: E2ESession
}

const isUInt = (n: number | undefined): n is number => typeof n === 'number' && Number.isInteger(n)

const parseKeyNode = (node: BinaryNode | undefined): { keyId: number; publicKey: Uint8Array } | undefined => {
	if (!node) return undefined
	const keyId = getBinaryNodeChildUInt(node, 'id', 3)
	const value = getBinaryNodeChildBuffer(node, 'value')
	if (!isUInt(keyId) || !value || value.length !== 32) return undefined
	return { keyId, publicKey: generateSignalPubKey(value) }
}

/**
 * Bundles from a `FetchMissingPreKeys` answer. A user or device that answered with an error, or whose
 * bundle is malformed, is skipped (WA Web counts and logs failed users and processes the rest).
 */
export const parseMissingPreKeyBundles = (
	result: BinaryNode
): { bundles: MissingPreKeyBundle[]; failedUsers: number } => {
	const bundles: MissingPreKeyBundle[] = []
	let failedUsers = 0
	const list = getBinaryNodeChild(result, 'list')
	for (const userNode of getBinaryNodeChildren(list, 'user')) {
		const decoded = jidDecode(userNode.attrs.jid)
		if (!decoded || getBinaryNodeChild(userNode, 'error')) {
			failedUsers++
			continue
		}

		for (const deviceNode of getBinaryNodeChildren(userNode, 'device')) {
			const deviceId = Number(deviceNode.attrs.id)
			const registrationId = getBinaryNodeChildUInt(deviceNode, 'registration', 4)
			const identity = getBinaryNodeChildBuffer(deviceNode, 'identity')
			const signedPreKey = parseKeyNode(getBinaryNodeChild(deviceNode, 'skey'))
			const signature = getBinaryNodeChildBuffer(getBinaryNodeChild(deviceNode, 'skey'), 'signature')
			if (
				!Number.isInteger(deviceId) ||
				!isUInt(registrationId) ||
				!identity ||
				identity.length !== 32 ||
				!signedPreKey ||
				!signature
			) {
				failedUsers++
				continue
			}

			const deviceIdentity = getBinaryNodeChildBuffer(deviceNode, 'device-identity')
			const preKey = parseKeyNode(getBinaryNodeChild(deviceNode, 'key'))
			bundles.push({
				jid: jidEncode(decoded.user, decoded.server, deviceId),
				session: {
					registrationId,
					identityKey: generateSignalPubKey(identity),
					signedPreKey: { ...signedPreKey, signature },
					...(preKey ? { preKey } : {}),
					...(deviceIdentity ? { deviceIdentity } : {})
				}
			})
		}
	}

	return { bundles, failedUsers }
}
