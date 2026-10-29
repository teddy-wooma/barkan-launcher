const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const FontCacheDev = require('../app/assets/js/fontcachedev')

const PROFILE_ID = 'barkan-font-cache-dev'
const CLIENT_SHA1 = 'ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd'
const AGENTS = [
    { name: 'font-image-cache-agent.jar', sha256: 'fe68efc2eaaa8db3a139ee48eea59e779e05d231a444580deab0eac78c021c76', options: 'enabled=true' },
    { name: 'font-gpu-cache-agent.jar', sha256: 'c294ad8e72405106202588694d3f7a34de023d2a0eda1c1c24df542bbf5dc0b2', options: 'enabled=true,shareBitmapCells=true,poolPolicy=small-text,smallTextRawHeight=22,smallTextMaxRawWidth=32' }
]
const enabledEnv = { BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: '127.0.0.1:25567' }
const server = { id: PROFILE_ID, barkanFontCacheDev: true }
const vanilla = { id: '1.21.11', mainClass: 'net.minecraft.client.main.Main' }
const bundleDir = path.resolve(__dirname, '../app/assets/font-cache-dev')
const clientFixture = Buffer.from('offline official-client fixture; never executed')

function rawDistribution() {
    return {
        resourcePack: { manifestUrl: 'https://example.invalid/production-pack' },
        extraResourcePacks: [{ fileName: 'production-extra.zip' }],
        clientMods: [{ fileName: 'sodium.jar' }, { fileName: 'iris.jar' }],
        shaders: { high: { fileName: 'production-shaders.zip' } },
        servers: [
            { id: 'other', minecraftVersion: '1.21.11' },
            { id: 'barkan', minecraftVersion: '1.21.11', address: 'barkan.kr', modules: [{ id: 'fabric-loader' }] }
        ]
    }
}

function freeze(value) {
    if (value && typeof value === 'object') {
        Object.values(value).forEach(freeze)
        Object.freeze(value)
    }
    return value
}

// The official Minecraft JAR is not a repository fixture. Substitute only its
// known-good SHA1; agent SHA256s and all filesystem reads remain real. Changing
// the client bytes uses the real SHA1 and must fail the production validation.
function offlinePolicy() {
    const module = { exports: {} }
    vm.runInNewContext(fs.readFileSync(require.resolve('../app/assets/js/fontcachedev'), 'utf8'), {
        module, process: { env: {} }, URL,
        require(name) {
            if (name === 'fs') return fs
            if (name === 'path') return path
            assert.equal(name, 'crypto', `Unexpected dependency: ${name}`)
            return {
                createHash(algorithm) {
                    if (algorithm !== 'sha1') return crypto.createHash(algorithm)
                    const chunks = []
                    return {
                        update(bytes) { chunks.push(bytes); return this },
                        digest(encoding) {
                            const bytes = Buffer.concat(chunks)
                            return bytes.equals(clientFixture)
                                ? CLIENT_SHA1
                                : crypto.createHash(algorithm).update(bytes).digest(encoding)
                        }
                    }
                }
            }
        }
    }, { filename: 'fontcachedev.js' })
    return module.exports
}

function launchFixture(t, agentsDirectory = 'agent bundle') {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'barkan-fontcache-policy-'))
    t.after(() => fs.rmSync(root, { recursive: true, force: true }))
    const commonDir = path.join(root, 'common')
    const clientJar = path.join(commonDir, 'versions', '1.21.11', '1.21.11.jar')
    fs.mkdirSync(path.dirname(clientJar), { recursive: true })
    fs.writeFileSync(clientJar, clientFixture)
    const agents = path.join(root, agentsDirectory)
    fs.mkdirSync(agents)
    for (const agent of AGENTS) fs.copyFileSync(path.join(bundleDir, agent.name), path.join(agents, agent.name))
    const dataDir = path.join(root, 'isolated game')
    return {
        policy: offlinePolicy(), clientJar,
        options: {
            server, vanilla, commonDir, gameDir: path.join(dataDir, 'instances', PROFILE_ID), bundleDir: agents,
            env: { ...enabledEnv, BARKAN_DATA_DIR: dataDir }
        }
    }
}

test('font cache opt-in requires the exact environment flag, profile ID and boolean marker', () => {
    assert.equal(FontCacheDev.PROFILE_ID, PROFILE_ID)
    for (const flag of [undefined, '', '0', 'true', '01', 1, true]) {
        const env = { BARKAN_FONT_CACHE_DEV: flag }
        assert.equal(FontCacheDev.enabled(env), false)
        assert.equal(FontCacheDev.isProfile(server, env), false)
    }
    assert.equal(FontCacheDev.enabled(enabledEnv), true)
    assert.equal(FontCacheDev.isProfile(server, enabledEnv), true)
    for (const candidate of [null, undefined, {}, { id: 'barkan', barkanFontCacheDev: true },
        { id: PROFILE_ID }, { id: PROFILE_ID, barkanFontCacheDev: 'true' }, { id: PROFILE_ID, barkanFontCacheDev: 1 }]) {
        assert.equal(Boolean(FontCacheDev.isProfile(candidate, enabledEnv)), false)
    }
})

test('normal distribution is returned untouched, including production pack, mods and shaders', () => {
    const raw = freeze(rawDistribution())
    for (const env of [{}, { BARKAN_FONT_CACHE_DEV: '0' }]) {
        assert.equal(FontCacheDev.distribution(raw, env), raw)
    }
    const production = require('../app/assets/distribution.json')
    assert.equal(FontCacheDev.distribution(production, {}), production)
    assert(production.resourcePack)
    assert(production.clientMods.length > 0)
})

test('development distribution is a separate vanilla profile without production content synchronization', () => {
    const raw = freeze(rawDistribution())
    const before = JSON.stringify(raw)
    const dev = FontCacheDev.distribution(raw, enabledEnv)
    assert.equal(JSON.stringify(raw), before)
    assert.notEqual(dev, raw)
    assert.equal(dev.servers.length, 1)
    assert.equal(dev.servers[0].id, PROFILE_ID)
    assert.equal(dev.servers[0].minecraftVersion, '1.21.11')
    assert.equal(dev.servers[0].barkanFontCacheDev, true)
    assert.equal(dev.servers[0].address, '127.0.0.1:25567')
    assert.equal(dev.servers[0].autoconnect, true)
    assert.deepEqual(dev.servers[0].modules, raw.servers[1].modules, 'repair dependencies remain available')
    assert.notEqual(dev.servers[0].modules, raw.servers[1].modules)
    assert.equal(dev.resourcePack, null)
    assert.deepEqual(dev.extraResourcePacks, [])
    assert.deepEqual(dev.clientMods, [])
    assert.deepEqual(dev.shaders, {})
    const production = freeze(structuredClone(require('../app/assets/distribution.json')))
    assert.equal(FontCacheDev.distribution(production, enabledEnv).servers[0].id, PROFILE_ID)
})

test('development distribution validates the endpoint and requires a 1.21.11 source profile', () => {
    for (const address of ['127.0.0.1:1', 'localhost:25567', 'dev.example.invalid:65535', 'barkan.kr:25566']) {
        const dev = FontCacheDev.distribution(rawDistribution(), { ...enabledEnv, BARKAN_DEV_SERVER: address })
        assert.equal(dev.servers[0].address, address)
    }
    for (const address of [undefined, '', 'localhost', 'localhost:0', 'localhost:65536', 'localhost:-1',
        'localhost:abc', 'localhost:123456', ' localhost:25567', 'localhost:25567/path', 'tcp://localhost:25567']) {
        assert.throws(() => FontCacheDev.distribution(rawDistribution(), { ...enabledEnv, BARKAN_DEV_SERVER: address }))
    }
    for (const address of ['barkan.kr:25565', 'BARKAN.KR:25565']) {
        assert.throws(() => FontCacheDev.distribution(rawDistribution(), { ...enabledEnv, BARKAN_DEV_SERVER: address }), /운영 서버/)
    }
    for (const servers of [[], [{ id: 'other', minecraftVersion: '1.21.11' }], [{ id: 'barkan', minecraftVersion: '1.21.10' }]]) {
        assert.throws(() => FontCacheDev.distribution({ ...rawDistribution(), servers }, enabledEnv), /1\.21\.11/)
    }
})

test('development runtime discards loader arguments and rejects other clients; normal manifests retain identity', () => {
    const original = { mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient', arguments: { jvm: ['-Dfabric=true'], game: ['--loader'] } }
    const official = { ...vanilla, arguments: { jvm: ['vanilla-jvm'], game: ['vanilla-game'] } }
    assert.deepEqual(FontCacheDev.runtimeManifest(server, official, original, enabledEnv), {
        ...vanilla, arguments: { jvm: [], game: [] }
    })
    assert.equal(FontCacheDev.runtimeManifest(server, official, original, {}), original)
    assert.equal(FontCacheDev.runtimeManifest({ id: 'barkan' }, official, original, enabledEnv), original)
    for (const bad of [{ ...vanilla, id: '1.21.10' }, { ...vanilla, mainClass: original.mainClass }]) {
        assert.throws(() => FontCacheDev.runtimeManifest(server, bad, original, enabledEnv), /지원하지 않는/)
    }
})

test('both checked-in agents match independent pinned SHA256s in NativeImage then GPU order', () => {
    assert.equal(FontCacheDev.CLIENT_SHA1, CLIENT_SHA1)
    assert.deepEqual(FontCacheDev.AGENTS, AGENTS)
    for (const agent of AGENTS) {
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(bundleDir, agent.name))).digest('hex')
        assert.equal(digest, agent.sha256, agent.name)
    }
})

test('validated development arguments contain exactly the two ordered agents and fixed small-text options', t => {
    const { policy, options } = launchFixture(t)
    assert.deepEqual(Array.from(policy.jvmArguments(options)), AGENTS.map(agent =>
        '-javaagent:' + path.join(options.bundleDir, agent.name) + '=' + agent.options))
})

test('normal profiles never read client or agent files and receive no development arguments', () => {
    for (const [candidate, env] of [[server, {}], [{ id: 'barkan' }, enabledEnv], [{ id: PROFILE_ID }, enabledEnv]]) {
        // Omitted paths and manifest would throw if validation were reached.
        assert.deepEqual(FontCacheDev.jvmArguments({ server: candidate, env }), [])
    }
})

test('development launch rejects missing data isolation, a normal instance, and unsupported vanilla before agents', t => {
    const { policy, options } = launchFixture(t)
    assert.throws(() => policy.jvmArguments({ ...options, env: enabledEnv }), /격리/)
    for (const gameDir of [path.dirname(options.gameDir), path.join(options.env.BARKAN_DATA_DIR, 'instances', 'barkan'),
        path.join(options.gameDir, 'child')]) {
        assert.throws(() => policy.jvmArguments({ ...options, gameDir }), /격리/)
    }
    assert.throws(() => policy.jvmArguments({ ...options, vanilla: { ...vanilla, id: '1.21.10' } }), /지원하지 않는/)
    assert.throws(() => policy.jvmArguments({ ...options, vanilla: { ...vanilla, mainClass: 'fabric.Main' } }), /지원하지 않는/)
})

test('missing or modified official client fails closed before Javaagents are returned', t => {
    const { policy, options, clientJar } = launchFixture(t)
    fs.writeFileSync(clientJar, 'modified client')
    assert.throws(() => policy.jvmArguments(options), /클라이언트 원본 검증/)
    // Also exercise the real crypto implementation: fixture bytes are not a valid official client.
    fs.writeFileSync(clientJar, clientFixture)
    assert.throws(() => FontCacheDev.jvmArguments(options), /클라이언트 원본 검증/)
    fs.rmSync(clientJar)
    assert.throws(() => policy.jvmArguments(options), { code: 'ENOENT' })
})

test('each Javaagent independently rejects modified and missing files', t => {
    const { policy, options } = launchFixture(t)
    for (const agent of AGENTS) {
        const jar = path.join(options.bundleDir, agent.name)
        const original = fs.readFileSync(jar)
        fs.appendFileSync(jar, 'tampered')
        assert.throws(() => policy.jvmArguments(options), error => error.message.includes('검증에 실패') && error.message.includes(agent.name))
        fs.rmSync(jar)
        assert.throws(() => policy.jvmArguments(options), { code: 'ENOENT' })
        fs.writeFileSync(jar, original)
    }
})

test('agent paths containing commas are rejected before JVM argument parsing', t => {
    const { policy, options } = launchFixture(t, 'agent,bundle')
    assert.throws(() => policy.jvmArguments(options), /쉼표/)
})
