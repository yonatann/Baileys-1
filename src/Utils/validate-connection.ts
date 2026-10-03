import { Boom } from '@hapi/boom'
import { createHash } from 'crypto'
import { proto } from '../../WAProto/index.js'
import {
	KEY_BUNDLE_TYPE,
	WA_ADV_ACCOUNT_SIG_PREFIX,
	WA_ADV_DEVICE_SIG_PREFIX,
	WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
} from '../Defaults'
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types'
import { type BinaryNode, getBinaryNodeChild, jidDecode, S_WHATSAPP_NET } from '../WABinary'
import { Curve, hmacSign } from './crypto'
import { encodeBigEndian } from './generics'
import { createSignalIdentity } from './signal'

const getUserAgent = (config: SocketConfig): proto.ClientPayload.IUserAgent => {
	return {
		appVersion: {
			primary: config.version[0],
			secondary: config.version[1],
			tertiary: config.version[2]
		},
		platform: proto.ClientPayload.UserAgent.Platform.WEB,
		releaseChannel: proto.ClientPayload.UserAgent.ReleaseChannel.RELEASE,
		osVersion: '0.1',
		device: 'Desktop',
		osBuildNumber: '0.1',
		localeLanguageIso6391: 'en',

		mnc: '000',
		mcc: '000',
		localeCountryIso31661Alpha2: config.countryCode
	}
}

const PLATFORM_MAP = {
	'Mac OS': proto.ClientPayload.WebInfo.WebSubPlatform.DARWIN,
	Windows: proto.ClientPayload.WebInfo.WebSubPlatform.WIN32
}

const getWebInfo = (config: SocketConfig): proto.ClientPayload.IWebInfo => {
	let webSubPlatform = proto.ClientPayload.WebInfo.WebSubPlatform.WEB_BROWSER
	if (
		config.syncFullHistory &&
		PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP] &&
		config.browser[1] === 'Desktop'
	) {
		webSubPlatform = PLATFORM_MAP[config.browser[0] as keyof typeof PLATFORM_MAP]
	}

	return { webSubPlatform }
}

const getClientPayload = (config: SocketConfig) => {
	const payload: proto.IClientPayload = {
		connectType: proto.ClientPayload.ConnectType.WIFI_UNKNOWN,
		connectReason: proto.ClientPayload.ConnectReason.USER_ACTIVATED,
		userAgent: getUserAgent(config)
	}

	payload.webInfo = getWebInfo(config)

	if (config.pushName) {
		payload.pushName = config.pushName
	}

	return payload
}

export const generateLoginNode = (
	userJid: string,
	config: SocketConfig,
	loginCounter = 0
): proto.IClientPayload => {
	const { user, device } = jidDecode(userJid)!
	const payload: proto.IClientPayload = {
		...getClientPayload(config),
		// WA Web parity (BE#687): a sole/primary connection (our headless gateway is the account's
		// only device) connects ACTIVE. WA Web resets passive=false after every successful connect;
		// persistently announcing passive=true marked us as a secondary companion.
		passive: false,
		pull: true,
		username: +user,
		device: device,
		// WA Web parity (BE#687): monotonic per-device login counter, persisted in creds (survives
		// pod restarts via the PVC auth-state) and incremented on each successful stream open. Gives
		// the server the device-continuity signal a reload presents; omitting it made every reconnect
		// look like a device that had logged in zero times.
		lc: loginCounter,
		// TODO: investigate (hard set as false atm)
		lidDbMigrated: false
	}
	return proto.ClientPayload.fromObject(payload)
}

const getPlatformType = (platform: string): proto.DeviceProps.PlatformType => {
	const platformType = platform.toUpperCase()
	return (
		proto.DeviceProps.PlatformType[platformType as keyof typeof proto.DeviceProps.PlatformType] ||
		proto.DeviceProps.PlatformType.CHROME
	)
}

/**
 * Parse a browser OS-version string (`config.browser[2]`, e.g. "15.6.1") into the
 * `DeviceProps.version` {primary, secondary, tertiary} sent at companion
 * registration. This used to be HARDCODED to macOS 10.15.7 (Catalina, 2019)
 * regardless of `config`, which made every pairing present a 6-year-old OS — a
 * stale, non-human tell. Deriving it from `config.browser[2]` lets the caller
 * present a current OS (and makes the stock `Browsers.macOS` default's "14.4.1"
 * flow through). Falls back to 10.15.7 only when no usable version is supplied.
 */
export const parseOsVersion = (
	v: string | undefined
): { primary: number, secondary: number, tertiary: number } => {
	const parts = (v ?? '').split('.').map(n => parseInt(n, 10))
	const at = (i: number): number => {
		const n = parts[i]
		return typeof n === 'number' && Number.isFinite(n) ? n : 0
	}
	if(!Number.isFinite(parts[0])) {
		return { primary: 10, secondary: 15, tertiary: 7 }
	}
	return { primary: at(0), secondary: at(1), tertiary: at(2) }
}

export const generateRegistrationNode = (
	{ registrationId, signedPreKey, signedIdentityKey }: SignalCreds,
	config: SocketConfig
) => {
	// the app version needs to be md5 hashed
	// and passed in
	const appVersionBuf = createHash('md5')
		.update(config.version.join('.')) // join as string
		.digest()

	const companion: proto.IDeviceProps = {
		os: config.browser[0],
		platformType: getPlatformType(config.browser[1]),
		requireFullSync: config.syncFullHistory,
		historySyncConfig: {
			storageQuotaMb: 10240,
			inlineInitialPayloadInE2EeMsg: true,
			recentSyncDaysLimit: undefined,
			supportCallLogHistory: false,
			supportBotUserAgentChatHistory: true,
			supportCagReactionsAndPolls: true,
			supportBizHostedMsg: true,
			supportRecentSyncChunkMessageCountTuning: true,
			supportHostedGroupMsg: true,
			supportFbidBotChatHistory: true,
			supportAddOnHistorySyncMigration: undefined,
			supportMessageAssociation: true,
			supportGroupHistory: false,
			onDemandReady: undefined,
			supportGuestChat: undefined
		},
		version: parseOsVersion(config.browser[2])
	}

	const companionProto = proto.DeviceProps.encode(companion).finish()

	const registerPayload: proto.IClientPayload = {
		...getClientPayload(config),
		passive: false,
		pull: false,
		devicePairingData: {
			buildHash: appVersionBuf,
			deviceProps: companionProto,
			eRegid: encodeBigEndian(registrationId),
			eKeytype: KEY_BUNDLE_TYPE,
			eIdent: signedIdentityKey.public,
			eSkeyId: encodeBigEndian(signedPreKey.keyId, 3),
			eSkeyVal: signedPreKey.keyPair.public,
			eSkeySig: signedPreKey.signature
		}
	}

	return proto.ClientPayload.fromObject(registerPayload)
}

export const configureSuccessfulPairing = (
	stanza: BinaryNode,
	{
		advSecretKey,
		signedIdentityKey,
		signalIdentities
	}: Pick<AuthenticationCreds, 'advSecretKey' | 'signedIdentityKey' | 'signalIdentities'>
) => {
	const msgId = stanza.attrs.id

	const pairSuccessNode = getBinaryNodeChild(stanza, 'pair-success')

	const deviceIdentityNode = getBinaryNodeChild(pairSuccessNode, 'device-identity')
	const platformNode = getBinaryNodeChild(pairSuccessNode, 'platform')
	const deviceNode = getBinaryNodeChild(pairSuccessNode, 'device')
	const businessNode = getBinaryNodeChild(pairSuccessNode, 'biz')

	if (!deviceIdentityNode || !deviceNode) {
		throw new Boom('Missing device-identity or device in pair success node', { data: stanza })
	}

	const bizName = businessNode?.attrs.name
	const jid = deviceNode.attrs.jid
	const lid = deviceNode.attrs.lid

	const { details, hmac, accountType } = proto.ADVSignedDeviceIdentityHMAC.decode(deviceIdentityNode.content as Buffer)

	let hmacPrefix = Buffer.from([])
	if (accountType !== undefined && accountType === proto.ADVEncryptionType.HOSTED) {
		hmacPrefix = WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
	}

	const advSign = hmacSign(Buffer.concat([hmacPrefix, details!]), Buffer.from(advSecretKey, 'base64'))
	if (Buffer.compare(hmac!, advSign) !== 0) {
		throw new Boom('Invalid account signature')
	}

	const account = proto.ADVSignedDeviceIdentity.decode(details!)
	const { accountSignatureKey, accountSignature, details: deviceDetails } = account

	const deviceIdentity = proto.ADVDeviceIdentity.decode(deviceDetails!)

	const accountSignaturePrefix =
		deviceIdentity.deviceType === proto.ADVEncryptionType.HOSTED
			? WA_ADV_HOSTED_ACCOUNT_SIG_PREFIX
			: WA_ADV_ACCOUNT_SIG_PREFIX
	const accountMsg = Buffer.concat([accountSignaturePrefix, deviceDetails!, signedIdentityKey.public])
	if (!Curve.verify(accountSignatureKey!, accountMsg, accountSignature!)) {
		throw new Boom('Failed to verify account signature')
	}

	const deviceMsg = Buffer.concat([
		WA_ADV_DEVICE_SIG_PREFIX,
		deviceDetails!,
		signedIdentityKey.public,
		accountSignatureKey!
	])
	account.deviceSignature = Curve.sign(signedIdentityKey.private, deviceMsg)

	const identity = createSignalIdentity(lid!, accountSignatureKey!)
	const accountEnc = encodeSignedDeviceIdentity(account, false)

	const reply: BinaryNode = {
		tag: 'iq',
		attrs: {
			to: S_WHATSAPP_NET,
			type: 'result',
			id: msgId!
		},
		content: [
			{
				tag: 'pair-device-sign',
				attrs: {},
				content: [
					{
						tag: 'device-identity',
						attrs: { 'key-index': deviceIdentity.keyIndex!.toString() },
						content: accountEnc
					}
				]
			}
		]
	}

	const authUpdate: Partial<AuthenticationCreds> = {
		account,
		me: { id: jid!, name: bizName, lid },
		signalIdentities: [...(signalIdentities || []), identity],
		platform: platformNode?.attrs.name,
		// QR pairing completes HERE — mark the device registered so the connect-node selector
		// (`if (!creds.me || !creds.registered)`) takes the LOGIN branch on the post-pair 515
		// reconnect instead of re-registering an already-linked device (which loops back to QR).
		// Symmetric with the link-code path, which sets `creds.registered = true` at companion_finish
		// (Socket/messages-recv). Without this, the registration-gate fix broke QR pairing entirely.
		registered: true
	}

	return {
		creds: authUpdate,
		reply
	}
}

export const encodeSignedDeviceIdentity = (account: proto.IADVSignedDeviceIdentity, includeSignatureKey: boolean) => {
	account = { ...account }
	// set to null if we are not to include the signature key
	// or if we are including the signature key but it is empty
	if (!includeSignatureKey || !account.accountSignatureKey?.length) {
		account.accountSignatureKey = null
	}

	return proto.ADVSignedDeviceIdentity.encode(account).finish()
}
