import { webcrypto } from 'node:crypto'

const QAAB_SALT_HEX =
  '4dd4c2e6b83162090e52b3c7a6733ba4' +
  '1cb2462b829ab58a196b39db57177524' +
  'f49baf7f08e8d68d26a72e37c1a95a2f' +
  '1f05a51892aef2949732b62a38aadd58'

export function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}

export function decodeJsonEscapedFragment(value) {
  let text = String(value || '')
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = JSON.parse(`"${text.replace(/"/g, '\\"')}"`)
      if (decoded === text) break
      text = decoded
    } catch {
      break
    }
  }
  return text.replace(/\\u0026/g, '&').replace(/\\\//g, '/')
}

function parseJsonString(value) {
  const text = String(value || '').trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function walkJsonAndStrings(value, visitor, seen = new Set()) {
  if (value == null) return
  if (typeof value === 'string') {
    const parsed = parseJsonString(value)
    if (parsed !== null) walkJsonAndStrings(parsed, visitor, seen)
    return
  }
  if (typeof value !== 'object' || seen.has(value)) return
  seen.add(value)
  visitor(value)
  if (Array.isArray(value)) {
    for (const item of value) walkJsonAndStrings(item, visitor, seen)
    return
  }
  for (const item of Object.values(value)) {
    walkJsonAndStrings(item, visitor, seen)
  }
}

function findValuesByKey(value, targetKey) {
  const values = []
  walkJsonAndStrings(value, (node) => {
    if (
      node &&
      !Array.isArray(node) &&
      Object.prototype.hasOwnProperty.call(node, targetKey)
    ) {
      values.push(node[targetKey])
    }
  })
  return values
}

export function extractFallbackApis(rawBody) {
  const apis = new Set()
  const add = (value) => {
    const decoded = decodeJsonEscapedFragment(value)
    if (isHttpUrl(decoded)) apis.add(decoded)
  }

  let payload = null
  try {
    payload = JSON.parse(rawBody)
  } catch {
    // Some endpoints wrap JSON in an SSE data line.
  }
  if (payload) {
    for (const value of findValuesByKey(payload, 'fallback_api')) add(value)
  }

  const patterns = [
    /fallback_api\\":\\"(.*?)\\"/g,
    /"fallback_api"\s*:\s*"([^"]+)"/g,
  ]
  for (const pattern of patterns) {
    let match = pattern.exec(rawBody)
    while (match) {
      add(match[1])
      match = pattern.exec(rawBody)
    }
  }
  return [...apis]
}

export function rewriteFallbackApi(fallbackApi) {
  const url = new URL(fallbackApi)
  url.searchParams.set('channel', 'no')
  url.searchParams.set('codec_type', '8')
  url.searchParams.set('logo_type', 'unwatermarked')
  return url.toString()
}

export function getVideoData(payload) {
  const videoInfo =
    payload?.video_info || payload?.data?.video_info || payload
  const data = videoInfo?.data || videoInfo
  return data && typeof data === 'object' ? data : {}
}

export function findVideoToken(data) {
  const videoList = data?.video_list
  const entries =
    videoList &&
    typeof videoList === 'object' &&
    Object.keys(videoList).length
      ? Object.values(videoList)
      : [data]
  let best = null

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const token = entry.main_url || entry.play_url || ''
    if (typeof token !== 'string' || !token.trim()) continue
    const score =
      Number(entry.bitrate || entry.real_bitrate || 0) +
      Number(entry.vwidth || entry.width || 0) *
        Number(entry.vheight || entry.height || 0)
    if (!best || score > best.score) {
      best = { token: token.trim(), score }
    }
  }
  return best?.token || ''
}

export function findKeySeedDeep(value, depth = 0) {
  if (depth > 10 || value == null) return ''
  if (typeof value === 'string') {
    let match = value.match(/(?:^|[?&])key_seed=([^&"'<>\\\s]+)/i)
    if (match) return safeDecodeURIComponent(match[1])
    match = value.match(/["']key_seed["']\s*:\s*["']([^"']+)/i)
    return match ? safeDecodeURIComponent(match[1]) : ''
  }
  if (typeof value !== 'object') return ''
  if (typeof value.key_seed === 'string' && value.key_seed.trim()) {
    return value.key_seed.trim()
  }
  for (const item of Object.values(value)) {
    const hit = findKeySeedDeep(item, depth + 1)
    if (hit) return hit
  }
  return ''
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

export async function decodeMediaToken(token, keySeed = '') {
  if (isHttpUrl(token)) return token
  const plainUrl = tryDecodeBase64Url(token)
  if (plainUrl) return plainUrl
  if (token.startsWith('qAAB') && keySeed) {
    return decodeQaabToken(token, keySeed)
  }
  return ''
}

function base64DecodeLoose(text) {
  const input = String(text || '').trim()
  const variants = [
    input,
    input.replace(/[$@#]/g, (char) => ({ $: '_', '@': '/', '#': '.' })[char]),
    input.replace(/[$@#]/g, (char) => ({ $: '+', '@': '/', '#': '=' })[char]),
  ]
  const seen = new Set()

  for (const candidate of variants) {
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)
    try {
      const pad = (4 - (candidate.length % 4)) % 4
      const normalized = (candidate + '='.repeat(pad))
        .replace(/-/g, '+')
        .replace(/_/g, '/')
      const binary = atob(normalized)
      const bytes = new Uint8Array(binary.length)
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index)
      }
      return bytes
    } catch {
      // Try the next loose Base64 variant.
    }
  }
  return null
}

function asciiUrlFromBytes(bytes) {
  if (!bytes?.length) return ''
  for (const byte of bytes) {
    if (
      byte !== 9 &&
      byte !== 10 &&
      byte !== 13 &&
      (byte < 32 || byte > 126)
    ) {
      return ''
    }
  }
  return new TextDecoder().decode(bytes)
}

function tryDecodeBase64Url(token) {
  const bytes = base64DecodeLoose(token)
  if (!bytes) return ''
  const text = asciiUrlFromBytes(bytes)
  return isHttpUrl(text) ? text : ''
}

async function decodeQaabToken(token, keySeed) {
  const data = base64DecodeLoose(token)
  const seed = base64DecodeLoose(keySeed)
  if (!data || !seed) return ''

  const digest1 = await webcrypto.subtle.digest(
    'SHA-512',
    seed.slice(0, 32),
  )
  const salt = hexToBytes(QAAB_SALT_HEX)
  const digest2Input = concatBytes(new Uint8Array(digest1), salt)
  const digest2 = new Uint8Array(
    await webcrypto.subtle.digest('SHA-512', digest2Input),
  )
  const key = digest2.slice(0, 16)
  const iv = digest2.slice(16, 32)
  const attempts = []

  if (
    data.length >= 4 &&
    data[0] === 0xa8 &&
    data[1] === 0x00 &&
    data[2] === 0x01 &&
    data[3] === 0x00
  ) {
    attempts.push({ payload: data.slice(4), key, iv })
    attempts.push({ payload: data.slice(4), key: iv, iv: key })
    if (data.length > 36) {
      attempts.push({ payload: data.slice(36), key, iv: data.slice(20, 36) })
      attempts.push({ payload: data.slice(36), key, iv })
    }
  } else {
    attempts.push({ payload: data, key, iv })
  }

  for (const attempt of attempts) {
    const url = await decryptAesCbcUrl(
      attempt.payload,
      attempt.key,
      attempt.iv,
    )
    if (url) return url
  }
  return ''
}

async function decryptAesCbcUrl(payload, keyBytes, ivBytes) {
  if (!payload.length || payload.length % 16 !== 0) return ''
  try {
    const key = await webcrypto.subtle.importKey(
      'raw',
      keyBytes,
      'AES-CBC',
      false,
      ['decrypt'],
    )
    const plain = new Uint8Array(
      await webcrypto.subtle.decrypt(
        { name: 'AES-CBC', iv: ivBytes },
        key,
        payload,
      ),
    )
    const direct = asciiUrlFromBytes(plain)
    if (isHttpUrl(direct)) return direct
    const stripped = stripPkcs7(plain)
    const url = asciiUrlFromBytes(stripped)
    return isHttpUrl(url) ? url : ''
  } catch {
    return ''
  }
}

function stripPkcs7(bytes) {
  if (!bytes?.length) return new Uint8Array()
  const pad = bytes[bytes.length - 1]
  if (pad < 1 || pad > 16 || pad > bytes.length) return bytes
  for (let index = bytes.length - pad; index < bytes.length; index += 1) {
    if (bytes[index] !== pad) return bytes
  }
  return bytes.slice(0, bytes.length - pad)
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(
      hex.slice(index * 2, index * 2 + 2),
      16,
    )
  }
  return bytes
}

function concatBytes(first, second) {
  const bytes = new Uint8Array(first.length + second.length)
  bytes.set(first, 0)
  bytes.set(second, first.length)
  return bytes
}

export async function findVideoUrlInFallbackPayload(payload) {
  const data = getVideoData(payload)
  const token = findVideoToken(data)
  if (!token) return ''
  return decodeMediaToken(token, findKeySeedDeep(payload))
}

export function patchActionBarDuration(body) {
  let json
  try {
    json = JSON.parse(body)
  } catch {
    return body
  }
  return patchNestedJsonStrings(json) ? JSON.stringify(json) : body
}

function patchNestedJsonStrings(value, seen = new Set()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    return false
  }
  seen.add(value)
  let changed = false
  if (Array.isArray(value)) {
    for (const item of value) {
      changed = patchNestedJsonStrings(item, seen) || changed
    }
    return changed
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      const patched = patchJsonStringDuration(child)
      if (patched !== child) {
        value[key] = patched
        changed = true
      }
    } else {
      changed = patchNestedJsonStrings(child, seen) || changed
    }
  }
  return changed
}

function patchJsonStringDuration(text) {
  if (!text || (!text.includes('时长') && !text.includes('鏃堕暱'))) {
    return text
  }
  try {
    const json = JSON.parse(text)
    return patchDurationSelector(json) ? JSON.stringify(json) : text
  } catch {
    return text
  }
}

function patchDurationSelector(value, seen = new Set()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) {
    return false
  }
  seen.add(value)
  let changed = false
  if (Array.isArray(value)) {
    for (const item of value) {
      changed = patchDurationSelector(item, seen) || changed
    }
    return changed
  }
  if (
    (value.label === '时长' || value.label === '鏃堕暱') &&
    Array.isArray(value.option_list)
  ) {
    const has15s = value.option_list.some(
      (option) => option?.option_key === '15',
    )
    if (!has15s) {
      const tenSecondIndex = value.option_list.findIndex(
        (option) => option?.option_key === '10',
      )
      const insertIndex =
        tenSecondIndex >= 0 ? tenSecondIndex + 1 : value.option_list.length
      value.option_list.splice(
        insertIndex,
        0,
        createFifteenSecondOption(value.option_list),
      )
      changed = true
    }
  }
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (typeof child === 'string') {
      const patched = patchJsonStringDuration(child)
      if (patched !== child) {
        value[key] = patched
        changed = true
      }
    } else {
      changed = patchDurationSelector(child, seen) || changed
    }
  }
  return changed
}

function createFifteenSecondOption(optionList) {
  const maxId = optionList.reduce((maxValue, option) => {
    const id = Number(option?.id)
    return Number.isFinite(id) ? Math.max(maxValue, id) : maxValue
  }, 0)
  return {
    id: maxId + 1,
    display_text: '15s',
    message_text: '',
    option_key: '15',
  }
}
