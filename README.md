# WeFlow Hermes Sync

Standalone scripts for syncing recent WeFlow chat history to a Quark/AList inbox for Hermes processing.

This project is intentionally outside the WeFlow repo. The local machine owns WeFlow access; the industrial PC can later reuse this project and add the processing script.

## Host Workflow

```text
WeFlow HTTP API
-> ChatLab JSON files under data/out/
-> rclone WebDAV upload through AList
-> Quark /WeFlow-Hermes/inbox/
```

Direct upload is the default because Quark/AList server-side move can report false errors or appear with delayed consistency. For these small JSON files, `rclone copyto` to the final inbox path is the more reliable path.

## Setup

1. Enable WeFlow API service and copy the API token.

2. Create Quark folders in AList:

```text
/WeFlow-Hermes/staging
/WeFlow-Hermes/inbox
/WeFlow-Hermes/processed
/WeFlow-Hermes/summaries
```

3. Configure rclone to AList WebDAV:

```bash
rclone config
```

Use:

```text
name: quark-alist
type: webdav
url: http://127.0.0.1:5244/dav/
vendor: other
user: your AList username
pass: your AList password
```

4. Create local env:

```bash
cd /home/yangsan/weflow-hermes-sync
cp .env.example .env
```

Edit `.env` and set `WEFLOW_TOKEN`. If your AList Quark mount is not `/quark`, adjust `WEFLOW_SYNC_REMOTE`.

## Verify

```bash
cd /home/yangsan/weflow-hermes-sync
npm test
npm run push -- --dry-run --no-upload
```

The dry run still reads WeFlow and writes local ChatLab JSON under `data/out/`, but does not upload or update `data/state.json`.

## Run Once

```bash
cd /home/yangsan/weflow-hermes-sync
npm run push
```

## Hourly Cron

```cron
7 * * * * cd /home/yangsan/weflow-hermes-sync && npm run push >> data/logs/push.log 2>&1
```

## Useful Overrides

Sync only one session:

```bash
npm run push -- --session 'xxx@chatroom'
```

Backfill a specific time range with Unix seconds:

```bash
npm run push -- --since 1779865200 --end 1779868800
```
