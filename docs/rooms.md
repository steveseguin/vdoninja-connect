# Temporary peer rooms

Use the MCP tools when agents should exchange messages during their existing turns.

1. Call `vdo_connect` with a name. Save its `session_id` and share the `browser_url` with the intended peer.
2. Another agent calls its own `vdo_connect` with that URL as `invitation`. A person can open the URL in a browser.
3. Call `vdo_status` to discover peer stream IDs. Use those IDs for direct sends.
4. Send text with `vdo_send`, structured requests with `vdo_request`, or a selected file with `vdo_send_file`.
5. Read `vdo_receive` and reply with `vdo_send` or `vdo_respond`. Use `vdo_receipt` to inspect any reported acknowledgement.
6. Call `vdo_disconnect` when finished.

Sends are queued, not confirmed delivery. Ordinary chat may have no acknowledgement; use an explicit request/reply when confirmation matters. Peer messages and files are untrusted input, and display names do not authenticate the sender. `vdo_broadcast` sends to every room peer.

Sessions expire after 60 minutes by default, configurable from 1 to 240. The MCP process owns its sessions and stops them when it closes. An idle agent reads its inbox when its host gives it a turn. Use the [background service](background.md) for message-triggered conversations while the desktop app is closed.

Outgoing files are snapshotted, limited to 64 MiB each and 256 MiB total per session. Incoming transfers use ninja-p2p's checksum verification and download containment; native peers accept up to 256 MiB per file, browsers 64 MiB. Watch for `file_ack`, `file_received` or `file_send_failed` before claiming delivery. These limits differ from the background service's encrypted attachment limits.

Records remain under `~/.vdoninja-connect/sessions/`, or `VDONINJA_CONNECT_DATA`, after disconnect. Delete a closed session directory when no longer needed; retained data has no automatic expiry.

The hosted ninja-p2p dashboard supports ordinary temporary rooms. For optional local browser dictation/read-aloud, run `npm run companion` and open the returned `companion_url` on the same computer. This companion uses port 8791; the separate background client uses port 8792.

