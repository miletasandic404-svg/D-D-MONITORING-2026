const fs = require('fs');
const path = require('path');

// Load .env file manually
function loadEnv(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2].trim();
      // Remove surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
}

// Load production env
loadEnv('C:/Users/Korisnik/Desktop/D-D-MONITORING-2026/.env.production.local');

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
  ];
  
  console.log('Starting migrations...');
  console.log('DATABASE_URL set:', process.env.DATABASE_URL ? 'YES' : 'NO');
  
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
    
    // Check indexes
    const facesIndexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'known_faces'");
    const platesIndexes = await db.query("SELECT indexname FROM pg_indexes WHERE tablename = 'known_plates'");
    
    console.log('\n=== Indexes on known_faces ===');
    facesIndexes.rows.forEach(r => console.log('  -', r.indexname));
    
    console.log('\n=== Indexes on known_plates ===');
    platesIndexes.rows.forEach(r => console.log('  -', r.indexname));
    
  } catch (err) {
    console.error('Verification failed:', err.message);
  }
  
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
