import { proto } from '../../../WAProto/index.js'
import { buildHistorySyncOnDemandRequest, getPeerDataOperationStanzaAttrs } from '../../Utils/history'

const T = proto.Message.PeerDataOperationRequestType

describe('history-sync on-demand request parity (WA Web b07@784600/785634/655635)', () => {
	const key = { remoteJid: '123@s.whatsapp.net', fromMe: true, id: 'OLDEST' }

	it('proto roundtrips supportInlineResponse (field 7)', () => {
		const bytes = proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest.encode({
			chatJid: 'a',
			supportInlineResponse: true
		}).finish()
		const dec = proto.Message.PeerDataOperationRequestMessage.HistorySyncOnDemandRequest.decode(bytes)
		expect(dec.supportInlineResponse).toBe(true)
	})

	it('builds the WA Web request shape and never sets accountLid (WA Web does not populate it)', () => {
		const r = buildHistorySyncOnDemandRequest({ count: 50, oldestMsgKey: key, oldestMsgTimestamp: 1700000000000 })
		expect(r).toMatchObject({
			chatJid: key.remoteJid,
			oldestMsgId: 'OLDEST',
			oldestMsgFromMe: true,
			onDemandMsgCount: 50,
			oldestMsgTimestampMs: 1700000000000
		})
		expect(r.accountLid).toBeUndefined()
	})

	it('supportInlineResponse is OFF by default (inline responses are not handled by process-message) and opt-in', () => {
		expect(
			buildHistorySyncOnDemandRequest({ count: 50, oldestMsgKey: key, oldestMsgTimestamp: 1 }).supportInlineResponse
		).toBeUndefined()
		expect(
			buildHistorySyncOnDemandRequest({
				count: 50,
				oldestMsgKey: key,
				oldestMsgTimestamp: 1,
				supportInlineResponse: true
			}).supportInlineResponse
		).toBe(true)
	})

	it('stanza: HISTORY_SYNC_ON_DEMAND carries privacy_sensitive=1 (PrivacySensitiveType.OnDemand)', () => {
		expect(getPeerDataOperationStanzaAttrs(T.HISTORY_SYNC_ON_DEMAND)).toEqual({
			category: 'peer',
			push_priority: 'high_force',
			privacy_sensitive: '1'
		})
	})

	it('stanza: other peer-data ops do NOT carry privacy_sensitive', () => {
		expect(getPeerDataOperationStanzaAttrs(T.PLACEHOLDER_MESSAGE_RESEND)).toEqual({
			category: 'peer',
			push_priority: 'high_force'
		})
		expect(getPeerDataOperationStanzaAttrs(undefined)).toEqual({ category: 'peer', push_priority: 'high_force' })
	})
})
