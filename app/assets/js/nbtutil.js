'use strict'


const TAG = {
    END: 0,
    BYTE: 1,
    SHORT: 2,
    INT: 3,
    LONG: 4,
    FLOAT: 5,
    DOUBLE: 6,
    BYTE_ARRAY: 7,
    STRING: 8,
    LIST: 9,
    COMPOUND: 10,
    INT_ARRAY: 11,
    LONG_ARRAY: 12
}


function readTag(buffer, state) {
    const type = buffer.readUInt8(state.offset)
    state.offset += 1
    return readPayload(buffer, state, type)
}


function readPayload(buffer, state, type) {
    switch (type) {
        case TAG.BYTE: {
            const value = buffer.readInt8(state.offset)
            state.offset += 1
            return { type, value }
        }
        case TAG.SHORT: {
            const value = buffer.readInt16BE(state.offset)
            state.offset += 2
            return { type, value }
        }
        case TAG.INT: {
            const value = buffer.readInt32BE(state.offset)
            state.offset += 4
            return { type, value }
        }
        case TAG.LONG: {
            const value = Number(buffer.readBigInt64BE(state.offset))
            state.offset += 8
            return { type, value }
        }
        case TAG.FLOAT: {
            const value = buffer.readFloatBE(state.offset)
            state.offset += 4
            return { type, value }
        }
        case TAG.DOUBLE: {
            const value = buffer.readDoubleBE(state.offset)
            state.offset += 8
            return { type, value }
        }
        case TAG.STRING: {
            const length = buffer.readUInt16BE(state.offset)
            state.offset += 2
            const value = buffer.subarray(state.offset, state.offset + length)
            state.offset += length
            return { type, value }
        }
        case TAG.BYTE_ARRAY: {
            const length = buffer.readInt32BE(state.offset)
            state.offset += 4
            const value = buffer.subarray(state.offset, state.offset + length)
            state.offset += length
            return { type, value }
        }
        case TAG.INT_ARRAY: {
            const length = buffer.readInt32BE(state.offset)
            state.offset += 4
            const value = buffer.subarray(state.offset, state.offset + length * 4)
            state.offset += length * 4
            return { type, value }
        }
        case TAG.LONG_ARRAY: {
            const length = buffer.readInt32BE(state.offset)
            state.offset += 4
            const value = buffer.subarray(state.offset, state.offset + length * 8)
            state.offset += length * 8
            return { type, value }
        }
        case TAG.LIST: {
            const elemType = buffer.readUInt8(state.offset)
            state.offset += 1
            const length = buffer.readInt32BE(state.offset)
            state.offset += 4
            const items = []
            for (let i = 0; i < length; i++) {
                items.push(readPayload(buffer, state, elemType))
            }
            return { type, elemType, items }
        }
        case TAG.COMPOUND: {
            const entries = []
            for (;;) {
                const childType = buffer.readUInt8(state.offset)
                state.offset += 1
                if (childType === TAG.END) {
                    break
                }
                const nameLength = buffer.readUInt16BE(state.offset)
                state.offset += 2
                const name = buffer.subarray(state.offset, state.offset + nameLength)
                state.offset += nameLength
                entries.push([name, readPayload(buffer, state, childType)])
            }
            return { type, entries }
        }
        default:
            throw new Error(`알 수 없는 NBT 태그 종류: ${type}`)
    }
}


function parse(buffer) {
    const state = { offset: 0 }
    const type = buffer.readUInt8(state.offset)
    state.offset += 1
    if (type !== TAG.COMPOUND) {
        throw new Error('NBT 복합 태그로 시작하지 않습니다.')
    }
    const nameLength = buffer.readUInt16BE(state.offset)
    state.offset += 2 + nameLength
    return readPayload(buffer, state, TAG.COMPOUND)
}


function writePayload(tag, out) {
    switch (tag.type) {
        case TAG.BYTE: {
            const b = Buffer.alloc(1)
            b.writeInt8(tag.value)
            out.push(b)
            break
        }
        case TAG.SHORT: {
            const b = Buffer.alloc(2)
            b.writeInt16BE(tag.value)
            out.push(b)
            break
        }
        case TAG.INT: {
            const b = Buffer.alloc(4)
            b.writeInt32BE(tag.value)
            out.push(b)
            break
        }
        case TAG.LONG: {
            const b = Buffer.alloc(8)
            b.writeBigInt64BE(BigInt(Math.trunc(tag.value)))
            out.push(b)
            break
        }
        case TAG.FLOAT: {
            const b = Buffer.alloc(4)
            b.writeFloatBE(tag.value)
            out.push(b)
            break
        }
        case TAG.DOUBLE: {
            const b = Buffer.alloc(8)
            b.writeDoubleBE(tag.value)
            out.push(b)
            break
        }
        case TAG.STRING: {
            const header = Buffer.alloc(2)
            header.writeUInt16BE(tag.value.length)
            out.push(header, tag.value)
            break
        }
        case TAG.BYTE_ARRAY:
        case TAG.INT_ARRAY:
        case TAG.LONG_ARRAY: {
            const unit = tag.type === TAG.BYTE_ARRAY ? 1 : (tag.type === TAG.INT_ARRAY ? 4 : 8)
            const header = Buffer.alloc(4)
            header.writeInt32BE(tag.value.length / unit)
            out.push(header, tag.value)
            break
        }
        case TAG.LIST: {
            const header = Buffer.alloc(5)
            header.writeUInt8(tag.elemType, 0)
            header.writeInt32BE(tag.items.length, 1)
            out.push(header)
            tag.items.forEach(item => writePayload(item, out))
            break
        }
        case TAG.COMPOUND: {
            tag.entries.forEach(([name, child]) => {
                const header = Buffer.alloc(2)
                header.writeUInt16BE(name.length)
                out.push(Buffer.from([child.type]), header, name)
                writePayload(child, out)
            })
            out.push(Buffer.from([TAG.END]))
            break
        }
        default:
            throw new Error(`알 수 없는 NBT 태그 종류: ${tag.type}`)
    }
}


function write(root) {
    const out = [Buffer.from([TAG.COMPOUND, 0x00, 0x00])]
    writePayload(root, out)
    return Buffer.concat(out)
}

function makeCompound(entries) {
    return { type: TAG.COMPOUND, entries: entries || [] }
}

function makeString(value) {
    return { type: TAG.STRING, value: Buffer.from(value, 'utf8') }
}


function findChild(compoundTag, name) {
    return compoundTag.entries.find(([childName]) => childName.toString('utf8') === name) || null
}

function setString(compoundTag, name, value) {
    const found = findChild(compoundTag, name)
    if (found != null) {
        found[1] = makeString(value)
        return
    }
    compoundTag.entries.push([Buffer.from(name, 'utf8'), makeString(value)])
}

function setByte(compoundTag, name, value) {
    const found = findChild(compoundTag, name)
    if (found != null) {
        found[1] = { type: TAG.BYTE, value }
        return
    }
    compoundTag.entries.push([Buffer.from(name, 'utf8'), { type: TAG.BYTE, value }])
}


function endpointOf(ip) {
    try {
        const url = new URL(`minecraft://${String(ip || '').trim()}`)
        if (!url.hostname || url.pathname || url.search || url.hash || url.username || url.password) {
            return null
        }
        return `${url.hostname.toLowerCase()}:${url.port || '25565'}`
    } catch (_) {
        return null
    }
}


exports.ensureServer = function (buffer, options) {
    const name = String((options && options.name) || '')
    const ip = String((options && options.ip) || '')
    const quickPlayIp = String((options && options.quickPlayAddress) || '')
    const endpoint = endpointOf(ip)
    if (endpoint == null) {
        throw new Error('서버 주소가 비어 있습니다.')
    }
    if (quickPlayIp && endpointOf(quickPlayIp) !== endpoint) {
        throw new Error('자동 접속 주소가 서버 주소와 다릅니다.')
    }

    let root
    if (buffer != null && buffer.length > 0) {
        root = parse(buffer)
    } else {
        root = makeCompound([])
    }

    let listEntry = findChild(root, 'servers')
    if (listEntry == null || listEntry[1].type !== TAG.LIST) {
        listEntry = [Buffer.from('servers', 'utf8'), { type: TAG.LIST, elemType: TAG.COMPOUND, items: [] }]
        root.entries.push(listEntry)
    }

    const list = listEntry[1]
    const matches = item => {
        if (item.type !== TAG.COMPOUND) {
            return false
        }
        const ipTag = findChild(item, 'ip')
        return ipTag != null && ipTag[1].type === TAG.STRING && endpointOf(ipTag[1].value.toString('utf8')) === endpoint
    }
    let server = list.items.find(item => matches(item) && findChild(item, 'hidden')?.[1].value !== 1)

    if (server == null) {
        server = makeCompound([])
        setString(server, 'ip', ip)
        if (name.length > 0) {
            setString(server, 'name', name)
        }
        setByte(server, 'hidden', 0)
        list.items.push(server)
    }

    // Quick Play searches servers.dat by the exact "host:port" string, including hidden entries.
    // Updating only the visible "host" entry leaves its separate Quick Play entry at PROMPT.
    const quickPlay = quickPlayIp || endpoint
    if (!list.items.some(item => {
        if (item.type !== TAG.COMPOUND) return false
        const ipTag = findChild(item, 'ip')
        return ipTag != null && ipTag[1].type === TAG.STRING && ipTag[1].value.toString('utf8') === quickPlay
    })) {
        const hidden = makeCompound([])
        setString(hidden, 'ip', quickPlay)
        setString(hidden, 'name', name || 'Minecraft 서버')
        setByte(hidden, 'hidden', 1)
        list.items.push(hidden)
    }
    for (const item of list.items) {
        if (matches(item)) {
            setByte(item, 'acceptTextures', 1)
        }
    }

    return write(root)
}


exports.listServers = function (buffer) {
    const root = parse(buffer)
    const listEntry = findChild(root, 'servers')
    if (listEntry == null || listEntry[1].type !== TAG.LIST) {
        return []
    }
    return listEntry[1].items.map(item => {
        const nameTag = findChild(item, 'name')
        const ipTag = findChild(item, 'ip')
        const acceptTag = findChild(item, 'acceptTextures')
        const hiddenTag = findChild(item, 'hidden')
        return {
            name: nameTag != null ? nameTag[1].value.toString('utf8') : '',
            ip: ipTag != null ? ipTag[1].value.toString('utf8') : '',
            acceptTextures: acceptTag != null ? acceptTag[1].value : null,
            hidden: hiddenTag != null ? hiddenTag[1].value === 1 : false
        }
    })
}
