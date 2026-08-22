const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');
const dataDir = process.env.CLAWOPT_DATA_DIR || '.clawopt';
const dbPath = path.join(os.homedir(), dataDir, 'clawopt.sqlite');

try {
  const db = new Database(dbPath);
  
  // Check for both legacy numeric ID and 'main' as session ID
  const legacyId = '5741707482';
  const legacySession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(legacyId);
  const mainAsSessionId = db.prepare('SELECT * FROM sessions WHERE id = ?').get('main');
  
  if (legacySession || mainAsSessionId) {
    const oldId = legacySession ? legacyId : 'main';
    const newId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    
    db.prepare("UPDATE sessions SET id = ?, name = '综合管家', agentId = 'main' WHERE id = ?").run(newId, oldId);
    
    // Update related tables. Note: column name in chat_messages is session_key
    try {
      db.prepare("UPDATE chat_messages SET session_key = ? WHERE session_key = ?").run(newId, oldId);
    } catch (e) { console.log("Note: chat_messages update failed or column mismatch", e.message); }
    
    try {
      db.prepare("UPDATE files SET session_key = ? WHERE session_key = ?").run(newId, oldId);
    } catch (e) { console.log("Note: files update failed or column mismatch", e.message); }
    
    console.log(`Migration successful: session ${oldId} updated to random id ${newId}`);
  } else {
    // maybe it already exists with a random ID, let's just make sure the name is right for the main agent
    const mainAgent = db.prepare('SELECT * FROM sessions WHERE agentId = ?').get('main');
    if (mainAgent) {
      db.prepare("UPDATE sessions SET name = '综合管家' WHERE agentId = 'main'").run();
      console.log("Updated main agent session name to '综合管家'");
    } else {
        console.log("No main agent found. Creating default...");
        const now = Date.now();
        const randId = Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
        db.prepare(`
          INSERT INTO sessions (id, name, agentId, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(randId, '综合管家', 'main', 0, now, now);
        console.log("Created default 'main' agent session.");
    }
  }
} catch (e) {
  console.error("Failed to migrate database:", e);
}
