'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PROFILE_ID = 'barkan-font-cache-dev'
const CLIENT_SHA1 = 'ba2df812c2d12e0219c489c4cd9a5e1f0760f5bd'
const AGENTS = Object.freeze([
    { name: 'font-image-cache-agent.jar', sha256: 'fe68efc2eaaa8db3a139ee48eea59e779e05d231a444580deab0eac78c021c76', options: 'enabled=true' },
    { name: 'font-gpu-cache-agent.jar', sha256: 'c294ad8e72405106202588694d3f7a34de023d2a0eda1c1c24df542bbf5dc0b2', options: 'enabled=true,shareBitmapCells=true,poolPolicy=small-text,smallTextRawHeight=22,smallTextMaxRawWidth=32' }
])

function enabled(env = process.env) {
    return env.BARKAN_FONT_CACHE_DEV === '1'
}

function isProfile(server, env = process.env) {
    return enabled(env) && server?.id === PROFILE_ID && server.barkanFontCacheDev === true
}

function distribution(raw, env = process.env) {
    if (!enabled(env)) return raw
    const address = env.BARKAN_DEV_SERVER
    if (!address || !/^[^:\s/]+:\d{1,5}$/.test(address)) throw new Error('개발 서버 주소를 도메인 또는 IPv4:port 형식으로 지정해 주세요.')
    const endpoint = new URL('tcp://' + address)
    const port = Number(endpoint.port)
    if (!endpoint.hostname || port < 1 || port > 65535) throw new Error('개발 서버 주소가 올바르지 않습니다.')
    if (endpoint.hostname.toLowerCase() === 'barkan.kr' && port === 25565) throw new Error('운영 서버는 개발 프로필에서 사용할 수 없습니다.')
    const clone = JSON.parse(JSON.stringify(raw))
    const original = clone.servers.find(s => s.id === 'barkan')
    if (!original || original.minecraftVersion !== '1.21.11') throw new Error('공식 1.21.11 개발 프로필 원본이 없습니다.')
    // FullRepair requires a loader module even for a vanilla launch. Its Fabric
    // artifacts remain download-only dependencies; ProcessBuilder excludes them
    // from the runtime classpath and uses the official vanilla main class.
    original.id = PROFILE_ID
    original.name = '바르칸 개발용 · 글꼴 캐시'
    original.description = '공식 1.21.11 전용 개발 프로필'
    original.address = address
    original.autoconnect = true
    original.barkanFontCacheDev = true
    clone.servers = [original]
    clone.resourcePack = null
    clone.extraResourcePacks = []
    clone.clientMods = []
    clone.shaders = {}
    return clone
}

function runtimeManifest(server, vanilla, original, env = process.env) {
    if (!isProfile(server, env)) return original
    if (vanilla.id !== '1.21.11' || vanilla.mainClass !== 'net.minecraft.client.main.Main') throw new Error('지원하지 않는 개발 클라이언트입니다.')
    return { id: vanilla.id, mainClass: vanilla.mainClass, arguments: { jvm: [], game: [] } }
}

function jvmArguments({ server, vanilla, commonDir, gameDir, bundleDir, env = process.env }) {
    if (!isProfile(server, env)) return []
    runtimeManifest(server, vanilla, null, env)
    if (!env.BARKAN_DATA_DIR) throw new Error('개발 게임 폴더가 격리되지 않았습니다.')
    const expectedGameDir = path.resolve(env.BARKAN_DATA_DIR, 'instances', PROFILE_ID)
    if (path.resolve(gameDir) !== expectedGameDir) throw new Error('개발 게임 폴더가 격리되지 않았습니다.')
    const clientJar = path.join(commonDir, 'versions', '1.21.11', '1.21.11.jar')
    const clientDigest = crypto.createHash('sha1').update(fs.readFileSync(clientJar)).digest('hex')
    if (clientDigest !== CLIENT_SHA1) throw new Error('개발 클라이언트 원본 검증에 실패했습니다.')
    return AGENTS.map(agent => {
        const jar = path.resolve(bundleDir, agent.name)
        if (jar.includes(',')) throw new Error('개발 파일 경로에 쉼표를 사용할 수 없습니다.')
        const digest = crypto.createHash('sha256').update(fs.readFileSync(jar)).digest('hex')
        if (digest !== agent.sha256) throw new Error('글꼴 캐시 파일 검증에 실패했습니다: ' + agent.name)
        return '-javaagent:' + jar + '=' + agent.options
    })
}

module.exports = { PROFILE_ID, CLIENT_SHA1, AGENTS, enabled, isProfile, distribution, runtimeManifest, jvmArguments }
