const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('downloader', {
  getState: () => ipcRenderer.invoke('downloader:get-state'),
  openDoubao: () => ipcRenderer.invoke('downloader:open-doubao'),
  setMonitoring: (enabled) =>
    ipcRenderer.invoke('downloader:set-monitoring', Boolean(enabled)),
  chooseOutputDir: () => ipcRenderer.invoke('downloader:choose-output'),
  openOutputDir: () => ipcRenderer.invoke('downloader:open-output'),
  openVideo: (id) => ipcRenderer.invoke('downloader:open-video', String(id || '')),
  showVideo: (id) => ipcRenderer.invoke('downloader:show-video', String(id || '')),
  onEvent: (callback) => {
    const listener = (_event, payload) => callback(payload)
    ipcRenderer.on('downloader:event', listener)
    return () => ipcRenderer.removeListener('downloader:event', listener)
  },
})
