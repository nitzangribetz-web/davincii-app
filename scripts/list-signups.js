const pool = require('../db/pool');

pool.query('SELECT id, email, name, email_verified, created_at FROM artists ORDER BY created_at DESC')
  .then(r => {
    if (r.rows.length === 0) {
      console.log('No signups yet.');
    } else {
      console.log(`\n${r.rows.length} signed-up artist(s):\n`);
      console.table(r.rows.map(a => ({
        id: a.id,
        email: a.email,
        name: a.name,
        verified: a.email_verified ? 'Yes' : 'No',
        signed_up: new Date(a.created_at).toLocaleString()
      })));
    }
    process.exit(0);
  })
  .catch(e => {
    console.error('Query failed:', e.message);
    process.exit(1);
  });
