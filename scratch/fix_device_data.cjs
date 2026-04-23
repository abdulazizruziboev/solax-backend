const Database = require('better-sqlite3');
const db = new Database('./solax_data.sqlite');

async function fixData() {
  console.log('Populating new columns from daily_stats...');
  
  const devices = db.prepare('SELECT registrationNo FROM devices').all();
  const now = new Date().toISOString().slice(0, 10);
  const month = now.slice(0, 7);
  const year = now.slice(0, 4) + '-%';

  for (const device of devices) {
    const regNo = device.registrationNo;
    
    // Today
    const todayStats = db.prepare('SELECT yieldToday, yieldTotal, acPower FROM daily_stats WHERE registrationNo = ? AND date = ?').get(regNo, now);
    
    // Month
    const monthStats = db.prepare('SELECT SUM(yieldToday) as total FROM daily_stats WHERE registrationNo = ? AND date LIKE ?').get(regNo, month + '-%');
    
    // Year
    const yearStats = db.prepare('SELECT SUM(yieldToday) as total FROM daily_stats WHERE registrationNo = ? AND date LIKE ?').get(regNo, year);

    db.prepare(`
      UPDATE devices 
      SET 
        yieldToday = ?, 
        yieldTotal = ?,
        acPower = ?,
        yieldMonth = ?,
        yieldYear = ?,
        realtimeUpdatedAt = CURRENT_TIMESTAMP
      WHERE registrationNo = ?
    `).run(
      todayStats?.yieldToday || 0,
      todayStats?.yieldTotal || 0,
      todayStats?.acPower || 0,
      monthStats?.total || 0,
      yearStats?.total || 0,
      regNo
    );
  }
  
  console.log('Data migration complete for', devices.length, 'devices.');
}

fixData().catch(console.error);
