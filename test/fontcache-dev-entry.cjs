const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const FontCacheDev = require('../app/assets/js/fontcachedev')

const root = path.resolve(__dirname, '..')
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const distribution = JSON.parse(source('app/assets/distribution.json'))

function section(text, start, end) {
    const from = text.indexOf(start)
    const to = text.indexOf(end, from)
    assert.ok(from >= 0 && to > from, `Missing executable section: ${start}`)
    return text.slice(from, to)
}

// Execute production entrypoints with explicit dependency stubs. No Electron
// process, user directory, network request or game process is created here.
function bootstrap(env = {}, isPackaged = false) {
    const effects = []
    const runtimeEnv = { ...env }
    const app = {
        isPackaged,
        setName: name => effects.push(['name', name]),
        setPath: (...args) => effects.push(['path', ...args])
    }
    const context = {
        __dirname: root,
        process: { env: runtimeEnv },
        require(id) {
            switch (id) {
                case 'electron': return { app }
                case 'fs': return { mkdirSync: (...args) => effects.push(['mkdir', ...args]) }
                case 'path': return path
                case './app/assets/js/fontcachedev':
                    return { distribution: raw => FontCacheDev.distribution(raw, runtimeEnv) }
                case './app/assets/distribution.json': return distribution
                case './index.js':
                    effects.push(['index', { ...runtimeEnv }])
                    return {}
                default: throw new Error(`Unexpected require: ${id}`)
            }
        }
    }
    return { effects, env: runtimeEnv, run: () => vm.runInNewContext(source('fontcache-dev-main.cjs'), context) }
}

test('isolated main rejects packaged, unselected and invalid-server launches before filesystem or app changes', () => {
    const cases = [
        [{ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567' }, true, /개발 실행 전용/],
        [{ BARKAN_DEV_SERVER: '127.0.0.1:25567' }, false, /개발 실행 전용/],
        [{ BARKAN_FONT_CACHE_DEV: 'true', BARKAN_DEV_SERVER: '127.0.0.1:25567' }, false, /개발 실행 전용/],
        [{ BARKAN_FONT_CACHE_DEV: '1' }, false, /개발 서버 주소/],
        [{ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: 'barkan.kr:25565' }, false, /운영 서버/],
        [{ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: 'https://localhost:25567' }, false, /개발 서버 주소/]
    ]
    for (const [env, packaged, error] of cases) {
        const h = bootstrap(env, packaged)
        assert.throws(h.run, error)
        assert.deepEqual(h.effects, [])
        assert.deepEqual(h.env, env)
    }
})

test('isolated main replaces inherited data paths before loading the normal main', () => {
    const h = bootstrap({
        BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567',
        BARKAN_DATA_DIR: '/production/game', BARKAN_FONT_CACHE_DEV_ENTRY: 'wrong', ELECTRON_IS_DEV: '0'
    })
    h.run()
    const devRoot = path.join(root, '.font-cache-dev')
    assert.deepEqual(plain(h.effects), [
        ['mkdir', path.join(devRoot, 'launcher'), { recursive: true }],
        ['name', 'Barkan Font Cache Dev'],
        ['path', 'userData', path.join(devRoot, 'launcher')],
        ['index', {
            BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567',
            BARKAN_DATA_DIR: path.join(devRoot, 'game'), BARKAN_FONT_CACHE_DEV_ENTRY: 'isolated', ELECTRON_IS_DEV: '1'
        }]
    ])
})

test('normal main blocks a dev opt-in before requiring Electron but accepts ordinary and isolated entries', () => {
    for (const env of [
        { BARKAN_FONT_CACHE_DEV: '1' },
        { BARKAN_FONT_CACHE_DEV: '1', BARKAN_FONT_CACHE_DEV_ENTRY: 'wrong' }
    ]) {
        let requires = 0
        assert.throws(() => vm.runInNewContext(source('index.js'), {
            process: { env }, require() { requires++; throw new Error('reached dependency') }
        }), /격리 진입점/)
        assert.equal(requires, 0)
    }
    for (const env of [{}, { BARKAN_FONT_CACHE_DEV: '0' },
        { BARKAN_FONT_CACHE_DEV: '1', BARKAN_FONT_CACHE_DEV_ENTRY: 'isolated' }]) {
        const reachedDependency = new Error('dependency boundary')
        assert.throws(() => vm.runInNewContext(source('index.js'), {
            process: { env }, require() { throw reachedDependency }
        }), error => error === reachedDependency)
    }
})

test('start helper selects only the isolated entrypoint and forwards its explicit development environment', () => {
    const child = new EventEmitter()
    const spawned = []
    const processStub = { argv: ['node', 'start-fontcache-dev.cjs', 'dev.example:25567'], env: {
        BARKAN_FONT_CACHE_DEV: '0', BARKAN_DEV_SERVER: 'barkan.kr:25565', ELECTRON_IS_DEV: '0', KEEP_ME: 'yes'
    } }
    const context = {
        __dirname: path.join(root, 'tools'), process: processStub, console: { error() {} },
        require(id) {
            if (id === 'path') return path
            if (id === 'electron') return '/fixture/electron'
            if (id === 'child_process') return { spawn: (...args) => { spawned.push(args); return child } }
            throw new Error(`Unexpected require: ${id}`)
        }
    }
    vm.runInNewContext(source('tools/start-fontcache-dev.cjs'), context)
    assert.deepEqual(plain(spawned), [[
        '/fixture/electron', [path.join(root, 'fontcache-dev-main.cjs')], {
            stdio: 'inherit', env: {
                BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: 'dev.example:25567', ELECTRON_IS_DEV: '1', KEEP_ME: 'yes'
            }
        }
    ]])
    child.emit('exit', 7)
    assert.equal(processStub.exitCode, 7)
    child.emit('exit', null)
    assert.equal(processStub.exitCode, 1)
    processStub.exitCode = 0
    child.emit('error', new Error('spawn failed'))
    assert.equal(processStub.exitCode, 1)

    processStub.argv = ['node', 'start-fontcache-dev.cjs']
    assert.throws(() => vm.runInNewContext(source('tools/start-fontcache-dev.cjs'), { ...context }), /개발 서버 주소/)
    assert.equal(spawned.length, 1)
})

function updateHarness(platform, env) {
    let handler
    const calls = []
    const notifications = []
    const updater = {
        on: name => calls.push(['listen', name]),
        checkForUpdates: async () => { calls.push(['check']) },
        quitAndInstall: () => calls.push(['install'])
    }
    const context = {
        process: { platform, env }, path, __dirname: root, isDev: false,
        ipcMain: { on: (channel, fn) => { assert.equal(channel, 'autoUpdateAction'); handler = fn } },
        autoUpdater: updater,
        macUpdater: { check: () => calls.push(['mac-check']), install: () => calls.push(['mac-install']) },
        app: { getVersion: () => '1.0.20' }, semver: { prerelease: () => null }, console: { log() {} }
    }
    vm.runInNewContext(section(source('index.js'), 'function initAutoUpdater', '// 배포 인덱스는'), context)
    const event = { sender: { send: (...args) => notifications.push(args) } }
    return { calls, notifications, updater, action: (action, data) => handler(event, action, data) }
}

test('all updater actions are inert in dev on macOS and Windows', () => {
    for (const platform of ['darwin', 'win32']) {
        const h = updateHarness(platform, { BARKAN_FONT_CACHE_DEV: '1' })
        for (const action of ['initAutoUpdater', 'checkMacUpdate', 'checkForUpdate', 'allowPrereleaseChange', 'installUpdateNow']) {
            h.action(action, true)
        }
        assert.deepEqual(h.calls, [])
        assert.equal(h.updater.allowPrerelease, undefined)
        assert.deepEqual(h.notifications, [
            ['autoUpdateNotification', 'ready'],
            ...Array.from({ length: 4 }, () => ['autoUpdateNotification', 'update-not-available'])
        ])
    }
})

test('ordinary updater checks and installations still use the platform updater', () => {
    for (const platform of ['darwin', 'win32']) {
        for (const env of [{}, { BARKAN_FONT_CACHE_DEV: '0' }]) {
            const h = updateHarness(platform, env)
            h.action('initAutoUpdater')
            h.action('checkForUpdate')
            h.action('installUpdateNow')
            h.action('allowPrereleaseChange', true)
            assert.equal(h.updater.allowPrerelease, true)
            assert.deepEqual(h.calls, platform === 'darwin' ? [['mac-check'], ['mac-install']] : [
                ...['update-available', 'update-downloaded', 'update-not-available', 'checking-for-update', 'error'].map(name => ['listen', name]),
                ['check'], ['install']
            ])
            assert.deepEqual(h.notifications, [['autoUpdateNotification', 'ready']])
        }
    }
})

function memoryConfig(env, launcherDir, initialFiles = new Map(), platform = 'darwin') {
    const files = new Map(initialFiles)
    const operations = []
    const fakeFs = {
        existsSync: name => { operations.push(['exists', name]); return files.has(name) },
        ensureDirSync: name => operations.push(['mkdir', name]),
        moveSync(from, to) { operations.push(['move', from, to]); files.set(to, files.get(from)); files.delete(from) },
        readFileSync(name) {
            operations.push(['read', name])
            if (!files.has(name)) throw new Error(`Missing fixture: ${name}`)
            return files.get(name)
        },
        writeFileSync(name, data) { operations.push(['write', name]); files.set(name, data) }
    }
    const exports = {}
    vm.runInNewContext(source('app/assets/js/configmanager.js'), {
        exports, process: { env, platform },
        require(id) {
            if (id === 'fs-extra') return fakeFs
            if (id === 'path') return path
            if (id === 'os') return { totalmem: () => 8 * 1073741824 }
            if (id === '@electron/remote') return { app: { getPath: name => { assert.equal(name, 'userData'); return launcherDir } } }
            if (id === 'helios-core') return { LoggerUtil: { getLogger: () => ({ info() {}, error() {} }) } }
            throw new Error(`Unexpected require: ${id}`)
        }
    })
    return { config: exports, files, operations }
}

test('dev config, accounts, game directories and native directory remain isolated from ordinary data', () => {
    const h = bootstrap({ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567', HOME: '/fixture/home' })
    h.run()
    const devRoot = path.join(root, '.font-cache-dev')
    const launcherDir = path.join(devRoot, 'launcher')
    const prodLegacy = path.join('/fixture/home', 'Library/Application Support', '.barkanlauncher', 'config.json')
    const prodContents = JSON.stringify({ selectedAccount: 'production', authenticationDatabase: { production: { accessToken: 'fixture-token' } } })
    const store = memoryConfig(h.env, launcherDir, new Map([[prodLegacy, prodContents]]))
    assert.equal(store.config.isFirstLaunch(), true)
    store.config.load()
    assert.equal(store.config.getLauncherDirectory(), launcherDir)
    assert.equal(store.config.getDataDirectory(), path.join(devRoot, 'game'))
    assert.equal(store.config.getCommonDirectory(), path.join(devRoot, 'game', 'common'))
    assert.equal(store.config.getInstanceDirectory(), path.join(devRoot, 'game', 'instances'))
    assert.equal(store.config.getTempNativeFolder(), 'BarkanFontCacheDevNatives')
    assert.deepEqual(plain(store.config.getAuthAccounts()), {})
    assert.equal(store.config.getSelectedAccount(), undefined)
    store.config.setDataDirectory('/production/game')
    assert.equal(store.config.getDataDirectory(), path.join(devRoot, 'game'))
    store.config.addMojangAuthAccount('dev', 'dev-fixture-token', 'Dev', 'Dev')
    store.config.save()
    assert.equal(JSON.parse(store.files.get(path.join(launcherDir, 'config.json'))).selectedAccount, 'dev')
    assert.equal(store.files.get(prodLegacy), prodContents)
    assert.ok(store.operations.every(([, ...paths]) => paths.every(name => name.startsWith(devRoot))))
})

test('ordinary config still migrates legacy accounts and uses the selected data directory', () => {
    const home = '/fixture/home'
    const launcherDir = '/fixture/ordinary-launcher'
    const legacyData = path.join(home, 'Library/Application Support/.barkanlauncher')
    const legacy = path.join(legacyData, 'config.json')
    const saved = { settings: { launcher: { dataDirectory: '/fixture/custom-game' } },
        selectedAccount: 'ordinary', authenticationDatabase: { ordinary: { accessToken: 'fixture-token' } } }
    const h = memoryConfig({ HOME: home }, launcherDir, new Map([[legacy, JSON.stringify(saved)]]))
    assert.equal(h.config.isFirstLaunch(), false)
    h.config.load()
    assert.equal(h.config.getDataDirectory(true), legacyData)
    assert.equal(h.config.getDataDirectory(), '/fixture/custom-game')
    assert.equal(h.config.getTempNativeFolder(), 'WCNatives')
    assert.deepEqual(plain(h.config.getSelectedAccount()), saved.authenticationDatabase.ordinary)
    assert.ok(h.operations.some(op => op[0] === 'move' && op[1] === legacy && op[2] === path.join(launcherDir, 'config.json')))
    h.config.setDataDirectory('/fixture/changed-game')
    assert.equal(h.config.getInstanceDirectory(), path.join('/fixture/changed-game', 'instances'))
})

test('dev language lookup never imports the ordinary launcher config and ordinary fallback still works', () => {
    const main = section(source('index.js'), 'function readConfiguredLanguage()', '// webContents.reload')
    const launcherDir = '/fixture/launcher'
    const appData = '/fixture/appdata'
    const legacy = path.join(appData, '.barkanlauncher', 'config.json')
    for (const dev of [true, false]) {
        const reads = []
        let getLanguage
        const context = vm.createContext({
            process: { env: dev ? { BARKAN_FONT_CACHE_DEV: '1' } : {} }, path,
            app: { getPath: name => name === 'userData' ? launcherDir : appData },
            fs: { readFileSync(name) {
                reads.push(name)
                if (name !== legacy) throw new Error('No local language yet')
                return JSON.stringify({ settings: { launcher: { language: 'ja_JP' } } })
            } },
            ipcMain: { on: (name, handler) => { assert.equal(name, 'getLanguage'); getLanguage = handler } }
        })
        vm.runInContext(main, context)
        const event = {}
        getLanguage(event)
        assert.equal(event.returnValue, dev ? 'ko_KR' : 'ja_JP')
        assert.deepEqual(reads, dev ? [path.join(launcherDir, 'config.json')] : [path.join(launcherDir, 'config.json'), legacy])
    }
})
