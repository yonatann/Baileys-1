import { proto } from '../../WAProto/index.js';
import type { AuthenticationCreds, SignalCreds, SocketConfig } from '../Types/index.js';
import { type BinaryNode } from '../WABinary/index.js';
export declare const generateLoginNode: (userJid: string, config: SocketConfig) => proto.IClientPayload;
/**
 * Parse a browser OS-version string (`config.browser[2]`, e.g. "15.6.1") into the
 * `DeviceProps.version` {primary, secondary, tertiary} sent at companion
 * registration. This used to be HARDCODED to macOS 10.15.7 (Catalina, 2019)
 * regardless of `config`, which made every pairing present a 6-year-old OS — a
 * stale, non-human tell. Deriving it from `config.browser[2]` lets the caller
 * present a current OS (and makes the stock `Browsers.macOS` default's "14.4.1"
 * flow through). Falls back to 10.15.7 only when no usable version is supplied.
 */
export declare const parseOsVersion: (v: string | undefined) => {
    primary: number;
    secondary: number;
    tertiary: number;
};
export declare const generateRegistrationNode: ({ registrationId, signedPreKey, signedIdentityKey }: SignalCreds, config: SocketConfig) => proto.ClientPayload;
export declare const configureSuccessfulPairing: (stanza: BinaryNode, { advSecretKey, signedIdentityKey, signalIdentities }: Pick<AuthenticationCreds, "advSecretKey" | "signedIdentityKey" | "signalIdentities">) => {
    creds: Partial<AuthenticationCreds>;
    reply: BinaryNode;
};
export declare const encodeSignedDeviceIdentity: (account: proto.IADVSignedDeviceIdentity, includeSignatureKey: boolean) => Uint8Array<ArrayBufferLike>;
//# sourceMappingURL=validate-connection.d.ts.map