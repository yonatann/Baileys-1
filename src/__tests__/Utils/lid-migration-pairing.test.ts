import { randomBytes } from 'crypto'
import { proto } from '../../../WAProto/index.js'
import { WA_ADV_ACCOUNT_SIG_PREFIX } from '../../Defaults'
import type { BinaryNode } from '../../WABinary'
import { initAuthCreds } from '../../Utils/auth-utils'
import { Curve, hmacSign } from '../../Utils/crypto'
import { getPairingLidMigrationUpdate, isAccountLidMigrated, parseClientPairingProps } from '../../Utils/lid-migration'
import { configureSuccessfulPairing } from '../../Utils/validate-connection'

const propsBytes = (p: proto.IClientPairingProps) => Buffer.from(proto.ClientPairingProps.encode(p).finish())

const pairSuccessStanza = (clientProps?: Buffer, identity?: ReturnType<typeof buildIdentity>): BinaryNode => {
	const id = identity ?? buildIdentity()
	const children: BinaryNode[] = [
		{ tag: 'device-identity', attrs: {}, content: id.deviceIdentityBytes },
		{ tag: 'device', attrs: { jid: '123:1@s.whatsapp.net', lid: '999:1@lid' } },
		{ tag: 'platform', attrs: { name: 'web' } }
	]
	if (clientProps) {
		children.push({ tag: 'client-props', attrs: {}, content: clientProps })
	}
	return {
		tag: 'iq',
		attrs: { id: 'pair-1', from: 's.whatsapp.net', type: 'set' },
		content: [{ tag: 'pair-success', attrs: {}, content: children }]
	}
}

// Builds a cryptographically valid device-identity so configureSuccessfulPairing runs end to end.
function buildIdentity() {
	const advSecretKey = randomBytes(32).toString('base64')
	const signedIdentityKey = Curve.generateKeyPair()
	const accountKey = Curve.generateKeyPair()
	const deviceDetails = Buffer.from(proto.ADVDeviceIdentity.encode({ rawId: 1, timestamp: 1, keyIndex: 1 }).finish())
	const accountSignature = Curve.sign(
		accountKey.private,
		Buffer.concat([WA_ADV_ACCOUNT_SIG_PREFIX, deviceDetails, signedIdentityKey.public])
	)
	const details = Buffer.from(
		proto.ADVSignedDeviceIdentity.encode({
			details: deviceDetails,
			accountSignatureKey: accountKey.public,
			accountSignature
		}).finish()
	)
	const hmac = hmacSign(details, Buffer.from(advSecretKey, 'base64'))
	const deviceIdentityBytes = Buffer.from(proto.ADVSignedDeviceIdentityHMAC.encode({ details, hmac }).finish())
	return { advSecretKey, signedIdentityKey, deviceIdentityBytes }
}

describe('WA Web parity FR1: pair-success ClientPairingProps.isChatDbLidMigrated', () => {
	describe('parseClientPairingProps (client-props child of pair-success)', () => {
		it('decodes isChatDbLidMigrated and isSyncdPureLidSession from the client-props bytes', () => {
			const stanza = pairSuccessStanza(propsBytes({ isChatDbLidMigrated: true, isSyncdPureLidSession: true }))
			expect(parseClientPairingProps(stanza)).toMatchObject({
				isChatDbLidMigrated: true,
				isSyncdPureLidSession: true
			})
		})

		it('returns undefined when the client-props child is absent', () => {
			expect(parseClientPairingProps(pairSuccessStanza())).toBeUndefined()
		})
	})

	describe('getPairingLidMigrationUpdate', () => {
		it('isChatDbLidMigrated === true persists the flag and the parsed pure-LID value', () => {
			expect(getPairingLidMigrationUpdate({ isChatDbLidMigrated: true, isSyncdPureLidSession: false })).toStrictEqual({
				isChatDbLidMigrated: true,
				isSyncdPureLidSession: false
			})
		})

		it('isChatDbLidMigrated === true with no pure-LID value persists only the flag (pureLid kept absent)', () => {
			const update = getPairingLidMigrationUpdate({ isChatDbLidMigrated: true })
			expect(update).toStrictEqual({ isChatDbLidMigrated: true })
			expect('isSyncdPureLidSession' in update).toBe(false)
		})

		it('isChatDbLidMigrated false does NOT persist anything (no flip to false, no logout path)', () => {
			expect(getPairingLidMigrationUpdate({ isChatDbLidMigrated: false, isSyncdPureLidSession: true })).toStrictEqual(
				{}
			)
		})

		it('isChatDbLidMigrated absent (not true) persists nothing', () => {
			expect(getPairingLidMigrationUpdate({})).toStrictEqual({})
		})

		it('props absent is a no-op', () => {
			expect(getPairingLidMigrationUpdate(undefined)).toStrictEqual({})
		})
	})

	describe('creds default and gating getter', () => {
		it('a new session has no migration fields (unmigrated, byte-identical creds for every other field)', () => {
			const creds = initAuthCreds()
			expect('isChatDbLidMigrated' in creds).toBe(false)
			expect('isSyncdPureLidSession' in creds).toBe(false)
			expect(isAccountLidMigrated(creds)).toBe(false)
		})

		it('isAccountLidMigrated is true only for the boolean true', () => {
			expect(isAccountLidMigrated({ isChatDbLidMigrated: true })).toBe(true)
			expect(isAccountLidMigrated({ isChatDbLidMigrated: false })).toBe(false)
			expect(isAccountLidMigrated({ isChatDbLidMigrated: undefined })).toBe(false)
			expect(isAccountLidMigrated({ isChatDbLidMigrated: 'true' as unknown as boolean })).toBe(false)
		})
	})

	describe('configureSuccessfulPairing end to end', () => {
		it('persists the migration flag from client-props when isChatDbLidMigrated is true', () => {
			const identity = buildIdentity()
			const stanza = pairSuccessStanza(propsBytes({ isChatDbLidMigrated: true, isSyncdPureLidSession: true }), identity)
			const { creds } = configureSuccessfulPairing(stanza, {
				advSecretKey: identity.advSecretKey,
				signedIdentityKey: identity.signedIdentityKey,
				signalIdentities: undefined
			})
			expect(creds).toMatchObject({ isChatDbLidMigrated: true, isSyncdPureLidSession: true, registered: true })
		})

		it('leaves the migration fields untouched when isChatDbLidMigrated is false (no logout, no flip)', () => {
			const identity = buildIdentity()
			const stanza = pairSuccessStanza(propsBytes({ isChatDbLidMigrated: false }), identity)
			const { creds } = configureSuccessfulPairing(stanza, {
				advSecretKey: identity.advSecretKey,
				signedIdentityKey: identity.signedIdentityKey,
				signalIdentities: undefined
			})
			expect('isChatDbLidMigrated' in creds).toBe(false)
			expect('isSyncdPureLidSession' in creds).toBe(false)
		})

		it('leaves the migration fields untouched when client-props is absent', () => {
			const identity = buildIdentity()
			const { creds } = configureSuccessfulPairing(pairSuccessStanza(undefined, identity), {
				advSecretKey: identity.advSecretKey,
				signedIdentityKey: identity.signedIdentityKey,
				signalIdentities: undefined
			})
			expect('isChatDbLidMigrated' in creds).toBe(false)
			expect('isSyncdPureLidSession' in creds).toBe(false)
		})
	})
})

describe('malformed client-props never throws (FR1 review: no connection end from the flag path)', () => {
	it('returns undefined for garbage bytes instead of throwing', () => {
		const stanza = {
			tag: 'iq',
			attrs: {},
			content: [
				{
					tag: 'pair-success',
					attrs: {},
					content: [{ tag: 'client-props', attrs: {}, content: new Uint8Array([0xff, 0xff, 0xff, 0x7f, 0x01]) }]
				}
			]
		} as unknown as BinaryNode
		expect(() => parseClientPairingProps(stanza)).not.toThrow()
		expect(parseClientPairingProps(stanza)).toBeUndefined()
	})
})
