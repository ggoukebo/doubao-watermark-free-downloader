const api = window.downloader
const records = new Map()
let toastTimer = 0

const elements = {
  connectionDot: document.querySelector('#connectionDot'),
  connectionText: document.querySelector('#connectionText'),
  openDoubao: document.querySelector('#openDoubao'),
  monitoringToggle: document.querySelector('#monitoringToggle'),
  monitoringBadge: document.querySelector('#monitoringBadge'),
  statusMessage: document.querySelector('#statusMessage'),
  successCount: document.querySelector('#successCount'),
  activeCount: document.querySelector('#activeCount'),
  errorCount: document.querySelector('#errorCount'),
  outputPath: document.querySelector('#outputPath'),
  chooseOutput: document.querySelector('#chooseOutput'),
  openOutput: document.querySelector('#openOutput'),
  downloadList: document.querySelector('#downloadList'),
  toast: document.querySelector('#toast'),
}

function showToast(message, kind = 'info') {
  window.clearTimeout(toastTimer)
  elements.toast.textContent = message
  elements.toast.className = `toast visible ${kind}`
  toastTimer = window.setTimeout(() => {
    elements.toast.className = 'toast'
  }, 3600)
}

function formatTime(timestamp) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(timestamp))
}

function upsertRecord(record) {
  if (!record?.id) return
  records.set(record.id, { ...records.get(record.id), ...record })
  renderRecords()
}

function renderState(nextState) {
  const list = Array.isArray(nextState?.downloads) ? nextState.downloads : []
  records.clear()
  for (const record of list) records.set(record.id, record)

  elements.connectionDot.className = `connection-dot ${
    nextState?.doubaoOpen ? 'online' : ''
  }`
  elements.connectionText.textContent = nextState?.doubaoOpen
    ? '豆包窗口已打开'
    : '豆包尚未打开'
  elements.monitoringToggle.checked = Boolean(nextState?.monitoring)
  elements.monitoringBadge.textContent = nextState?.monitoring
    ? '监听中'
    : '已暂停'
  elements.monitoringBadge.classList.toggle('paused', !nextState?.monitoring)
  elements.outputPath.textContent = nextState?.outputDir || '未设置'
  renderRecords()
}

function renderRecords() {
  const list = [...records.values()].sort(
    (left, right) => Number(right.createdAt || 0) - Number(left.createdAt || 0),
  )
  const success = list.filter((record) => record.status === 'success').length
  const active = list.filter((record) => record.status === 'downloading').length
  const errors = list.filter((record) => record.status === 'error').length
  elements.successCount.textContent = String(success)
  elements.activeCount.textContent = String(active)
  elements.errorCount.textContent = String(errors)

  if (!list.length) {
    elements.downloadList.replaceChildren(createEmptyState())
    return
  }

  const fragment = document.createDocumentFragment()
  for (const record of list) {
    fragment.append(createRecordRow(record))
  }
  elements.downloadList.replaceChildren(fragment)
}

function createEmptyState() {
  const wrapper = document.createElement('div')
  wrapper.className = 'empty-state'
  const index = document.createElement('span')
  index.textContent = '00'
  const title = document.createElement('strong')
  title.textContent = '还没有下载任务'
  const copy = document.createElement('p')
  copy.textContent = '点击“打开豆包”，生成视频后会出现在这里。'
  wrapper.append(index, title, copy)
  return wrapper
}

function createRecordRow(record) {
  const row = document.createElement('article')
  row.className = `download-row status-${record.status || 'downloading'}`

  const indicator = document.createElement('span')
  indicator.className = 'record-indicator'
  indicator.textContent =
    record.status === 'success' ? '✓' : record.status === 'error' ? '!' : '↓'

  const info = document.createElement('div')
  info.className = 'record-info'
  const title = document.createElement('strong')
  title.textContent = record.filename || '豆包视频'
  const detail = document.createElement('small')
  detail.textContent = `${formatTime(record.createdAt)} · ${
    record.message || '处理中'
  }`
  info.append(title, detail)

  const actions = document.createElement('div')
  actions.className = 'record-actions'
  if (record.status === 'success') {
    const play = document.createElement('button')
    play.type = 'button'
    play.textContent = '播放'
    play.addEventListener('click', () => api.openVideo(record.id))
    const locate = document.createElement('button')
    locate.type = 'button'
    locate.textContent = '定位'
    locate.addEventListener('click', () => api.showVideo(record.id))
    actions.append(play, locate)
  } else if (record.status === 'downloading') {
    const progress = document.createElement('span')
    progress.className = 'record-progress'
    actions.append(progress)
  }

  row.append(indicator, info, actions)
  return row
}

elements.openDoubao.addEventListener('click', async () => {
  elements.openDoubao.disabled = true
  try {
    const result = await api.openDoubao()
    if (!result?.success) {
      showToast(result?.error || '豆包窗口打开失败', 'error')
    }
  } finally {
    window.setTimeout(() => {
      elements.openDoubao.disabled = false
    }, 600)
  }
})

elements.monitoringToggle.addEventListener('change', async (event) => {
  const result = await api.setMonitoring(event.target.checked)
  if (!result?.success) {
    event.target.checked = !event.target.checked
    showToast(result?.error || '切换监听状态失败', 'error')
  }
})

elements.chooseOutput.addEventListener('click', async () => {
  const result = await api.chooseOutputDir()
  if (result?.canceled) return
  if (!result?.success) {
    showToast(result?.error || '选择目录失败', 'error')
    return
  }
  renderState(result.state)
  showToast('保存目录已更新', 'success')
})

elements.openOutput.addEventListener('click', async () => {
  const result = await api.openOutputDir()
  if (!result?.success) {
    showToast(result?.error || '打开目录失败', 'error')
  }
})

api.onEvent((event) => {
  if (event.type === 'state' && event.state) {
    renderState(event.state)
    return
  }
  if (event.type === 'record') {
    upsertRecord(event.record)
    if (event.record?.status === 'success') {
      elements.statusMessage.textContent = '无水印视频已保存到本机'
      showToast('豆包视频已无水印保存', 'success')
    }
    return
  }
  if (event.type === 'detected') {
    elements.statusMessage.textContent = event.message
    return
  }
  if (event.type === 'saved') {
    elements.statusMessage.textContent = event.message
    return
  }
  if (event.type === 'error') {
    elements.statusMessage.textContent = event.message || '下载失败'
    showToast(event.message || '下载失败', 'error')
  }
})

api
  .getState()
  .then(renderState)
  .catch((error) => {
    showToast(error instanceof Error ? error.message : String(error), 'error')
  })
