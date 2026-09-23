# Publishing blog posts

The portfolio is a static GitHub Pages site, so publishing a post does not require a database or a build step.

## Add a post

1. Create a new HTML file in the repository, for example `posts/my-first-post.html`.
2. Copy the structure and styles from `blog.html` (or keep the post page simpler) and replace the content with your writing.
3. Add a card inside the `.posts` section of `blog.html`:

```html
<article class="post" data-category="engineering">
  <div class="post-meta"><span class="tag">Engineering</span><span>24 Sep 2026</span></div>
  <h3>My post title</h3>
  <p>A short description shown on the blog landing page.</p>
  <a class="read" href="./posts/my-first-post.html">Read the post →</a>
</article>
```

4. Commit the files to `main`. GitHub Pages will publish them automatically.

Use one of the existing filter categories (`engineering`, `identity`, or `career`) or add a new filter button and matching `data-category` value in `blog.html`.

The blog landing page is available at `/blog.html` on the published site.
