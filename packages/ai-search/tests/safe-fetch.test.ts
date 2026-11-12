import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createServer as createHttpServer,
  type RequestOptions,
  type IncomingMessage,
} from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { readFileSync } from 'node:fs'
import { brotliCompressSync, deflateSync, gzipSync } from 'node:zlib'
import { webExtract, webSearch } from '../src/index'
import { safeFetch } from '../src/safe-fetch'

const network = vi.hoisted(() => ({
  answers: new Map<string, string[][]>(),
  lookups: [] as string[],
  selected: [] as string[],
  ca: '',
  searchPort: 0,
  stalled: new Set<string>(),
  failAddress: '',
}))

vi.mock('node:dns/promises', () => ({
  lookup: async (hostname: string) => {
    network.lookups.push(hostname)
    if (network.stalled.has(hostname)) return await new Promise<never>(() => {})
    const sequence = network.answers.get(hostname)
    if (!sequence?.length) throw new Error('DNS failed')
    const addresses = sequence.length > 1 ? sequence.shift()! : sequence[0]!
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
  },
}))

// Translate only the already-selected public address to a synthetic loopback server.
// DNS, the transport's lookup callback, URL hostname, TLS and HTTP are otherwise real.
vi.mock('node:http', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:http')>()
  return {
    ...original,
    request: (url: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      const pinned = options.lookup!
      return original.request(
        url,
        {
          ...options,
          lookup: (hostname, opts, done) => {
            pinned(hostname, opts, (error, address, family) => {
              if (error || typeof address !== 'string') return done(error, address, family)
              network.selected.push(address)
              if (address === network.failAddress)
                return done(new Error('synthetic connection failure'), '', 4)
              done(null, '127.0.0.1', 4)
            })
          },
        },
        callback,
      )
    },
  }
})
vi.mock('node:https', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:https')>()
  return {
    ...original,
    request: (url: URL, options: RequestOptions, callback: (r: IncomingMessage) => void) => {
      const pinned = options.lookup!
      return original.request(
        url,
        {
          ...options,
          ...(url.hostname === 'search.brave.com' ? { port: network.searchPort } : {}),
          ca: network.ca,
          lookup: (hostname, opts, done) => {
            pinned(hostname, opts, (error, address, family) => {
              if (error || typeof address !== 'string') return done(error, address, family)
              network.selected.push(address)
              if (address === network.failAddress)
                return done(new Error('synthetic connection failure'), '', 4)
              done(null, '127.0.0.1', 4)
            })
          },
        },
        callback,
      )
    },
  }
})

const cert = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url))
network.ca = cert.toString()
let hits: string[] = []
const handler: import('node:http').RequestListener = (req, res) => {
  hits.push(`${req.headers.host}${req.url}`)
  if (req.headers.host?.startsWith('search.brave.com')) {
    res.writeHead(302, { location: `http://127.0.0.1:${httpPort}/` }).end()
  } else if (req.url?.startsWith('/redirect/')) {
    res.writeHead(302, { location: decodeURIComponent(req.url.slice('/redirect/'.length)) }).end()
  } else if (req.url === '/loop') {
    res.writeHead(302, { location: '/loop' }).end()
  } else if (req.url === '/error') {
    res.writeHead(503, 'Unavailable').end()
  } else if (req.url === '/hang') {
    // Timeout test closes this request via the abort signal.
  } else if (req.url === '/large/plain') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    for (let i = 0; i < 6; i++) res.write(Buffer.alloc(1024 * 1024, 'a'))
    res.end()
  } else if (req.url?.startsWith('/large/')) {
    const encoding = req.url.slice('/large/'.length)
    const body = Buffer.alloc(10 * 1024 * 1024 + 1, 'a')
    const compressed =
      encoding === 'gzip'
        ? gzipSync(body)
        : encoding === 'deflate'
          ? deflateSync(body)
          : brotliCompressSync(body)
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': encoding })
    res.end(compressed)
  } else {
    const encoding = req.url === '/br' ? 'br' : req.url === '/deflate' ? 'deflate' : 'gzip'
    const body = '<title>Synthetic</title><p>safe content</p>'
    res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': encoding })
    res.end(
      encoding === 'br'
        ? brotliCompressSync(body)
        : encoding === 'deflate'
          ? deflateSync(body)
          : gzipSync(body),
    )
  }
}
const http = createHttpServer(handler)
const https = createHttpsServer({ cert, key }, handler)
let httpPort: number
let httpsPort: number

beforeAll(async () => {
  await Promise.all([
    new Promise<void>((r) => http.listen(0, '127.0.0.1', r)),
    new Promise<void>((r) => https.listen(0, '127.0.0.1', r)),
  ])
  httpPort = (http.address() as import('node:net').AddressInfo).port
  httpsPort = (https.address() as import('node:net').AddressInfo).port
  network.searchPort = httpsPort
})
afterAll(async () => {
  await Promise.all([
    new Promise<void>((r) => http.close(() => r())),
    new Promise<void>((r) => https.close(() => r())),
  ])
})
beforeEach(() => {
  hits = []
  network.answers.clear()
  network.stalled.clear()
  network.failAddress = ''
  network.lookups = []
  network.selected = []
})
const publicAnswer = ['93.184.216.34']
const allow = (host: string) => network.answers.set(host, [publicAnswer])
const url = (host: string, path = '/') => `http://${host}:${httpPort}${path}`
const redirect = (target: string) => `/redirect/${encodeURIComponent(target)}`

describe('connection-bound SSRF guard', () => {
  it('pins the validated address instead of resolving a rebinding hostname again', async () => {
    network.answers.set('safe.test', [publicAnswer, ['127.0.0.1']])
    const result = await webExtract(url('safe.test'))
    expect(result.content).toContain('safe content')
    expect(network.lookups).toEqual(['safe.test'])
    expect(network.selected).toEqual(publicAnswer)
    expect(hits).toEqual([`safe.test:${httpPort}/`])
  })

  it('tries another validated address after a connection failure without another DNS lookup', async () => {
    network.answers.set('safe.test', [['93.184.216.34', '8.8.8.8'], ['127.0.0.1']])
    network.failAddress = '93.184.216.34'
    expect((await webExtract(url('safe.test'))).content).toContain('safe content')
    expect(network.selected).toEqual(['93.184.216.34', '8.8.8.8'])
    expect(network.lookups).toEqual(['safe.test'])
    expect(hits).toHaveLength(1)
  })

  it('pins every redirect hop and rejects a rebinding target before connecting', async () => {
    allow('safe.test')
    network.answers.set('target.test', [['127.0.0.1']])
    const result = await webExtract(url('safe.test', redirect(url('target.test'))))
    expect(result.content).toBeUndefined()
    expect(hits).toHaveLength(1)
    expect(network.lookups).toEqual(['safe.test', 'target.test'])
  })

  it('follows safe redirects and retains the Host header on each hop', async () => {
    allow('safe.test')
    allow('target.test')
    network.answers.set('target.test', [publicAnswer, ['127.0.0.1']])
    expect((await webExtract(url('safe.test', redirect(url('target.test'))))).content).toContain(
      'safe content',
    )
    expect(hits[1]).toBe(`target.test:${httpPort}/`)
    expect(network.lookups).toEqual(['safe.test', 'target.test'])
  })

  it.each([
    ['literal private', 'http://127.0.0.1:9/'],
    ['mixed answers', 'http://mixed.test/'],
    ['failed DNS', 'http://missing.test/'],
  ])('rejects %s redirects', async (_name, target) => {
    allow('safe.test')
    network.answers.set('mixed.test', [['93.184.216.34', '127.0.0.1']])
    expect((await webExtract(url('safe.test', redirect(target)))).content).toBeUndefined()
    expect(hits).toHaveLength(1)
  })

  it('stops redirect loops and reports HTTP errors, then succeeds on retry', async () => {
    allow('safe.test')
    expect((await webExtract(url('safe.test', '/loop'))).excerpt).toContain('Too many redirects')
    expect(hits).toHaveLength(6)
    expect((await webExtract(url('safe.test', '/error'))).excerpt).toContain('HTTP 503')
    expect((await webExtract(url('safe.test'))).content).toContain('safe content')
  })

  it.each(['/br', '/deflate'])('decodes compressed response %s', async (path) => {
    allow('safe.test')
    expect((await webExtract(url('safe.test', path))).content).toContain('safe content')
  })

  it.each(['plain', 'gzip', 'deflate', 'br'])(
    'rejects an oversized %s response without returning content and recovers',
    async (encoding) => {
      allow('safe.test')
      const result = await webExtract(url('safe.test', `/large/${encoding}`))
      expect(result.content).toBeUndefined()
      expect(result.excerpt).toContain('Response exceeds size limit')
      expect((await webExtract(url('safe.test'))).content).toContain('safe content')
    },
  )

  it('does not open a socket after DNS times out, and retries successfully', async () => {
    network.stalled.add('safe.test')
    await expect(safeFetch(url('safe.test'), { headers: {}, timeout: 30 })).rejects.toThrow()
    expect(hits).toEqual([])
    network.stalled.clear()
    allow('safe.test')
    expect((await webExtract(url('safe.test'))).content).toContain('safe content')
  })

  it('checks the original HTTPS hostname against the certificate', async () => {
    allow('safe.test')
    allow('wrong.test')
    expect((await webExtract(`https://safe.test:${httpsPort}/`)).content).toContain('safe content')
    const result = await webExtract(`https://wrong.test:${httpsPort}/`)
    expect(result.content).toBeUndefined()
    expect(result.excerpt).toContain('Failed to fetch URL')
    expect(hits).toHaveLength(1)
  })

  it('rejects private redirects from search providers too', async () => {
    allow('search.brave.com')
    expect((await webSearch('test')).results).toEqual([])
    expect(hits).toHaveLength(1)
    expect(hits[0]).toContain('search.brave.com')
  })

  it('times out a stalled response and recovers after a connection failure', async () => {
    allow('safe.test')
    const stalled = await safeFetch(url('safe.test', '/hang'), { headers: {}, timeout: 50 })
      .then((response) => response.text())
      .catch((error: Error) => error)
    expect(stalled).toBeInstanceOf(Error)
    const closed = createHttpServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as import('node:net').AddressInfo).port
    await new Promise<void>((resolve) => closed.close(() => resolve()))
    expect((await webExtract(`http://safe.test:${port}/`)).content).toBeUndefined()
    expect((await webExtract(url('safe.test'))).content).toContain('safe content')
  })
})
