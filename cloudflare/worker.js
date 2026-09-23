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

const base64UrlEncode = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const githubBase64Encode = (value) => {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary);
};

const base64Decode = (value = '') => {
  const normalized = String(value).replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
};

async function signature(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return base64UrlEncode(String.fromCharCode(...bytes));
}

async function sessionFrom(request, env) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)gh_blog_session=([^;]+)/);
  if (!match) return null;
  const [payload, sig] = match[1].split('.');
  if (!payload || sig !== await signature(payload, env.COOKIE_SECRET)) return null;
  try { return JSON.parse(base64Decode(payload)); } catch { return null; }
}

function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripTags(value = '') {
  return String(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function firstMatch(html, regex) {
  const match = String(html || '').match(regex);
  return match ? match[1] : '';
}

function parsePageHtml(pageHtml = '') {
  const html = String(pageHtml || '');
  const title = stripTags(firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i)) || 'Untitled post';
  const description = stripTags(firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i));
  const cover = firstMatch(html, /<img[^>]+src=["']([^"']+)["'][^>]*>/i) || '';
  const article = firstMatch(html, /<article[^>]*>([\s\S]*?)<\/article>/i) || html;
  const small = stripTags(firstMatch(article, /<small[^>]*>([\s\S]*?)<\/small>/i));
  const parts = small.split('•').map((part) => part.trim()).filter(Boolean);
  const body = article
    .replace(/<small[^>]*>[\s\S]*?<\/small>/i, '')
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/i, '')
    .replace(/<img[^>]*>/i, '')
    .trim();
  return {
    title,
    excerpt: description || title,
    date: parts[0] || new Date().toISOString().slice(0, 10),
    category: parts[1] || 'Engineering',
    cover,
    contentHtml: body || '<p>Write something here.</p>'
  };
}

function githubHeaders(env) {
  return {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'scmishra-blog-admin',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

async function listPosts(env) {
  const directoryResponse = await fetch(`https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts?ref=main`, {
    headers: githubHeaders(env)
  });
  if (!directoryResponse.ok) throw new Error(`Unable to load blog posts: ${await directoryResponse.text()}`);
  const files = await directoryResponse.json();
  const posts = await Promise.all(files.filter((file) => file.type === 'file' && file.name.endsWith('.html')).map(async (file) => {
    const response = await fetch(file.url, { headers: githubHeaders(env) });
    if (!response.ok) throw new Error(`Unable to read ${file.name}`);
    const item = await response.json();
    const page = base64Decode(item.content || '');
    const meta = parsePageHtml(page);
    return {
      ...meta,
      slug: file.name.replace(/\.html$/, ''),
      sha: item.sha,
      path: item.path,
      url: `https://${env.OWNER}.github.io/posts/${file.name}`
    };
  }));
  return posts.sort((a, b) => new Date(b.date) - new Date(a.date));
}

function buildPostPage({ title, excerpt, cover, contentHtml, date, category }) {
  const bodyHtml = contentHtml && String(contentHtml).trim() ? String(contentHtml).trim() : '<p>Write something here.</p>';
  const safeTitle = escapeHtml(title || 'Untitled post');
  const safeExcerpt = escapeHtml(excerpt || title || 'Untitled post');
  const safeCategory = escapeHtml(category || 'Engineering');
  const safeDate = escapeHtml(date || new Date().toISOString().slice(0, 10));
  const safeCover = cover ? `<img src="${escapeHtml(cover)}" alt="${safeTitle}" style="width:100%;max-height:420px;object-fit:cover;border-radius:18px;display:block;margin:18px 0;">` : '';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>${safeTitle}</title>
    <meta name="description" content="${safeExcerpt}">
    <style>
      body { margin: 0; background: #f5f7fb; color: #172033; font-family: Arial, sans-serif; }
      .wrap { max-width: 900px; margin: 0 auto; padding: 32px 20px 80px; }
      .back { display: inline-block; color: #30458a; text-decoration: none; font-weight: 700; margin-bottom: 18px; }
      article { background: #fff; border: 1px solid #e5ebf3; border-radius: 22px; box-shadow: 0 16px 45px rgba(15, 23, 42, .06); padding: 28px; }
      h1 { margin: 0; font-size: clamp(2.2rem, 5vw, 4rem); letter-spacing: -.06em; line-height: 1.04; }
      small { display: block; color: #5b6880; margin: 10px 0 20px; font-size: .85rem; }
      p, li, blockquote { line-height: 1.8; }
      p { margin: 18px 0; }
      img, video, iframe { max-width: 100%; border-radius: 14px; display: block; margin: 18px 0; }
      pre { background: #0f172a; color: #e5ecff; border-radius: 14px; padding: 16px; overflow: auto; }
      code { background: rgba(61,90,254,.08); color: #2f3ea0; padding: 2px 6px; border-radius: 6px; }
      blockquote { border-left: 4px solid #4656df; padding-left: 14px; color: #5b6880; font-style: italic; }
      ul, ol { padding-left: 1.4rem; }
      a { color: #2f3ea0; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <a class="back" href="../blog.html">← Back to blog</a>
      <article>
        <small>${safeDate} • ${safeCategory}</small>
        <h1>${safeTitle}</h1>
        ${safeCover}
        ${bodyHtml}
      </article>
    </div>
  </body>
</html>`;
}

async function deletePost(slug, env) {
  const target = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts/${slug}.html`;
  const existingResponse = await fetch(target, { headers: githubHeaders(env) });
  if (!existingResponse.ok) throw new Error(`Post not found: ${slug}`);
  const existing = await existingResponse.json();
  const response = await fetch(target, {
    method: 'DELETE',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: `Delete blog post: ${slug}`, sha: existing.sha })
  });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { deleted: true, slug };
}

async function publish(body, env, updateExisting = false) {
  const title = String(body.title || '').trim();
  const slug = String(body.slug || title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const originalSlug = String(body.originalSlug || '').trim();
  const date = String(body.date || new Date().toISOString().slice(0, 10)).trim();
  const category = String(body.tag || body.category || 'Engineering').trim();
  const excerpt = String(body.excerpt || '').trim();
  const cover = String(body.cover || '').trim();
  const contentHtml = String(body.contentHtml || body.html || body.markdown || '').trim();

  if (!title || !slug || !contentHtml) throw new Error('Title and content are required.');

  const target = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts/${slug}.html`;
  const payload = {
    message: `${updateExisting ? 'Update' : 'Add'} blog post: ${title}`,
    content: githubBase64Encode(buildPostPage({ title, excerpt, cover, contentHtml, date, category }))
  };

  if (updateExisting) {
    const existingResponse = await fetch(target, { headers: githubHeaders(env) });
    if (!existingResponse.ok) {
      // allow rename while preserving old file if needed
      if (!originalSlug) throw new Error(`Post not found: ${slug}`);
    } else {
      payload.sha = (await existingResponse.json()).sha;
    }
  }

  const response = await fetch(target, {
    method: 'PUT',
    headers: { ...githubHeaders(env), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);

  if (updateExisting && originalSlug && originalSlug !== slug) {
    try {
      await deletePost(originalSlug, env);
    } catch {
      // no-op: old file may already be absent or preserved intentionally
    }
  }

  return { url: `https://${env.OWNER}.github.io/posts/${slug}.html`, slug, title };
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
      const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: callback })
      });
      const token = await tokenResponse.json();
      if (!token.access_token) return json(400, { error: token.error || 'Failed to get GitHub access token.' });
      const userResponse = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token.access_token}`, 'User-Agent': 'scmishra-blog-admin' }
      });
      const user = await userResponse.json();
      if (!user.login || user.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(403, { error: 'Only the configured GitHub account may publish.' });
      const payload = base64UrlEncode(JSON.stringify({ login: user.login, id: user.id }));
      const sig = await signature(payload, env.COOKIE_SECRET);
      return new Response(null, {
        status: 302,
        headers: {
          ...corsHeaders,
          Location: `${SITE_ORIGIN}/admin/index.html`,
          'Set-Cookie': `gh_blog_session=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=604800`
        }
      });
    }

    if (url.pathname === '/api/session') {
      const session = await sessionFrom(request, env);
      return session ? json(200, session) : json(401, { error: 'Not authenticated.' });
    }

    if (url.pathname === '/api/logout') {
      return new Response(null, {
        status: 204,
        headers: { ...corsHeaders, 'Set-Cookie': 'gh_blog_session=; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=0' }
      });
    }

    if (url.pathname === '/api/posts' && request.method === 'GET') {
      const session = await sessionFrom(request, env);
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try { return json(200, await listPosts(env)); } catch (error) { return json(400, { error: error.message }); }
    }

    if (url.pathname === '/api/posts' && request.method === 'POST') {
      const session = await sessionFrom(request, env);
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try {
        const body = await request.json();
        const isUpdate = body.action === 'update' || !!body.originalSlug;
        return json(200, await publish(body, env, isUpdate));
      } catch (error) {
        return json(400, { error: error.message });
      }
    }

    if (url.pathname.startsWith('/api/posts/') && request.method === 'DELETE') {
      const session = await sessionFrom(request, env);
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try {
        const slug = decodeURIComponent(url.pathname.replace('/api/posts/', ''));
        return json(200, await deletePost(slug, env));
      } catch (error) {
        return json(400, { error: error.message });
      }
    }

    return new Response('Not found', { status: 404, headers: corsHeaders });
  }
};
