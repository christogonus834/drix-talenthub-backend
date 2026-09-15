const express = require('express');
const router = express.Router();
const supabase = require('../config/supabase');
const { adminMiddleware } = require('../middleware/auth');

// PUBLIC: Get all published posts
router.get('/', async (req, res) => {
  try {
    const { data } = await supabase
      .from('blog_posts')
      .select('id, title, slug, excerpt, tag, author, read_time, cover_image, published, created_at')
      .eq('published', true)
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// PUBLIC: Get single post by slug
router.get('/:slug', async (req, res) => {
  try {
    const { data } = await supabase
      .from('blog_posts')
      .select('*')
      .eq('slug', req.params.slug)
      .eq('published', true)
      .single();
    if (!data) return res.status(404).json({ error: 'Post not found.' });
    res.json(data);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ADMIN: Get all posts (including drafts)
router.get('/admin/all', adminMiddleware, async (req, res) => {
  try {
    const { data } = await supabase
      .from('blog_posts')
      .select('*')
      .order('created_at', { ascending: false });
    res.json(data || []);
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

// ADMIN: Create post
router.post('/admin/post', adminMiddleware, async (req, res) => {
  try {
    const { title, slug, excerpt, content, tag, author, read_time, cover_image, published } = req.body;
    if (!title || !content) return res.status(400).json({ error: 'Title and content are required.' });
    const { data, error } = await supabase
      .from('blog_posts')
      .insert({
        title,
        slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        excerpt: excerpt || '',
        content,
        tag: tag || 'General',
        author: author || 'Drix Team',
        read_time: read_time || 5,
        cover_image: cover_image || null,
        published: published || false,
        created_at: new Date()
      })
      .select().single();
    if (error) throw error;
    res.json({ success: true, post: data });
  } catch(err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create post.' });
  }
});

// ADMIN: Update post
router.patch('/admin/post/:id', adminMiddleware, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('blog_posts')
      .update({ ...req.body, updated_at: new Date() })
      .eq('id', req.params.id)
      .select().single();
    if (error) throw error;
    res.json({ success: true, post: data });
  } catch(err) {
    res.status(500).json({ error: 'Failed to update post.' });
  }
});

// ADMIN: Delete post
router.delete('/admin/post/:id', adminMiddleware, async (req, res) => {
  try {
    await supabase.from('blog_posts').delete().eq('id', req.params.id);
    res.json({ success: true });
  } catch(err) {
    res.status(500).json({ error: 'Failed.' });
  }
});

module.exports = router;
