

const $                              = require('jquery')
const {ipcRenderer, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

// Base URL of the launcher's own release downloads, used on macOS to offer a
// direct .dmg link when an update is available. Only relevant once the
// auto-updater is enabled - see README.md ("자동 업데이트"). Example:
// 'https://github.com/your-user/barkan-launcher/releases/download'
const LAUNCHER_RELEASE_DOWNLOAD_BASE = null


process.traceProcessWarnings = true
process.traceDeprecation = true


window.eval = global.eval = function () {
    throw new Error('Sorry, this app does not support window.eval().')
}


remote.getCurrentWebContents().on('devtools-opened', () => {
    console.log('%cThe console is dark and full of terrors.', 'color: white; -webkit-text-stroke: 4px #a02d2a; font-size: 60px; font-weight: bold')
    console.log('%cIf you\'ve been told to paste something here, you\'re being scammed.', 'font-size: 16px')
    console.log('%cUnless you know exactly what you\'re doing, close this window.', 'font-size: 16px')
})


webFrame.setZoomLevel(0)
webFrame.setVisualZoomLevelLimits(1, 1)


const SKIN_FALLBACK_ATTR = 'data-skin-fallback'


function skinServiceUrls(kind, uuid, size){
    const s = Math.max(16, Math.round(size))

    const vs = Math.max(64, s)
    if(kind === 'head'){
        return [
            `https://minotar.net/avatar/${uuid}/${s}`,
            `https://visage.surgeplay.com/face/${vs}/${uuid}`,
            `https://crafthead.net/avatar/${uuid}/${s}`,
            `https://mc-heads.net/head/${uuid}/${s}`
        ]
    }
    return [
        `https://minotar.net/body/${uuid}/${s}`,
        `https://visage.surgeplay.com/full/${vs}/${uuid}`,
        `https://crafthead.net/body/${uuid}`,
        `https://mc-heads.net/body/${uuid}/right`
    ]
}


function skinPrimaryUrl(kind, uuid, size){
    return skinServiceUrls(kind, uuid, size)[0]
}


function skinFallbackUrls(kind, uuid, size){
    return skinServiceUrls(kind, uuid, size).slice(1).join(' ')
}


document.addEventListener('error', event => {
    const element = event.target
    if (!(element instanceof HTMLImageElement)) {
        return
    }
    const chain = element.getAttribute(SKIN_FALLBACK_ATTR)
    if (chain == null) {
        return
    }
    const [next, ...rest] = chain.split(/\s+/).filter(Boolean)
    if (rest.length > 0) {
        element.setAttribute(SKIN_FALLBACK_ATTR, rest.join(' '))
    } else {
        element.removeAttribute(SKIN_FALLBACK_ATTR)
    }
    if (next != null) {
        element.src = next
    }
}, true)


let updateCheckListener
if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'checking-for-update':
                loggerAutoUpdater.info('Checking for update..')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
                break
            case 'update-available':
                loggerAutoUpdater.info('New update available', info.version)

                if(process.platform === 'darwin' && LAUNCHER_RELEASE_DOWNLOAD_BASE != null){
                    info.darwindownload = `${LAUNCHER_RELEASE_DOWNLOAD_BASE}/v${info.version}/Barkan-Launcher-setup-${info.version}${process.arch === 'arm64' ? '-arm64' : '-x64'}.dmg`
                    showUpdateUI(info)
                }

                populateSettingsUpdateInformation(info)
                break
            case 'update-downloaded':
                loggerAutoUpdater.info('Update ' + info.version + ' ready to be installed.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, () => {
                    if(!isDev){
                        ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
                    }
                })
                showUpdateUI(info)
                break
            case 'update-not-available':
                loggerAutoUpdater.info('No new update found.')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'))
                break
            case 'ready':
                updateCheckListener = setInterval(() => {
                    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                }, 1800000)
                ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
                break
            case 'mac-selfupdate-progress':
                handleMacSelfUpdateProgress(info)
                break
            case 'realerror':
                if(info != null && info.code != null){
                    if(info.code === 'ERR_UPDATER_INVALID_RELEASE_FEED'){
                        loggerAutoUpdater.info('No suitable releases found.')
                    } else if(info.code === 'ERR_XML_MISSED_ELEMENT'){
                        loggerAutoUpdater.info('No releases found.')
                    } else {
                        loggerAutoUpdater.error('Error during update check..', info)
                        loggerAutoUpdater.debug('Error Code:', info.code)
                    }
                }
                break
            default:
                loggerAutoUpdater.info('Unknown argument', arg)
                break
        }
    })
}


function changeAllowPrerelease(val){
    ipcRenderer.send('autoUpdateAction', 'allowPrereleaseChange', val)
}

// macOS 자체 교체 업데이트의 진행 상황입니다.
// 서명 인증서가 없어 electron-updater 로는 설치할 수 없어서
// dmg 를 직접 받아 앱을 교체합니다. (index.js 의 runMacSelfUpdate)
function handleMacSelfUpdateProgress(info){
    const stage = info != null ? info.stage : null

    switch(stage){
        case 'checking':
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
            break

        case 'downloading': {
            const percent = info.total > 0 ? Math.floor((info.received / info.total) * 100) : 0
            settingsUpdateButtonStatus(`${Lang.queryJS('settings.updates.downloadingButton')} ${percent}%`, true)
            break
        }

        case 'extracting':
            settingsUpdateButtonStatus(Lang.queryJS('settings.updates.downloadingButton'), true)
            break

        case 'installing':
            // 곧 런처가 종료되고 새 버전이 설치됩니다.
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), true)
            break

        case 'up-to-date':
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'), false)
            break

        case 'manual':
            // dmg 를 열어 두었습니다. 사용자가 Applications 로 옮겨야 합니다.
            loggerAutoUpdater.info('자동 교체를 할 수 없어 dmg 를 열었습니다.', info != null ? info.reason : '')
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'), false)
            break

        case 'failed':
            loggerAutoUpdater.error('macOS 자체 교체 업데이트 실패', info != null ? info.message : '')
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'), false)
            break

        default:
            break
    }
}


function showUpdateUI(info){

    document.getElementById('image_seal_container').setAttribute('update', true)
    document.getElementById('image_seal_container').onclick = () => {


        switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
            settingsNavItemListener(document.getElementById('settingsNavUpdate'), false)
        })
    }
}


document.addEventListener('readystatechange', function () {
    if (document.readyState === 'interactive'){
        loggerUICore.info('UICore Initializing..')


        Array.from(document.getElementsByClassName('fCb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.close()
            })
        })


        Array.from(document.getElementsByClassName('fRb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                if(window.isMaximized()){
                    window.unmaximize()
                } else {
                    window.maximize()
                }
                document.activeElement.blur()
            })
        })


        Array.from(document.getElementsByClassName('fMb')).map((val) => {
            val.addEventListener('click', e => {
                const window = remote.getCurrentWindow()
                window.minimize()
                document.activeElement.blur()
            })
        })


        Array.from(document.getElementsByClassName('mediaURL')).map(val => {
            val.addEventListener('click', e => {
                document.activeElement.blur()
            })
        })

    } else if(document.readyState === 'complete'){


        document.getElementById('launch_details').style.maxWidth = 266.01
        document.getElementById('launch_progress').style.width = 170.8
        document.getElementById('launch_details_right').style.maxWidth = 170.8
        document.getElementById('launch_progress_label').style.width = 53.21

    }

}, false)


$(document).on('click', 'a[href^="http"]', function(event) {
    event.preventDefault()
    ipcRenderer.invoke('openExternal', this.href).catch(err => {
        console.error('[Links] 브라우저를 열지 못했습니다:', this.href, err)
    })
})


document.addEventListener('keydown', function (e) {
    if((e.key === 'I' || e.key === 'i') && e.ctrlKey && e.shiftKey){
        let window = remote.getCurrentWindow()
        window.toggleDevTools()
    }
})
