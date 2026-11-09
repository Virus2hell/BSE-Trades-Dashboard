// HMAC-SHA256 signing for the BSE -> dashboard "pull ready" webhook.
import crypto from 'node:crypto';

export function sign(secret, body) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

export function verify(secret, body, header) {
  if (!header || typeof header !== 'string') return false;
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(header);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
