#!/usr/bin/env node
'use strict'

// 런처에 넣을 모드 잠금 파일(app/assets/mods.lock.json)을 만듭니다.
//
//   node tools/lock-mods.cjs                    # FISH_MOD_LIST main 의 mods.json 기준
//   node tools/lock-mods.cjs --source ./mods.json --ref <커밋 또는 브랜치>
//   node tools/lock-mods.cjs --distribution     # 배포 인덱스의 셰이더 모드·셰이더팩 해시도 채움
//
// 하는 일
//   1. 목록 저장소의 브랜치를 «커밋 SHA» 로 고정합니다. GitHub 직접 jar 는 그 커밋 주소로 받습니다.
//   2. 모드린스 모드는 런처가 예전에 하던 것과 똑같이 1.21.11 + fabric 의 최신 release(없으면 beta)를 고르고,
//      그 «버전 ID» 의 파일 주소로 고정합니다.
//   3. 파일을 실제로 내려받아 SHA-512 와 크기를 잽니다. 모드린스가 알려 준 해시와 다르면 멈춥니다.
//   4. 결과를 검증(validateLock)한 뒤 씁니다.
//
// 결과 파일의 diff 를 사람이 확인하고 커밋한 다음 런처를 배포해야 유저에게 반영됩니다.
// 이 도구는 패키지에 들어가지 않습니다. (electron-builder.yml 의 '!tools')

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ModLock = require('../app/assets/js/modlock')

const ROOT = path.join(__dirname, '..')
const MODRINTH_API = 'https://api.modrinth.com/v2'
const MOD_LOADER = 'fabric'
const MOD_GAME_VERSION = '1.21.11'
const USER_AGENT = 'barkan-launcher/lock-mods (https://github.com/teddy-wooma/barkan-launcher)'

function parseArgs(argv) {
    const args = {
        repo: 'teddy-wooma/FISH_MOD_LIST',
        ref: 'main',
        source: null,
        out: path.join(ROOT, 'app', 'assets', 'mods.lock.json'),
        distribution: false
    }
    for(let i = 0; i < argv.length; i++){
        const key = argv[i]
        const next = () => {
            if(i + 1 >= argv.length){
                throw new Error(`${key} 뒤에 값이 필요합니다.`)
            }
            return argv[++i]
        }
        if(key === '--repo') args.repo = next()
        else if(key === '--ref') args.ref = next()
        else if(key === '--source') args.source = next()
        else if(key === '--out') args.out = path.resolve(next())
        else if(key === '--distribution') args.distribution = true
        else throw new Error(`알 수 없는 인자: ${key}`)
    }
    return args
}

async function request(url, accept) {
    const headers = { 'user-agent': USER_AGENT }
    if(accept){
        headers.accept = accept
    }
    if(process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com'){
        headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
    }
    const response = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) })
    if(!response.ok){
        throw new Error(`${url} → HTTP ${response.status}`)
    }
    return response
}

async function getJson(url) {
    return JSON.parse(await (await request(url, 'application/json')).text())
}

async function getBytes(url) {
    return Buffer.from(await (await request(url)).arrayBuffer())
}

const commitCache = new Map()
async function resolveCommit(repo, ref) {
    if(/^[0-9a-f]{40}$/i.test(ref)){
        return ref.toLowerCase()
    }
    const key = `${repo}@${ref}`
    if(!commitCache.has(key)){
        const sha = (await (await request(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`, 'application/vnd.github.sha')).text()).trim()
        if(!/^[0-9a-f]{40}$/.test(sha)){
            throw new Error(`${key} 의 커밋을 확인하지 못했습니다: ${sha.slice(0, 80)}`)
        }
        commitCache.set(key, sha)
    }
    return commitCache.get(key)
}

function sha512(buffer) {
    return crypto.createHash('sha512').update(buffer).digest('hex')
}

function modrinthSlug(url) {
    const match = /modrinth\.com\/mod\/([^/?#]+)/i.exec(String(url || ''))
    return match ? match[1] : null
}

// 예전 런처의 상태 파일 이름(.barkan-mod-<slug>.json)과 같게 만들어야 기존 설치를 이어받습니다.
function directSlug(fileName) {
    return fileName.replace(/[^0-9A-Za-z._-]/g, '_')
}

async function lockModrinth(mod, slug) {
    const base = `loaders=${encodeURIComponent(JSON.stringify([MOD_LOADER]))}`
        + `&game_versions=${encodeURIComponent(JSON.stringify([MOD_GAME_VERSION]))}`
    for(const channel of ['release', 'beta']){
        const list = await getJson(`${MODRINTH_API}/project/${encodeURIComponent(slug)}/version?${base}&version_type=${channel}`)
        if(!Array.isArray(list) || list.length === 0){
            continue
        }
        const version = list[0]
        const files = Array.isArray(version.files) ? version.files : []
        const file = files.find(f => f.primary === true) || files[0]
        if(file == null || !file.url){
            continue
        }
        const bytes = await getBytes(file.url)
        const digest = sha512(bytes)
        const reported = file.hashes && file.hashes.sha512
        if(reported && reported !== digest){
            throw new Error(`${mod.name}: 모드린스가 알려 준 SHA-512 와 받은 파일이 다릅니다.`)
        }
        return {
            slug,
            version: `${version.version_number} (${version.id})`,
            fileName: path.basename(file.filename),
            downloadUrl: file.url,
            size: bytes.length,
            sha512: digest
        }
    }
    throw new Error(`${mod.name}: ${MOD_GAME_VERSION} + ${MOD_LOADER} 버전을 찾지 못했습니다.`)
}

async function lockGitHubBlob(mod, owner, repo, ref, filePath) {
    const commit = await resolveCommit(`${owner}/${repo}`, ref)
    const downloadUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${commit}/${filePath}`
    const bytes = await getBytes(downloadUrl)
    const fileName = decodeURIComponent(filePath.split('/').pop() || '')
    return {
        slug: directSlug(fileName),
        version: `${ref}@${commit.slice(0, 7)}`,
        fileName,
        downloadUrl,
        size: bytes.length,
        sha512: sha512(bytes)
    }
}

async function lockEntry(mod, required) {
    const slug = modrinthSlug(mod.url)
    let locked
    if(slug != null){
        locked = await lockModrinth(mod, slug)
    } else {
        const blob = /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/i.exec(mod.url)
        if(blob == null){
            throw new Error(`${mod.name}: 모드린스 주소나 GitHub blob 주소만 지원합니다. (${mod.url})`)
        }
        locked = await lockGitHubBlob(mod, blob[1], blob[2], blob[3], blob[4])
    }
    return { name: String(mod.name || mod.url), url: mod.url, required, ...locked }
}

async function readSource(args) {
    if(args.source != null && !/^https?:\/\//i.test(args.source)){
        return { list: JSON.parse(fs.readFileSync(args.source, 'utf8')), origin: path.resolve(args.source) }
    }
    if(args.source != null){
        return { list: await getJson(args.source), origin: args.source }
    }
    const commit = await resolveCommit(args.repo, args.ref)
    const url = `https://raw.githubusercontent.com/${args.repo}/${commit}/mods.json`
    return { list: await getJson(url), origin: url }
}

async function fillDistributionHashes() {
    const file = path.join(ROOT, 'app', 'assets', 'distribution.json')
    const distro = JSON.parse(fs.readFileSync(file, 'utf8'))
    const targets = [
        ...(distro.clientMods || []),
        ...Object.values(distro.shaders || {})
    ]
    for(const entry of targets){
        const bytes = await getBytes(entry.url)
        entry.size = bytes.length
        entry.sha512 = sha512(bytes)
        console.log(`  distribution  ${entry.name.padEnd(40)} ${entry.sha512.slice(0, 16)}…  ${bytes.length}B`)
    }
    fs.writeFileSync(file, JSON.stringify(distro, null, 4) + '\n', 'utf8')
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    const { list, origin } = await readSource(args)
    console.log(`목록: ${origin}`)

    const mods = []
    for(const [key, required] of [['required', true], ['optional', false]]){
        for(const mod of (Array.isArray(list[key]) ? list[key] : [])){
            if(mod == null || typeof mod.url !== 'string'){
                continue
            }
            const entry = await lockEntry(mod, required)
            console.log(`  ${required ? '필수' : '선택'}  ${entry.name.padEnd(28)} ${entry.version.padEnd(36)} ${entry.sha512.slice(0, 16)}…`)
            mods.push(entry)
        }
    }

    const lock = {
        schema: 1,
        minecraft: MOD_GAME_VERSION,
        loader: MOD_LOADER,
        source: origin,
        generatedAt: new Date().toISOString(),
        mods
    }
    ModLock.validateLock(lock)
    fs.writeFileSync(args.out, JSON.stringify(lock, null, 2) + '\n', 'utf8')
    console.log(`썼습니다: ${path.relative(ROOT, args.out)} (${mods.length}개)`)

    if(args.distribution){
        await fillDistributionHashes()
    }
}

main().catch(err => {
    console.error(err.message || err)
    process.exit(1)
})
