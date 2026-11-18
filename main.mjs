import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Notification,
  session,
  shell,
} from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import {
  extractFallbackApis,
  extractUnwatermarkedImages,
  findVideoUrlInFallbackPayload,
  rewriteFallbackApi,
} from './lib/doubao-media.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DOUBAO_URL = 'https://www.doubao.com/chat/'
const DOUBAO_PARTITION = 'persist:doubao-standalone-downloader'
const DEBUGGER_VERSION = '1.3'
const CHAIN_PATTERNS = [
  {
    urlPattern: '*doubao.com/im/chain/single*',
    requestStage: 'Response',
  },
  {
    urlPattern: '*dola.com/im/chain/single*',
    requestStage: 'Response',
  },
  {
    urlPattern: '*doubao.com/creativity/canvas_workspace/doc/get*',
    requestStage: 'Response',
  },
]
const INSPECT_PATH_PATTERNS = [
  '/im/chain/single',
  '/chat/completion',
  '/creativity/canvas_workspace/doc/get',
]

let mainWindow
let doubaoWindow
let captureSession
let outputDir
let monitoring = true
let ignoreUntil = 0
let responseQueue = Promise.resolve()
const seenResponseHashes = new Set()
const downloadedUrls = new Set()
const downloadedImageKeys = new Set()
const downloads = []
const smokeTest = process.argv.includes('--smoke-test')

app.setName('豆包无水印下载器')

function configPath() {
  return join(app.getPath('userData'), 'config.json')
}

function defaultOutputDir() {
  return join(app.getPath('videos'), '豆包无水印作品')
}

async function loadConfig() {
  outputDir = defaultOutputDir()
  try {
    const config = JSON.parse(await readFile(configPath(), 'utf8'))
    if (typeof config.outputDir === 'string' && config.outputDir.trim()) {
      outputDir = config.outputDir.trim()
    }
    if (typeof config.monitoring === 'boolean') {
      monitoring = config.monitoring
    }
  } catch {
    // First launch.
  }
  await mkdir(outputDir, { recursive: true })
}

async function saveConfig() {
  await writeFile(
    configPath(),
    JSON.stringify({ outputDir, monitoring }, null, 2),
    'utf8',
  )
}

function state() {
  return {
    outputDir,
    monitoring,
    doubaoOpen: Boolean(doubaoWindow && !doubaoWindow.isDestroyed()),
    downloads: downloads.slice(0, 30),
  }
}

function broadcast(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('downloader:event', payload)
}

function timestamp() {
  const date = new Date()
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
    String(date.getSeconds()).padStart(2, '0'),
  ].join('')
}

function uniqueFilename() {
  return `豆包视频_${timestamp()}_${randomUUID().slice(0, 4)}.mp4`
}

function uniqueImageBasename() {
  return `豆包图片_${timestamp()}_${randomUUID().slice(0, 4)}`
}

function isInspectableUrl(url) {
  return INSPECT_PATH_PATTERNS.some((pattern) => url.includes(pattern))
}

async function downloadVideo(url, filename) {
  await mkdir(outputDir, { recursive: true })
  const savePath = join(outputDir, filename)
  const tempPath = `${savePath}.part`
  const partitionSession = session.fromPartition(DOUBAO_PARTITION)
  const response = await partitionSession.fetch(url, {
    credentials: 'include',
    headers: {
      accept: 'video/mp4,video/*;q=0.9,*/*;q=0.8',
      referer: 'https://www.doubao.com/',
    },
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) throw new Error(`视频下载失败：HTTP ${response.status}`)
  const contentType = response.headers.get('content-type') || ''
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error('视频地址已失效，请重新生成')
  }
  if (!response.body) throw new Error('视频响应为空')

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
    const fileStats = await stat(tempPath)
    if (fileStats.size < 1024) throw new Error('下载到的视频文件为空或已损坏')
    await rename(tempPath, savePath)
    return savePath
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

function imageExtension(contentType, url) {
  const type = String(contentType || '').toLowerCase()
  if (type.includes('image/png')) return 'png'
  if (type.includes('image/webp')) return 'webp'
  if (type.includes('image/gif')) return 'gif'
  if (type.includes('image/avif')) return 'avif'
  if (type.includes('image/heic') || type.includes('image/heif')) {
    return 'heic'
  }
  if (type.includes('image/bmp')) return 'bmp'
  if (type.includes('image/jpeg') || type.includes('image/jpg')) return 'jpg'
  if (type && !type.startsWith('image/')) return ''

  try {
    const pathname = new URL(url).pathname.toLowerCase()
    const match = pathname.match(/\.(jpe?g|png|webp|gif|avif|heic|bmp)/)
    if (match) return match[1].replace('jpeg', 'jpg')
  } catch {
    // Fall back to jpg when the URL cannot be parsed.
  }
  return 'jpg'
}

async function downloadImage(url, baseName) {
  await mkdir(outputDir, { recursive: true })
  const partitionSession = session.fromPartition(DOUBAO_PARTITION)
  const response = await partitionSession.fetch(url, {
    credentials: 'include',
    headers: {
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/*;q=0.9,*/*;q=0.8',
      referer: 'https://www.doubao.com/',
    },
    signal: AbortSignal.timeout(120_000),
  })
  if (!response.ok) throw new Error(`图片下载失败：HTTP ${response.status}`)

  const contentType = response.headers.get('content-type') || ''
  if (/text\/html|application\/json/i.test(contentType)) {
    throw new Error('图片地址已失效，请重新生成')
  }
  const extension = imageExtension(contentType, url)
  if (!extension) throw new Error('返回的内容不是图片')
  if (!response.body) throw new Error('图片响应为空')

  const savePath = join(outputDir, `${baseName}.${extension}`)
  const tempPath = `${savePath}.part`
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath))
    const fileStats = await stat(tempPath)
    if (fileStats.size < 64) throw new Error('下载到的图片文件为空或已损坏')
    await rename(tempPath, savePath)
    return savePath
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => {})
    throw error
  }
}

async function fetchUnwatermarkedUrl(fallbackApi) {
  const partitionSession = session.fromPartition(DOUBAO_PARTITION)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await partitionSession.fetch(
        rewriteFallbackApi(fallbackApi),
        {
          method: 'GET',
          credentials: 'include',
          headers: {
            accept: 'application/json,text/plain,*/*',
            referer: 'https://www.doubao.com/',
          },
          signal: AbortSignal.timeout(30_000),
        },
      )
      if (response.ok) {
        const text = await response.text()
        try {
          const videoUrl = findVideoUrlInFallbackPayload(JSON.parse(text))
          if (videoUrl) return videoUrl
        } catch {
          // Retry because the fallback endpoint can lag behind generation.
        }
      }
    } catch {
      // Retry once or twice before reporting a useful error.
    }
    await new Promise((resolve) => setTimeout(resolve, 900 * (attempt + 1)))
  }
  return ''
}

async function processImages(images) {
  let firstSavedPath = ''
  let lastError = ''

  for (const image of images) {
    if (downloadedImageKeys.has(image.key)) continue
    downloadedImageKeys.add(image.key)

    const baseName = uniqueImageBasename()
    const record = {
      id: randomUUID(),
      kind: 'image',
      status: 'downloading',
      filename: `${baseName}.jpg`,
      path: '',
      createdAt: Date.now(),
      message: '正在下载无水印图片…',
    }
    downloads.unshift(record)
    broadcast({ type: 'record', record })

    try {
      record.path = await downloadImage(image.url, baseName)
      record.filename = basename(record.path)
      record.status = 'success'
      record.message = '已保存到本机'
      if (!firstSavedPath) firstSavedPath = record.path
      broadcast({ type: 'record', record })
    } catch (error) {
      downloadedImageKeys.delete(image.key)
      record.status = 'error'
      record.message = error instanceof Error ? error.message : String(error)
      broadcast({ type: 'record', record })
      lastError = record.message
    }
  }

  if (firstSavedPath) notifyDownloaded(firstSavedPath, '图片')
  if (lastError) broadcast({ type: 'error', message: lastError })
}

async function processResponse(body) {
  if (!monitoring || Date.now() < ignoreUntil || typeof body !== 'string' || !body) {
    return
  }
  const hash = createHash('sha1').update(body).digest('hex')
  if (seenResponseHashes.has(hash)) return
  seenResponseHashes.add(hash)

  const images = extractUnwatermarkedImages(body)
  if (images.length) {
    broadcast({
      type: 'detected',
      message:
        images.length > 1
          ? `检测到 ${images.length} 张豆包图片，正在下载无水印原图…`
          : '检测到新的豆包图片，正在下载无水印原图…',
    })
    await processImages(images)
  }

  const fallbackApis = extractFallbackApis(body)
  if (!fallbackApis.length) return
  broadcast({
    type: 'detected',
    message: '检测到新的豆包视频，正在解析无水印地址…',
  })

  let lastError = ''
  for (const fallbackApi of fallbackApis) {
    if (downloadedUrls.has(fallbackApi)) continue
    const videoUrl = await fetchUnwatermarkedUrl(fallbackApi)
    if (!videoUrl) {
      lastError = '未解析到无水印视频地址'
      continue
    }
    if (downloadedUrls.has(videoUrl)) return

    const record = {
      id: randomUUID(),
      kind: 'video',
      status: 'downloading',
      filename: uniqueFilename(),
      path: '',
      createdAt: Date.now(),
      message: '正在下载无水印视频…',
    }
    downloads.unshift(record)
    broadcast({ type: 'record', record })

    try {
      record.path = await downloadVideo(videoUrl, record.filename)
      record.status = 'success'
      record.message = '已保存到本机'
      downloadedUrls.add(videoUrl)
      downloadedUrls.add(fallbackApi)
      broadcast({ type: 'record', record })
      notifyDownloaded(record.path, '视频')
      return
    } catch (error) {
      record.status = 'error'
      record.message = error instanceof Error ? error.message : String(error)
      broadcast({ type: 'record', record })
      lastError = record.message
    }
  }

  if (lastError) {
    broadcast({ type: 'error', message: lastError })
  }
}

function enqueueResponse(body) {
  responseQueue = responseQueue
    .then(() => processResponse(body))
    .catch((error) => {
      broadcast({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    })
  return responseQueue
}

function notifyDownloaded(savePath, label = '作品') {
  broadcast({
    type: 'saved',
    message: `${label}已保存：${savePath}`,
  })
  try {
    const notification = new Notification({
      title: `豆包${label}已无水印保存`,
      body: savePath,
      silent: false,
    })
    notification.on('click', () => shell.showItemInFolder(savePath))
    notification.show()
  } catch {
    // Notifications can be disabled by the operating system.
  }
}

const VIDEO_HOOK = String.raw`
(function () {
  if (window.__standaloneDownloaderHookInstalled) return;
  window.__standaloneDownloaderHookInstalled = true;

  function invoke(payload) {
    if (window.electronAPI && window.electronAPI.invoke) {
      return window.electronAPI.invoke('doubao-video-response', payload)
        .catch(function () {});
    }
    return Promise.resolve();
  }

  function shouldInspect(url) {
    if (typeof url !== 'string') return false;
    return [
      '/im/chain/single',
      '/chat/completion',
      '/creativity/canvas_workspace/doc/get'
    ].some(function (path) {
      return url.indexOf(path) !== -1;
    });
  }

  function reportResponse(url, body) {
    if (!shouldInspect(url) || typeof body !== 'string' || !body) return;
    if (body.length > 8 * 1024 * 1024) return;
    invoke({ url: url, body: body });
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = function () {
      var input = arguments[0];
      var requestUrl = typeof input === 'string'
        ? input
        : input && input.url
          ? input.url
          : '';
      var promise = originalFetch.apply(this, arguments);
      if (!shouldInspect(requestUrl)) return promise;
      return promise.then(function (response) {
        try {
          response.clone().text().then(function (body) {
            reportResponse(response.url || requestUrl, body);
          }).catch(function () {});
        } catch (error) {}
        return response;
      });
    };
  }

  var originalOpen = XMLHttpRequest.prototype.open;
  var originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__standaloneRequestUrl = url;
    return originalOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener('load', function () {
      var type = xhr.responseType || '';
      if (type && type !== 'text' && type !== 'json') return;
      var body = type === 'json'
        ? JSON.stringify(xhr.response)
        : xhr.responseText;
      reportResponse(xhr.responseURL || xhr.__standaloneRequestUrl, body);
    });
    return originalSend.apply(this, arguments);
  };
})();
`

async function injectHook(window) {
  if (window.isDestroyed()) return
  await window.webContents.executeJavaScript(VIDEO_HOOK).catch((error) => {
    console.warn('[DoubaoDownloader] hook injection failed:', error.message)
  })
}

async function detachCapture() {
  const current = captureSession
  captureSession = null
  if (!current || current.window.isDestroyed()) return
  current.debugger.removeListener('message', current.onMessage)
  current.debugger.removeListener('detach', current.onDetach)
  if (current.debugger.isAttached()) {
    await current.debugger.detach().catch(() => {})
  }
}

async function attachCapture(window) {
  if (captureSession?.window === window) return true
  await detachCapture()
  const debuggerApi = window.webContents.debugger
  const onMessage = (_event, method, params) => {
    if (method === 'Fetch.requestPaused') {
      void handlePausedResponse(window, params)
    }
  }
  const onDetach = () => {
    if (captureSession?.window === window) captureSession = null
  }
  debuggerApi.on('message', onMessage)
  debuggerApi.on('detach', onDetach)
  try {
    await debuggerApi.attach(DEBUGGER_VERSION)
    captureSession = { window, debugger: debuggerApi, onMessage, onDetach }
    await debuggerApi.sendCommand('Fetch.enable', {
      patterns: CHAIN_PATTERNS,
    })
    return true
  } catch (error) {
    debuggerApi.removeListener('message', onMessage)
    debuggerApi.removeListener('detach', onDetach)
    if (captureSession?.window === window) captureSession = null
    console.warn(
      '[DoubaoDownloader] native capture unavailable, using page hook:',
      error instanceof Error ? error.message : String(error),
    )
    return false
  }
}

async function handlePausedResponse(window, params) {
  const requestId = params?.requestId
  if (!requestId) return
  try {
    const response = await window.webContents.debugger.sendCommand(
      'Fetch.getResponseBody',
      { requestId },
    )
    const body = response.base64Encoded
      ? Buffer.from(response.body, 'base64').toString('utf8')
      : response.body
    await window.webContents.debugger.sendCommand('Fetch.continueRequest', {
      requestId,
    })
    void enqueueResponse(body)
  } catch {
    await window.webContents.debugger
      .sendCommand('Fetch.continueRequest', { requestId })
      .catch(() => {})
  }
}

async function openDoubaoWindow() {
  if (doubaoWindow && !doubaoWindow.isDestroyed()) {
    doubaoWindow.show()
    doubaoWindow.focus()
    return { success: true }
  }

  doubaoWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 960,
    minHeight: 680,
    show: true,
    title: '豆包 · 生成图片或视频后自动无水印下载',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload-doubao.cjs'),
      partition: DOUBAO_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const window = doubaoWindow
  window.webContents.setWindowOpenHandler(() => ({ action: 'allow' }))
  window.on('closed', () => {
    if (doubaoWindow === window) doubaoWindow = null
    if (captureSession?.window === window) void detachCapture()
    broadcast({ type: 'state', state: state() })
  })
  window.webContents.on('did-finish-load', () => {
    ignoreUntil = Date.now() + 3_500
    void injectHook(window)
    broadcast({ type: 'state', state: state() })
  })
  window.webContents.on('did-navigate-in-page', () => {
    void injectHook(window)
  })
  await attachCapture(window)
  await window.loadURL(DOUBAO_URL)
  broadcast({ type: 'state', state: state() })
  return { success: true }
}

async function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1040,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    show: false,
    title: '豆包无水印下载器',
    backgroundColor: '#ffffff',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload-main.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  await mainWindow.loadFile(join(__dirname, 'renderer', 'index.html'))
  mainWindow.once('ready-to-show', () => {
    if (!smokeTest) mainWindow.show()
  })
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function registerIpc() {
  ipcMain.handle('downloader:get-state', () => state())
  ipcMain.handle('downloader:open-doubao', () => openDoubaoWindow())
  ipcMain.handle('downloader:set-monitoring', async (_event, enabled) => {
    monitoring = Boolean(enabled)
    if (monitoring) ignoreUntil = Date.now() + 2_000
    await saveConfig()
    broadcast({ type: 'state', state: state() })
    return { success: true, monitoring }
  })
  ipcMain.handle('downloader:choose-output', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择豆包图片与视频保存目录',
      defaultPath: outputDir,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths[0]) {
      return { success: false, canceled: true }
    }
    outputDir = result.filePaths[0]
    await mkdir(outputDir, { recursive: true })
    await saveConfig()
    const nextState = state()
    broadcast({ type: 'state', state: nextState })
    return { success: true, state: nextState }
  })
  ipcMain.handle('downloader:open-output', async () => {
    await mkdir(outputDir, { recursive: true })
    const error = await shell.openPath(outputDir)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('downloader:open-video', async (_event, id) => {
    const record = downloads.find((item) => item.id === id)
    if (!record?.path || !existsSync(record.path)) {
      return { success: false, error: '文件不存在' }
    }
    const error = await shell.openPath(record.path)
    return error ? { success: false, error } : { success: true }
  })
  ipcMain.handle('downloader:show-video', (_event, id) => {
    const record = downloads.find((item) => item.id === id)
    if (!record?.path || !existsSync(record.path)) {
      return { success: false, error: '文件不存在' }
    }
    shell.showItemInFolder(record.path)
    return { success: true }
  })
  ipcMain.handle('doubao-video-response', (_event, payload) => {
    const url = String(payload?.url || '')
    const body = String(payload?.body || '')
    if (!isInspectableUrl(url) || !body) {
      return { success: false }
    }
    void enqueueResponse(body)
    return { success: true }
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    await loadConfig()
    registerIpc()
    await createMainWindow()
    if (smokeTest) {
      setTimeout(() => app.quit(), 1_500)
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
}
