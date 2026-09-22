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
