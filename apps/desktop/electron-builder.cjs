/**
 * electron-builder configuration (kept separate from package.json so the
 * release provider and runtime environment can be resolved at build time).
 *
 * Update feed:
 * - ARAREADER_UPDATE_URL set -> generic provider for a static feed serving
 *   latest.yml / latest-mac.yml (for example, a CDN).
 * - Otherwise use GitHub Releases, defaulting to funara/arareader. The
 *   ARA_GITHUB_OWNER / ARA_GITHUB_REPO environment or .env values can override it.
 */

const { existsSync, readFileSync } = require('node:fs')
const { join } = require('node:path')

const updateUrl = process.env.ARAREADER_UPDATE_URL || sourceEnvValue('ARAREADER_UPDATE_URL')
const githubOwner = process.env.ARA_GITHUB_OWNER || sourceEnvValue('ARA_GITHUB_OWNER') || 'funara'
const githubRepo = process.env.ARA_GITHUB_REPO || sourceEnvValue('ARA_GITHUB_REPO') || 'arareader'

/** One value from the repo-root private .env (build-time identity fallback); undefined when missing. */
function sourceEnvValue(key) {
  const source = join(__dirname, '../../.env')
  if (!existsSync(source)) return undefined
  for (const line of readFileSync(source, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith(`${key}=`)) continue
    const value = line.slice(key.length + 1).trim()
    const quote = value[0]
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      return value.slice(1, -1)
    }
    return value
  }
  return undefined
}

const copyright = `Copyright © ${new Date().getFullYear()} ARAReader / Adhi Rahmadian. All rights reserved.`
const legalTrademarks = 'ARAReader original work'

// Packaging inputs that the build must have produced before electron-builder
// runs. electron-builder only logs "file source doesn't exist" for an absent
// extraResources source and still exits 0, so without this check the installer
// could ship without the PDF module, the notices, or the Chromium licenses.
//
// Runs from the beforePack hook, not at module load: gen-third-party-notices
// requires this config to read extraResources, and the dist:* scripts run
// notices before the PDF module build, when out dirs legitimately don't exist.
function assertPackagingInputsPresent() {
  for (const rel of [
    '../pdf/out',
    'build/THIRD-PARTY-NOTICES.txt',
    '../../node_modules/electron/dist/LICENSES.chromium.html',
  ]) {
    if (!existsSync(join(__dirname, rel))) {
      throw new Error(
        `electron-builder extraResources source missing: ${rel} ` +
          '(run npm run build && npm run notices first)',
      )
    }
  }
}

/** @type {import('electron-builder').Configuration} */
const config = {
  appId: 'com.arareader.app',
  productName: 'ARAReader',
  copyright,
  // Resolved from the installed electron package so dependency bumps can
  // never leave a stale hard-coded pin behind (packaging would silently ship
  // the old runtime).
  electronVersion: require('electron/package.json').version,
  directories: {
    output: 'release',
  },
  files: ['out/**'],
  extraResources: [
    {
      from: 'build/THIRD-PARTY-NOTICES.txt',
      to: 'THIRD-PARTY-NOTICES.txt',
    },
    {
      from: '../../node_modules/electron/dist/LICENSES.chromium.html',
      to: 'LICENSES.chromium.html',
    },
    {
      from: '../pdf/out',
      to: 'modules/pdf',
    },
    {
      from: '../../public/ARAReader-icon.png',
      to: 'ARAReader-icon.png',
    },
    {
      from: '../../public/ARAPdf-icon.png',
      to: 'ARAPdf-icon.png',
    },
    {
      from: '../../public/ARA_dark.png',
      to: 'ARA_dark.png',
    },
    {
      from: '../../public/ARA_light.png',
      to: 'ARA_light.png',
    },
    {
      from: 'build/pdf.ico',
      to: 'pdf.ico',
    },
  ],
  // `mimeType` is read only by the Linux target, where it becomes the
  // desktop entry's MimeType= list; associations without it are dropped
  // there. macOS and Windows ignore the field and key off `ext`.
  fileAssociations: [
    {
      ext: 'pdf',
      name: 'ARAReader.pdf',
      description: 'ARAReader PDF',
      icon: 'build/pdf.ico',
      role: 'Editor',
      mimeType: 'application/pdf',
    },
  ],
  npmRebuild: false,
  mac: {
    icon: '../../public/ARAReader-icon.png',
    target: ['dmg', 'zip'],
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize: false,
  },
  win: {
    icon: 'build/icon.ico',
    legalTrademarks,
    target: [
      {
        target: 'nsis',
        arch: ['x64'],
      },
    ],
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Office',
    icon: '../../public/ARAReader-icon.png',
    // mac and win name the binary from productName; linux instead derives it
    // from package.json "name", and "@arareader/desktop" sanitizes to the
    // invalid "@arareaderdesktop". Setting it explicitly also makes the
    // generated arareader.desktop match the WM_CLASS Electron reports (it
    // takes that from the executable basename), so the running window links
    // back to its launcher entry.
    executableName: 'arareader',
    // Electron takes its X11 app_id from package.json "desktopName"
    // (arareader.desktop); syncDesktopName makes electron-builder name the
    // .desktop file and its StartupWMClass from the same value. Without it
    // StartupWMClass falls back to productName ("ARAReader"), which does not
    // match the "arareader" WM_CLASS the window actually reports — and X11
    // compares case-sensitively, so the taskbar shows an unlinked window.
    syncDesktopName: true,
    maintainer: 'Adhi Rahmadian <noreply@arareader.app>',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    artifactName: 'ARAReader.Setup.${version}.${ext}',
    include: 'build/installer.nsh',
    uninstallDisplayName: 'ARAReader',
    createDesktopShortcut: 'always',
    createStartMenuShortcut: true,
    shortcutName: 'ARAReader',
  },
  beforePack: async () => {
    assertPackagingInputsPresent()
  },
  dmg: {
    sign: false,
  },
}

if (updateUrl) {
  config.publish = [
    {
      provider: 'generic',
      url: updateUrl.replace(/\/+$/, ''),
      channel: 'latest',
    },
  ]
} else {
  // Generate updater metadata for the configured GitHub Releases repository.
  config.publish = [
    {
      provider: 'github',
      owner: githubOwner,
      repo: githubRepo,
      releaseType: 'release',
    },
  ]
}

module.exports = config
