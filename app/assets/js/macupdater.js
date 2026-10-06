const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const { Readable, Transform } = require('stream')
const { pipeline } = require('stream/promises')
const semver = require('semver')
const yaml = require('js-yaml')

const RELEASE_BASE = 'https://github.com/teddy-wooma/barkan-launcher/releases'

// Use the published file names. electron-builder normalizes spaces to hyphens.
function parseMacRelease(text, arch, releaseBase = RELEASE_BASE) {
    const info = yaml.load(text)
    if (!info || !semver.valid(info.version)) {
        throw new Error('latest-mac.yml: invalid release version')
    }
    const entry = (Array.isArray(info.files) ? info.files : []).find(file => {
        if (typeof file.url !== 'string') {
            return false
        }
        const name = decodeURIComponent(file.url)
        return !name.includes('/') && name.endsWith(`-${info.version}-${arch}.dmg`)
    })
    if (!entry || typeof entry.sha512 !== 'string' || Buffer.from(entry.sha512, 'base64').length !== 64) {
        throw new Error(`latest-mac.yml: no verified ${arch} DMG for ${info.version}`)
    }
    const fileName = decodeURIComponent(entry.url)
    return {
        version: info.version,
        releaseName: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
        entry: {
            // Pin the tag so a release published during the download cannot change the payload.
            url: `${releaseBase}/download/v${info.version}/${encodeURIComponent(fileName)}`,
            fileName,
            sha512: entry.sha512,
            size: Number(entry.size) || 0
        }
    }
}

async function downloadMacDmg(entry, destination, fetchImpl, onProgress) {
    try {
        const response = await fetchImpl(entry.url, { redirect: 'follow', signal: AbortSignal.timeout(3600000) })
        if (!response.ok || !response.body) {
            throw new Error(`DMG download: HTTP ${response.status}`)
        }
        const total = entry.size || Number(response.headers.get('content-length')) || 0
        const hash = crypto.createHash('sha512')
        let received = 0
        let lastReport = 0
        const counter = new Transform({
            transform(chunk, encoding, callback) {
                received += chunk.length
                hash.update(chunk)
                if (received - lastReport >= 1024 * 1024 || received === total) {
                    lastReport = received
                    onProgress(received, total)
                }
                callback(null, chunk)
            }
        })
        await pipeline(Readable.fromWeb(response.body), counter, fs.createWriteStream(destination, { mode: 0o600 }))
        if ((entry.size && received !== entry.size) || hash.digest('base64') !== entry.sha512) {
            throw new Error('DMG checksum/size mismatch')
        }
        onProgress(received, total)
    } catch (err) {
        await fs.promises.rm(destination, { force: true }).catch(() => {})
        throw err
    }
}

function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
        let out = ''
        let error = ''
        child.stdout.on('data', data => { out += data })
        child.stderr.on('data', data => { error += data })
        child.on('error', reject)
        child.on('close', code => code === 0 ? resolve(out.trim()) : reject(new Error(`${command}: ${error.trim() || `exit ${code}`}`)))
    })
}

async function extractAppFromDmg(dmgPath, staged, workDir, version, command = runCommand) {
    const mountPoint = path.join(workDir, 'mount')
    await fs.promises.mkdir(mountPoint)
    let mounted = false
    try {
        await command('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mountPoint, dmgPath])
        mounted = true
        await command('/usr/bin/ditto', [path.join(mountPoint, 'Barkan Launcher.app'), staged])
        const plist = path.join(staged, 'Contents', 'Info.plist')
        const bundleId = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', plist])
        const bundleVersion = await command('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', plist])
        if (bundleId !== 'kr.barkan.launcher' || bundleVersion !== version) {
            throw new Error(`DMG bundle does not match release ${version}`)
        }
    } finally {
        if (mounted) {
            await command('/usr/bin/hdiutil', ['detach', mountPoint, '-force'])
        }
        await fs.promises.rm(mountPoint, { recursive: true, force: true })
    }
}

// All paths are argv, including the administrator branch. Never interpolate them into shell code.
async function writeSelfReplaceScripts(workDir) {
    const rootPath = path.join(workDir, 'replace.sh')
    const mainPath = path.join(workDir, 'wait-and-replace.sh')
    const rootScript = `#!/bin/bash
set -e
APP="$1"
STAGED="$2"
NEW="$3"
BACKUP="$4"
MODE="$5"
case "$APP" in /*.app) ;; *) exit 1 ;; esac
if [ "$MODE" = rollback ]; then
    if [ -d "$BACKUP" ]; then
        rm -rf "$APP"
        mv "$BACKUP" "$APP"
    fi
    rm -rf "$NEW"
    exit 0
fi
[ -d "$APP/Contents" ] && [ -d "$STAGED/Contents" ]
[ ! -e "$NEW" ] && [ ! -e "$BACKUP" ]
# Copy first, on the target filesystem. A failed copy leaves the original app intact.
/usr/bin/ditto "$STAGED" "$NEW"
/usr/bin/xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
mv "$APP" "$BACKUP"
if ! mv "$NEW" "$APP"; then
    mv "$BACKUP" "$APP"
    exit 1
fi
`
    const mainScript = `#!/bin/bash
APP="$1"
STAGED="$2"
PID="$3"
ROOT="$4"
NEW="$5"
BACKUP="$6"
READY="$7"
LOG="$8"
WORK="$9"
exec >>"$LOG" 2>&1
echo "$(date) Waiting for launcher $PID"
touch "$READY" || exit 1
for ((i=0; i<60; i++)); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.5
done
if kill -0 "$PID" 2>/dev/null; then
    echo "Launcher did not exit; original app was preserved"
    exit 1
fi
run_replace() {
    if [ -w "$(dirname "$APP")" ] && [ -w "$APP" ]; then
        /bin/bash "$ROOT" "$APP" "$STAGED" "$NEW" "$BACKUP" "$1"
    else
        /usr/bin/osascript - "$ROOT" "$APP" "$STAGED" "$NEW" "$BACKUP" "$1" <<'APPLESCRIPT'
on run argv
    set commandText to "/bin/bash"
    repeat with argument in argv
        set commandText to commandText & " " & quoted form of (contents of argument)
    end repeat
    do shell script commandText with administrator privileges
end run
APPLESCRIPT
    fi
}
if run_replace install; then
    echo "Replacement complete; reopening launcher"
    if /usr/bin/open "$APP"; then
        rm -rf "$BACKUP" "$WORK"
        exit 0
    fi
    echo "Reopen failed; restoring original app"
else
    echo "Replacement failed; restoring original app"
fi
run_replace rollback
/usr/bin/open "$APP"
/usr/bin/osascript - "$LOG" <<'APPLESCRIPT'
on run argv
    display alert "Barkan Launcher update failed" message ("The original launcher was restored. Details: " & item 1 of argv) as warning
end run
APPLESCRIPT
exit 1
`
    await fs.promises.writeFile(rootPath, rootScript, { mode: 0o700 })
    await fs.promises.writeFile(mainPath, mainScript, { mode: 0o700 })
    return { rootPath, mainPath }
}

async function launchReplacement(scripts, args) {
    const child = spawn('/bin/bash', [scripts.mainPath, ...args], { detached: true, stdio: 'ignore' })
    await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('spawn', resolve)
    })
    child.unref()
    const readyPath = args[6]
    for (let i = 0; i < 50; i++) {
        if (fs.existsSync(readyPath)) {
            return
        }
        await new Promise(resolve => setTimeout(resolve, 100))
    }
    child.kill()
    throw new Error('The replacement helper did not start; the launcher will stay open')
}

function createMacUpdater({ app, shell, fetchImpl = fetch, arch = process.arch, releaseBase = RELEASE_BASE,
    tempDir = os.tmpdir(), command = runCommand, launch = launchReplacement }) {
    let installing = false
    let pendingRelease = null
    const log = message => {
        console.log('[MacUpdate]', message)
        try {
            const dir = path.join(app.getPath('userData'), 'logs')
            fs.mkdirSync(dir, { recursive: true })
            fs.appendFileSync(path.join(dir, 'mac-update.log'), `[${new Date().toISOString()}] ${message}\n`)
        } catch (_err) { /* Logging must not block updating. */ }
    }
    const send = (sender, type, data) => {
        if (!sender.isDestroyed()) {
            sender.send('autoUpdateNotification', type, data)
        }
    }
    const latest = () => {
        if (!pendingRelease) {
            pendingRelease = (async () => {
                const response = await fetchImpl(`${releaseBase}/latest/download/latest-mac.yml`, {
                    redirect: 'follow', signal: AbortSignal.timeout(20000),
                    headers: { 'user-agent': `BarkanLauncher/${app.getVersion()}` }
                })
                if (!response.ok) {
                    throw new Error(`Update check: HTTP ${response.status}`)
                }
                return parseMacRelease(await response.text(), arch === 'arm64' ? 'arm64' : 'x64', releaseBase)
            })().finally(() => { pendingRelease = null })
        }
        return pendingRelease
    }
    return {
        async check(sender) {
            if (installing) {
                return
            }
            log(`Check requested (current ${app.getVersion()}, ${arch})`)
            send(sender, 'checking-for-update')
            try {
                const release = await latest()
                // A periodic check completing during installation must not reset its UI.
                if (!installing) {
                    log(`Latest version ${release.version}`)
                    send(sender, semver.gt(release.version, app.getVersion()) ? 'update-available' : 'update-not-available', release)
                }
            } catch (err) {
                log(`Check failed: ${err.stack}`)
                if (!installing) {
                    send(sender, 'realerror', { message: err.message })
                }
            }
        },
        async install(sender) {
            if (installing) {
                return
            }
            installing = true
            let workDir
            let keepFiles = false
            const progress = info => send(sender, 'mac-selfupdate-progress', info)
            try {
                log(`Install requested (current ${app.getVersion()}, ${arch})`)
                progress({ stage: 'checking' })
                const release = await latest()
                if (!semver.gt(release.version, app.getVersion())) {
                    send(sender, 'update-not-available', release)
                    return
                }
                if (!app.isPackaged) {
                    throw new Error('Install the packaged launcher in Applications before updating')
                }
                const appBundle = path.resolve(path.dirname(app.getPath('exe')), '..', '..')
                if (!appBundle.endsWith('.app')) {
                    throw new Error('Could not locate the running app bundle')
                }
                workDir = await fs.promises.mkdtemp(path.join(tempDir, 'barkan-update-'))
                const dmgPath = path.join(workDir, release.entry.fileName)
                log(`Downloading ${release.entry.url}`)
                progress({ stage: 'downloading', received: 0, total: release.entry.size })
                await downloadMacDmg(release.entry, dmgPath, fetchImpl, (received, total) => progress({ stage: 'downloading', received, total }))
                if (appBundle.includes('/AppTranslocation/') || appBundle.startsWith('/Volumes/')) {
                    const error = await shell.openPath(dmgPath)
                    if (error) {
                        throw new Error(error)
                    }
                    keepFiles = true
                    progress({ stage: 'manual' })
                    return
                }
                const staged = path.join(workDir, 'Barkan Launcher.app')
                progress({ stage: 'extracting' })
                await extractAppFromDmg(dmgPath, staged, workDir, release.version, command)
                const scripts = await writeSelfReplaceScripts(workDir)
                const suffix = path.basename(workDir)
                const newPath = path.join(path.dirname(appBundle), `.${suffix}-new.app`)
                const backupPath = path.join(path.dirname(appBundle), `.${suffix}-backup.app`)
                const logPath = path.join(app.getPath('userData'), 'logs', 'mac-update-install.log')
                await fs.promises.mkdir(path.dirname(logPath), { recursive: true })
                progress({ stage: 'installing' })
                await launch(scripts, [appBundle, staged, String(process.pid), scripts.rootPath, newPath, backupPath,
                    path.join(workDir, 'ready'), logPath, workDir])
                keepFiles = true
                log('Replacement helper ready; quitting launcher')
                app.quit()
            } catch (err) {
                log(`Install failed: ${err.stack}`)
                progress({ stage: 'failed', message: err.message })
            } finally {
                installing = false
                if (workDir && !keepFiles) {
                    await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {})
                }
            }
        }
    }
}

module.exports = { createMacUpdater, parseMacRelease, downloadMacDmg, extractAppFromDmg, writeSelfReplaceScripts, launchReplacement, runCommand }
