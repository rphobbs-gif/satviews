/* Sat Views - orbit calculations (position, day/night, passes).
   Works in the browser (window.Orbit) and in Node for testing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory;
  else root.Orbit = factory(root.satellite);
})(this, function (satellite) {
  const DEG = Math.PI / 180;
  const EARTH_R = 6371.0;          // km
  const AU = 149597870.7;          // km

  function makeSatrec(line1, line2) {
    return satellite.twoline2satrec(line1.trim(), line2.trim());
  }

  // Low-precision sun position (Astronomical Almanac), returns ECI unit-ish vector in km
  function sunEci(date) {
    const jd = date.getTime() / 86400000 + 2440587.5;
    const n = jd - 2451545.0;
    const L = (280.460 + 0.9856474 * n) % 360;
    const g = ((357.528 + 0.9856003 * n) % 360) * DEG;
    const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    const eps = (23.439 - 0.0000004 * n) * DEG;
    const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
    return {
      x: R * Math.cos(lam),
      y: R * Math.cos(eps) * Math.sin(lam),
      z: R * Math.sin(eps) * Math.sin(lam)
    };
  }

  // Point on Earth directly under the Sun (degrees)
  function subsolarPoint(date) {
    const s = sunEci(date);
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(s, gmst);
    const r = Math.hypot(ecf.x, ecf.y, ecf.z);
    return { lat: Math.asin(ecf.z / r) / DEG, lon: Math.atan2(ecf.y, ecf.x) / DEG };
  }

  // Is the satellite in sunlight? (cylindrical Earth-shadow model)
  function isSunlit(posEci, date) {
    const s = sunEci(date);
    const sl = Math.hypot(s.x, s.y, s.z);
    const u = { x: s.x / sl, y: s.y / sl, z: s.z / sl };
    const proj = posEci.x * u.x + posEci.y * u.y + posEci.z * u.z;
    if (proj > 0) return true;
    const px = posEci.x - proj * u.x, py = posEci.y - proj * u.y, pz = posEci.z - proj * u.z;
    return Math.hypot(px, py, pz) > EARTH_R;
  }

  function observerGd(obs) {
    return { latitude: obs.lat * DEG, longitude: obs.lon * DEG, height: (obs.heightKm || 0) };
  }

  // Sun elevation (degrees) as seen by the observer
  function sunElevation(obs, date) {
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(sunEci(date), gmst);
    const look = satellite.ecfToLookAngles(observerGd(obs), ecf);
    return look.elevation / DEG;
  }

  // Current position: lat, lon (deg), altitude (km), speed (km/h), sunlit
  function position(satrec, date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const gd = satellite.eciToGeodetic(pv.position, gmst);
    const v = pv.velocity;
    return {
      lat: satellite.degreesLat(gd.latitude),
      lon: satellite.degreesLong(gd.longitude),
      altKm: gd.height,
      speedKmh: Math.hypot(v.x, v.y, v.z) * 3600,
      sunlit: isSunlit(pv.position, date),
      eci: pv.position
    };
  }

  // Ground track from startDate for `minutes`, step seconds. Returns array of segments
  // (split where the track crosses the date line so the map doesn't draw a line across it).
  function groundTrack(satrec, startDate, minutes, stepSec) {
    const segs = [];
    let cur = [];
    let prevLon = null;
    for (let t = 0; t <= minutes * 60; t += stepSec) {
      const p = position(satrec, new Date(startDate.getTime() + t * 1000));
      if (!p) continue;
      if (prevLon !== null && Math.abs(p.lon - prevLon) > 180) { segs.push(cur); cur = []; }
      cur.push([p.lat, p.lon]);
      prevLon = p.lon;
    }
    if (cur.length) segs.push(cur);
    return segs;
  }

  function look(satrec, obs, date) {
    const pv = satellite.propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const gmst = satellite.gstime(date);
    const ecf = satellite.eciToEcf(pv.position, gmst);
    const la = satellite.ecfToLookAngles(observerGd(obs), ecf);
    return { el: la.elevation / DEG, az: ((la.azimuth / DEG) + 360) % 360, eci: pv.position };
  }

  // Find the moment the elevation crosses `minEl` between t0 and t1 (ms) by bisection
  function crossing(satrec, obs, t0, t1, minEl) {
    const above0 = look(satrec, obs, new Date(t0)).el >= minEl;
    for (let i = 0; i < 20; i++) {
      const tm = (t0 + t1) / 2;
      const above = look(satrec, obs, new Date(tm)).el >= minEl;
      if (above === above0) t0 = tm; else t1 = tm;
    }
    return (t0 + t1) / 2;
  }

  // Find passes over the observer.
  // Returns [{start, end, maxTime, maxEl, startAz, maxAz, endAz, visible, visStart, visEnd, sunEl}]
  function findPasses(satrec, obs, startDate, days, opts) {
    opts = opts || {};
    const minEl = opts.minEl != null ? opts.minEl : 10;
    const step = 20 * 1000;
    const tEnd = startDate.getTime() + days * 86400000;
    const passes = [];
    let t = startDate.getTime();
    let prev = look(satrec, obs, new Date(t));
    if (!prev) return passes;
    let inPass = prev.el >= minEl;
    let pass = inPass ? { start: t, startAz: prev.az, samples: [] } : null;
    for (t += step; t <= tEnd; t += step) {
      const cur = look(satrec, obs, new Date(t));
      if (!cur) break;
      const above = cur.el >= minEl;
      if (above && !inPass) {
        const tc = crossing(satrec, obs, t - step, t, minEl);
        pass = { start: tc, startAz: look(satrec, obs, new Date(tc)).az, samples: [] };
        inPass = true;
      }
      if (inPass && pass) {
        const d = new Date(t);
        pass.samples.push({
          t: t, el: cur.el, az: cur.az,
          lit: isSunlit(cur.eci, d),
          sunEl: sunElevation(obs, d)
        });
      }
      if (!above && inPass) {
        const tc = crossing(satrec, obs, t - step, t, minEl);
        pass.end = tc;
        pass.endAz = look(satrec, obs, new Date(tc)).az;
        passes.push(finishPass(satrec, obs, pass));
        inPass = false; pass = null;
      }
    }
    return passes.filter(Boolean);
  }

  function finishPass(satrec, obs, p) {
    if (!p.samples.length) {
      const mid = (p.start + p.end) / 2, l = look(satrec, obs, new Date(mid));
      p.samples.push({ t: mid, el: l.el, az: l.az, lit: isSunlit(l.eci, new Date(mid)), sunEl: sunElevation(obs, new Date(mid)) });
    }
    // refine the highest point to the nearest second
    let best = p.samples.reduce((a, b) => (b.el > a.el ? b : a));
    let lo = Math.max(p.start, best.t - 20000), hi = Math.min(p.end, best.t + 20000);
    for (let i = 0; i < 30; i++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (look(satrec, obs, new Date(m1)).el < look(satrec, obs, new Date(m2)).el) lo = m1; else hi = m2;
    }
    const tMax = (lo + hi) / 2, lMax = look(satrec, obs, new Date(tMax));
    const vis = p.samples.filter(s => s.lit && s.sunEl < -6);
    return {
      start: new Date(p.start), end: new Date(p.end), maxTime: new Date(tMax),
      maxEl: lMax.el, startAz: p.startAz, maxAz: lMax.az, endAz: p.endAz,
      visible: vis.length > 0,
      visMaxEl: vis.length ? Math.max.apply(null, vis.map(s => s.el)) : 0,
      visSeconds: vis.length ? (vis[vis.length - 1].t - vis[0].t) / 1000 + 20 : 0,
      visStart: vis.length ? new Date(Math.max(p.start, vis[0].t - 10000)) : null,
      visEnd: vis.length ? new Date(Math.min(p.end, vis[vis.length - 1].t + 10000)) : null,
      sunEl: sunElevation(obs, new Date(tMax))
    };
  }

  // Minutes until the station next comes out into sunlight (or null if already sunlit)
  function minutesUntilSunlit(satrec, date) {
    const p0 = position(satrec, date);
    if (!p0 || p0.sunlit) return null;
    for (let s = 30; s <= 60 * 60; s += 30) {
      const d = new Date(date.getTime() + s * 1000);
      const p = position(satrec, d);
      if (p && p.sunlit) return Math.round(s / 60);
    }
    return null;
  }

  // Polygon covering the night side of the Earth, for the map
  function nightPolygon(date) {
    const ss = subsolarPoint(date);
    const lat0 = ss.lat * DEG;
    const pts = [];
    for (let lon = -180; lon <= 180; lon += 2) {
      const ha = (lon - ss.lon) * DEG;
      // latitude of the terminator at this longitude
      let lat = Math.atan(-Math.cos(ha) / Math.tan(lat0 === 0 ? 1e-6 : lat0)) / DEG;
      pts.push([lat, lon]);
    }
    // night is on the pole opposite the subsolar latitude
    const pole = ss.lat > 0 ? -90 : 90;
    pts.push([pole, 180]);
    pts.push([pole, -180]);
    return pts;
  }

  const COMPASS = ['north', 'north-northeast', 'northeast', 'east-northeast', 'east', 'east-southeast',
    'southeast', 'south-southeast', 'south', 'south-southwest', 'southwest', 'west-southwest',
    'west', 'west-northwest', 'northwest', 'north-northwest'];
  const COMPASS_SHORT = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  function compass(az) { return COMPASS[Math.round(az / 22.5) % 16]; }
  function compassShort(az) { return COMPASS_SHORT[Math.round(az / 22.5) % 16]; }

  return { makeSatrec, position, groundTrack, findPasses, isSunlit, sunElevation,
    subsolarPoint, nightPolygon, minutesUntilSunlit, compass, compassShort };
});
