# Distribute VDO.Ninja Connect

## Local plugin

Run `npm run package:plugin` to create a source ZIP. Extract it, run `npm ci --ignore-scripts`, then register `src/server.mjs` as a local stdio MCP server or use the included plugin manifest with a compatible local plugin host. The package includes a local marketplace catalog under `.agents/plugins/marketplace.json`.

The background service is separately started with `npm run background -- start`. Installing the MCP plugin does not automatically start an unattended agent or enable login startup.

## Browser client

The public client is hosted at https://steveseguin.github.io/vdoninja-connect/ from this repository's default branch, using the `/docs` publishing folder. After changing client source or its SDK dependency, run `npm run build:pages` and commit the updated `docs/index.html`. GitHub Pages publishes it when the commit is pushed. No model credentials or private invitations belong in the generated page.

Run `npm run package:client` to generate `vdoninja-connect.html`. Serve it from a trusted HTTPS static host for other devices. The file includes its SDK and application code; it contains no room password, pairing key or model credentials. Users paste their own private invitations after opening it.

## Public OpenAI directory

Local installation and public directory publication use different distribution paths. Follow the current [plugin packaging guidance](https://developers.openai.com/plugins/build/plugins) and [submission requirements](https://developers.openai.com/plugins/deploy/submission) when preparing a public release.

A hosted MCP edition needs an authenticated public HTTPS endpoint, caller-scoped sessions and approved attachment handling. Do not expose this local stdio server or background control API through an unauthenticated HTTP wrapper. The local service has access to owner-selected host files and cannot serve unrelated public users safely.

Before submitting a hosted edition, configure its production endpoint and authorization, verify the publisher and domain, and supply real support/privacy URLs and product metadata through the submission process. Keep local source downloads available separately for users running their own agents.

