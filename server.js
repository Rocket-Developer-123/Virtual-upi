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
        // Remove '@rpay' if the frontend sent it, then strip illegal characters
        cleanHandle = cleanHandle.replace(/@rpay$/, '').replace(/[^a-z0-9._]/g, '');

        if (!cleanHandle) {
            cleanHandle = name.toLowerCase().replace(/[^a-z0-9]/g, '');
            if (!cleanHandle) cleanHandle = "user" + Math.floor(Math.random() * 9000 + 1000);
        }
        
        // Append exactly one @rpay
        cleanHandle = cleanHandle + '@rpay';

        // Check if chosen ID is already in the database
        const check = await pool.query('SELECT upi_id FROM accounts WHERE upi_id = $1', [cleanHandle]);
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
                // NEW: Global Maintenance Lock Check         
                if (globalMaintenanceMode) throw new Error("RPAY Network is currently under maintenance. Transfers are temporarily paused.");


        // 1. Check Sender Status
        const auth = await client.query('SELECT balance, status FROM accounts WHERE upi_id = $1 AND pin = $2', [sender, pin]);
        if (auth.rows.length === 0) throw new Error("Invalid PIN.");
        if (auth.rows[0].status === 'FROZEN') throw new Error("Your account is frozen.");
        // Anti-farming protection: maintain a minimum balance reserve of K 50
        if (auth.rows[0].balance - amount < 50) {
            throw new Error("A minimum balance of K 50.00 must remain in your account.");
        }

        // 2. Check Receiver Status
        const receiverCheck = await client.query('SELECT status FROM accounts WHERE upi_id = $1', [receiver]);
        if (receiverCheck.rows.length === 0) throw new Error("Receiver does not exist.");
        if (receiverCheck.rows[0].status === 'FROZEN') throw new Error("Receiver account is currently frozen and cannot accept funds.");

        // 3. Process Transfer
        await client.query('UPDATE accounts SET balance = balance - $1 WHERE upi_id = $2', [amount, sender]);
        await client.query('UPDATE accounts SET balance = balance + $1 WHERE upi_id = $2', [amount, receiver]);
        await client.query('INSERT INTO transactions (sender, receiver, amount) VALUES ($1, $2, $3)', [sender, receiver, amount]);
                // Auto-insert payment into chat history
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
// UPGRADED ADMIN / BOSS0 ENDPOINTS
// ==========================================
let globalMaintenanceMode = false;
const MASTER_SECRET = process.env.ADMIN_MASTER_SECRET || 'Rpay-master-55';

// Helper to verify Boss0 against the database password instead of hardcoded '5555'
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

// 1. View Users + Economy Analytics + Maintenance Status
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

// 2. Toggle Global Maintenance Lock (Requires Master Secret)
app.post('/admin/maintenance', async (req, res) => {
    const { admin_id, admin_pin, master_secret, enable } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    globalMaintenanceMode = Boolean(enable);
    res.json({ success: true, maintenance: globalMaintenanceMode });
});

// 3. System Broadcast
app.post('/admin/broadcast', async (req, res) => {
    const { admin_id, admin_pin, message } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    await pool.query('UPDATE system_notices SET is_active = FALSE');
    if (message) await pool.query('INSERT INTO system_notices (message, is_active) VALUES (\$1, TRUE)', [message]);
    res.json({ success: true });
});

// 4. Account Management (Requires Master Secret)
app.post('/admin/adjust', async (req, res) => {
    const { admin_id, admin_pin, master_secret, target_id, amount, action } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    try {
        const target = target_id.trim();
        let result;
        if (action === 'add') result = await pool.query('UPDATE accounts SET balance = balance + \$1 WHERE upi_id = \$2 RETURNING *', [amount, target]);
        if (action === 'deduct') result = await pool.query('UPDATE accounts SET balance = balance - \$1 WHERE upi_id = \$2 RETURNING *', [amount, target]);
        if (action === 'freeze') result = await pool.query('UPDATE accounts SET status = \$1 WHERE upi_id = \$2 RETURNING *', ['FROZEN', target]);
        if (action === 'unfreeze') result = await pool.query('UPDATE accounts SET status = \$1 WHERE upi_id = \$2 RETURNING *', ['ACTIVE', target]);

        if (result && result.rowCount === 0) {
            return res.status(400).json({ success: false, error: "Target not found. Did you type the full @rpay handle?" });
        }
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

// 5. Terminate Account (Requires Master Secret)
app.post('/admin/delete', async (req, res) => {
    const { admin_id, admin_pin, master_secret, target_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    await pool.query('DELETE FROM accounts WHERE upi_id = \$1', [target_id.trim()]);
    await pool.query('DELETE FROM transactions WHERE sender = \$1 OR receiver = \$1', [target_id.trim()]);
    res.json({ success: true });
});

// 6. Live Global Transaction Feed
app.post('/admin/transactions', async (req, res) => {
    const { admin_id, admin_pin, target_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    let result = target_id
        ? await pool.query('SELECT * FROM transactions WHERE sender = \$1 OR receiver = \$1 ORDER BY created_at DESC LIMIT 50', [target_id.trim()])
        : await pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 50');
    res.json({ success: true, data: result.rows });
});

// 7. One-Click Clawback / Reverse Transaction (Requires Master Secret)
app.post('/admin/clawback', async (req, res) => {
    const { admin_id, admin_pin, master_secret, tx_id } = req.body;
    const auth = await verifyBoss(admin_id, admin_pin, true, master_secret);
    if (!auth.ok) return res.status(401).json({ success: false, error: auth.error });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const txQuery = await client.query('SELECT * FROM transactions WHERE id = \$1 FOR UPDATE', [tx_id]);
        if (txQuery.rows.length === 0) throw new Error("Transaction not found or already reversed.");

        const tx = txQuery.rows[0];
        const amt = parseFloat(tx.amount);

        // Pull money back from receiver and return to sender
        await client.query('UPDATE accounts SET balance = balance - \$1 WHERE upi_id = \$2', [amt, tx.receiver]);
        await client.query('UPDATE accounts SET balance = balance + \$1 WHERE upi_id = \$2', [amt, tx.sender]);
        await client.query('DELETE FROM transactions WHERE id = \$1', [tx_id]);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});
// ==========================================
// QUEST SYSTEM — fully server-side, persisted in Postgres
// (quest_state / quest_cards / quest_ledger — see quests-schema.sql)
// ==========================================

const CHECKIN_REWARDS = [20, 30, 40, 60, 80, 120, 200];
const SPIN_PRIZES  = [10, 50, 20, 100, 25, 1000, 75, 250];
const SPIN_WEIGHTS = [24, 15, 20, 7, 18, 1, 10, 5];
const SCRATCH_PRIZES  = [5, 10, 20, 50, 100, 250, 500];
const SCRATCH_WEIGHTS = [30, 25, 18, 12, 8, 5, 2];
const BADGES = [
    { id: 'first', name: 'First Transfer', target: 1,    reward: 100,  metric: 'payments' },
    { id: 'ten',   name: 'Ten-Timer',      target: 10,   reward: 250,  metric: 'payments' },
    { id: 'fifty', name: 'Half-Century',   target: 50,   reward: 1000, metric: 'payments' },
    { id: 'vol',   name: 'Big Mover',      target: 5000, reward: 750,  metric: 'volume' },
    { id: 'week',  name: 'Week Warrior',   target: 7,    reward: 300,  metric: 'best_streak' },
    { id: 'shark', name: 'Card Shark',     target: 5,    reward: 200,  metric: 'scratched' }
];

function todayEpochDay() {
    return Math.floor(Date.now() / 86400000);
}

function weightedPick(values, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (let i = 0; i < values.length; i++) {
        r -= weights[i];
        if (r < 0) return values[i];
    }
    return values[values.length - 1];
}

// Every read/write goes through this so a quest_state row always exists.
async function getOrCreateQuestState(client, upi_id) {
    await client.query('INSERT INTO quest_state (upi_id) VALUES ($1) ON CONFLICT (upi_id) DO NOTHING', [upi_id]);
    const r = await client.query('SELECT * FROM quest_state WHERE upi_id = $1', [upi_id]);
    return r.rows[0];
}

async function addLedgerEntry(client, upi_id, label, amount) {
    await client.query('INSERT INTO quest_ledger (upi_id, label, amount) VALUES ($1, $2, $3)', [upi_id, label, amount]);
}

// 1. Full quest state — balances, streak, spin/scratch/badge progress, passbook
app.get('/api/quests/state/:upi_id', async (req, res) => {
    const upi_id = req.params.upi_id;
    try {
        const account = await pool.query('SELECT balance, reward_balance FROM accounts WHERE upi_id = $1', [upi_id]);
        if (account.rows.length === 0) return res.json({ success: false, error: 'Account not found.' });

        const qs = await getOrCreateQuestState(pool, upi_id);

        const stats = await pool.query(
            "SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount),0)::float AS volume FROM transactions WHERE sender = $1",
            [upi_id]
        );

        const cards = await pool.query('SELECT id, prize FROM quest_cards WHERE upi_id = $1 ORDER BY id ASC', [upi_id]);

        const ledger = await pool.query(
            'SELECT id, label, amount, created_at FROM quest_ledger WHERE upi_id = $1 ORDER BY created_at DESC LIMIT 30',
            [upi_id]
        );

        res.json({
            success: true,
            balance: parseFloat(account.rows[0].balance),
            reward_balance: parseFloat(account.rows[0].reward_balance),
            streak: qs.streak,
            best_streak: qs.best_streak,
            last_checkin_day: qs.last_checkin_day,
            spin_day: qs.spin_day,
            payments: stats.rows[0].payments,
            volume: stats.rows[0].volume,
            scratched: qs.scratched,
            cards: cards.rows.map(c => ({ id: c.id, prize: parseFloat(c.prize), done: false })),
            claimed_badges: qs.claimed_badges || [],
            ledger: ledger.rows.map(l => ({
                id: l.id,
                label: l.label,
                amount: parseFloat(l.amount),
                date: new Date(l.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
            }))
        });
    } catch (e) {
        res.json({ success: false, error: e.message });
    }
});

// 2. Daily check-in — server decides the day, the streak, and the reward
app.post('/api/quests/checkin', async (req, res) => {
    const { upi_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const qs = await getOrCreateQuestState(client, upi_id);
        const today = todayEpochDay();

        if (qs.last_checkin_day === today) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Already checked in today.' });
        }

        const effStreak = (qs.last_checkin_day === today - 1) ? qs.streak : 0;
        const newStreak = effStreak + 1;
        const reward = CHECKIN_REWARDS[(newStreak - 1) % 7];
        const newBest = Math.max(qs.best_streak, newStreak);

        await client.query(
            'UPDATE quest_state SET streak = $1, best_streak = $2, last_checkin_day = $3 WHERE upi_id = $4',
            [newStreak, newBest, today, upi_id]
        );
        await client.query('UPDATE accounts SET reward_balance = reward_balance + $1 WHERE upi_id = $2', [reward, upi_id]);
        await addLedgerEntry(client, upi_id, 'Daily check-in', reward);

        await client.query('COMMIT');
        res.json({ success: true, reward });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 3. Spin the Vault — one free spin per UTC day, server picks the prize
app.post('/api/quests/spin', async (req, res) => {
    const { upi_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const qs = await getOrCreateQuestState(client, upi_id);
        const today = todayEpochDay();

        if (qs.spin_day === today) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Already spun today.' });
        }

        const prize = weightedPick(SPIN_PRIZES, SPIN_WEIGHTS);

        await client.query('UPDATE quest_state SET spin_day = $1 WHERE upi_id = $2', [today, upi_id]);
        await client.query('UPDATE accounts SET reward_balance = reward_balance + $1 WHERE upi_id = $2', [prize, upi_id]);
        await addLedgerEntry(client, upi_id, 'Vault spin', prize);

        await client.query('COMMIT');
        res.json({ success: true, prize });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 4. Buy a scratch card — costs K 50 from the reward wallet
app.post('/api/quests/scratch/buy', async (req, res) => {
    const { upi_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const acc = await client.query('SELECT reward_balance FROM accounts WHERE upi_id = $1 FOR UPDATE', [upi_id]);
        if (acc.rows.length === 0) { await client.query('ROLLBACK'); return res.json({ success: false, error: 'Account not found.' }); }
        if (parseFloat(acc.rows[0].reward_balance) < 50) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Not enough reward balance. Need K 50.' });
        }

        const prize = weightedPick(SCRATCH_PRIZES, SCRATCH_WEIGHTS);
        await client.query('UPDATE accounts SET reward_balance = reward_balance - 50 WHERE upi_id = $1', [upi_id]);
        const card = await client.query('INSERT INTO quest_cards (upi_id, prize) VALUES ($1, $2) RETURNING id', [upi_id, prize]);
        await addLedgerEntry(client, upi_id, 'Bought scratch card', -50);

        await client.query('COMMIT');
        res.json({ success: true, card: { id: card.rows[0].id, prize } });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 5. Reveal a scratch card the user owns
app.post('/api/quests/scratch/reveal', async (req, res) => {
    const { upi_id, card_id } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const card = await client.query('SELECT id, prize FROM quest_cards WHERE id = $1 AND upi_id = $2 FOR UPDATE', [card_id, upi_id]);
        if (card.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Card not found.' });
        }
        const prize = parseFloat(card.rows[0].prize);

        await client.query('DELETE FROM quest_cards WHERE id = $1', [card_id]);
        await client.query('UPDATE accounts SET reward_balance = reward_balance + $1 WHERE upi_id = $2', [prize, upi_id]);
        await client.query('UPDATE quest_state SET scratched = scratched + 1 WHERE upi_id = $1', [upi_id]);
        await addLedgerEntry(client, upi_id, 'Scratch card win', prize);

        await client.query('COMMIT');
        res.json({ success: true, prize });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 6. Claim a milestone badge — eligibility is re-checked here, not trusted from the client
app.post('/api/quests/badge/claim', async (req, res) => {
    const { upi_id, badge_id } = req.body;
    const badge = BADGES.find(b => b.id === badge_id);
    if (!badge) return res.json({ success: false, error: 'Unknown badge.' });

    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const qs = await getOrCreateQuestState(client, upi_id);
        if ((qs.claimed_badges || []).includes(badge_id)) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Badge already claimed.' });
        }

        let value;
        if (badge.metric === 'payments' || badge.metric === 'volume') {
            const stats = await client.query(
                "SELECT COUNT(*)::int AS payments, COALESCE(SUM(amount),0)::float AS volume FROM transactions WHERE sender = $1",
                [upi_id]
            );
            value = stats.rows[0][badge.metric];
        } else {
            value = qs[badge.metric];
        }

        if (value < badge.target) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Not eligible yet.' });
        }

        await client.query(
            'UPDATE quest_state SET claimed_badges = array_append(claimed_badges, $1) WHERE upi_id = $2',
            [badge_id, upi_id]
        );
        await client.query('UPDATE accounts SET reward_balance = reward_balance + $1 WHERE upi_id = $2', [badge.reward, upi_id]);
        await addLedgerEntry(client, upi_id, 'Badge: ' + badge.name, badge.reward);

        await client.query('COMMIT');
        res.json({ success: true, reward: badge.reward });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

// 7. Redeem reward wallet -> main wallet (PIN required — this is the only quest
//    route that touches the main balance)
app.post('/api/quests/redeem', async (req, res) => {
    const { upi_id, pin, amount } = req.body;
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const user = await client.query('SELECT pin, reward_balance FROM accounts WHERE upi_id = $1 FOR UPDATE', [upi_id]);
        if (user.rows.length === 0 || user.rows[0].pin !== pin) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Invalid Security PIN' });
        }
        if (parseFloat(user.rows[0].reward_balance) < amount) {
            await client.query('ROLLBACK');
            return res.json({ success: false, error: 'Insufficient Reward Balance' });
        }

        await client.query('UPDATE accounts SET reward_balance = reward_balance - $1, balance = balance + $1 WHERE upi_id = $2', [amount, upi_id]);
        await addLedgerEntry(client, upi_id, 'Redeemed to main wallet', -amount);

        await client.query('COMMIT');
        res.json({ success: true });
    } catch (e) {
        await client.query('ROLLBACK');
        res.json({ success: false, error: e.message });
    } finally {
        client.release();
    }
});

app.listen(process.env.PORT || 3000, () => console.log('API live'));
