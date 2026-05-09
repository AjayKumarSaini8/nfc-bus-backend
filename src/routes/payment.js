import express from 'express';
import pool from "../db.js";
import authMiddleware from "../middleware/auth.js";

const router = express.Router();

router.post('/tap', authMiddleware, async (req, res) => {
    // Conductor calls this after reading passenger's NFC token
    const { nfc_token, route_id } = req.body;
    const operator_id = req.user.id;

    if (req.user.role !== 'operator') {
        return res.status(403).json({ error: 'Only operators can process payments' });
    }

    const client = await pool.connect();  // get a dedicated client for the transaction

    try {
        await client.query('BEGIN');

        // 1. Find the passenger by their NFC token (token = their user ID for now)
        const passengerResult = await client.query(
            `SELECT id, wallet_balance FROM users WHERE id = $1 FOR UPDATE`,
            [nfc_token]  // FOR UPDATE locks the row so no race conditions
        );

        if (passengerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Passenger not found' });
        }

        const passenger = passengerResult.rows[0];

        // 2. Get the fare for this route
        const routeResult = await client.query(
            `SELECT fare, bus_number, from_stop, to_stop FROM routes WHERE id = $1`,
            [route_id]
        );

        if (routeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Route not found' });
        }

        const route = routeResult.rows[0];

        // 3. Check balance
        if (passenger.wallet_balance < route.fare) {
            // Still record the failed attempt
            await client.query(
                `INSERT INTO transactions
         (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
         VALUES ($1, $2, $3, $4, 'insufficient_funds', $5)`,
                [passenger.id, operator_id, route_id, route.fare, nfc_token]
            );
            await client.query('COMMIT');
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        // 4. Deduct from passenger
        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
            [route.fare, passenger.id]
        );

        // 5. Credit operator
        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
            [route.fare, operator_id]
        );

        // 6. Record the transaction
        const txn = await client.query(
            `INSERT INTO transactions
       (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
       VALUES ($1, $2, $3, $4, 'success', $5)
       RETURNING id, created_at`,
            [passenger.id, operator_id, route_id, route.fare, nfc_token]
        );

        await client.query('COMMIT');

        res.json({
            message: 'Payment successful',
            transaction_id: txn.rows[0].id,
            route: `${route.from_stop} → ${route.to_stop}`,
            fare_rupees: (route.fare / 100).toFixed(2),
            timestamp: txn.rows[0].created_at
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();  // always release the client back to pool
    }
});

export default router;