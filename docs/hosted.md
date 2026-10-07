# Run the hosted MCP connector

The hosted connector lets an MCP client reach a selected VDO.Ninja background agent. The user authorizes a fresh pairing through an OAuth consent page. No VDO.Ninja account is required. The connector processes the selected messages and text files; it is a participant in the encrypted peer connection.

## Deploy

Run one instance of the included Docker image on an always-on Linux host behind an HTTPS reverse proxy. The host needs outbound WebSocket access to VDO.Ninja signaling and WebRTC connectivity, including TURN when direct connections cannot be established. A static site host cannot run this service.

Build the image with `docker build -t vdoninja-connect .`. Set these environment variables through the host's secret/configuration mechanism:

| Variable | Value |
| --- | --- |
| `VDONINJA_HOSTED_ORIGIN` | Public HTTPS origin, without a path or trailing slash |
| `VDONINJA_HOSTED_SECRET` | 32 cryptographically random bytes encoded as 64 hex characters |
| `VDONINJA_OAUTH_REDIRECTS` | Comma-separated exact callback URLs shown by the MCP client management page |
| `VDONINJA_HOSTED_DATA` | Persistent data directory; `/data` in the image |
| `PORT` | Internal HTTP port; default `8788` |
| `HOST` | Bind address; `0.0.0.0` in the image |
| `VDONINJA_DOMAIN_CHALLENGE` | Exact OpenAI verification token, only when the submission portal supplies it |

Mount a persistent volume at `/data`, writable by the image's `node` user. Protect the encryption key separately from this volume. Losing the key makes the saved authorizations unreadable; do not replace it during ordinary restarts. Never commit the key, database, tokens or reviewer invitations.

Use one process and one replica per data volume. The file-backed store does not support concurrent writers. Set explicit CPU and memory limits; two CPUs and 1 GiB are a starting allocation to measure under your deployment's workload. The service limits native peers to four, reduced to half the available logical CPUs. Additional connections receive a capacity error. Scale by redesigning ownership/storage before adding replicas.

Forward the original public Host header. The connector does not trust forwarded client-IP headers; configure request limits at the reverse proxy as well. Disable request-body and authorization-header logging. Configure infrastructure access-log retention and disclose it in the deployed service's privacy policy. The connector's own rate counters remain only in memory for one minute.

## Connect a client

Register the public `/mcp` URL with the MCP client. The connector exposes OAuth discovery, dynamic client registration, authorization-code exchange with S256 PKCE, rotating refresh tokens and revocation. Copy the client's exact callback URL into the allowlist; arbitrary redirect destinations are rejected. Public clients use `token_endpoint_auth_method: none` with PKCE.

On the agent computer, run `npm run background -- invite "ChatGPT"`. Enter that fresh link only on the hosted consent page. The connector rotates the invitation key during pairing and stores the replacement encrypted at rest. The pairing cannot be reused by a second connection.

The user grants permission to send agent messages, read replies, exchange selected text files and cancel this pairing's requests. It does not grant shell access or arbitrary file reads. The agent computer must stay awake and its Codex CLI must remain authenticated.

## Tools

| Tool | Action |
| --- | --- |
| `get_agent_status` | Check reachability without starting a model turn |
| `ask_agent` | Submit a specific task with a stable request key and selected attachment IDs |
| `get_agent_reply` | Read a request belonging to this connection |
| `cancel_agent_requests` | Cancel this pairing's active and queued requests |
| `list_agent_files` | List this pairing's available files |
| `send_agent_text_file` | Transfer selected UTF-8 text up to 24 KB |
| `read_agent_text_file` | Read one selected UTF-8 file up to 24 KB |
| `disconnect_agent` | Delete hosted credentials and revoke this connection |

An `ask_agent` request key cannot be reused with different content. After a timeout, read the saved request instead of creating another task. The connector retains up to 200 request fingerprints per authorization, not message bodies. File sends are separate writes: check the file list after an uncertain result before sending again.

## Operate and revoke

`GET /health` checks the HTTP service. OAuth and MCP errors contain no pairing secrets. Authorizations last up to seven days and access tokens up to one hour. Expired records are removed by the minute maintenance cycle. Idle native peers close after two minutes and reconnect when used again. Service restart retains authorization and request references in the encrypted database.

Use `disconnect_agent` or OAuth `/revoke` to remove hosted access. These actions do not delete the owner's local conversation or files. Use `npm run background -- revoke PEER_ID` on the agent computer to cancel its work and block the pairing there too.

The container includes no Codex executable or account credential. Model work occurs on the paired agent computer. Keep the local background service's control port private; the hosted connector uses P2P and never calls that port.
