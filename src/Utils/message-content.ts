import type { WAMessageContent } from '../Types'

// Leaf home for `normalizeMessageContent`. It is pure, but `Utils/messages.ts` (its old home)
// imports `fs`, `stream` and `messages-media` (jimp/sharp) at module scope, which the SendCore
// browser bundle cannot resolve. `messages.ts` re-exports it, so the `Utils` barrel is unchanged.

/**
 * Normalizes ephemeral, view once messages to regular message content
 * Eg. image messages in ephemeral messages, in view once messages etc.
 * @param content
 * @returns
 */
export const normalizeMessageContent = (content: WAMessageContent | null | undefined): WAMessageContent | undefined => {
	if (!content) {
		return undefined
	}

	// set max iterations to prevent an infinite loop
	for (let i = 0; i < MAX_UNWRAP_DEPTH; i++) {
		const inner = getFutureProofMessage(content)
		if (!inner) {
			break
		}

		content = inner.message
	}

	return content!
}

const MAX_UNWRAP_DEPTH = 5

/** the wrapper (ephemeral, view once, ...) of `message`, when it is one; `normalizeMessageContent` peels these */
export const getFutureProofMessage = (message: WAMessageContent | null | undefined) =>
	message?.ephemeralMessage ||
	message?.viewOnceMessage ||
	message?.documentWithCaptionMessage ||
	message?.viewOnceMessageV2 ||
	message?.viewOnceMessageV2Extension ||
	message?.editedMessage ||
	message?.associatedChildMessage ||
	message?.groupStatusMessage ||
	message?.groupStatusMessageV2

/** the unwrap depth bound shared with `normalizeMessageContent` */
export const UNWRAP_DEPTH = MAX_UNWRAP_DEPTH
