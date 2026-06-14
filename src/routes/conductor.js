import express from 'express';
import pool from '../db.js';
import auth from '../middleware/auth.js';
import { getStopsForRoute, calculateSegmentFare } from '../utils/routeHelpers.js';

const router = express.Router();

const ensureSessionTable = async () => {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS active_bus_sessions (
      operator_id UUID PRIMARY KEY,
      route_id UUID NOT NULL,
      started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      stopped_at TIMESTAMPTZ,
      active BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
};

router.get('/routes', auth, async (req, res) => {
  if (req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Operators only' });
  }

  try {
    const result = await pool.query(
      `SELECT id, bus_number, from_stop, to_stop, fare
       FROM routes
       ORDER BY bus_number, from_stop, to_stop`
    );
    const routes = result.rows.map((route) => ({
      ...route,
      stops: getStopsForRoute(route),
    }));
    res.json({ routes });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/route/:id', auth, async (req, res) => {
  if (req.user.role !== 'operator' && req.user.role !== 'passenger') {
    return res.status(403).json({ error: 'Operators or passengers only' });
  }

  try {
    const result = await pool.query(
      `SELECT id, bus_number, from_stop, to_stop, fare
       FROM routes
       WHERE id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Route not found' });
    }
    const route = result.rows[0];
    route.stops = getStopsForRoute(route);
    res.json({ route });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/session/current', auth, async (req, res) => {
  if (req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Operators only' });
  }

  try {
    await ensureSessionTable();
    const result = await pool.query(
      `SELECT s.operator_id, s.route_id, s.started_at, s.active,
              r.bus_number, r.from_stop, r.to_stop, r.fare
       FROM active_bus_sessions s
       JOIN routes r ON r.id = s.route_id
       WHERE s.operator_id = $1 AND s.active = TRUE
       LIMIT 1`,
      [req.user.id]
    );
    res.json({ session: result.rows[0] || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conductor starts a session
router.post('/session/start', auth, async (req, res) => {
  if (req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Operators only' });
  }
  const route_id = String(req.body.route_id || '').trim();
  if (!route_id) {
    return res.status(400).json({ error: 'Route is required' });
  }

  try {
    await ensureSessionTable();

    const routeResult = await pool.query(
      `SELECT id, bus_number, from_stop, to_stop, fare FROM routes WHERE id = $1`,
      [route_id]
    );

    if (routeResult.rows.length === 0) {
      return res.status(404).json({ error: 'Route not found' });
    }

    await pool.query(
      `INSERT INTO active_bus_sessions (operator_id, route_id, started_at, stopped_at, active)
       VALUES ($1, $2, NOW(), NULL, TRUE)
       ON CONFLICT (operator_id)
       DO UPDATE SET route_id = EXCLUDED.route_id,
                     started_at = NOW(),
                     stopped_at = NULL,
                     active = TRUE`,
      [req.user.id, route_id]
    );

    res.json({ message: 'Session started', route: routeResult.rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Conductor stops session
router.post('/session/stop', auth, async (req, res) => {
  if (req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Operators only' });
  }

  try {
    await ensureSessionTable();
    await pool.query(
      `UPDATE active_bus_sessions
       SET active = FALSE, stopped_at = NOW()
       WHERE operator_id = $1`,
      [req.user.id]
    );
    res.json({ message: 'Session stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Passenger checks for active conductor AND triggers payment in one call
router.post('/checkin', auth, async (req, res) => {
  if (req.user.role !== 'passenger') {
    return res.status(403).json({ error: 'Passengers only' });
  }

  const operator_id = String(req.body.operator_id || '').trim();
  const requested_route_id = String(req.body.route_id || '').trim();
  const passenger_id = req.user.id;

  if (!operator_id) {
    return res.status(400).json({ error: 'Operator is required' });
  }

  const client = await pool.connect();
  try {
    await ensureSessionTable();
    await client.query('BEGIN');

    const passengerResult = await client.query(
      `SELECT id, wallet_balance FROM users WHERE id = $1 FOR UPDATE`,
      [passenger_id]
    );
    const passenger = passengerResult.rows[0];

    if (!passenger) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Passenger not found' });
    }

    const operatorResult = await client.query(
      `SELECT id FROM users WHERE id = $1 AND role = 'operator'`,
      [operator_id]
    );
    if (operatorResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Operator not found' });
    }

    const sessionResult = await client.query(
      `SELECT route_id FROM active_bus_sessions
       WHERE operator_id = $1 AND active = TRUE
       LIMIT 1`,
      [operator_id]
    );
    if (sessionResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Conductor session not active' });
    }

    const route_id = sessionResult.rows[0].route_id;
    if (requested_route_id && requested_route_id !== route_id) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Passenger connected to stale route broadcast' });
    }

    const routeResult = await client.query(
      `SELECT fare, from_stop, to_stop, bus_number FROM routes WHERE id = $1`,
      [route_id]
    );
    if (routeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Route not found' });
    }
    const route = routeResult.rows[0];
    const destination_stop = String(req.body.destination_stop || '').trim();

    if (!destination_stop || destination_stop === route.from_stop) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Please select a valid destination stop' });
    }

    const fareAmount = calculateSegmentFare(route, route.from_stop, destination_stop);
    if (fareAmount === null) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Invalid destination selected' });
    }

    if (passenger.wallet_balance < fareAmount) {
      await client.query(
        `INSERT INTO transactions
         (passenger_id, operator_id, route_id, fare_amount, status, nfc_token)
         VALUES ($1, $2, $3, $4, 'insufficient_funds', $5)`,
        [passenger_id, operator_id, route_id, fareAmount, passenger_id]
      );
      await client.query('COMMIT');
      return res.status(402).json({ error: 'Insufficient balance' });
    }

    await client.query(
      `UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id = $2`,
      [fareAmount, passenger_id]
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
      [passenger_id, operator_id, route_id, fareAmount, passenger_id]
    );

    await client.query('COMMIT');
    res.json({
      message: 'Payment successful',
      transaction_id: txn.rows[0].id,
      route: `${route.from_stop} → ${destination_stop}`,
      fare_rupees: (fareAmount / 100).toFixed(2),
      timestamp: txn.rows[0].created_at
    });

  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});


// Add this route to conductor.js
router.get('/payments/recent', auth, async (req, res) => {
  if (req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Operators only' });
  }
  try {
    const result = await pool.query(
      `SELECT t.id, t.fare_amount, t.created_at,
              u.name as passenger_name,
              r.from_stop, r.to_stop
       FROM transactions t
       JOIN users u ON u.id = t.passenger_id
       JOIN routes r ON r.id = t.route_id
       WHERE t.operator_id = $1
         AND t.status = 'success'
         AND t.created_at > NOW() - INTERVAL '1 hour'
       ORDER BY t.created_at DESC
       LIMIT 10`,
      [req.user.id]
    );
    res.json({ payments: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
