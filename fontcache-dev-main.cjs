'use strict'

const { app } = require('electron')
const fs = require('fs')
const path = require('path')

if (app.isPackaged || process.env.BARKAN_FONT_CACHE_DEV !== '1') throw new Error('개발 실행 전용 진입점입니다.')
if (!process.env.BARKAN_DEV_SERVER) throw new Error('개발 서버 주소가 필요합니다.')
require('./app/assets/js/fontcachedev').distribution(require('./app/assets/distribution.json'))
const root = path.join(__dirname, '.font-cache-dev')
const userData = path.join(root, 'launcher')
fs.mkdirSync(userData, { recursive: true })
app.setName('Barkan Font Cache Dev')
app.setPath('userData', userData)
process.env.BARKAN_DATA_DIR = path.join(root, 'game')
process.env.BARKAN_FONT_CACHE_DEV_ENTRY = 'isolated'
process.env.ELECTRON_IS_DEV = '1'
require('./index.js')
