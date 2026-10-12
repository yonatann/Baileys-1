import { Boom } from '@hapi/boom'
import { QueryIds, XWAPaths } from '../Types/Mex.js'
import type { NewChatMessageCapInfo } from '../Types/State.js'
import type { BinaryNode } from '../WABinary'
import { getBinaryNodeChild, S_WHATSAPP_NET } from '../WABinary'

const wMexQuery = (
	variables: Record<string, unknown>,
	queryId: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) => {
	return query({
		tag: 'iq',
		attrs: {
			id: generateMessageTag(),
			type: 'get',
			to: S_WHATSAPP_NET,
			xmlns: 'w:mex'
		},
		content: [
			{
				tag: 'query',
				attrs: { query_id: queryId },
				content: Buffer.from(JSON.stringify({ variables }), 'utf-8')
			}
		]
	})
}

export const executeWMexQuery = async <T>(
	variables: Record<string, unknown>,
	queryId: string,
	dataPath: string,
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
): Promise<T> => {
	const result = await wMexQuery(variables, queryId, query, generateMessageTag)
	const child = getBinaryNodeChild(result, 'result')
	if (child?.content) {
		const data = JSON.parse(child.content.toString())

		if (data.errors && data.errors.length > 0) {
			const errorMessages = data.errors.map((err: Error) => err.message || 'Unknown error').join(', ')
			const firstError = data.errors[0]
			const errorCode = firstError.extensions?.error_code || 400
			throw new Boom(`GraphQL server error: ${errorMessages}`, { statusCode: errorCode, data: firstError })
		}

		const response = dataPath ? data?.data?.[dataPath] : data?.data
		if (typeof response !== 'undefined') {
			return response as T
		}
	}

	const action = (dataPath || '').startsWith('xwa2_')
		? dataPath.substring(5).replace(/_/g, ' ')
		: dataPath?.replace(/_/g, ' ')
	throw new Boom(`Failed to ${action}, unexpected response structure.`, { statusCode: 400, data: result })
}

/**
 * The `input.type` WA Web sends for the new-chat capping query
 * (wa-web-bundles-202610120949.js b11@643207, WAWebMexFetchNewChatMessageCappingInfoJob).
 */
export const NEW_CHAT_MESSAGE_CAPPING_TYPE = 'INDIVIDUAL_NEW_CHAT_THREAD'

/** Fetches the account's new-chat message quota (WAWebMexFetchNewChatMessageCappingInfoJobQuery). */
export const fetchNewChatMessageCappingInfo = (
	query: (node: BinaryNode) => Promise<BinaryNode>,
	generateMessageTag: () => string
) =>
	executeWMexQuery<NewChatMessageCapInfo>(
		{ input: { type: NEW_CHAT_MESSAGE_CAPPING_TYPE } },
		QueryIds.MESSAGE_CAPPING_INFO,
		XWAPaths.xwa2_message_capping_info,
		query,
		generateMessageTag
	)
