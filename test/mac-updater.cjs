const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { promisify } = require('node:util')
const execFile = promisify(require('node:child_process').execFile)
const { createMacUpdater, parseMacRelease, downloadMacDmg, extractAppFromDmg, writeSelfReplaceScripts, launchReplacement, runCommand } = require('../app/assets/js/macupdater')

const payload = Buffer.from('verified test DMG')
const hash = crypto.createHash('sha512').update(payload).digest('base64')
const feed = `version: 1.0.14
files:
  - url: Barkan-Launcher-setup-1.0.14-x64.dmg
    sha512: ${hash}
    size: ${payload.length}
  - url: Barkan-Launcher-setup-1.0.14-arm64.dmg
    sha512: ${hash}
    size: ${payload.length}
releaseNotes: |-
  ## Fixed updates
  Download and restart.
`

async function temp(t) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'barkan-updater-test-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    return dir
}

async function harness(t, options = {}) {
    const dir = await temp(t)
    const events = []
    const sender = { isDestroyed: () => false, send: (_channel, type, data) => events.push({ type, data }) }
    const app = {
        isPackaged: true,
        getVersion: () => '1.0.11',
        getPath: name => name === 'exe' ? '/Applications/Barkan Launcher.app/Contents/MacOS/Barkan Launcher' : dir,
        quit: () => { app.quitCalled = true }
    }
    const opened = []
    const updater = createMacUpdater({
        app, shell: { openPath: async name => { opened.push(name); return '' } }, arch: 'arm64', tempDir: dir,
        fetchImpl: async url => new Response(url.endsWith('.yml') ? feed : payload), ...options
    })
    return { updater, app, dir, events, sender, opened }
}

test('selects the actual published DMG name for both architectures and parses block release notes', () => {
    for (const arch of ['arm64', 'x64']) {
        const release = parseMacRelease(feed, arch)
        assert.match(release.entry.url, new RegExp(`/download/v1.0.14/Barkan-Launcher-setup-1.0.14-${arch}\\.dmg$`))
        assert.equal(release.releaseNotes, '## Fixed updates\nDownload and restart.')
    }
    assert.match(parseMacRelease(feed.replaceAll('Barkan-Launcher', 'Barkan Launcher'), 'arm64').entry.url, /Barkan%20Launcher/)
    assert.throws(() => parseMacRelease(feed, 'missing'), /no verified/)
    assert.throws(() => parseMacRelease(feed.replace('version: 1.0.14', 'version: invalid'), 'arm64'), /invalid release/)
    assert.throws(() => parseMacRelease(feed.replaceAll(hash, 'bad'), 'arm64'), /no verified/)
})

test('verifies download checksum and size; deletes corrupt or incomplete files', async t => {
    const dir = await temp(t)
    const dest = path.join(dir, 'update.dmg')
    const entry = parseMacRelease(feed, 'arm64').entry
    const progress = []
    await downloadMacDmg(entry, dest, async () => new Response(payload), (...args) => progress.push(args))
    assert.deepEqual(await fs.readFile(dest), payload)
    assert.deepEqual(progress.at(-1), [payload.length, payload.length])
    await assert.rejects(downloadMacDmg(entry, dest, async () => new Response('corrupt'), () => {}), /mismatch/)
    await assert.rejects(fs.stat(dest), { code: 'ENOENT' })
    await assert.rejects(downloadMacDmg(entry, dest, async () => new Response('', { status: 404 }), () => {}), /HTTP 404/)
})

test('checks updates, reports network errors, and handles the current version', async t => {
    const h = await harness(t)
    await h.updater.check(h.sender)
    assert.deepEqual(h.events.map(e => e.type), ['checking-for-update', 'update-available'])
    assert.equal(h.events[1].data.version, '1.0.14')
    h.app.getVersion = () => '1.0.14'
    await h.updater.check(h.sender)
    assert.equal(h.events.at(-1).type, 'update-not-available')
    const failure = await harness(t, { fetchImpl: async () => { throw new Error('network offline') } })
    await failure.updater.check(failure.sender)
    assert.equal(failure.events.at(-1).data.message, 'network offline')
})

test('install errors are visible, keep the launcher open, and never open an unverified DMG', async t => {
    const h = await harness(t, { fetchImpl: async url => new Response(url.endsWith('.yml') ? feed : 'corrupt') })
    await h.updater.install(h.sender)
    assert.equal(h.events.at(-1).data.stage, 'failed')
    assert.match(h.events.at(-1).data.message, /mismatch/)
    assert.equal(h.app.quitCalled, undefined)
    assert.deepEqual(h.opened, [])
    assert.deepEqual((await fs.readdir(h.dir)).filter(name => name.startsWith('barkan-update-')), [])
})

test('translocated / mounted apps open a verified installer instead of replacing a read-only bundle', async t => {
    for (const exe of ['/private/var/folders/AppTranslocation/random/d/Barkan Launcher.app/Contents/MacOS/Barkan Launcher',
        '/Volumes/Barkan/Barkan Launcher.app/Contents/MacOS/Barkan Launcher']) {
        const h = await harness(t)
        h.app.getPath = name => name === 'exe' ? exe : h.dir
        await h.updater.install(h.sender)
        assert.equal(h.events.at(-1).data.stage, 'manual')
        assert.equal(h.opened.length, 1)
        assert.deepEqual(await fs.readFile(h.opened[0]), payload)
        assert.equal(h.app.quitCalled, undefined)
    }
})

test('concurrent clicks download once; helper launch failure is reported before quitting', async t => {
    let downloads = 0
    const h = await harness(t, {
        fetchImpl: async url => {
            if (!url.endsWith('.yml')) { downloads++ }
            return new Response(url.endsWith('.yml') ? feed : payload)
        },
        command: async (cmd, args) => cmd.endsWith('PlistBuddy') ? (args[1].endsWith('Identifier') ? 'kr.barkan.launcher' : '1.0.14') : '',
        launch: async () => { throw new Error('helper failed') }
    })
    await Promise.all([h.updater.install(h.sender), h.updater.install(h.sender), h.updater.check(h.sender)])
    assert.equal(downloads, 1)
    assert.equal(h.events.at(-1).data.message, 'helper failed')
    assert.equal(h.app.quitCalled, undefined)
})

test('staged bundle is validated and helper is ready before app quit', async t => {
    const h = await harness(t, {
        command: async (cmd, args) => cmd.endsWith('PlistBuddy') ? (args[1].endsWith('Identifier') ? 'kr.barkan.launcher' : '1.0.14') : '',
        launch: async (scripts, args) => {
            assert.equal(h.app.quitCalled, undefined)
            assert.equal(args[0], '/Applications/Barkan Launcher.app')
            assert.ok((await fs.readFile(scripts.mainPath, 'utf8')).includes('Launcher did not exit'))
        }
    })
    await h.updater.install(h.sender)
    assert.equal(h.app.quitCalled, true)
    const bad = await harness(t, { command: async () => 'wrong bundle' })
    await bad.updater.install(bad.sender)
    assert.equal(bad.events.at(-1).data.stage, 'failed')
    assert.equal(bad.app.quitCalled, undefined)
})

test('a development Electron runtime cannot be replaced', async t => {
    const h = await harness(t)
    h.app.isPackaged = false
    await h.updater.install(h.sender)
    assert.equal(h.events.at(-1).data.stage, 'failed')
    assert.match(h.events.at(-1).data.message, /packaged launcher/)
})

test('replacement preserves a backup and handles spaces, apostrophes and shell characters in paths', async t => {
    const dir = await temp(t)
    const target = path.join(dir, "User's $App (test).app")
    const staged = path.join(dir, 'staged.app')
    const next = path.join(dir, '.next.app')
    const backup = path.join(dir, '.backup.app')
    await fs.mkdir(path.join(target, 'Contents'), { recursive: true })
    await fs.mkdir(path.join(staged, 'Contents'), { recursive: true })
    await fs.writeFile(path.join(target, 'Contents', 'version'), 'old')
    await fs.writeFile(path.join(staged, 'Contents', 'version'), 'new')
    const scripts = await writeSelfReplaceScripts(dir)
    await runCommand('/bin/bash', ['-n', scripts.mainPath])
    await runCommand('/bin/bash', ['-n', scripts.rootPath])
    await runCommand('/bin/bash', [scripts.rootPath, target, staged, next, backup, 'install'])
    assert.equal(await fs.readFile(path.join(target, 'Contents', 'version'), 'utf8'), 'new')
    assert.equal(await fs.readFile(path.join(backup, 'Contents', 'version'), 'utf8'), 'old')
    await runCommand('/bin/bash', [scripts.rootPath, target, staged, next, backup, 'rollback'])
    assert.equal(await fs.readFile(path.join(target, 'Contents', 'version'), 'utf8'), 'old')
    await assert.rejects(runCommand('/bin/bash', [scripts.rootPath, target, '/missing.app', next, backup, 'install']))
    assert.equal(await fs.readFile(path.join(target, 'Contents', 'version'), 'utf8'), 'old')
})

test('a failed final rename restores the original app automatically', async t => {
    const dir = await temp(t)
    const target = path.join(dir, 'target.app')
    const staged = path.join(dir, 'staged.app')
    const next = path.join(dir, 'next.app')
    const backup = path.join(dir, 'backup.app')
    const bin = path.join(dir, 'bin')
    for (const folder of [target, staged]) { await fs.mkdir(path.join(folder, 'Contents'), { recursive: true }) }
    await fs.writeFile(path.join(target, 'Contents', 'version'), 'old')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, 'mv'), '#!/bin/bash\ncase "$1" in */next.app) exit 1 ;; esac\nexec /bin/mv "$@"\n', { mode: 0o700 })
    const scripts = await writeSelfReplaceScripts(dir)
    await assert.rejects(execFile('/bin/bash', [scripts.rootPath, target, staged, next, backup, 'install'], {
        env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }
    }))
    assert.equal(await fs.readFile(path.join(target, 'Contents', 'version'), 'utf8'), 'old')
})

test('real macOS DMG mount, extraction, version validation and detach', { skip: process.platform !== 'darwin' }, async t => {
    const dir = await temp(t)
    const source = path.join(dir, 'source', 'Barkan Launcher.app', 'Contents')
    await fs.mkdir(source, { recursive: true })
    await fs.writeFile(path.join(source, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>kr.barkan.launcher</string>
<key>CFBundleShortVersionString</key><string>1.0.14</string></dict></plist>`)
    const dmg = path.join(dir, 'fixture.dmg')
    await runCommand('/usr/bin/hdiutil', ['create', '-quiet', '-format', 'UDZO', '-srcfolder', path.join(dir, 'source'), dmg])
    const staged = path.join(dir, 'staged.app')
    await extractAppFromDmg(dmg, staged, dir, '1.0.14')
    assert.equal(await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(staged, 'Contents', 'Info.plist')]), '1.0.14')
    await assert.rejects(fs.stat(path.join(dir, 'mount')), { code: 'ENOENT' })
})

test('real detached helper replaces a disposable app and launches the new executable', { skip: process.platform !== 'darwin' }, async t => {
    const dir = await temp(t)
    const work = path.join(dir, 'work')
    await fs.mkdir(work)
    const target = path.join(dir, 'Disposable Launcher.app')
    const staged = path.join(work, 'staged.app')
    const marker = path.join(dir, 'new-app-launched')
    const id = `kr.barkan.updater-test.${Date.now()}`
    for (const [bundle, version] of [[target, '1.0.11'], [staged, '1.0.14']]) {
        const contents = path.join(bundle, 'Contents')
        await fs.mkdir(path.join(contents, 'MacOS'), { recursive: true })
        await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleExecutable</key><string>marker</string>
<key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>`)
        await fs.writeFile(path.join(contents, 'MacOS', 'marker'), `#!/bin/bash\ntouch '${marker}'\n`, { mode: 0o755 })
    }
    const scripts = await writeSelfReplaceScripts(work)
    const backup = path.join(dir, 'backup.app')
    await launchReplacement(scripts, [target, staged, '99999999', scripts.rootPath, path.join(dir, 'new.app'),
        backup, path.join(work, 'ready'), path.join(dir, 'install.log'), work])
    for (let i = 0; i < 100; i++) {
        if (await fs.stat(marker).catch(() => false)) { break }
        await new Promise(resolve => setTimeout(resolve, 50))
    }
    assert.ok(await fs.stat(marker).catch(() => false), await fs.readFile(path.join(dir, 'install.log'), 'utf8'))
    assert.equal(await runCommand('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(target, 'Contents', 'Info.plist')]), '1.0.14')
    await assert.rejects(fs.stat(backup), { code: 'ENOENT' })
})
