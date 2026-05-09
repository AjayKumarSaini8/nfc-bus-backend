import express from 'express';
import pool from '../db.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Get balance
router.get('/balance', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT wallet_balance FROM users WHERE id = $1`,
            [req.user.id]
        );
        const balancePaise = result.rows[0].wallet_balance;
        res.json({
            balance_paise: balancePaise,
            balance_rupees: (balancePaise / 100).toFixed(2)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Top up wallet
router.post('/topup', authMiddleware, async (req, res) => {
    const { amount_paise } = req.body;  // e.g. 10000 = ₹100
    if (!amount_paise || amount_paise <= 0) {
        return res.status(400).json({ error: 'Invalid amount' });
    }
    try {
        const result = await pool.query(
            `UPDATE users
       SET wallet_balance = wallet_balance + $1
       WHERE id = $2
       RETURNING wallet_balance`,
            [amount_paise, req.user.id]
        );
        res.json({
            message: 'Wallet topped up',
            new_balance_rupees: (result.rows[0].wallet_balance / 100).toFixed(2)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

export default router;