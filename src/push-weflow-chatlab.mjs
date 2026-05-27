#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { constants as fsConstants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PROJECT_ROOT = path.resolve(__dirname, '..')

const DEFAULT_BASE_URL = 'http://127.0.0.1:5031/api/v1'
const DEFAULT_LOOKBACK_SECONDS = 3600
const DEFAULT_OVERLAP_SECONDS = 120
const DEFAULT_MESSAGE_LIMIT = 5000
const DEFAULT_SESSION_LIMIT = 10000
const DEFAULT_UPLOAD_MODE = 'direct'

export function sanitizePathSegment(input) {
  const safe = String(input || '')
    .normalize('NFKD')
    .replace(/[^\x00-\x7F]/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
  return safe || 'unknown'
}

export function buildSyncWindow({
  now,
  lastSyncAt,
  lookbackSeconds = DEFAULT_LOOKBACK_SECONDS,
  overlapSeconds = DEFAULT_OVERLAP_SECONDS
}) {
  const end = Math.floor(Number(now))
  if (!Number.isFinite(end) || end <= 0) {
    throw new Error(`Invalid sync end timestamp: ${now}`)
  }

  const previous = Number(lastSyncAt)
  if (!Number.isFinite(previous) || previous <= 0) {
    const nominalSince = Math.max(0, end - Math.max(1, Number(lookbackSeconds) || DEFAULT_LOOKBACK_SECONDS))
    return { nominalSince, effectiveSince: nominalSince, end }
  }

  const nominalSince = Math.floor(previous)
  const effectiveSince = Math.max(0, nominalSince - Math.max(0, Number(overlapSeconds) || 0))
  return { nominalSince, effectiveSince, end }
}

export function mergeChatLabPages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    throw new Error('Cannot merge empty ChatLab pages')
  }

  const first = pages[0]
  const memberMap = new Map()
  const messageMap = new Map()

  for (const page of pages) {
    for (const member of page.members || []) {
      const key = String(member.platformId || member.accountName || JSON.stringify(member))
      if (!memberMap.has(key)) memberMap.set(key, member)
    }

    for (const message of page.messages || []) {
      const key = message.platformMessageId
        ? `id:${message.platformMessageId}`
        : `fallback:${message.timestamp || ''}:${message.sender || ''}:${message.content || ''}`
      if (!messageMap.has(key)) messageMap.set(key, message)
    }
  }

  const messages = Array.from(messageMap.values())
    .sort((left, right) => Number(left.timestamp || 0) - Number(right.timestamp || 0))

  return {
    chatlab: first.chatlab,
    meta: first.meta,
    members: Array.from(memberMap.values()),
    messages,
    sync: {
      hasMore: false,
      pageCount: pages.length,
      messageCount: messages.length,
      watermark: pages.at(-1)?.sync?.watermark
    }
  }
}

export function buildRemoteTransferPaths({ remoteBase, relativeDir, filename }) {
  const base = String(remoteBase || '').replace(/\/+$/g, '')
  const rel = String(relativeDir || '').replace(/^\/+|\/+$/g, '')
  const name = sanitizePathSegment(filename)
  const suffix = rel ? `${rel}/${name}` : name
  return {
    staging: `${base}/staging/${suffix}`,
    inbox: `${base}/inbox/${suffix}`
  }
}

export function shouldAcceptMoveFailure({ destinationExists }) {
  return destinationExists === true
}

export function buildRetryDelays({ attempts, intervalMs }) {
  const count = Math.max(0, Math.floor(Number(attempts) || 0))
  const delay = Math.max(0, Math.floor(Number(intervalMs) || 0))
  return Array.from({ length: count }, () => delay)
}

export function resolveUploadMode(value) {
  return String(value || '').trim().toLowerCase() === 'staging' ? 'staging' : DEFAULT_UPLOAD_MODE
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    upload: true,
    envFile: path.join(PROJECT_ROOT, '.env'),
    since: null,
    end: null,
    session: []
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--no-upload') args.upload = false
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--env') args.envFile = argv[++i]
    else if (arg.startsWith('--env=')) args.envFile = arg.slice('--env='.length)
    else if (arg === '--since') args.since = Number(argv[++i])
    else if (arg.startsWith('--since=')) args.since = Number(arg.slice('--since='.length))
    else if (arg === '--end') args.end = Number(argv[++i])
    else if (arg.startsWith('--end=')) args.end = Number(arg.slice('--end='.length))
    else if (arg === '--session') args.session.push(argv[++i])
    else if (arg.startsWith('--session=')) args.session.push(arg.slice('--session='.length))
    else throw new Error(`Unknown argument: ${arg}`)
  }

  return args
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

async function readJson(filePath, fallback) {
  if (!await pathExists(filePath)) return fallback
  const raw = await fs.readFile(filePath, 'utf8')
  return JSON.parse(raw)
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.tmp-${process.pid}`
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await fs.rename(tmp, filePath)
}

async function loadEnvFile(filePath) {
  if (!filePath || !await pathExists(filePath)) return {}
  const raw = await fs.readFile(filePath, 'utf8')
  const result = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[key] = value
  }
  return result
}

function readNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

async function buildConfig(args) {
  const fileEnv = await loadEnvFile(args.envFile)
  const env = { ...fileEnv, ...process.env }
  const dataDir = path.resolve(env.WEFLOW_SYNC_DIR || path.join(PROJECT_ROOT, 'data'))

  return {
    baseUrl: String(env.WEFLOW_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/g, ''),
    token: env.WEFLOW_TOKEN || '',
    dataDir,
    statePath: path.resolve(env.WEFLOW_SYNC_STATE || path.join(dataDir, 'state.json')),
    remoteBase: env.WEFLOW_SYNC_REMOTE || '',
    rcloneBin: env.WEFLOW_SYNC_RCLONE_BIN || 'rclone',
    uploadMode: resolveUploadMode(env.WEFLOW_SYNC_UPLOAD_MODE),
    sessionLimit: readNumber(env.WEFLOW_SYNC_SESSION_LIMIT, DEFAULT_SESSION_LIMIT),
    messageLimit: readNumber(env.WEFLOW_SYNC_MESSAGE_LIMIT, DEFAULT_MESSAGE_LIMIT),
    lookbackSeconds: readNumber(env.WEFLOW_SYNC_LOOKBACK_SECONDS, DEFAULT_LOOKBACK_SECONDS),
    overlapSeconds: readNumber(env.WEFLOW_SYNC_OVERLAP_SECONDS, DEFAULT_OVERLAP_SECONDS),
    includeSessions: new Set([
      ...String(env.WEFLOW_SYNC_INCLUDE_SESSIONS || '').split(',').map(item => item.trim()).filter(Boolean),
      ...args.session.map(item => String(item || '').trim()).filter(Boolean)
    ])
  }
}

function printHelp() {
  console.log(`Usage: npm run push -- [options]

Options:
  --dry-run          Fetch and write local files, but do not upload or update state
  --no-upload        Fetch and write local files only
  --since <seconds>  Override since timestamp
  --end <seconds>    Override end timestamp
  --session <id>     Only sync one session; repeatable
  --env <path>       Env file path, defaults to .env

Required env:
  WEFLOW_TOKEN       Token from WeFlow API settings

Common env:
  WEFLOW_SYNC_REMOTE quark-alist:/quark/WeFlow-Hermes
`)
}

async function fetchJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`GET ${url} failed: HTTP ${response.status} ${text.slice(0, 200)}`)
  }
  return response.json()
}

async function fetchSessions(config) {
  const url = new URL(`${config.baseUrl}/sessions`)
  url.searchParams.set('format', 'chatlab')
  url.searchParams.set('limit', String(config.sessionLimit))
  const payload = await fetchJson(url, config.token)
  return Array.isArray(payload.sessions) ? payload.sessions : []
}

async function fetchChatLabPages(config, sessionId, syncWindow) {
  const pages = []
  let offset = 0

  for (let pageIndex = 0; pageIndex < 1000; pageIndex++) {
    const url = new URL(`${config.baseUrl}/sessions/${encodeURIComponent(sessionId)}/messages`)
    url.searchParams.set('since', String(syncWindow.effectiveSince))
    url.searchParams.set('end', String(syncWindow.end))
    url.searchParams.set('limit', String(config.messageLimit))
    url.searchParams.set('offset', String(offset))

    const page = await fetchJson(url, config.token)
    pages.push(page)

    if (!page.sync?.hasMore) break
    const nextOffset = Number(page.sync.nextOffset)
    if (!Number.isFinite(nextOffset) || nextOffset === offset) {
      offset += Array.isArray(page.messages) ? page.messages.length : config.messageLimit
    } else {
      offset = nextOffset
    }
  }

  return mergeChatLabPages(pages)
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

function formatLocalTimestamp(ts, { seconds = true } = {}) {
  const date = new Date(Number(ts) * 1000)
  const base = [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join('-')
  const time = [pad2(date.getHours()), pad2(date.getMinutes())]
  if (seconds) time.push(pad2(date.getSeconds()))
  return `${base}T${time.join('-')}`
}

function relativeDirForWindow(syncWindow) {
  const date = new Date(syncWindow.end * 1000)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}/${pad2(date.getHours())}`
}

function buildOutputName(session, syncWindow) {
  const id = sanitizePathSegment(session.id || session.name)
  return `${formatLocalTimestamp(syncWindow.nominalSince)}_${formatLocalTimestamp(syncWindow.end)}_${id}.chatlab.json`
}

function dirnameRemote(remotePath) {
  const index = remotePath.lastIndexOf('/')
  if (index <= 0) return remotePath
  return remotePath.slice(0, index)
}

function runCommand(command, args, { dryRun = false } = {}) {
  const printable = [command, ...args].join(' ')
  if (dryRun) {
    console.log(`[dry-run] ${printable}`)
    return Promise.resolve()
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${printable} exited with ${code}`))
    })
  })
}

function runCommandSilent(command, args, { dryRun = false } = {}) {
  const printable = [command, ...args].join(' ')
  if (dryRun) {
    console.log(`[dry-run] ${printable}`)
    return Promise.resolve({ success: true })
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => {
      resolve({ success: code === 0, code })
    })
  })
}

async function remotePathExists(config, remotePath, dryRun) {
  const result = await runCommandSilent(config.rcloneBin, ['lsf', remotePath], { dryRun })
  return result.success
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitForRemotePath(config, remotePath, dryRun, {
  attempts = 10,
  intervalMs = 1000
} = {}) {
  if (await remotePathExists(config, remotePath, dryRun)) return true
  for (const delay of buildRetryDelays({ attempts, intervalMs })) {
    if (delay > 0) await sleep(delay)
    if (await remotePathExists(config, remotePath, dryRun)) return true
  }
  return false
}

async function uploadViaRclone(config, localPath, relativeDir, filename, dryRun) {
  if (!config.remoteBase) return null
  const paths = buildRemoteTransferPaths({
    remoteBase: config.remoteBase,
    relativeDir,
    filename
  })

  await runCommand(config.rcloneBin, ['mkdir', dirnameRemote(paths.inbox)], { dryRun })
  if (config.uploadMode !== 'staging') {
    await runCommand(config.rcloneBin, ['copyto', localPath, paths.inbox], { dryRun })
    return paths.inbox
  }

  await runCommand(config.rcloneBin, ['mkdir', dirnameRemote(paths.staging)], { dryRun })
  await runCommand(config.rcloneBin, ['copyto', localPath, paths.staging], { dryRun })
  try {
    await runCommand(config.rcloneBin, ['moveto', paths.staging, paths.inbox], { dryRun })
  } catch (error) {
    const destinationExists = await waitForRemotePath(config, paths.inbox, dryRun)
    if (!shouldAcceptMoveFailure({ destinationExists })) {
      throw error
    }
    console.warn(`rclone moveto reported an error, but destination exists: ${paths.inbox}`)
  }
  return paths.inbox
}

async function acquireLock(lockPath) {
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const handle = await fs.open(lockPath, 'wx').catch((error) => {
    if (error?.code === 'EEXIST') {
      throw new Error(`Sync lock exists: ${lockPath}`)
    }
    throw error
  })
  await handle.writeFile(String(process.pid))
  await handle.close()
}

async function releaseLock(lockPath) {
  await fs.rm(lockPath, { force: true })
}

async function main(argv) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return
  }

  const config = await buildConfig(args)
  if (!config.token) {
    throw new Error('Missing WEFLOW_TOKEN. Copy .env.example to .env and fill it.')
  }

  const state = await readJson(config.statePath, {})
  const now = args.end || Math.floor(Date.now() / 1000)
  const syncWindow = buildSyncWindow({
    now,
    lastSyncAt: args.since || state.lastSyncAt || null,
    lookbackSeconds: config.lookbackSeconds,
    overlapSeconds: args.since ? 0 : config.overlapSeconds
  })

  const lockPath = path.join(config.dataDir, 'push.lock')
  await acquireLock(lockPath)
  const uploaded = []

  try {
    const sessions = await fetchSessions(config)
    const candidates = sessions.filter((session) => {
      if (config.includeSessions.size > 0 && !config.includeSessions.has(session.id)) return false
      const lastMessageAt = Number(session.lastMessageAt || 0)
      return lastMessageAt >= syncWindow.effectiveSince && lastMessageAt <= syncWindow.end
    })

    console.log(`Sync window: ${syncWindow.effectiveSince} -> ${syncWindow.end}`)
    console.log(`Candidate sessions: ${candidates.length}/${sessions.length}`)

    for (const session of candidates) {
      const merged = await fetchChatLabPages(config, session.id, syncWindow)
      if (!Array.isArray(merged.messages) || merged.messages.length === 0) {
        console.log(`Skip empty session: ${session.name || session.id}`)
        continue
      }

      merged.weflowSync = {
        generatedAt: Math.floor(Date.now() / 1000),
        window: syncWindow,
        session: {
          id: session.id,
          name: session.name,
          type: session.type,
          lastMessageAt: session.lastMessageAt
        }
      }

      const relativeDir = relativeDirForWindow(syncWindow)
      const filename = buildOutputName(session, syncWindow)
      const localPath = path.join(config.dataDir, 'out', relativeDir, filename)
      await writeJsonAtomic(localPath, merged)

      const remotePath = args.upload
        ? await uploadViaRclone(config, localPath, relativeDir, filename, args.dryRun)
        : null

      uploaded.push({ session: session.id, messageCount: merged.messages.length, localPath, remotePath })
      console.log(`Wrote ${merged.messages.length} messages: ${localPath}`)
    }

    if (!args.dryRun) {
      await writeJsonAtomic(config.statePath, {
        lastSyncAt: syncWindow.end,
        updatedAt: Math.floor(Date.now() / 1000),
        lastRun: {
          window: syncWindow,
          uploaded
        }
      })
    }

    console.log(`Done. Files written: ${uploaded.length}`)
  } finally {
    await releaseLock(lockPath)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
