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

const encode = (value) => {
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

const decode = (value) => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return new Uint8Array([...binary].map((char) => char.charCodeAt(0)));
};

const decodeBase64Text = (value = '') => {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
  return new TextDecoder().decode(Uint8Array.from(atob(padded), (char) => char.charCodeAt(0)));
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

function articleMetaFromHtml(html = '') {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const title = doc.querySelector('h1')?.textContent.trim() || 'Untitled post';
  const description = doc.querySelector('meta[name="description"]')?.getAttribute('content')?.trim() || '';
  const small = doc.querySelector('article small')?.textContent.trim() || '';
  const parts = small.split('•').map((part) => part.trim()).filter(Boolean);
  const date = parts[0] || new Date().toISOString().slice(0, 10);
  const category = parts[1] || 'Engineering';
  const cover = doc.querySelector('article img')?.getAttribute('src') || '';
  const article = doc.querySelector('article');
  const markdown = article ? article.textContent.replace(/\s+/g, ' ').trim() : '';

  return {
    title,
    excerpt: description || markdown.slice(0, 180),
    date,
    category,
    cover,
    markdown: markdown || description || title
  };
}

async function listPosts(env) {
  const directoryUrl = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/posts?ref=main`;
  const listResponse = await fetch(directoryUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'scmishra-blog-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!listResponse.ok) throw new Error(`Unable to load blog posts: ${await listResponse.text()}`);
  const files = await listResponse.json();

  const posts = await Promise.all(files.filter((file) => file.type === 'file' && file.name.endsWith('.html')).map(async (file) => {
    const fileResponse = await fetch(file.url, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        'User-Agent': 'scmishra-blog-admin',
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });

    const item = await fileResponse.json();
    const html = decodeBase64Text(item.content || '');
    const meta = articleMetaFromHtml(html);
    const slug = file.name.replace(/\.html$/, '');

    return {
      slug,
      title: meta.title,
      excerpt: meta.excerpt,
      date: meta.date,
      category: meta.category,
      cover: meta.cover,
      markdown: meta.markdown,
      sha: item.sha,
      path: item.path,
      url: `https://${env.OWNER}.github.io/posts/${file.name}`
    };
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

  const path = `posts/${slug}.html`;
  const targetUrl = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`;
  const payload = {
    message: updateExisting ? `Update blog post: ${title}` : `Add blog post: ${title}`,
    content: githubBase64(html)
  };

  const existingResponse = await fetch(targetUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'scmishra-blog-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (existingResponse.ok && updateExisting) {
    const existing = await existingResponse.json();
    payload.sha = existing.sha;
  }

  const response = await fetch(targetUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'scmishra-blog-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { url: `https://${env.OWNER}.github.io/posts/${slug}.html`, slug, title };
}

async function deletePost(slug, env) {
  const path = `posts/${slug}.html`;
  const targetUrl = `https://api.github.com/repos/${env.OWNER}/${env.REPO}/contents/${path}`;

  const existingResponse = await fetch(targetUrl, {
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'User-Agent': 'scmishra-blog-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });

  if (!existingResponse.ok) {
    throw new Error(`Post not found: ${slug}`);
  }

  const existing = await existingResponse.json();
  const response = await fetch(targetUrl, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'scmishra-blog-admin',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: JSON.stringify({ message: `Delete blog post: ${slug}`, sha: existing.sha })
  });

  if (!response.ok) throw new Error(`GitHub returned ${response.status}: ${await response.text()}`);
  return { deleted: true, slug };
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

      const payload = encode(JSON.stringify({ login: user.login, id: user.id }));
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
      try {
        return json(200, await listPosts(env));
      } catch (error) {
        return json(400, { error: error.message });
      }
    }

    if (url.pathname === '/api/posts' && request.method === 'POST') {
      const session = await sessionFrom(request, env);
      if (!session || session.login !== (env.ALLOWED_LOGIN || 'scmishra-cse')) return json(401, { error: 'Not authenticated.' });
      try {
        const body = await request.json();
        const mode = String(body.action || 'create').toLowerCase();
        const isUpdate = mode === 'update' || !!body.originalSlug;
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
