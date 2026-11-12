import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { BlockList, isIP } from 'node:net'
import { promisify } from 'node:util'
import { brotliDecompress, gunzip, inflate } from 'node:zlib'

const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 10 * 1024 * 1024

const blockedAddresses = (() => {
  const list = new BlockList()
  list.addSubnet('0.0.0.0', 8)
  list.addSubnet('10.0.0.0', 8)
  list.addSubnet('100.64.0.0', 10)
  list.addSubnet('127.0.0.0', 8)
  list.addSubnet('169.254.0.0', 16)
  list.addSubnet('172.16.0.0', 12)
  list.addSubnet('192.0.0.0', 24)
  list.addSubnet('192.168.0.0', 16)
  list.addSubnet('198.18.0.0', 15)
  list.addSubnet('224.0.0.0', 4)
  list.addSubnet('240.0.0.0', 4)
  list.addAddress('::', 'ipv6')
  list.addAddress('::1', 'ipv6')
  list.addSubnet('::', 96, 'ipv6')
  list.addSubnet('64:ff9b::', 96, 'ipv6')
  list.addSubnet('fc00::', 7, 'ipv6')
  list.addSubnet('fe80::', 10, 'ipv6')
  list.addSubnet('ff00::', 8, 'ipv6')
  return list
})()

export function isBlockedAddress(ip: string): boolean {
  const type = isIP(ip)
  return type === 0 || blockedAddresses.check(ip, type === 4 ? 'ipv4' : 'ipv6')
}

async function resolveSafe(
  raw: unknown,
): Promise<{ url: URL; addresses: { address: string; family: number }[] }> {
  if (typeof raw !== 'string') throw new Error('Private or unsafe network hosts are not accessible')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Private or unsafe network hosts are not accessible')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !host ||
    host === 'localhost' ||
    ['.localhost', '.local', '.internal'].some((suffix) => host.endsWith(suffix))
  )
    throw new Error('Private or unsafe network hosts are not accessible')
  let addresses: { address: string; family: number }[]
  try {
    const family = isIP(host)
    addresses = family ? [{ address: host, family }] : await lookup(host, { all: true })
  } catch {
    throw new Error('Private or unsafe network hosts are not accessible')
  }
  if (!addresses.length || addresses.some(({ address }) => isBlockedAddress(address))) {
    throw new Error('Private or unsafe network hosts are not accessible')
  }
  return { url, addresses }
}

export async function isSafeRemoteUrl(raw: unknown): Promise<boolean> {
  try {
    await resolveSafe(raw)
    return true
  } catch {
    return false
  }
}

type SafeResponse = {
  ok: boolean
  status: number
  statusText: string
  headers: Headers
  text(): Promise<string>
  json(): Promise<unknown>
  discard(): void
}

async function requestOnce(
  raw: string,
  headers: Record<string, string>,
  timeout: number,
): Promise<SafeResponse> {
  const signal = AbortSignal.timeout(timeout)
  // DNS itself is not abortable, so bound the wait before starting a socket.
  const resolved = await Promise.race([
    resolveSafe(raw),
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
    ),
  ])
  if (signal.aborted) throw signal.reason
  const { url, addresses } = resolved
  let lastError: unknown
  for (const { address, family } of addresses) {
    try {
      return await new Promise((resolve, reject) => {
        const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
          url,
          {
            headers: { 'Accept-Encoding': 'gzip, deflate, br', ...headers },
            agent: false,
            signal,
            family,
            // Keep the URL hostname for Host, SNI and certificate verification; never resolve it again.
            lookup: (_hostname, _options, callback) => callback(null, address, family),
          },
          (response) => {
            const responseHeaders = new Headers()
            for (const [key, value] of Object.entries(response.headers)) {
              if (value !== undefined)
                responseHeaders.set(key, Array.isArray(value) ? value.join(', ') : value)
            }
            const status = response.statusCode ?? 0
            const text = async () => {
              const chunks: Buffer[] = []
              let size = 0
              for await (const chunk of response) {
                const bytes = Buffer.from(chunk)
                size += bytes.length
                if (size > MAX_RESPONSE_BYTES) {
                  response.destroy()
                  throw new Error('Response exceeds size limit')
                }
                chunks.push(bytes)
              }
              let body = Buffer.concat(chunks)
              const encoding = responseHeaders.get('content-encoding')?.toLowerCase()
              const options = { maxOutputLength: MAX_DECOMPRESSED_BYTES }
              try {
                if (encoding === 'gzip' || encoding === 'x-gzip')
                  body = await promisify(gunzip)(body, options)
                else if (encoding === 'deflate') body = await promisify(inflate)(body, options)
                else if (encoding === 'br') body = await promisify(brotliDecompress)(body, options)
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE')
                  throw new Error('Response exceeds size limit', { cause: error })
                throw error
              }
              return body.toString('utf8')
            }
            resolve({
              ok: status >= 200 && status < 300,
              status,
              statusText: response.statusMessage ?? '',
              headers: responseHeaders,
              text,
              json: async () => JSON.parse(await text()) as unknown,
              discard: () => response.destroy(),
            })
          },
        )
        request.on('error', reject)
        request.end()
      })
    } catch (error) {
      if (signal.aborted) throw signal.reason
      lastError = error
    }
  }
  throw lastError
}

export async function safeFetch(
  raw: string,
  options: { headers: Record<string, string>; timeout: number },
): Promise<SafeResponse> {
  let current = raw
  for (let hop = 0; hop <= 5; hop++) {
    const response = await requestOnce(current, options.headers, options.timeout)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    const location = response.headers.get('location')
    response.discard()
    if (!location) throw new Error('Redirect missing location header')
    if (hop === 5) throw new Error('Too many redirects')
    current = new URL(location, current).toString()
  }
  throw new Error('Too many redirects')
}
