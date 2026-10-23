import { describe, expect, it, jest } from '@jest/globals'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { Jimp } from 'jimp'
import { tmpdir } from 'os'
import { join } from 'path'
import { generateThumbnail, IMG_THUMB_MAX_EDGE } from '../../Utils/messages-media'

const hasFfmpeg = (() => {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
		return true
	} catch {
		return false
	}
})()

const withDir = async (fn: (dir: string) => Promise<void>) => {
	const dir = mkdtempSync(join(tmpdir(), 'video-thumb-'))
	try {
		await fn(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

describe('video jpegThumbnail (WA Web: first frame, longest edge 100)', () => {
	jest.setTimeout(30_000)

	// needs ffmpeg on PATH (the backend image installs it); skipped where it is absent
	;(hasFfmpeg ? it : it.skip)('a 640×360 video gets a 100×56 JPEG of its first frame (was 32px wide)', async () => {
		await withDir(async dir => {
			const video = join(dir, 'in.mp4')
			// first frame red, then blue: the thumbnail must be the first frame
			execFileSync(
				'ffmpeg',
				[
					'-f',
					'lavfi',
					'-i',
					'color=c=red:s=640x360:d=0.5',
					'-f',
					'lavfi',
					'-i',
					'color=c=blue:s=640x360:d=0.5',
					'-filter_complex',
					'[0:v][1:v]concat=n=2:v=1[v]',
					'-map',
					'[v]',
					'-pix_fmt',
					'yuv420p',
					'-y',
					video
				],
				{ stdio: 'ignore' }
			)
			const { thumbnail } = await generateThumbnail(video, 'video', {})
			expect(thumbnail).toBeDefined()
			const img = await Jimp.read(Buffer.from(thumbnail!, 'base64'))
			expect(Math.max(img.width, img.height)).toBe(IMG_THUMB_MAX_EDGE)
			expect(img.height).toBe(56)
			const at = (50 + 28 * img.width) * 4
			const [r, g, b] = [img.bitmap.data[at]!, img.bitmap.data[at + 1]!, img.bitmap.data[at + 2]!]
			expect(r).toBeGreaterThan(200)
			expect(g + b).toBeLessThan(80)
		})
	})

	it('a broken video → no thumbnail, no throw (the send still goes out)', async () => {
		await withDir(async dir => {
			const video = join(dir, 'broken.mp4')
			writeFileSync(video, Buffer.from('not a video'))
			await expect(generateThumbnail(video, 'video', {})).resolves.toEqual({
				thumbnail: undefined,
				originalImageDimensions: undefined
			})
		})
	})

	it('a path with shell metacharacters is passed as one argument, not run', async () => {
		await withDir(async dir => {
			// a shell would run `touch <marker>` in the process cwd
			const marker = `pwned-${process.pid}-${Date.now()}`
			const video = join(dir, `x; touch ${marker}; .mp4`)
			writeFileSync(video, Buffer.from('not a video'))
			await generateThumbnail(video, 'video', {})
			const touched = existsSync(marker)
			rmSync(marker, { force: true })
			expect(touched).toBe(false)
		})
	})
})
