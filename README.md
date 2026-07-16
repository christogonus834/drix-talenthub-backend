# Drix Tech Talent — Backend API

Node.js + Express + Supabase

## Deploy to Render
1. Push `backend/` folder to its own GitHub repo
2. Create Web Service on Render
3. Set Root Directory: `.` (since this IS the root)
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Add environment variables:
   - SUPABASE_URL
   - SUPABASE_SERVICE_KEY
   - JWT_SECRET
   - FRONTEND_URL (your Vercel URL e.g. https://drix-tech-talent.vercel.app)
   - NODE_ENV=production

## Local dev
```bash
cp .env.example .env
npm install
npm run dev
```
