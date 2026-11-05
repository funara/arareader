import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'

const testDir = path.dirname(fileURLToPath(import.meta.url))
const configPath = path.resolve(testDir, '../electron-builder.cjs')
const configSource = readFileSync(configPath, 'utf8')

interface LoadedConfig {
  appId?: string
  productName?: string
  fileAssociations?: Array<Record<string, unknown>>
  extraResources?: Array<{ from?: string; to?: string }>
  publish?: unknown[]
}

function loadConfig(env: Record<string, string> = {}) {
  const mockedFs = {
    // no repo-root .env in the isolated test: every probe misses
    existsSync: () => false,
    readFileSync: () => {
      throw new Error('Unexpected file read in isolated packaging config test')
    },
    writeFileSync: () => undefined,
  }
  const module = { exports: {} as Record<string, unknown> }
  const sandbox = {
    __dirname: path.dirname(configPath),
    module,
    process: { env },
    require: (name: string) => {
      if (name === 'node:fs') return mockedFs
      if (name === 'node:path') return path
      if (name === 'electron/package.json') return { version: '43.3.0' }
      throw new Error(`Unexpected require: ${name}`)
    },
  }

  runInNewContext(configSource, sandbox, { filename: configPath })
  return JSON.parse(JSON.stringify(module.exports)) as LoadedConfig
}

describe('electron-builder release configuration', () => {
  it('defaults to the public GitHub Releases repository', () => {
    expect(loadConfig().publish).toEqual([
      { provider: 'github', owner: 'funara', repo: 'arareader', releaseType: 'release' },
    ])
  })

  it('keeps the optional generic update feed override', () => {
    expect(loadConfig({ ARAREADER_UPDATE_URL: 'https://updates.example.test' }).publish).toEqual([
      { provider: 'generic', url: 'https://updates.example.test', channel: 'latest' },
    ])
  })

  it('allows owner/repo overrides', () => {
    expect(
      loadConfig({
        ARA_GITHUB_OWNER: 'someone',
        ARA_GITHUB_REPO: 'arareader-fork',
      }).publish,
    ).toEqual([
      { provider: 'github', owner: 'someone', repo: 'arareader-fork', releaseType: 'release' },
    ])
  })

  it('packages the ARAReader app identity', () => {
    const config = loadConfig()
    expect(config.appId).toBe('com.arareader.app')
    expect(config.productName).toBe('ARAReader')
  })

  it('registers the PDF association only', () => {
    expect(loadConfig().fileAssociations).toEqual([
      {
        ext: 'pdf',
        name: 'ARAReader.pdf',
        description: 'ARAReader PDF',
        icon: 'build/pdf.ico',
        role: 'Editor',
        mimeType: 'application/pdf',
      },
    ])
  })

  it('ships the PDF module tree as a resource', () => {
    expect(loadConfig().extraResources).toContainEqual({
      from: '../pdf/out',
      to: 'modules/pdf',
    })
  })
})
