// routes/blog.js — Blog CMS: public read endpoints + admin CRUD
const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { adminMiddleware } = require('../middleware/auth');

// ── Helpers ─────────────────────────────────────────────────────────
function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

async function uniqueSlug(base, ignoreId = null) {
  let slug = slugify(base) || 'post';
  let attempt = slug;
  let i = 1;
  while (true) {
    let query = supabase.from('blog_posts').select('id').eq('slug', attempt);
    if (ignoreId) query = query.neq('id', ignoreId);
    const { data } = await query.maybeSingle();
    if (!data) return attempt;
    attempt = `${slug}-${++i}`;
  }
}

const PUBLIC_FIELDS = 'id, title, slug, excerpt, cover_image_url, tag, author_name, read_minutes, published_at';

// ══════════════════════════════════════════════════════════════════════
// ADMIN ROUTES — must be BEFORE the public wildcard /:slug
// ══════════════════════════════════════════════════════════════════════

// ── Admin: Get all posts (drafts + published) ────────────────────────
router.get('/admin/all', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('Get all blog posts error:', err);
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

// ── Admin: Get single post by id (for edit form) ──────────────────────
router.get('/admin/:id', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts').select('*').eq('id', req.params.id).single();
    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Post not found.' });
  }
});

// ── Admin: Create post ─────────────────────────────────────────────────
router.post('/admin', adminMiddleware, async (req, res) => {
  try {
    const { title, excerpt, content, cover_image_url, tag, author_name, read_minutes, status, slug } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content are required.' });

    const finalSlug = await uniqueSlug(slug || title);
    const isPublished = status === 'published';

    const { data, error } = await supabase.from('blog_posts').insert({
      title,
      slug: finalSlug,
      excerpt: excerpt || null,
      content,
      cover_image_url: cover_image_url || null,
      tag: tag || 'General',
      author_name: author_name || 'Drix Team',
      read_minutes: read_minutes || 5,
      status: isPublished ? 'published' : 'draft',
      published_at: isPublished ? new Date() : null
    }).select().single();

    if (error) throw error;
    res.json({ success: true, post: data });
  } catch (err) {
    console.error('Create blog post error:', err);
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

// ── Admin: Update post ─────────────────────────────────────────────────
router.patch('/admin/:id', adminMiddleware, async (req, res) => {
  try {
    const { title, excerpt, content, cover_image_url, tag, author_name, read_minutes, status, slug } = req.body;

    const { data: existing, error: fetchErr } = await supabase
      .from('blog_posts').select('*').eq('id', req.params.id).single();
    if (fetchErr || !existing) return res.status(404).json({ error: 'Post not found.' });

    const update = { updated_at: new Date() };
    if (title !== undefined) update.title = title;
    if (excerpt !== undefined) update.excerpt = excerpt;
    if (content !== undefined) update.content = content;
    if (cover_image_url !== undefined) update.cover_image_url = cover_image_url;
    if (tag !== undefined) update.tag = tag;
    if (author_name !== undefined) update.author_name = author_name;
    if (read_minutes !== undefined) update.read_minutes = read_minutes;

    // Re-slug only if title or slug explicitly changed
    if (slug !== undefined && slug !== existing.slug) {
      update.slug = await uniqueSlug(slug, existing.id);
    } else if (title !== undefined && title !== existing.title && slug === undefined) {
      update.slug = await uniqueSlug(title, existing.id);
    }

    // Handle publish/unpublish transitions
    if (status !== undefined && status !== existing.status) {
      update.status = status;
      if (status === 'published' && !existing.published_at) update.published_at = new Date();
      if (status === 'draft') update.published_at = null;
    }

    const { data, error } = await supabase.from('blog_posts')
      .update(update).eq('id', req.params.id).select().single();
    if (error) throw error;
    res.json({ success: true, post: data });
  } catch (err) {
    console.error('Update blog post error:', err);
    res.status(500).json({ error: 'Failed to update post.' });
  }
});

// ── Admin: Delete post ─────────────────────────────────────────────────
router.delete('/admin/:id', adminMiddleware, async (req, res) => {
  try {
    const { error } = await supabase.from('blog_posts').delete().eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete post.' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// PUBLIC ROUTES — wildcards AFTER all specific /admin routes
// ══════════════════════════════════════════════════════════════════════

// ── Public: List published posts ──────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { tag, limit } = req.query;
    let query = supabase
      .from('blog_posts')
      .select(PUBLIC_FIELDS)
      .eq('status', 'published')
      .order('published_at', { ascending: false });
    if (tag) query = query.eq('tag', tag);
    if (limit) query = query.limit(parseInt(limit));
    const { data, error } = await query;
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('List blog posts error:', err);
    res.status(500).json({ error: 'Failed to fetch posts.' });
  }
});

// ── Public: Get single published post by slug ─────────────────────────
router.get('/:slug', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('status', 'published')
      .single();
    if (error || !data) return res.status(404).json({ error: 'Post not found.' });
    res.json(data);
  } catch (err) {
    res.status(404).json({ error: 'Post not found.' });
  }
});

module.exports = router;
