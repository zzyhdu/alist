import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildRemoteTransferPaths,
  buildRetryDelays,
  buildSyncWindow,
  resolveUploadMode,
  shouldAcceptMoveFailure,
  mergeChatLabPages,
  sanitizePathSegment
} from './push-weflow-chatlab.mjs'

test('buildSyncWindow uses one hour lookback for first run', () => {
  assert.deepEqual(
    buildSyncWindow({
      now: 1_700_003_600,
      lastSyncAt: null,
      lookbackSeconds: 3600,
      overlapSeconds: 120
    }),
    {
      nominalSince: 1_700_000_000,
      effectiveSince: 1_700_000_000,
      end: 1_700_003_600
    }
  )
})

test('buildSyncWindow applies overlap after first run', () => {
  assert.deepEqual(
    buildSyncWindow({
      now: 1_700_003_600,
      lastSyncAt: 1_700_002_000,
      lookbackSeconds: 3600,
      overlapSeconds: 120
    }),
    {
      nominalSince: 1_700_002_000,
      effectiveSince: 1_700_001_880,
      end: 1_700_003_600
    }
  )
})

test('sanitizePathSegment keeps filenames portable', () => {
  assert.equal(sanitizePathSegment('项目群/客户:报价?* wxid_xxx@chatroom'), 'wxid_xxx_chatroom')
  assert.equal(sanitizePathSegment(''), 'unknown')
})

test('mergeChatLabPages merges members and deduplicates messages', () => {
  const first = {
    chatlab: { version: '0.0.2', exportedAt: 1, generator: 'WeFlow' },
    meta: { name: '项目群', platform: 'wechat', type: 'group', groupId: 'room@chatroom' },
    members: [{ platformId: 'wxid_a', accountName: 'A' }],
    messages: [
      { platformMessageId: 'm1', sender: 'wxid_a', timestamp: 10, content: 'hello' }
    ],
    sync: { hasMore: true }
  }
  const second = {
    chatlab: { version: '0.0.2', exportedAt: 2, generator: 'WeFlow' },
    meta: { name: '项目群', platform: 'wechat', type: 'group', groupId: 'room@chatroom' },
    members: [
      { platformId: 'wxid_a', accountName: 'A2' },
      { platformId: 'wxid_b', accountName: 'B' }
    ],
    messages: [
      { platformMessageId: 'm1', sender: 'wxid_a', timestamp: 10, content: 'hello' },
      { platformMessageId: 'm2', sender: 'wxid_b', timestamp: 20, content: 'world' }
    ],
    sync: { hasMore: false }
  }

  const merged = mergeChatLabPages([first, second])

  assert.equal(merged.members.length, 2)
  assert.equal(merged.messages.length, 2)
  assert.equal(merged.sync.pageCount, 2)
})

test('buildRemoteTransferPaths uploads through staging before inbox', () => {
  assert.deepEqual(
    buildRemoteTransferPaths({
      remoteBase: 'quark-alist:/quark/WeFlow-Hermes/',
      relativeDir: '2026-05-27/16',
      filename: 'window_room.chatlab.json'
    }),
    {
      staging: 'quark-alist:/quark/WeFlow-Hermes/staging/2026-05-27/16/window_room.chatlab.json',
      inbox: 'quark-alist:/quark/WeFlow-Hermes/inbox/2026-05-27/16/window_room.chatlab.json'
    }
  )
})

test('shouldAcceptMoveFailure accepts a failed move when destination exists', () => {
  assert.equal(shouldAcceptMoveFailure({ destinationExists: true }), true)
  assert.equal(shouldAcceptMoveFailure({ destinationExists: false }), false)
})

test('buildRetryDelays returns bounded fixed delays', () => {
  assert.deepEqual(buildRetryDelays({ attempts: 3, intervalMs: 250 }), [250, 250, 250])
  assert.deepEqual(buildRetryDelays({ attempts: 0, intervalMs: 250 }), [])
})

test('resolveUploadMode defaults to direct for Quark reliability', () => {
  assert.equal(resolveUploadMode(undefined), 'direct')
  assert.equal(resolveUploadMode('staging'), 'staging')
  assert.equal(resolveUploadMode('other'), 'direct')
})
