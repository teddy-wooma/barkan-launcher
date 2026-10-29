'use strict'

const { spawn } = require('child_process')
const path = require('path')
const address = process.argv[2]
if (!address) throw new Error('개발 서버 주소를 지정해 주세요: node tools/start-fontcache-dev.cjs host:port')
const child = spawn(require('electron'), [path.join(__dirname, '..', 'fontcache-dev-main.cjs')], {
    stdio: 'inherit',
    env: { ...process.env, BARKAN_FONT_CACHE_DEV: '1', BARKAN_DEV_SERVER: address, ELECTRON_IS_DEV: '1' }
})
child.on('error', error => { console.error(error.message); process.exitCode = 1 })
child.on('exit', code => { process.exitCode = code ?? 1 })
