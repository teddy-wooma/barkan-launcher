

const $                              = require('jquery')
const {ipcRenderer, webFrame} = require('electron')
const remote                         = require('@electron/remote')
const isDev                          = require('./assets/js/isdev')
const { LoggerUtil }                 = require('helios-core')
const Lang                           = require('./assets/js/langloader')

const loggerUICore             = LoggerUtil.getLogger('UICore')
const loggerAutoUpdater        = LoggerUtil.getLogger('AutoUpdater')

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


let availableUpdateInfo = null
let updateDownloaded = false
let macSelfUpdateProgress = null
let updateCheckListener

function requestUpdateCheck(){
    settingsUpdateStatusMessage('')
    settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
    ipcRenderer.send('autoUpdateAction', 'checkForUpdate')
}

function requestUpdateInstall(){
    if(process.platform === 'darwin'){
        handleMacSelfUpdateProgress({ stage: 'checking' })
    }
    ipcRenderer.send('autoUpdateAction', 'installUpdateNow')
}

if(!isDev){
    ipcRenderer.on('autoUpdateNotification', (event, arg, info) => {
        switch(arg){
            case 'checking-for-update':
                loggerAutoUpdater.info('Checking for update..')
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton'), true)
                break
            case 'update-available':
                loggerAutoUpdater.info('New update available', info.version)

                availableUpdateInfo = info
                updateDownloaded = false
                settingsUpdateStatusMessage('')
                if(process.platform === 'darwin'){
                    showUpdateUI(info)
                }

                populateSettingsUpdateInformation(info)
                break
            case 'update-downloaded':
                loggerAutoUpdater.info('Update ' + info.version + ' ready to be installed.')
                availableUpdateInfo = info
                updateDownloaded = true
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, requestUpdateInstall)
                showUpdateUI(info)
                break
            case 'update-not-available':
                loggerAutoUpdater.info('No new update found.')
                availableUpdateInfo = null
                updateDownloaded = false
                macSelfUpdateProgress = null
                populateSettingsUpdateInformation(null)
                settingsUpdateStatusMessage('')
                document.getElementById('image_seal_container').removeAttribute('update')
                break
            case 'ready':
                clearInterval(updateCheckListener)
                updateCheckListener = setInterval(() => {
                    ipcRenderer.send('autoUpdateAction', process.platform === 'darwin' ? 'checkMacUpdate' : 'checkForUpdate')
                }, 1800000)
                ipcRenderer.send('autoUpdateAction', process.platform === 'darwin' ? 'checkMacUpdate' : 'checkForUpdate')
                break
            case 'mac-selfupdate-progress':
                handleMacSelfUpdateProgress(info)
                break
            case 'realerror':
                // 확인이 실패해도 버튼이 "확인 중"에 멈추지 않게 되돌립니다.
                settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.checkForUpdatesButton'), false, requestUpdateCheck)
                settingsUpdateStatusMessage(info && info.message ? info.message : Lang.queryJS('settings.updates.checkFailed'))
                loggerAutoUpdater.error('Update check failed', info)
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

// Keep both entry points disabled while a single update is running.
function handleMacSelfUpdateProgress(info){
    macSelfUpdateProgress = info
    const stage = info != null ? info.stage : null
    let text
    switch(stage){
        case 'checking':
            text = Lang.queryJS('uicore.autoUpdate.checkingForUpdateButton')
            break
        case 'downloading': {
            const percent = info.total > 0 ? Math.min(100, Math.floor(info.received / info.total * 100)) : 0
            text = `${Lang.queryJS('settings.updates.downloadingButton')} ${percent}%`
            break
        }
        case 'extracting':
            text = Lang.queryJS('settings.updates.extractingButton')
            break
        case 'installing':
            text = Lang.queryJS('settings.updates.installingButton')
            break
        case 'manual':
        case 'failed': {
            macSelfUpdateProgress = null
            const message = stage === 'manual'
                ? Lang.queryJS('settings.updates.manualInstallMessage')
                : `${Lang.queryJS('settings.updates.installFailed')} ${info.message || ''}`
            loggerAutoUpdater.error(message)
            settingsUpdateStatusMessage(message)
            settingsUpdateButtonStatus(Lang.queryJS('uicore.autoUpdate.installNowButton'), false, requestUpdateInstall)
            showLandingUpdateNotice(availableUpdateInfo, true)
            setOverlayContent(Lang.queryJS('settings.updates.updateMessageTitle'), '', Lang.queryJS('settings.msftLogin.okButton'))
            document.getElementById('overlayDesc').textContent = message
            setOverlayHandler(null)
            toggleOverlay(true)
            return
        }
        default:
            return
    }
    settingsUpdateStatusMessage('')
    settingsUpdateButtonStatus(text, true)
    const button = document.getElementById('updateNoticeButton')
    if(button != null){
        button.textContent = text
        button.disabled = true
        button.onclick = null
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
