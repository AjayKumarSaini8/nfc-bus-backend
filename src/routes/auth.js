import express from 'express';
import pool from '../db.js';
import jwt from 'jsonwebtoken';

const router = express.Router();

router.get('/me', async (req, res) => {
    const header = req.headers.authorization;
    if (!header) return res.status(401).json({ error: 'No token provided' });

    try {
        const token = header.split(' ')[1];
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const result = await pool.query(
            `SELECT id, name, phone, role, wallet_balance, created_at
             FROM users
             WHERE id = $1`,
            [decoded.id]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        res.json({ user: result.rows[0] });
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
});

// User registration
router.post('/register', async (req, res) => {
    const { name, phone, role } = req.body;
    try {
        const result = await pool.query(`
        INSERT INTO users (name, phone, role )
        VALUES ($1, $2, $3) RETURNING id, name, phone, role, wallet_balance`,
            [name, phone, role]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') {
            return res.status(400).json({ error: 'Phone number already exists' });
        }
        res.status(500).json({ error: err.message });
    }
}
);

// User login
router.post('/login', async (req, res) => {
    const { phone } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'User not found' });
        }
        const user = result.rows[0];
        const token = jwt.sign(
            { id: user.id, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: '7d' }
        );
        res.json({ token, user });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;
