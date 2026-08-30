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

// Create Account
app.post('/register', async (req, res) => {
    const { upi_id, name, pin } = req.body;
    try {
        await pool.query('INSERT INTO accounts (upi_id, name, pin, balance) VALUES ($1, $2, $3, 10000)', [upi_id, name, pin]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: "UPI ID already exists." });
    }
});

// Secure Login
app.post('/login', async (req, res) => {
    const { upi_id, pin } = req.body;
    const result = await pool.query('SELECT name, balance, upi_id FROM accounts WHERE upi_id = $1 AND pin = $2', [upi_id, pin]);
    if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
    else res.status(401).json({ success: false, error: "Invalid ID or PIN." });
});

// Standard User Payment
app.post('/pay', async (req, res) => {
    const { sender, receiver, pin, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const auth = await client.query('SELECT balance FROM accounts WHERE upi_id = $1 AND pin = $2', [sender, pin]);
        if (auth.rows.length === 0 || auth.rows[0].balance < amount) throw new Error("Invalid PIN or Insufficient Funds.");
        
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2', [amount, sender]);
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2', [amount, receiver]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, $3)', [sender, receiver, amount]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// Fetch Standard Ledger & Balance
app.get('/history/:upi', async (req, res) => {
    const result = await pool.query('SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY created_at DESC', [req.params.upi]);
    res.json(result.rows);
});
app.get('/balance/:upi', async (req, res) => {
    const result = await pool.query('SELECT balance FROM accounts WHERE upi_id = $1', [req.params.upi]);
    res.json(result.rows[0]);
});

// ==========================================
// ADMIN / OWNER ENDPOINTS
// ==========================================
app.post('/admin/adjust', async (req, res) => {
    const { admin_id, admin_pin, target_id, amount, action } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false, error: "Unauthorized" });
    
    try {
        if (action === 'add') {
            await pool.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2', [amount, target_id]);
        } else if (action === 'deduct') {
            await pool.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2', [amount, target_id]);
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: "Account not found." });
    }
});

app.post('/admin/delete', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false, error: "Unauthorized" });
    
    try {
        await pool.query('DELETE FROM accounts WHERE upi_id = $1', [target_id]);
        await pool.query('DELETE FROM transactions WHERE sender = $1 OR receiver = $1', [target_id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: "Error deleting account." });
    }
});

app.post('/admin/transactions', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    if (admin_id !== 'Boss0' || admin_pin !== '5555') return res.status(401).json({ success: false, error: "Unauthorized" });
    
    try {
        let result;
        if (target_id) {
            result = await pool.query('SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY created_at DESC', [target_id]);
        } else {
            result = await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
        }
        res.json({ success: true, data: result.rows });
    } catch (e) {
        res.status(400).json({ success: false, error: "Error fetching data." });
    }
});

app.listen(process.env.PORT || 3000, () => console.log('API live'));
