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

// Relatie tussen twee segmenten: kruisen ze, of hoe dichtbij komen ze?
// Geeft het punt op segment A (het wandelpad) terug dat het dichtst bij
// segment B (de weg) ligt, met de onderlinge hoek (0-90°).
function segmentRelation(a1, a2, b1, b2) {
  const lat0 = (a1.lat + a2.lat + b1.lat + b2.lat) / 4;
  const p1 = project(a1, lat0);
  const p2 = project(a2, lat0);
  const p3 = project(b1, lat0);
  const p4 = project(b2, lat0);
  const d1x = p2.x - p1.x;
  const d1y = p2.y - p1.y;
  const d2x = p4.x - p3.x;
  const d2y = p4.y - p3.y;
  const len = Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y);
  if (len === 0) return null;
  const dot = d1x * d2x + d1y * d2y;
  const angle = (Math.acos(Math.min(1, Math.abs(dot) / len)) * 180) / Math.PI;

  const atPoint = (t) => ({
    lat: a1.lat + (a2.lat - a1.lat) * t,
    lng: a1.lng + (a2.lng - a1.lng) * t,
  });

  // Echte kruising?
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) > 1e-9) {
    const t = ((p3.x - p1.x) * d2y - (p3.y - p1.y) * d2x) / denom;
    const u = ((p3.x - p1.x) * d1y - (p3.y - p1.y) * d1x) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1) {
      return { dist: 0, t, angle, ...atPoint(t) };
    }
  }

  // Geen kruising: kleinste afstand tussen de segmenten, bijv. een zijstraat
  // die op de gelopen weg uitkomt (T-kruising).
  const lenA2 = d1x * d1x + d1y * d1y;
  const lenB2 = d2x * d2x + d2y * d2y;
  let best = null;
  const consider = (dist, t) => {
    if (!best || dist < best.dist) best = { dist, t };
  };
  for (const p of [p3, p4]) {
    const t = lenA2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - p1.x) * d1x + (p.y - p1.y) * d1y) / lenA2));
    const q = { x: p1.x + d1x * t, y: p1.y + d1y * t };
    consider(Math.hypot(p.x - q.x, p.y - q.y), t);
  }
  for (const [p, t] of [[p1, 0], [p2, 1]]) {
    const u = lenB2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - p3.x) * d2x + (p.y - p3.y) * d2y) / lenB2));
    const q = { x: p3.x + d2x * u, y: p3.y + d2y * u };
    consider(Math.hypot(p.x - q.x, p.y - q.y), t);
  }
  return { dist: best.dist, t: best.t, angle, ...atPoint(best.t) };
}

// Snijpunt van segment a1-a2 met b1-b2, of null (alleen echte kruisingen,
// gebruikt voor de conflictcontrole van teamroutes).
function segmentIntersection(a1, a2, b1, b2) {
  const rel = segmentRelation(a1, a2, b1, b2);
  return rel && rel.dist === 0 ? rel : null;
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

// Kleinste afstand (m) van een punt tot een pad.
function distanceToPath(path, point) {
  let best = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = distanceM(a, b);
    let t = 0;
    if (segLen > 0) {
      const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
      const bx = (b.lng - a.lng) * Math.cos(lat0);
      const by = b.lat - a.lat;
      const px = (point.lng - a.lng) * Math.cos(lat0);
      const py = point.lat - a.lat;
      t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
    }
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    best = Math.min(best, distanceM(point, proj));
  }
  return best;
}

// Lengte (m) van `path` die binnen maxDist meter van refPath ligt — meet
// hoeveel een fietsroute over de wandelroute heen rijdt.
function overlapLength(path, refPath, maxDist = 15) {
  let overlap = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const seg = distanceM(a, b);
    if (seg === 0) continue;
    const steps = Math.max(1, Math.ceil(seg / 10));
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      const p = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      if (distanceToPath(refPath, p) <= maxDist) overlap += seg / steps;
    }
  }
  return overlap;
}

module.exports = { findConflicts, overlapLength };
