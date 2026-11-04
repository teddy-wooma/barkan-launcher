'use strict'

// 런처가 설치하는 모드 목록과 각 파일의 SHA-512 는 런처 안(app/assets/mods.lock.json)에 들어 있습니다.
//
// 예전에는 PLAY 때마다 GitHub 의 mods.json 을 받아 거기 적힌 jar 와 모드린스 최신판을
// 검증 없이 mods 폴더에 넣었습니다. 그러면 목록 저장소나 모드 작성자 계정 하나만
// 털려도 모든 유저 PC 에서 그 코드가 실행됩니다(니케 런처 사고와 같은 구조).
// 이제 목록·버전·해시는 런처 빌드에 고정되고, 받은 파일은 해시가 맞을 때만 설치합니다.
// 목록을 바꾸려면 tools/lock-mods.cjs 로 잠금 파일을 다시 만들고 런처를 새로 배포합니다.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')

const STATE_FILE_PREFIX = '.barkan-mod-'
const DISABLED_DIR = 'mods-disabled'
const DEFAULT_ALLOWED_HOSTS = Object.freeze(['cdn.modrinth.com', 'raw.githubusercontent.com'])

const SHA512_PATTERN = /^[0-9a-f]{128}$/
const SLUG_PATTERN = /^[0-9A-Za-z._-]+$/
const JAR_NAME_PATTERN = /^[^./\\][^/\\]*\.jar$/i

function isSha512(value) {
    return typeof value === 'string' && SHA512_PATTERN.test(value)
}

function isJarName(value) {
    return typeof value === 'string' && JAR_NAME_PATTERN.test(value) && !value.includes('..')
}

// https 이고 허용한 호스트일 때만 주소를 돌려줍니다. (http 는 테스트용 루프백만)
function checkDownloadUrl(value, allowedHosts) {
    let parsed
    try {
        parsed = new URL(value)
    } catch (_err) {
        return null
    }
    if(parsed.username || parsed.password){
        return null
    }
    const host = parsed.hostname.toLowerCase()
    if(!allowedHosts.includes(host)){
        return null
    }
    const loopback = host === '127.0.0.1' || host === 'localhost'
    if(parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)){
        return null
    }
    return parsed.href
}

function validateLock(raw, options = {}) {
    const allowedHosts = (options.allowedHosts || DEFAULT_ALLOWED_HOSTS).map(h => String(h).toLowerCase())
    if(raw == null || typeof raw !== 'object' || !Array.isArray(raw.mods)){
        throw new Error('모드 잠금 파일 형식이 올바르지 않습니다.')
    }

    const seenUrls = new Set()
    const seenSlugs = new Set()
    const seenFiles = new Set()

    const mods = raw.mods.map((entry, index) => {
        const fail = reason => new Error(`모드 잠금 파일 mods[${index}]: ${reason}`)
        if(entry == null || typeof entry !== 'object'){
            throw fail('항목이 비어 있습니다.')
        }
        const { name, url, slug, required, version, fileName, downloadUrl, size, sha512 } = entry
        if(typeof name !== 'string' || name.length === 0){
            throw fail('name 이 없습니다.')
        }
        if(typeof url !== 'string' || url.length === 0){
            throw fail('url 이 없습니다.')
        }
        if(typeof slug !== 'string' || !SLUG_PATTERN.test(slug)){
            throw fail(`slug 가 올바르지 않습니다: ${slug}`)
        }
        if(typeof required !== 'boolean'){
            throw fail('required 는 true/false 여야 합니다.')
        }
        if(!isJarName(fileName)){
            throw fail(`fileName 이 올바르지 않습니다: ${fileName}`)
        }
        const href = checkDownloadUrl(downloadUrl, allowedHosts)
        if(href == null){
            throw fail(`허용되지 않은 다운로드 주소입니다: ${downloadUrl}`)
        }
        if(!Number.isSafeInteger(size) || size <= 0){
            throw fail('size 가 올바르지 않습니다.')
        }
        if(!isSha512(sha512)){
            throw fail('sha512 가 올바르지 않습니다.')
        }
        for(const [set, key, label] of [[seenUrls, url, 'url'], [seenSlugs, slug, 'slug'], [seenFiles, fileName.toLowerCase(), 'fileName']]){
            if(set.has(key)){
                throw fail(`${label} 가 중복됩니다: ${key}`)
            }
            set.add(key)
        }

        return Object.freeze({
            name,
            url,
            slug,
            required,
            version: typeof version === 'string' ? version : '',
            fileName,
            downloadUrl: href,
            size,
            sha512
        })
    })

    return Object.freeze({ mods: Object.freeze(mods) })
}

function loadLockSync(file, options) {
    return validateLock(JSON.parse(fs.readFileSync(file, 'utf8')), options)
}

async function sha512OfFile(file) {
    try {
        const hash = crypto.createHash('sha512')
        for await (const chunk of fs.createReadStream(file)){
            hash.update(chunk)
        }
        return hash.digest('hex')
    } catch (err) {
        if(err.code === 'ENOENT' || err.code === 'EISDIR'){
            return null
        }
        throw err
    }
}

// 임시 파일(.part)로 받고, 크기와 SHA-512 가 맞을 때만 제자리로 옮깁니다.
// 맞지 않으면 임시 파일을 지우고 실패합니다. (mods 폴더에 검증 안 된 jar 가 남지 않습니다)
async function downloadVerified({ url, destination, sha512, size, fetchImpl = globalThis.fetch, userAgent = 'BarkanLauncher', onProgress, timeoutMs = 30 * 60 * 1000 }) {
    if(!isSha512(sha512)){
        throw new Error('검증할 SHA-512 가 없어 내려받지 않습니다.')
    }
    const expectedSize = Number.isSafeInteger(size) && size > 0 ? size : null
    const temp = `${destination}.part`
    await fs.promises.mkdir(path.dirname(destination), { recursive: true })
    await fs.promises.rm(temp, { force: true })

    try {
        const response = await fetchImpl(url, {
            redirect: 'follow',
            headers: { 'user-agent': userAgent },
            signal: AbortSignal.timeout(timeoutMs)
        })
        if(!response.ok){
            throw new Error(`HTTP ${response.status}`)
        }

        const total = Number(response.headers.get('content-length') || 0) || expectedSize || 0
        const hash = crypto.createHash('sha512')
        let received = 0
        let lastReport = 0
        const counter = new Transform({
            transform(chunk, encoding, callback) {
                received += chunk.length
                if(expectedSize != null && received > expectedSize){
                    callback(new Error(`파일이 예상보다 큽니다. (예상 ${expectedSize}B)`))
                    return
                }
                hash.update(chunk)
                if(onProgress && (received - lastReport > 512 * 1024 || received === total)){
                    lastReport = received
                    onProgress(received, total)
                }
                callback(null, chunk)
            }
        })

        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(temp))

        const digest = hash.digest('hex')
        if(expectedSize != null && received !== expectedSize){
            throw new Error(`크기가 다릅니다. (받은 ${received}B / 예상 ${expectedSize}B)`)
        }
        if(digest !== sha512){
            throw new Error(`SHA-512 가 다릅니다. 파일이 바뀌었을 수 있어 설치하지 않습니다. (받은 ${digest.slice(0, 16)}… / 예상 ${sha512.slice(0, 16)}…)`)
        }

        await fs.promises.rename(temp, destination)
        return { size: received, sha512: digest, etag: response.headers.get('etag') || null }
    } catch (err) {
        await fs.promises.rm(temp, { force: true }).catch(() => {})
        throw err
    }
}

async function isFile(target) {
    try {
        return (await fs.promises.stat(target)).isFile()
    } catch (_err) {
        return false
    }
}

async function readState(target) {
    try {
        const parsed = JSON.parse(await fs.promises.readFile(target, 'utf8'))
        return parsed != null && typeof parsed === 'object' ? parsed : null
    } catch (_err) {
        return null
    }
}

async function moveIfExists(from, to) {
    if(!(await isFile(from))){
        return false
    }
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    await fs.promises.rm(to, { force: true })
    await fs.promises.rename(from, to)
    return true
}

async function writeState(statePath, entry) {
    await fs.promises.writeFile(statePath, JSON.stringify({
        slug: entry.slug,
        name: entry.name,
        version: entry.version,
        fileName: entry.fileName,
        size: entry.size,
        sha512: entry.sha512
    }, null, 2), 'utf8')
}

function directories(directory) {
    return {
        modsDir: path.join(directory, 'mods'),
        disabledDir: path.join(directory, DISABLED_DIR)
    }
}

// 예전 런처가 남긴 상태 파일(.barkan-mod-<slug>.json)에서 설치된 파일 이름을 읽습니다.
async function inspect(entry, dirs) {
    const statePath = path.join(dirs.modsDir, `${STATE_FILE_PREFIX}${entry.slug}.json`)
    const state = await readState(statePath)
    const recorded = state != null && typeof state.fileName === 'string' ? path.basename(state.fileName) : null
    const installedName = isJarName(recorded) ? recorded : entry.fileName
    return {
        statePath,
        state,
        installedName,
        version: state != null && typeof state.version === 'string' ? state.version : null,
        inMods: await isFile(path.join(dirs.modsDir, installedName)),
        inDisabled: await isFile(path.join(dirs.disabledDir, installedName))
    }
}

async function install(entry, dirs, inspected, context) {
    if(inspected.installedName !== entry.fileName){
        await fs.promises.rm(path.join(dirs.modsDir, inspected.installedName), { force: true })
        await fs.promises.rm(path.join(dirs.disabledDir, inspected.installedName), { force: true })
    }
    await downloadVerified({
        url: entry.downloadUrl,
        destination: path.join(dirs.modsDir, entry.fileName),
        sha512: entry.sha512,
        size: entry.size,
        fetchImpl: context.fetchImpl,
        userAgent: context.userAgent
    })
    await writeState(inspected.statePath, entry)
}

function newItem(entry, enabled) {
    return {
        name: entry.name,
        url: entry.url,
        slug: entry.slug,
        required: entry.required,
        enabled,
        status: 'failed',
        latestVersion: entry.version,
        fileName: entry.fileName,
        version: null
    }
}

function isEnabled(entry, disabled) {
    // 필수 모드는 끌 수 없습니다. (설정 화면에도 토글이 없습니다)
    return entry.required || !disabled.has(entry.url)
}

async function syncMods({ directory, disabledUrls, lock, fetchImpl, userAgent, log = () => {} }) {
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }
    const dirs = directories(directory)
    await fs.promises.mkdir(dirs.modsDir, { recursive: true })
    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])
    const context = { fetchImpl, userAgent }

    const items = []
    const failures = []

    for(const entry of lock.mods){
        const enabled = isEnabled(entry, disabled)
        const item = newItem(entry, enabled)

        try {
            const inspected = await inspect(entry, dirs)
            item.version = inspected.version
            item.fileName = inspected.installedName
            const inModsPath = path.join(dirs.modsDir, inspected.installedName)

            if(!enabled){
                if(inspected.inMods){
                    await moveIfExists(inModsPath, path.join(dirs.disabledDir, inspected.installedName))
                }
                item.status = 'disabled'
                items.push(item)
                continue
            }

            if(inspected.inDisabled && !inspected.inMods){
                await moveIfExists(path.join(dirs.disabledDir, inspected.installedName), inModsPath)
            }
            const present = inspected.inMods || inspected.inDisabled
            const digest = present ? await sha512OfFile(inModsPath) : null

            if(digest === entry.sha512){
                if(inspected.state == null || inspected.state.sha512 !== entry.sha512){
                    await writeState(inspected.statePath, { ...entry, fileName: inspected.installedName })
                }
                item.status = 'installed'
                item.version = entry.version
            } else if(!present || entry.required){
                // 없거나, 필수 모드인데 내용이 잠금 파일과 다르면 검증된 파일로 바꿉니다.
                await install(entry, dirs, inspected, context)
                if(present){
                    item.autoUpdated = true
                    log(`필수 모드를 잠금 파일 버전으로 맞췄습니다: ${entry.name} (${inspected.version || '?'} -> ${entry.version})`)
                }
                item.status = 'installed'
                item.version = entry.version
                item.fileName = entry.fileName
            } else {
                // 선택 모드는 사용자가 업데이트 버튼을 누를 때만 바꿉니다.
                item.status = 'outdated'
                item.updateAvailable = true
            }
        } catch (err) {
            item.status = 'failed'
            item.reason = err.message
            failures.push(`${entry.name}: ${err.message}`)
        }
        items.push(item)
    }

    return {
        ok: failures.length === 0,
        items,
        reason: failures.length > 0 ? failures.join('\n') : null
    }
}

async function getModStatus({ directory, disabledUrls, lock }) {
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }
    const dirs = directories(directory)
    await fs.promises.mkdir(dirs.modsDir, { recursive: true })
    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])

    const items = []
    for(const entry of lock.mods){
        const item = newItem(entry, isEnabled(entry, disabled))
        try {
            const inspected = await inspect(entry, dirs)
            item.version = inspected.version
            item.fileName = inspected.installedName

            if(!inspected.inMods && !inspected.inDisabled){
                item.status = 'missing'
            } else if(!item.enabled){
                item.status = 'disabled'
            } else if(inspected.inDisabled && !inspected.inMods){
                item.status = 'toEnable'
            } else if(await sha512OfFile(path.join(dirs.modsDir, inspected.installedName)) === entry.sha512){
                item.status = 'installed'
                item.version = entry.version
            } else {
                item.status = 'outdated'
                item.updateAvailable = true
            }
        } catch (err) {
            item.reason = err.message
        }
        items.push(item)
    }

    return { ok: true, items }
}

async function updateMod({ directory, url, lock, fetchImpl, userAgent }) {
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.' }
    }
    const entry = lock.mods.find(m => m.url === url)
    if(entry == null){
        return { ok: false, reason: '런처 모드 목록에 없는 모드입니다.' }
    }

    try {
        const dirs = directories(directory)
        await fs.promises.mkdir(dirs.modsDir, { recursive: true })
        const inspected = await inspect(entry, dirs)
        await install(entry, dirs, inspected, { fetchImpl, userAgent })
        return { ok: true, version: entry.version, fileName: entry.fileName }
    } catch (err) {
        return { ok: false, reason: err.message }
    }
}

module.exports = {
    STATE_FILE_PREFIX,
    DISABLED_DIR,
    DEFAULT_ALLOWED_HOSTS,
    isSha512,
    isJarName,
    validateLock,
    loadLockSync,
    sha512OfFile,
    downloadVerified,
    syncMods,
    getModStatus,
    updateMod
}
