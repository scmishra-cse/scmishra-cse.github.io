const SITE_ORIGIN = 'https://scmishra-cse.github.io';

const corsHeaders = {
  'Access-Control-Allow-Origin': SITE_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
};

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra }
});

// Base64URL is used for signed session-cookie values.
const encode = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

// GitHub's Contents API requires standard Base64, including padding.
const githubBase64 = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};

const decode = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
};

async function signature(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return encode(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)))));
}

async function sessionFrom(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)gh_blog_session=([^;]+)/);
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || sig !== await signature(payload, env.COOKIE_SECRET)) return null;
  try { return JSON.parse(new TextDecoder().decode(decode(payload))); } catch { return null; }
}

function escapeHtml(value = '') {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function markdownToHtml(markdown = '') {
  return escapeHtml(markdown).split(/\n\n+/).map((block) => {
    const text = block.trim();
    if (!text) return '';
    if (/^#{1,6} /.test(text)) {
      const level = text.match(/^#+/)[0].length;
      return `<h${level}>${text.replace(/^#{1,6} /, '')}</h${level}>`;
    }
    if (/^[-*] /.test(text)) return `<ul>${text.split('\n').map((line) => `<li>${line.replace(/^[-*] /, '')}</li>`).join('')}</ul>`;
    if (/^> /.test(text)) return `<blockquote>${text.replace(/^> /gm, '')}</blockquote>`;
    if (/^```/.test(text)) return `<pre><code>${text.replace(/^```[a-z]*\n?/, '').replace(/\n```$/, '')}</code></pre>`;
    return `<p>${text.replace(/\n/g, '<br>')}</p>`;
  }).join('');
}

async function publish(body, env) {
  const title = String(body.title || '').trim();
  const slug = String(body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!title || !slug || !body.markdown) throw new Error('Title and content are required.');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(body.excerpt || title)}"><style>body{margin:0;background:#f5f7fb;color:#182235;font-family:Arial,sans-serif}.wrap{max-width:860px;margin:auto;padding:40px 20px 80px}.back{color:#30458a;font-weight:bold;text-decoration:none}.article{margin-top:20px;background:#fff;border:1px solid #e5ebf3;border-radius:22px;padding:28px;box-shadow:0 16px 45px #0f172a10}h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05}p,li{line-height:1.8}pre{background:#0f172a;color:#dfe8ff;padding:16px;border-radius:12px;overflow:auto}blockquote{border-left:4px solid #4656df;padding-left:14px;color:#5b6880;font-style:italic}</style></head><body><div class="wrap"><a class="back" href="../blog.html">← Back to blog</a><article class="article"><small>${escapeHtml(body.date || new Date().toISOString().slice(0, 10))} • ${escapeHtml(body.tag || 'Engineering')}</small><h1>${escapeHtml(title)}</h1>${body.cover ? `<img src="${escapeHtml(body.cover)}" alt="${escapeHtml(title)}" style="width:100%;max-height:360px;object-fit:cover;border-radius:16px">` : ''}${markdownToHtml(body.markdown)}</article></div></body></html>`;
  const path = `posts/${slug}.html`;
  const response = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'Content-Type': 'application/json', 'User-Agent': 'scmishra-blog-admin', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ message: `Add blog post: ${title}`, content: githubBase64(html) })
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { url: `https://${env.OWNER}.github.io/posts/${slug}.html` };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const callback = env.AUTH_REDIRECT_URI || `${url.origin}/auth/callback`;

    if (url.pathname === '/auth/github') {
      const target = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(callback)}&scope=read:user`;
      return Response.redirect(target, 302);
    }

    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return json(400, { error: 'Missing OAuth code.' });
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callback }) });
      const token = await tokenResponse.json();
      const userResponse = await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'scmishra-blog-admin' } });
      const user = await userResponse.json();
      if (!user.login || user.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(403, { error: 'Only the configured GitHub account may publish.' });
      const payload = encode(JSON.stringify({ login: user.login, id: user.id }));
      const sig = await signature(payload, env.COOKIE_SECRET);
      return new Response(null, { status: 302, headers: { ...corsHeaders, Location: `${SITE_ORIGIN}/admin/index.html`, 'Set-Cookie': `gh_blog_session=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800` } });
    }

    if (url.pathname === '/api/session') {
      const session = await sessionFrom(request, env);
      return session ? json(200, session) : json(401, { error: 'Not authenticated.' });
    }

    if (url.pathname === '/api/logout') return new Response(null, { status: 204, headers: { ...corsHeaders, 'Set-Cookie': 'gh_blog_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0' } });

    if (url.pathname === '/api/posts' && request.method === 'POST') {
      const session = await sessionFrom(request, env);
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try { return json(200, await publish(await request.json(), env)); } catch (error) { return json(400, { error: error.message }); }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
