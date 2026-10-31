// Deliverability signals for a candidate address, all without a paid API:
//   • SMTP RCPT probe against the domain's MX (Node only; needs outbound port 25)
//   • catch-all detection (random mailbox accepted ⇒ SMTP says nothing)
//   • Microsoft 365 account-existence check (for M365-hosted domains)
//   • Gravatar lookup (a profile on the exact address ⇒ strong positive)
import { platform } from './platform.js';

// → {status:'valid'|'invalid'|'catch_all'|'unknown', reason, port25}
export async function checkSmtp(email, mxHosts, opts = {}) {
  if (!mxHosts?.length) return { status: 'unknown', reason: 'no MX', port25: 'n/a' };
  if (!platform.smtp) return { status: 'unknown', reason: 'SMTP probing is not available in the browser', port25: 'n/a' };
  return platform.smtp(email, mxHosts, opts);
}

// Microsoft 365 / Entra ID account existence (public endpoint used by the sign-in page).
// IfExistsResult: 0 = exists, 1 = does not exist, 5/6 = exists (federated / other IdP), 4 = throttled
export async function checkO365(email) {
  try {
    const r = await fetch('https://login.microsoftonline.com/common/GetCredentialType', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Username: email }), signal: AbortSignal.timeout(7000),
    });
    const j = await r.json();
    const code = j.IfExistsResult;
    if (code === 0 || code === 5 || code === 6) return { exists: true, code };
    if (code === 1) return { exists: false, code };
    return { exists: null, code };
  } catch (e) { return { exists: null, code: null, error: e.message }; }
}

async function gravatarHas(hash) {
  const r = await fetch(`https://www.gravatar.com/avatar/${hash}?d=404`, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
  return r.status === 200 ? true : r.status === 404 ? false : null;
}

export async function checkGravatar(email) {
  try {
    const norm = email.trim().toLowerCase();
    const a = await gravatarHas(await platform.sha256(norm));
    if (a !== false || !platform.md5) return a;
    return gravatarHas(await platform.md5(norm)); // older profiles are keyed by md5
  } catch { return null; }
}

export const syntaxOk = (e) => /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(String(e));
