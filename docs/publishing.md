# Distribute VDO.Ninja Connect

## Local plugin

Run `npm run package:plugin` to create a source ZIP. Extract it, run `npm ci --ignore-scripts`, then register `src/server.mjs` as a local stdio MCP server or use the included plugin manifest with a compatible local plugin host. The package includes a local marketplace catalog under `.agents/plugins/marketplace.json`.

The background service is separately started with `npm run background -- start`. Installing the MCP plugin does not automatically start an unattended agent or enable login startup.

## Browser client

The public client is hosted at https://steveseguin.github.io/vdoninja-connect/ from this repository's default branch, using the `/docs` publishing folder. After changing client source or its SDK dependency, run `npm run build:pages` and commit the updated `docs/index.html`. GitHub Pages publishes it when the commit is pushed. No model credentials or private invitations belong in the generated page.

Run `npm run package:client` to generate `vdoninja-connect.html`. Serve it from a trusted HTTPS static host for other devices. The file includes its SDK and application code; it contains no room password, pairing key or model credentials. Users paste their own private invitations after opening it.

## Public OpenAI directory

Local installation and public directory publication use different distribution paths. Follow the current [plugin packaging guidance](https://developers.openai.com/plugins/build/plugins) and [submission requirements](https://developers.openai.com/plugins/deploy/submission) when preparing a public release.

Deploy the [hosted connector](hosted.md), register its public HTTPS endpoint with the client and complete OAuth pairing. Keep the background control API bound to loopback. The hosted tools use their own pairing and do not expose arbitrary owner filesystem access.

Set `VDONINJA_HOSTED_ORIGIN` to the deployed HTTPS origin and `VDONINJA_REVIEW_VIDEO_URL` to a reviewer-accessible recording of the hosted plugin workflows. Run `npm run package:submission`. The command checks public metadata URLs and the endpoint's OAuth challenge, then writes a separate submission ZIP containing the remote MCP configuration, hosted workflow skill, icon and review metadata. The local stdio runtime is distributed in the source ZIP.

The submission metadata includes five positive and three negative cases. Run them inside ChatGPT and Codex using a dedicated review agent with sample data. Record the hosted workflows, including authorization, selected-file tasks, cancellation and safe handling of unsupported requests. The browser walkthrough demonstrates the standalone client; make a separate hosted-plugin review recording.

Verify the publisher and endpoint domain through the submission portal. Enter private reviewer access through its secure form, never in the ZIP or repository. Arrange an always-on review agent and access that remains usable for repeat reviews; ordinary single-use user invitations must not be the reviewer's only access method. Publish only after the required checks and review complete. Keep local source downloads available separately for users running their own agents.

