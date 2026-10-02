import React, { useEffect, useRef, useState } from 'react';
import { useAreas } from '../hooks/useAreas.js';
import { reverseGeocode } from '../utils/geocode.js';

// Three ways in to the same lat/lng, all converging on one point:
//   1. "Use my current location" (GPS)
//   2. District -> City/Taluka picker (no GPS needed/wanted)
//   3. Manual lat/lng (kept as a fallback for precise cases)
// Whichever is used, a reverse-geocoded confirmation line shows what
// the coordinates actually resolve to — the "smart element" so raw
// numbers are never the only thing on screen.
export default function LocationField({ lat, lng, onChange, onResolved, label = 'Location', required = true }) {
  const { areas: MAHARASHTRA_AREAS, districts: DISTRICTS } = useAreas();
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState('');
  const [district, setDistrict] = useState('');
  const [area, setArea] = useState('');
  const [resolved, setResolved] = useState(null); // { label, district }
  const [resolving, setResolving] = useState(false);
  const debounceRef = useRef(null);

  // Reverse-geocode whenever the point settles (debounced so typing
  // manually doesn't fire a request per keystroke).
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!lat || !lng) { setResolved(null); return; }
    setResolving(true);
    debounceRef.current = setTimeout(async () => {
      const result = await reverseGeocode(lat, lng);
      setResolved(result);
      setResolving(false);
      if (onResolved) onResolved(result ? { ...result, pickedName: area || null } : null);
    }, 600);
    return () => clearTimeout(debounceRef.current);
  }, [lat, lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const useMyLocation = () => {
    if (!navigator.geolocation) {
      setLocateError('Your browser doesn\'t support location access — pick a district & area below instead.');
      return;
    }
    setLocating(true);
    setLocateError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDistrict(''); setArea('');
        onChange({ lat: pos.coords.latitude.toFixed(6), lng: pos.coords.longitude.toFixed(6) });
        setLocating(false);
      },
      () => {
        setLocateError('Could not get your location — pick a district & area below, or enter coordinates manually.');
        setLocating(false);
      }
    );
  };

  const pickArea = (areaName) => {
    setArea(areaName);
    const spot = MAHARASHTRA_AREAS[district]?.find((a) => a.name === areaName);
    if (spot) onChange({ lat: String(spot.lat), lng: String(spot.lng) });
  };

  return (
    <div>
      <label>{label}</label>

      <button type="button" className="btn btn-outline" onClick={useMyLocation} disabled={locating} style={{ marginBottom: 8 }}>
        {locating ? 'Locating…' : '📍 Use my current location'}
      </button>
      {locateError && <p className="muted" style={{ fontSize: 12, color: 'var(--accent)' }}>{locateError}</p>}

      <div className="grid grid-2" style={{ marginBottom: 8 }}>
        <div>
          <label style={{ fontSize: 12 }}>District</label>
          <select value={district} onChange={(e) => { setDistrict(e.target.value); setArea(''); }}>
            <option value="">— Select district —</option>
            {DISTRICTS.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12 }}>City / Taluka</label>
          <select value={area} onChange={(e) => pickArea(e.target.value)} disabled={!district}>
            <option value="">— Select area —</option>
            {(MAHARASHTRA_AREAS[district] || []).map((a) => <option key={a.name} value={a.name}>{a.name}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-2">
        <div>
          <label style={{ fontSize: 12 }}>Latitude</label>
          <input required={required} type="number" step="any" value={lat}
            onChange={(e) => { setDistrict(''); setArea(''); onChange({ lat: e.target.value, lng }); }} />
        </div>
        <div>
          <label style={{ fontSize: 12 }}>Longitude</label>
          <input required={required} type="number" step="any" value={lng}
            onChange={(e) => { setDistrict(''); setArea(''); onChange({ lat, lng: e.target.value }); }} />
        </div>
      </div>

      {(lat && lng) && (
        <p className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {resolving ? 'Resolving location…' : resolved?.label ? <>📍 Resolves to: <strong>{resolved.label}</strong></> : 'Could not resolve this location to a place name.'}
        </p>
      )}
    </div>
  );
}
