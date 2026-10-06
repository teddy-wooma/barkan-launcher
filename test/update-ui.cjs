const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')

const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)))

function ui(platform = 'darwin') {
    const ipcRenderer = new EventEmitter()
    const sends = []
    ipcRenderer.send = (...args) => sends.push(args)
    const elements = new Map()
    const element = id => {
        if (!elements.has(id)) {
            elements.set(id, { innerHTML: '', textContent: '', style: {}, disabled: false, onclick: null,
                removeAttribute() {}, setAttribute() {} })
        }
        return elements.get(id)
    }
    const context = vm.createContext({
        ipcRenderer, process: { platform }, isDev: false,
        Lang: { queryJS: key => key }, loggerAutoUpdater: { info() {}, error() {}, debug() {} },
        remote: { app: { getVersion: () => '1.0.11' } },
        document: { getElementById: element }, clearInterval() {}, setInterval() {},
        showUpdateUI() {}, setOverlayContent() {}, setOverlayHandler() {}, toggleOverlay() {},
        isPrerelease: () => false, renderReleaseNotes: text => text,
        populateVersionInformation: version => { element('version').textContent = version },
        ...Object.fromEntries(['settingsUpdateTitle', 'settingsUpdateChangelogCont', 'settingsUpdateChangelogTitle',
            'settingsUpdateChangelogText', 'settingsUpdateVersionValue', 'settingsUpdateVersionTitle',
            'settingsUpdateVersionCheck', 'settingsUpdateActionButton'].map(id => [id, element(id)]))
    })
    const core = source('app/assets/js/scripts/uicore.js')
    const settings = source('app/assets/js/scripts/settings.js')
    const landing = source('app/assets/js/scripts/landing.js')
    vm.runInContext(section(core, 'let availableUpdateInfo', '\n\nfunction showUpdateUI'), context)
    vm.runInContext(section(settings, 'function settingsUpdateButtonStatus', '// 릴리즈 노트'), context)
    vm.runInContext(section(settings, 'function populateSettingsUpdateInformation', 'const settingsLanguageList'), context)
    vm.runInContext(landing.slice(landing.indexOf('function showLandingUpdateNotice')), context)
    const emit = (type, data) => ipcRenderer.emit('autoUpdateNotification', {}, type, data)
    return { context, sends, element, emit }
}

test('both macOS buttons install; progress clears old handlers and disables both buttons', () => {
    const h = ui()
    h.emit('update-available', { version: '1.0.14', releaseName: '1.0.14', releaseNotes: 'Fix' })
    const settings = h.element('settingsUpdateActionButton')
    const landing = h.element('updateNoticeButton')
    assert.equal(settings.disabled, false)
    assert.equal(landing.disabled, false)
    landing.onclick()
    assert.equal(h.sends.at(-1)[1], 'installUpdateNow')
    assert.equal(settings.disabled, true)
    assert.equal(settings.onclick, null)
    assert.equal(landing.disabled, true)
    assert.equal(landing.onclick, null)
    h.emit('mac-selfupdate-progress', { stage: 'downloading', total: 100, received: 50 })
    assert.match(settings.innerHTML, /50%/)
    assert.match(landing.textContent, /50%/)
})

test('failed installs show the reason and restore real retry handlers on both buttons', () => {
    const h = ui()
    h.emit('update-available', { version: '1.0.14', releaseName: '1.0.14', releaseNotes: '' })
    h.element('settingsUpdateActionButton').onclick()
    h.emit('mac-selfupdate-progress', { stage: 'failed', message: 'checksum mismatch' })
    assert.match(h.element('settingsUpdateStatusMessage').textContent, /checksum mismatch/)
    assert.match(h.element('overlayDesc').textContent, /checksum mismatch/)
    assert.equal(h.element('settingsUpdateActionButton').disabled, false)
    assert.equal(h.element('updateNoticeButton').disabled, false)
    h.element('settingsUpdateActionButton').onclick()
    assert.equal(h.sends.at(-1)[1], 'installUpdateNow')
})

test('checking after an install replaces its handler; no-update response clears stale version and banner', () => {
    const h = ui()
    h.emit('update-available', { version: '1.0.14', releaseName: '1.0.14', releaseNotes: '' })
    h.emit('checking-for-update')
    assert.equal(h.element('settingsUpdateActionButton').onclick, null)
    h.emit('update-not-available', { version: '1.0.11' })
    assert.equal(h.element('version').textContent, '1.0.11')
    assert.equal(h.element('updateNotice').style.display, 'none')
    h.element('settingsUpdateActionButton').onclick()
    assert.equal(h.sends.at(-1)[1], 'checkForUpdate')
    assert.equal(h.element('settingsUpdateActionButton').onclick, null)
})

test('settings initialization preserves an available update and an active download', () => {
    const h = ui()
    h.emit('update-available', { version: '1.0.14', releaseName: '1.0.14', releaseNotes: '' })
    vm.runInContext('prepareUpdateTab()', h.context)
    assert.match(h.element('settingsUpdateActionButton').innerHTML, /installNowButton/)
    h.emit('mac-selfupdate-progress', { stage: 'downloading', received: 10, total: 100 })
    vm.runInContext('prepareUpdateTab()', h.context)
    assert.equal(h.element('settingsUpdateActionButton').disabled, true)
    assert.match(h.element('settingsUpdateActionButton').innerHTML, /10%/)
})

test('a check failure is visible and check can be retried', () => {
    const h = ui()
    h.emit('realerror', { message: 'HTTP 503' })
    assert.equal(h.element('settingsUpdateStatusMessage').textContent, 'HTTP 503')
    h.element('settingsUpdateActionButton').onclick()
    assert.equal(h.sends.at(-1)[1], 'checkForUpdate')
})

test('Windows waits for update-downloaded; downloaded state survives settings initialization', () => {
    const h = ui('win32')
    const info = { version: '1.0.14', releaseName: '1.0.14', releaseNotes: '' }
    h.emit('update-available', info)
    assert.equal(h.element('settingsUpdateActionButton').disabled, true)
    assert.equal(h.element('updateNoticeButton').disabled, true)
    h.emit('update-downloaded', info)
    vm.runInContext('prepareUpdateTab()', h.context)
    assert.equal(h.element('settingsUpdateActionButton').disabled, false)
    h.element('settingsUpdateActionButton').onclick()
    assert.equal(h.sends.at(-1)[1], 'installUpdateNow')
})

test('IPC dispatch routes all macOS actions to the custom updater and keeps Windows on electron-updater', async () => {
    const main = source('index.js')
    for (const platform of ['darwin', 'win32']) {
        let handler
        const calls = []
        const context = vm.createContext({
            ipcMain: { on: (_channel, fn) => { handler = fn } }, process: { platform },
            macUpdater: { check: sender => calls.push(['mac-check', sender]), install: sender => calls.push(['mac-install', sender]) },
            autoUpdater: { checkForUpdates: async () => { calls.push(['win-check']) }, quitAndInstall: () => calls.push(['win-install']) }
        })
        vm.runInContext(section(main, "ipcMain.on('autoUpdateAction'", '// 배포 인덱스는'), context)
        handler({ sender: 'renderer' }, 'checkForUpdate')
        handler({ sender: 'renderer' }, 'installUpdateNow')
        if (platform === 'darwin') {
            handler({ sender: 'renderer' }, 'checkMacUpdate')
            assert.deepEqual(calls, [['mac-check', 'renderer'], ['mac-install', 'renderer'], ['mac-check', 'renderer']])
        } else {
            assert.deepEqual(calls, [['win-check'], ['win-install']])
        }
    }
})
