const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const FontCacheDev = require('../app/assets/js/fontcachedev')

const root = path.join(__dirname, '..')
const source = file => fs.readFileSync(path.join(root, file), 'utf8')
const plain = value => JSON.parse(JSON.stringify(value))
const logger = { info() {}, warn() {}, error() {} }
const bundled = source('app/assets/distribution.json')

// Execute the checked-in modules with explicit dependencies. Unexpected I/O,
// Electron imports and process creation fail instead of reaching the host.
function load(file, dependencies, env = {}, platform = 'linux') {
    const module = { exports: {} }
    const context = vm.createContext({
        module, exports: module.exports, __dirname: path.dirname(path.join(root, file)),
        process: { env: { ...env }, platform, arch: 'x64' },
        console: { log() {}, error() {} }, structuredClone,
        require(name) {
            assert.ok(Object.hasOwn(dependencies, name), `Unexpected dependency: ${name}`)
            return dependencies[name]
        }
    })
    vm.runInContext(source(file), context, { filename: file })
    return module.exports
}

function distributionHarness(env = {}, contents = bundled) {
    const launcherDir = path.join(root, '.font-cache-dev', 'launcher')
    const distroPath = path.join(launcherDir, 'distribution_dev.json')
    const files = new Map([[path.join(root, 'app/assets/distribution.json'), contents]])
    const apiCalls = []
    const dependencies = {
        path,
        'fs-extra': {
            existsSync: file => files.has(file),
            readFileSync: file => { assert.ok(files.has(file)); return files.get(file) },
            outputFileSync: (file, text) => { assert.equal(file, distroPath); files.set(file, text) }
        },
        './configmanager': { getLauncherDirectory: () => launcherDir },
        './fontcachedev': {
            enabled: () => FontCacheDev.enabled(env),
            distribution: raw => FontCacheDev.distribution(raw, env)
        },
        'helios-core/common': { DistributionAPI: class {
            constructor(...args) { apiCalls.push(args) }
        } }
    }
    const run = () => load('app/assets/js/distromanager.js', dependencies, env)
    return { run, files, distroPath, apiCalls, launcherDir }
}

test('distribution manager writes only the sanitized local dev profile and rejects invalid dev startup', () => {
    const h = distributionHarness({ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567' })
    const result = h.run()
    const distro = JSON.parse(h.files.get(h.distroPath))
    assert.deepEqual(distro.servers.map(server => server.id), ['barkan-font-cache-dev'])
    assert.equal(distro.servers[0].address, '127.0.0.1:25567')
    assert.equal(distro.resourcePack, null)
    assert.deepEqual(distro.extraResourcePacks, [])
    assert.deepEqual(distro.clientMods, [])
    assert.deepEqual(distro.shaders, {})
    assert.equal(result.REMOTE_DISTRO_URL, null)
    assert.deepEqual(plain(h.apiCalls), [[h.launcherDir, null, null, null, true]])
    assert.equal(h.files.get(path.join(root, 'app/assets/distribution.json')), bundled)

    for (const address of [undefined, 'barkan.kr:25565']) {
        const invalid = distributionHarness({ BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: address })
        assert.throws(invalid.run)
        assert.equal(invalid.files.has(invalid.distroPath), false)
        assert.equal(invalid.apiCalls.length, 0)
    }
})

test('normal distribution manager preserves bundled production bytes and profiles', () => {
    const h = distributionHarness()
    h.run()
    assert.equal(h.files.get(h.distroPath), bundled)
    const distro = JSON.parse(h.files.get(h.distroPath))
    assert.equal(distro.servers[0].id, 'barkan')
    assert.ok(distro.resourcePack.manifestUrl)
    assert.ok(distro.clientMods.length > 0)
})

test('preloader replaces a stale production selection with the isolated dev profile and keeps valid selections', () => {
    const text = source('app/assets/js/preloader.js')
    const start = text.indexOf('function onDistroLoad(')
    const end = text.indexOf('\nDistroAPI.getDistribution()', start)
    assert.ok(start >= 0 && end > start)
    for (const dev of [true, false]) {
        const distro = FontCacheDev.distribution(JSON.parse(bundled), dev
            ? { BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: 'localhost:25567' } : {})
        let selected = 'barkan'
        let saves = 0
        const sends = []
        const context = vm.createContext({
            ConfigManager: {
                getSelectedServer: () => selected,
                setSelectedServer: id => { selected = id },
                save: () => { saves++ }
            }, logger,
            ipcRenderer: { send: (...args) => sends.push(args) },
            data: {
                getServerById: id => distro.servers.find(server => server.id === id),
                getMainServer: () => ({ rawServer: distro.servers[0] })
            }
        })
        vm.runInContext(text.slice(start, end) + '\nonDistroLoad(data); onDistroLoad(data)', context)
        assert.equal(selected, dev ? 'barkan-font-cache-dev' : 'barkan')
        assert.equal(saves, dev ? 1 : 0)
        assert.deepEqual(sends, [['distributionIndexDone', true], ['distributionIndexDone', true]])
    }
})

function processBuilderHarness(dev, platform, agentError) {
    const dataDir = path.join(root, dev ? '.font-cache-dev/game' : 'normal-game')
    const env = dev ? { BARKAN_FONT_CACHE_DEV: '1', BARKAN_DATA_DIR: dataDir } : {}
    const calls = { agents: [], spawn: [], liteLoader: 0, modConfig: 0 }
    const Type = { Fabric: 'Fabric', Library: 'Library', LiteLoader: 'LiteLoader' }
    const server = {
        rawServer: { id: dev ? 'barkan-font-cache-dev' : 'barkan', barkanFontCacheDev: dev,
            minecraftVersion: '1.21.11', address: dev ? 'localhost:25567' : 'barkan.kr:25565', autoconnect: true },
        hostname: dev ? 'localhost' : 'barkan.kr', port: dev ? 25567 : 25565,
        modules: [{ rawModule: { type: Type.Fabric }, subModules: [],
            getVersionlessMavenIdentifier: () => 'net.fabricmc:fabric-loader',
            getPath: () => path.join(dataDir, 'fabric-loader.jar') }]
    }
    const vanilla = { id: '1.21.11', mainClass: 'net.minecraft.client.main.Main',
        assets: 'test-assets', type: 'release', libraries: [{ name: 'org.test:vanilla:1',
            downloads: { artifact: { path: 'org/test/vanilla.jar' } } }],
        arguments: { jvm: ['-cp', '${classpath}', { rules: [{ features: { has_custom_resolution: true } }], value: ['--width', '${resolution_width}'] }],
            game: ['--gameDir', '${game_directory}', '--version', '${version_name}', '--accessToken', '${auth_access_token}'] } }
    const originalVanilla = structuredClone(vanilla)
    const modManifest = { id: 'fabric-loader-1.21.11', mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
        arguments: { jvm: ['-Dfabric.marker=true'], game: ['--fabric-marker'] } }
    const config = {
        getInstanceDirectory: () => path.join(dataDir, 'instances'),
        getCommonDirectory: () => path.join(dataDir, 'common'),
        getTempNativeFolder: () => dev ? 'BarkanFontCacheDevNatives' : 'WCNatives',
        getMaxRAM: () => '4G', getMinRAM: () => '2G', getJVMOptions: () => ['-Duser.option=true'],
        getFullscreen: () => false, getGameWidth: () => 1280, getAutoConnect: () => true,
        getJavaExecutable: () => '/fixture/java', getLaunchDetached: () => false,
        getModConfiguration: () => { calls.modConfig++; return { mods: {} } }
    }
    const agentArgs = ['-javaagent:/fixture/font-image-cache-agent.jar=enabled=true',
        '-javaagent:/fixture/font-gpu-cache-agent.jar=enabled=true,poolPolicy=small-text']
    const Builder = load('app/assets/js/processbuilder.js', {
        path, os: { tmpdir: () => path.join(root, 'test-tmp') }, crypto: require('node:crypto'),
        'fs-extra': { ensureDirSync() {}, existsSync: () => true },
        'helios-core': { LoggerUtil: { getLogger: () => logger } },
        'helios-core/common': { getMojangOS: () => platform === 'win32' ? 'windows' : 'linux',
            isLibraryCompatible: () => true, mcVersionAtLeast: () => true },
        'helios-distribution-types': { Type },
        './configmanager': config,
        './fontcachedev': {
            isProfile: raw => FontCacheDev.isProfile(raw, env),
            runtimeManifest: (raw, vanillaData, original) => FontCacheDev.runtimeManifest(raw, vanillaData, original, env),
            // Integrity is exercised with real hashes in fontcache-dev-policy.cjs.
            // This spy verifies that ProcessBuilder actually wires in the helper.
            jvmArguments: options => {
                calls.agents.push(options)
                if (!FontCacheDev.isProfile(options.server, env)) return []
                if (agentError) throw agentError
                return agentArgs
            }
        },
        'adm-zip': class { constructor() { assert.fail('No native archive fixture expected') } },
        electron: { ipcRenderer: { send() {} } },
        child_process: { spawn: (...args) => {
            calls.spawn.push(args)
            const child = new EventEmitter()
            child.stdout = new EventEmitter()
            child.stderr = new EventEmitter()
            child.stdout.setEncoding = child.stderr.setEncoding = () => {}
            return child
        } }
    }, env, platform)
    const pb = new Builder(server, vanilla, modManifest, { displayName: 'Fixture', uuid: 'fixture-uuid',
        accessToken: 'fixture-token', type: 'microsoft' }, 'test-version')
    pb.applyDefaultGameOptions = () => {}
    pb.setupLiteLoader = () => { calls.liteLoader++ }
    pb.resolveModConfiguration = () => ({ fMods: [], lMods: [] })
    return { pb, vanilla, originalVanilla, modManifest, dataDir, calls, agentArgs }
}

for (const platform of ['linux', 'win32']) {
    test(`ProcessBuilder assembles isolated vanilla dev arguments without launching Java (${platform})`, () => {
        const h = processBuilderHarness(true, platform)
        h.pb.build()
        h.pb.build()
        assert.equal(h.calls.spawn.length, 2)
        assert.equal(h.calls.liteLoader, 0)
        assert.equal(h.calls.modConfig, 0)
        assert.equal(h.pb.usingFabricLoader, false)
        assert.deepEqual(h.vanilla, h.originalVanilla, 'repeated launches must not mutate the vanilla manifest')
        for (const [executable, args, options] of h.calls.spawn) {
            assert.equal(executable, '/fixture/java')
            assert.equal(options.cwd, path.join(h.dataDir, 'instances/barkan-font-cache-dev'))
            assert.deepEqual(Array.from(args.filter(arg => typeof arg === 'string' && arg.startsWith('-javaagent:'))), h.agentArgs)
            const main = args.indexOf('net.minecraft.client.main.Main')
            assert.ok(main > 0)
            assert.ok(args.indexOf(h.agentArgs[1]) < main)
            assert.equal(args[args.indexOf('--gameDir') + 1], options.cwd)
            assert.equal(args[args.indexOf('--version') + 1], 'barkan-font-cache-dev')
            assert.equal(args[args.indexOf('--quickPlayMultiplayer') + 1], 'localhost:25567')
            assert.equal(args.includes('--fabric-marker'), false)
            assert.equal(args.some(arg => /fabric-loader|Dfabric.marker|KnotClient/.test(arg)), false)
            assert.equal(args[args.indexOf('-cp') + 1], [path.join(h.dataDir, 'common/versions/1.21.11/1.21.11.jar'),
                path.join(h.dataDir, 'common/libraries/org/test/vanilla.jar')].join(platform === 'win32' ? ';' : ':'))
        }
        assert.equal(h.calls.agents.length, 2)
        for (const options of h.calls.agents) {
            assert.equal(options.server, h.pb.server.rawServer)
            assert.equal(options.vanilla, h.vanilla)
            assert.equal(options.gameDir, h.pb.gameDir)
            assert.equal(options.commonDir, path.join(h.dataDir, 'common'))
            assert.equal(options.bundleDir, path.join(root, 'app/assets/font-cache-dev'))
        }
    })

    test(`ProcessBuilder aborts before Java spawn when cache integrity validation fails (${platform})`, () => {
        const failure = new Error('fixture integrity validation failure')
        const h = processBuilderHarness(true, platform, failure)
        assert.throws(() => h.pb.build(), error => error === failure)
        assert.equal(h.calls.agents.length, 1)
        assert.deepEqual(h.calls.spawn, [])
    })

    test(`normal ProcessBuilder preserves Fabric, user JVM options and production entry (${platform})`, () => {
        const h = processBuilderHarness(false, platform)
        h.pb.build()
        const [, args, options] = h.calls.spawn[0]
        assert.equal(h.calls.liteLoader, 1)
        assert.equal(h.calls.modConfig, 1)
        assert.equal(h.pb.usingFabricLoader, true)
        assert.equal(h.pb.modManifest, h.modManifest)
        assert.ok(args.includes(h.modManifest.mainClass))
        assert.ok(args.includes('-Dfabric.marker=true'))
        assert.ok(args.includes('--fabric-marker'))
        assert.ok(args.includes('-Duser.option=true'))
        assert.equal(args.some(arg => typeof arg === 'string' && arg.startsWith('-javaagent:')), false)
        assert.equal(args[args.indexOf('--quickPlayMultiplayer') + 1], 'barkan.kr:25565')
        assert.equal(options.cwd, path.join(h.dataDir, 'instances/barkan'))
        assert.ok(args[args.indexOf('-cp') + 1].includes('fabric-loader.jar'))
    })
}

function landingFunctions() {
    const text = source('app/assets/js/scripts/landing.js')
    const start = text.indexOf('async function syncExtraResourcePacks(')
    const end = text.indexOf('\nfunction setupShaderControls(', start)
    assert.ok(start >= 0 && end > start)
    const calls = []
    const context = vm.createContext({
        LoggerUtil: { getLogger: () => logger }, loggerLanding: logger, shaderWrites: [],
        setLaunchDetails() {},
        ConfigManager: { getDisabledMods: () => [], getShadersEnabled: () => false, getShaderQuality: () => 'low' },
        require(name) {
            if (name === 'path') return path
            assert.equal(name, 'electron')
            return { ipcRenderer: { on() {}, removeListener() {}, invoke: async (...args) => {
                calls.push(args)
                return { ok: true, status: 'installed', items: [], size: 1 }
            } } }
        }
    })
    vm.runInContext(text.slice(start, end) + '\nwriteIrisProperties = (...args) => shaderWrites.push(args)', context)
    return { context, calls }
}

test('dev launch preparation does not preload production packs, mods or shaders', async () => {
    const h = landingFunctions()
    h.context.pb = { fontCacheDev: true, gameDir: '/fixture/dev-game' }
    h.context.distro = { rawDistribution: FontCacheDev.distribution(JSON.parse(bundled),
        { BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: 'localhost:25567' }) }
    assert.equal(await vm.runInContext('syncResourcePackForLaunch(pb, distro)', h.context), null)
    assert.deepEqual(plain(await vm.runInContext('syncExtraResourcePacks(pb, distro)', h.context)), [])
    await vm.runInContext('syncRemoteMods(pb)', h.context)
    await vm.runInContext('syncShadersForLaunch(pb, distro)', h.context)
    assert.deepEqual(h.calls, [])
    assert.deepEqual(plain(h.context.shaderWrites), [])
})

test('normal launch preparation still downloads packs, syncs mods and applies shader preference', async () => {
    const h = landingFunctions()
    h.context.pb = { fontCacheDev: false, gameDir: '/fixture/normal-game',
        server: { rawServer: { address: 'barkan.kr:25565' }, hostname: 'barkan.kr', port: 25565 } }
    h.context.distro = { rawDistribution: JSON.parse(bundled) }
    assert.equal(await vm.runInContext('syncResourcePackForLaunch(pb, distro)', h.context), 'file/barkan-resourcepack.zip')
    const extras = await vm.runInContext('syncExtraResourcePacks(pb, distro)', h.context)
    assert.deepEqual(plain(extras), JSON.parse(bundled).extraResourcePacks.map(pack => `file/${pack.fileName}`))
    await vm.runInContext('syncRemoteMods(pb)', h.context)
    await vm.runInContext('syncShadersForLaunch(pb, distro)', h.context)
    assert.ok(h.calls.some(([channel]) => channel === 'syncServerResourcePack'))
    assert.ok(h.calls.some(([channel]) => channel === 'syncResourcePack'))
    assert.ok(h.calls.some(([channel]) => channel === 'syncMods'))
    assert.deepEqual(plain(h.context.shaderWrites), [['/fixture/normal-game', null]])
})
