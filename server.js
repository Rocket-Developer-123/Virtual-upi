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

// PWA Asset Routes
app.get('/manifest.json', (req, res) => res.sendFile(path.join(__dirname, 'manifest.json')));
app.get('/sw.js', (req, res) => res.sendFile(path.join(__dirname, 'sw.js')));
app.get('/icon-192.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-192.png')));
app.get('/icon-512.png', (req, res) => res.sendFile(path.join(__dirname, 'icon-512.png')));

// 1. Register Route (Fixes double @rpay@rpay bug & checks duplicates)
app.post('/register', async (req, res) => {
    const { upi_id, name, pin, phone, dob, account_type } = req.body;
    try {
        let cleanHandle = String(upi_id || '').toLowerCase().trim();
        cleanHandle = cleanHandle.replace(/@rpay\$/i, '').replace(/[^a-z0-9._]/g, '');
        if (!cleanHandle) cleanHandle = "user" + Math.floor(Math.random() * 9000 + 1000);
        cleanHandle = cleanHandle + '@rpay';

        const check = await pool.query('SELECT upi_id FROM accounts WHERE LOWER(upi_id) = \$1', [cleanHandle]);
        if (check.rows.length > 0) {
            const base = cleanHandle.replace('@rpay', '');
            const suggestions = [
                base + Math.floor(Math.random() * 90 + 10) + '@rpay',
                base + Math.floor(Math.random() * 900 + 100) + '@rpay',
                base + (Math.floor(Math.random() * 9000) + 1000) + '@rpay'
            ];
            return res.json({ success: false, error: "ID taken", suggestions });
        }

        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(
                `INSERT INTO accounts (upi_id, name, pin, balance, status, phone, dob, account_type)
                 VALUES ($1, $2, $3, 500, 'ACTIVE', $4, $5, $6)`,
                [cleanHandle, name, pin, phone || '', dob || '2005-01-01', account_type || 'PERSONAL']
            );
            await client.query(
                `INSERT INTO transactions (sender, receiver, amount) VALUES ('system@rpay', $1, 500)`,
                [cleanHandle]
            );
            await client.query('COMMIT');
            res.json({ success: true, upi_id: cleanHandle });
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 2. Login Route
app.post('/login', async (req, res) => {
    const { upi_id, pin } = req.body;
    try {
        const cleanId = String(upi_id || '').trim().toLowerCase();
        const r = await pool.query(
            'SELECT upi_id, name, balance, status, account_type FROM accounts WHERE LOWER(upi_id) = \$1 AND pin = \$2',
            [cleanId, pin]
        );
        if (r.rows.length === 0) return res.status(401).json({ success: false, error: "Invalid credentials" });
        res.json({ success: true, ...r.rows[0] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. Real-Time Passbook & Balance Sync for BOTH Sender and Receiver
app.get('/api/user-state/:upi_id', async (req, res) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    const cleanId = String(req.params.upi_id || '').trim().toLowerCase();
    try {
        const accRes = await pool.query(
            'SELECT upi_id, name, balance, account_type, status FROM accounts WHERE LOWER(upi_id) = \$1',
            [cleanId]
        );
        if (accRes.rows.length === 0) return res.status(404).json({ success: false, error: "Not found" });
        const user = accRes.rows[0];

        const allUsersRes = await pool.query("SELECT upi_id, name FROM accounts WHERE LOWER(upi_id) != 'boss0' ORDER BY name ASC");
        const nameMap = { 'system@rpay': 'Welcome bonus', 'boss0': 'Network Treasury' };
        const contacts = [];
        allUsersRes.rows.forEach(r => {
            nameMap[r.upi_id.toLowerCase()] = r.name;
            if (r.upi_id.toLowerCase() !== cleanId) contacts.push({ n: r.name, id: r.upi_id });
        });

        const txRes = await pool.query(
            `SELECT id, sender, receiver, amount, timestamp
             FROM transactions
             WHERE LOWER(sender) = $1 OR LOWER(receiver) = $1
             ORDER BY id DESC LIMIT 50`,
            [cleanId]
        );

        const transactions = txRes.rows.map(t => {
            const isIncoming = String(t.receiver).toLowerCase() === cleanId;
            const otherPartyId = isIncoming ? String(t.sender).toLowerCase() : String(t.receiver).toLowerCase();
            const otherPartyName = nameMap[otherPartyId] || (isIncoming ? t.sender : t.receiver);
            const dt = t.timestamp ? new Date(t.timestamp) : new Date();
            const isToday = dt.toDateString() === new Date().toDateString();

            return {
                n: otherPartyName,
                id: otherPartyId,
                d: isToday ? 'Today' : dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }),
                t: dt.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }),
                a: isIncoming ? Number(t.amount) : -Number(t.amount),
                ref: 'KX' + String(10000000 + Number(t.id))
            };
        });

        res.json({
            success: true,
            upi_id: user.upi_id,
            name: user.name,
            balance: Number(user.balance),
            status: user.status || 'ACTIVE',
            account_type: user.account_type || 'PERSONAL',
            transactions,
            contacts
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. Atomic Payment Route (Updates both Sender and Receiver & validates K 50 reserve)
app.post('/pay', async (req, res) => {
    const { sender, receiver, pin, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        if (globalMaintenanceMode) throw new Error("Network is under maintenance. Transfers paused.");

        const cleanSender = String(sender || '').trim().toLowerCase();
        const cleanReceiver = String(receiver || '').trim().toLowerCase();
        if (!cleanSender || !cleanReceiver) throw new Error("Missing sender or receiver ID.");
        if (cleanSender === cleanReceiver) throw new Error("You cannot transfer Kinex to your own account.");

        const rawAmount = Number(amount);
        if (!Number.isFinite(rawAmount) || rawAmount <= 0) throw new Error("Invalid payment amount.");
        const sanitizedAmount = Math.round(rawAmount * 100) / 100;
        if (sanitizedAmount < 1) throw new Error("Minimum transfer amount is K 1.00.");

        const auth = await client.query(
            'SELECT upi_id, balance, status FROM accounts WHERE LOWER(upi_id) = \$1 AND pin = \$2 FOR UPDATE',
            [cleanSender, pin]
        );
        if (auth.rows.length === 0) throw new Error("Invalid PIN.");
        if (auth.rows[0].status === 'FROZEN') throw new Error("Your account is frozen.");

        const currentBal = parseFloat(auth.rows[0].balance);
        if (currentBal < sanitizedAmount) throw new Error("Insufficient Funds.");
        if (currentBal - sanitizedAmount < 50) throw new Error("A minimum reserve of K 50.00 must remain in your wallet.");

        const receiverCheck = await client.query(
            'SELECT upi_id, status FROM accounts WHERE LOWER(upi_id) = \$1 FOR UPDATE',
            [cleanReceiver]
        );
        if (receiverCheck.rows.length === 0) throw new Error("Receiver does not exist.");
        if (receiverCheck.rows[0].status === 'FROZEN') throw new Error("Receiver account is frozen.");

        await client.query('UPDATE accounts SET balance = balance - \$1 WHERE LOWER(upi_id) = \$2', [sanitizedAmount, cleanSender]);
        await client.query('UPDATE accounts SET balance = balance + \$1 WHERE LOWER(upi_id) = \$2', [sanitizedAmount, cleanReceiver]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES (\$1, \$2, \$3)', [cleanSender, cleanReceiver, sanitizedAmount]);

        await client.query('COMMIT');
        res.json({ success: true, amount: sanitizedAmount });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Kinex Network running on port ${PORT}`));