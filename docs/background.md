# Background agent setup

Run `npm run background -- start`, create an invitation with `npm run background -- invite`, and open its link. Sign in to the Codex CLI once with `codex login` before asking the agent to reply. Windows installations outside the standard npm location can set `VDONINJA_CODEX_BIN` to the absolute path to `codex.exe`.

The browser is a client. The background service owns the P2P connection, request queue and saved conversation IDs. Closing the browser or desktop app leaves the service running. Shutting down, sleeping or signing out of the host can stop it; use an always-on computer when continuous availability matters.

## Start when you sign in to Windows

```sh
npm run background -- startup enable
```

This installs a hidden launcher named `VDO.Ninja Connect.vbs` in your Windows Startup folder. To remove the launcher:

```sh
npm run background -- startup disable
```

Use `npm run background -- stop` to stop the current process. Startup settings do not close or change Codex desktop sessions. On other platforms, run `node src/background.mjs` through your preferred service manager.

## Invite another device

Open the `web_url` returned by `npm run background -- invite` on your phone or another computer. It opens the [GitHub Pages client](https://steveseguin.github.io/vdoninja-connect/) with your private invitation. You can also open that client and paste the complete invitation. Keep the full invitation private; the public site address alone grants no agent access.

The `url` address, `http://127.0.0.1:8792`, opens only on the service computer. For a self-hosted client:

1. Run `npm run package:client`.
2. Serve the generated `vdoninja-connect.html` from a trusted HTTPS static host, or open the file in a browser that supports local HTML applications and local storage.
3. Open that client and paste the complete invitation from `npm run background -- invite`.

The client connects through VDO.Ninja; it does not contact the service's loopback HTTP address. GitHub Pages only serves the client application, not the agent or MCP server. Keep the agent computer awake. Use HTTPS for microphone/camera access. A static host can modify the code it serves, so use a host you trust.

Create a new invitation for each device. First use consumes the invitation and replaces its key. The browser stores the replacement locally; losing browser storage requires a new invitation. An interrupted first pairing can be retried for ten minutes using the saved pending credentials.

```sh
npm run background -- invite "Phone" 30
npm run background -- status
npm run background -- revoke PEER_ID
```

Invitations default to 30 days; choose 1–365 days. Revocation cancels that peer's active and queued requests and blocks future access. Revoking does not erase retained conversation history or transferred files.

## Connect an agent without a browser

Decode the `invitation` value in the link's URL fragment into a private JSON file. Do not put the key directly in process arguments or commit the file. The supplied client saves its replacement pairing key back to this file.

```sh
npm run peer -- /absolute/path/peer.json ask "Hello"
npm run peer -- /absolute/path/peer.json status
npm run peer -- /absolute/path/peer.json files
npm run peer -- /absolute/path/peer.json upload /absolute/path/example.txt
npm run peer -- /absolute/path/peer.json download FILE_ID /absolute/path/download.txt
npm run peer -- /absolute/path/peer.json cancel
```

For an embedded client, use `Connection` from `src/connection.mjs` with `Peer` from `src/peer.mjs`. See `scripts/peer-client.mjs` for the complete connection and cleanup sequence. `Connection.request('ask', { text, attachments: [fileId] })` explicitly selects model attachments. Replies and presence messages never start another model turn automatically.

## Files and photos

Upload a selected file in the client, or make a host file available to one paired peer:

```sh
npm run background -- send-file PEER_ID /absolute/path/example.txt
```

The file is snapshotted. The peer clicks **Refresh files**, then **Download**. Downloaded bytes are checked against SHA-256. Transfer does not automatically attach content to a model request. Select an uploaded file before sending a message to attach it. The agent accepts PNG/JPEG images and UTF-8 text up to 32 KB as model attachments; other formats can still be transferred.

**Open camera** starts a preview. **Attach photo** captures one frame and stops the camera. The photo reaches the model only with your next sent message. No live video stream is sent to the model.

## Voice

**Dictate a draft** uses browser speech recognition and leaves the text editable. **Read replies aloud** uses device speech synthesis. Neither requires a transcription key on the service.

For **Record voice**, set `OPENAI_API_KEY` in the environment that starts the service, then restart it. Record up to 60 seconds, review the audio, and click **Send recording**. The recording travels over the encrypted peer connection, then the service submits it to OpenAI's audio transcription API. The transcript enters that peer's Codex conversation. API transcription has its own billing, separate from Codex account access.

`VDONINJA_TRANSCRIPTION_MODEL` optionally selects the transcription model; the default is `gpt-transcribe`. Browser speech synthesis reads the resulting text reply if enabled. Recorded voice is a turn-based exchange, not native ChatGPT voice mode or a continuous call.

## Storage and limits

The default service directory is `~/.vdoninja-connect/background/`. Override it with `VDONINJA_BACKGROUND_DATA` before starting the service. Keep this directory private: `config.json` contains connection and local control credentials; `state.json` contains pairing keys, request records and conversation IDs. Codex stores its own conversation transcripts in its Codex home.

- One model turn runs at a time, with up to eight queued requests.
- Model turns time out after three minutes. Audio transcription times out after one minute.
- Defaults allow 120 accepted model requests and 1,000,000 reported tokens per UTC day across all peers. Token accounting is checked between turns, so one turn may exceed the threshold. Edit `dailyTurns` and `dailyTokens` in `config.json` while stopped to change these limits.
- Files are limited to 8 MiB each, 32 MiB per peer and 128 MiB total. Delete files from the client when no longer needed. Incomplete uploads also count against the quota.
- Up to 32 pairings are stored. Revoked pairings remain with their conversation ownership; use a fresh service data directory for a fresh installation.
- Requests carry stable IDs and a ten-minute validity window. Recent results remain available for at least twenty minutes. Reconnect and check the saved request ID after a timeout; do not blindly submit the same task under a new ID.
- After an interrupted service run, unfinished requests are marked interrupted and are not automatically repeated. Send a new request when you want to continue the saved conversation.

The service binds local control to loopback and requires a private bearer token. Do not forward its control port through a router or tunnel. Remote clients use P2P requests, never the local control API.

The Codex adapter uses read-only execution and disables command execution, connectors, browser/computer tools, subagents, memory sharing and the code execution host for its own child process. It does not modify your global Codex configuration. Use this service for conversations and explicitly selected attachments; broader computer automation needs a separately scoped integration.

