const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- AUTHENTICATION ---
app.post('/register', async (req, res) => {
    const { upi_id, name, pin } = req.body;
    try {
        // 1. Check if the UPI ID is already taken
        const check = await pool.query('SELECT upi_id FROM accounts WHERE upi_id = $1', [upi_id]);
        
        if (check.rows.length > 0) {
            // 2. Generate 3 unique suggestions if taken
            const base = upi_id.replace('@rpay', '');
            const suggestions = [
                base + Math.floor(Math.random() * 100) + '@rpay',
                base + Math.floor(Math.random() * 1000) + '@rpay',
                base + (Math.floor(Math.random() * 9000) + 1000) + '@rpay' // 4 digit number
            ];
            return res.json({ success: false, error: "ID taken", suggestions });
        }

        // 3. If available, create the account
        await pool.query('INSERT INTO accounts (upi_id, name, pin, balance, status) VALUES ($1, $2, $3, 10000, \'ACTIVE\')', [upi_id, name, pin]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: "Registration failed or invalid format." });
    }
});


app.post('/login', async (req, res) => {
    const { upi_id, pin } = req.body;
    const result = await pool.query('SELECT name, balance, upi_id, status FROM accounts WHERE upi_id = $1 AND pin = $2', [upi_id, pin]);
    if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
    else res.status(401).json({ success: false, error: "Invalid ID or PIN." });
});

app.post('/auth/change-pin', async (req, res) => {
    const { upi_id, old_pin, new_pin } = req.body;
    const result = await pool.query('UPDATE accounts SET pin = $1 WHERE upi_id = $2 AND pin = $3 RETURNING *', [new_pin, upi_id, old_pin]);
    if (result.rows.length > 0) res.json({ success: true });
    else res.status(401).json({ success: false, error: "Incorrect Current PIN." });
});

// --- TRANSACTIONS & BALANCES ---
app.post('/pay', async (req, res) => {
    const { sender, receiver, pin, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        
        // 1. Check Sender Status
        const auth = await client.query('SELECT balance, status FROM accounts WHERE upi_id = $1 AND pin = $2', [sender, pin]);
        if (auth.rows.length === 0) throw new Error("Invalid PIN.");
        if (auth.rows[0].status === 'FROZEN') throw new Error("Your account is frozen.");
        if (auth.rows[0].balance < amount) throw new Error("Insufficient Funds.");
        
        // 2. Check Receiver Status
        const receiverCheck = await client.query('SELECT status FROM accounts WHERE upi_id = $1', [receiver]);
        if (receiverCheck.rows.length === 0) throw new Error("Receiver does not exist.");
        if (receiverCheck.rows[0].status === 'FROZEN') throw new Error("Receiver account is currently frozen and cannot accept funds.");
        
        // 3. Process Transfer
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2', [amount, sender]);
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2', [amount, receiver]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, $3)', [sender, receiver, amount]);
                // Auto-insert payment into chat history
        await client.query('INSERT INTO messages (sender, receiver, content, type) VALUES ($1, $2, $3, \'TRANSACTION\')', [sender, receiver, `₹${parseFloat(amount).toFixed(2)}`]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});


app.get('/history/:upi', async (req, res) => {
    const result = await pool.query('SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY created_at DESC', [req.params.upi]);
    res.json(result.rows);
});

app.get('/balance/:upi', async (req, res) => {
    const result = await pool.query('SELECT balance FROM accounts WHERE upi_id = $1', [req.params.upi]);
    res.json(result.rows[0]);
});

// --- GLOBAL NETWORK DIRECTORY ---
app.get('/directory/:upi', async (req, res) => {
    // Fetch all active users to display in the search list (excludes Boss0 and the user themselves)
    const result = await pool.query(
        'SELECT name, upi_id FROM accounts WHERE upi_id != $1 AND upi_id != \'Boss0\' ORDER BY name ASC', 
        [req.params.upi]
    );
    res.json(result.rows);
});

// --- SYSTEM NOTICES ---
app.get('/notices/active', async (req, res) => {
    const result = await pool.query('SELECT message FROM system_notices WHERE is_active = TRUE LIMIT 1');
    res.json(result.rows[0] || { message: null });
});

// ==========================================
// ADMIN / BOSS0 ENDPOINTS
// ==========================================
app.post('/admin/users', async (req, res) => {
    const { admin_id, admin_pin } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false });
    const result = await pool.query('SELECT upi_id, name, balance, status FROM accounts ORDER BY balance DESC');
    res.json({ success: true, data: result.rows });
});

app.post('/admin/broadcast', async (req, res) => {
    const { admin_id, admin_pin, message } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false });
    
    await pool.query('UPDATE system_notices SET is_active = FALSE');
    if (message) await pool.query('INSERT INTO system_notices (message, is_active) VALUES ($1, TRUE)', [message]);
    res.json({ success: true });
});

app.post('/admin/adjust', async (req, res) => {
    const { admin_id, admin_pin, target_id, amount, action } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false });
    
    try {
        const target = target_id.trim(); // Cleans up accidental spaces
        let result;
        
        // Using RETURNING * lets us check if a row was actually found and updated
        if (action === 'add') result = await pool.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2 RETURNING *', [amount, target]);
        if (action === 'deduct') result = await pool.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2 RETURNING *', [amount, target]);
        if (action === 'freeze') result = await pool.query('UPDATE accounts SET status = $1 WHERE upi_id = $2 RETURNING *', ['FROZEN', target]);
        if (action === 'unfreeze') result = await pool.query('UPDATE accounts SET status = $1 WHERE upi_id = $2 RETURNING *', ['ACTIVE', target]);
        
        // If 0 rows were updated, the ID was typed wrong
        if (result && result.rowCount === 0) {
            return res.status(400).json({ success: false, error: "Target not found. Did you type the full @rpay handle?" });
        }
        
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});


app.post('/admin/delete', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false });
    
    await pool.query('DELETE FROM accounts WHERE upi_id = $1', [target_id]);
    await pool.query('DELETE FROM transactions WHERE sender = $1 OR receiver = $1', [target_id]);
    res.json({ success: true });
});

app.post('/admin/transactions', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false });
    
    let result = target_id 
        ? await pool.query('SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY created_at DESC', [target_id])
        : await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: result.rows });
});

// --- SECURE CHAT LOGIC ---
app.post('/messages/history', async (req, res) => {
    const { user_id, pin, target_id } = req.body;
    try {
        // Authenticate request to prevent unauthorized reading
        const auth = await pool.query('SELECT status FROM accounts WHERE upi_id = $1 AND pin = $2', [user_id, pin]);
        if (auth.rows.length === 0) throw new Error("Unauthorized");
        
        const result = await pool.query(`
            SELECT sender, content, type, created_at FROM messages 
            WHERE (sender = $1 AND receiver = $2) OR (sender = $2 AND receiver = $1)
            ORDER BY created_at ASC
        `, [user_id, target_id]);
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(401).json({ success: false, error: e.message });
    }
});

app.post('/messages/send', async (req, res) => {
    const { sender, pin, receiver, content } = req.body;
    try {
        const auth = await pool.query('SELECT status FROM accounts WHERE upi_id = $1 AND pin = $2', [sender, pin]);
        if (auth.rows.length === 0) throw new Error("Unauthorized");
        if (auth.rows[0].status === 'FROZEN') throw new Error("Account frozen.");

        await pool.query('INSERT INTO messages (sender, receiver, content, type) VALUES ($1, $2, $3, \'TEXT\')', [sender, receiver, content]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});


app.listen(process.env.PORT || 3000, () => console.log('API live'));
