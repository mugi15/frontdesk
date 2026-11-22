import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

const AGENT_COOKIE = 'frontdesk_agent';
const CUSTOMER_COOKIE = 'frontdesk_customer';
const HOUR = 3600;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

function cookieValue(req, name) {
  return (req.headers.cookie || '').split(';').map((value) => value.trim())
    .find((value) => value.startsWith(name + '='))?.slice(name.length + 1);
}

function equal(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const digest = (value) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(left), digest(right));
}

export function createAuth({
  required = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production' || process.env.FRONTDESK_AUTH_REQUIRED === '1',
  agentPassword = process.env.FRONTDESK_AGENT_PASSWORD,
  sessionSecret = process.env.FRONTDESK_SESSION_SECRET,
  secureCookies = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production'
} = {}) {
  if (required && (!agentPassword || agentPassword.length < 16 || !sessionSecret || sessionSecret.length < 32)) {
    throw new Error('Hosted Frontdesk requires a 16+ character FRONTDESK_AGENT_PASSWORD and a 32+ character FRONTDESK_SESSION_SECRET.');
  }

  function signature(name, value) {
    return createHmac('sha256', sessionSecret).update(`${name}:${value}`).digest('base64url');
  }

  function read(req, name) {
    if (!required) return null;
    const cookie = cookieValue(req, name);
    if (!cookie) return null;
    const [id, expires, mac, extra] = cookie.split('.');
    if (extra !== undefined || !UUID.test(id) || !/^\d{10}$/.test(expires)) return null;
    if (Number(expires) <= Math.floor(Date.now() / 1000) || !equal(mac, signature(name, `${id}.${expires}`))) return null;
    return id;
  }

  function set(res, name, id, age) {
    const value = `${id}.${Math.floor(Date.now() / 1000) + age}`;
    const cookie = age === 0 ? '' : `${value}.${signature(name, value)}`;
    res.setHeader('Set-Cookie', `${name}=${cookie}; Path=/; Max-Age=${age}; HttpOnly; SameSite=Lax${secureCookies ? '; Secure' : ''}`);
  }

  return {
    required,
    checkAgentPassword: (password) => required && equal(password, agentPassword),
    agent: (req) => read(req, AGENT_COOKIE),
    customer: (req) => read(req, CUSTOMER_COOKIE),
    signInAgent: (res, id) => set(res, AGENT_COOKIE, id, 12 * HOUR),
    signOutAgent: (res) => set(res, AGENT_COOKIE, '', 0),
    rememberCustomer(req, res) {
      if (!required) return null;
      const id = read(req, CUSTOMER_COOKIE) || randomUUID();
      set(res, CUSTOMER_COOKIE, id, 30 * 24 * HOUR);
      return id;
    }
  };
}
