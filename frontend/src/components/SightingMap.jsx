import React from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';

const STATUS_COLORS = {
  pending: '#f2a007',
  verified: '#2fb380',
  rejected: '#8593ad',
};

const sightingIcon = (status) => {
  const color = STATUS_COLORS[status] || STATUS_COLORS.pending;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
      <circle cx="11" cy="11" r="9" fill="${color}" stroke="#0a0f1a" stroke-width="2"/>
      <circle cx="11" cy="11" r="3" fill="#0a0f1a"/>
    </svg>`;
  return L.divIcon({ html: svg, className: '', iconSize: [22, 22], iconAnchor: [11, 11], popupAnchor: [0, -11] });
};

/**
 * A second, sighting-specific map — distinct from the case map. Each
 * pin is a reported sighting location (not the case's last-seen
 * point), colored by review status, so an officer verifying sightings
 * can see at a glance where they cluster relative to each other and
 * decide plausibility from geography, not just the text description.
 * When onVerify/onReject are provided (Police Admin+), pending
 * sightings get action buttons right in the popup — no need to scroll
 * to the list below to act on one.
 */
export default function SightingMap({ sightings, caseLocation, onVerify, onReject }) {
  const plottable = sightings.filter((s) => s.location?.geo?.coordinates?.length === 2);

  const center = caseLocation?.geo?.coordinates
    ? [caseLocation.geo.coordinates[1], caseLocation.geo.coordinates[0]]
    : plottable.length > 0
      ? [plottable[0].location.geo.coordinates[1], plottable[0].location.geo.coordinates[0]]
      : [22.9734, 78.6569];

  if (plottable.length === 0) {
    return <p className="muted">No sightings with location data yet.</p>;
  }

  return (
    <div className="leaflet-map" style={{ height: 320 }}>
      <MapContainer center={center} zoom={11} style={{ height: '100%', width: '100%' }}>
        <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
        {caseLocation?.geo?.coordinates && (
          <Marker position={[caseLocation.geo.coordinates[1], caseLocation.geo.coordinates[0]]}>
            <Popup><strong>Last seen here</strong><br />{caseLocation.address}</Popup>
          </Marker>
        )}
        {plottable.map((s) => {
          const [lng, lat] = s.location.geo.coordinates;
          return (
            <Marker key={s._id} position={[lat, lng]} icon={sightingIcon(s.status)}>
              <Popup>
                <div style={{ minWidth: 180 }}>
                  <strong style={{ textTransform: 'uppercase', fontSize: 11, color: STATUS_COLORS[s.status] }}>{s.status}</strong>
                  <p style={{ margin: '4px 0' }}>{s.description}</p>
                  <p style={{ margin: '4px 0', fontSize: 12, color: '#666' }}>{s.location.address}</p>
                  <p style={{ margin: '4px 0', fontSize: 11, color: '#888' }}>
                    Reported by {s.reportedBy?.name || 'unknown'} on {new Date(s.seenAt).toLocaleDateString()}
                  </p>
                  {s.status === 'pending' && onVerify && onReject && (
                    <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                      <button onClick={() => onVerify(s._id)} style={{ background: '#2fb380', color: 'white', border: 'none', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>Verify</button>
                      <button onClick={() => onReject(s._id)} style={{ background: 'transparent', color: '#333', border: '1px solid #ccc', borderRadius: 4, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>Reject</button>
                    </div>
                  )}
                </div>
              </Popup>
            </Marker>
          );
        })}
      </MapContainer>
    </div>
  );
}
