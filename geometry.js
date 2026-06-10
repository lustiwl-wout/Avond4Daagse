// Geometrie-hulpfuncties voor kruisingdetectie en conflictcontrole.
// Werkt met een equirectangulaire benadering — ruim voldoende op stadsschaal.
const R = 6371000;
const rad = (d) => (d * Math.PI) / 180;

function project(p, lat0) {
  return { x: rad(p.lng) * Math.cos(rad(lat0)) * R, y: rad(p.lat) * R };
}

function distanceM(a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const pa = project(a, lat0);
  const pb = project(b, lat0);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

// Snijpunt van segment a1-a2 met b1-b2, of null. Geeft ook de kruisingshoek
// (0-90°) terug zodat bijna-parallelle "kruisingen" genegeerd kunnen worden.
function segmentIntersection(a1, a2, b1, b2) {
  const lat0 = (a1.lat + a2.lat + b1.lat + b2.lat) / 4;
  const p1 = project(a1, lat0);
  const p2 = project(a2, lat0);
  const p3 = project(b1, lat0);
  const p4 = project(b2, lat0);
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
  const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  const len = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
  if (len === 0) return null;
  const dot = d1x * d2x + d1y * d2y;
  const angle = (Math.acos(Math.min(1, Math.abs(dot) / len)) * 180) / Math.PI;
  return {
    lat: a1.lat + (a2.lat - a1.lat) * t,
    lng: a1.lng + (a2.lng - a1.lng) * t,
    t,
    angle,
  };
}

function segBox(a, b, margin = 0.0003) {
  return {
    minLat: Math.min(a.lat, b.lat) - margin,
    maxLat: Math.max(a.lat, b.lat) + margin,
    minLng: Math.min(a.lng, b.lng) - margin,
    maxLng: Math.max(a.lng, b.lng) + margin,
  };
}

function boxesOverlap(a, b) {
  return (
    a.minLat <= b.maxLat && a.maxLat >= b.minLat && a.minLng <= b.maxLng && a.maxLng >= b.minLng
  );
}

const HIGHWAY_LABELS = {
  cycleway: 'fietspad',
  service: 'inrit / zijweg',
  residential: 'woonstraat',
  living_street: 'woonerf',
  unclassified: 'weg',
  tertiary: 'doorgaande weg',
  tertiary_link: 'doorgaande weg',
  secondary: 'doorgaande weg',
  secondary_link: 'doorgaande weg',
  primary: 'hoofdweg',
  primary_link: 'hoofdweg',
  trunk: 'hoofdweg',
  trunk_link: 'hoofdweg',
  busway: 'busbaan',
  track: 'landweg',
};

function wayName(way) {
  const tags = way.tags || {};
  if (tags.name) return tags.name;
  return HIGHWAY_LABELS[tags.highway] || 'weg';
}

// Alle plekken waar het wandelpad een (fiets)weg transversaal kruist.
// Punten binnen clusterDist meter worden samengevoegd tot één oversteekpunt.
function findCrossings(path, ways, { minAngle = 20, clusterDist = 25 } = {}) {
  const pathBoxes = [];
  for (let i = 0; i < path.length - 1; i++) pathBoxes.push(segBox(path[i], path[i + 1]));

  const hits = [];
  for (const way of ways) {
    const geom = (way.geometry || []).map((g) => ({ lat: g.lat, lng: g.lon }));
    const name = wayName(way);
    for (let j = 0; j < geom.length - 1; j++) {
      const wb = segBox(geom[j], geom[j + 1]);
      for (let i = 0; i < path.length - 1; i++) {
        if (!boxesOverlap(pathBoxes[i], wb)) continue;
        const hit = segmentIntersection(path[i], path[i + 1], geom[j], geom[j + 1]);
        if (hit && hit.angle >= minAngle) {
          hits.push({ lat: hit.lat, lng: hit.lng, order: i + hit.t, name });
        }
      }
    }
  }

  hits.sort((a, b) => a.order - b.order);
  const clusters = [];
  for (const h of hits) {
    const near = clusters.find((c) => distanceM(c, h) < clusterDist);
    if (near) {
      if (!near.names.includes(h.name)) near.names.push(h.name);
    } else {
      clusters.push({ lat: h.lat, lng: h.lng, order: h.order, names: [h.name] });
    }
  }
  return clusters.map((c) => ({
    lat: c.lat,
    lng: c.lng,
    order: c.order,
    name: c.names.join(' / '),
  }));
}

// Plekken waar een teamroute de wandelroute kruist, met uitzondering van de
// zones rond de eigen posten en start/finish (daar mág het team de route raken).
function findConflicts(
  teamPath,
  walkPath,
  excludePoints,
  { minAngle = 15, excludeDist = 50, clusterDist = 30 } = {}
) {
  const walkBoxes = [];
  for (let i = 0; i < walkPath.length - 1; i++) walkBoxes.push(segBox(walkPath[i], walkPath[i + 1]));

  const hits = [];
  for (let j = 0; j < teamPath.length - 1; j++) {
    const tb = segBox(teamPath[j], teamPath[j + 1]);
    for (let i = 0; i < walkPath.length - 1; i++) {
      if (!boxesOverlap(walkBoxes[i], tb)) continue;
      const hit = segmentIntersection(walkPath[i], walkPath[i + 1], teamPath[j], teamPath[j + 1]);
      if (!hit || hit.angle < minAngle) continue;
      if (excludePoints.some((p) => distanceM(p, hit) < excludeDist)) continue;
      hits.push({ lat: hit.lat, lng: hit.lng });
    }
  }

  const clusters = [];
  for (const h of hits) {
    if (!clusters.some((c) => distanceM(c, h) < clusterDist)) clusters.push(h);
  }
  return clusters;
}

module.exports = { distanceM, findCrossings, findConflicts };
