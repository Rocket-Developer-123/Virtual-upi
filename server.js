const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

let globalMaintenanceMode = false;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'KINEX_MASTER_2026';

// Initialize Database Tables & Boss0 Master Account on Startup
async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS accounts (
                upi_id VARCHAR(100) PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                pin VARCHAR(100) NOT NULL,
                balance FLOAT DEFAULT 500,
                reward_balance FLOAT DEFAULT 0,
                status VARCHAR(30) DEFAULT 'ACTIVE',
                phone VARCHAR(20),
                dob VARCHAR(30),
                account_type VARCHAR(30) DEFAULT 'PERSONAL'
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS transactions (
                id SERIAL PRIMARY KEY,
                sender VARCHAR(100) NOT NULL,
                receiver VARCHAR(100) NOT NULL,
                amount FLOAT NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            INSERT INTO accounts (upi_id, name, pin, balance, reward_balance, status, phone, dob, account_type)
            VALUES ('Boss0', 'System Operator', 'Kinex_Admin_2026!', 1000000, 0, 'ACTIVE', '0000000000', '2000-01-01', 'MERCHANT')
            ON CONFLICT (upi_id) DO NOTHING;
        `);
        console.log('Kinex PostgreSQL Ledger Ready.');
    } catch (e) {
        console.error('Database initialization warning:', e.message);
    }
}
initDatabase();

// PWA Files
app.get('/manifest.json', function(req, res) { res.sendFile(path.join(__dirname, 'manifest.json')); });
app.get('/sw.js', function(req, res) { res.sendFile(path.join(__dirname, 'sw.js')); });
app.get('/icon-192.png', function(req, res) { res.sendFile(path.join(__dirname, 'icon-192.png')); });
app.get('/icon-512.png', function(req, res) { res.sendFile(path.join(__dirname, 'icon-512.png')); });

// 1. REGISTER ROUTE (Fixes @rpay@rpay bug, checks duplicates, credits K 500 bonus into Passbook)
app.post('/register', async function(req, res) {
    const body = req.body || {};
    const upi_id = body.upi_id;
    const name = String(body.name || '').trim();
    const pin = String(body.pin || '').trim();
    const phone = String(body.phone || '').replace(/\D/g, '');
    const dob = String(body.dob || '2005-01-01').trim();
    const account_type = String(body.account_type || 'PERSONAL').toUpperCase();

    try {
        let cleanHandle = String(upi_id || '').toLowerCase().trim();
        cleanHandle = cleanHandle.replace(/@rpay$/i, '').replace(/[^a-z0-9._]/g, '');

        if (!cleanHandle) {
            cleanHandle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!cleanHandle) cleanHandle = 'user' + Math.floor(Math.random() * 9000 + 1000);
        }
        cleanHandle = cleanHandle + '@rpay';

        // Check if handle already exists
        const check = await pool.query('SELECT upi_id FROM accounts WHERE LOWER(upi_id) = $1', [cleanHandle]);
        if (check.rows.length > 0) {
            const base = cleanHandle.replace('@rpay', '');
            const suggestions = [
                base + Math.floor(Math.random() * 90 + 10) + '@rpay',
                base + Math.floor(Math.random() * 900 + 100) + '@rpay',
                base + (Math.floor(Math.random() * 9000) + 1000) + '@rpay'
            ];
            return res.json({ success: false, error: 'ID taken', suggestions: suggestions });
        }

        // Check duplicate mobile number
        if (phone) {
            const phoneCheck = await pool.query('SELECT upi_id FROM accounts WHERE phone = $1 AND LOWER(upi_id) != $2', [phone, 'boss0']);
            if (phoneCheck.rows.length > 0) {
                return res.status(400).json({
                    success: false,
                    error: 'Mobile number already registered to ' + phoneCheck.rows[0].upi_id
                });
            }
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                'INSERT INTO accounts (upi_id, name, pin, balance, reward_balance, status, phone, dob, account_type) VALUES ($1, $2, $3, 500, 0, $4, $5, $6, $7)',
                [cleanHandle, name, pin, 'ACTIVE', phone, dob, account_type]
            );
            await client.query(
                'INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, 500)',
                ['system@rpay', cleanHandle]
            );
            await client.query('COMMIT');
            res.json({ success: true, upi_id: cleanHandle });
        } catch (txErr) {
            await client.query('ROLLBACK');
            throw txErr;
        } finally {
            client.release();
        }
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 2. LOGIN ROUTE
app.post('/login', async function(req, res) {
    const body = req.body || {};
    const rawId = String(body.upi_id || '').trim();
    const pin = String(body.pin || '');

    try {
        const result = await pool.query(
            'SELECT upi_id, name, balance, status, account_type FROM accounts WHERE LOWER(upi_id) = LOWER($1) AND pin = $2',
            [rawId, pin]
        );
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, error: 'Invalid Kinex ID or PIN' });
        }
        const user = result.rows[0];
        if (user.status === 'FROZEN' && user.upi_id !== 'Boss0') {
            return res.status(403).json({ success: false, error: 'Account is frozen for security investigation' });
        }
        res.json({
            success: true,
            upi_id: user.upi_id,
            name: user.name,
            balance: parseFloat(user.balance),
            status: user.status,
            account_type: user.account_type || 'PERSONAL'
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. LIVE BALANCE ROUTE (No-Cache for Instant Receiver Sync)
app.get('/balance/:upi_id', async function(req, res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    try {
        const cleanId = String(req.params.upi_id || '').trim().toLowerCase();
        const result = await pool.query(
            'SELECT balance, reward_balance, status, name, account_type FROM accounts WHERE LOWER(upi_id) = $1',
            [cleanId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: 'Account not found' });
        }
        res.json({
            success: true,
            balance: parseFloat(result.rows[0].balance),
            reward_balance: parseFloat(result.rows[0].reward_balance || 0),
            status: result.rows[0].status,
            name: result.rows[0].name,
            account_type: result.rows[0].account_type
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. LIVE PASSBOOK / HISTORY ROUTE (Returns both Sent & Received with No-Cache)
async function handleHistoryRequest(req, res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    try {
        const cleanId = String(req.params.upi_id || '').trim().toLowerCase();
        const result = await pool.query(
            'SELECT id, sender, receiver, amount, timestamp FROM transactions WHERE LOWER(sender) = $1 OR LOWER(receiver) = $1 ORDER BY id DESC LIMIT 60',
            [cleanId]
        );
        res.json({ success: true, transactions: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
}
app.get('/history/:upi_id', handleHistoryRequest);
app.get('/transactions/:upi_id', handleHistoryRequest);

// 5. VERIFIED PEOPLE DIRECTORY ROUTE
app.get('/users', async function(req, res) {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    try {
        const result = await pool.query(
            "SELECT upi_id, name, account_type FROM accounts WHERE LOWER(upi_id) != 'boss0' ORDER BY name ASC"
        );
        res.json({ success: true, users: result.rows });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6. SECURED ATOMIC PAYMENT ROUTE (Updates both Sender & Receiver Passbooks)
app.post('/pay', async function(req, res) {
    const body = req.body || {};
    const sender = body.sender;
    const receiver = body.receiver;
    const pin = body.pin;
    const amount = body.amount;

    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        if (globalMaintenanceMode) {
            throw new Error('RPAY Network is currently under maintenance. Transfers are temporarily paused.');
        }

        const cleanSender = String(sender || '').trim().toLowerCase();
        const cleanReceiver = String(receiver || '').trim().toLowerCase();
        if (!cleanSender || !cleanReceiver) {
            throw new Error('Missing sender or receiver ID.');
        }
        if (cleanSender === cleanReceiver) {
            throw new Error('Security Block: You cannot transfer Kinex to your own account.');
        }

        const rawAmount = Number(amount);
        if (!Number.isFinite(rawAmount) || rawAmount <= 0) {
            throw new Error('Invalid payment amount. Must be greater than K 0.');
        }
        const sanitizedAmount = Math.round(rawAmount * 100) / 100;
        if (sanitizedAmount < 1) {
            throw new Error('Minimum transfer amount is K 1.00.');
        }

        // Lock Sender Row
        const auth = await client.query(
            'SELECT upi_id, balance, status FROM accounts WHERE LOWER(upi_id) = $1 AND pin = $2 FOR UPDATE',
            [cleanSender, pin]
        );
        if (auth.rows.length === 0) throw new Error('Invalid PIN.');
        if (auth.rows[0].status === 'FROZEN') throw new Error('Your account is frozen.');

        const currentBal = parseFloat(auth.rows[0].balance);
        if (currentBal < sanitizedAmount) throw new Error('Insufficient Funds.');
        if (currentBal - sanitizedAmount < 50) {
            throw new Error('A minimum balance of K 50.00 must remain in your account.');
        }

        // Lock Receiver Row
        const receiverCheck = await client.query(
            'SELECT upi_id, status FROM accounts WHERE LOWER(upi_id) = $1 FOR UPDATE',
            [cleanReceiver]
        );
        if (receiverCheck.rows.length === 0) throw new Error('Receiver does not exist.');
        if (receiverCheck.rows[0].status === 'FROZEN') {
            throw new Error('Receiver account is currently frozen and cannot accept funds.');
        }

        const canonicalSender = auth.rows[0].upi_id;
        const canonicalReceiver = receiverCheck.rows[0].upi_id;

        await client.query('UPDATE accounts SET balance = balance - $1 WHERE LOWER(upi_id) = $2', [sanitizedAmount, cleanSender]);
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE LOWER(upi_id) = $2', [sanitizedAmount, cleanReceiver]);
        const txInsert = await client.query(
            'INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, $3) RETURNING id',
            [canonicalSender, canonicalReceiver, sanitizedAmount]
        );

        await client.query('COMMIT');
        const refCode = 'KX' + (10000000 + parseInt(txInsert.rows[0].id, 10));
        res.json({ success: true, amount: sanitizedAmount, ref: refCode });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 7. BOSS0 ADMIN ROUTES (Protected by Master Secret Header)
function verifyAdminSecret(req, res, next) {
    const provided = req.headers['x-admin-secret'];
    if (!provided || provided !== ADMIN_SECRET) {
        return res.status(403).json({ success: false, error: 'Unauthorized: Invalid Master Secret' });
    }
    next();
}

app.get('/admin/overview', verifyAdminSecret, async function(req, res) {
    res.set('Cache-Control', 'no-store');
    try {
        const users = await pool.query("SELECT upi_id, name, balance, status, phone, account_type FROM accounts WHERE LOWER(upi_id) != 'boss0' ORDER BY upi_id ASC");
        const txs = await pool.query('SELECT id, sender, receiver, amount, timestamp FROM transactions ORDER BY id DESC LIMIT 30');
        res.json({
            success: true,
            maintenance: globalMaintenanceMode,
            users: users.rows,
            transactions: txs.rows
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

app.post('/admin/maintenance', verifyAdminSecret, function(req, res) {
    globalMaintenanceMode = !globalMaintenanceMode;
    res.json({ success: true, maintenance: globalMaintenanceMode });
});

app.post('/admin/status', verifyAdminSecret, async function(req, res) {
    const body = req.body || {};
    try {
        await pool.query('UPDATE accounts SET status = $1 WHERE LOWER(upi_id) = LOWER($2)', [body.status, body.upi_id]);
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

app.post('/admin/adjust-balance', verifyAdminSecret, async function(req, res) {
    const body = req.body || {};
    const target = String(body.upi_id || '').trim().toLowerCase();
    const amt = parseFloat(body.amount || 0);
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const check = await client.query('SELECT upi_id FROM accounts WHERE LOWER(upi_id) = $1 FOR UPDATE', [target]);
        if (check.rows.length === 0) throw new Error('Account not found');
        await client.query('UPDATE accounts SET balance = GREATEST(0, balance + $1) WHERE LOWER(upi_id) = $2', [amt, target]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, $3)', [
            amt >= 0 ? 'Boss0' : check.rows[0].upi_id,
            amt >= 0 ? check.rows[0].upi_id : 'Boss0',
            Math.abs(amt)
        ]);
        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.post('/admin/clawback', verifyAdminSecret, async function(req, res) {
    const txId = req.body ? req.body.tx_id : null;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txRes = await pool.query('SELECT id, sender, receiver, amount FROM transactions WHERE id = $1', [txId]);
        if (txRes.rows.length === 0) throw new Error('Transaction not found');
        const tx = txRes.rows[0];

        await client.query('UPDATE accounts SET balance = balance + $1 WHERE LOWER(upi_id) = LOWER($2)', [tx.amount, tx.sender]);
        await client.query('UPDATE accounts SET balance = GREATEST(0, balance - $1) WHERE LOWER(upi_id) = LOWER($2)', [tx.amount, tx.receiver]);
        await client.query('DELETE FROM transactions WHERE id = $1', [txId]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, function() {
    console.log('Kinex Network Server running on port ' + PORT);
});