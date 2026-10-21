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

// Route for the new Quests/Earn ecosystem
app.get('/quests', (req, res) => {
    res.sendFile(__dirname + '/quests.html');
});

// --- AUTHENTICATION ---
app.post('/register', async (req, res) => {
    let { upi_id, name, pin, phone, dob, account_type } = req.body;
    try {
        if (!name || !pin || !phone || !dob) {
            return res.status(400).json({ success: false, error: "Please fill in all KYC details." });
        }

        // Clean & validate 10-digit phone number
        phone = String(phone).replace(/\D/g, '');
        if (phone.length < 10) {
            return res.status(400).json({ success: false, error: "Enter a valid 10-digit mobile number." });
        }

        // Anti-farming check: prevent multiple accounts with the same phone number
        const phoneCheck = await pool.query('SELECT upi_id FROM accounts WHERE phone = \$1', [phone]);
        if (phoneCheck.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                error: `This mobile number is already linked to account: ${phoneCheck.rows[0].upi_id}` 
            });
        }

        // Clean and ensure single @rpay suffix
        let cleanHandle = (upi_id || '').toLowerCase().trim();
        cleanHandle = cleanHandle.replace(/@rpay\$/, '').replace(/[^a-z0-9._]/g, '');

        if (!cleanHandle) {
            cleanHandle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!cleanHandle) cleanHandle = "user" + Math.floor(Math.random() * 9000 + 1000);
        }
        
        // Append exactly one @rpay
        cleanHandle = cleanHandle + '@rpay';

        // Check if chosen ID is already in the database
        const check = await pool.query('SELECT upi_id FROM accounts WHERE upi_id = \$1', [cleanHandle]);
        if (check.rows.length > 0) {
            const base = cleanHandle.replace('@rpay', '');
            const suggestions = [
                base + Math.floor(Math.random() * 100) + '@rpay',
                base + Math.floor(Math.random() * 1000) + '@rpay',
                base + (Math.floor(Math.random() * 9000) + 1000) + '@rpay'
            ];
            return res.json({ success: false, error: "ID taken", suggestions });
        }

        // Create account with K 500 bonus
        const accType = (account_type === 'MERCHANT') ? 'MERCHANT' : 'PERSONAL';
        await pool.query(
            `INSERT INTO accounts (upi_id, name, pin, balance, status, phone, dob, account_type) 
             VALUES ($1, $2, $3, 500, 'ACTIVE', $4, $5, $6)`,
            [cleanHandle, name.trim(), pin, phone, dob, accType]
        );

        res.json({ success: true, upi_id: cleanHandle });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message || "Registration failed." });
    }
});

app.post('/login', async (req, res) => {
    const { upi_id, pin } = req.body;
    const result = await pool.query('SELECT name, balance, upi_id, status FROM accounts WHERE lower(upi_id) = lower(\$1) AND pin = \$2', [upi_id, pin]);
    if (result.rows.length > 0) res.json({ success: true, user: result.rows[0] });
    else res.status(401).json({ success: false, error: "Invalid ID or PIN." });
});

app.post('/auth/change-pin', async (req, res) => {
    const { upi_id, old_pin, new_pin } = req.body;
    const result = await pool.query('UPDATE accounts SET pin = \$1 WHERE upi_id = \$2 AND pin = \$3 RETURNING *', [new_pin, upi_id, old_pin]);
    if (result.rows.length > 0) res.json({ success: true });
    else res.status(401).json({ success: false, error: "Incorrect Current PIN." });
});

// --- TRANSACTIONS & BALANCES ---
app.post('/pay', async (req, res) => {
    const { sender, receiver, pin, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');          
        if (globalMaintenanceMode) throw new Error("RPAY Network is currently under maintenance. Transfers are temporarily paused.");

        // 1. Check Sender Status
        const auth = await client.query('SELECT balance, status FROM accounts WHERE lower(upi_id) = lower(\$1) AND pin = \$2 FOR UPDATE', [sender, pin]);
        if (auth.rows.length === 0) throw new Error("Invalid PIN.");
        if (auth.rows[0].status === 'FROZEN') throw new Error("Your account is frozen.");
        // Anti-farming protection: maintain a minimum balance reserve of K 50
        if (auth.rows[0].balance - amount < 50) {
            throw new Error("A minimum balance of K 50.00 must remain in your account.");
        }

        // 2. Check Receiver Status
        const receiverCheck = await client.query('SELECT status FROM accounts WHERE lower(upi_id) = lower(\$1) FOR UPDATE', [receiver]);
        if (receiverCheck.rows.length === 0) throw new Error("Receiver does not exist.");
        if (receiverCheck.rows[0].status === 'FROZEN') throw new Error("Receiver account is currently frozen and cannot accept funds.");

        // 3. Process Transfer
        await client.query('UPDATE accounts SET balance = balance - \$1 WHERE lower(upi_id) = lower(\$2)', [amount, sender]);
        await client.query('UPDATE accounts SET balance = balance + \$1 WHERE lower(upi_id) = lower(\$2)', [amount, receiver]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES (\$1, \$2, \$3)', [sender, receiver, amount]);
        
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// Force Cache-Control so the Passbook never shows blank/old data
app.get('/history/:upi', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const result = await pool.query('SELECT * FROM transactions WHERE lower(sender) = lower(\$1) OR lower(receiver) = lower(\$1) ORDER BY created_at DESC', [req.params.upi]);
    res.json(result.rows);
});

app.get('/balance/:upi', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const result = await pool.query('SELECT balance FROM accounts WHERE lower(upi_id) = lower(\$1)', [req.params.upi]);
    if (result.rows.length > 0) {
        res.json(result.rows[0]);
    } else {
        res.status(404).json({ error: "User not found" });
    }
});

// --- GLOBAL NETWORK DIRECTORY ---
app.get('/directory/:upi', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const result = await pool.query(
        'SELECT name, upi_id FROM accounts WHERE upi_id != \$1 AND upi_id != \'Boss0\' ORDER BY name ASC',
        [req.params.upi]
    );
    res.json(result.rows);
});

// --- SYSTEM NOTICES ---
app.get('/notices/active', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache');
    const result = await pool.query('SELECT message FROM system_notices WHERE is_active = TRUE LIMIT 1');
    res.json(result.rows[0] || { message: null });
});

// ==========================================
// UPGRADED ADMIN / BOSS0 ENDPOINTS
// ==========================================
let globalMaintenanceMode = false;
const MASTER_SECRET = process.env.ADMIN_MASTER_SECRET || 'Rpay-master-55';

async function verifyBoss(admin_id, admin_pin, requireSecret = false, master_secret = '') {
    if (admin_id !== 'Boss0') return { ok: false, error: 'Unauthorized user.' };
    const res = await pool.query('SELECT pin FROM accounts WHERE upi_id = \$1', ['Boss0']);
    if (res.rows.length === 0 || res.rows[0].pin !== admin_pin) {
        return { ok: false, error: 'Invalid Admin Password.' };
    }
    if (requireSecret && master_secret !== MASTER_SECRET) {
        return { ok: false, error: 'Invalid Master Secret Key!' };
    }
    return { ok: true };
}

app.post('/admin/users', async (req, res) => {
    const { admin_id, admin_pin } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    try {
        const result = await pool.query('SELECT upi_id, name, balance, COALESCE(reward_balance, 0) AS reward_balance, status FROM accounts ORDER BY balance DESC');
        const stats = await pool.query(`
            SELECT 
                COUNT(*)::int AS total_accounts,
                COALESCE(SUM(balance), 0)::float AS total_circulation,
                COALESCE(SUM(reward_balance), 0)::float AS total_rewards
            FROM accounts WHERE upi_id != 'Boss0'
        `);
        res.json({ 
            success: true, 
            data: result.rows,
            analytics: stats.rows[0],
            maintenance: globalMaintenanceMode
        });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/admin/maintenance', async (req, res) => {
    const { admin_id, admin_pin, master_secret, enable } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    globalMaintenanceMode = Boolean(enable);
    res.json({ success: true, maintenance: globalMaintenanceMode });
});

app.post('/admin/broadcast', async (req, res) => {
    const { admin_id, admin_pin, message } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    await pool.query('UPDATE system_notices SET is_active = FALSE');
    if (message) await pool.query('INSERT INTO system_notices (message, is_active) VALUES ($1, TRUE)', [message]);
    res.json({ success: true });
});

app.post('/admin/adjust', async (req, res) => {
    const { admin_id, admin_pin, master_secret, target_id, amount, action } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    try {
        const target = target_id.trim();
        let result;
        if (action === 'add') result = await pool.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2 RETURNING *', [amount, target]);
        if (action === 'deduct') result = await pool.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2 RETURNING *', [amount, target]);
        if (action === 'freeze') result = await pool.query('UPDATE accounts SET status = $1 WHERE upi_id = $2 RETURNING *', ['FROZEN', target]);
        if (action === 'unfreeze') result = await pool.query('UPDATE accounts SET status = $1 WHERE upi_id = $2 RETURNING *', ['ACTIVE', target]);

        if (result && result.rowCount === 0) {
            return res.status(400).json({ success: false, error: "Target not found. Did you type the full @rpay handle?" });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/admin/delete', async (req, res) => {
    const { admin_id, admin_pin, master_secret, target_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    await pool.query('DELETE FROM accounts WHERE upi_id = $1', [target_id.trim()]);
    await pool.query('DELETE FROM transactions WHERE sender = $1 OR receiver = $1', [target_id.trim()]);
    res.json({ success: true });
});

app.post('/admin/transactions', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    let result = target_id
        ? await pool.query('SELECT * FROM transactions WHERE sender = $1 OR receiver = $1 ORDER BY created_at DESC LIMIT 50', [target_id.trim()])
        : await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: result.rows });
});

app.post('/admin/clawback', async (req, res) => {
    const { admin_id, admin_pin, master_secret, tx_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txQuery = await client.query('SELECT * FROM transactions WHERE id = $1 FOR UPDATE', [tx_id]);
        if (txQuery.rows.length === 0) throw new Error("Transaction not found or already reversed.");

        const tx = txQuery.rows[0];
        const amt = parseFloat(tx.amount);

        await client.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2', [amt, tx.receiver]);
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2', [amt, tx.sender]);
        await client.query('DELETE FROM transactions WHERE id = $1', [tx_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.listen(process.env.PORT || 3000, () => console.log('API live'));