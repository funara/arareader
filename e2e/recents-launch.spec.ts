import { spawn, type ChildProcess } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { PDFDocument } from 'pdf-lib'
import { closeReader, DESKTOP_DIR, launchApp } from './helpers'

function waitForExit(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('Second Electron instance did not exit')),
      20_000,
    )
    child.once('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timeout)
      resolve(code)
    })
  })
}

async function recentHead(path: string): Promise<string | null> {
  try {
    const recent = JSON.parse(await readFile(path, 'utf8'))
    return Array.isArray(recent) && typeof recent[0] === 'string' ? recent[0] : null
  } catch {
    return null
  }
}

test('simulated second-instance additionalData resolves relative PDF from launch directory', async () => {
  const firstDir = await mkdtemp(join(tmpdir(), 'arareader-fallback-first-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'arareader-fallback-second-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-fallback-profile-'))
  const firstPdf = join(firstDir, 'report.pdf')
  const secondPdf = join(secondDir, 'report.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  const bytes = await document.save()
  await Promise.all([writeFile(firstPdf, bytes), writeFile(secondPdf, bytes)])
  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  try {
    launched = await launchApp({ cwd: firstDir, openFile: firstPdf, userDataDir })
    const recentFile = join(userDataDir, 'recent.json')
    await expect.poll(() => recentHead(recentFile)).toBe(firstPdf)
    await launched.app.evaluate(({ app }, cwd) => {
      app.emit('second-instance', {} as Electron.Event, ['--non-pdf'], cwd, {
        launchPath: 'report.pdf',
      })
    }, secondDir)
    await expect.poll(() => recentHead(recentFile)).toBe(secondPdf)
  } finally {
    if (launched) await closeReader(launched)
    await Promise.all([
      rm(firstDir, { recursive: true, force: true }),
      rm(secondDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})

test('second-instance relative PDF opens from its launch directory and becomes recent', async () => {
  const firstDir = await mkdtemp(join(tmpdir(), 'arareader-second-instance-first-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'arareader-second-instance-second-'))
  const userDataDir = await mkdtemp(join(tmpdir(), 'arareader-second-instance-profile-'))
  const firstPdf = join(firstDir, 'report.pdf')
  const secondPdf = join(secondDir, 'report.pdf')
  const document = await PDFDocument.create()
  document.addPage([612, 792])
  const bytes = await document.save()
  await Promise.all([writeFile(firstPdf, bytes), writeFile(secondPdf, bytes)])

  let launched: Awaited<ReturnType<typeof launchApp>> | undefined
  let secondInstance: ChildProcess | undefined
  try {
    // Keep a same-named PDF in the primary process's CWD to catch resolution
    // against the wrong instance's working directory.
    launched = await launchApp({ cwd: firstDir, openFile: firstPdf, userDataDir })
    const recentFile = join(userDataDir, 'recent.json')
    await expect.poll(() => recentHead(recentFile)).toBe(firstPdf)

    const require = createRequire(join(DESKTOP_DIR, 'package.json'))
    const executablePath = require('electron') as unknown as string
    const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...hostEnv } = process.env
    const args: string[] = []
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-gpu')
    args.push(DESKTOP_DIR, 'report.pdf')
    secondInstance = spawn(executablePath, args, {
      cwd: secondDir,
      env: {
        ...hostEnv,
        ARAREADER_USER_DATA: userDataDir,
        ARAREADER_LANG: 'en',
        ARAREADER_FAKE_UPDATE: '',
        ...(process.platform === 'linux' ? { ELECTRON_DISABLE_SANDBOX: '1' } : {}),
      },
      stdio: 'ignore',
    })
    expect(await waitForExit(secondInstance)).toBe(0)

    await expect.poll(() => recentHead(recentFile)).toBe(secondPdf)
    await expect
      .poll(() =>
        launched!.page.evaluate(async () => {
          const tabs = await (
            window as unknown as { readerTabs: { list(): Promise<{ kind: string }[]> } }
          ).readerTabs.list()
          return tabs.filter((tab) => tab.kind === 'pdf').length
        }),
      )
      .toBe(2)
  } finally {
    if (secondInstance && secondInstance.exitCode === null) secondInstance.kill()
    if (launched) await closeReader(launched)
    await Promise.all([
      rm(firstDir, { recursive: true, force: true }),
      rm(secondDir, { recursive: true, force: true }),
      rm(userDataDir, { recursive: true, force: true }),
    ])
  }
})
