const { autoUpdater } = require('electron-updater')

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

function sendUpdateStatus(status, extra = {}) {
  const { getSettingsWindow } = require('./windows')
  const win = getSettingsWindow()
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-status', { status, ...extra })
  }
}

autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'))
autoUpdater.on('update-available', (info) => sendUpdateStatus('available', { version: info.version }))
autoUpdater.on('update-not-available', () => sendUpdateStatus('up-to-date'))
autoUpdater.on('download-progress', (progress) => sendUpdateStatus('downloading', { percent: Math.round(progress.percent) }))
autoUpdater.on('error', (err) => {
  console.error('Erreur updater:', err.message)
  sendUpdateStatus('error', { message: err?.message || 'Erreur inconnue' })
})
autoUpdater.on('update-downloaded', () => {
  sendUpdateStatus('downloaded')
  autoUpdater.quitAndInstall(true, true)
})

function checkForUpdates() {
  console.log('Vérification des mises à jour...')
  sendUpdateStatus('checking')
  autoUpdater.checkForUpdates().catch(err => {
    console.error('Erreur vérification MAJ:', err.message)
    sendUpdateStatus('error', { message: err?.message || 'Erreur de vérification' })
  })
}

module.exports = { checkForUpdates }
