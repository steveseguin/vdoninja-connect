import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

export const opaque = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export class HostedStore {
  constructor(directory, secret) {
    if (!/^[a-fA-F0-9]{64}$/.test(secret || '')) throw new Error('VDONINJA_HOSTED_SECRET must be 32 random bytes encoded as 64 hex characters.');
    this.key = Buffer.from(secret, 'hex');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.file = path.join(directory, 'hosted.enc');
    this.data = { clients: {}, codes: {}, grants: {}, tokens: {}, refresh: {} };
    if (existsSync(this.file)) {
      const data = readFileSync(this.file);
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      this.data = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8'));
    }
  }
  save() {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(this.data)), cipher.final()]);
    const temp = this.file + '.' + opaque() + '.tmp';
    writeFileSync(temp, Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { flag: 'wx', mode: 0o600 });
    renameSync(temp, this.file);
  }
  issue(grant) {
    const access = opaque(), refresh = opaque(), now = Date.now();
    this.data.tokens[hash(access)] = { grant: grant.id, expires: Math.min(now + 3600000, grant.expires) };
    this.data.refresh[hash(refresh)] = { grant: grant.id, expires: grant.expires };
    this.save();
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: Math.max(0, Math.floor((Math.min(now + 3600000, grant.expires) - now) / 1000)), scope: 'agent:connect' };
  }
  authenticate(token) {
    const entry = this.data.tokens[hash(token || '')];
    const grant = entry && this.data.grants[entry.grant];
    if (!entry || entry.expires <= Date.now() || !grant || grant.expires <= Date.now()) throw new Error('invalid_token');
    return grant;
  }
  remove(id) {
    delete this.data.grants[id];
    for (const name of ['codes', 'tokens', 'refresh']) {
      for (const [key, value] of Object.entries(this.data[name])) if (value.grant === id) delete this.data[name][key];
    }
    this.save();
  }
}
