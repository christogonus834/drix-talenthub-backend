// seed-admin.js
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const admins = [
  {
    full_name: 'Super Admin',
    email: 'admin@drixtechtalent.com',
    password: 'Admin@Drix2025',
    role: 'super_admin',
  },
  // Add more admins below if needed:
  // {
  //   full_name: 'Moderator One',
  //   email: 'mod@drixtechtalent.com',
  //   password: 'SomePassword123',
  //   role: 'moderator',
  // },
];

async function seedAdmins() {
  console.log('🌱 Seeding admin accounts...\n');

  for (const admin of admins) {
    const password_hash = await bcrypt.hash(admin.password, 12);

    const { data, error } = await supabase
      .from('admins')
      .upsert(
        {
          full_name: admin.full_name,
          email: admin.email,
          password_hash,
          role: admin.role,
          is_active: true,
        },
        { onConflict: 'email' }
      )
      .select();

    if (error) {
      console.error(`❌ Failed to seed ${admin.email}:`, error.message);
    } else {
      console.log(`✅ Seeded: ${admin.email} (${admin.role})`);
    }
  }

  console.log('\n✅ Done seeding admins.');
  process.exit(0);
}

seedAdmins();