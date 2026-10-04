const fs   = require('fs-extra')
const path = require('path')

const { DistributionAPI } = require('helios-core/common')

const ConfigManager = require('./configmanager')

// -----------------------------------------------------------------------------
// Distribution Index
//
// The launcher ships with its distribution index bundled at
// app/assets/distribution.json. helios-core always reads a *local* copy from the
// launcher data directory, so that copy is kept in sync with the bundled file
// on every start. Edit app/assets/distribution.json (or regenerate it with
// `node tools/build-distribution.cjs`) to change servers, mods or Java options.
//
// To move the index onto a web server later - which lets you push modpack
// updates without rebuilding the launcher - set REMOTE_DISTRO_URL below. The
// launcher then downloads the index on startup and caches it locally, falling
// back to the bundled copy whenever the download fails.
// -----------------------------------------------------------------------------

exports.REMOTE_DISTRO_URL = null


const launcherDir = ConfigManager.getLauncherDirectory()

// helios-core reads `distribution_dev.json` when in dev mode and
// `distribution.json` otherwise. Here, "dev mode" simply means "the index is
// local only, never fetched from the network".
const useRemote = exports.REMOTE_DISTRO_URL != null
const localDistroName = useRemote ? 'distribution.json' : 'distribution_dev.json'
const localDistroPath = path.join(launcherDir, localDistroName)
const bundledDistroPath = path.join(__dirname, '..', 'distribution.json')


function syncBundledDistribution() {
    if (!fs.existsSync(bundledDistroPath)) {
        console.error(`[Distribution] Bundled index is missing at ${bundledDistroPath}`)
        return
    }
    try {
        const bundled = fs.readFileSync(bundledDistroPath, 'UTF-8')
        const current = fs.existsSync(localDistroPath) ? fs.readFileSync(localDistroPath, 'UTF-8') : null
        if (current !== bundled) {
            fs.outputFileSync(localDistroPath, bundled, 'UTF-8')
        }
    } catch (err) {

        console.error('[Distribution] Failed to sync the bundled distribution index.', err)
    }
}

syncBundledDistribution()

const api = new DistributionAPI(
    launcherDir,
    null,
    null,
    exports.REMOTE_DISTRO_URL,
    !useRemote
)

exports.DistroAPI = api
