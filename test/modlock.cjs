const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')

const ModLock = require('../app/assets/js/modlock')

const sha512 = buffer => crypto.createHash('sha512').update(buffer).digest('hex')

// 테스트용 파일 서버. files[경로] 를 바꾸면 «배포 서버가 변조된» 상황을 흉내 낼 수 있습니다.
async function startServer(files) {
    const server = http.createServer((req, res) => {
        const body = files[req.url]
        if(body == null){
            res.statusCode = 404
            res.end()
            return
        }
        res.setHeader('content-length', body.length)
        res.end(body)
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    return { server, base: `http://127.0.0.1:${server.address().port}` }
}

function makeLock(base, contents) {
    const entry = (name, required, file) => ({
        name,
        url: `https://modrinth.com/mod/${name}`,
        slug: name,
        required,
        version: '1.0.0',
        fileName: file,
        downloadUrl: `${base}/${file}`,
        size: contents[file].length,
        sha512: sha512(contents[file])
    })
    return ModLock.validateLock({
        mods: [
            entry('core', true, 'core-1.0.0.jar'),
            entry('extra', false, 'extra-1.0.0.jar')
        ]
    }, { allowedHosts: ['127.0.0.1'] })
}

function tempGameDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'barkan-modlock-'))
}

const ORIGINAL = {
    'core-1.0.0.jar': Buffer.from('core mod bytes'),
    'extra-1.0.0.jar': Buffer.from('extra mod bytes')
}

test('the bundled lock file is valid and only points at pinned Modrinth/GitHub files', () => {
    const lock = ModLock.loadLockSync(path.join(__dirname, '..', 'app', 'assets', 'mods.lock.json'))
    assert.ok(lock.mods.length > 0)
    for(const mod of lock.mods){
        const url = new URL(mod.downloadUrl)
        assert.equal(url.protocol, 'https:')
        if(url.hostname === 'raw.githubusercontent.com'){
            // 브랜치 이름이 아니라 커밋 SHA 로 고정돼 있어야 합니다.
            assert.match(url.pathname.split('/')[3], /^[0-9a-f]{40}$/, mod.downloadUrl)
        } else {
            assert.equal(url.hostname, 'cdn.modrinth.com')
            assert.match(url.pathname, /^\/data\/[^/]+\/versions\/[^/]+\//, mod.downloadUrl)
        }
    }
})

test('validateLock rejects unpinned or unsafe entries', () => {
    const good = {
        name: 'x', url: 'https://modrinth.com/mod/x', slug: 'x', required: true, version: '1',
        fileName: 'x.jar', downloadUrl: 'https://cdn.modrinth.com/data/a/versions/b/x.jar', size: 1, sha512: 'a'.repeat(128)
    }
    assert.doesNotThrow(() => ModLock.validateLock({ mods: [good] }))
    const bad = [
        { sha512: 'abc' },
        { sha512: undefined },
        { downloadUrl: 'https://evil.example/x.jar' },
        { downloadUrl: 'http://cdn.modrinth.com/data/a/versions/b/x.jar' },
        { downloadUrl: 'https://user:pw@cdn.modrinth.com/x.jar' },
        { fileName: '../x.jar' },
        { fileName: 'sub/x.jar' },
        { fileName: 'sub\\x.jar' },
        { fileName: '.hidden.jar' },
        { fileName: 'x.zip' },
        { slug: '../x' },
        { size: 0 },
        { required: 'yes' }
    ]
    for(const patch of bad){
        assert.throws(() => ModLock.validateLock({ mods: [{ ...good, ...patch }] }), undefined, JSON.stringify(patch))
    }
    assert.throws(() => ModLock.validateLock({ mods: [good, { ...good, slug: 'y', fileName: 'y.jar' }] }), /url/)
})

test('fresh install downloads every enabled mod and verifies its hash', async t => {
    const { server, base } = await startServer({ ...Object.fromEntries(Object.entries(ORIGINAL).map(([k, v]) => [`/${k}`, v])) })
    t.after(() => server.close())
    const dir = tempGameDir()
    const lock = makeLock(base, ORIGINAL)

    const result = await ModLock.syncMods({ directory: dir, disabledUrls: [], lock })

    assert.equal(result.ok, true, result.reason)
    for(const [file, bytes] of Object.entries(ORIGINAL)){
        assert.deepEqual(fs.readFileSync(path.join(dir, 'mods', file)), bytes)
    }
    const state = JSON.parse(fs.readFileSync(path.join(dir, 'mods', '.barkan-mod-core.json'), 'utf8'))
    assert.equal(state.sha512, sha512(ORIGINAL['core-1.0.0.jar']))
})

test('a tampered file on the download server is never written into mods', async t => {
    const served = {
        '/core-1.0.0.jar': Buffer.from('core mod bytes + backdoor'),
        '/extra-1.0.0.jar': ORIGINAL['extra-1.0.0.jar']
    }
    const { server, base } = await startServer(served)
    t.after(() => server.close())
    const dir = tempGameDir()
    const lock = makeLock(base, ORIGINAL)

    const result = await ModLock.syncMods({ directory: dir, disabledUrls: [], lock })

    assert.equal(result.ok, false)
    assert.match(result.reason, /core/)
    const files = fs.readdirSync(path.join(dir, 'mods'))
    assert.ok(!files.includes('core-1.0.0.jar'), files.join(','))
    assert.ok(!files.some(f => f.endsWith('.part')), files.join(','))
})

test('a same-size tampered file is rejected by SHA-512, not just by size', async t => {
    const forged = Buffer.from(ORIGINAL['core-1.0.0.jar'])
    forged[0] ^= 1
    const { server, base } = await startServer({ '/core-1.0.0.jar': forged, '/extra-1.0.0.jar': ORIGINAL['extra-1.0.0.jar'] })
    t.after(() => server.close())
    const dir = tempGameDir()

    const result = await ModLock.syncMods({ directory: dir, disabledUrls: [], lock: makeLock(base, ORIGINAL) })

    assert.equal(result.ok, false)
    assert.match(result.reason, /SHA-512/)
    assert.equal(fs.existsSync(path.join(dir, 'mods', 'core-1.0.0.jar')), false)
})

test('a locally modified required mod is replaced; an optional one is only reported', async t => {
    const { server, base } = await startServer(Object.fromEntries(Object.entries(ORIGINAL).map(([k, v]) => [`/${k}`, v])))
    t.after(() => server.close())
    const dir = tempGameDir()
    const lock = makeLock(base, ORIGINAL)
    await ModLock.syncMods({ directory: dir, disabledUrls: [], lock })

    fs.writeFileSync(path.join(dir, 'mods', 'core-1.0.0.jar'), 'swapped')
    fs.writeFileSync(path.join(dir, 'mods', 'extra-1.0.0.jar'), 'user changed')

    const result = await ModLock.syncMods({ directory: dir, disabledUrls: [], lock })
    const byName = Object.fromEntries(result.items.map(i => [i.name, i]))

    assert.equal(byName.core.status, 'installed')
    assert.equal(byName.core.autoUpdated, true)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'mods', 'core-1.0.0.jar')), ORIGINAL['core-1.0.0.jar'])
    assert.equal(byName.extra.status, 'outdated')
    assert.equal(fs.readFileSync(path.join(dir, 'mods', 'extra-1.0.0.jar'), 'utf8'), 'user changed')

    const update = await ModLock.updateMod({ directory: dir, url: lock.mods[1].url, lock })
    assert.equal(update.ok, true, update.reason)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'mods', 'extra-1.0.0.jar')), ORIGINAL['extra-1.0.0.jar'])
})

test('optional mods can be disabled, required mods cannot', async t => {
    const { server, base } = await startServer(Object.fromEntries(Object.entries(ORIGINAL).map(([k, v]) => [`/${k}`, v])))
    t.after(() => server.close())
    const dir = tempGameDir()
    const lock = makeLock(base, ORIGINAL)
    await ModLock.syncMods({ directory: dir, disabledUrls: [], lock })

    const disabledUrls = lock.mods.map(m => m.url)
    const result = await ModLock.syncMods({ directory: dir, disabledUrls, lock })
    const byName = Object.fromEntries(result.items.map(i => [i.name, i]))

    assert.equal(byName.core.status, 'installed')
    assert.equal(byName.extra.status, 'disabled')
    assert.ok(fs.existsSync(path.join(dir, 'mods', 'core-1.0.0.jar')))
    assert.ok(fs.existsSync(path.join(dir, ModLock.DISABLED_DIR, 'extra-1.0.0.jar')))
    assert.equal(fs.existsSync(path.join(dir, 'mods', 'extra-1.0.0.jar')), false)

    const status = await ModLock.getModStatus({ directory: dir, disabledUrls, lock })
    assert.deepEqual(status.items.map(i => i.status), ['installed', 'disabled'])
})

test('state left by the old launcher is migrated and the old jar is removed', async t => {
    const { server, base } = await startServer(Object.fromEntries(Object.entries(ORIGINAL).map(([k, v]) => [`/${k}`, v])))
    t.after(() => server.close())
    const dir = tempGameDir()
    const mods = path.join(dir, 'mods')
    fs.mkdirSync(mods, { recursive: true })
    fs.writeFileSync(path.join(mods, 'core-0.9.0.jar'), 'old core')
    fs.writeFileSync(path.join(mods, '.barkan-mod-core.json'), JSON.stringify({ slug: 'core', version: '0.9.0', fileName: 'core-0.9.0.jar' }))

    const result = await ModLock.syncMods({ directory: dir, disabledUrls: [], lock: makeLock(base, ORIGINAL) })

    assert.equal(result.ok, true, result.reason)
    assert.equal(fs.existsSync(path.join(mods, 'core-0.9.0.jar')), false)
    assert.deepEqual(fs.readFileSync(path.join(mods, 'core-1.0.0.jar')), ORIGINAL['core-1.0.0.jar'])
})

test('downloadVerified refuses to run without a hash and stops oversized bodies', async t => {
    const { server, base } = await startServer({ '/big.jar': Buffer.alloc(4096, 1) })
    t.after(() => server.close())
    const dir = tempGameDir()

    await assert.rejects(ModLock.downloadVerified({ url: `${base}/big.jar`, destination: path.join(dir, 'a.jar') }), /SHA-512/)
    await assert.rejects(ModLock.downloadVerified({
        url: `${base}/big.jar`,
        destination: path.join(dir, 'b.jar'),
        sha512: sha512(Buffer.alloc(4096, 1)),
        size: 10
    }), /예상보다 큽니다/)
    assert.deepEqual(fs.readdirSync(dir), [])
})

test('updateMod refuses mods that are not in the bundled lock', async () => {
    const lock = makeLock('http://127.0.0.1:1', ORIGINAL)
    const reply = await ModLock.updateMod({ directory: tempGameDir(), url: 'https://modrinth.com/mod/not-listed', lock })
    assert.equal(reply.ok, false)
})
