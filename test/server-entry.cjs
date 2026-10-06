const test = require('node:test')
const assert = require('node:assert/strict')

const NbtUtil = require('../app/assets/js/nbtutil')

function withRejectedPack(buffer, occurrence) {
    const changed = Buffer.from(buffer)
    const tagName = Buffer.from('acceptTextures')
    let offset = -1
    for (let i = 0; i < occurrence; i++) {
        offset = changed.indexOf(tagName, offset + 1)
        assert.notEqual(offset, -1)
    }
    changed.writeInt8(0, offset + tagName.length)
    return changed
}

test('Quick Play and visible Barkan entries both accept server resource packs', () => {
    const options = {
        name: '바르칸 열도',
        ip: 'barkan.kr',
        quickPlayAddress: 'barkan.kr:25565'
    }
    const first = NbtUtil.ensureServer(null, options)
    const entries = NbtUtil.listServers(first)

    assert.deepEqual(entries.map(({ ip, acceptTextures, hidden }) => ({ ip, acceptTextures, hidden })), [
        { ip: 'barkan.kr', acceptTextures: 1, hidden: false },
        { ip: 'barkan.kr:25565', acceptTextures: 1, hidden: true }
    ])
    assert.deepEqual(NbtUtil.ensureServer(first, options), first)

    const previouslyRejected = withRejectedPack(first, 2)
    assert.equal(NbtUtil.listServers(previouslyRejected)[1].acceptTextures, 0)
    const repaired = NbtUtil.ensureServer(previouslyRejected, options)
    assert.equal(NbtUtil.listServers(repaired)[1].acceptTextures, 1)
})

test('another port on the same host keeps its resource pack preference', () => {
    const other = withRejectedPack(NbtUtil.ensureServer(null, {
        name: '다른 서버', ip: 'barkan.kr:25566', quickPlayAddress: 'barkan.kr:25566'
    }), 1)
    const updated = NbtUtil.ensureServer(other, {
        name: '바르칸 열도', ip: 'barkan.kr', quickPlayAddress: 'barkan.kr:25565'
    })
    const entries = NbtUtil.listServers(updated)

    assert.equal(entries.filter(entry => entry.ip === 'barkan.kr:25566').length, 1)
    assert.equal(entries.find(entry => entry.ip === 'barkan.kr:25566').acceptTextures, 0)
    assert.equal(entries.find(entry => entry.ip === 'barkan.kr:25565').acceptTextures, 1)
    assert.equal(entries.find(entry => entry.ip === 'barkan.kr:25565').hidden, true)
})
