export const routeStopConfig = {
  '101A': ['Malad', 'Borivali', 'Goregaon', 'Andheri', 'Santacruz', 'Bandra', 'Dadar', 'Churchgate'],
  '102B': ['Dahisar', 'Kandivali', 'Malad', 'Andheri', 'Goregaon', 'Bandra', 'Charni Road'],
  '201': ['Thane', 'Mulund', 'Kalyan', 'Dombivli', 'Panvel'],
};

export const routeGeoConfig = {
  '101A': [
    { stop: 'Malad', latitude: 19.1760, longitude: 72.8480 },
    { stop: 'Borivali', latitude: 19.2280, longitude: 72.8565 },
    { stop: 'Goregaon', latitude: 19.1642, longitude: 72.8407 },
    { stop: 'Andheri', latitude: 19.1190, longitude: 72.8460 },
    { stop: 'Santacruz', latitude: 19.0880, longitude: 72.8410 },
    { stop: 'Bandra', latitude: 19.0544, longitude: 72.8404 },
    { stop: 'Dadar', latitude: 19.0180, longitude: 72.8440 },
    { stop: 'Churchgate', latitude: 18.9398, longitude: 72.8233 },
  ],
  '102B': [
    { stop: 'Dahisar', latitude: 19.2543, longitude: 72.8542 },
    { stop: 'Kandivali', latitude: 19.2068, longitude: 72.8445 },
    { stop: 'Malad', latitude: 19.1760, longitude: 72.8480 },
    { stop: 'Andheri', latitude: 19.1190, longitude: 72.8460 },
    { stop: 'Goregaon', latitude: 19.1642, longitude: 72.8407 },
    { stop: 'Bandra', latitude: 19.0544, longitude: 72.8404 },
    { stop: 'Charni Road', latitude: 18.9468, longitude: 72.8294 },
  ],
  '201': [
    { stop: 'Thane', latitude: 19.2183, longitude: 72.9781 },
    { stop: 'Mulund', latitude: 19.1584, longitude: 72.9781 },
    { stop: 'Kalyan', latitude: 19.2440, longitude: 73.1305 },
    { stop: 'Dombivli', latitude: 19.2181, longitude: 73.0898 },
    { stop: 'Panvel', latitude: 18.9899, longitude: 73.1160 },
  ],
};

export const getStopsForRoute = (route) => {
  if (!route) return [];
  const geoStops = routeGeoConfig[route.bus_number];
  if (Array.isArray(geoStops) && geoStops.length > 1) {
    return geoStops.map((item) => item.stop);
  }
  const knownStops = routeStopConfig[route.bus_number];
  if (Array.isArray(knownStops) && knownStops.length > 1) {
    return knownStops;
  }
  return [route.from_stop, route.to_stop].filter(Boolean);
};

export const getRouteCoordinates = (route) => {
  if (!route) return [];
  return routeGeoConfig[route.bus_number] || [];
};

export const calculateSegmentFare = (route, from_stop, to_stop) => {
  if (!route || !from_stop || !to_stop) return null;
  const stops = getStopsForRoute(route);
  const fromIndex = stops.indexOf(from_stop);
  const toIndex = stops.indexOf(to_stop);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) {
    return null;
  }

  const totalSegments = Math.max(stops.length - 1, 1);
  const segmentCount = Math.abs(toIndex - fromIndex);
  const fare = Math.round((route.fare * segmentCount) / totalSegments);
  return Math.max(100, fare);
};
