import { fetchNewChatMessageCappingInfo } from '../../Socket/mex'
import type { BinaryNode } from '../../WABinary'

// WA Web 2026-10-12 (wa-web-bundles-202610120949.js):
//   b11@642474  WAWebMexFetchNewChatMessageCappingInfoJobQuery params.id = "27910975521856601"
//   b11@643207  WAWebMexFetchNewChatMessageCappingInfoJob variables {input:{type:"INDIVIDUAL_NEW_CHAT_THREAD"}}
// The fork shipped the previous capture's id (24503548349331633, rotated out) and a type value
// ("INDIVIDUAL_NEW_CHAT_MSG") that appears in neither capture.
describe('fetchNewChatMessageCappingInfo', () => {
	const capture = () => {
		const sent: BinaryNode[] = []
		const query = async (node: BinaryNode): Promise<BinaryNode> => {
			sent.push(node)
			const data = { data: { xwa2_message_capping_info: { total_quota: 50, used_quota: 3, capping_status: 'NONE' } } }
			return { tag: 'iq', attrs: { type: 'result' }, content: [{ tag: 'result', attrs: {}, content: Buffer.from(JSON.stringify(data)) }] }
		}
		return { sent, query }
	}

	it("sends WA Web's current query id and input type", async () => {
		const { sent, query } = capture()
		await fetchNewChatMessageCappingInfo(query, () => 'tag-1')

		expect(sent).toHaveLength(1)
		const q = (sent[0]!.content as BinaryNode[])[0]!
		expect(sent[0]!.attrs.xmlns).toBe('w:mex')
		expect(q.attrs.query_id).toBe('27910975521856601')
		expect(JSON.parse((q.content as Buffer).toString())).toEqual({
			variables: { input: { type: 'INDIVIDUAL_NEW_CHAT_THREAD' } }
		})
	})

	it('returns the xwa2_message_capping_info payload', async () => {
		const { query } = capture()
		const info = await fetchNewChatMessageCappingInfo(query, () => 'tag-1')
		expect(info).toEqual({ total_quota: 50, used_quota: 3, capping_status: 'NONE' })
	})
})
