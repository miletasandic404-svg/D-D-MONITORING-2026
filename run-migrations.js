const fs = require('fs');
const path = require('path');
const db = require('./db/index');

async function runMigration(filePath) {
  const sql = fs.readFileSync(filePath, 'utf8');
  const fileName = path.basename(filePath);
  
  console.log(`\n=== Running migration: ${fileName} ===`);
  
  try {
    await db.query(sql);
    console.log(`✅ Migration ${fileName} completed successfully`);
    return true;
  } catch (err) {
    console.error(`❌ Migration ${fileName} failed:`, err.message);
    return false;
  }
}

async function main() {
  const migrations = [
    './db/migrations/043_known_faces.sql',
    './db/migrations/044_known_plates.sql',
    './db/migrations/045_emergency_contacts.sql',
  ];
  
  console.log('Starting migrations...');
  console.log('DATABASE_URL:', process.env.DATABASE_URL ? 'SET' : 'NOT SET');
  
  for (const migration of migrations) {
    const success = await runMigration(migration);
    if (!success) {
      console.log('\nStopping due to migration failure.');
      process.exit(1);
    }
  }
  
  console.log('\n=== All migrations completed ===');
  
  // Verify tables exist
  try {
    const facesResult = await db.query("SELECT to_regclass('public.known_faces') as exists");
    const platesResult = await db.query("SELECT to_regclass('public.known_plates') as exists");
    
    console.log('\n=== Verification ===');
    console.log('known_faces table:', facesResult.rows[0].exists ? 'EXISTS ✅' : 'MISSING ❌');
    console.log('known_plates table:', platesResult.rows[0].exists ? 'EXISTS ✅' : 'MISSING ❌');
  } catch (err) {
    console.error('Verification failed:', err.message);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
