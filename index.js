const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const path                              = require('path')
const semver                            = require('semver')
const { spawn }                         = require('child_process')
const { Readable, Transform }           = require('stream')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const crypto                            = require('crypto')
const LangLoader                        = require('./app/assets/js/langloader')
const NbtUtil                           = require('./app/assets/js/nbtutil')

LangLoader.setupLanguage()

function initAutoUpdater(event, data) {

    if(data){
        autoUpdater.allowPrerelease = true
    } else {
    }
    
    if(isDev){
        autoUpdater.autoInstallOnAppQuit = false
        autoUpdater.updateConfigPath = path.join(__dirname, 'dev-app-update.yml')
    }
    if(process.platform === 'darwin'){
        autoUpdater.autoDownload = false
    }
    autoUpdater.on('update-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-available', info)
    })
    autoUpdater.on('update-downloaded', (info) => {
        event.sender.send('autoUpdateNotification', 'update-downloaded', info)
    })
    autoUpdater.on('update-not-available', (info) => {
        event.sender.send('autoUpdateNotification', 'update-not-available', info)
    })
    autoUpdater.on('checking-for-update', () => {
        event.sender.send('autoUpdateNotification', 'checking-for-update')
    })
    autoUpdater.on('error', (err) => {
        event.sender.send('autoUpdateNotification', 'realerror', err)
    }) 
}

ipcMain.on('autoUpdateAction', (event, arg, data) => {
    switch(arg){
        case 'initAutoUpdater':
            console.log('Initializing auto updater.')
            initAutoUpdater(event, data)
            event.sender.send('autoUpdateNotification', 'ready')
            break
        case 'checkForUpdate':
            autoUpdater.checkForUpdates()
                .catch(err => {
                    event.sender.send('autoUpdateNotification', 'realerror', err)
                })
            break
        case 'allowPrereleaseChange':
            if(!data){
                const preRelComp = semver.prerelease(app.getVersion())
                if(preRelComp != null && preRelComp.length > 0){
                    autoUpdater.allowPrerelease = true
                } else {
                    autoUpdater.allowPrerelease = data
                }
            } else {
                autoUpdater.allowPrerelease = data
            }
            break
        case 'installUpdateNow':
            if(process.platform === 'darwin'){
                // 서명이 없어 electron-updater 로는 설치할 수 없습니다.
                runMacSelfUpdate(event)
            } else {
                autoUpdater.quitAndInstall()
            }
            break
        default:
            console.log('Unknown argument', arg)
            break
    }
})
// 배포 인덱스는 preloader 가 렌더러 스크립트보다 먼저 끝나므로, 렌더러가 'dom-ready' 를 알리기 전까지
// 결과를 큐에 쌓아 둡니다. 그대로 보내면 메시지가 사라져 로딩 화면에서 멈춥니다.
const rendererDomReady = new WeakSet()
const pendingDistributionIndex = new WeakMap()

function sendDistributionIndexDone(webContents, res) {
    if (webContents.isDestroyed()) {
        return
    }
    webContents.send('distributionIndexDone', res === true)
}

function flushDistributionIndexDone(webContents) {
    if (!pendingDistributionIndex.has(webContents)) {
        return
    }
    const res = pendingDistributionIndex.get(webContents)
    pendingDistributionIndex.delete(webContents)
    sendDistributionIndexDone(webContents, res)
}

ipcMain.on('distributionIndexDone', (event, res) => {
    const webContents = event.sender
    if (rendererDomReady.has(webContents)) {
        sendDistributionIndexDone(webContents, res)
    } else {
        pendingDistributionIndex.set(webContents, res === true)
    }
})

ipcMain.handle(SHELL_OPCODE.TRASH_ITEM, async (event, ...args) => {
    try {
        await shell.trashItem(args[0])
        return {
            result: true
        }
    } catch(error) {
        return {
            result: false,
            error: error
        }
    }
})

// Windows 에서는 shell.openExternal 이 아무것도 열지 않고 성공하는 경우가 있어 cmd /c start 를 먼저 시도합니다.
function openExternalUrl(url) {
    if(process.platform === 'win32'){
        try {
            const child = spawn('cmd', ['/c', 'start', '', url], {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
            })
            child.unref()
            return
        } catch (err) {
            console.error('[Links] cmd start 실패, shell.openExternal 로 재시도합니다.', err)
        }
    }
    shell.openExternal(url).catch(err => {
        console.error('[Links] 브라우저를 열지 못했습니다:', url, err)
    })
}

ipcMain.handle('openExternal', (event, url) => {
    if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
        console.error('[Links] 허용되지 않은 URL 입니다:', url)
        return false
    }
    openExternalUrl(url)
    return true
})

// 렌더러는 file:// 로 돌고 커뮤니티 사이트는 CORS 헤더를 보내지 않아, 메인 프로세스에서 대신 받아옵니다.
async function fetchNewsPage(url) {
    const response = await fetch(url, {
        headers: {
            'user-agent': `BarkanLauncher/${app.getVersion()}`,
            accept: 'text/html,application/xhtml+xml'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }
    return await response.text()
}

ipcMain.handle('fetchNews', (event, url) => {
    if(typeof url !== 'string' || !/^https?:\/\//i.test(url)){
        return Promise.reject(new Error(`허용되지 않은 주소입니다: ${url}`))
    }
    return fetchNewsPage(url)
})

// preload 는 @electron/remote 가 준비되기 전에 돌아 ConfigManager 를 쓸 수 없고, 언어는 EJS 렌더링 전에 정해져야 하므로 config.json 을 직접 읽습니다.
function readConfiguredLanguage() {
    const candidates = [
        path.join(app.getPath('userData'), 'config.json'),
        path.join(app.getPath('appData'), '.barkanlauncher', 'config.json')
    ]
    for(const candidate of candidates){
        try {
            const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'))
            const value = parsed?.settings?.launcher?.language
            if(typeof value === 'string' && value.length > 0){
                return value
            }
        } catch (err) {
        }
    }
    return 'ko_KR'
}

ipcMain.on('getLanguage', (event) => {
    event.returnValue = readConfiguredLanguage()
})

// webContents.reload 로는 EJS 문구가 그대로 남고 앱 재시작은 돌아오지 않는 경우가 있어, loadURL 로 다시 그리고 메인 쪽 언어도 다시 읽습니다.
ipcMain.on('rerenderWindow', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if(win == null){
        return
    }
    LangLoader.setupLanguage()
    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())
})

const RESOURCE_PACK_STATE_FILE_PREFIX = '.barkan-file-'

async function fileSizeIfExists(target) {
    try {
        const stats = await fs.promises.stat(target)
        return stats.isFile() ? stats.size : null
    } catch (err) {
        return null
    }
}

async function readJsonIfExists(target) {
    try {
        return JSON.parse(await fs.promises.readFile(target, 'utf8'))
    } catch (err) {
        return null
    }
}

// releases/latest/download 는 releases/download/<태그>/... 로 리다이렉트되므로 그 주소에서 태그를 읽습니다. (GitHub API 요청 제한 없음)
async function resolveLatestRelease(url) {
    const manual = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })

    let version = null
    const location = manual.headers.get('location')
    if(location){
        const match = /\/releases\/download\/([^/]+)\//.exec(location)
        if(match){
            version = decodeURIComponent(match[1])
        }
    }

    if(manual.status >= 200 && manual.status < 300){
        return {
            version,
            size: Number(manual.headers.get('content-length') || 0),
            etag: manual.headers.get('etag') || null
        }
    }

    const followed = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })
    if(!followed.ok){
        throw new Error(`HTTP ${followed.status}`)
    }
    return {
        version,
        size: Number(followed.headers.get('content-length') || 0),
        etag: followed.headers.get('etag') || null
    }
}

async function downloadToFile(url, destination, onProgress, expectedSha1) {
    const response = await fetch(url, {
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(30 * 60 * 1000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }

    const total = Number(response.headers.get('content-length') || 0)
    let received = 0
    let lastReport = 0
    const hash = expectedSha1 ? crypto.createHash('sha1') : null
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length
            if(hash != null){
                hash.update(chunk)
            }
            if(onProgress && (received - lastReport > 512 * 1024 || received === total)){
                lastReport = received
                onProgress(received, total)
            }
            callback(null, chunk)
        }
    })

    const { pipeline } = require('stream/promises')
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destination))

    const sha1 = hash != null ? hash.digest('hex') : null
    if(expectedSha1 && sha1 !== String(expectedSha1).toLowerCase()){
        throw new Error(`SHA1 이 다릅니다 (받은 ${sha1} / 예상 ${expectedSha1})`)
    }

    return { size: received, total, etag: response.headers.get('etag') || null, sha1 }
}

// 매니페스트와 SHA1 이 같으면 건너뛰고, zip 을 풀거나 다시 압축하지 않습니다. (그러면 SHA1 이 달라집니다)
ipcMain.handle('syncServerResourcePack', async (event, options) => {
    const { directory, manifestUrl, fileName } = options || {}

    if(typeof directory !== 'string' || directory.length === 0){
        return { status: 'failed', reason: '게임 폴더를 알 수 없습니다.' }
    }
    if(typeof manifestUrl !== 'string' || !/^https:\/\//i.test(manifestUrl)){
        return { status: 'failed', reason: `허용되지 않은 매니페스트 주소입니다: ${manifestUrl}` }
    }

    const safeName = path.basename(fileName || 'barkan-resourcepack.zip')
    const packDir = path.join(directory, 'resourcepacks')
    const target = path.join(packDir, safeName)
    const statePath = path.join(packDir, `${RESOURCE_PACK_STATE_FILE_PREFIX}${safeName}.json`)

    try {
        await fs.promises.mkdir(packDir, { recursive: true })

        const manifest = await fetchJson(manifestUrl, 20000)
        const sha1 = String(manifest.sha1 || '').toLowerCase()
        const url = String(manifest.url || '')
        const expectedSize = Number(manifest.size || 0)

        if(!/^[0-9a-f]{40}$/.test(sha1)){
            throw new Error(`매니페스트의 SHA1 이 올바르지 않습니다: ${manifest.sha1}`)
        }
        if(!/^https:\/\//i.test(url)){
            throw new Error(`매니페스트의 주소가 올바르지 않습니다: ${manifest.url}`)
        }

        const installedSize = await fileSizeIfExists(target)
        const state = await readJsonIfExists(statePath)

        if(installedSize != null && installedSize > 0 && state != null
            && String(state.sha1 || '').toLowerCase() === sha1
            && (expectedSize === 0 || installedSize === expectedSize)){
            console.log(`[ResourcePack] 이미 최신입니다: ${sha1.slice(0, 12)}…`)
            return { status: 'skipped', size: installedSize, sha1, version: sha1 }
        }

        const previousName = state != null && typeof state.fileName === 'string'
            ? path.basename(state.fileName)
            : null
        if(previousName != null && previousName !== safeName){
            await fs.promises.rm(path.join(packDir, previousName), { force: true })
        }
        await fs.promises.rm(target, { force: true })
        await fs.promises.rm(statePath, { force: true })

        const temp = `${target}.part`
        console.log(`[ResourcePack] 내려받는 중: ${safeName} (${(expectedSize / 1048576).toFixed(1)} MB)`)
        const result = await downloadToFile(url, temp, (received, total) => {
            if(!event.sender.isDestroyed()){
                event.sender.send('resourcePackProgress', { received, total })
            }
        }, sha1)

        await fs.promises.rename(temp, target)
        await fs.promises.writeFile(statePath, JSON.stringify({
            url,
            fileName: safeName,
            sha1,
            size: result.size,
            publishedAt: manifest.published_at || null,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8')

        console.log(`[ResourcePack] 설치 완료: ${safeName} sha1=${sha1.slice(0, 12)}… (${(result.size / 1048576).toFixed(1)} MB)`)
        return { status: 'installed', size: result.size, sha1, version: sha1 }
    } catch (err) {
        console.warn('[ResourcePack] 내려받지 못했습니다:', err.message)
        try {
            await fs.promises.rm(`${target}.part`, { force: true })
        } catch (cleanupErr) {  }

        const existing = await fileSizeIfExists(target)
        return existing != null
            ? { status: 'kept', size: existing, reason: err.message }
            : { status: 'failed', reason: err.message }
    }
})

ipcMain.handle('syncResourcePack', async (event, options) => {
    const { url, directory, subdirectory, fileName } = options || {}

    if(typeof url !== 'string' || !/^https:\/\//i.test(url)){
        return { status: 'failed', reason: `허용되지 않은 주소입니다: ${url}` }
    }
    if(typeof directory !== 'string' || typeof fileName !== 'string'){
        return { status: 'failed', reason: '저장 위치가 올바르지 않습니다.' }
    }

    const safeName = path.basename(fileName)
    const safeFolder = path.basename(subdirectory || 'resourcepacks')
    const packDir = path.join(directory, safeFolder)
    const target = path.join(packDir, safeName)
    const statePath = path.join(packDir, `${RESOURCE_PACK_STATE_FILE_PREFIX}${safeName}.json`)

    try {
        await fs.promises.mkdir(packDir, { recursive: true })

        let latest = null
        try {
            latest = await resolveLatestRelease(url)
        } catch (err) {
            console.warn('[ResourcePack] 최신 정보를 확인하지 못했습니다:', err.message)
        }

        const installedSize = await fileSizeIfExists(target)
        const installed = installedSize != null && installedSize > 0
        const state = await readJsonIfExists(statePath)
        const havePack = installed

        const upToDate = latest != null && havePack && (
            (latest.version != null && state != null && state.version === latest.version &&
                (latest.size === 0 || installedSize === latest.size)) ||
            (latest.version == null && latest.size > 0 && installedSize === latest.size)
        )

        if(upToDate){
            console.log(`[ResourcePack] 이미 최신입니다: ${latest.version || '(태그 없음)'}`)
            return { status: 'skipped', size: installedSize, version: latest.version }
        }

        if(latest == null && havePack){
            console.log('[ResourcePack] 최신 버전을 확인할 수 없어 가진 팩을 그대로 사용합니다.')
            return { status: 'kept', size: installedSize, reason: '최신 버전을 확인하지 못했습니다.' }
        }

        if(havePack){
            console.log(`[ResourcePack] 새 버전을 발견해 교체합니다: ${state && state.version ? state.version : '알 수 없음'} -> ${latest && latest.version ? latest.version : '알 수 없음'}`)
            await fs.promises.rm(target, { force: true })
        }
        await fs.promises.rm(statePath, { force: true })

        const temp = `${target}.part`
        console.log(`[ResourcePack] 내려받는 중: ${safeName}`)
        const result = await downloadToFile(url, temp, (received, total) => {
            if(!event.sender.isDestroyed()){
                event.sender.send('resourcePackProgress', { received, total })
            }
        })

        if(latest != null && latest.size > 0 && result.size !== latest.size){
            throw new Error(`크기가 다릅니다 (받은 ${result.size} / 예상 ${latest.size})`)
        }

        await fs.promises.rename(temp, target)
        await fs.promises.writeFile(statePath, JSON.stringify({
            url,
            fileName: safeName,
            version: latest ? latest.version : null,
            size: result.size,
            etag: result.etag,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8')

        console.log(`[ResourcePack] 설치 완료: ${safeName} ${latest && latest.version ? latest.version : ''} (${(result.size / 1048576).toFixed(1)} MB)`)
        return { status: 'installed', size: result.size, version: latest ? latest.version : null }
    } catch (err) {
        console.warn('[ResourcePack] 내려받지 못했습니다:', err.message)
        try {
            await fs.promises.rm(`${target}.part`, { force: true })
        } catch (cleanupErr) {  }

        const existing = await fileSizeIfExists(target)
        return existing != null
            ? { status: 'kept', size: existing, reason: err.message }
            : { status: 'failed', reason: err.message }
    }
})

app.disableHardwareAcceleration()


const MOD_LIST_URL = 'https://raw.githubusercontent.com/teddy-wooma/FISH_MOD_LIST/refs/heads/main/mods.json'
const MODRINTH_API = 'https://api.modrinth.com/v2'
const MOD_LOADER = 'fabric'
const MOD_GAME_VERSION = '1.21.11'
const MOD_STATE_FILE_PREFIX = '.barkan-mod-'
// 모드를 끄면 파일을 지우지 않고 이 폴더로 옮깁니다. (지웠다 다시 받으면 그 모드가 쓰던 설정이 사라집니다)
const MOD_DISABLED_DIR = 'mods-disabled'

async function fetchJson(url, timeoutMs = 15000) {
    const response = await fetch(url, {
        headers: {
            'user-agent': `BarkanLauncher/${app.getVersion()}`,
            accept: 'application/json'
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }
    return JSON.parse(await response.text())
}

function modrinthSlug(url) {
    const match = /modrinth\.com\/mod\/([^/?#]+)/i.exec(String(url || ''))
    return match ? match[1] : null
}

async function resolveModrinthVersion(slug) {
    const base = `loaders=${encodeURIComponent(JSON.stringify([MOD_LOADER]))}`
        + `&game_versions=${encodeURIComponent(JSON.stringify([MOD_GAME_VERSION]))}`

    // 릴리즈를 먼저 찾고, 없으면 베타를 씁니다.
    // 나중에 릴리즈가 나오면 버전 번호가 달라지므로 자동으로 갈아탑니다.
    for(const channel of ['release', 'beta']){
        const list = await fetchJson(
            `${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?${base}&version_type=${channel}`
        )
        if(!Array.isArray(list) || list.length === 0){
            continue
        }

        const version = list[0]
        const files = Array.isArray(version.files) ? version.files : []
        const file = files.find(f => f.primary === true) || files[0]
        if(file == null || !file.url){
            continue
        }

        return {
            version: String(version.version_number || ''),
            fileName: path.basename(file.filename),
            url: file.url,
            size: Number(file.size || 0),
            channel
        }
    }

    return null
}

async function ensureServerEntry(directory, address) {
    if(typeof directory !== 'string' || directory.length === 0){
        return false
    }
    if(typeof address !== 'string' || address.length === 0){
        return false
    }

    const target = path.join(directory, 'servers.dat')
    let current = null
    try {
        current = await fs.promises.readFile(target)
    } catch (err) {
        current = null
    }

    const updated = NbtUtil.ensureServer(current, { name: '바르칸 열도', ip: address })
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(target, updated)
    return true
}

async function fetchModList() {
    const parsed = await fetchJson(MOD_LIST_URL)
    const pick = list => (Array.isArray(list) ? list : [])
        .filter(m => m != null && typeof m.url === 'string' && m.url.length > 0)
        .map(m => ({ name: String(m.name || m.url), url: m.url }))

    return { required: pick(parsed.required), optional: pick(parsed.optional) }
}

function directJarUrl(url) {
    const text = String(url || '')
    const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/i.exec(text)
    if(blob != null){
        return `https://raw.githubusercontent.com/${blob[1]}/${blob[2]}/${blob[3]}`
    }
    return /^https?:\/\//i.test(text) ? text : null
}

function modStateKey(url) {
    const slug = modrinthSlug(url)
    if(slug != null){
        return slug
    }
    const direct = directJarUrl(url)
    if(direct == null){
        return null
    }
    const name = decodeURIComponent(direct.split('/').pop() || '')
    return name.length > 0 ? name.replace(/[^0-9A-Za-z._-]/g, '_') : null
}

async function resolveModTarget(url) {
    const slug = modrinthSlug(url)
    if(slug != null){
        return await resolveModrinthVersion(slug)
    }

    const direct = directJarUrl(url)
    if(direct == null){
        return null
    }

    const response = await fetch(direct, {
        method: 'HEAD',
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(15000)
    })
    if(!response.ok){
        throw new Error(`HTTP ${response.status}`)
    }

    const fileName = decodeURIComponent((new URL(response.url).pathname.split('/').pop()) || '')
    if(fileName.length === 0){
        throw new Error('파일 이름을 알 수 없습니다.')
    }

    const etag = response.headers.get('etag') || response.headers.get('last-modified') || ''
    const size = Number(response.headers.get('content-length') || 0)

    return {
        version: etag.length > 0 ? etag : `size:${size}`,
        fileName: path.basename(fileName),
        url: direct,
        size
    }
}

async function moveFileIfExists(from, to) {
    if(await fileSizeIfExists(from) == null){
        return false
    }
    await fs.promises.mkdir(path.dirname(to), { recursive: true })
    await fs.promises.rm(to, { force: true })
    await fs.promises.rename(from, to)
    return true
}

async function writeModState(statePath, data) {
    await fs.promises.writeFile(statePath, JSON.stringify(data, null, 2), 'utf8')
}

ipcMain.handle('syncMods', async (event, options) => {
    const { directory, disabledUrls, serverAddress } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }

    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])

    let list
    try {
        list = await fetchModList()
    } catch (err) {
        return {
            ok: false,
            items: [],
            reason: `모드 목록을 받아오지 못했습니다. (${err.message})\n인터넷 연결을 확인해 주세요.`
        }
    }

    const modsDir = path.join(directory, 'mods')
    const disabledDir = path.join(directory, MOD_DISABLED_DIR)
    await fs.promises.mkdir(modsDir, { recursive: true })

    const wanted = [
        ...list.required.map(m => ({ ...m, required: true })),
        ...list.optional.map(m => ({ ...m, required: false }))
    ]

    const items = []
    const failures = []

    for(const mod of wanted){
        const slug = modStateKey(mod.url)
        const enabled = !disabled.has(mod.url)
        const item = { name: mod.name, url: mod.url, slug, required: mod.required, enabled, status: 'failed' }

        try {
            if(slug == null){
                throw new Error('지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)')
            }

            const info = await resolveModTarget(mod.url)
            if(info == null){
                throw new Error(`${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.`)
            }
            item.latestVersion = info.version

            const statePath = path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${slug}.json`)
            const state = await readJsonIfExists(statePath)
            const fileName = state != null && typeof state.fileName === 'string'
                ? path.basename(state.fileName)
                : info.fileName
            item.fileName = fileName
            item.version = state != null ? (state.version || null) : null

            const inMods = (await fileSizeIfExists(path.join(modsDir, fileName))) != null
            const inDisabled = (await fileSizeIfExists(path.join(disabledDir, fileName))) != null

            if(!enabled){
                if(inMods){
                    await moveFileIfExists(path.join(modsDir, fileName), path.join(disabledDir, fileName))
                }
                item.status = 'disabled'
                items.push(item)
                continue
            }

            if(!inMods && !inDisabled){
                await fs.promises.rm(path.join(modsDir, info.fileName), { force: true })
                await downloadToFile(info.url, path.join(modsDir, info.fileName))
                await writeModState(statePath, { slug, name: mod.name, version: info.version, fileName: info.fileName, size: info.size })
                item.status = 'installed'
                item.version = info.version
                item.fileName = info.fileName
                items.push(item)
                continue
            }

            if(inDisabled && !inMods){
                await moveFileIfExists(path.join(disabledDir, fileName), path.join(modsDir, fileName))
                item.status = 'installed'
                items.push(item)
                continue
            }

            // 필수 모드는 자동으로 최신 버전에 맞춥니다.
            // 선택 모드는 그대로 두고, 사용자가 직접 업데이트 버튼을 누릅니다.
            if(mod.required && item.version != null && info.version != null && item.version !== info.version){
                const target = path.join(modsDir, info.fileName)
                if(fileName !== info.fileName){
                    await fs.promises.rm(path.join(modsDir, fileName), { force: true })
                }
                await fs.promises.rm(target, { force: true })
                await downloadToFile(info.url, target)
                await writeModState(statePath, {
                    slug,
                    name: mod.name,
                    version: info.version,
                    fileName: info.fileName,
                    size: info.size
                })
                console.log(`[Mods] 필수 모드를 자동 업데이트했습니다: ${mod.name} (${item.version} -> ${info.version})`)
                item.status = 'installed'
                item.version = info.version
                item.fileName = info.fileName
                item.autoUpdated = true
                items.push(item)
                continue
            }

            item.status = item.version != null && item.version !== info.version ? 'outdated' : 'installed'
            items.push(item)
        } catch (err) {
            item.reason = err.message
            failures.push(`${mod.name}: ${err.message}`)
            items.push(item)
        }
    }

    try {
        await ensureServerEntry(directory, serverAddress)
    } catch (err) {
        console.warn('[Mods] servers.dat 을 쓰지 못했습니다.', err.message)
    }

    return {
        ok: failures.length === 0,
        items,
        reason: failures.length > 0 ? failures.join('\n') : null
    }
})

ipcMain.handle('getModStatus', async (event, options) => {
    const { directory, disabledUrls } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.', items: [] }
    }

    const disabled = new Set(Array.isArray(disabledUrls) ? disabledUrls : [])
    const modsDir = path.join(directory, 'mods')
    const disabledDir = path.join(directory, MOD_DISABLED_DIR)
    await fs.promises.mkdir(modsDir, { recursive: true })

    let list
    try {
        list = await fetchModList()
    } catch (err) {
        return { ok: false, items: [], reason: `모드 목록을 받아오지 못했습니다. (${err.message})` }
    }

    const wanted = [
        ...list.required.map(m => ({ ...m, required: true })),
        ...list.optional.map(m => ({ ...m, required: false }))
    ]

    const items = []
    for(const mod of wanted){
        const item = {
            name: mod.name,
            url: mod.url,
            slug: modStateKey(mod.url),
            required: mod.required,
            enabled: !disabled.has(mod.url),
            status: 'failed'
        }

        try {
            if(item.slug == null){
                throw new Error('지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)')
            }
            const info = await resolveModTarget(mod.url)
            if(info == null){
                throw new Error(`${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.`)
            }
            item.latestVersion = info.version

            const state = await readJsonIfExists(path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${item.slug}.json`))
            const fileName = state != null && typeof state.fileName === 'string'
                ? path.basename(state.fileName)
                : info.fileName
            item.fileName = fileName
            item.version = state != null ? (state.version || null) : null

            const inMods = (await fileSizeIfExists(path.join(modsDir, fileName))) != null
            const inDisabled = (await fileSizeIfExists(path.join(disabledDir, fileName))) != null

            if(!inMods && !inDisabled){
                item.status = 'missing'
            } else if(!item.enabled){
                item.status = 'disabled'
            } else if(inDisabled && !inMods){
                item.status = 'toEnable'
            } else if(item.version != null && item.version !== info.version){
                item.status = 'outdated'
                item.updateAvailable = true
            } else {
                item.status = 'installed'
            }
        } catch (err) {
            item.reason = err.message
        }
        items.push(item)
    }

    return { ok: true, items }
})

ipcMain.handle('updateMod', async (event, options) => {
    const { directory, url } = options || {}
    if(typeof directory !== 'string' || directory.length === 0){
        return { ok: false, reason: '게임 폴더를 알 수 없습니다.' }
    }

    const slug = modStateKey(url)
    if(slug == null){
        return { ok: false, reason: '지원하지 않는 주소입니다. (모드린스 주소 또는 jar 주소)' }
    }

    try {
        const info = await resolveModTarget(url)
        if(info == null){
            return { ok: false, reason: `${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.` }
        }

        const modsDir = path.join(directory, 'mods')
        const disabledDir = path.join(directory, MOD_DISABLED_DIR)
        await fs.promises.mkdir(modsDir, { recursive: true })

        const statePath = path.join(modsDir, `${MOD_STATE_FILE_PREFIX}${slug}.json`)
        const old = await readJsonIfExists(statePath)

        if(old != null && typeof old.fileName === 'string' && old.fileName !== info.fileName){
            await fs.promises.rm(path.join(modsDir, path.basename(old.fileName)), { force: true })
            await fs.promises.rm(path.join(disabledDir, path.basename(old.fileName)), { force: true })
        }

        await fs.promises.rm(path.join(modsDir, info.fileName), { force: true })
        await downloadToFile(info.url, path.join(modsDir, info.fileName))
        await writeModState(statePath, {
            slug,
            name: old != null ? old.name : slug,
            version: info.version,
            fileName: info.fileName,
            size: info.size
        })

        return { ok: true, version: info.version, fileName: info.fileName }
    } catch (err) {
        return { ok: false, reason: err.message }
    }
})

const REDIRECT_URI_PREFIX = 'https://login.microsoftonline.com/common/oauth2/nativeclient?'

let msftAuthWindow
let msftAuthSuccess
let msftAuthViewSuccess
let msftAuthViewOnClose
ipcMain.on(MSFT_OPCODE.OPEN_LOGIN, (ipcEvent, ...arguments_) => {
    if (msftAuthWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN, msftAuthViewOnClose)
        return
    }
    msftAuthSuccess = false
    msftAuthViewSuccess = arguments_[0]
    msftAuthViewOnClose = arguments_[1]
    msftAuthWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLoginTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftAuthWindow.on('closed', () => {
        msftAuthWindow = undefined
    })

    msftAuthWindow.on('close', () => {
        if(!msftAuthSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED, msftAuthViewOnClose)
        }
    })

    msftAuthWindow.webContents.on('did-navigate', (_, uri) => {
        if (uri.startsWith(REDIRECT_URI_PREFIX)) {
            let queryMap = {}
            
            new URL(uri).searchParams.forEach((v, k) => {
                queryMap[k] = v;
            });

            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGIN, MSFT_REPLY_TYPE.SUCCESS, queryMap, msftAuthViewSuccess)

            msftAuthSuccess = true
            msftAuthWindow.close()
            msftAuthWindow = null
        }
    })

    msftAuthWindow.removeMenu()
    msftAuthWindow.loadURL(`https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize?prompt=select_account&client_id=${AZURE_CLIENT_ID}&response_type=code&scope=XboxLive.signin%20offline_access&redirect_uri=https://login.microsoftonline.com/common/oauth2/nativeclient`)
})

let msftLogoutWindow
let msftLogoutSuccess
let msftLogoutSuccessSent
ipcMain.on(MSFT_OPCODE.OPEN_LOGOUT, (ipcEvent, uuid, isLastAccount) => {
    if (msftLogoutWindow) {
        ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.ALREADY_OPEN)
        return
    }

    msftLogoutSuccess = false
    msftLogoutSuccessSent = false
    msftLogoutWindow = new BrowserWindow({
        title: LangLoader.queryJS('index.microsoftLogoutTitle'),
        backgroundColor: '#222222',
        width: 520,
        height: 600,
        frame: true,
        icon: getPlatformIcon('SealCircle')
    })

    msftLogoutWindow.on('closed', () => {
        msftLogoutWindow = undefined
    })

    msftLogoutWindow.on('close', () => {
        if(!msftLogoutSuccess) {
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.ERROR, MSFT_ERROR.NOT_FINISHED)
        } else if(!msftLogoutSuccessSent) {
            msftLogoutSuccessSent = true
            ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
        }
    })
    
    msftLogoutWindow.webContents.on('did-navigate', (_, uri) => {
        if(uri.startsWith('https://login.microsoftonline.com/common/oauth2/v2.0/logoutsession')) {
            msftLogoutSuccess = true
            setTimeout(() => {
                if(!msftLogoutSuccessSent) {
                    msftLogoutSuccessSent = true
                    ipcEvent.reply(MSFT_OPCODE.REPLY_LOGOUT, MSFT_REPLY_TYPE.SUCCESS, uuid, isLastAccount)
                }

                if(msftLogoutWindow) {
                    msftLogoutWindow.close()
                    msftLogoutWindow = null
                }
            }, 5000)
        }
    })
    
    msftLogoutWindow.removeMenu()
    msftLogoutWindow.loadURL('https://login.microsoftonline.com/common/oauth2/v2.0/logout')
})

let win

function createWindow() {

    win = new BrowserWindow({
        width: 980,
        height: 552,
        icon: getPlatformIcon('SealCircle'),
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'app', 'assets', 'js', 'preloader.js'),
            nodeIntegration: true,
            contextIsolation: false
        },
        backgroundColor: '#171614'
    })
    remoteMain.enable(win.webContents)

    // 'once' 로 두면 새로 고침 뒤에도 준비됨으로 남아 메시지가 사라지므로(무한 로딩) 매번 초기화합니다.
    win.webContents.on('did-start-loading', () => {
        rendererDomReady.delete(win.webContents)
    })
    win.webContents.on('dom-ready', () => {
        rendererDomReady.add(win.webContents)
        flushDistributionIndexDone(win.webContents)
    })

    const data = {
        bkid: Math.floor((Math.random() * fs.readdirSync(path.join(__dirname, 'app', 'assets', 'images', 'backgrounds')).length)),
        lang: (str, placeHolders) => LangLoader.queryEJS(str, placeHolders)
    }
    Object.entries(data).forEach(([key, val]) => ejse.data(key, val))

    win.loadURL(pathToFileURL(path.join(__dirname, 'app', 'app.ejs')).toString())


    win.removeMenu()

    win.webContents.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown') {
            return
        }
        const isF12 = input.key === 'F12'
        const isDevToolsCombo = input.control && input.shift && input.key.toLowerCase() === 'i'
        if (isF12 || isDevToolsCombo) {
            win.webContents.toggleDevTools()
            event.preventDefault()
        }
    })

    win.resizable = true

    win.on('closed', () => {
        win = null
    })
}

function createMenu() {
    
    if(process.platform === 'darwin') {

        let applicationSubMenu = {
            label: 'Application',
            submenu: [{
                label: 'About Application',
                selector: 'orderFrontStandardAboutPanel:'
            }, {
                type: 'separator'
            }, {
                label: 'Quit',
                accelerator: 'Command+Q',
                click: () => {
                    app.quit()
                }
            }]
        }

        let editSubMenu = {
            label: 'Edit',
            submenu: [{
                label: 'Undo',
                accelerator: 'CmdOrCtrl+Z',
                selector: 'undo:'
            }, {
                label: 'Redo',
                accelerator: 'Shift+CmdOrCtrl+Z',
                selector: 'redo:'
            }, {
                type: 'separator'
            }, {
                label: 'Cut',
                accelerator: 'CmdOrCtrl+X',
                selector: 'cut:'
            }, {
                label: 'Copy',
                accelerator: 'CmdOrCtrl+C',
                selector: 'copy:'
            }, {
                label: 'Paste',
                accelerator: 'CmdOrCtrl+V',
                selector: 'paste:'
            }, {
                label: 'Select All',
                accelerator: 'CmdOrCtrl+A',
                selector: 'selectAll:'
            }]
        }

        let menuTemplate = [applicationSubMenu, editSubMenu]
        let menuObject = Menu.buildFromTemplate(menuTemplate)

        Menu.setApplicationMenu(menuObject)

    }

}

function getPlatformIcon(filename){
    let ext
    switch(process.platform) {
        case 'win32':
            ext = 'ico'
            break
        case 'darwin':
        case 'linux':
        default:
            ext = 'png'
            break
    }

    return path.join(__dirname, 'app', 'assets', 'images', `${filename}.${ext}`)
}

app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

// ===== macOS 자체 교체 업데이트 =====
// 서명 인증서가 없어 electron-updater 의 설치는 쓸 수 없습니다.
// 확인은 기존대로 하고, 설치는 dmg 를 직접 받아 앱 번들을 통째로 교체합니다.

const MAC_RELEASE_BASE = 'https://github.com/teddy-wooma/barkan-launcher/releases/latest/download'

function macArchTag() {
    return process.arch === 'arm64' ? 'arm64' : 'x64'
}

function macDmgFileName(version) {
    return `Barkan Launcher-setup-${version}-${macArchTag()}.dmg`
}

// .../Barkan Launcher.app/Contents/MacOS/Barkan Launcher 에서 3단계 위가 앱 번들입니다.
function macAppBundle() {
    return path.resolve(path.dirname(app.getPath('exe')), '..', '..')
}

// dmg 안이나 다운로드 폴더에서 바로 실행하면 경로가 무작위화되어 교체할 수 없습니다.
function isTranslocated() {
    return macAppBundle().includes('AppTranslocation')
}

async function fetchLatestMacRelease() {
    const response = await fetch(`${MAC_RELEASE_BASE}/latest-mac.yml`, {
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(20000)
    })
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
    }
    const text = await response.text()
    const version = /^version:\s*(\S+)/m.exec(text)
    if (version == null) {
        throw new Error('latest-mac.yml 에서 버전을 읽지 못했습니다.')
    }
    return { version: version[1], text }
}

// latest-mac.yml 의 files 항목에서 이 아키텍처의 dmg 와 sha512 를 찾습니다.
function findMacDmgEntry(text, fileName) {
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(fileName)) {
            continue
        }
        for (let j = i; j < Math.min(i + 6, lines.length); j++) {
            const sha = /^\s*sha512:\s*(\S+)/.exec(lines[j])
            if (sha != null) {
                return {
                    url: `${MAC_RELEASE_BASE}/${encodeURIComponent(fileName)}`,
                    sha512: sha[1]
                }
            }
        }
    }
    return null
}

async function downloadMacDmg(entry, destination, onProgress) {
    const response = await fetch(entry.url, {
        redirect: 'follow',
        headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` },
        signal: AbortSignal.timeout(60 * 60 * 1000)
    })
    if (!response.ok) {
        throw new Error(`HTTP ${response.status}`)
    }

    const total = Number(response.headers.get('content-length') || 0)
    let received = 0
    let lastReport = 0
    const hash = crypto.createHash('sha512')
    const counter = new Transform({
        transform(chunk, encoding, callback) {
            received += chunk.length
            hash.update(chunk)
            if (onProgress && (received - lastReport > 1024 * 1024 || received === total)) {
                lastReport = received
                onProgress(received, total)
            }
            callback(null, chunk)
        }
    })

    const { pipeline } = require('stream/promises')
    await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destination))

    const actual = hash.digest('base64')
    if (actual !== entry.sha512) {
        await fs.promises.rm(destination, { force: true }).catch(() => {})
        throw new Error('내려받은 파일이 손상되었습니다. (sha512 불일치)')
    }
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        child.stdout.on('data', d => { out += d })
        child.stderr.on('data', d => { out += d })
        child.on('error', reject)
        child.on('close', code => {
            if (code === 0) {
                resolve(out)
            } else {
                reject(new Error(`${command} 실패 (코드 ${code})`))
            }
        })
    })
}

async function extractAppFromDmg(dmgPath, destination) {
    const mountPoint = path.join(os.tmpdir(), `barkan-dmg-${Date.now()}`)
    await fs.promises.mkdir(mountPoint, { recursive: true })
    try {
        await runCommand('hdiutil', ['attach', '-nobrowse', '-readonly', '-noverify', '-mountpoint', mountPoint, dmgPath])
        await fs.promises.rm(destination, { recursive: true, force: true })
        // ditto 를 써야 코드 서명이 그대로 보존됩니다.
        await runCommand('ditto', [path.join(mountPoint, 'Barkan Launcher.app'), destination])
    } finally {
        await runCommand('hdiutil', ['detach', mountPoint, '-force']).catch(() => {})
        await fs.promises.rm(mountPoint, { recursive: true, force: true }).catch(() => {})
    }
}

// 런처가 종료된 뒤에 앱을 갈아끼우는 스크립트를 만듭니다.
// 스크립트는 반드시 /tmp 에 둡니다. 앱 안에 두면 앱을 지울 때 자기 자신도 사라집니다.
async function writeSelfReplaceScripts(target, staged, dmgPath) {
    const rootPath = path.join(os.tmpdir(), 'barkan-selfupdate-root.sh')
    const mainPath = path.join(os.tmpdir(), 'barkan-selfupdate.sh')

    const rootScript = [
        '#!/bin/bash',
        '# 관리자 권한으로 실행되는 부분입니다. (앱 교체와 격리 속성 제거)',
        'set -e',
        'APP="$1"',
        'STAGED="$2"',
        'rm -rf "$APP"',
        'mv "$STAGED" "$APP"',
        'xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
        ''
    ].join('\n')

    const mainScript = [
        '#!/bin/bash',
        '# 런처가 끝난 뒤 앱을 교체하고 다시 실행합니다.',
        'APP="$1"',
        'STAGED="$2"',
        'PID="$3"',
        'DMG="$4"',
        'ROOT="$5"',
        'BACKUP="$6"',
        'LOG=/tmp/barkan-selfupdate.log',
        'exec >>"$LOG" 2>&1',
        'echo "=== $(date) 자체 업데이트 시작 ==="',
        '',
        '# 런처가 끝날 때까지 기다립니다. (최대 30초)',
        'for i in $(seq 1 60); do',
        '  kill -0 "$PID" 2>/dev/null || break',
        '  sleep 0.5',
        'done',
        'sleep 1',
        '',
        'DIR=$(dirname "$APP")',
        'rm -rf "$BACKUP"',
        '',
        'if [ -w "$DIR" ]; then',
        '  # 쓰기 권한이 있으면 그대로 진행합니다.',
        '  cp -R "$APP" "$BACKUP" 2>/dev/null || true',
        '  if bash "$ROOT" "$APP" "$STAGED"; then OK=1; else OK=0; fi',
        'else',
        '  # /Applications 처럼 권한이 필요한 곳은 암호를 한 번 묻습니다.',
        '  cp -R "$APP" "$BACKUP" 2>/dev/null || true',
        '  if osascript -e "do shell script \\"bash \'$ROOT\' \'$APP\' \'$STAGED\'\\" with administrator privileges"; then OK=1; else OK=0; fi',
        'fi',
        '',
        'if [ "$OK" = "1" ]; then',
        '  echo "교체 완료"',
        '  rm -rf "$BACKUP"',
        '  open "$APP"',
        'else',
        '  echo "교체 실패 - 백업으로 되돌리고 dmg 를 엽니다"',
        '  if [ -d "$BACKUP" ]; then',
        '    if [ -w "$DIR" ]; then rm -rf "$APP" && mv "$BACKUP" "$APP";',
        '    else osascript -e "do shell script \\"rm -rf \'$APP\' && mv \'$BACKUP\' \'$APP\'\\" with administrator privileges"; fi',
        '  fi',
        '  open "$DMG"',
        'fi',
        ''
    ].join('\n')

    await fs.promises.writeFile(rootPath, rootScript, 'utf8')
    await fs.promises.writeFile(mainPath, mainScript, 'utf8')
    await fs.promises.chmod(mainPath, 0o755).catch(() => {})
    return { mainPath, rootPath }
}

async function runMacSelfUpdate(event) {
    const send = (arg, data) => {
        event.sender.send('autoUpdateNotification', arg, data)
    }

    let dmgPath = null
    try {
        send('mac-selfupdate-progress', { stage: 'checking' })
        const latest = await fetchLatestMacRelease()

        if (semver.lte(latest.version, app.getVersion())) {
            send('mac-selfupdate-progress', { stage: 'up-to-date', version: latest.version })
            return
        }

        const fileName = macDmgFileName(latest.version)
        const entry = findMacDmgEntry(latest.text, fileName)
        if (entry == null) {
            throw new Error(`릴리즈에서 ${fileName} 을 찾지 못했습니다.`)
        }

        dmgPath = path.join(os.tmpdir(), fileName)
        await downloadMacDmg(entry, dmgPath, (received, total) => {
            send('mac-selfupdate-progress', { stage: 'downloading', received, total })
        })

        // dmg 안이나 다운로드 폴더에서 실행 중이면 교체할 수 없습니다.
        if (isTranslocated()) {
            await shell.openPath(dmgPath)
            send('mac-selfupdate-progress', { stage: 'manual', reason: 'translocated' })
            return
        }

        const staged = path.join(os.tmpdir(), 'Barkan Launcher.app.new')
        send('mac-selfupdate-progress', { stage: 'extracting' })
        await extractAppFromDmg(dmgPath, staged)

        send('mac-selfupdate-progress', { stage: 'installing' })
        const appBundle = macAppBundle()
        const { mainPath } = await writeSelfReplaceScripts(appBundle, staged, dmgPath)

        // 런처가 종료되어야 앱을 바꿀 수 있으므로 분리 실행 후 스스로 끝냅니다.
        spawn('/bin/bash', [mainPath, appBundle, staged, String(process.pid), dmgPath,
            path.join(os.tmpdir(), 'barkan-selfupdate-root.sh'),
            `${appBundle}.bak`], { detached: true, stdio: 'ignore' }).unref()

        setTimeout(() => app.quit(), 900)
    } catch (err) {
        console.error('[MacSelfUpdate]', err)
        send('mac-selfupdate-progress', { stage: 'failed', message: err.message })
        // 실패하면 dmg 를 열어 사용자가 직접 설치할 수 있게 합니다.
        if (dmgPath != null) {
            await shell.openPath(dmgPath).catch(() => {})
        }
    }
}