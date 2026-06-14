import express from 'express';
import pool from "../db.js";
import authMiddleware from '../middleware/auth.js';
import { getStopsForRoute, calculateSegmentFare } from '../utils/routeHelpers.js';

const router = express.Router();

router.post('/tap', authMiddleware, async (req, res) => {
    const { nfc_token, route_id, destination_stop } = req.body;
    const operator_id = req.user.id;

    if (req.user.role !== 'operator') {
        return res.status(403).json({ error: 'Only operators can process payments' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const passengerResult = await client.query(
            `SELECT id, wallet_balance FROM users WHERE id = $1 FOR UPDATE`,
            [nfc_token]
        );

        if (passengerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Passenger not found' });
        }

        const passenger = passengerResult.rows[0];

        const routeResult = await client.query(
            `SELECT fare, bus_number, from_stop, to_stop FROM routes WHERE id = $1`,
            [route_id]
        );

        if (routeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Route not found' });
        }

        const route = routeResult.rows[0];
        const destination = String(destination_stop || '').trim() || route.to_stop;
        const fareAmount = calculateSegmentFare(route, route.from_stop, destination);

        if (fareAmount === null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid destination selected' });
        }

        if (passenger.wallet_balance < fareAmount) {
            await client.query(
                `INSERT INTO transactions
         (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
         VALUES ($1, $2, $3, $4, 'insufficient_funds', $5)`,
                [passenger.id, operator_id, route_id, fareAmount, nfc_token]
            );
            await client.query('COMMIT');
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
            [fareAmount, passenger.id]
        );

        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
            [fareAmount, operator_id]
        );

        const txn = await client.query(
            `INSERT INTO transactions
       (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
       VALUES ($1, $2, $3, $4, 'success', $5)
       RETURNING id, created_at`,
            [passenger.id, operator_id, route_id, fareAmount, nfc_token]
        );

        await client.query('COMMIT');

        res.json({
            message: 'Payment successful',
            transaction_id: txn.rows[0].id,
            route: `${route.from_stop} → ${destination}`,
            fare_rupees: (fareAmount / 100).toFixed(2),
            timestamp: txn.rows[0].created_at,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

router.post('/qr', authMiddleware, async (req, res) => {
    if (req.user.role !== 'operator') {
        return res.status(403).json({ error: 'Only operators can process QR payments' });
    }

    const { passenger_token, destination_stop } = req.body;
    const operator_id = req.user.id;

    if (!passenger_token) {
        return res.status(400).json({ error: 'Passenger token is required' });
    }

    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const passengerResult = await client.query(
            `SELECT id, wallet_balance FROM users WHERE id = $1 FOR UPDATE`,
            [passenger_token]
        );

        if (passengerResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Passenger not found' });
        }

        const passenger = passengerResult.rows[0];

        const sessionResult = await client.query(
            `SELECT route_id FROM active_bus_sessions WHERE operator_id = $1 AND active = TRUE LIMIT 1`,
            [operator_id]
        );

        if (sessionResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'No active conductor session' });
        }

        const route_id = sessionResult.rows[0].route_id;
        const routeResult = await client.query(
            `SELECT fare, bus_number, from_stop, to_stop FROM routes WHERE id = $1`,
            [route_id]
        );

        if (routeResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ error: 'Route not found' });
        }

        const route = routeResult.rows[0];
        const destination = String(destination_stop || '').trim() || route.to_stop;
        const fareAmount = calculateSegmentFare(route, route.from_stop, destination);

        if (fareAmount === null) {
            await client.query('ROLLBACK');
            return res.status(400).json({ error: 'Invalid destination selected' });
        }

        if (passenger.wallet_balance < fareAmount) {
            await client.query(
                `INSERT INTO transactions
         (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
         VALUES ($1, $2, $3, $4, 'insufficient_funds', $5)`,
                [passenger.id, operator_id, route_id, fareAmount, passenger_token]
            );
            await client.query('COMMIT');
            return res.status(402).json({ error: 'Insufficient balance' });
        }

        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
            [fareAmount, passenger.id]
        );

        await client.query(
            `UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id = $2`,
            [fareAmount, operator_id]
        );

        const txn = await client.query(
            `INSERT INTO transactions
       (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
       VALUES ($1, $2, $3, $4, 'success', $5)
       RETURNING id, created_at`,
            [passenger.id, operator_id, route_id, fareAmount, passenger_token]
        );

        await client.query('COMMIT');

        res.json({
            message: 'QR payment successful',
            transaction_id: txn.rows[0].id,
            route: `${route.from_stop} → ${destination}`,
            fare_rupees: (fareAmount / 100).toFixed(2),
            timestamp: txn.rows[0].created_at,
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

export default router;
