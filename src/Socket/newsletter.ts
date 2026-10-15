import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload } from '../Types'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateMessageIDV2 } from '../Utils/generics'
import { generateProfilePicture } from '../Utils/messages-media'
import { type BinaryNode, getBinaryNodeChild } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse | null | undefined): NewsletterMetadata => {
	if (!response) {
		throw new Error('newsletterCreate: server returned an empty response')
	}

	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	return {
		id: id,
		owner: undefined,
		name: thread?.name?.text,
		creation_time: thread?.creation_time ? parseInt(thread.creation_time, 10) : undefined,
		description: thread?.description?.text,
		invite: thread?.invite,
		subscribers: thread?.subscribers_count ? parseInt(thread.subscribers_count, 10) : undefined,
		verification: thread?.verification,
		// A freshly-created newsletter has no picture set: the server returns
		// `thread.picture: null`. Guard against the null so the parse doesn't
		// throw `Cannot read properties of null (reading 'id')` on every
		// successful create.
		picture: thread?.picture ? { id: thread.picture.id, directPath: thread.picture.direct_path } : undefined,
		mute_state: viewer?.mute
	}
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	if (typeof result !== 'object' || result === null) {
		return null
	}

	if ('id' in result && typeof result.id === 'string') {
		return result as NewsletterMetadata
	}

	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
		return result.result as NewsletterMetadata
	}

	return null
}

/**
 * Channel history request: `<iq to=s.whatsapp.net xmlns=newsletter type=get><messages type=jid jid=.. count=..[ since=..][ after=..]/></iq>`.
 * Verified live 2026-10-15; WA Web's own request mixin is `<messages count=..>` under the channel jid.
 */
export const buildNewsletterFetchMessagesNode = (
	id: string,
	jid: string,
	count: number,
	since?: number,
	after?: number
): BinaryNode => {
	const attrs: BinaryNode['attrs'] = { type: 'jid', jid, count: count.toString() }
	if (typeof since === 'number') {
		attrs.since = since.toString()
	}

	if (after) {
		attrs.after = after.toString()
	}

	return {
		tag: 'iq',
		attrs: { id, type: 'get', xmlns: 'newsletter', to: 's.whatsapp.net' },
		content: [{ tag: 'messages', attrs }]
	}
}

export const buildNewsletterFetchMessageUpdatesNode = (
	id: string,
	jid: string,
	count: number,
	since?: number,
	after?: number
): BinaryNode => {
	const attrs: BinaryNode['attrs'] = { count: count.toString() }
	if (typeof since === 'number') {
		attrs.since = since.toString()
	}

	if (after) {
		attrs.after = after.toString()
	}

	return {
		tag: 'iq',
		attrs: { id, type: 'get', xmlns: 'newsletter', to: jid },
		content: [{ tag: 'message_updates', attrs }]
	}
}

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}

	return {
		...sock,
		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
				variables,
				QueryIds.CREATE,
				XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			return executeWMexQuery<{ subscribers: number }>(
				{ newsletter_id: jid },
				QueryIds.SUBSCRIBERS,
				XWAPaths.xwa2_newsletter_subscribers
			)
		},

		newsletterMetadata: async (type: 'invite' | 'jid', key: string) => {
			const variables = {
				fetch_creation_time: true,
				fetch_full_image: true,
				fetch_viewer_metadata: true,
				input: {
					key,
					type: type.toUpperCase()
				}
			}
			const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return parseNewsletterMetadata(result)
		},

		newsletterFollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_join_v2)
		},

		newsletterUnfollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_leave_v2)
		},

		newsletterMute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			return await newsletterUpdate(jid, { name })
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			return await newsletterUpdate(jid, { description })
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},

		newsletterRemovePicture: async (jid: string) => {
			return await newsletterUpdate(jid, { picture: '' })
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					// WA Web uses a message id here (3EB0...), not an iq tag
					id: generateMessageIDV2(sock.authState.creds.me?.id)
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},

		/**
		 * Channel history (see `buildNewsletterFetchMessagesNode`: the old `<message_updates>`
		 * shape addressed to the channel jid is never answered, 60s timeout).
		 */
		newsletterFetchMessages: async (jid: string, count: number, since?: number, after?: number) =>
			query(buildNewsletterFetchMessagesNode(generateMessageTag(), jid, count, since, after)),

		/** Per-message updates (reaction counts, views) for a channel: the old `<message_updates>` shape, kept as-is. */
		newsletterFetchMessageUpdates: async (jid: string, count: number, since?: number, after?: number) =>
			query(buildNewsletterFetchMessageUpdatesNode(generateMessageTag(), jid, count, since, after)),

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			const response = await executeWMexQuery<{ admin_count: number }>(
				{ newsletter_id: jid },
				QueryIds.ADMIN_COUNT,
				XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				QueryIds.CHANGE_OWNER,
				XWAPaths.xwa2_newsletter_change_owner
			)
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			await executeWMexQuery({ newsletter_id: jid, user_id: userJid }, QueryIds.DEMOTE, XWAPaths.xwa2_newsletter_demote)
		},

		newsletterDelete: async (jid: string) => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>
