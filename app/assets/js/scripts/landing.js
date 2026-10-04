

const { URL }                 = require('url')
const {
    MojangRestAPI,
    getServerStatus
}                             = require('helios-core/mojang')
const {
    RestResponseStatus,
    isDisplayableError,
    validateLocalFile
}                             = require('helios-core/common')
const {
    FullRepair,
    DistributionIndexProcessor,
    MojangIndexProcessor,
    downloadFile
}                             = require('helios-core/dl')
const {
    validateSelectedJvm,
    ensureJavaDirIsRoot,
    javaExecFromRoot,
    discoverBestJvmInstallation,
    latestOpenJDK,
    extractJdk
}                             = require('helios-core/java')


const DiscordWrapper          = require('./assets/js/discordwrapper')
const ProcessBuilder          = require('./assets/js/processbuilder')


const launch_content          = document.getElementById('launch_content')
const launch_details          = document.getElementById('launch_details')
const launch_progress         = document.getElementById('launch_progress')
const launch_progress_label   = document.getElementById('launch_progress_label')
const launch_details_text     = document.getElementById('launch_details_text')
const server_selection_button = document.getElementById('server_selection_button')
const user_text               = document.getElementById('user_text')

const loggerLanding = LoggerUtil.getLogger('Landing')


function toggleLaunchArea(loading){
    // 셰이더 줄은 실행 중에 숨깁니다.
    // 등급 버튼이 토글 아래에 떠 있는 구조라, 진행 표시(#launch_details)와
    // 자리가 겹쳐 글자가 겹쳐 보입니다.
    const shaderBar = document.getElementById('shaderBar')

    if(loading){
        launch_details.style.display = 'flex'
        launch_content.style.display = 'none'
        if(shaderBar != null){
            shaderBar.style.display = 'none'
        }
    } else {
        launch_details.style.display = 'none'
        launch_content.style.display = 'inline-flex'
        if(shaderBar != null){
            shaderBar.style.display = 'inline-flex'
        }
    }
}


function setLaunchDetails(details){
    launch_details_text.innerHTML = details
}


function setLaunchPercentage(percent){
    launch_progress.setAttribute('max', 100)
    launch_progress.setAttribute('value', percent)
    launch_progress_label.innerHTML = percent + '%'
}


function setDownloadPercentage(percent){
    remote.getCurrentWindow().setProgressBar(percent/100)
    setLaunchPercentage(percent)
}


function setLaunchEnabled(val){
    document.getElementById('launch_button').disabled = !val
}


document.getElementById('launch_button').addEventListener('click', async e => {
    loggerLanding.info('Launching game..')
    try {
        const server = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())
        const jExe = ConfigManager.getJavaExecutable(ConfigManager.getSelectedServer())
        if(jExe == null){
            await asyncSystemScan(server.effectiveJavaOptions)
        } else {

            setLaunchDetails(Lang.queryJS('landing.launch.pleaseWait'))
            toggleLaunchArea(true)
            setLaunchPercentage(0, 100)

            const details = await validateSelectedJvm(ensureJavaDirIsRoot(jExe), server.effectiveJavaOptions.supported)
            if(details != null){
                loggerLanding.info('Jvm Details', details)
                await dlAsync()

            } else {
                await asyncSystemScan(server.effectiveJavaOptions)
            }
        }
    } catch(err) {
        loggerLanding.error('Unhandled error in during launch process.', err)
        showLaunchFailure(Lang.queryJS('landing.launch.failureTitle'), Lang.queryJS('landing.launch.failureText'))
    }
})


document.getElementById('settingsMediaButton').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings)
}


document.getElementById('avatarOverlay').onclick = async e => {
    await prepareSettings()
    switchView(getCurrentView(), VIEWS.settings, 500, 500, () => {
        settingsNavItemListener(document.getElementById('settingsNavAccount'), false)
    })
}


function updateSelectedAccount(authUser){
    let username = Lang.queryJS('landing.selectedAccount.noAccountSelected')
    if(authUser != null){
        if(authUser.displayName != null){
            username = authUser.displayName
        }
        if(authUser.uuid != null){
            // The avatar is a third party render, so each service in the chain
            // is tried in turn. A CSS background cannot raise an error event, so
            // the image is preloaded here before being applied.
            const avatarContainer = document.getElementById('avatarContainer')
            const urls = skinServiceUrls('body', authUser.uuid, 128)
            const tryNextService = (index) => {
                if(index >= urls.length){
                    return
                }
                const probe = new Image()
                probe.onload = () => {
                    avatarContainer.style.backgroundImage = `url('${urls[index]}')`
                }
                probe.onerror = () => tryNextService(index + 1)
                probe.src = urls[index]
            }
            tryNextService(0)
        }
    }
    user_text.innerHTML = username
}
updateSelectedAccount(ConfigManager.getSelectedAccount())


function updateSelectedServer(serv){
    if(getCurrentView() === VIEWS.settings){
        fullSettingsSave()
    }
    ConfigManager.setSelectedServer(serv != null ? serv.rawServer.id : null)
    ConfigManager.save()
    server_selection_button.innerHTML = '&#8226; ' + (serv != null ? serv.rawServer.name : Lang.queryJS('landing.noSelection'))
    if(getCurrentView() === VIEWS.settings){
        animateSettingsTabRefresh()
    }
    setLaunchEnabled(serv != null)
}

server_selection_button.innerHTML = '&#8226; ' + Lang.queryJS('landing.selectedServer.loading')
server_selection_button.onclick = async e => {
    e.target.blur()
    await toggleServerSelection(true)
}


const refreshMojangStatuses = async function(){
    loggerLanding.info('Refreshing Mojang Statuses..')

    let status = 'grey'
    let tooltipEssentialHTML = ''
    let tooltipNonEssentialHTML = ''

    const response = await MojangRestAPI.status()
    let statuses
    if(response.responseStatus === RestResponseStatus.SUCCESS) {
        statuses = response.data
    } else {
        loggerLanding.warn('Unable to refresh Mojang service status.')
        statuses = MojangRestAPI.getDefaultStatuses()
    }

    greenCount = 0
    greyCount = 0

    for(let i=0; i<statuses.length; i++){
        const service = statuses[i]

        const tooltipHTML = `<div class="mojangStatusContainer">
            <span class="mojangStatusIcon" style="color: ${MojangRestAPI.statusToHex(service.status)};">&#8226;</span>
            <span class="mojangStatusName">${service.name}</span>
        </div>`
        if(service.essential){
            tooltipEssentialHTML += tooltipHTML
        } else {
            tooltipNonEssentialHTML += tooltipHTML
        }

        if(service.status === 'yellow' && status !== 'red'){
            status = 'yellow'
        } else if(service.status === 'red'){
            status = 'red'
        } else {
            if(service.status === 'grey'){
                ++greyCount
            }
            ++greenCount
        }

    }

    if(greenCount === statuses.length){
        if(greyCount === statuses.length){
            status = 'grey'
        } else {
            status = 'green'
        }
    }

    document.getElementById('mojangStatusEssentialContainer').innerHTML = tooltipEssentialHTML
    document.getElementById('mojangStatusNonEssentialContainer').innerHTML = tooltipNonEssentialHTML
    document.getElementById('mojang_status_icon').style.color = MojangRestAPI.statusToHex(status)
}

const refreshServerStatus = async (fade = false) => {
    loggerLanding.info('Refreshing Server Status')
    const serv = (await DistroAPI.getDistribution()).getServerById(ConfigManager.getSelectedServer())

    let pLabel = Lang.queryJS('landing.serverStatus.server')
    let pVal = Lang.queryJS('landing.serverStatus.offline')

    try {

        const servStat = await getServerStatus(47, serv.hostname, serv.port)
        console.log(servStat)
        pLabel = Lang.queryJS('landing.serverStatus.players')
        pVal = servStat.players.online + '/' + servStat.players.max

    } catch (err) {
        loggerLanding.warn('Unable to refresh server status, assuming offline.')
        loggerLanding.debug(err)
    }
    if(fade){
        $('#server_status_wrapper').fadeOut(250, () => {
            document.getElementById('landingPlayerLabel').innerHTML = pLabel
            document.getElementById('player_count').innerHTML = pVal
            $('#server_status_wrapper').fadeIn(500)
        })
    } else {
        document.getElementById('landingPlayerLabel').innerHTML = pLabel
        document.getElementById('player_count').innerHTML = pVal
    }

}

refreshMojangStatuses()


let mojangStatusListener = setInterval(() => refreshMojangStatuses(true), 60*60*1000)

let serverStatusListener = setInterval(() => refreshServerStatus(true), 300000)


function showLaunchFailure(title, desc){
    setOverlayContent(
        title,
        desc,
        Lang.queryJS('landing.launch.okay')
    )
    setOverlayHandler(null)
    toggleOverlay(true)
    toggleLaunchArea(false)
}


async function asyncSystemScan(effectiveJavaOptions, launchAfter = true){

    setLaunchDetails(Lang.queryJS('landing.systemScan.checking'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const jvmDetails = await discoverBestJvmInstallation(
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.supported
    )

    if(jvmDetails == null) {


        setOverlayContent(
            Lang.queryJS('landing.systemScan.noCompatibleJava'),
            Lang.queryJS('landing.systemScan.installJavaMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
            Lang.queryJS('landing.systemScan.installJava'),
            Lang.queryJS('landing.systemScan.installJavaManually')
        )
        setOverlayHandler(() => {
            setLaunchDetails(Lang.queryJS('landing.systemScan.javaDownloadPrepare'))
            toggleOverlay(false)

            try {
                downloadJava(effectiveJavaOptions, launchAfter)
            } catch(err) {
                loggerLanding.error('Unhandled error in Java Download', err)
                showLaunchFailure(Lang.queryJS('landing.systemScan.javaDownloadFailureTitle'), Lang.queryJS('landing.systemScan.javaDownloadFailureText'))
            }
        })
        setDismissHandler(() => {
            $('#overlayContent').fadeOut(250, () => {

                setOverlayContent(
                    Lang.queryJS('landing.systemScan.javaRequired', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredMessage', { 'major': effectiveJavaOptions.suggestedMajor }),
                    Lang.queryJS('landing.systemScan.javaRequiredDismiss'),
                    Lang.queryJS('landing.systemScan.javaRequiredCancel')
                )
                setOverlayHandler(() => {
                    toggleLaunchArea(false)
                    toggleOverlay(false)
                })
                setDismissHandler(() => {
                    toggleOverlay(false, true)

                    asyncSystemScan(effectiveJavaOptions, launchAfter)
                })
                $('#overlayContent').fadeIn(250)
            })
        })
        toggleOverlay(true, true)
    } else {

        const javaExec = javaExecFromRoot(jvmDetails.path)
        ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), javaExec)
        ConfigManager.save()


        settingsJavaExecVal.value = javaExec
        await populateJavaExecDetails(settingsJavaExecVal.value)


        if(launchAfter){
            await dlAsync()
        }
    }

}

async function downloadJava(effectiveJavaOptions, launchAfter = true) {


    const asset = await latestOpenJDK(
        effectiveJavaOptions.suggestedMajor,
        ConfigManager.getDataDirectory(),
        effectiveJavaOptions.distribution)

    if(asset == null) {
        throw new Error(Lang.queryJS('landing.downloadJava.findJdkFailure'))
    }

    let received = 0
    await downloadFile(asset.url, asset.path, ({ transferred }) => {
        received = transferred
        setDownloadPercentage(Math.trunc((transferred/asset.size)*100))
    })
    setDownloadPercentage(100)

    if(received != asset.size) {
        loggerLanding.warn(`Java Download: Expected ${asset.size} bytes but received ${received}`)
        if(!await validateLocalFile(asset.path, asset.algo, asset.hash)) {
            log.error(`Hashes do not match, ${asset.id} may be corrupted.`)

            throw new Error(Lang.queryJS('landing.downloadJava.javaDownloadCorruptedError'))
        }
    }


    remote.getCurrentWindow().setProgressBar(2)


    const eLStr = Lang.queryJS('landing.downloadJava.extractingJava')
    let dotStr = ''
    setLaunchDetails(eLStr)
    const extractListener = setInterval(() => {
        if(dotStr.length >= 3){
            dotStr = ''
        } else {
            dotStr += '.'
        }
        setLaunchDetails(eLStr + dotStr)
    }, 750)

    const newJavaExec = await extractJdk(asset.path)


    remote.getCurrentWindow().setProgressBar(-1)


    ConfigManager.setJavaExecutable(ConfigManager.getSelectedServer(), newJavaExec)
    ConfigManager.save()

    clearInterval(extractListener)
    setLaunchDetails(Lang.queryJS('landing.downloadJava.javaInstalled'))


    asyncSystemScan(effectiveJavaOptions, launchAfter)

}


let proc

let hasRPC = false


const GAME_JOINED_REGEX = /\[.+\]: Sound engine started/
const GAME_LAUNCH_REGEX = /^\[.+\]: (?:MinecraftForge .+ Initialized|ModLauncher .+ starting: .+|Loading Minecraft .+ with Fabric Loader .+)$/
const MIN_LINGER = 5000

async function dlAsync(login = true) {


    const loggerLaunchSuite = LoggerUtil.getLogger('LaunchSuite')

    setLaunchDetails(Lang.queryJS('landing.dlAsync.loadingServerInfo'))

    let distro

    try {
        distro = await DistroAPI.refreshDistributionOrFallback()
        onDistroRefresh(distro)
    } catch(err) {
        loggerLaunchSuite.error('Unable to refresh distribution index.', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.fatalError'), Lang.queryJS('landing.dlAsync.unableToLoadDistributionIndex'))
        return
    }

    const serv = distro.getServerById(ConfigManager.getSelectedServer())

    if(login) {
        if(ConfigManager.getSelectedAccount() == null){
            loggerLanding.error('You must be logged into an account.')
            return
        }
    }

    setLaunchDetails(Lang.queryJS('landing.dlAsync.pleaseWait'))
    toggleLaunchArea(true)
    setLaunchPercentage(0, 100)

    const fullRepairModule = new FullRepair(
        ConfigManager.getCommonDirectory(),
        ConfigManager.getInstanceDirectory(),
        ConfigManager.getLauncherDirectory(),
        ConfigManager.getSelectedServer(),
        DistroAPI.isDevMode()
    )

    fullRepairModule.spawnReceiver()

    fullRepairModule.childProcess.on('error', (err) => {
        loggerLaunchSuite.error('Error during launch', err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), err.message || Lang.queryJS('landing.dlAsync.errorDuringLaunchText'))
    })
    fullRepairModule.childProcess.on('close', (code, _signal) => {
        if(code !== 0){
            loggerLaunchSuite.error(`Full Repair Module exited with code ${code}, assuming error.`)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.seeConsoleForDetails'))
        }
    })

    loggerLaunchSuite.info('Validating files.')
    setLaunchDetails(Lang.queryJS('landing.dlAsync.validatingFileIntegrity'))
    let invalidFileCount = 0
    try {
        invalidFileCount = await fullRepairModule.verifyFiles(percent => {
            setLaunchPercentage(percent)
        })
        setLaunchPercentage(100)
    } catch (err) {

        const detail = (err && (err.displayable || err.message)) || String(err)
        loggerLaunchSuite.error(`Error during file validation: ${detail}`, err)
        showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileVerificationTitle'), detail)
        return
    }


    if(invalidFileCount > 0) {
        loggerLaunchSuite.info('Downloading files.')
        setLaunchDetails(Lang.queryJS('landing.dlAsync.downloadingFiles'))
        setLaunchPercentage(0)
        try {
            await fullRepairModule.download(percent => {
                setDownloadPercentage(percent)
            })
            setDownloadPercentage(100)
        } catch(err) {
            const detail = (err && (err.displayable || err.message)) || String(err)
            loggerLaunchSuite.error(`Error during file download: ${detail}`, err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringFileDownloadTitle'), detail)
            return
        }
    } else {
        loggerLaunchSuite.info('No invalid files, skipping download.')
    }


    remote.getCurrentWindow().setProgressBar(-1)

    fullRepairModule.destroyReceiver()

    setLaunchDetails(Lang.queryJS('landing.dlAsync.preparingToLaunch'))

    const mojangIndexProcessor = new MojangIndexProcessor(
        ConfigManager.getCommonDirectory(),
        serv.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(
        ConfigManager.getCommonDirectory(),
        distro,
        serv.rawServer.id
    )

    const modLoaderData = await distributionIndexProcessor.loadModLoaderVersionJson(serv)
    const versionData = await mojangIndexProcessor.getVersionJson()

    if(login) {
        const authUser = ConfigManager.getSelectedAccount()
        loggerLaunchSuite.info(`Sending selected account (${authUser.displayName}) to ProcessBuilder.`)
        let pb = new ProcessBuilder(serv, versionData, modLoaderData, authUser, remote.app.getVersion())
        setLaunchDetails(Lang.queryJS('landing.dlAsync.launchingGame'))


        const SERVER_JOINED_REGEX = new RegExp(`\\[.+\\]: \\[CHAT\\] ${authUser.displayName} joined the game`)

        const onLoadComplete = () => {
            toggleLaunchArea(false)
            if(hasRPC){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.loading'))
                proc.stdout.on('data', gameStateChange)
            }
            proc.stdout.removeListener('data', tempListener)
            proc.stderr.removeListener('data', gameErrorListener)
        }
        const start = Date.now()


        const tempListener = function(data){
            if(GAME_LAUNCH_REGEX.test(data.trim())){
                const diff = Date.now()-start
                if(diff < MIN_LINGER) {
                    setTimeout(onLoadComplete, MIN_LINGER-diff)
                } else {
                    onLoadComplete()
                }
            }
        }


        const gameStateChange = function(data){
            data = data.trim()
            if(SERVER_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joined'))
            } else if(GAME_JOINED_REGEX.test(data)){
                DiscordWrapper.updateDetails(Lang.queryJS('landing.discord.joining'))
            }
        }

        const gameErrorListener = function(data){
            data = data.trim()
            if(data.indexOf('Could not find or load main class net.minecraft.launchwrapper.Launch') > -1){
                loggerLaunchSuite.error('Game launch failed, LaunchWrapper was not downloaded properly.')
                showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.launchWrapperNotDownloaded'))
            }
        }

        try {


            let packEntry = null
            try {
                packEntry = await syncResourcePackForLaunch(pb, distro)
            } catch (packErr) {
                loggerLaunchSuite.error('Resource pack could not be prepared.', packErr)
                showLaunchFailure('리소스팩 준비 실패', packErr.message || '리소스팩을 준비하지 못했습니다.')
                return
            }
            if(packEntry){
                pb.enableResourcePacks([packEntry])
            }


            try {
                await syncShadersForLaunch(pb, distro)
            } catch (shaderErr) {
                loggerLaunchSuite.error('Shaders could not be prepared.', shaderErr)
                showLaunchFailure('셰이더 준비 실패', shaderErr.message || '셰이더를 준비하지 못했습니다.')
                return
            }


            try {
                await syncRemoteMods(pb, distro)
            } catch (modErr) {
                loggerLaunchSuite.error('Mods could not be prepared.', modErr)
                showLaunchFailure('모드 준비 실패', modErr.message || '모드를 준비하지 못했습니다.')
                return
            }


            proc = pb.build()


            proc.stdout.on('data', tempListener)
            proc.stderr.on('data', gameErrorListener)

            setLaunchDetails(Lang.queryJS('landing.dlAsync.doneEnjoyServer'))


            if(distro.rawDistribution.discord != null && serv.rawServer.discord != null){
                DiscordWrapper.initRPC(distro.rawDistribution.discord, serv.rawServer.discord)
                hasRPC = true
                proc.on('close', (code, signal) => {
                    loggerLaunchSuite.info('Shutting down Discord Rich Presence..')
                    DiscordWrapper.shutdownRPC()
                    hasRPC = false
                    proc = null
                })
            }

        } catch(err) {

            loggerLaunchSuite.error('Error during launch', err)
            showLaunchFailure(Lang.queryJS('landing.dlAsync.errorDuringLaunchTitle'), Lang.queryJS('landing.dlAsync.checkConsoleForDetails'))

        }
    }

}


const newsContent                   = document.getElementById('newsContent')
const newsArticleTitle              = document.getElementById('newsArticleTitle')
const newsArticleDate               = document.getElementById('newsArticleDate')
const newsArticleAuthor             = document.getElementById('newsArticleAuthor')
const newsArticleComments           = document.getElementById('newsArticleComments')
const newsNavigationStatus          = document.getElementById('newsNavigationStatus')
const newsArticleContentScrollable  = document.getElementById('newsArticleContentScrollable')
const nELoadSpan                    = document.getElementById('nELoadSpan')


let newsActive = false
let newsGlideCount = 0


function slide_(up){
    const lCUpper = document.querySelector('#landingContainer > #upper')
    const lCLLeft = document.querySelector('#landingContainer > #lower > #left')
    const lCLCenter = document.querySelector('#landingContainer > #lower > #center')
    const lCLRight = document.querySelector('#landingContainer > #lower > #right')
    const newsBtn = document.querySelector('#landingContainer > #lower > #center #content')
    const landingContainer = document.getElementById('landingContainer')
    const newsContainer = document.querySelector('#landingContainer > #newsContainer')

    newsGlideCount++

    if(up){
        lCUpper.style.top = '-200vh'
        lCLLeft.style.top = '-200vh'
        lCLCenter.style.top = '-200vh'
        lCLRight.style.top = '-200vh'
        newsBtn.style.top = '130vh'
        newsContainer.style.top = '0px'


        landingContainer.style.background = 'rgba(0, 0, 0, 0.50)'
        setTimeout(() => {
            if(newsGlideCount === 1){
                lCLCenter.style.transition = 'none'
                newsBtn.style.transition = 'none'
            }
            newsGlideCount--
        }, 2000)
    } else {
        setTimeout(() => {
            newsGlideCount--
        }, 2000)
        landingContainer.style.background = null
        lCLCenter.style.transition = null
        newsBtn.style.transition = null
        newsContainer.style.top = '100%'
        lCUpper.style.top = '0px'
        lCLLeft.style.top = '0px'
        lCLCenter.style.top = '0px'
        lCLRight.style.top = '0px'
        newsBtn.style.top = '10px'
    }
}


document.getElementById('newsButton').onclick = () => {

    if(newsActive){
        $('#landingContainer *').removeAttr('tabindex')
        $('#newsContainer *').attr('tabindex', '-1')
    } else {
        $('#landingContainer *').attr('tabindex', '-1')
        $('#newsContainer, #newsContainer *, #lower, #lower #center *').removeAttr('tabindex')
        if(newsAlertShown){
            $('#newsButtonAlert').fadeOut(2000)
            newsAlertShown = false
            ConfigManager.setNewsCacheDismissed(true)
            ConfigManager.save()
        }
    }
    slide_(!newsActive)
    newsActive = !newsActive
}


let newsArr = null


let newsLoadingListener = null


function setNewsLoading(val){
    if(val){
        const nLStr = Lang.queryJS('landing.news.checking')
        let dotStr = '..'
        nELoadSpan.innerHTML = nLStr + dotStr
        newsLoadingListener = setInterval(() => {
            if(dotStr.length >= 3){
                dotStr = ''
            } else {
                dotStr += '.'
            }
            nELoadSpan.innerHTML = nLStr + dotStr
        }, 750)
    } else {
        if(newsLoadingListener != null){
            clearInterval(newsLoadingListener)
            newsLoadingListener = null
        }
    }
}


newsErrorRetry.onclick = () => {
    $('#newsErrorFailed').fadeOut(250, () => {
        initNews()
        $('#newsErrorLoading').fadeIn(250)
    })
}

newsArticleContentScrollable.onscroll = (e) => {
    if(e.target.scrollTop > Number.parseFloat($('.newsArticleSpacerTop').css('height'))){
        newsContent.setAttribute('scrolled', '')
    } else {
        newsContent.removeAttribute('scrolled')
    }
}


function reloadNews(){
    return new Promise((resolve, reject) => {
        $('#newsContent').fadeOut(250, () => {
            $('#newsErrorLoading').fadeIn(250)
            initNews().then(() => {
                resolve()
            })
        })
    })
}

let newsAlertShown = false


function showNewsAlert(){
    newsAlertShown = true
    $(newsButtonAlert).fadeIn(250)
}

async function digestMessage(str) {
    const msgUint8 = new TextEncoder().encode(str)
    const hashBuffer = await crypto.subtle.digest('SHA-1', msgUint8)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    return hashHex
}


async function initNews(){

    setNewsLoading(true)

    const news = await loadNews()

    newsArr = news?.articles || null

    if(newsArr == null){
        setNewsLoading(false)

        await $('#newsErrorLoading').fadeOut(250).promise()
        // A missing news source is not a failure, so say "no news" rather than
        // showing the retry button.
        await $(news?.noSource ? '#newsErrorNone' : '#newsErrorFailed').fadeIn(250).promise()

    } else if(newsArr.length === 0) {

        setNewsLoading(false)

        ConfigManager.setNewsCache({
            date: null,
            content: null,
            dismissed: false
        })
        ConfigManager.save()

        await $('#newsErrorLoading').fadeOut(250).promise()
        await $('#newsErrorNone').fadeIn(250).promise()
    } else {

        setNewsLoading(false)

        const lN = newsArr[0]
        const cached = ConfigManager.getNewsCache()
        let newHash = await digestMessage(lN.content)
        let newDate = new Date(lN.date)
        let isNew = false

        if(cached.date != null && cached.content != null){

            if(new Date(cached.date) >= newDate){


                if(cached.content !== newHash){
                    isNew = true
                    showNewsAlert()
                } else {
                    if(!cached.dismissed){
                        isNew = true
                        showNewsAlert()
                    }
                }

            } else {
                isNew = true
                showNewsAlert()
            }

        } else {
            isNew = true
            showNewsAlert()
        }

        if(isNew){
            ConfigManager.setNewsCache({
                date: newDate.getTime(),
                content: newHash,
                dismissed: false
            })
            ConfigManager.save()
        }

        const switchHandler = (forward) => {
            let cArt = parseInt(newsContent.getAttribute('article'))
            let nxtArt = forward ? (cArt >= newsArr.length-1 ? 0 : cArt + 1) : (cArt <= 0 ? newsArr.length-1 : cArt - 1)

            displayArticle(newsArr[nxtArt], nxtArt+1)
        }

        document.getElementById('newsNavigateRight').onclick = () => { switchHandler(true) }
        document.getElementById('newsNavigateLeft').onclick = () => { switchHandler(false) }
        await $('#newsErrorContainer').fadeOut(250).promise()
        displayArticle(newsArr[0], 1)
        await $('#newsContent').fadeIn(250).promise()
    }


}


document.addEventListener('keydown', (e) => {
    if(newsActive){
        if(e.key === 'ArrowRight' || e.key === 'ArrowLeft'){
            document.getElementById(e.key === 'ArrowRight' ? 'newsNavigateRight' : 'newsNavigateLeft').click()
        }


    } else {
        if(getCurrentView() === VIEWS.landing){
            if(e.key === 'ArrowUp'){
                document.getElementById('newsButton').click()
            }
        }
    }
})


function displayArticle(articleObject, index){
    newsArticleTitle.innerHTML = articleObject.title
    newsArticleTitle.href = articleObject.link
    newsArticleAuthor.innerHTML = articleObject.author ? Lang.query('ejs.landing.newsByAuthor', { author: articleObject.author }) : ''
    newsArticleDate.innerHTML = articleObject.date
    newsArticleComments.innerHTML = articleObject.comments
    newsArticleComments.href = articleObject.commentsLink
    newsArticleContentScrollable.innerHTML = '<div id="newsArticleContentWrapper"><div class="newsArticleSpacerTop"></div>' + articleObject.content + '<div class="newsArticleSpacerBot"></div></div>'
    Array.from(newsArticleContentScrollable.getElementsByClassName('bbCodeSpoilerButton')).forEach(v => {
        v.onclick = () => {
            const text = v.parentElement.getElementsByClassName('bbCodeSpoilerText')[0]
            text.style.display = text.style.display === 'block' ? 'none' : 'block'
        }
    })
    newsNavigationStatus.innerHTML = Lang.query('ejs.landing.newsNavigationStatus', {currentPage: index, totalPages: newsArr.length})
    newsContent.setAttribute('article', index-1)

    // 게시판 목록에는 날짜만 있고 시각이 없으므로, 상세 페이지를 한 번 읽어
    // "2026. 10. 3. PM 7:37:44" 처럼 시각까지 채웁니다. (글마다 한 번만)
    enrichArticleMeta(articleObject, index)
}


async function enrichArticleMeta(articleObject, index){

    if(!articleObject.link || articleObject.metaLoaded){
        return
    }
    articleObject.metaLoaded = true

    try {
        const html = await require('electron').ipcRenderer.invoke('fetchNews', articleObject.link)
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const fields = Array.from(doc.querySelectorAll('.detail-meta > *'))
            .map(el => el.textContent.replace(/\s+/g, ' ').trim())
            .filter(text => text.length > 0)

        if(fields.length === 0){
            return
        }

        articleObject.author = escapeNewsHtml(fields[0])
        articleObject.date = escapeNewsHtml(fields[1] || articleObject.date)
        if(fields.length > 2){
            articleObject.comments = escapeNewsHtml(fields.slice(2).join(' · '))
        }

        if(parseInt(newsContent.getAttribute('article'), 10) === index - 1){
            newsArticleAuthor.innerHTML = Lang.query('ejs.landing.newsByAuthor', { author: articleObject.author })
            newsArticleDate.innerHTML = articleObject.date
            newsArticleComments.innerHTML = articleObject.comments
        }
    } catch (err) {
        loggerLanding.debug('Failed to read the post detail page.', err)
    }
}


async function loadNews(){

    const distroData = await DistroAPI.getDistribution()
    const newsFeed = distroData.rawDistribution.rss
    const newsPage = distroData.rawDistribution.news

    if(newsFeed){
        return await loadNewsFromRss(newsFeed)
    }
    if(newsPage){
        return await loadNewsFromHtml(newsPage)
    }

    loggerLanding.debug('No RSS feed or community page provided.')
    return {
        articles: null,
        noSource: true
    }
}


async function loadNewsFromRss(newsFeed){

    const promise = new Promise((resolve, reject) => {

        const newsHost = new URL(newsFeed).origin + '/'
        $.ajax({
            url: newsFeed,
            success: (data) => {
                const items = $(data).find('item')
                const articles = []

                for(let i=0; i<items.length; i++){

                    const el = $(items[i])


                    const date = new Date(el.find('pubDate').text()).toLocaleDateString('en-US', {month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: 'numeric'})


                    let comments = el.find('slash\\:comments').text() || '0'
                    comments = comments + ' Comment' + (comments === '1' ? '' : 's')


                    let content = el.find('content\\:encoded').text()
                    let regex = /src="(?!http:\/\/|https:\/\/)(.+?)"/g
                    let matches
                    while((matches = regex.exec(content))){
                        content = content.replace(`"${matches[1]}"`, `"${newsHost + matches[1]}"`)
                    }

                    let link   = el.find('link').text()
                    let title  = el.find('title').text()
                    let author = el.find('dc\\:creator').text()


                    articles.push(
                        {
                            link,
                            title,
                            date,
                            author,
                            content,
                            comments,
                            commentsLink: link + '#comments'
                        }
                    )
                }
                resolve({
                    articles
                })
            },
            timeout: 2500
        }).catch(err => {
            resolve({
                articles: null
            })
        })
    })

    return await promise
}


async function loadNewsFromHtml(newsPage){

    try {
        // Required inline: another script in this global scope already declares a
        // top-level `ipcRenderer`, and a second `const` would break this whole file.
        const html = await require('electron').ipcRenderer.invoke('fetchNews', newsPage)
        const doc = new DOMParser().parseFromString(html, 'text/html')
        const nodes = doc.querySelectorAll('section.feed .post, a.post')
        const articles = []

        nodes.forEach(node => {
            const title = newsTextOf(node, '.post-title')
            if(!title){
                return
            }

            const linkEl = node.tagName === 'A' ? node : node.querySelector('a')
            const href = linkEl ? linkEl.getAttribute('href') : null
            const link = href ? new URL(href, newsPage).toString() : newsPage

            const category = newsTextOf(node, '.post-category')
            const excerpt = dropRepeatedTitle(newsBlockTextOf(node, '.post-excerpt'), title)

            // 작성자와 날짜는 <br> 로 나뉘어 있습니다.
            // 예: "wsi1212<br>2026. 10. 3. PM 7:37:44"
            const meta = newsLinesOf(node, '.post-meta')
            const author = meta[0] || ''
            const date = meta.slice(1).join(' ') || category

            const stats = Array.from(node.querySelectorAll('.post-stat'))
                .map(el => el.textContent.replace(/\s+/g, ' ').trim())
                .filter(text => text.length > 0)

            articles.push({
                link,
                title: escapeNewsHtml(title),
                date: escapeNewsHtml(date),
                author: escapeNewsHtml(author),
                comments: escapeNewsHtml(stats.join(' · ')),
                commentsLink: link,
                content: excerpt ? `<p class="newsArticleExcerpt">${escapeNewsHtml(excerpt)}</p>` : ''
            })
        })

        return {
            articles
        }
    } catch (err) {
        loggerLanding.warn('Failed to load the community board.', err)
        return {
            articles: null
        }
    }
}


function newsTextOf(parent, selector){
    const el = parent.querySelector(selector)
    return el ? el.textContent.trim().replace(/\s+/g, ' ') : ''
}


function newsLinesOf(parent, selector){
    const el = parent.querySelector(selector)
    if(!el){
        return []
    }
    return newsTextWithBreaks(el)
        .split('\n')
        .map(line => line.replace(/\s+/g, ' ').trim())
        .filter(line => line.length > 0)
}


function newsBlockTextOf(parent, selector){
    const el = parent.querySelector(selector)
    if(!el){
        return ''
    }
    return newsTextWithBreaks(el)
        .split('\n')
        .map(line => line.replace(/\s+$/, ''))
        .join('\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '')
}


function dropRepeatedTitle(text, title){
    if(!text){
        return text
    }
    const lines = text.split('\n')
    if((lines[0] || '').trim() === title.trim()){
        return lines.slice(1).join('\n').replace(/^\n+/, '')
    }
    return text
}


function newsTextWithBreaks(el){
    const clone = el.cloneNode(true)
    clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'))
    return clone.textContent
}


function escapeNewsHtml(value){
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
}


async function syncResourcePackForLaunch(pb, distro){
    const logger = LoggerUtil.getLogger('ResourcePack')
    const config = distro.rawDistribution.resourcePack
    if(!config || !config.manifestUrl){
        return null
    }

    const path = require('path')
    const { ipcRenderer } = require('electron')
    const fileName = path.basename(config.fileName || 'barkan-resourcepack.zip')

    const onProgress = (event, payload) => {
        if(payload && payload.total > 0){
            const percent = Math.floor((payload.received / payload.total) * 100)
            setLaunchDetails(`리소스팩 내려받는 중.. ${percent}%`)
        }
    }
    ipcRenderer.on('resourcePackProgress', onProgress)

    let result
    try {
        setLaunchDetails('리소스팩 확인 중..')
        result = await ipcRenderer.invoke('syncServerResourcePack', {
            directory: pb.gameDir,
            manifestUrl: config.manifestUrl,
            fileName
        })
    } catch (err) {
        throw new Error(`리소스팩을 확인하는 중 오류가 발생했습니다.\n\n${err.message}`)
    } finally {
        ipcRenderer.removeListener('resourcePackProgress', onProgress)
    }

    if(result && result.status === 'installed'){
        logger.info(`Resource pack installed: ${result.version || '(버전 정보 없음)'} (${(result.size / 1048576).toFixed(1)} MB)`)
        return `file/${fileName}`
    }
    if(result && result.status === 'skipped'){
        logger.info(`Resource pack is already up to date: ${result.version || '(버전 정보 없음)'}`)
        return `file/${fileName}`
    }

    // 최신인지 확인하지 못했거나 내려받지 못했습니다.
    // 서버 리소스팩이 필수이므로 게임을 실행하지 않고 오류를 알립니다.
    if(result && result.status === 'kept'){
        throw new Error(
            '리소스팩이 최신 버전인지 확인하지 못했습니다.\n\n' +
            `${result.reason || '원인을 알 수 없습니다.'}\n\n` +
            '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
        )
    }
    throw new Error(
        '리소스팩을 내려받지 못했습니다.\n\n' +
        `${(result && result.reason) || '원인을 알 수 없습니다.'}\n\n` +
        '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
    )
}


async function syncGameFile(directory, subdirectory, file){
    const { ipcRenderer } = require('electron')
    return await ipcRenderer.invoke('syncResourcePack', {
        url: file.url,
        directory,
        subdirectory,
        fileName: file.fileName
    })
}


function writeIrisProperties(gameDir, packFileName){
    const fs = require('fs-extra')
    const path = require('path')
    const irisPath = path.join(gameDir, 'config', 'iris.properties')

    let lines = []
    try {
        if(fs.existsSync(irisPath)){
            lines = fs.readFileSync(irisPath, 'utf8').split(/\r?\n/)
        }
    } catch (err) {
        loggerLanding.warn('iris.properties 를 읽지 못했습니다.', err)
        return
    }

    const set = (key, value) => {
        const index = lines.findIndex(line => line.startsWith(`${key}=`))
        const entry = `${key}=${value}`
        if(index >= 0){
            lines[index] = entry
        } else {
            lines.push(entry)
        }
    }

    set('enableShaders', packFileName ? 'true' : 'false')
    if(packFileName){
        set('shaderPack', packFileName)
    }

    try {
        fs.ensureDirSync(path.dirname(irisPath))
        while(lines.length > 0 && lines[lines.length - 1].trim() === ''){
            lines.pop()
        }
        fs.writeFileSync(irisPath, lines.join('\n') + '\n', 'utf8')
        loggerLanding.info(`셰이더 설정을 저장했습니다: ${packFileName || '사용 안 함'}`)
    } catch (err) {
        loggerLanding.warn('iris.properties 를 쓰지 못했습니다.', err)
    }
}


async function syncRemoteMods(pb, distro){
    const { ipcRenderer } = require('electron')
    setLaunchDetails('모드 준비 중..')

    const result = await ipcRenderer.invoke('syncMods', {
        directory: pb.gameDir,
        disabledUrls: ConfigManager.getDisabledMods(),

        serverAddress: (distro.rawDistribution.servers[0] || {}).address || null
    })

    if(result == null || result.ok !== true){
        throw new Error(
            '모드 준비에 실패했습니다.\n\n' +
            `${(result && result.reason) || '원인을 알 수 없습니다.'}\n\n` +
            '인터넷 연결을 확인한 뒤 다시 시도해 주세요.'
        )
    }

    const items = result.items || []
    const installed = items.filter(s => s.status === 'installed')
    loggerLanding.info(`모드 준비 완료 (새로 받음 ${installed.length}개, 전체 ${items.length}개)`)
}


async function syncShadersForLaunch(pb, distro){
    const enabled = ConfigManager.getShadersEnabled()
    const quality = ConfigManager.getShaderQuality()
    const mods = distro.rawDistribution.clientMods || []
    const shaders = distro.rawDistribution.shaders || {}
    const chosen = shaders[quality]


    if(!enabled){
        writeIrisProperties(pb.gameDir, null)
        return
    }

    const failures = []

    for(const mod of mods){
        try {
            setLaunchDetails(`셰이더 모드 준비 중.. ${mod.name}`)
            const r = await syncGameFile(pb.gameDir, 'mods', mod)
            if(r && r.status === 'failed'){
                failures.push(`${mod.name}: ${r.reason || '내려받기 실패'}`)
            }
        } catch (err) {
            failures.push(`${mod.name}: ${err.message}`)
        }
    }

    if(chosen){
        try {
            setLaunchDetails(`셰이더팩 준비 중.. ${chosen.name}`)
            const r = await syncGameFile(pb.gameDir, 'shaderpacks', chosen)
            if(r && r.status === 'failed'){
                failures.push(`${chosen.name}: ${r.reason || '내려받기 실패'}`)
            }
        } catch (err) {
            failures.push(`${chosen.name}: ${err.message}`)
        }
    } else {
        failures.push(`${quality} 등급 셰이더팩 주소가 배포 인덱스에 없습니다.`)
    }

    if(failures.length > 0){
        throw new Error(
            '셰이더 준비에 실패했습니다.\n\n' +
            failures.join('\n') + '\n\n' +
            '인터넷 연결을 확인하거나, 홈 화면에서 셰이더팩을 끄고 다시 시도해 주세요.'
        )
    }

    writeIrisProperties(pb.gameDir, chosen ? chosen.fileName : null)
}


function setupShaderControls(){
    const toggle = document.getElementById('shaderToggle')
    const qualityBox = document.getElementById('shaderQuality')
    if(toggle == null || qualityBox == null){
        return
    }

    const render = () => {
        const enabled = ConfigManager.getShadersEnabled()
        const quality = ConfigManager.getShaderQuality()

        toggle.setAttribute('aria-pressed', enabled ? 'true' : 'false')
        qualityBox.style.display = enabled ? 'flex' : 'none'

        Array.from(qualityBox.getElementsByClassName('shaderQualityButton')).forEach(button => {
            button.classList.toggle('selected', button.dataset.quality === quality)
        })
    }

    toggle.addEventListener('click', () => {
        ConfigManager.setShadersEnabled(!ConfigManager.getShadersEnabled())
        ConfigManager.save()
        render()
    })

    Array.from(qualityBox.getElementsByClassName('shaderQualityButton')).forEach(button => {
        button.addEventListener('click', () => {
            ConfigManager.setShaderQuality(button.dataset.quality)
            ConfigManager.save()
            render()
        })
    })

    render()
}

setupShaderControls()


function restorePendingSettingsTab(){
    const pending = ConfigManager.getPendingSettingsTab()
    if(pending == null){
        return
    }

    ConfigManager.setPendingSettingsTab(null)
    ConfigManager.save()


    let attempts = 0
    const tryRestore = () => {
        const navItem = document.getElementById(pending)
        if(navItem != null && getCurrentView() === VIEWS.landing){
            switchView(VIEWS.landing, VIEWS.settings, 0, 0, () => {
                settingsNavItemListener(navItem, false)
            })
            return
        }
        if(++attempts < 60){
            setTimeout(tryRestore, 500)
        } else {
            loggerLanding.warn('설정 탭으로 돌아가지 못했습니다. 랜딩 화면에 머무릅니다.')
        }
    }
    setTimeout(tryRestore, 500)
}

restorePendingSettingsTab()


const INFO_HOME_URL = 'https://barkan.kr/api/home'
const INFO_RANKING_URL = 'https://barkan.kr/api/ranking'
const INFO_MARKET_URL = 'https://barkan.kr/assets/market-data.js'
// 랭킹 응답이 2MB 라서 한 번 받으면 5분간 재사용합니다.
const INFO_RANKING_CACHE_MS = 5 * 60 * 1000


const INFO_RANK_ROWS = 8

const infoRankingCache = { data: null, at: 0 }
let infoRankCategory = 'level'


async function fetchInfoJson(url){
    const text = await require('electron').ipcRenderer.invoke('fetchNews', url)
    return JSON.parse(text)
}


function infoText(key){
    return Lang.query(`ejs.landing.${key}`)
}


function infoValue(value){
    return typeof value === 'number' ? value.toLocaleString() : String(value == null ? '' : value)
}


function renderInfoList(listId, statsId, rows, statText){
    const list = document.getElementById(listId)
    const stats = document.getElementById(statsId)
    if(list == null || stats == null){
        return
    }

    list.innerHTML = ''
    rows.forEach(row => {
        const li = document.createElement('li')

        if(row[2] != null){
            const rank = document.createElement('span')
            rank.className = 'r'
            rank.textContent = row[2]
            li.appendChild(rank)
        }

        const left = document.createElement('span')
        left.style.flex = '1'
        left.textContent = row[0]

        const right = document.createElement('span')
        right.className = 'v'
        right.textContent = row[1]

        li.appendChild(left)
        li.appendChild(right)
        list.appendChild(li)
    })

    stats.textContent = statText || ''
}


async function loadInfoMarket(){
    try {
        const text = await require('electron').ipcRenderer.invoke('fetchNews', INFO_MARKET_URL)
        // 파일은 `window.BARKAN_MARKET_DATA={...}` 형태라 JSON 부분만 잘라 씁니다.
        const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1))
        const items = (json.items || []).slice()
            .sort((a, b) => (b.medianUnitPrice || 0) - (a.medianUnitPrice || 0))
            .slice(0, 8)

        renderInfoList('infoListMarket', 'infoStatsMarket',
            items.map(i => [i.name, infoValue(Number(i.medianUnitPrice || 0))]),
            `${json.transactionCount != null ? json.transactionCount : '-'} 건 · ${json.windowDays || 30}일`)
    } catch (err) {
        loggerLanding.warn('시세를 불러오지 못했습니다.', err)
        renderInfoList('infoListMarket', 'infoStatsMarket', [], infoText('infoFailed'))
    }
}


function renderInfoRanking(){
    const data = infoRankingCache.data
    if(data == null){
        return
    }

    const category = (data.categories || {})[infoRankCategory]
    const rows = []
    if(category != null && Array.isArray(category.rows)){
        category.rows.slice(0, INFO_RANK_ROWS).forEach((row, index) => {
            const name = row.name || row.player || row.display || row.uuid || '-'
            const value = row[category.field] != null ? row[category.field] : (row.value != null ? row.value : '')
            rows.push([name, infoValue(value), String(index + 1)])
        })
    }

    renderInfoList('infoListRanking', 'infoStatsRanking', rows, data.updatedAt ? String(data.updatedAt) : '')
}


async function loadInfoRanking(){
    if(infoRankingCache.data == null || (Date.now() - infoRankingCache.at) > INFO_RANKING_CACHE_MS){
        try {
            infoRankingCache.data = await fetchInfoJson(INFO_RANKING_URL)
            infoRankingCache.at = Date.now()
        } catch (err) {
            loggerLanding.warn('랭킹을 불러오지 못했습니다.', err)
            renderInfoList('infoListRanking', 'infoStatsRanking', [], infoText('infoFailed'))
            return
        }
    }

    // 분야 버튼 이름은 서버가 주는 표기를 그대로 씁니다.
    Array.from(document.getElementsByClassName('infoRankTab')).forEach(tab => {
        const category = (infoRankingCache.data.categories || {})[tab.dataset.rank]
        if(category != null && category.label){
            tab.textContent = category.label
        }
        tab.classList.toggle('selected', tab.dataset.rank === infoRankCategory)
    })

    renderInfoRanking()
}


async function loadInfoRare(){
    try {
        const data = await fetchInfoJson(INFO_HOME_URL)
        const online = data.online ? data.online.count : '-'
        const today = data.todayCatches != null ? data.todayCatches : '-'

        renderInfoList('infoListRare', 'infoStatsRare',
            (data.rareCatches || []).slice(0, 8).map(r => [
                [r.fish, r.region, r.method].filter(Boolean).join(' · '),
                `${r.grade || ''} ${r.size ? r.size : ''}`.trim()
            ]),
            `${infoText('infoOnline')} ${online} · ${infoText('infoToday')} ${today}`)
    } catch (err) {
        loggerLanding.warn('희귀 어종을 불러오지 못했습니다.', err)
        renderInfoList('infoListRare', 'infoStatsRare', [], infoText('infoFailed'))
    }
}


function setupInfoPanel(){


    const media = document.getElementById('mediaContent')
    const sections = document.getElementById('infoSections')
    if(media != null && sections != null && media.parentElement !== sections){
        sections.appendChild(media)
    }

    Array.from(document.getElementsByClassName('infoRefresh')).forEach(button => {
        button.addEventListener('click', () => {
            const kind = button.dataset.info
            if(kind === 'market'){
                loadInfoMarket()
            } else if(kind === 'ranking'){
                infoRankingCache.at = 0
                loadInfoRanking()
            } else {
                loadInfoRare()
            }
        })
    })

    Array.from(document.getElementsByClassName('infoRankTab')).forEach(tab => {
        tab.addEventListener('click', () => {
            infoRankCategory = tab.dataset.rank
            Array.from(document.getElementsByClassName('infoRankTab')).forEach(other => {
                other.classList.toggle('selected', other === tab)
            })
            renderInfoRanking()
        })
    })

    // 소식 창이 열리면 정보 패널을 감춥니다. 겹치면 소식이 읽기 어렵습니다.
    //
    // display 나 크기로는 알 수 없습니다.
    //  - #newsContainer 는 평소에도 display:none 이 아니고, 감춰져 있어도 980x530 을 차지합니다.
    //  - #newsContent 도 평소 높이가 453 이라 크기로 구분되지 않습니다.
    // 소식 상태의 정답은 이 파일의 newsActive 이고, #newsButton 의 onclick 이
    // 그것을 뒤집습니다. 그래서 그 클릭에 붙여서 따라갑니다.
    const newsButton = document.getElementById('newsButton')
    const panel = document.getElementById('infoPanel')
    if(newsButton != null && panel != null){
        const sync = () => {
            panel.classList.toggle('hidden', newsActive === true)
        }
        newsButton.addEventListener('click', () => {

            setTimeout(sync, 0)
        })
        sync()
    }
}

setupInfoPanel()


loadInfoMarket()
loadInfoRanking()
loadInfoRare()
