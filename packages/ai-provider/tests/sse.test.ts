import { describe, expect, it } from 'vitest'
import { readSseStream } from '../src/sse'

const encoder = new TextEncoder()

describe('shared SSE reader', () => {
  it.each([
    { lineEnding: 'LF', firstChunk: 'data: first\n', secondChunk: '\n' },
    { lineEnding: 'CRLF', firstChunk: 'data: first\r\n\r', secondChunk: '\n' },
  ])(
    'delivers $lineEnding events before the stream closes when the separator is split',
    async ({ firstChunk, secondChunk }) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>
      const body = new ReadableStream<Uint8Array>({
        start(streamController) {
          controller = streamController
        },
      })
      const received: string[] = []
      let resolveReceived!: () => void
      const firstReceived = new Promise<void>((resolve) => {
        resolveReceived = resolve
      })
      const reading = readSseStream(new Response(body), (data) => {
        received.push(data)
        resolveReceived()
      })

      try {
        controller.enqueue(encoder.encode(firstChunk))
        controller.enqueue(encoder.encode(secondChunk))
        let timeout: ReturnType<typeof setTimeout> | undefined
        const deliveredBeforeClose = await Promise.race([
          firstReceived.then(() => true),
          new Promise<boolean>((resolve) => {
            timeout = setTimeout(() => resolve(false), 100)
          }),
        ])
        if (timeout) clearTimeout(timeout)

        expect(deliveredBeforeClose).toBe(true)
        expect(received).toEqual(['first'])
      } finally {
        controller.close()
        await reading
      }
    },
  )

  it.each(['\n', '\r\n'])(
    'delivers a trailing event at EOF with %j line endings',
    async (lineEnding) => {
      const received: string[] = []
      const body = `data: complete${lineEnding}${lineEnding}data: trailing${lineEnding}`

      await readSseStream(new Response(body), (data) => received.push(data))

      expect(received).toEqual(['complete', 'trailing'])
    },
  )
})
