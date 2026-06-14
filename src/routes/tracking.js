import express from 'express';
import axios from 'axios';
import pool from '../db.js';
import auth from '../middleware/auth.js';
import { getRouteCoordinates } from '../utils/routeHelpers.js';

const router = express.Router();

// Replace with your real API key
const CALMGO_API_KEY = process.env.CALMGO_API_KEY || 'demo_key';

const fetchRealBusPositions = async () => {
  try {
    // Example: Fetch from CalmGo API (replace with actual endpoint)
    const response = await axios.get('https://api.calmgo.com/v1/buses/live', {
      headers: { 'Authorization': `Bearer ${CALMGO_API_KEY}` },
      params: { city: 'mumbai' }
    });
    return response.data.buses || [];
  } catch (error) {
    console.error('Real API fetch failed:', error.message);
    return null;
  }
};

const buildBusPosition = (route, coordinates) => {
  if (!coordinates || coordinates.length === 0) return null;
  const index = Math.floor(Date.now() / 10000) % coordinates.length;
  const current = coordinates[index];
  const nextStop = coordinates[(index + 1) % coordinates.length];
  const driftLat = Math.sin(Date.now() / 15000) * 0.00035;
  const driftLng = Math.cos(Date.now() / 15000) * 0.0004;

  return {
    id: `${route.id}-${index}`,
    route_id: route.id,
    bus_number: route.bus_number,
    latitude: current.latitude + driftLat,
    longitude: current.longitude + driftLng,
    next_stop: nextStop?.stop || '',
    eta: `${Math.max(1, 3 + ((coordinates.length - index) % 6))} min`,
  };
};

const getRoutePath = (coordinates) =>
  coordinates.map((point) => ({ latitude: point.latitude, longitude: point.longitude }));

router.get('/buses', auth, async (req, res) => {
  if (req.user.role !== 'passenger' && req.user.role !== 'operator') {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  try {
    // Try real API first
    const realBuses = await fetchRealBusPositions();
    if (realBuses && realBuses.length > 0) {
      // Map real data to our format
      const buses = realBuses.map(bus => ({
        id: bus.vehicle_id,
        route_id: bus.route_id,
        bus_number: bus.route_short_name,
        latitude: bus.position.latitude,
        longitude: bus.position.longitude,
        next_stop: bus.next_stop || '',
        eta: bus.eta || 'Unknown',
      }));

      // For paths, use our route data
      const routesResult = await pool.query(
        `SELECT id, bus_number, from_stop, to_stop FROM routes ORDER BY bus_number`
      );
      const paths = routesResult.rows.map(route => ({
        route_id: route.id,
        bus_number: route.bus_number,
        coordinates: getRoutePath(getRouteCoordinates(route)),
      }));

      return res.json({ buses, paths });
    }

    // Fallback to simulated data
    const routesResult = await pool.query(
      `SELECT id, bus_number, from_stop, to_stop FROM routes ORDER BY bus_number`
    );
    const buses = [];
    const paths = [];

    for (const route of routesResult.rows) {
      const coordinates = getRouteCoordinates(route);
      if (coordinates.length === 0) continue;
      const busMarker = buildBusPosition(route, coordinates);
      if (busMarker) buses.push(busMarker);
      paths.push({
        route_id: route.id,
        bus_number: route.bus_number,
        coordinates: getRoutePath(coordinates),
      });
    }

    res.json({ buses, paths });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
