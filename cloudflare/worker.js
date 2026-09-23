const SITE_ORIGIN = 'https://scmishra-cse.github.io';

const corsHeaders = {
  'Access-Control-Allow-Origin': SITE_ORIGIN,
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, DELETE'
};

const json = (status, body, extra = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, 'Content-Type': 'application/json', ...extra }
});

const base64Url = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const githubBase64 = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};

const decodeBase64 = (value = '') => {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
};

const decodeCookiePayload = (value) => decodeBase64(value);

async function signature(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return base64Url(String.fromCharCode(...bytes));
}

async function sessionFrom(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)gh_blog_session=([^;]+)/);
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || sig !== await signature(payload, env.COOKIE_SECRET)) return null;
  try { return JSON.parse(decodeCookiePayload(payload)); } catch { return null; }
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

function stripTags(value = '') {
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
}

function firstMatch(html, expression) {
  return html.match(expression)?.[1]?.trim() || '';
}

// Cloudflare Workers do not provide DOMParser. Parse only the metadata emitted by publish().
function articleMetaFromHtml(html = '') {
  const title = stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || 'Untitled post';
  const description = stripTags(firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i));
  const small = stripTags(firstMatch(html, /<small[^>]*>([\s\S]*?)<\/small>/i));
  const parts = small.split('•').map((part) => part.trim()).filter(Boolean);
  const article = firstMatch(html, /<article[^>]*>([\s\S]*?)<\/article>/i);
  const cover = firstMatch(article, /<img[^>]+src=["']([^"']+)["']/i);
  const withoutHeader = article.replace(/<small[^>]*>[\s\S]*?<\/small>/i, '').replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '').replace(/<img[^>]*>/i, '');
  const markdown = stripTags(withoutHeader);
  return {
    title,
    excerpt: description || markdown.slice(0, 180),
    date: parts[0] || new Date().toISOString().slice(0, 10),
    category: parts[1] || 'Engineering',
    cover,
    markdown: markdown || description || title
  };
}

function githubHeaders(env) {
  return { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'scmishra-blog-admin', 'X-GitHub-Api-Version': '2022-11-28' };
}

async function listPosts(env) {
  const directory = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts?ref=main`, { headers: githubHeaders(env) });
  if (!directory.ok) throw new Error(`Unable to load blog posts: ${await directory.text()}`);
  const files = await directory.json();
  const posts = await Promise.all(files.filter((file) => file.type === 'file' && file.name.endsWith('.html')).map(async (file) => {
    const response = await fetch(file.url, { headers: githubHeaders(env) });
    if (!response.ok) throw new Error(`Unable to read ${file.name}`);
    const item = await response.json();
    const meta = articleMetaFromHtml(decodeBase64(item.content || ''));
    return { ...meta, slug: file.name.replace(/\.html$/, ''), sha: item.sha, path: item.path, url: `https://${env.OWNER}.github.io/posts/${file.name}` };
  }));
  return posts.sort((a, b) => new Date(b.date) - new Date(a.date));
}

async function publish(body, env, updateExisting = false) {
  const title = String(body.title || '').trim();
  const slug = String(body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const date = String(body.date || new Date().toISOString().slice(0, 10)).trim();
  const category = String(body.tag || 'Engineering').trim();
  const excerpt = String(body.excerpt || '').trim();
  const cover = String(body.cover || '').trim();
  const markdown = String(body.markdown || '').trim();
  if (!title || !slug || !markdown) throw new Error('Title and content are required.');

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(excerpt || title)}"><style>body{margin:0;background:#f5f7fb;color:#182235;font-family:Arial,sans-serif}.wrap{max-width:860px;margin:auto;padding:40px 20px 80px}.back{color:#30458a;font-weight:bold;text-decoration:none}.article{margin-top:20px;background:#fff;border:1px solid #e5ebf3;border-radius:22px;padding:28px;box-shadow:0 16px 45px rgba(15,23,42,.06)}h1{font-size:clamp(2rem,5vw,4rem);line-height:1.05}small{display:block;color:#5b6880;margin:8px 0 18px}p,li{line-height:1.8}pre{background:#0f172a;color:#dfe8ff;padding:16px;border-radius:12px;overflow:auto}blockquote{border-left:4px solid #4656df;padding-left:14px;color:#5b6880;font-style:italic}img{width:100%;max-height:360px;object-fit:cover;border-radius:16px;display:block}</style></head><body><div class="wrap"><a class="back" href="../blog.html">← Back to blog</a><article class="article"><small>${escapeHtml(date)} • ${escapeHtml(category)}</small><h1>${escapeHtml(title)}</h1>${cover ? `<img src="${escapeHtml(cover)}" alt="${escapeHtml(title)}">` : ''}${markdownToHtml(markdown)}</article></div></body></html>`;
  const target = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts/${slug}.html`;
  const payload = { message: `${updateExisting ? 'Update' : 'Add'} blog post: ${title}`, content: githubBase64(html) };
  if (updateExisting) {
    const existing = await fetch(target, { headers: githubHeaders(env) });
    if (!existing.ok) throw new Error(`Post not found: ${slug}`);
    payload.sha = (await existing.json()).sha;
  }
  const response = await fetch(target, { method: 'PUT', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { url: `https://${env.OWNER}.github.io/posts/${slug}.html`, slug, title };
}

async function deletePost(slug, env) {
  const target = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts/${slug}.html`;
  const existing = await fetch(target, { headers: githubHeaders(env) });
  if (!existing.ok) throw new Error(`Post not found: ${slug}`);
  const response = await fetch(target, { method: 'DELETE', headers: { ...githubHeaders(env), 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `Delete blog post: ${slug}`, sha: (await existing.json()).sha }) });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { deleted: true, slug };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const callback = env.AUTH_REDIRECT_URI || `${url.origin}/auth/callback`;

    if (url.pathname === '/auth/github') {
      return Response.redirect(`https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.GITHUB_CLIENT_ID)}&redirect_uri=${encodeURIComponent(callback)}&scope=read:user`, 302);
    }
    if (url.pathname === '/auth/callback') {
      const code = url.searchParams.get('code');
      if (!code) return json(400, { error: 'Missing OAuth code.' });
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callback }) });
      const token = await tokenResponse.json();
      if (!token.access_token) return json(400, { error: token.error || 'Failed to get GitHub access token.' });
      const user = await (await fetch('https://api.github.com/user', { headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'scmishra-blog-admin' } })).json();
      if (!user.login || user.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(403, { error: 'Only the configured GitHub account may publish.' });
      const payload = base64Url(JSON.stringify({ login: user.login, id: user.id }));
      const sig = await signature(payload, env.COOKIE_SECRET);
      return new Response(null, { status: 302, headers: { ...corsHeaders, Location: `${SITE_ORIGIN}/admin/index.html`, 'Set-Cookie': `gh_blog_session=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800` } });
    }
    if (url.pathname === '/api/session') {
      const session = await sessionFrom(request, env);
      return session ? json(200, session) : json(401, { error: 'Not authenticated.' });
    }
    if (url.pathname === '/api/logout') return new Response(null, { status: 204, headers: { ...corsHeaders, 'Set-Cookie': 'gh_blog_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0' } });

    const session = await sessionFrom(request, env);
    if (url.pathname === '/api/posts' && request.method === 'GET') {
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try { return json(200, await listPosts(env)); } catch (error) { return json(400, { error: error.message }); }
    }
    if (url.pathname === '/api/posts' && request.method === 'POST') {
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try { const body = await request.json(); return json(200, await publish(body, env, body.action === 'update' || !!body.originalSlug)); } catch (error) { return json(400, { error: error.message }); }
    }
    if (url.pathname.startsWith('/api/posts/') && request.method === 'DELETE') {
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try { return json(200, await deletePost(decodeURIComponent(url.pathname.replace('/api/posts/', '')), env)); } catch (error) { return json(400, { error: error.message }); }
    }
    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
