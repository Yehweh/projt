require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const bcrypt = require('bcrypt');

const app = express();
app.use(cors());
app.use(express.json());

app.use(express.static(path.join(__dirname, '../frontend')));

let db;

// Initialize Database connection and tables
async function initDB() {
  db = await open({
    filename: './turf.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS Users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS Turfs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      meta TEXT NOT NULL,
      basePrice INTEGER NOT NULL,
      panoramaUrl TEXT
    );
    CREATE TABLE IF NOT EXISTS Bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turf_id INTEGER,
      user_name TEXT,
      user_phone TEXT,
      sport_type TEXT,
      booking_date DATE,
      slot_hour INTEGER
    );
    CREATE TABLE IF NOT EXISTS BlockedSlots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turf_id INTEGER,
      blocked_date DATE,
      slot_hour INTEGER,
      UNIQUE(turf_id, blocked_date, slot_hour)
    );
    CREATE TABLE IF NOT EXISTS TeamOpenings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turf_id INTEGER,
      sport TEXT,
      seats INTEGER,
      team_size INTEGER,
      fare INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed turfs if none exist
  const count = await db.get('SELECT COUNT(*) as count FROM Turfs');
  if (count.count === 0) {
    await db.exec(`
      INSERT INTO Turfs (id, name, meta, basePrice, panoramaUrl) VALUES 
      (1, 'GreenLine Arena', 'Velachery • Football, Cricket', 1200, 'turf1-360.jpg'),
      (2, 'Boundary Line Turf', 'Tambaram • Cricket box', 800, 'turf2-360.jpg'),
      (3, 'SkyLine Sports Hub', 'OMR • Multi-sport', 1000, 'turf3-360.jpg');
    `);
    console.log("Seeded database with initial turf data.");
  }

  // Seed default user if none exist so your friend can log in
  const userCount = await db.get('SELECT COUNT(*) as count FROM Users');
  if (userCount.count === 0) {
    const defaultPassword = await bcrypt.hash('password123', 10);
    await db.run(
      'INSERT INTO Users (name, email, phone, password) VALUES (?, ?, ?, ?)',
      ['Test User', 'test@turf.com', '9999999999', defaultPassword]
    );
    console.log("Seeded default user: test@turf.com / password123");
  }
}

initDB().catch(console.error);

// --- AUTHENTICATION ROUTES ---

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, phone, password } = req.body;
    if (!name || !email || !phone || !password) return res.status(400).json({ error: 'All fields are required' });

    const hashedPassword = await bcrypt.hash(password, 10);
    
    await db.run(
      'INSERT INTO Users (name, email, phone, password) VALUES (?, ?, ?, ?)',
      [name, email, phone, hashedPassword]
    );
    
    // Auto-login after registration
    res.json({ message: 'Registration successful', user: { name, email, phone } });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Email already exists' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const user = await db.get('SELECT * FROM Users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });

    // Format joinedDate
    const joinedDate = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric' }).format(new Date(user.created_at + "Z"));

    res.json({
      message: 'Login successful',
      user: { name: user.name, email: user.email, phone: user.phone, joinedDate: joinedDate }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API ROUTES ---

app.get('/api/turfs', async (req, res) => {
  try {
    const rows = await db.all('SELECT id, name, meta, basePrice, panoramaUrl FROM Turfs');
    const turfData = {};
    rows.forEach(turf => {
      turfData[turf.id] = {
        id: turf.id,
        name: turf.name,
        meta: turf.meta,
        basePrice: turf.basePrice,
        panoramaUrl: turf.panoramaUrl
      };
    });
    res.json(turfData);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/bookings', async (req, res) => {
  try {
    const date = req.query.date;
    const rows = await db.all('SELECT turf_id, slot_hour FROM Bookings WHERE booking_date = ?', [date]);
    
    const bookings = {};
    rows.forEach(row => {
      if (!bookings[row.turf_id]) bookings[row.turf_id] = [];
      bookings[row.turf_id].push(row.slot_hour);
    });
    res.json(bookings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/user/bookings/:phone', async (req, res) => {
  try {
    const phone = req.params.phone;
    const query = `
      SELECT 
        b.booking_date, 
        b.slot_hour, 
        t.name as turf_name, 
        t.basePrice 
      FROM Bookings b
      JOIN Turfs t ON b.turf_id = t.id
      WHERE b.user_phone = ?
      ORDER BY b.booking_date DESC, b.slot_hour DESC
    `;
    const rows = await db.all(query, [phone]);

    // Format output for frontend
    const history = rows.map(r => {
      // 12 hour format logic
      const h = r.slot_hour;
      const ampm = h >= 12 ? 'PM' : 'AM';
      const hr = h % 12 || 12;
      const nextH = (h + 1) % 12 || 12;
      const nextAmpm = (h + 1) >= 12 && (h + 1) < 24 ? 'PM' : 'AM';
      
      const timeStr = `${hr}:00 ${ampm} – ${nextH}:00 ${nextAmpm}`;

      return {
        turf: r.turf_name,
        date: r.booking_date,
        time: timeStr,
        price: "₹" + r.basePrice,
        status: "Confirmed" // For this demo, all booked slots are confirmed
      };
    });

    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bookings', async (req, res) => {
  try {
    const { turfId, userName, userPhone, sportType, date, selectedSlots } = req.body;

    if (!selectedSlots || selectedSlots.length === 0) {
      return res.status(400).json({ error: 'No slots selected' });
    }

    await db.exec('BEGIN TRANSACTION');
    const stmt = await db.prepare('INSERT INTO Bookings (turf_id, user_name, user_phone, sport_type, booking_date, slot_hour) VALUES (?, ?, ?, ?, ?, ?)');
    
    for (const slot of selectedSlots) {
      await stmt.run([turfId, userName, userPhone, sportType, date, slot]);
    }
    
    await stmt.finalize();
    await db.exec('COMMIT');

    res.json({ message: 'Booking confirmed successfully!' });
  } catch (err) {
    await db.exec('ROLLBACK');
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// --- ADMIN ROUTES FOR BLOCKED SLOTS ---

app.get('/api/blocked-slots', async (req, res) => {
  try {
    const date = req.query.date;
    const rows = await db.all('SELECT turf_id, slot_hour FROM BlockedSlots WHERE blocked_date = ?', [date]);
    
    const blocked = {};
    rows.forEach(row => {
      if (!blocked[row.turf_id]) blocked[row.turf_id] = [];
      blocked[row.turf_id].push(row.slot_hour);
    });
    res.json(blocked);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blocked-slots', async (req, res) => {
  try {
    const { turfId, date, slotHour } = req.body;
    await db.run('INSERT INTO BlockedSlots (turf_id, blocked_date, slot_hour) VALUES (?, ?, ?)', [turfId, date, slotHour]);
    res.json({ message: 'Slot blocked successfully!' });
  } catch (err) {
    if (err.message.includes('UNIQUE constraint failed')) {
      return res.json({ message: 'Already blocked' });
    }
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/blocked-slots', async (req, res) => {
  try {
    const { turfId, date, slotHour } = req.body;
    await db.run('DELETE FROM BlockedSlots WHERE turf_id = ? AND blocked_date = ? AND slot_hour = ?', [turfId, date, slotHour]);
    res.json({ message: 'Slot unblocked successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- TEAM OPENINGS ROUTES ---

app.get('/api/openings', async (req, res) => {
  try {
    const rows = await db.all('SELECT id, turf_id, sport, seats, team_size as teamSize, fare FROM TeamOpenings ORDER BY created_at DESC');
    
    const openings = {};
    rows.forEach(row => {
      if (!openings[row.turf_id]) openings[row.turf_id] = [];
      openings[row.turf_id].push({
        id: row.id,
        sport: row.sport,
        seats: row.seats,
        teamSize: row.teamSize,
        fare: row.fare
      });
    });
    res.json(openings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/openings', async (req, res) => {
  try {
    const { turfId, sport, seats, teamSize, fare } = req.body;
    await db.run('INSERT INTO TeamOpenings (turf_id, sport, seats, team_size, fare) VALUES (?, ?, ?, ?, ?)', [turfId, sport, seats, teamSize, fare]);
    res.json({ message: 'Team opening posted successfully!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = 5000;
app.listen(PORT, () => {
  console.log(`SQLite Backend Server is running on http://localhost:${PORT}`);
});
