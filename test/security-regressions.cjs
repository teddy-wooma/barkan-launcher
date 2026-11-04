// 소스 수준 회귀 검사. 2026-11 공급망 점검에서 찾은 구멍이 다시 열리지 않게 막습니다.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const read = file => fs.readFileSync(path.join(ROOT, file), 'utf8')

test('mods are not fetched from a mutable remote list at runtime', () => {
    const main = read('index.js')
    assert.doesNotMatch(main, /FISH_MOD_LIST\/[^'"]*mods\.json/)
    assert.doesNotMatch(main, /api\.modrinth\.com/)
    assert.match(main, /ModLock\.syncMods\(/)
})

test('every jar the distribution index puts into mods/ carries a SHA-512', () => {
    const distro = JSON.parse(read('app/assets/distribution.json'))
    for(const mod of distro.clientMods || []){
        assert.match(String(mod.sha512), /^[0-9a-f]{128}$/, mod.name)
        assert.ok(Number.isSafeInteger(mod.size) && mod.size > 0, mod.name)
    }
})

test('links are not opened through cmd.exe', () => {
    assert.doesNotMatch(read('index.js'), /spawn\(\s*['"]cmd(\.exe)?['"]/i)
})

test('the Node-enabled main window cannot navigate away from the launcher pages', () => {
    const main = read('index.js')
    assert.match(main, /remoteMain\.enable\(win\.webContents\)\s*\n\s*lockMainWindowNavigation\(win\.webContents\)/)
    assert.match(main, /'will-navigate'/)
    assert.match(main, /setWindowOpenHandler/)
})

test('server status values are never written as HTML', () => {
    const landing = read('app/assets/js/scripts/landing.js')
    assert.doesNotMatch(landing, /player_count'\)\.innerHTML/)
    assert.doesNotMatch(landing, /landingPlayerLabel'\)\.innerHTML/)
    assert.match(landing, /Number\.isSafeInteger\(online\)/)
})
