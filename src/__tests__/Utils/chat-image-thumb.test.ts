import { describe, expect, it, jest } from '@jest/globals'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { Jimp } from 'jimp'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WAMediaUploadFunction } from '../../Types'
import { prepareWAMessageMedia } from '../../Utils/messages'
import { extractChatImageThumb, IMG_THUMB_MAX_BYTES, IMG_THUMB_MAX_EDGE } from '../../Utils/messages-media'

/** A noisy RGB image, so the JPEG is not trivially small. */
const imageFile = async (width: number, height: number) => {
	const img = new Jimp({ width, height, color: 0xffffffff })
	let x = 12345
	for (let i = 0; i < img.bitmap.data.length; i++) {
		x = (x * 1103515245 + 12345) & 0x7fffffff
		img.bitmap.data[i] = i % 4 === 3 ? 255 : x >> 16
	}

	const dir = mkdtempSync(join(tmpdir(), 'chat-thumb-'))
	const file = join(dir, 'in.jpg')
	writeFileSync(file, await img.getBuffer('image/jpeg', { quality: 90 }))
	return { file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const sizeOf = async (jpeg: Buffer) => {
	const img = await Jimp.read(jpeg)
	return { width: img.width, height: img.height }
}

describe('chat image jpegThumbnail (WA Web WAWebMediaDataUtils parity)', () => {
	jest.setTimeout(30_000)

	it('WA Web constants: longest edge 100, 20 000 byte budget', () => {
		expect(IMG_THUMB_MAX_EDGE).toBe(100)
		expect(IMG_THUMB_MAX_BYTES).toBe(20000)
	})

	it('scales the LONGEST edge to 100, aspect kept (portrait and landscape)', async () => {
		for (const [w, h, expected] of [
			[400, 800, { width: 50, height: 100 }],
			[1200, 600, { width: 100, height: 50 }]
		] as const) {
			const { file, cleanup } = await imageFile(w, h)
			try {
				const { buffer, original } = await extractChatImageThumb(file)
				expect(await sizeOf(buffer)).toEqual(expected)
				expect(original).toEqual({ width: w, height: h })
				expect(buffer.length).toBeLessThanOrEqual(IMG_THUMB_MAX_BYTES)
			} finally {
				cleanup()
			}
		}
	})

	it('never upscales a small image', async () => {
		const { file, cleanup } = await imageFile(40, 30)
		try {
			expect(await sizeOf((await extractChatImageThumb(file)).buffer)).toEqual({ width: 40, height: 30 })
		} finally {
			cleanup()
		}
	})

	it('prepareWAMessageMedia puts the 100px thumbnail on the imageMessage (was 32px wide, q50)', async () => {
		const { file, cleanup } = await imageFile(600, 900)
		try {
			const upload = (async () => ({
				mediaUrl: 'https://mmg.whatsapp.net/x',
				directPath: '/v/x'
			})) as WAMediaUploadFunction
			const msg = await prepareWAMessageMedia({ image: { url: file } }, { upload })
			const thumb = Buffer.from(msg.imageMessage!.jpegThumbnail!)
			expect(await sizeOf(thumb)).toEqual({ width: 67, height: 100 })
			expect(msg.imageMessage!.width).toBe(600)
			expect(msg.imageMessage!.height).toBe(900)
		} finally {
			cleanup()
		}
	})
})
