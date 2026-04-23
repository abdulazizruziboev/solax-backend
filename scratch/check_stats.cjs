const Database = require('better-sqlite3');
const path = require('path');
// Path relative to backend root
const dbPath = 'C:\\Users\\teleg\\Desktop\\solax-backend\\solax_data.sqlite';
const db = new Database(dbPath);
try {
  const rows = db.prepare("SELECT onlineStatus, COUNT(*) as count FROM devices GROUP BY onlineStatus").all();
  console.log('STATUS DISTRIBUTION:');
  console.log(JSON.stringify(rows, null, 2));
  
  const samples = db.prepare("SELECT registrationNo, onlineStatus FROM devices LIMIT 10").all();
  console.log('\nSAMPLES:');
  console.log(JSON.stringify(samples, null, 2));
} catch (e) {
  console.error(e);
}
db.close();
