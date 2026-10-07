# VDO.Ninja Connect

Talk to an agent through a private P2P link, exchange selected files, and keep a Codex conversation available after closing the desktop app. No VDO.Ninja account is required.

**[Open the browser client](https://steveseguin.github.io/vdoninja-connect/)** on your computer or phone. Connect using a private invitation from your running agent service.

## Start your background agent

Install Node.js 22 or newer and the Codex CLI, then sign in with `codex login`. In this folder:

```sh
npm ci --ignore-scripts
npm run background -- start
npm run background -- invite
```

Open the returned `web_url` on your phone or computer and click **Connect to agent**. The `url` address opens the locally served client on the service computer. Each invitation pairs one browser or agent; that device saves its replacement key for reconnecting. Each pairing gets its own persistent Codex conversation.

The service runs independently of the desktop app. Keep its computer awake and connected to the internet. Codex uses its configured account and usage allowance. This creates a separate conversation; it does not connect to an existing ChatGPT Dot thread.

```sh
npm run background -- status
npm run background -- stop
```

See [background setup](docs/background.md) for Windows login startup, another device, agent clients, voice, files and revoking access.

[Watch the browser walkthrough](https://steveseguin.github.io/vdoninja-connect/demo.html): turn selected notes into a checklist, download a file and continue the conversation after reconnecting.

## Talk, share and listen

- Send messages from the browser or a headless agent client.
- Upload and download selected files up to 8 MiB. Select text or images to attach them to a message.
- Dictate an editable draft or enable **Read replies aloud** using browser speech services.
- Configure a transcription API key to send recorded voice messages.
- Open the camera and attach a photo when you want the agent to see something.

The background assistant is configured for conversation and selected attachments. It has no remote shell command interface. Continuous audio/video calls are not supported; use recorded voice and selected photos.

## Add the MCP tools

For temporary peer rooms or controlling background invitations from a local agent:

```sh
node scripts/setup-local.mjs
```

Reopen this trusted project in Codex to load its project MCP configuration. Other local MCP clients can launch `node` with the absolute path to `src/server.mjs`. Set a tool timeout of at least 35 seconds. Use either this MCP entry or the packaged plugin, so tools are not registered twice.

Ask: "Create a peer room and give me the browser link." Another agent can join with `vdo_connect`, exchange messages and selected files, and disconnect when finished. These temporary sessions end with their MCP process and do not start background model turns. [Temporary room guide](docs/rooms.md).

## Hosted MCP connector

To connect a remote MCP client, deploy the [hosted connector](docs/hosted.md) and register its HTTPS `/mcp` endpoint. It uses OAuth to pair with the background service and exposes selected tasks and text files. GitHub Pages hosts the browser client; the connector needs an always-on server.

## Privacy and connections

Keep invitations and saved pairing keys private. Background messages and files use a separate encryption key for each pairing; revoke that pairing to stop access. Temporary rooms instead grant room access to anyone with their invitation, and peer names are self-asserted.

VDO.Ninja provides signaling, and TURN may relay encrypted traffic when a direct route is unavailable. Peers may learn each other's IP addresses. Messages and selected attachments sent to Codex reach its model provider. Recorded voice sent for transcription reaches OpenAI; browser dictation may use the browser vendor's service.

State and files are stored under `~/.vdoninja-connect/`. Codex also retains its conversation history. Stop the service before removing its local data. [Storage and operating details](docs/background.md#storage-and-limits).

## Package

```sh
npm run package:client
npm run package:plugin
```

The client command produces a standalone HTML client. The plugin command produces a source ZIP with its lockfile and manifests; install its dependencies before running it. Outputs default to `~/.codex/artifacts/vdoninja-connect/`, or `VDONINJA_PACKAGE_DIR`. [Distribution guide](docs/publishing.md).

