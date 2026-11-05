const remoteMain = require('@electron/remote/main')
remoteMain.initialize()

const { app, BrowserWindow, ipcMain, Menu, shell } = require('electron')
const autoUpdater                       = require('electron-updater').autoUpdater
const ejse                              = require('ejs-electron')
const fs                                = require('fs')
const isDev                             = require('./app/assets/js/isdev')
const os                                = require('os')
const path                              = require('path')
const semver                            = require('semver')
const { spawn }                         = require('child_process')
const { Readable, Transform }           = require('stream')
const { pathToFileURL }                 = require('url')
const { AZURE_CLIENT_ID, MSFT_OPCODE, MSFT_REPLY_TYPE, MSFT_ERROR, SHELL_OPCODE } = require('./app/assets/js/ipcconstants')
const crypto                            = require('crypto')
const LangLoader                        = require('./app/assets/js/langloader')
const NbtUtil                           = require('./app/assets/js/nbtutil')
const ModLock                           = require('./app/assets/js/modlock')
const ExternalLink                      = require('./app/assets/js/externallink')
const { createMacUpdater }              = require('./app/assets/js/macupdater')
const macUpdater                        = createMacUpdater({ app, shell })

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
        // The custom DMG updater owns both checking and installation on macOS.
        return
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
        case 'checkMacUpdate':
            macUpdater.check(event.sender)
            break
        case 'checkForUpdate':
            if(process.platform === 'darwin'){
                // macOS 에서는 서명 문제로 electron-updater 확인이 실패할 수 있습니다.
                macUpdater.check(event.sender)
                break
            }
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
                macUpdater.install(event.sender)
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

// Windows 에서는 shell.openExternal 이 아무것도 열지 않고 성공하는 경우가 있어 rundll32 로 먼저 엽니다.
// cmd /c start 는 주소 속 `&` 뒤를 별도 명령으로 실행하므로 쓰지 않습니다. (externallink.js 참고)
function openExternalUrl(url) {
    const href = ExternalLink.normalizeExternalUrl(url)
    if(href == null){
        console.error('[Links] 허용되지 않은 URL 입니다:', url)
        return false
    }

    const fallback = err => {
        console.error('[Links] rundll32 로 열지 못해 shell.openExternal 로 재시도합니다.', err)
        shell.openExternal(href).catch(error => {
            console.error('[Links] 브라우저를 열지 못했습니다:', href, error)
        })
    }

    if(process.platform === 'win32'){
        try {
            const { command, args } = ExternalLink.windowsOpenCommand(href)
            const child = spawn(command, args, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true,
                shell: false
            })
            child.once('error', fallback)
            child.unref()
            return true
        } catch (err) {
            fallback(err)
            return true
        }
    }
    shell.openExternal(href).catch(err => {
        console.error('[Links] 브라우저를 열지 못했습니다:', href, err)
    })
    return true
}

ipcMain.handle('openExternal', (event, url) => {
    return openExternalUrl(url)
})

// 메인 창은 Node 권한(nodeIntegration)을 가지므로, 런처 화면(app 폴더의 file://) 밖으로 이동하면 안 됩니다.
// HTML 이 한 줄만 끼어들어도 <meta http-equiv="refresh"> 로 외부 페이지를 이 창에 열 수 있고,
// 그 페이지는 CSP 없이 Node 권한으로 실행됩니다. 이동·리다이렉트·새 창·webview 를 모두 막습니다.
const LAUNCHER_PAGE_PREFIX = pathToFileURL(path.join(__dirname, 'app') + path.sep).href

function isLauncherPage(url) {
    try {
        const parsed = new URL(url)
        return parsed.protocol === 'file:' && parsed.href.startsWith(LAUNCHER_PAGE_PREFIX)
    } catch (_err) {
        return false
    }
}

function lockMainWindowNavigation(contents) {
    const block = (event, url) => {
        if(!isLauncherPage(url)){
            event.preventDefault()
            console.warn('[Security] 런처 창이 외부 주소로 이동하려는 것을 막았습니다:', url)
        }
    }
    contents.on('will-navigate', block)
    contents.on('will-redirect', block)
    contents.on('will-attach-webview', event => event.preventDefault())
    contents.setWindowOpenHandler(({ url }) => {
        if(ExternalLink.normalizeExternalUrl(url) != null){
            openExternalUrl(url)
        }
        return { action: 'deny' }
    })
}

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
    const logStart = Date.now()
    launchLog('DOWNLOAD', '시작 : ' + url)
    launchLog('DOWNLOAD', '  → 저장 : ' + destination)
    if (expectedSha1) { launchLog('DOWNLOAD', '  → 기대 sha1 : ' + expectedSha1) }
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

    launchLog('DOWNLOAD', '  → 완료 : ' + received + 'B / ' + total + 'B  (' + ((Date.now() - logStart) / 1000).toFixed(1) + '초)')
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
    launchLogSection('서버 리소스팩 동기화')
    launchLog('RSPACK', '요청 : ' + JSON.stringify(options))
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

// 배포 인덱스에 SHA-512 가 적힌 파일(셰이더 모드·셰이더팩)은 해시가 맞을 때만 씁니다.
async function syncVerifiedGameFile(event, { url, target, statePath, safeName, safeFolder, sha512, size }) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true })
    const current = await ModLock.sha512OfFile(target)
    const version = `sha512:${sha512.slice(0, 12)}`
    if(current === sha512){
        return { status: 'skipped', size: await fileSizeIfExists(target), version }
    }

    try {
        const result = await ModLock.downloadVerified({
            url,
            destination: target,
            sha512,
            size: Number.isSafeInteger(size) ? size : undefined,
            userAgent: launcherUserAgent(),
            onProgress: (received, total) => {
                if(!event.sender.isDestroyed()){
                    event.sender.send('resourcePackProgress', { received, total })
                }
            }
        })
        await fs.promises.writeFile(statePath, JSON.stringify({
            url,
            fileName: safeName,
            version,
            size: result.size,
            sha512,
            updatedAt: new Date().toISOString()
        }, null, 2), 'utf8')
        console.log(`[GameFile] 검증 후 설치했습니다: ${safeFolder}/${safeName}`)
        return { status: 'installed', size: result.size, version }
    } catch (err) {
        // 해시가 다른 jar 가 mods 폴더에 남아 실행되지 않게 지웁니다.
        if(safeFolder === 'mods' && current != null){
            await fs.promises.rm(target, { force: true }).catch(() => {})
        }
        console.warn(`[GameFile] 검증 설치 실패: ${safeFolder}/${safeName}`, err.message)
        return { status: 'failed', reason: err.message }
    }
}

ipcMain.handle('syncResourcePack', async (event, options) => {
    launchLogSection('리소스팩 동기화')
    launchLog('RSPACK', '요청 : ' + JSON.stringify(options))
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

    const expectedSha512 = typeof (options || {}).sha512 === 'string' ? options.sha512.toLowerCase() : null
    if(ModLock.isSha512(expectedSha512)){
        return await syncVerifiedGameFile(event, { url, target, statePath, safeName, safeFolder, sha512: expectedSha512, size: options.size })
    }
    // mods 폴더에 들어가는 파일은 코드라서, 해시 없이 받아 넣지 않습니다.
    if(safeFolder === 'mods'){
        return { status: 'failed', reason: `${safeName}: mods 폴더에 넣는 파일은 배포 인덱스에 SHA-512 가 있어야 합니다.` }
    }

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


// 모드 목록·버전·SHA-512 는 런처 안의 잠금 파일에 고정합니다. (원격 목록을 받아 검증 없이 설치하지 않습니다)
// 목록을 바꾸려면 tools/lock-mods.cjs 로 app/assets/mods.lock.json 을 다시 만들고 런처를 새로 배포합니다.
const MOD_LOCK_PATH = path.join(__dirname, 'app', 'assets', 'mods.lock.json')
let modLockCache = null

function getModLock() {
    if(modLockCache == null){
        modLockCache = ModLock.loadLockSync(MOD_LOCK_PATH)
    }
    return modLockCache
}

function launcherUserAgent() {
    return `BarkanLauncher/${app.getVersion()}`
}

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

async function ensureServerEntry(directory, address, quickPlayAddress) {
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

    const updated = NbtUtil.ensureServer(current, {
        name: '바르칸 열도',
        ip: address,
        quickPlayAddress
    })
    await fs.promises.mkdir(directory, { recursive: true })
    await fs.promises.writeFile(target, updated)
    return true
}

ipcMain.handle('syncMods', async (event, options) => {
    launchLogSection('모드 동기화')
    launchLog('MODS', '요청 : ' + JSON.stringify(options))
    const { directory, disabledUrls, serverAddress, quickPlayAddress } = options || {}

    let lock
    try {
        lock = getModLock()
    } catch (err) {
        return { ok: false, items: [], reason: `런처 모드 목록을 읽지 못했습니다. (${err.message})` }
    }

    const result = await ModLock.syncMods({
        directory,
        disabledUrls,
        lock,
        userAgent: launcherUserAgent(),
        log: message => console.log(`[Mods] ${message}`)
    })
    result.items.forEach(item => launchLog('MODS', `${item.status} : ${item.name}${item.reason ? ' (' + item.reason + ')' : ''}`))

    if(typeof directory === 'string' && directory.length > 0){
        try {
            await ensureServerEntry(directory, serverAddress, quickPlayAddress)
        } catch (err) {
            console.warn('[Mods] servers.dat 을 쓰지 못했습니다.', err.message)
        }
    }

    return result
})

ipcMain.handle('getModStatus', async (event, options) => {
    const { directory, disabledUrls } = options || {}
    let lock
    try {
        lock = getModLock()
    } catch (err) {
        return { ok: false, items: [], reason: `런처 모드 목록을 읽지 못했습니다. (${err.message})` }
    }
    return await ModLock.getModStatus({ directory, disabledUrls, lock })
})

ipcMain.handle('updateMod', async (event, options) => {
    const { directory, url } = options || {}
    let lock
    try {
        lock = getModLock()
    } catch (err) {
        return { ok: false, reason: `런처 모드 목록을 읽지 못했습니다. (${err.message})` }
    }
    return await ModLock.updateMod({ directory, url, lock, userAgent: launcherUserAgent() })
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
    lockMainWindowNavigation(win.webContents)

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

app.on('ready', () => {
    // 어떤 이유로든 이 호출이 실패해도 창은 반드시 떠야 합니다.
    try { launchLogSystemInfo() } catch (err) { console.error('[launchLog]', err) }
})
app.on('ready', createWindow)
app.on('ready', createMenu)

app.on('window-all-closed', () => {
    launchLog('SYS', '모든 창이 닫혀 런처를 종료합니다.')
    if (process.platform !== 'darwin') {
        app.quit()
    }
})

app.on('activate', () => {
    if (win === null) {
        createWindow()
    }
})

// ===== 런처 진단 로그 =====
// 플레이 버튼을 누른 시점부터의 모든 과정을 파일로 남깁니다.
//   위치: <userData>/logs/launcher.log     (예: %APPDATA%\Barkan Launcher\logs\launcher.log)
//
// 목적: 게임이 logs/latest.log 를 만들기 전에 실패하면 아무 흔적도 남지 않습니다.
//       ("왜 게임이 안 켜지나" 를 알 수 없게 되는 문제) 그 구간을 기록합니다.

const LAUNCH_LOG_MAX_BYTES = 8 * 1024 * 1024
let launchLogFile = null
let launchLogReady = false

function launchLogPath() {
    if (launchLogFile == null) {
        launchLogFile = path.join(app.getPath('userData'), 'logs', 'launcher.log')
    }
    return launchLogFile
}

function launchLogTimestamp() {
    const d = new Date()
    const p = n => String(n).padStart(2, '0')
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' '
        + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) + '.'
        + String(d.getMilliseconds()).padStart(3, '0')
}

function launchLogEnsure() {
    if (launchLogReady) {
        return
    }
    const file = launchLogPath()
    fs.mkdirSync(path.dirname(file), { recursive: true })
    try {
        // 무한히 커지지 않게, 일정 크기를 넘으면 한 번만 옮겨 둡니다.
        if (fs.existsSync(file) && fs.statSync(file).size > LAUNCH_LOG_MAX_BYTES) {
            fs.renameSync(file, file + '.old')
        }
    } catch (err) { /* 무시 */ }
    launchLogReady = true
}

function launchLog(scope, message) {
    try {
        launchLogEnsure()
        let text
        if (message == null) {
            text = ''
        } else if (typeof message === 'string') {
            text = message
        } else if (message instanceof Error) {
            text = message.stack || message.message
        } else {
            try { text = JSON.stringify(message) } catch (err) { text = String(message) }
        }
        fs.appendFileSync(launchLogPath(), '[' + launchLogTimestamp() + '] [' + scope + '] ' + text + '\n', 'utf8')
    } catch (err) {
        // 로그를 못 써도 앱 동작에는 영향이 없게 합니다.
    }
}

function launchLogSection(title) {
    launchLog('----', '')
    launchLog('----', '==================== ' + title + ' ====================')
}

function launchLogSystemInfo() {
    // 로깅이 앱 시작을 막으면 안 됩니다.
    try {
    const cpus = os.cpus() || []
    launchLogSection('런처 시작')
    launchLog('SYS', '런처 버전   : ' + app.getVersion())
    launchLog('SYS', '플랫폼      : ' + process.platform + ' / ' + process.arch)
    launchLog('SYS', 'OS          : ' + os.type() + ' ' + os.release() + ' (빌드 ' + os.version() + ')')
    launchLog('SYS', 'CPU         : ' + ((cpus[0] || {}).model || '?') + '  (' + cpus.length + ' 코어)')
    launchLog('SYS', '메모리      : 전체 ' + (os.totalmem() / 1073741824).toFixed(1) + 'GB / 여유 ' + (os.freemem() / 1073741824).toFixed(1) + 'GB')
    launchLog('SYS', 'Electron    : ' + process.versions.electron + '   Chrome ' + process.versions.chrome + '   Node ' + process.versions.node)
    launchLog('SYS', 'userData    : ' + app.getPath('userData'))
    launchLog('SYS', 'appData     : ' + app.getPath('appData'))
    launchLog('SYS', '실행 파일   : ' + app.getPath('exe'))
    launchLog('SYS', '개발 모드   : ' + isDev)
    } catch (err) {
        console.error('[launchLog] 시스템 정보 기록 실패:', err)
    }
}

// 렌더러(화면 쪽)에서 보내는 로그를 받아 같은 파일에 씁니다.
ipcMain.on('launcherLog', (event, scope, message) => {
    launchLog(scope || 'UI', message)
})

// 로그 파일이 있는 폴더를 열어 줍니다. (사용자가 파일을 찾기 쉽게)
ipcMain.on('launcherLogOpenFolder', () => {
    try {
        launchLogEnsure()
        shell.showItemInFolder(launchLogPath())
    } catch (err) {
        launchLog('WARN', '로그 폴더 열기 실패: ' + (err.message || err))
    }
})

ipcMain.handle('launcherLogPathGet', () => launchLogPath())

// 예기치 못한 오류도 남깁니다. (이게 없으면 조용히 죽습니다)
process.on('uncaughtException', (err) => {
    launchLog('FATAL', 'uncaughtException: ' + (err && err.stack ? err.stack : String(err)))
})
process.on('unhandledRejection', (reason) => {
    launchLog('FATAL', 'unhandledRejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
})