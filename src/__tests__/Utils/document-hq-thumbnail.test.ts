import { describe, expect, it, jest } from '@jest/globals'
import { createDecipheriv, createHash, createHmac } from 'crypto'
import { readFileSync } from 'fs'
import { MEDIA_HKDF_KEY_MAPPING, MEDIA_PATH_MAP, type MediaType } from '../../Defaults'
import type { WAMediaUploadFunction } from '../../Types'
import { hkdf } from '../../Utils/crypto'
import { prepareWAMessageMedia } from '../../Utils/messages'
import { getMediaKeys } from '../../Utils/messages-media'

type UploadCall = { mediaType: MediaType; fileEncSha256B64: string; enc: Buffer }

/** Upload stub that keeps each uploaded (encrypted) file's bytes, read before prepareWAMessageMedia unlinks it. */
const makeUpload = (failFor?: MediaType) => {
	const calls: UploadCall[] = []
	const upload = jest.fn(async (filePath: string, opts: { fileEncSha256B64: string; mediaType: MediaType }) => {
		calls.push({ mediaType: opts.mediaType, fileEncSha256B64: opts.fileEncSha256B64, enc: readFileSync(filePath) })
		if (opts.mediaType === failFor) {
			throw new Error('upload refused')
		}

		return { mediaUrl: `https://mmg.whatsapp.net/${opts.mediaType}`, directPath: `/v/${opts.mediaType}/x` }
	})
	return { calls, upload: upload as unknown as WAMediaUploadFunction }
}

/** Decrypts a WA media blob (ciphertext || 10-byte mac) the way a receiver does, verifying the mac. */
const decrypt = async (enc: Buffer, mediaKey: Uint8Array, mediaType: MediaType) => {
	const { iv, cipherKey, macKey } = await getMediaKeys(mediaKey, mediaType)
	const body = enc.subarray(0, enc.length - 10)
	const mac = createHmac('sha256', macKey!).update(iv).update(body).digest().subarray(0, 10)
	if (!mac.equals(enc.subarray(enc.length - 10))) {
		throw new Error('mac mismatch')
	}

	const d = createDecipheriv('aes-256-cbc', cipherKey, iv)
	return Buffer.concat([d.update(body), d.final()])
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest()

const PDF = Buffer.from('%PDF-1.4 fake document bytes for the test')
const HQ_JPEG = Buffer.from('fake-480px-jpeg-preview-bytes')

describe('document HQ thumbnail (WA Web thumbnail-document parity)', () => {
	it('uses the WA Web upload path and HKDF info for thumbnail-document', async () => {
		expect(MEDIA_PATH_MAP['thumbnail-document']).toBe('/mms/thumbnail-document')
		expect(`WhatsApp ${MEDIA_HKDF_KEY_MAPPING['thumbnail-document']} Keys`).toBe('WhatsApp Document Thumbnail Keys')
		const key = Buffer.alloc(32, 7)
		const expected = hkdf(key, 112, { info: 'WhatsApp Document Thumbnail Keys' })
		const keys = await getMediaKeys(key, 'thumbnail-document')
		expect(Buffer.from(keys.iv)).toEqual(expected.subarray(0, 16))
		expect(Buffer.from(keys.cipherKey)).toEqual(expected.subarray(16, 48))
	})

	it("uploads the preview encrypted under the document's own mediaKey and points the proto at it", async () => {
		const { calls, upload } = makeUpload()
		const msg = await prepareWAMessageMedia(
			{
				document: PDF,
				mimetype: 'application/pdf',
				fileName: 'a.pdf',
				jpegThumbnail: Buffer.from('micro'),
				pageCount: 3,
				hqThumbnail: { jpeg: HQ_JPEG, width: 340, height: 480 }
			},
			{ upload }
		)
		const doc = msg.documentMessage!
		expect(calls.map(c => c.mediaType).sort()).toEqual(['document', 'thumbnail-document'])
		const thumbCall = calls.find(c => c.mediaType === 'thumbnail-document')!
		const docCall = calls.find(c => c.mediaType === 'document')!

		// a receiver holding only the documentMessage decrypts both blobs with its one mediaKey
		expect(await decrypt(thumbCall.enc, doc.mediaKey!, 'thumbnail-document')).toEqual(HQ_JPEG)
		expect(await decrypt(docCall.enc, doc.mediaKey!, 'document')).toEqual(PDF)
		// …and the thumbnail is NOT readable with the document's own keys (distinct HKDF info)
		await expect(decrypt(thumbCall.enc, doc.mediaKey!, 'document')).rejects.toThrow()

		expect(doc.thumbnailDirectPath).toBe('/v/thumbnail-document/x')
		expect(Buffer.from(doc.thumbnailSha256!)).toEqual(sha256(HQ_JPEG))
		expect(Buffer.from(doc.thumbnailEncSha256!)).toEqual(sha256(thumbCall.enc))
		expect(thumbCall.fileEncSha256B64).toBe(sha256(thumbCall.enc).toString('base64'))
		expect(doc.thumbnailWidth).toBe(340)
		expect(doc.thumbnailHeight).toBe(480)
		expect(Buffer.from(doc.jpegThumbnail!).toString()).toBe('micro')
		expect(doc.pageCount).toBe(3)
		expect(doc.directPath).toBe('/v/document/x')
	})

	it('a failed preview upload still sends the document, without HQ fields', async () => {
		const { upload } = makeUpload('thumbnail-document')
		const msg = await prepareWAMessageMedia(
			{
				document: PDF,
				mimetype: 'application/pdf',
				jpegThumbnail: Buffer.from('micro'),
				hqThumbnail: { jpeg: HQ_JPEG, width: 340, height: 480 }
			},
			{ upload }
		)
		const doc = msg.documentMessage!
		expect(doc.directPath).toBe('/v/document/x')
		expect(doc.thumbnailDirectPath).toBeFalsy()
		expect(doc.thumbnailSha256?.length ?? 0).toBe(0)
		expect(Buffer.from(doc.jpegThumbnail!).toString()).toBe('micro')
	})

	it('no hqThumbnail → a single upload, as before', async () => {
		const { calls, upload } = makeUpload()
		const msg = await prepareWAMessageMedia({ document: PDF, mimetype: 'application/pdf' }, { upload })
		expect(calls.map(c => c.mediaType)).toEqual(['document'])
		expect(msg.documentMessage!.thumbnailDirectPath).toBeFalsy()
	})
})
